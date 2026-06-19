/**
 * Enemy utility AI.
 *
 * The AI is decoupled from the reducer: it never imports battle.ts and never
 * mutates state directly. It reads the world through the pure helpers
 * (los / pathfinding / combat) and acts only through the {@link AiExecutor}
 * handed in, which performs the actual TU spend, reaction fire, and event
 * emission. After each exec call the AI re-reads unit state fresh from `state`,
 * since exec mutates it.
 *
 * Determinism: enemy ids are iterated in a fixed (sorted) order and every tie
 * is broken deterministically; the only randomness is whatever state.rng the
 * executor consumes.
 *
 * Purity: no DOM / three.js imports.
 */

import type {
  AiExecutor,
  BattleState,
  GameEvent,
  ShotMode,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "./types";
import { TU_COST } from "./types";
import { canSee, hasLineOfSight } from "./los";
import { findPath } from "./pathfinding";
import { inBounds, moveCost, tileTypeAt } from "./grid";
import { findMode, previewShot, reloadTuCost, tileDistance, tuCostForMode } from "./combat";
import { ITEMS } from "./content";

/** Hard cap on action iterations per unit, to guarantee termination. */
const MAX_ACTIONS_PER_UNIT = 6;

interface ShotPlan {
  target: Unit;
  mode: ShotMode;
  score: number;
}

/** TU to enter `to` from the adjacent `from` (mirrors pathfinding's rule). */
function stepCost(state: BattleState, from: Vec2, to: Vec2): number {
  const diagonal = from.x !== to.x && from.y !== to.y;
  const base = moveCost(state.grid, to.x, to.y);
  return diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
}

/** Living players, sorted nearest-first with a deterministic id tie-break. */
function playersByProximity(state: BattleState, from: Vec2): Unit[] {
  const players = state.units.filter((u) => u.faction === "player" && u.alive);
  players.sort((a, b) => {
    const da = tileDistance(from, a.pos);
    const db = tileDistance(from, b.pos);
    if (da !== db) return da - db;
    return a.id - b.id;
  });
  return players;
}

/**
 * Choose the best affordable shot at any visible target, or null. Utility is
 * expected damage (hitChance * shots * base damage), with a large bonus when
 * the shot is likely lethal and a small nudge toward lower-HP targets.
 */
function chooseShot(state: BattleState, unit: Unit, visible: Unit[]): ShotPlan | null {
  const weapon = state.weapons[unit.weaponId];
  if (!weapon) return null;

  let best: ShotPlan | null = null;
  const targets = [...visible].sort((a, b) => a.id - b.id);
  for (const target of targets) {
    for (const mode of weapon.modes) {
      const preview = previewShot(state, unit, target.pos, mode.kind);
      if (!preview.possible) continue;
      let score = preview.expectedHits * weapon.damage;
      const expectedDamage = preview.expectedHits * weapon.damage;
      if (expectedDamage >= target.hp) score += 1000; // likely kill
      score += 1 / (1 + target.hp); // prefer weaker targets
      if (best === null || score > best.score) {
        best = { target, mode, score };
      }
    }
  }
  return best;
}

/** Chebyshev (8-way) tile distance. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/**
 * Choose the best tile to lob a grenade at, or null. A throw is worth making
 * only when at least two living players fall inside the blast. Candidate tiles
 * are each visible player's own tile plus every tile adjacent to one; we score
 * by how many players a blast there would catch and keep the best tile within
 * throw range, breaking ties deterministically (lowest y, then x).
 */
function chooseGrenadeThrow(
  state: BattleState,
  unit: Unit,
  visiblePlayers: Unit[],
): Vec2 | null {
  const grenadeDef = state.items?.["grenade"] ?? ITEMS.grenade;
  if (!grenadeDef) return null;
  const instance = unit.items?.find((it) => it.itemId === "grenade" && it.uses > 0);
  if (!instance) return null;

  const radius = grenadeDef.blastRadius ?? 2;
  const maxRange = grenadeDef.throwRange ?? 6;
  const livingPlayers = state.units.filter((u) => u.faction === "player" && u.alive);

  // Candidate target tiles: each visible player's tile + its 8 neighbours.
  const candidates: Vec2[] = [];
  for (const p of visiblePlayers) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        candidates.push({ x: p.pos.x + dx, y: p.pos.y + dy });
      }
    }
  }

  let best: { tile: Vec2; covered: number } | null = null;
  for (const tile of candidates) {
    if (!inBounds(state.grid, tile.x, tile.y)) continue;
    if (chebyshev(unit.pos, tile) > maxRange) continue;

    let covered = 0;
    for (const p of livingPlayers) {
      if (chebyshev(p.pos, tile) <= radius) covered++;
    }
    if (covered < 2) continue;

    if (
      best === null ||
      covered > best.covered ||
      (covered === best.covered &&
        (tile.y < best.tile.y || (tile.y === best.tile.y && tile.x < best.tile.x)))
    ) {
      best = { tile: { x: tile.x, y: tile.y }, covered };
    }
  }

  return best?.tile ?? null;
}

interface MoveCandidate {
  tile: Vec2;
  cum: number;
  score: number;
}

/** Score a reachable tile: prefer firing positions, then cover, then closeness. */
function scoreTile(
  state: BattleState,
  tile: Vec2,
  target: Unit,
  weapon: Weapon | undefined,
): number {
  let score = 0;
  const d = tileDistance(tile, target.pos);
  if (
    weapon &&
    d <= weapon.range &&
    hasLineOfSight(state.grid, tile, target.pos)
  ) {
    score += 1000; // can open fire from here next iteration
  }
  const tt = tileTypeAt(state.grid, tile.x, tile.y);
  if (tt && tt.cover > 0) score += 10;
  score += 1 / (1 + d); // closer is better
  return score;
}

