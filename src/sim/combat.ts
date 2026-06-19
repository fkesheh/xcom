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
  BlastHit,
  Grid,
  PanicBehavior,
  ShotKind,
  ShotMode,
  ShotPreview,
  ShotRound,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "./types";
import { COMBAT, COVER, MORALE, STANCE } from "./types";
import { lineOfFire } from "./los";
import { tileTypeAt } from "./grid";

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
  // Kneeling steadies the aim: the classic-scale bonus is added to the firer's
  // skill before scaling, so a 60-accuracy kneel shoots like an 80-accuracy stand.
  const skill =
    shooter.stats.firingAccuracy +
    (shooter.stance === "kneel" ? STANCE.KNEEL_ACCURACY_BONUS : 0);
  return clamp01((skill / 100) * (mode.accuracy / 100) * rangeFactor);
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
 * closer => higher, more accurate => higher. `defense` (default 0) is the
 * cover + kneeling-target reduction in [0, 0.8]; it shrinks the raw odds BEFORE
 * the MIN/MAX cap, so the preview and the resolve roll agree exactly.
 */
export function hitChance(
  shooter: Unit,
  weapon: Weapon,
  mode: ShotMode,
  dist: number,
  defense: number = 0,
): number {
  const acc = effectiveAccuracy(shooter, weapon, mode, dist);
  const spread = spreadForAccuracy(acc);
  const half = targetHalfAngle(dist);
  const defended = (half / spread) * (1 - defense);
  return clamp(defended, COMBAT.MIN_HIT_CHANCE, COMBAT.MAX_HIT_CHANCE);
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
 * Best directional cover protecting `defender` from a shot fired by `shooter`.
 * Pure: no rng, no mutation. Looks at the 1-2 cardinal neighbors of the defender
 * that sit between it and the shooter (sign(shooter - defender) per axis) and
 * returns the max cover value among them, or 0 when none provides cover. A
 * diagonal shooter checks both axis neighbors (take the max); a cardinal one
 * checks only the single tile it must fire across.
 */
export function coverDefenseFor(grid: Grid, defender: Vec2, shooter: Vec2): 0 | 1 | 2 {
  const dx = Math.sign(shooter.x - defender.x);
  const dy = Math.sign(shooter.y - defender.y);
  let best: 0 | 1 | 2 = 0;
  if (dx !== 0) {
    const tile = tileTypeAt(grid, defender.x + dx, defender.y);
    if (tile && tile.cover > best) best = tile.cover;
  }
  if (dy !== 0) {
    const tile = tileTypeAt(grid, defender.x, defender.y + dy);
    if (tile && tile.cover > best) best = tile.cover;
  }
  return best;
}

/**
 * Total hit-chance reduction for a shot arriving at `defenderPos` from
 * `shooterPos`: directional cover plus the smaller-profile bonus when the
 * defender is kneeling. Capped at 0.8 so a shot always keeps at least 20% of its
 * base odds. Pure apart from reading the defender's stance field.
 */
function totalDefenseFor(
  grid: Grid,
  defenderPos: Vec2,
  shooterPos: Vec2,
  defender: Unit | undefined,
): number {
  const cover = coverDefenseFor(grid, defenderPos, shooterPos);
  const coverDefense =
    cover === 2 ? COVER.FULL_DEFENSE : cover === 1 ? COVER.HALF_DEFENSE : 0;
  const stanceDefense =
    defender && defender.stance === "kneel" ? STANCE.KNEEL_TARGET_DEFENSE : 0;
  return Math.min(0.8, coverDefense + stanceDefense);
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
  const defender = occupantAt(state, targetPos);
  const defense = totalDefenseFor(state.grid, targetPos, shooter.pos, defender);
  const chance = hitChance(shooter, weapon, mode, dist, defense);
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
  const occupant = occupantAt(state, targetPos);
  // Sample against the SAME probability the preview reports. The clamped hit
  // chance maps back to an effective half-angle (chance * spread); when the
  // chance is not clamped this is exactly the geometric half-angle, so honest
  // cone behaviour is preserved while the MIN/MAX floor + ceiling (e.g. the
  // 0.99 "nothing is certain" cap) apply identically to preview and resolve.
  // Cover + a kneeling target shrink the odds through the SAME totalDefense so
  // the displayed chance matches what the dice actually roll.
  const defense = totalDefenseFor(state.grid, targetPos, shooter.pos, occupant);
  const chance = hitChance(shooter, weapon, mode, dist, defense);
  const effHalf = chance * spread;

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

// ---------------------------------------------------------------------------
// Area-of-effect blasts, items, morale, and panic
// ---------------------------------------------------------------------------
//
// These pure helpers extend the combat model for consumable battlefield items
// (grenades / medkits) and the morale + panic layer. As with resolveShot, the
// ONLY randomness is state.rng, advanced in a stable order; HP/morale mutation
// happens here, while TU spend + event emission stay with the reducer.

/** Chebyshev (chessboard) distance between two tiles: max(|dx|, |dy|). */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Resolve an area-of-effect blast centered on `center`. Every LIVING unit
 * within `radius` (Chebyshev) takes damage that falls off with distance from
 * the center; each hit rolls the same damage spread resolveShot uses. The rng
 * is advanced once per struck unit, in ascending unit-id order, so the same
 * (state, center, radius, baseDamage) is fully deterministic. Mutates hp/alive
 * on the struck units directly (like resolveShot).
 */
export function resolveBlast(
  state: BattleState,
  center: Vec2,
  radius: number,
  baseDamage: number,
): { hits: BlastHit[] } {
  const hits: BlastHit[] = [];
  const affected = state.units
    .filter((u) => u.alive && chebyshev(u.pos, center) <= radius)
    .sort((a, b) => a.id - b.id);

  for (const u of affected) {
    const dist = chebyshev(u.pos, center);
    const falloff = Math.max(0.2, 1 - dist * 0.25);
    const dmg = Math.max(
      1,
      Math.round(
        baseDamage * falloff * state.rng.uniform(COMBAT.DAMAGE_MIN_MULT, COMBAT.DAMAGE_MAX_MULT),
      ),
    );
    u.hp -= dmg;
    let killed = false;
    if (u.hp <= 0) {
      u.hp = 0;
      u.alive = false;
      killed = true;
    }
    hits.push({ unitId: u.id, damage: dmg, killed });
  }
  return { hits };
}

/**
 * Heal `target` by `amount`, capped at its max health. Mutates hp directly and
 * returns the HP actually gained (0 when already at full).
 */
export function resolveHeal(state: BattleState, target: Unit, amount: number): { healed: number } {
  void state; // resolveHeal is side-effect-free apart from the target's hp; kept for API symmetry.
  const before = target.hp;
  target.hp = Math.min(target.stats.health, before + amount);
  return { healed: target.hp - before };
}

/** A unit's bravery, falling back to the classic rookie baseline when unset. */
export function braveryOf(unit: Unit): number {
  return unit.stats.bravery ?? MORALE.DEFAULT_BRAVERY;
}

/**
 * Per-turn morale recovery, scaled by bravery (bravery 60 => the configured
 * base; the result is never below 1 so a brave unit always steadies a little).
 */
export function moraleRecoveryFor(unit: Unit): number {
  return Math.max(1, Math.round((MORALE.RECOVERY_PER_TURN * braveryOf(unit)) / 60));
}

/**
 * Roll whether a unit panics this turn and how. Returns null when morale is at
 * or above the panic threshold, or when the unit resists via its bravery.
 * Advances the rng once to resist, then (on failure) once more to pick the
 * behavior. Pure apart from the rng stream; does NOT mutate the unit.
 */
export function rollPanic(state: BattleState, unit: Unit): PanicBehavior | null {
  const morale = unit.morale ?? MORALE.MAX;
  if (morale >= MORALE.PANIC_THRESHOLD) return null;
  const resistChance = braveryOf(unit) / 120;
  if (state.rng.uniform(0, 1) < resistChance) return null;
  const r = state.rng.uniform(0, 1);
  if (r < 0.5) return "freeze";
  if (r < 0.8) return "flee";
  return "berserk";
}

/**
 * Apply a morale loss (clamped to [0, MAX]) and return the new morale. If the
 * unit has no morale value yet it is treated as MAX for the clamp, then the
 * result is written back so the unit joins the morale system.
 */
export function applyMoraleLoss(unit: Unit, loss: number): number {
  unit.morale = clamp((unit.morale ?? MORALE.MAX) - loss, 0, MORALE.MAX);
  return unit.morale;
}
