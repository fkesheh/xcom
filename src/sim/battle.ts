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
  EnemyRank,
  Faction,
  GameEvent,
  Item,
  ItemInstance,
  PanicBehavior,
  PsiKind,
  ShotKind,
  ShotPreview,
  Unit,
  UnitId,
  UnitStance,
  Vec2,
} from "./types";
import { DIR8_VECTORS, MORALE, MOTION_SCANNER, PROX_MINE, PSI, SMOKE, STANCE, STUN, TU_COST } from "./types";
import { cellIndex, destroyCoverAt, moveCost } from "./grid";
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
    return playerWinEvent(state);
  }
  // An unconscious hostile is neutralized: it takes no turns and cannot fight, so
  // a battle where every surviving enemy is stunned out is already won (the KO'd
  // aliens become captures below). Only a conscious, living enemy keeps it going.
  const enemiesActive = state.units.some(
    (u) => u.faction === "enemy" && u.alive && !u.unconscious,
  );
  const playersAlive = state.units.some((u) => u.faction === "player" && u.alive);
  if (!enemiesActive) {
    // Clearing the hostiles wins any mission. For "recover" we also satisfy the
    // objective (legacy behaviour); a "rescue" objective is won purely by
    // clearing the aliens — civilian survival is a score concern, not a trigger,
    // so its recover/extract flags stay untouched.
    if (state.objective && state.objective.kind === "recover") {
      state.objective.recovered = true;
      state.objective.extracted = true;
    }
    state.status = "player_win";
    return playerWinEvent(state);
  }
  if (!playersAlive) {
    state.status = "enemy_win";
    return { type: "gameOver", status: "enemy_win" };
  }
  return null;
}

/**
 * The `gameOver` player-win event, attaching `captures` ONLY when at least one
 * enemy was taken unconscious — so a clean sweep with no captures emits the exact
 * legacy `{ type, status }` shape (no empty array), keeping existing callers and
 * event snapshots byte-for-byte unchanged.
 */
function playerWinEvent(state: BattleState): GameEvent {
  const captures = collectCaptures(state);
  return captures.length > 0
    ? { type: "gameOver", status: "player_win", captures }
    : { type: "gameOver", status: "player_win" };
}

/**
 * Enemy units still {@link Unit.unconscious} (alive, hp > 0) at a player victory,
 * shaped for the game-layer debrief (each becomes a MissionCapture). Rank falls
 * back to "soldier" when the unit omits one. Deterministic: ascending unit id.
 */
export function collectCaptures(
  state: BattleState,
): { templateId: string; rank: EnemyRank }[] {
  return state.units
    .filter((u) => homeFaction(u) === "enemy" && u.alive && u.unconscious === true && u.hp > 0)
    .sort((a, b) => a.id - b.id)
    .map((u) => ({ templateId: u.templateId, rank: u.rank ?? "soldier" }));
}

/**
 * A unit's HOME faction — the side it belongs to regardless of any active mind
 * control. Mind control swaps `faction` to the controller's side and stashes the
 * unit's home faction on `controlledByFaction`; capture eligibility keys off the
 * home faction so a mind-controlled PLAYER soldier stunned while enthralled is
 * never miscounted as an alien capture (and a player-controlled alien still is).
 */
function homeFaction(unit: Unit): Faction {
  return unit.controlledByFaction ?? unit.faction;
}

/**
 * Apply the damage-induced knockout rule to every unit: a living, conscious unit
 * whose accumulated STUN has reached its current hp falls {@link Unit.unconscious}
 * (mirroring the stun-rod threshold and the symmetric `stun < hp` wake rule). Only
 * units carrying stun are considered, so legacy stun-free battles are untouched.
 * Returns a `knockedOut` event per newly-downed unit in ascending id order.
 * Idempotent: already-unconscious units are skipped, so repeated calls are safe.
 */
