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
  ItemInstance,
  PanicBehavior,
  ShotKind,
  ShotPreview,
  Unit,
  UnitId,
  Vec2,
} from "./types";
import { DIR8_VECTORS, MORALE, TU_COST } from "./types";
import { cellIndex, moveCost } from "./grid";
import { blocksMove, inBounds } from "./grid";
import { canSee, dir8Towards, lineOfFire, visibleEnemyIds, visibleTiles } from "./los";
import { findPath } from "./pathfinding";
import {
  applyMoraleLoss,
  chebyshev,
  findMode,
  moraleRecoveryFor,
  previewShot,
  reloadTuCost,
  resolveBlast,
  resolveHeal,
  resolveShot,
  rollPanic,
  tuCostForMode,
} from "./combat";
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
    events.push(...moraleEventsForCasualty(state, result.targetId, true));
    const over = checkVictory(state);
    if (over) events.push(over);
  } else if (result.targetId !== null && result.rounds.some((r) => r.damage > 0)) {
    events.push(...moraleEventsForCasualty(state, result.targetId, false));
  }

  return events;
}

// ---------------------------------------------------------------------------
// Morale on casualties (the emotional core of the system)
// ---------------------------------------------------------------------------

/**
 * Emit morale events for a wound or death, threaded into the event stream
 * right after the causing shot/blast/died event.
 *
 * On a NON-lethal wound: the victim loses SELF_WOUNDED_LOSS and each living
 * same-faction ally within 6 tiles loses ALLY_WOUNDED_LOSS. On a DEATH: each
 * living same-faction ally within 8 tiles loses ALLY_DEATH_LOSS (the fallen
 * unit itself is gone, so no self-wound applies).
 *
 * Units only participate in the morale system once they carry a `morale` value
 * (the system is opt-in via setup); a moraleChanged event is emitted only when
 * the value actually changes. This helper does NOT advance the rng.
 */
function moraleEventsForCasualty(
  state: BattleState,
  woundedId: UnitId,
  killed: boolean,
): GameEvent[] {
  const events: GameEvent[] = [];
  const victim = unitById(state, woundedId);
  if (!victim || victim.morale === undefined) return events;
  const faction = victim.faction;
  const woundRadius = 6;
  const deathRadius = 8;

  if (!killed) {
    const before = victim.morale;
    const after = applyMoraleLoss(victim, MORALE.SELF_WOUNDED_LOSS);
    if (after !== before) {
      events.push({ type: "moraleChanged", unitId: woundedId, morale: after });
    }
    for (const ally of state.units) {
      if (ally.id === woundedId || !ally.alive || ally.faction !== faction) continue;
      if (ally.morale === undefined) continue;
      if (chebyshev(ally.pos, victim.pos) > woundRadius) continue;
      const aBefore = ally.morale;
      const aAfter = applyMoraleLoss(ally, MORALE.ALLY_WOUNDED_LOSS);
      if (aAfter !== aBefore) {
        events.push({ type: "moraleChanged", unitId: ally.id, morale: aAfter });
      }
    }
    return events;
  }

  for (const ally of state.units) {
    if (ally.id === woundedId || !ally.alive || ally.faction !== faction) continue;
    if (ally.morale === undefined) continue;
    if (chebyshev(ally.pos, victim.pos) > deathRadius) continue;
    const aBefore = ally.morale;
    const aAfter = applyMoraleLoss(ally, MORALE.ALLY_DEATH_LOSS);
    if (aAfter !== aBefore) {
      events.push({ type: "moraleChanged", unitId: ally.id, morale: aAfter });
    }
  }
  return events;
}

/** Drop `inst` from its carrier, either by spending a charge or removing it. */
function consumeItem(unit: Unit, inst: ItemInstance): void {
  if (inst.uses > 1) {
    inst.uses--;
    return;
  }
  unit.items = unit.items?.filter((x) => x !== inst);
}

/**
 * Throw a grenade at `target` and resolve its blast. Performs no faction check:
 * the same path serves the player command and the enemy AI executor (mirroring
 * how executeMove/executeShoot back the AiExecutor move/shoot). TU is spent,
 * the charge is consumed, the blast is resolved, and morale/died events are
 * threaded in for every struck unit. Throwing does NOT trigger reaction fire.
 */
