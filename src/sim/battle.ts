/**
 * The authoritative battle reducer.
 *
 * This is the single place that mutates {@link BattleState} in response to
 * player {@link Command}s and that drives the enemy turn. It composes the pure
 * layers (pathfinding / los / combat / reaction / ai) and owns the concerns
 * those layers deliberately leave out: TU spend, facing changes, fog reveal,
 * event emission, turn handover, and victory detection.
 *
 * Purity: no DOM / three.js. All randomness flows through state.rng (via the
 * combat/reaction layers). Integer game state (TU/HP) only changes through the
 * documented rules below.
 */

import type {
  AiExecutor,
  BattleState,
  Command,
  Dir8,
  Faction,
  GameEvent,
  ShotKind,
  ShotPreview,
  Unit,
  UnitId,
  Vec2,
} from "./types";
import { TU_COST } from "./types";
import { cellIndex, moveCost } from "./grid";
import { dir8Towards, lineOfFire, visibleEnemyIds, visibleTiles } from "./los";
import { findPath } from "./pathfinding";
import { findMode, previewShot, reloadTuCost, resolveShot, tuCostForMode } from "./combat";
import { triggerReactions } from "./reaction";
import { runEnemyTurn } from "./ai";

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** Find a unit by id (alive or dead), or undefined. */
export function unitById(state: BattleState, id: UnitId): Unit | undefined {
  return state.units.find((u) => u.id === id);
}

/** The living unit standing on `pos`, or undefined. */
export function unitAt(state: BattleState, pos: Vec2): Unit | undefined {
  return state.units.find((u) => u.alive && u.pos.x === pos.x && u.pos.y === pos.y);
}

/** All living units of a faction. */
export function livingUnits(state: BattleState, faction: Faction): Unit[] {
  return state.units.filter((u) => u.faction === faction && u.alive);
}

// ---------------------------------------------------------------------------
// Turn / fog / victory bookkeeping
// ---------------------------------------------------------------------------

/** Restore every living unit of `faction` to its maximum Time Units. */
export function refillTU(state: BattleState, faction: Faction): void {
  for (const u of state.units) {
    if (u.faction === faction && u.alive) u.tu = u.stats.timeUnits;
  }
}

/** Add the tiles a player unit can currently see to the explored fog memory. */
export function revealFor(state: BattleState, unit: Unit): void {
  if (unit.faction !== "player" || !unit.alive) return;
  for (const t of visibleTiles(state.grid, unit)) {
    state.explored.add(cellIndex(state.grid, t.x, t.y));
  }
}

/**
 * Detect a finished battle. Sets `state.status` and returns a single gameOver
 * event the first time an objective is extracted or a side is wiped out; returns null while the game is
 * still playing (or already decided, so the event fires exactly once).
 */
export function checkVictory(state: BattleState): GameEvent | null {
  if (state.status !== "playing") return null;
  if (state.objective?.extracted) {
    state.status = "player_win";
    return { type: "gameOver", status: "player_win" };
  }
  const enemiesAlive = state.units.some((u) => u.faction === "enemy" && u.alive);
  const playersAlive = state.units.some((u) => u.faction === "player" && u.alive);
  if (!enemiesAlive) {
    if (state.objective) {
      state.objective.recovered = true;
      state.objective.extracted = true;
    }
    state.status = "player_win";
    return { type: "gameOver", status: "player_win" };
  }
  if (!playersAlive) {
    state.status = "enemy_win";
    return { type: "gameOver", status: "enemy_win" };
  }
  return null;
}

export function canRecoverObjective(state: BattleState, unit: Unit): boolean {
  const objective = state.objective;
  if (!objective || objective.recovered || objective.kind !== "recover") return false;
  if (!unit.alive || unit.faction !== "player") return false;
  const dx = Math.abs(unit.pos.x - objective.target.x);
  const dy = Math.abs(unit.pos.y - objective.target.y);
  return Math.max(dx, dy) === 1;
}

export function canExtractObjective(state: BattleState, unit: Unit): boolean {
  const objective = state.objective;
  if (!objective || !objective.recovered || objective.extracted || objective.kind !== "recover") return false;
  if (!unit.alive || unit.faction !== "player" || objective.recoveredBy !== unit.id) return false;
  return objective.extractionZone.some((tile) => tile.x === unit.pos.x && tile.y === unit.pos.y);
}

function blocksKnownMovement(state: BattleState, mover: Unit, other: Unit): boolean {
  if (!other.alive || other.id === mover.id) return false;
  if (mover.faction === "player" && other.faction === "enemy") {
    return visibleEnemyIds(state, "player").has(other.id);
  }
  return true;
}