function applyStunKnockouts(state: BattleState): GameEvent[] {
  const events: GameEvent[] = [];
  for (const u of state.units) {
    if (!u.alive || u.unconscious) continue;
    if (u.stun === undefined || u.stun <= 0) continue;
    if (u.hp > 0 && u.stun >= u.hp) {
      u.unconscious = true;
      events.push({ type: "knockedOut", unitId: u.id });
    }
  }
  return events;
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
 * Toggle a unit's body stance (stand <-> kneel) for a fixed STANCE.TOGGLE_TU.
 * Rejected with `blocked` when the unit can't afford it; otherwise spends the
 * TU, records the stance, and emits a single stanceChanged event. Stance feeds
 * the hit model (firer accuracy, defender profile) and the move cost (see
 * combat.ts and executeMove).
 */
export function executeSetStance(
  state: BattleState,
  unit: Unit,
  stance: UnitStance,
): GameEvent[] {
  void state; // kept for API symmetry with the other executors; stance is unit-local.
  const cost = STANCE.TOGGLE_TU;
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];
  unit.tu -= cost;
  unit.stance = stance;
  return [{ type: "stanceChanged", unitId: unit.id, stance, tuLeft: unit.tu }];
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
    const diagonalMult = diagonal ? TU_COST.DIAGONAL_MULT : 1;
    // Kneeling moves are costlier (the unit isn't up and walking); combine the
    // multipliers before flooring so standing (mult 1) is byte-for-byte unchanged.
    const stanceMult = unit.stance === "kneel" ? STANCE.KNEEL_MOVE_MULT : 1;
    const cost = Math.floor(base * diagonalMult * stanceMult);
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

    // Proximity mine: detonates the moment a mover steps onto or adjacent to a
    // planted mine whose faction differs from the placer's (friendlies are
    // spared). Resolved before reaction fire so the blast reads as the trigger.
    events.push(...detonateMinesForMover(state, unit));
    if (state.status !== "playing") break;
    if (!unit.alive) {
      events.push(...dropObjectiveIfCarrierDown(state, unit.id));
      const over = checkVictory(state);
      if (over) events.push(over);
      break;
    }

    events.push(...triggerReactions(state, unit));

    if (!unit.alive) {
      events.push(...moraleEventsForCasualty(state, unit.id, true));
      events.push(...dropObjectiveIfCarrierDown(state, unit.id));
      const over = checkVictory(state);
      if (over) events.push(over);
      break;
    }
    // Reaction fire may have driven the mover's stun >= hp: it falls unconscious
    // mid-move. Stop advancing an unconscious mover and resolve any victory.
    const reactionKnockouts = applyStunKnockouts(state);
    if (reactionKnockouts.length > 0) {
      events.push(...reactionKnockouts);
      const over = checkVictory(state);
      if (over) events.push(over);
      if (state.status !== "playing" || unit.unconscious) break;
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
 * Detonate any proximity mine the mover has just stepped onto or adjacent to.
 * Only mines planted by a faction DIFFERENT from the mover's trip (the placer's
 * own side is spared); the blast itself is indiscriminate, so any unit in radius
 * — including friendlies — takes damage. Each tripped mine resolves an area blast
 * at its position, chews through destructible cover like a grenade, emits a
 * `blastDetonated` plus per-casualty morale/died events, and is then removed.
 * Deterministic: mines are checked in insertion order; spent mines are removed
 * back-to-front so the in-place splice stays index-stable.
 */
function detonateMinesForMover(state: BattleState, mover: Unit): GameEvent[] {
  const events: GameEvent[] = [];
  if (!state.mines || state.mines.length === 0) return events;
  const spent: number[] = [];
  for (let i = 0; i < state.mines.length; i++) {
    const mine = state.mines[i]!;
    if (mine.placedByFaction === mover.faction) continue; // friendlies don't trip it
    if (chebyshev(mover.pos, mine.pos) > 1) continue; // must be on/adjacent
    spent.push(i);
    const { hits } = resolveBlast(state, mine.pos, mine.radius, mine.damage);
    destroyCoverInBlast(state, mine.pos, mine.radius);
    state.log.push(`${mover.name} trips a proximity mine.`);
    events.push({
      type: "blastDetonated",
      itemId: "proxMine",
      center: { x: mine.pos.x, y: mine.pos.y },
      radius: mine.radius,
      hits,
    });
    for (const hit of hits) {
      events.push(...moraleEventsForCasualty(state, hit.unitId, hit.killed));
      if (hit.killed) {
        events.push({ type: "died", unitId: hit.unitId });
        events.push(...dropObjectiveIfCarrierDown(state, hit.unitId));
      }
    }
  }
  for (let j = spent.length - 1; j >= 0; j--) {
    state.mines.splice(spent[j]!, 1);
  }
  if (spent.length > 0) {
    // Mine blasts can push a survivor's hp down to its accumulated stun.
    events.push(...applyStunKnockouts(state));
    const over = checkVictory(state);
    if (over) events.push(over);
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
  const lof = lineOfFire(state.grid, unit.pos, target, state.smokeClouds);
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
  } else if (result.targetId !== null && result.rounds.some((r) => r.damage > 0)) {
    events.push(...moraleEventsForCasualty(state, result.targetId, false));
  }

  // A shot that drove the target's hp down to or below its accumulated stun
  // knocks it out (captured on victory) instead of killing it.
  const knockouts = applyStunKnockouts(state);
  events.push(...knockouts);

  if (result.killed || knockouts.length > 0) {
    const over = checkVictory(state);
    if (over) events.push(over);
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
 * Destroy every destructible cover tile within `radius` (Chebyshev) of `center`.
 * The blast runs AFTER unit damage ({@link resolveBlast}) so the explosion is
 * resolved against the original map; each destroyed tile then becomes a
 * walkable, no-cover debris pile (see {@link destroyCoverAt}), opening both
 * movement and sight through the former obstacle — the classic X-COM "blow up
 * their cover with a grenade" tactic. Indestructible terrain (rock, hulls) and
 * plain ground are left intact. Deterministic: row-major (y, then x) iteration.
 * Returns the destroyed tile positions in iteration order.
 */
function destroyCoverInBlast(state: BattleState, center: Vec2, radius: number): Vec2[] {
  const destroyed: Vec2[] = [];
  const { grid } = state;
  const x0 = Math.max(0, center.x - radius);
  const x1 = Math.min(grid.width - 1, center.x + radius);
  const y0 = Math.max(0, center.y - radius);
  const y1 = Math.min(grid.height - 1, center.y + radius);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (destroyCoverAt(grid, x, y)) destroyed.push({ x, y });
    }
  }
  return destroyed;
}

/**
 * Throw a grenade, smoke grenade, or proximity mine at `target` and resolve its
 * effect. Performs no faction check: the same path serves the player command and
 * the enemy AI executor (mirroring how executeMove/executeShoot back the
 * AiExecutor move/shoot). TU is spent and the charge consumed. A frag grenade
 * resolves an area blast (with morale/died events for every struck unit); a smoke
 * grenade instead deploys a line-of-sight-blocking cloud at the impact tile; a
 * proximity mine plants at the impact tile and detonates only later, when a
 * non-placer-faction unit moves onto or adjacent to it (see executeMove).
 * Throwing does NOT trigger reaction fire.
 */
function performThrow(state: BattleState, unit: Unit, target: Vec2, itemId: string): GameEvent[] {
  const inst = unit.items?.find((it) => it.itemId === itemId && it.uses > 0);
  const def = state.items?.[itemId];
  if (
    !inst ||
    !def ||
    (def.kind !== "grenade" && def.kind !== "smoke" && def.kind !== "proxMine")
  ) {
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

  // A smoke grenade deploys a sight-blocking cloud instead of a damaging blast.
  if (def.kind === "smoke") {
    const radius = def.blastRadius ?? SMOKE.DEFAULT_RADIUS;
    if (!state.smokeClouds) state.smokeClouds = [];
    state.smokeClouds.push({
      pos: { x: target.x, y: target.y },
      radius,
      turnsLeft: SMOKE.DURATION_TURNS,
    });
    state.log.push(`${unit.name} deploys a ${def.name}.`);
    return events;
  }

  // A proximity mine plants at the impact tile with NO immediate blast. It arms
  // itself and waits: when any unit whose faction differs from the placer's
  // moves onto or adjacent to the mined tile, it detonates (see executeMove).
  if (def.kind === "proxMine") {
    const radius = def.blastRadius ?? PROX_MINE.DEFAULT_RADIUS;
    const damage = def.damage ?? PROX_MINE.DEFAULT_DAMAGE;
    if (!state.mines) state.mines = [];
    state.mines.push({
      pos: { x: target.x, y: target.y },
      radius,
      damage,
      placedByFaction: unit.faction,
    });
    state.log.push(`${unit.name} plants a ${def.name}.`);
    events.push({
      type: "minePlaced",
      unitId: unit.id,
      itemId,
      pos: { x: target.x, y: target.y },
      tuLeft: unit.tu,
    });
    return events;
  }

  const radius = def.blastRadius ?? 1;
  const { hits } = resolveBlast(state, target, radius, def.damage ?? 0);
  // A frag grenade chews through cover: destructible tiles in the blast become
  // walkable debris. Resolved after unit damage so the explosion sees the map
  // as it was when the grenade landed.
  const destroyed = destroyCoverInBlast(state, target, radius);
  state.log.push(
    `${unit.name} throws a ${def.name}${destroyed.length > 0 ? `, destroying ${destroyed.length} cover tile${destroyed.length > 1 ? "s" : ""}` : ""}.`,
  );
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

  // Survivors of the blast whose stun now meets their hp are knocked out.
  events.push(...applyStunKnockouts(state));

  const over = checkVictory(state);
  if (over) events.push(over);

  return events;
}

/** Use a medkit on an adjacent ally, or activate a motion scanner on the user. */
function executeUseItem(
  state: BattleState,
  unit: Unit,
  targetId: UnitId,
  itemId: string,
): GameEvent[] {
  const inst = unit.items?.find((it) => it.itemId === itemId && it.uses > 0);
  const def = state.items?.[itemId];

  // Motion scanner: a self-carried device. Activates on the user regardless of
  // target (main.ts passes the user's own id); the sweep ignores line of sight,
  // revealing every enemy within the scan radius through walls for the turn.
  if (def?.kind === "scanner") {
    if (!inst) return [{ type: "blocked", reason: "no scanner" }];
    return activateScanner(state, unit, inst, def);
  }

  // Stun rod: a reusable melee tool. Strike an in-reach hostile to build STUN.
  if (def?.kind === "stunRod") {
    return executeStunStrike(state, unit, targetId, inst, def);
  }

  // Medkit: heal an adjacent ally.
  const target = unitById(state, targetId);
  if (!target || !target.alive) return [{ type: "blocked", reason: "no target" }];
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
 * Resolve a stun-rod melee strike from `unit` onto the hostile `targetId`. The
 * rod is REUSABLE (no charge is spent): it just needs to be carried. A strike
 * costs the item's `tuPercent` of max TU, requires the target within the rod's
 * `reach` (Chebyshev, default 1), and adds `stunPower` to the target's STUN pool
 * (never hp — stun cannot kill). When accumulated stun reaches the target's
 * current hp the target falls {@link Unit.unconscious}; if that KO's the last
 * active hostile the battle is won (unconscious enemies count as neutralized).
 */
function executeStunStrike(
  state: BattleState,
  unit: Unit,
  targetId: UnitId,
  inst: ItemInstance | undefined,
  def: Item,
): GameEvent[] {
  const target = unitById(state, targetId);
  if (!target || !target.alive) return [{ type: "blocked", reason: "no target" }];
  if (!inst) return [{ type: "blocked", reason: "no stun rod" }];
  if (target.faction === unit.faction) return [{ type: "blocked", reason: "not a hostile" }];
  const reach = def.reach ?? 1;
  if (chebyshev(unit.pos, target.pos) > reach) return [{ type: "blocked", reason: "too far" }];
  const cost = Math.ceil((unit.stats.timeUnits * def.tuPercent) / 100);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];

  unit.tu -= cost;
  const power = def.stunPower ?? 0;
  target.stun = (target.stun ?? 0) + power;
  const knockedOut = !target.unconscious && target.stun >= target.hp;
  if (knockedOut) target.unconscious = true;

  state.log.push(
    `${unit.name} strikes ${target.name} with a ${def.name}` +
      (knockedOut ? `, knocking it out.` : `.`),
  );

  const events: GameEvent[] = [
    {
      type: "stunStrike",
      unitId: unit.id,
      targetId: target.id,
      itemId: def.id,
      stun: power,
      targetStun: target.stun,
      knockedOut,
      tuLeft: unit.tu,
    },
  ];

  if (knockedOut) {
    const over = checkVictory(state);
    if (over) events.push(over);
  }
  return events;
}

/**
 * Activate a motion scanner on `unit`. Spends TU and a charge, then stamps the
 * item's scan radius onto `unit.scanRadius` — los.visibleEnemyIds treats every
 * enemy within that radius as seen through walls. The reveal lapses at turn
 * handover (see {@link startFactionTurn}).
 */
function activateScanner(
  state: BattleState,
  unit: Unit,
  inst: ItemInstance,
  def: Item,
): GameEvent[] {
  const cost = Math.ceil((unit.stats.timeUnits * def.tuPercent) / 100);
  if (unit.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];
  unit.tu -= cost;
  consumeItem(unit, inst);
  const radius = def.scanRadius ?? MOTION_SCANNER.DEFAULT_RADIUS;
  unit.scanRadius = radius;
  state.log.push(`${unit.name} activates a ${def.name}, sweeping for nearby movement.`);
  return [{ type: "scanActivated", unitId: unit.id, itemId: def.id, radius, tuLeft: unit.tu }];
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
// Psionics
// ---------------------------------------------------------------------------

/**
 * Execute a psionic attack. The caster rolls a single success chance derived
 * from its psiSkill against the target's psiStrength, reduced by distance; the
 * action costs PSI.TU_PERCENT of max TU whether or not it lands.
 *
 *  - 'panic': on a hit, dumps the target's morale to 0 — feeding it into the
 *    existing morale/panic system so the target rolls for panic at the start of
 *    its next turn (bravery can still resist that roll).
 *  - 'mindControl': HARD-CAPPED at PSI.MC_MAX_PER_BATTLE per battle (kept global
 *    by design — the cap is no longer wasted on a seize that yields no turn of
 *    control, since a seize now persists through the controller's actual next
 *    turn). On a hit, the target switches sides for PSI.MC_DURATION_TURNS: its
 *    `faction` becomes the caster's faction (so combat / AI / victory logic
 *    treats it as the controller's), its home faction is stashed on
 *    `controlledByFaction` for revert, and `mcTurnsLeft` is set. A
 *    mind-controlled unit cannot cast psi.
 *
 * Purity: no DOM / three.js. The only rng draw is the single success roll.
 */
export function executePsiAttack(
  state: BattleState,
  attacker: Unit,
  targetId: UnitId,
  kind: PsiKind,
): GameEvent[] {
  if (!attacker.alive) return [{ type: "blocked", reason: "no such unit" }];
  // A controlled unit cannot project psi; psiSkill 0/unset means untrained.
  if (attacker.controlledByFaction !== undefined) {
    return [{ type: "blocked", reason: "mind-controlled" }];
  }
  const psiSkill = attacker.stats.psiSkill ?? 0;
  if (psiSkill <= 0) return [{ type: "blocked", reason: "no psi ability" }];

  const target = unitById(state, targetId);
  if (!target || !target.alive) return [{ type: "blocked", reason: "no target" }];
  if (target.faction === attacker.faction) {
    return [{ type: "blocked", reason: "friendly target" }];
  }
  if (kind === "mindControl" && (state.mcUsedThisBattle ?? 0) >= PSI.MC_MAX_PER_BATTLE) {
    return [{ type: "blocked", reason: "mind control spent" }];
  }

  const dist = chebyshev(attacker.pos, target.pos);
  if (dist > PSI.RANGE) return [{ type: "blocked", reason: "out of psi range" }];

  const cost = Math.ceil((attacker.stats.timeUnits * PSI.TU_PERCENT) / 100);
  if (attacker.tu < cost) return [{ type: "blocked", reason: "not enough TU" }];

  attacker.tu -= cost;

  // Base odds from skill vs resistance, clamped to [MIN, MAX], then shrunk by
  // distance (falloff per tile, floored so psi never fully zeros out to range).
  const psiStrength = target.stats.psiStrength ?? 0;
  const base = (psiSkill - psiStrength * 0.5) / 100;
  const baseClamped = Math.min(PSI.MAX_CHANCE, Math.max(PSI.MIN_CHANCE, base));
  const rangeFactor = Math.max(PSI.FALLOFF_FLOOR, 1 - dist * PSI.FALLOFF_PER_TILE);
  const chance = baseClamped * rangeFactor;
  const success = state.rng.chance(chance);

  const events: GameEvent[] = [
    { type: "psiUsed", attackerId: attacker.id, targetId, kind, success, tuLeft: attacker.tu },
  ];

  if (!success) {
    state.log.push(`${attacker.name}'s psi attack on ${target.name} was resisted.`);
    return events;
  }

  if (kind === "panic") {
    // Dump morale to 0; the start-of-turn panic phase rolls from here.
    const before = target.morale ?? MORALE.MAX;
    target.morale = 0;
    if (target.morale !== before) {
      events.push({ type: "moraleChanged", unitId: target.id, morale: 0 });
    }
    state.log.push(`${attacker.name} panics ${target.name}.`);
    return events;
  }

  // mindControl: seize the target for the caster's faction. `controlledByFaction`
  // stashes the home faction; `faction` is swapped so the unit genuinely fights
  // for the wrong side. Control reverts at the round boundary once the controller
  // has had a turn to act with the unit — see tickMindControl/endPlayerTurn,
  // which spare a just-applied seize from the coincident round-boundary tick so
  // the controller (including the enemy, which casts mid-turn) keeps the unit
  // through its actual next turn.
  target.controlledByFaction = target.faction;
  target.faction = attacker.faction;
  target.mcTurnsLeft = PSI.MC_DURATION_TURNS;
  state.mcUsedThisBattle = (state.mcUsedThisBattle ?? 0) + 1;
  state.log.push(`${attacker.name} seizes control of ${target.name}.`);
  events.push({
    type: "mindControlled",
    unitId: target.id,
    faction: attacker.faction,
    turnsLeft: PSI.MC_DURATION_TURNS,
  });

  // A side wipe via MC (e.g. seizing the last living soldier) can end the battle.
  const over = checkVictory(state);
  if (over) events.push(over);
  return events;
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
      // A primed grenade detonating on its carrier chews through nearby cover
      // just like a thrown one (resolved after unit damage, same rule).
      destroyCoverInBlast(state, carrier.pos, radius);
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

  // Primed-grenade blasts can knock out survivors whose stun now meets their hp.
  events.push(...applyStunKnockouts(state));
  const over = checkVictory(state);
  if (over) events.push(over);
  return events;
}

/** Recover morale for every living unit of `faction` (opt-in via `morale`). */
function recoverMorale(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  for (const u of state.units) {
    if (u.faction !== faction || !u.alive || u.unconscious || u.morale === undefined) continue;
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
    if (!o.alive || o.unconscious || o.faction === unit.faction) continue;
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
    if (!o.alive || o.unconscious || o.faction === unit.faction) continue;
    if (!canSee(state.grid, unit, o.pos, state.smokeClouds)) continue;
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
  // Mirror executeMove's cost math: a kneeling mover pays the kneel multiplier,
  // combined with the diagonal multiplier before flooring so standing (mult 1)
  // is byte-for-byte unchanged.
  const stanceMult = unit.stance === "kneel" ? STANCE.KNEEL_MOVE_MULT : 1;
  const stepCost = Math.floor(base * (diagonal ? TU_COST.DIAGONAL_MULT : 1) * stanceMult);

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

  // A panicking mover still trips proximity mines and provokes reaction fire on
  // the tile it flees into — the same post-step handling every normal move step
  // routes through in executeMove.
  events.push(...detonateMinesForMover(state, unit));
  if (state.status === "playing" && unit.alive) {
    events.push(...triggerReactions(state, unit));
  }
  if (!unit.alive) {
    events.push(...dropObjectiveIfCarrierDown(state, unit.id));
    const over = checkVictory(state);
    if (over) events.push(over);
  } else {
    // Mine/reaction fire during the panic flee can knock the mover out.
    const knockouts = applyStunKnockouts(state);
    if (knockouts.length > 0) {
      events.push(...knockouts);
      const over = checkVictory(state);
      if (over) events.push(over);
    }
  }
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
    .filter((u) => u.faction === faction && u.alive && !u.unconscious)
    .sort((a, b) => a.id - b.id);
  for (const u of units) {
    if (state.status !== "playing") break;
    if (!u.alive || u.unconscious) continue; // a prior berserk shot may have turned the battle.
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
 *
 * Also lapses every motion-scanner reveal: a scanner's through-wall ping lasts
 * only for the rest of the activating unit's turn, so scanRadius is cleared for
 * ALL units here (the previous turn's reveals expire as the new turn begins).
 */
function startFactionTurn(state: BattleState, faction: Faction): GameEvent[] {
  for (const u of state.units) u.scanRadius = undefined;
  const events: GameEvent[] = [];
  events.push(...detonatePrimedGrenades(state, faction));
  if (state.status !== "playing") return events;
  events.push(...decayStunAndWake(state, faction));
  events.push(...recoverMorale(state, faction));
  events.push(...resolvePanicPhase(state, faction));
  return events;
}

/**
 * Shed STUN at the start of `faction`'s turn: every living unit of `faction`
 * loses {@link STUN.DECAY_PER_TURN} stun (floored at 0). An {@link Unit.unconscious}
 * unit whose stun drops back below its current hp WAKES — the marker clears and it
 * spends its waking turn with 0 TU (so it cannot act the round it comes to). A
 * no-op (no events, no rng) for units at 0 stun, so legacy stun-free battles are
 * byte-for-byte unchanged. Deterministic: iterates units in spawn order.
 */
function decayStunAndWake(state: BattleState, faction: Faction): GameEvent[] {
  const events: GameEvent[] = [];
  for (const u of state.units) {
    if (u.faction !== faction || !u.alive) continue;
    if (u.stun === undefined || u.stun <= 0) continue;
    u.stun = Math.max(0, u.stun - STUN.DECAY_PER_TURN);
    if (u.unconscious && u.stun < u.hp) {
      u.unconscious = false;
      u.tu = 0;
      events.push({ type: "woke", unitId: u.id });
    }
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
export function tickSmokeClouds(state: BattleState): void {
  if (!state.smokeClouds || state.smokeClouds.length === 0) return;
  // Decrement every cloud by one round and drop the ones that have fully
  // dissipated. Iterating back-to-front keeps the in-place splice deterministic.
  for (let i = state.smokeClouds.length - 1; i >= 0; i--) {
    const cloud = state.smokeClouds[i]!;
    cloud.turnsLeft -= 1;
    if (cloud.turnsLeft <= 0) state.smokeClouds.splice(i, 1);
  }
  if (state.smokeClouds.length === 0) state.smokeClouds = undefined;
}

/**
 * Age every mind-controlled unit one round closer to reverting — EXCEPT any unit
 * in `exceptIds`. For each unit whose `mcTurnsLeft` hits 0, restore its home
 * faction (stashed on `controlledByFaction`), clear the MC state, and emit a
 * `controlEnded` event so the UI can drop its "mind-controlled" toast and signal
 * restoration. Iterates units in ascending id order for determinism; a no-op when
 * nobody is controlled (or every controlled unit is excepted).
 *
 * `exceptIds` decouples MC aging from the round boundary. An enemy-applied seize
 * happens mid-enemy-turn, in the SAME endPlayerTurn call as this tick; without
 * exclusion it would lapse instantly, burning the per-battle cap for zero turns
 * of control. The caller passes the ids seized *this* enemy turn as `exceptIds`,
 * so a freshly-applied seize survives into the next enemy turn and only reverts
 * once its controller has actually been able to act with the unit. Player-applied
 * seizes are never mid-enemy-turn, so they are never excepted and revert at the
 * round boundary exactly as before.
 */
export function tickMindControl(
  state: BattleState,
  exceptIds: ReadonlySet<UnitId> = new Set(),
): GameEvent[] {
  const events: GameEvent[] = [];
  const controlled = state.units
    .filter(
      (u) =>
        u.controlledByFaction !== undefined &&
        u.mcTurnsLeft !== undefined &&
        !exceptIds.has(u.id),
    )
    .sort((a, b) => a.id - b.id);
  for (const u of controlled) {
    u.mcTurnsLeft = Math.max(0, (u.mcTurnsLeft ?? 0) - 1);
    if ((u.mcTurnsLeft ?? 0) <= 0) {
      const home = u.controlledByFaction ?? u.faction;
      u.faction = home;
      u.controlledByFaction = undefined;
      u.mcTurnsLeft = undefined;
      events.push({ type: "controlEnded", unitId: u.id, faction: home });
    }
  }
  return events;
}

function endPlayerTurn(state: BattleState): GameEvent[] {
  const events: GameEvent[] = [{ type: "turnEnded", faction: "player" }];

  state.activeFaction = "enemy";
  refillTU(state, "enemy");
  events.push({ type: "turnStarted", faction: "enemy", turn: state.turn });
  events.push(...startFactionTurn(state, "enemy"));
  if (state.status !== "playing") return events;

  // Snapshot the units already under mind control BEFORE the enemy acts. An
  // enemy-applied seize lands mid-enemy-turn (after this snapshot), so excluding
  // these ids from the comparison below marks the just-seized unit as "new" and
  // spares it the round-boundary tick — without this, an enemy MC would lapse in
  // the very endPlayerTurn that applied it, yielding zero turns of control while
  // still burning the one-per-battle cap.
  const controlledBeforeEnemyTurn = new Set(
    state.units.filter((u) => u.controlledByFaction !== undefined).map((u) => u.id),
  );

  const exec: AiExecutor = {
    move: (id, to) => executeMove(state, id, to),
    shoot: (id, target, mode) => executeShoot(state, id, target, mode),
    reload: (id) => executeReload(state, id),
    face: (id, dir) => executeFace(state, id, dir),
    throwItem: (id, target, itemId) => {
      const u = unitById(state, id);
      return u ? performThrow(state, u, target, itemId) : [];
    },
    psiAttack: (id, targetId, kind) => {
      const u = unitById(state, id);
      return u ? executePsiAttack(state, u, targetId, kind) : [];
    },
  };
  events.push(...runEnemyTurn(state, exec));

  // The AI ended the game (e.g. wiped out the squad): stop here. The gameOver
  // event was already emitted by the executor that landed the killing blow.
  if (state.status !== "playing") return events;

  events.push({ type: "turnEnded", faction: "enemy" });
  state.turn++;
  // A new round begins: age every active smoke cloud one round and clear any that
  // have fully dissipated.
  tickSmokeClouds(state);
  // Lapse mind control, but spare anything the enemy JUST seized this turn — it
  // hasn't given the controller a turn yet (the AI snapshotted its actors before
  // the psi cast, so a just-seized unit is only usable next enemy turn). Newly
  // seized ids are the controlled set minus the pre-enemy-turn snapshot above.
  const newlySeized = new Set(
    state.units
      .filter((u) => u.controlledByFaction !== undefined)
      .map((u) => u.id)
      .filter((id) => !controlledBeforeEnemyTurn.has(id)),
  );
  events.push(...tickMindControl(state, newlySeized));
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
      return executeSetStance(state, unit, cmd.stance);
    case "throwItem":
      return performThrow(state, unit, cmd.target, cmd.itemId);
    case "useItem":
      return executeUseItem(state, unit, cmd.targetId, cmd.itemId);
    case "primeItem":
      return executePrimeItem(state, unit, cmd.itemId, cmd.fuseTurns);
    case "psiAttack":
      return executePsiAttack(state, unit, cmd.targetId, cmd.kind);
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