function performThrow(state: BattleState, unit: Unit, target: Vec2, itemId: string): GameEvent[] {
  const inst = unit.items?.find((it) => it.itemId === itemId && it.uses > 0);
  const def = state.items?.[itemId];
  if (!inst || !def || def.kind !== "grenade") {
    return [{ type: "blocked", reason: "no grenade" }];
  }
  const cost = Math.ceil((unit.stats.timeUnits * def.tuPercent) / 100);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];
  const maxRange = def.throwRange ?? 6;
  if (chebyshev(unit.pos, target) > maxRange) {
    return [{ type: "blocked", reason: "out of throw range" }];
  }
  if (!inBounds(state.grid, target.x, target.y)) {
    return [{ type: "blocked", reason: "out of bounds" }];
  }

  unit.tu -= cost;
  consumeItem(unit, inst);

  const radius = def.blastRadius ?? 1;
  const events: GameEvent[] = [
    {
      type: "itemThrown",
      unitId: unit.id,
      itemId,
      from: { x: unit.pos.x, y: unit.pos.y },
      to: { x: target.x, y: target.y },
      tuLeft: unit.tu,
    },
  ];

  const { hits } = resolveBlast(state, target, radius, def.damage ?? 0);
  events.push({
    type: "blastDetonated",
    itemId,
    center: { x: target.x, y: target.y },
    radius,
    hits,
  });

  for (const hit of hits) {
    events.push(...moraleEventsForCasualty(state, hit.unitId, hit.killed));
    if (hit.killed) {
      events.push({ type: "died", unitId: hit.unitId });
      events.push(...dropObjectiveIfCarrierDown(state, hit.unitId));
    }
  }

  const over = checkVictory(state);
  if (over) events.push(over);

  return events;
}

/** Use a medkit on an adjacent ally, restoring HP capped at the target's max. */
function executeUseItem(
  state: BattleState,
  unit: Unit,
  targetId: UnitId,
  itemId: string,
): GameEvent[] {
  const target = unitById(state, targetId);
  if (!target || !target.alive) return [{ type: "blocked", reason: "no target" }];
  const inst = unit.items?.find((it) => it.itemId === itemId && it.uses > 0);
  const def = state.items?.[itemId];
  if (!inst || !def || def.kind !== "medkit") {
    return [{ type: "blocked", reason: "no medkit" }];
  }
  if (target.faction !== unit.faction) return [{ type: "blocked", reason: "not an ally" }];
  if (chebyshev(unit.pos, target.pos) > 1) return [{ type: "blocked", reason: "too far" }];
  const cost = Math.ceil((unit.stats.timeUnits * def.tuPercent) / 100);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];

  unit.tu -= cost;
  consumeItem(unit, inst);

  const { healed } = resolveHeal(state, target, def.healAmount ?? 0);
  return [
    {
      type: "itemUsed",
      unitId: unit.id,
      targetId: target.id,
      itemId,
      healed,
      tuLeft: unit.tu,
    },
  ];
}

/**
 * Prime a carried grenade with a fuse. Costs half the throw TU. State change
 * only: the primed grenade detonates on its carrier at the start of the
 * carrier's next turn (see detonatePrimedGrenades). Emits no events; the HUD
 * reflects the primed state on sync.
 */
function executePrimeItem(
  state: BattleState,
  unit: Unit,
  itemId: string,
  fuseTurns: number,
): GameEvent[] {
  const inst = unit.items?.find((it) => it.itemId === itemId && it.uses > 0);
  const def = state.items?.[itemId];
  if (!inst || !def || def.kind !== "grenade") {
    return [{ type: "blocked", reason: "no grenade" }];
  }
  const cost = Math.ceil((unit.stats.timeUnits * def.tuPercent * 0.5) / 100);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];

  unit.tu -= cost;
  inst.primed = true;
  inst.fuseTurns = Math.max(1, fuseTurns);
  state.log.push(`${unit.name} primes a ${def.name}.`);
  return [];
}

// ---------------------------------------------------------------------------
// Start-of-turn: primed detonation, morale recovery, and panic
// ---------------------------------------------------------------------------
//
// At the start of each faction's turn, BEFORE it acts: carried primed grenades
// tick down (and detonate on their carrier at zero), living units recover a
// bravery-scaled amount of morale, and any unit still below the panic threshold
// must roll for panic. All three phases iterate living units of the starting
// faction in ascending id order for determinism; only the panic phase advances
// the rng.