function knownHostileAt(state: BattleState, shooter: Unit, target: Vec2): Unit | undefined {
  const occupant = unitAt(state, target);
  if (!occupant || occupant.faction === shooter.faction) return undefined;
  return visibleEnemyIds(state, shooter.faction).has(occupant.id) ? occupant : undefined;
}

function blockedShotPreview(reason: string): ShotPreview {
  return {
    possible: false,
    hitChance: 0,
    expectedHits: 0,
    tuCost: 0,
    ammoCost: 0,
    reason,
  };
}

function targetBlockReason(state: BattleState, shooter: Unit, target: Vec2): string {
  const occupant = unitAt(state, target);
  return occupant && occupant.faction === shooter.faction ? "friendly target" : "no visible hostile";
}

export function executeRecoverObjective(state: BattleState, unitId: UnitId): GameEvent[] {
  const unit = unitById(state, unitId);
  if (!unit || !unit.alive) return [{ type: "blocked", reason: "no such unit" }];
  if (!canRecoverObjective(state, unit)) return [{ type: "blocked", reason: "objective out of reach" }];
  return recoverObjective(state, unit);
}

export function executeReload(state: BattleState, unitId: UnitId): GameEvent[] {
  const unit = unitById(state, unitId);
  if (!unit || !unit.alive) return [{ type: "blocked", reason: "no such unit" }];

  const weapon = state.weapons[unit.weaponId];
  if (!weapon) return [{ type: "blocked", reason: "no weapon" }];
  if (unit.ammo >= weapon.magazineSize) return [{ type: "blocked", reason: "magazine full" }];

  const cost = reloadTuCost(unit, weapon);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];

  unit.tu -= cost;
  unit.ammo = weapon.magazineSize;
  return [{ type: "reloaded", unitId, ammo: unit.ammo, tuLeft: unit.tu }];
}

function recoverObjective(state: BattleState, unit: Unit): GameEvent[] {
  const objective = state.objective;
  if (!objective) return [];

  objective.recovered = true;
  objective.extracted = false;
  objective.recoveredBy = unit.id;
  const events: GameEvent[] = [
    {
      type: "objectiveRecovered",
      unitId: unit.id,
      label: objective.label,
      target: { x: objective.target.x, y: objective.target.y },
    },
  ];
  events.push(...checkObjectiveExtraction(state, unit));
  return events;
}

function checkObjectiveRecovery(state: BattleState, unit: Unit): GameEvent[] {
  if (!canRecoverObjective(state, unit)) return [];
  return recoverObjective(state, unit);
}

function extractObjective(state: BattleState, unit: Unit): GameEvent[] {
  const objective = state.objective;
  if (!objective) return [];

  objective.extracted = true;
  const events: GameEvent[] = [
    {
      type: "objectiveExtracted",
      unitId: unit.id,
      label: objective.label,
      target: { x: unit.pos.x, y: unit.pos.y },
    },
  ];
  const over = checkVictory(state);
  if (over) events.push(over);
  return events;
}

function checkObjectiveExtraction(state: BattleState, unit: Unit): GameEvent[] {
  if (!canExtractObjective(state, unit)) return [];
  return extractObjective(state, unit);
}

function dropObjectiveIfCarrierDown(state: BattleState, unitId: UnitId): GameEvent[] {
  const objective = state.objective;
  if (!objective || !objective.recovered || objective.extracted || objective.recoveredBy !== unitId) return [];
  const carrier = unitById(state, unitId);
  if (!carrier || carrier.alive) return [];

  objective.recovered = false;
  objective.recoveredBy = undefined;
  objective.target = { x: carrier.pos.x, y: carrier.pos.y };
  return [
    {
      type: "objectiveDropped",
      unitId,
      label: objective.label,
      target: { x: carrier.pos.x, y: carrier.pos.y },
    },
  ];
}

// ---------------------------------------------------------------------------
// Action executors (also used by the AI executor + tests)
// ---------------------------------------------------------------------------

/** Minimum cyclic 45°-steps between two facings (0..4). */
function facingSteps(a: Dir8, b: Dir8): number {
  const diff = Math.abs(a - b);
  return Math.min(diff, 8 - diff);
}

/**
 * Rotate a unit to `dir`, paying TURN_STEP per 45°-step. Blocked (no state
 * change) when the unit can't afford the pivot. Turning never triggers
 * reaction fire.
 */
export function executeFace(state: BattleState, unitId: UnitId, dir: Dir8): GameEvent[] {
  const unit = unitById(state, unitId);
  if (!unit || !unit.alive) return [{ type: "blocked", reason: "no such unit" }];

  const cost = facingSteps(unit.facing, dir) * TU_COST.TURN_STEP;
  if (cost > unit.tu) return [{ type: "blocked", reason: "not enough TU" }];

  unit.tu -= cost;
  unit.facing = dir;
  revealFor(state, unit);
  return [{ type: "faced", unitId, dir, tuLeft: unit.tu }];
}