/** Pick the best candidate reachable within `budget`, or null. */
function pickBest(candidates: MoveCandidate[], budget: number): MoveCandidate | null {
  let best: MoveCandidate | null = null;
  for (const c of candidates) {
    if (c.cum > budget) continue;
    if (
      best === null ||
      c.score > best.score ||
      (c.score === best.score && c.cum > best.cum) ||
      (c.score === best.score && c.cum === best.cum && c.tile.x < best.tile.x) ||
      (c.score === best.score &&
        c.cum === best.cum &&
        c.tile.x === best.tile.x &&
        c.tile.y < best.tile.y)
    ) {
      best = c;
    }
  }
  return best;
}

/**
 * Advance `unit` toward the nearest player, stopping short of stepping onto it.
 * Returns true when a move was issued and the unit actually relocated.
 */
function tryMove(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  const players = playersByProximity(state, unit.pos);
  const target = players[0];
  if (!target) return false;

  const isBlocked = (x: number, y: number): boolean =>
    state.units.some(
      (o) => o.alive && o.id !== unit.id && o.pos.x === x && o.pos.y === y,
    );

  const result = findPath(state.grid, unit.pos, target.pos, { isBlocked });
  if (!result || result.path.length === 0) return false;

  const weapon = state.weapons[unit.weaponId];

  // Candidate tiles: the path excluding the target's own tile, with cumulative
  // entry cost from the unit's current position.
  const candidates: MoveCandidate[] = [];
  let prev: Vec2 = unit.pos;
  let cum = 0;
  for (let i = 0; i < result.path.length; i++) {
    const tile = result.path[i]!;
    cum += stepCost(state, prev, tile);
    const isTargetTile = tile.x === target.pos.x && tile.y === target.pos.y;
    if (!isTargetTile) {
      candidates.push({ tile, cum, score: scoreTile(state, tile, target, weapon) });
    }
    prev = tile;
  }
  if (candidates.length === 0) return false;

  // Prefer leaving a snap shot's worth of TU in reserve; fall back to spending
  // it all if that is the only way to make progress.
  const snap = weapon ? findMode(weapon, "snap") : undefined;
  const reserve = snap ? tuCostForMode(unit, snap) : 0;
  const reservedBudget = Math.max(0, unit.tu - reserve);

  let chosen = pickBest(candidates, reservedBudget);
  if (!chosen) chosen = pickBest(candidates, unit.tu);
  if (!chosen) return false;

  const before: Vec2 = { x: unit.pos.x, y: unit.pos.y };
  events.push(...exec.move(unit.id, chosen.tile));

  const after = state.units.find((u) => u.id === unit.id);
  if (!after) return false;
  return after.pos.x !== before.x || after.pos.y !== before.y;
}

function tryReload(
  state: BattleState,
  unit: Unit,
  exec: AiExecutor,
  events: GameEvent[],
): boolean {
  const weapon = state.weapons[unit.weaponId];
  if (!weapon || unit.ammo >= weapon.magazineSize) return false;
  if (unit.tu < reloadTuCost(unit, weapon)) return false;

  const ammoBefore = unit.ammo;
  const tuBefore = unit.tu;
  events.push(...exec.reload(unit.id));
  const after = state.units.find((u) => u.id === unit.id);
  return !!after && (after.ammo > ammoBefore || after.tu < tuBefore);
}

/**
 * Run the full enemy turn: each living enemy shoots a visible target when it
 * can, otherwise advances toward the nearest player. Returns every event the
 * executor produced, in order.
 */
export function runEnemyTurn(state: BattleState, exec: AiExecutor): GameEvent[] {
  const events: GameEvent[] = [];
  const enemyIds: UnitId[] = state.units
    .filter((u) => u.faction === "enemy" && u.alive)
    .map((u) => u.id)
    .sort((a, b) => a - b);

  for (const id of enemyIds) {
    for (let iteration = 0; iteration < MAX_ACTIONS_PER_UNIT; iteration++) {
      if (state.status !== "playing") return events;

      const unit = state.units.find((u) => u.id === id);
      if (!unit || !unit.alive || unit.tu <= 0) break;

      const visible = state.units.filter(
        (t) => t.faction === "player" && t.alive && canSee(state.grid, unit, t.pos),
      );

      // Grenade first: if a throw catches >= 2 players and TU allows, lob it.
      const grenadeTile = chooseGrenadeThrow(state, unit, visible);
      if (grenadeTile && exec.throwItem) {
        const grenadeDef = state.items?.["grenade"];
        const grenadeTu = grenadeDef
          ? Math.ceil((unit.stats.timeUnits * grenadeDef.tuPercent) / 100)
          : 0;
        if (unit.tu >= grenadeTu) {
          const thrown = exec.throwItem(unit.id, grenadeTile, "grenade");
          events.push(...thrown);
          if (thrown.length > 0) continue;
        }
      }

      const plan = visible.length > 0 ? chooseShot(state, unit, visible) : null;
      if (plan) {
        const tuBefore = unit.tu;
        events.push(...exec.shoot(unit.id, plan.target.pos, plan.mode.kind));
        const after = state.units.find((u) => u.id === id);
        if (!after || after.tu >= tuBefore) break; // no progress; avoid a loop
        continue;
      }

      if ((visible.length > 0 || unit.ammo === 0) && tryReload(state, unit, exec, events)) {
        continue;
      }

      if (!tryMove(state, unit, exec, events)) break;
    }
  }

  return events;
}