/** Resolve all primed grenades carried by living units of `faction`. */
function detonatePrimedGrenades(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  const carriers = state.units
    .filter((u) => u.faction === faction && u.alive && u.items && u.items.length > 0)
    .sort((a, b) => a.id - b.id);

  for (const carrier of carriers) {
    // Snapshot the carried items: a detonation may remove an entry, and we
    // process every primed charge the carrier began the turn with.
    const carried = carrier.items ? [...carrier.items] : [];
    for (const inst of carried) {
      if (!inst.primed || inst.uses <= 0) continue;
      inst.fuseTurns = Math.max(0, (inst.fuseTurns ?? 1) - 1);
      if ((inst.fuseTurns ?? 0) > 0) continue;

      const def = state.items?.[inst.itemId];
      // Detonate even if the definition is missing (treat as a default grenade)
      // and always clear the spent charge afterward.
      const radius = def?.blastRadius ?? 1;
      const damage = def?.damage ?? 0;
      const { hits } = resolveBlast(state, carrier.pos, radius, damage);
      events.push({
        type: "blastDetonated",
        itemId: inst.itemId,
        center: { x: carrier.pos.x, y: carrier.pos.y },
        radius,
        hits,
      });
      for (const hit of hits) {
        events.push(...moraleEventsForCasualty(state, hit.unitId, hit.killed));
        if (hit.killed) {
          events.push({ type: "died", unitId: hit.unitId });
          events.push(...dropObjectiveIfCarrierDown(state, hit.unitId));
        }
      }
      carrier.items = carrier.items?.filter((x) => x !== inst);
    }
  }

  const over = checkVictory(state);
  if (over) events.push(over);
  return events;
}

/** Recover morale for every living unit of `faction` (opt-in via `morale`). */
function recoverMorale(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  for (const u of state.units) {
    if (u.faction !== faction || !u.alive || u.morale === undefined) continue;
    const before = u.morale;
    const after = Math.min(MORALE.MAX, before + moraleRecoveryFor(u));
    if (after !== before) {
      u.morale = after;
      events.push({ type: "moraleChanged", unitId: u.id, morale: after });
    }
  }
  return events;
}

/** Nearest living enemy of `unit` (Chebyshev), tie-broken by ascending id. */
function nearestLivingEnemy(state: BattleState, unit: Unit): Unit | undefined {
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const o of state.units) {
    if (!o.alive || o.faction === unit.faction) continue;
    const d = chebyshev(unit.pos, o.pos);
    // Units are spawned in ascending id order, so strict `<` keeps the lowest id.
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/** Nearest living enemy of `unit` that `unit` can currently see. */
function nearestVisibleHostile(state: BattleState, unit: Unit): Unit | undefined {
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const o of state.units) {
    if (!o.alive || o.faction === unit.faction) continue;
    if (!canSee(state.grid, unit, o.pos)) continue;
    const d = chebyshev(unit.pos, o.pos);
    if (d < bestD) {
      bestD = d;
      best = o;
    }
  }
  return best;
}

/**
 * Best-effort one-tile flee: step onto the walkable, unoccupied adjacent tile
 * that maximizes Chebyshev distance from the nearest living enemy. Emits a
 * moveStep (with honest tuLeft) and pays the step's move cost. Returns false
 * when no safe step exists. Deterministic: ties keep the lowest Dir8 index.
 */