/**
 * Walk a unit toward `to` along the cheapest path (other living units block
 * intermediate tiles; the goal itself is allowed as a destination). Each step
 * pays its TU cost (diagonal = floor(base * DIAGONAL_MULT)); the walk stops the
 * moment the next step is unaffordable. After every step, reaction fire is
 * resolved against the mover; if the mover dies (or the battle ends) the walk
 * stops immediately.
 */
export function executeMove(state: BattleState, unitId: UnitId, to: Vec2): GameEvent[] {
  const unit = unitById(state, unitId);
  if (!unit || !unit.alive) return [{ type: "blocked", reason: "no such unit" }];

  // findPath deliberately exempts the goal tile from unit occupancy (the AI
  // relies on that to path toward, but stop short of, an occupied tile). Guard
  // it here so a player move can never stack two living units on one tile.
  const blocker = unitAt(state, to);
  if (blocker && blocksKnownMovement(state, unit, blocker)) {
    return [{ type: "blocked", reason: "occupied" }];
  }

  const isBlocked = (x: number, y: number): boolean =>
    state.units.some(
      (o) => o.pos.x === x && o.pos.y === y && blocksKnownMovement(state, unit, o),
    );

  const result = findPath(state.grid, unit.pos, to, { isBlocked });
  if (!result || result.path.length === 0) {
    return [{ type: "blocked", reason: "no path" }];
  }

  // Honour the unit's reaction-fire reserve: stop walking before a step would
  // drop TU below the cost of the reserved firing mode (no reservation for
  // "none", or when the weapon lacks that mode).
  const reserveKind: ShotKind | undefined =
    unit.reserve === "none" ? undefined : unit.reserve;
  const reserveWeapon = state.weapons[unit.weaponId];
  const reserveMode =
    reserveKind && reserveWeapon ? findMode(reserveWeapon, reserveKind) : undefined;
  const reservedTU = reserveMode ? tuCostForMode(unit, reserveMode) : 0;

  const events: GameEvent[] = [];
  for (const step of result.path) {
    const occupant = unitAt(state, step);
    if (occupant && occupant.id !== unitId) {
      if (unit.faction === "player" && occupant.faction === "enemy") {
        unit.facing = dir8Towards(unit.pos, step);
        revealFor(state, unit);
        events.push({ type: "blocked", reason: "hostile contact" });
      } else {
        events.push({ type: "blocked", reason: "occupied" });
      }
      break;
    }

    const diagonal = step.x !== unit.pos.x && step.y !== unit.pos.y;
    const base = moveCost(state.grid, step.x, step.y);
    const cost = diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
    if (!Number.isFinite(cost) || cost > unit.tu || unit.tu - cost < reservedTU) break;

    const from: Vec2 = { x: unit.pos.x, y: unit.pos.y };
    const facing = dir8Towards(from, step);
    unit.tu -= cost;
    unit.pos = { x: step.x, y: step.y };
    unit.facing = facing;
    revealFor(state, unit);
    events.push({
      type: "moveStep",
      unitId,
      from,
      to: { x: step.x, y: step.y },
      facing,
      tuLeft: unit.tu,
    });

    events.push(...triggerReactions(state, unit));

    if (!unit.alive) {
      events.push(...dropObjectiveIfCarrierDown(state, unit.id));
      const over = checkVictory(state);
      if (over) events.push(over);
      break;
    }
    events.push(...checkObjectiveExtraction(state, unit));
    if (state.status !== "playing") break;
    events.push(...checkObjectiveRecovery(state, unit));
    if (state.status !== "playing") break;
    events.push(...checkObjectiveExtraction(state, unit));
    if (state.status !== "playing") break;
  }

  return events;
}

/**
 * Fire a deliberate shot at `target`. Validated through previewShot; an
 * impossible shot is rejected with a `blocked` event and costs nothing. On a
 * valid shot the shooter turns to face the target (free), pays the mode's TU,
 * and rolls the action. A lethal hit emits `died` and, if it ends the battle,
 * `gameOver`.
 */
