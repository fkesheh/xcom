/**
 * Cone-of-fire combat model.
 *
 * A shot deviates by a random angle uniform in [-spread, +spread]. The target
 * tile subtends a half-angle alpha at the shooter; the shot connects when
 * |deviation| <= alpha. Hence the (preview) hit chance is alpha / spread,
 * clamped to the configured floor/ceiling: closer or larger targets are easier,
 * and a more accurate shooter has a tighter spread.
 *
 * Purity: this module never touches the DOM or three.js. The only randomness it
 * uses comes from state.rng, and only inside resolveShot (preview is pure).
 * resolveShot ONLY rolls dice + applies HP damage + advances rng; it does NOT
 * deduct shooter TU, set facing, or push events -- the reducer owns those.
 */

import type {
  BattleState,
  ShotKind,
  ShotMode,
  ShotPreview,
  ShotRound,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "./types";
import { COMBAT } from "./types";
import { lineOfFire } from "./los";

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Euclidean distance between two tiles (float). */
export function tileDistance(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/**
 * Effective per-shot accuracy in [0, 1]:
 *   (firingAccuracy/100) * (mode.accuracy/100) * rangeFactor
 * where rangeFactor is 1 within the weapon's range and decays linearly beyond
 * it, never falling below 0.05.
 */
export function effectiveAccuracy(
  shooter: Unit,
  weapon: Weapon,
  mode: ShotMode,
  dist: number,
): number {
  const rangeFactor =
    dist <= weapon.range
      ? 1
      : Math.max(0.05, 1 - (dist - weapon.range) * COMBAT.RANGE_FALLOFF_PER_TILE);
  return clamp01(
    (shooter.stats.firingAccuracy / 100) * (mode.accuracy / 100) * rangeFactor,
  );
}

/** Angular spread (radians) for a given effective accuracy. */
export function spreadForAccuracy(acc: number): number {
  return lerp(COMBAT.SPREAD_AT_0_RAD, COMBAT.SPREAD_AT_100_RAD, acc);
}

/** Half-angle (radians) subtended by a target tile at the given distance. */
export function targetHalfAngle(dist: number): number {
  return Math.atan2(COMBAT.TARGET_HALF_WIDTH, Math.max(dist, COMBAT.TARGET_HALF_WIDTH));
}

/**
 * Per-shot hit probability in [MIN_HIT_CHANCE, MAX_HIT_CHANCE]. Monotonic:
 * closer => higher, more accurate => higher.
 */
export function hitChance(
  shooter: Unit,
  weapon: Weapon,
  mode: ShotMode,
  dist: number,
): number {
  const acc = effectiveAccuracy(shooter, weapon, mode, dist);
  const spread = spreadForAccuracy(acc);
  const half = targetHalfAngle(dist);
  return clamp(half / spread, COMBAT.MIN_HIT_CHANCE, COMBAT.MAX_HIT_CHANCE);
}

/** TU a firing mode costs this unit (ceil of a percentage of its max TU). */
export function tuCostForMode(unit: Unit, mode: ShotMode): number {
  return Math.ceil((unit.stats.timeUnits * mode.tuPercent) / 100);
}

/** TU a reload costs this unit (ceil of a percentage of its max TU). */
export function reloadTuCost(unit: Unit, weapon: Weapon): number {
  return Math.ceil((unit.stats.timeUnits * weapon.reloadTuPercent) / 100);
}

/** Find a weapon's firing mode by kind, or undefined when absent. */
export function findMode(weapon: Weapon, kind: ShotKind): ShotMode | undefined {
  return weapon.modes.find((m) => m.kind === kind);
}

/** First LIVING unit standing on the given tile, or undefined. */
function occupantAt(state: BattleState, pos: Vec2): Unit | undefined {
  return state.units.find((u) => u.alive && u.pos.x === pos.x && u.pos.y === pos.y);
}

/**
 * Honest hit-chance preview for the UI / AI. Pure: does NOT advance the rng.
 * A shot is possible when the mode exists, line of sight is clear, and the
 * shooter has enough TU. `reason` is filled only when not possible.
 */
export function previewShot(
  state: BattleState,
  shooter: Unit,
  targetPos: Vec2,
  kind: ShotKind,
): ShotPreview {
  const weapon = state.weapons[shooter.weaponId];
  const mode = weapon ? findMode(weapon, kind) : undefined;
  if (!weapon || !mode) {
    return {
      possible: false,
      hitChance: 0,
      expectedHits: 0,
      tuCost: 0,
      ammoCost: 0,
      reason: weapon ? "no such firing mode" : "no weapon",
    };
  }

  const tuCost = tuCostForMode(shooter, mode);
  const ammoCost = mode.shots;
  const dist = tileDistance(shooter.pos, targetPos);
  const chance = hitChance(shooter, weapon, mode, dist);
  const expectedHits = chance * mode.shots;

  if (!lineOfFire(state.grid, shooter.pos, targetPos).clear) {
    return {
      possible: false,
      hitChance: chance,
      expectedHits,
      tuCost,
      ammoCost,
      reason: "no line of fire",
    };
  }
  if (shooter.ammo < ammoCost) {
    return {
      possible: false,
      hitChance: chance,
      expectedHits,
      tuCost,
      ammoCost,
      reason: shooter.ammo <= 0 ? "empty magazine" : "not enough ammo",
    };
  }
  if (shooter.tu < tuCost) {
    return {
      possible: false,
      hitChance: chance,
      expectedHits,
      tuCost,
      ammoCost,
      reason: "not enough TU",
    };
  }

  return { possible: true, hitChance: chance, expectedHits, tuCost, ammoCost };
}

/**
 * Roll a firing action and apply HP damage. Advances state.rng once per round
 * (deviation) and once more per landed hit (damage). Returns the per-round
 * results, the id of the occupant struck (or null), and whether it was killed.
 *
 * Does NOT deduct shooter TU/ammo, change facing, or emit events -- the reducer
 * layers those on top.
 */
export function resolveShot(
  state: BattleState,
  shooter: Unit,
  targetPos: Vec2,
  kind: ShotKind,
): { rounds: ShotRound[]; targetId: UnitId | null; killed: boolean } {
  const rounds: ShotRound[] = [];
  const weapon = state.weapons[shooter.weaponId];
  const mode = weapon ? findMode(weapon, kind) : undefined;
  if (!weapon || !mode) {
    return { rounds, targetId: null, killed: false };
  }

  const dist = tileDistance(shooter.pos, targetPos);
  const acc = effectiveAccuracy(shooter, weapon, mode, dist);
  const spread = spreadForAccuracy(acc);
  // Sample against the SAME probability the preview reports. The clamped hit
  // chance maps back to an effective half-angle (chance * spread); when the
  // chance is not clamped this is exactly the geometric half-angle, so honest
  // cone behaviour is preserved while the MIN/MAX floor + ceiling (e.g. the
  // 0.99 "nothing is certain" cap) apply identically to preview and resolve.
  const chance = hitChance(shooter, weapon, mode, dist);
  const effHalf = chance * spread;

  const occupant = occupantAt(state, targetPos);
  const targetId: UnitId | null = occupant ? occupant.id : null;

  for (let i = 0; i < mode.shots; i++) {
    const deviation = state.rng.uniform(-spread, spread);
    const hit = Math.abs(deviation) <= effHalf;
    let damage = 0;
    if (hit && occupant && occupant.alive) {
      const raw = state.rng.uniform(
        weapon.damage * COMBAT.DAMAGE_MIN_MULT,
        weapon.damage * COMBAT.DAMAGE_MAX_MULT,
      );
      damage = Math.max(0, Math.round(raw));
      occupant.hp = Math.max(0, occupant.hp - damage);
    }
    rounds.push({ hit, damage, deviationRad: deviation });
  }

  let killed = false;
  if (occupant && occupant.hp <= 0 && occupant.alive) {
    occupant.alive = false;
    killed = true;
  }

  return { rounds, targetId, killed };
}