function fleeOneTile(state: BattleState, unit: Unit, events: GameEvent[]): boolean {
  const enemy = nearestLivingEnemy(state, unit);
  if (!enemy) return false;

  let best: Vec2 | undefined;
  let bestDist = -1;
  for (let i = 0; i < DIR8_VECTORS.length; i++) {
    const v = DIR8_VECTORS[i]!;
    const tx = unit.pos.x + v.x;
    const ty = unit.pos.y + v.y;
    if (!inBounds(state.grid, tx, ty)) continue;
    if (blocksMove(state.grid, tx, ty)) continue;
    if (state.units.some((o) => o.alive && o.pos.x === tx && o.pos.y === ty)) continue;
    const dist = chebyshev({ x: tx, y: ty }, enemy.pos);
    // Strict `>` keeps the lowest Dir8 index on a tie (iteration is ascending).
    if (dist > bestDist) {
      bestDist = dist;
      best = { x: tx, y: ty };
    }
  }
  if (!best) return false;

  const diagonal = best.x !== unit.pos.x && best.y !== unit.pos.y;
  const base = moveCost(state.grid, best.x, best.y);
  const stepCost = diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;

  const from: Vec2 = { x: unit.pos.x, y: unit.pos.y };
  unit.pos = { x: best.x, y: best.y };
  unit.facing = dir8Towards(from, best);
  unit.tu = Math.max(0, unit.tu - stepCost);
  events.push({
    type: "moveStep",
    unitId: unit.id,
    from,
    to: { x: best.x, y: best.y },
    facing: unit.facing,
    tuLeft: unit.tu,
  });
  return true;
}

/**
 * Resolve a single panic roll for `unit`. Emits the `panicked` event with the
 * rolled behavior and applies its effect: freeze drops TU to 0; flee stumbles
 * one tile away from the nearest enemy (else freezes); berserk fires one snap
 * shot at the nearest visible hostile (else freezes). Bounded + deterministic.
 */
function resolvePanic(state: BattleState, unit: Unit): GameEvent[] {
  const events: GameEvent[] = [];
  const behavior: PanicBehavior | null = rollPanic(state, unit);
  if (!behavior) return events;

  events.push({ type: "panicked", unitId: unit.id, behavior });

  if (behavior === "freeze") {
    unit.tu = 0;
    return events;
  }
  if (behavior === "flee") {
    if (!fleeOneTile(state, unit, events)) unit.tu = 0;
    return events;
  }
  // berserk: fire one snap shot at the nearest visible hostile, else freeze.
  const hostile = nearestVisibleHostile(state, unit);
  if (hostile) {
    const shotEvents = executeShoot(state, unit.id, hostile.pos, "snap");
    events.push(...shotEvents);
    if (!shotEvents.some((e) => e.type === "shot")) unit.tu = 0;
  } else {
    unit.tu = 0;
  }
  return events;
}

/** Roll panic for every living unit of `faction` still below the threshold. */
function resolvePanicPhase(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  const units = state.units
    .filter((u) => u.faction === faction && u.alive)
    .sort((a, b) => a.id - b.id);
  for (const u of units) {
    if (state.status !== "playing") break;
    if (!u.alive) continue; // a prior berserk shot may have turned the battle.
    const morale = u.morale ?? MORALE.MAX;
    if (morale >= MORALE.PANIC_THRESHOLD) continue;
    events.push(...resolvePanic(state, u));
  }
  return events;
}

/**
 * Run the full start-of-turn sequence for `faction`: detonate primed grenades,
 * recover morale, then resolve panic. Short-circuits once the battle is decided.
 * Emits nothing and advances no rng for factions whose units carry no items and
 * no morale (the default-skirmish case), so this is a no-op for legacy tests.
 */
function startFactionTurn(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  events.push(...detonatePrimedGrenades(state, faction));
  if (state.status !== "playing") return events;
  events.push(...recoverMorale(state, faction));
  events.push(...resolvePanicPhase(state, faction));
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
  events.push(...startFactionTurn(state, "enemy"));
  if (state.status !== "playing") return events;

  const exec: AiExecutor = {
    move: (id, to) => executeMove(state, id, to),
    shoot: (id, target, mode) => executeShoot(state, id, target, mode),
    reload: (id) => executeReload(state, id),
    face: (id, dir) => executeFace(state, id, dir),
    throwItem: (id, target, itemId) => {
      const u = unitById(state, id);
      return u ? performThrow(state, u, target, itemId) : [];
    },
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
  events.push(...startFactionTurn(state, "player"));

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
    case "setStance":
      // TODO(tactical-depth): implement in the sim-core wave.
      return [{ type: "blocked", reason: "stance not yet implemented" }];
    case "throwItem":
      return performThrow(state, unit, cmd.target, cmd.itemId);
    case "useItem":
      return executeUseItem(state, unit, cmd.targetId, cmd.itemId);
    case "primeItem":
      return executePrimeItem(state, unit, cmd.itemId, cmd.fuseTurns);
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