export function executeShoot(
  state: BattleState,
  unitId: UnitId,
  target: Vec2,
  kind: ShotKind,
): GameEvent[] {
  const unit = unitById(state, unitId);
  if (!unit || !unit.alive) return [{ type: "blocked", reason: "no such unit" }];
  if (!knownHostileAt(state, unit, target)) {
    return [{ type: "blocked", reason: targetBlockReason(state, unit, target) }];
  }

  const preview = previewShot(state, unit, target, kind);
  if (!preview.possible) {
    return [{ type: "blocked", reason: preview.reason ?? "shot not possible" }];
  }

  const weapon = state.weapons[unit.weaponId];
  const mode = weapon ? findMode(weapon, kind) : undefined;
  if (!weapon || !mode) {
    return [{ type: "blocked", reason: "no weapon" }];
  }

  // Facing the target is free; then pay for the shot and resolve it. The shot
  // originates from the lean tile when the direct line is corner-blocked.
  const lof = lineOfFire(state.grid, unit.pos, target);
  unit.facing = dir8Towards(unit.pos, target);
  unit.tu -= tuCostForMode(unit, mode);
  unit.ammo = Math.max(0, unit.ammo - mode.shots);

  const result = resolveShot(state, unit, target, kind);
  const events: GameEvent[] = [
    {
      type: "shot",
      shooterId: unitId,
      targetId: result.targetId,
      targetPos: { x: target.x, y: target.y },
      originPos: lof.origin,
      mode: kind,
      rounds: result.rounds,
      tuLeft: unit.tu,
      reaction: false,
    },
  ];

  if (result.killed && result.targetId !== null) {
    events.push({ type: "died", unitId: result.targetId });
    events.push(...dropObjectiveIfCarrierDown(state, result.targetId));
    const over = checkVictory(state);
    if (over) events.push(over);
  }

  return events;
}

// ---------------------------------------------------------------------------
// Turn handover
// ---------------------------------------------------------------------------

/**
 * End the player's turn, run the full enemy turn through the AI, then (unless
 * the battle ended) hand control back to the player for a new round. Returns
 * the complete ordered event stream so the renderer can replay the enemy turn.
 */
function endPlayerTurn(state: BattleState): GameEvent[] {
  const events: GameEvent[] = [{ type: "turnEnded", faction: "player" }];

  state.activeFaction = "enemy";
  refillTU(state, "enemy");
  events.push({ type: "turnStarted", faction: "enemy", turn: state.turn });

  const exec: AiExecutor = {
    move: (id, to) => executeMove(state, id, to),
    shoot: (id, target, mode) => executeShoot(state, id, target, mode),
    reload: (id) => executeReload(state, id),
    face: (id, dir) => executeFace(state, id, dir),
  };
  events.push(...runEnemyTurn(state, exec));

  // The AI ended the game (e.g. wiped out the squad): stop here. The gameOver
  // event was already emitted by the executor that landed the killing blow.
  if (state.status !== "playing") return events;

  events.push({ type: "turnEnded", faction: "enemy" });
  state.turn++;
  state.activeFaction = "player";
  refillTU(state, "player");
  for (const u of state.units) {
    if (u.faction === "player" && u.alive) revealFor(state, u);
  }
  events.push({ type: "turnStarted", faction: "player", turn: state.turn });

  return events;
}

// ---------------------------------------------------------------------------
// Command entry point
// ---------------------------------------------------------------------------

/**
 * Apply a player command and return the resulting ordered events. Player
 * actions are only honoured during the player's turn while the battle is still
 * playing and the targeted unit is a living player unit; everything else is
 * rejected with a `blocked` event.
 */
export function applyCommand(state: BattleState, cmd: Command): GameEvent[] {
  if (state.status !== "playing") {
    return [{ type: "blocked", reason: "game over" }];
  }
  if (state.activeFaction !== "player") {
    return [{ type: "blocked", reason: "not your turn" }];
  }

  if (cmd.type === "endTurn") {
    return endPlayerTurn(state);
  }

  const unit = unitById(state, cmd.unitId);
  if (!unit || !unit.alive || unit.faction !== "player") {
    return [{ type: "blocked", reason: "invalid unit" }];
  }

  switch (cmd.type) {
    case "move":
      return executeMove(state, cmd.unitId, cmd.to);
    case "face":
      return executeFace(state, cmd.unitId, cmd.dir);
    case "shoot":
      return executeShoot(state, cmd.unitId, cmd.target, cmd.mode);
    case "reload":
      return executeReload(state, cmd.unitId);
    case "recoverObjective":
      return executeRecoverObjective(state, cmd.unitId);
    case "setReserve":
      unit.reserve = cmd.reserve;
      return [];
  }
}

/** Thin, side-effect-free wrapper around combat.previewShot for the UI. */
export function previewPlayerShot(
  state: BattleState,
  unitId: UnitId,
  target: Vec2,
  kind: ShotKind,
): ShotPreview {
  const unit = unitById(state, unitId);
  if (!unit) {
    return {
      possible: false,
      hitChance: 0,
      expectedHits: 0,
      tuCost: 0,
      ammoCost: 0,
      reason: "no such unit",
    };
  }
  if (!knownHostileAt(state, unit, target)) {
    return blockedShotPreview(targetBlockReason(state, unit, target));
  }
  return previewShot(state, unit, target, kind);
}
