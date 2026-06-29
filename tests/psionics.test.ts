import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { applyCommand, executePsiAttack, tickMindControl, unitById } from "../src/sim/battle";
import { TEMPLATES, WEAPONS } from "../src/sim/content";
import { MORALE, PSI } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
  GameEvent,
  PsiKind,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// Test factories. Mirrors tests/tactical-items.test.ts, populating morale so
// the panic system is opted-in, and exposing psiSkill / psiStrength for psionic
// combat. An open 30x30 grid keeps line-of-sight trivial so psi always lands.
// ---------------------------------------------------------------------------

const DEFAULT_STATS = {
  timeUnits: 60,
  health: 40,
  reactions: 40,
  firingAccuracy: 60,
  strength: 30,
  bravery: 50,
} as const;

function makeUnit(
  id: UnitId,
  faction: Faction,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  return {
    id,
    name: `u${id}`,
    templateId: faction === "enemy" ? "commander" : "trooper",
    faction,
    pos,
    facing,
    stats: { ...DEFAULT_STATS },
    tu: 60,
    hp: 40,
    morale: MORALE.MAX,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

/** A psionic alien commander (psiSkill 60 / psiStrength 70, matching content.ts). */
function makeCommander(
  id: UnitId,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  return makeUnit(id, "enemy", pos, facing, {
    stats: { ...DEFAULT_STATS, timeUnits: 58, health: 50, reactions: 75, psiSkill: 60, psiStrength: 70 },
    weaponId: "plasma",
    ammo: 8,
    ...overrides,
  });
}

function makeState(units: Unit[], seed = 1234): BattleState {
  return {
    grid: makeGrid(30, 30),
    units,
    weapons: WEAPONS,
    turn: 1,
    activeFaction: "player",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

/** The narrowed psiUsed event type, for clean field access in assertions. */
type PsiUsedEvent = Extract<GameEvent, { type: "psiUsed" }>;

/** The psiUsed event for a cast, or undefined when none was emitted. */
function psiUsedEvent(events: GameEvent[]): PsiUsedEvent | undefined {
  return events.find((e): e is PsiUsedEvent => e.type === "psiUsed");
}

/**
 * Psi success is probabilistic, so tests that need a LANDED cast search for a
 * seed where the roll succeeds. The roll is fully deterministic per seed, so the
 * found seed makes the assertion reproducible.
 */
function castUntilSuccess(
  factory: (seed: number) => { state: BattleState; attackerId: UnitId; targetId: UnitId },
  kind: PsiKind,
  fromSeed = 1,
  maxSeeds = 5000,
): { state: BattleState; events: GameEvent[] } {
  for (let seed = fromSeed; seed < fromSeed + maxSeeds; seed++) {
    const { state, attackerId, targetId } = factory(seed);
    const attacker = unitById(state, attackerId)!;
    const events = executePsiAttack(state, attacker, targetId, kind);
    const used = psiUsedEvent(events);
    if (used?.success) return { state, events };
  }
  throw new Error(`no seed produced a successful ${kind} cast within ${maxSeeds} tries`);
}

// ---------------------------------------------------------------------------
// Determinism + cost
// ---------------------------------------------------------------------------

describe("psi attack: determinism + TU cost", () => {
  it("the success roll is deterministic for a fixed seed (same seed => same outcome)", () => {
    const factory = (seed: number) => {
      const commander = makeCommander(1, { x: 5, y: 5 }, 2);
      const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
        stats: { ...DEFAULT_STATS, psiStrength: 10 },
      });
      return makeState([commander, target], seed);
    };

    const s1 = factory(42);
    const s2 = factory(42);
    const before1 = s1.rng.state;
    const a1 = unitById(s1, 1)!;
    const a2 = unitById(s2, 1)!;
    const t1 = unitById(s1, 2)!;
    const t2 = unitById(s2, 2)!;

    const ev1 = executePsiAttack(s1, a1, 2, "panic");
    const ev2 = executePsiAttack(s2, a2, 2, "panic");

    const u1 = psiUsedEvent(ev1)!;
    const u2 = psiUsedEvent(ev2)!;
    expect(u1.success).toBe(u2.success);
    expect(t1.morale).toBe(t2.morale);
    // A roll was consumed (rng advanced past its initial state).
    expect(s1.rng.state).not.toBe(before1);
    // Identical seed reproduces the exact rng stream end-state.
    expect(s1.rng.state).toBe(s2.rng.state);
    void t1;
    void t2;
  });

  it("costs ~50% of max TU and emits psiUsed whether or not it lands", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 8, y: 5 }, 6);
    const state = makeState([commander, target], 7);

    const tuBefore = commander.tu;
    const events = executePsiAttack(state, commander, 2, "panic");
    const used = psiUsedEvent(events)!;

    expect(used.attackerId).toBe(1);
    expect(used.targetId).toBe(2);
    expect(used.kind).toBe("panic");
    // ceil(58 * 50 / 100) = 29 TU spent.
    const cost = Math.ceil((commander.stats.timeUnits * PSI.TU_PERCENT) / 100);
    expect(commander.tu).toBe(tuBefore - cost);
    expect(used.tuLeft).toBe(commander.tu);
    // psiUsed is emitted for both success and resist (a moraleChanged only on hit).
    expect(typeof used.success).toBe("boolean");
  });
});

// ---------------------------------------------------------------------------
// Panic
// ---------------------------------------------------------------------------

describe("psi attack: panic", () => {
  it("on a successful hit, dumps the target's morale to 0 and emits moraleChanged", () => {
    const factory = (seed: number) => {
      const commander = makeCommander(1, { x: 5, y: 5 }, 2);
      const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
        stats: { ...DEFAULT_STATS, psiStrength: 0 },
      });
      return { state: makeState([commander, target], seed), attackerId: 1 as UnitId, targetId: 2 as UnitId };
    };

    const { state, events } = castUntilSuccess(factory, "panic");
    const target = unitById(state, 2)!;

    expect(target.morale).toBe(0);
    const morale = events.find(
      (e): e is Extract<GameEvent, { type: "moraleChanged" }> =>
        e.type === "moraleChanged" && e.unitId === 2,
    );
    expect(morale).toBeDefined();
    expect(morale!.morale).toBe(0);
  });

  it("a resisted panic leaves the target's morale untouched", () => {
    const factory = (seed: number) => {
      const commander = makeCommander(1, { x: 5, y: 5 }, 2);
      const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
        stats: { ...DEFAULT_STATS, psiStrength: 95 },
      });
      return { state: makeState([commander, target], seed), attackerId: 1 as UnitId, targetId: 2 as UnitId };
    };

    // Search for a seed where the psi RESISTS (success=false).
    let state!: BattleState;
    let events!: GameEvent[];
    for (let seed = 1; seed < 5000; seed++) {
      const { state: s, attackerId, targetId } = factory(seed);
      const attacker = unitById(s, attackerId)!;
      const ev = executePsiAttack(s, attacker, targetId, "panic");
      if (psiUsedEvent(ev)?.success === false) {
        state = s;
        events = ev;
        break;
      }
    }
    expect(state).toBeDefined();
    const target = unitById(state, 2)!;
    expect(target.morale).toBe(MORALE.MAX);
    expect(events.some((e) => e.type === "moraleChanged")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mind control: faction switch, hard cap, revert, psi lockout
// ---------------------------------------------------------------------------

describe("psi attack: mind control", () => {
  it("on a successful hit, switches the target to the caster's faction for 1 turn", () => {
    const factory = (seed: number) => {
      const commander = makeCommander(1, { x: 5, y: 5 }, 2);
      const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
        stats: { ...DEFAULT_STATS, psiStrength: 0 },
      });
      return { state: makeState([commander, target], seed), attackerId: 1 as UnitId, targetId: 2 as UnitId };
    };

    const { state, events } = castUntilSuccess(factory, "mindControl");
    const target = unitById(state, 2)!;

    // The target now fights for the enemy (the caster's faction).
    expect(target.faction).toBe("enemy");
    expect(target.controlledByFaction).toBe("player"); // home faction stashed for revert
    expect(target.mcTurnsLeft).toBe(PSI.MC_DURATION_TURNS);
    expect(state.mcUsedThisBattle).toBe(1);

    const mc = events.find(
      (e): e is Extract<GameEvent, { type: "mindControlled" }> => e.type === "mindControlled",
    );
    expect(mc).toBeDefined();
    expect(mc!.unitId).toBe(2);
    expect(mc!.faction).toBe("enemy");
    expect(mc!.turnsLeft).toBe(PSI.MC_DURATION_TURNS);
  });

  it("HARD CAP: at most one mind control per battle", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2);
    const targetA = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    const targetB = makeUnit(3, "player", { x: 8, y: 6 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    const state = makeState([commander, targetA, targetB], 99);

    // One MC has already landed this battle.
    state.mcUsedThisBattle = PSI.MC_MAX_PER_BATTLE;

    const blocked = executePsiAttack(state, commander, 3, "mindControl");
    expect(blocked).toEqual([{ type: "blocked", reason: "mind control spent" }]);
    expect(state.mcUsedThisBattle).toBe(PSI.MC_MAX_PER_BATTLE); // unchanged
    expect(targetB.faction).toBe("player"); // target untouched
    expect(targetB.controlledByFaction).toBeUndefined();

    // The cap only gates mind control; panic still works.
    const panicEvents = executePsiAttack(state, commander, 3, "panic");
    expect(panicEvents.some((e) => e.type === "psiUsed")).toBe(true);
  });

  it("reverts to the home faction after 1 turn (round-end tick)", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    const state = makeState([commander, target], 5);

    // Seize the target, then fast-forward to the post-cast state.
    const { state: seized } = castUntilSuccess(
      (seed) => {
        const c = makeCommander(1, { x: 5, y: 5 }, 2);
        const t = makeUnit(2, "player", { x: 8, y: 5 }, 6, { stats: { ...DEFAULT_STATS, psiStrength: 0 } });
        return { state: makeState([c, t], seed), attackerId: 1 as UnitId, targetId: 2 as UnitId };
      },
      "mindControl",
    );
    // Carry the seized MC state onto `state`'s target so the rest uses one rng.
    state.units[1]!.faction = seized.units[1]!.faction;
    state.units[1]!.controlledByFaction = "player";
    state.units[1]!.mcTurnsLeft = PSI.MC_DURATION_TURNS;
    state.mcUsedThisBattle = 1;
    const target2 = unitById(state, 2)!;
    expect(target2.faction).toBe("enemy");

    // One round passes: the MC lapses and the unit reverts to its home faction.
    tickMindControl(state);
    const reverted = unitById(state, 2)!;
    expect(reverted.faction).toBe("player");
    expect(reverted.controlledByFaction).toBeUndefined();
    expect(reverted.mcTurnsLeft).toBeUndefined();
    // The hard-cap counter is NOT decremented: MC is spent for the whole battle.
    expect(state.mcUsedThisBattle).toBe(1);
  });

  it("a mind-controlled unit cannot cast psi", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiSkill: 60, psiStrength: 10 },
    });
    const state = makeState([commander, target], 3);

    // The target is seized (psiSkill is irrelevant to the lockout — it's MC'd).
    target.controlledByFaction = "player";
    target.faction = "enemy";
    target.mcTurnsLeft = PSI.MC_DURATION_TURNS;

    const blocked = executePsiAttack(state, target, 1, "panic");
    expect(blocked).toEqual([{ type: "blocked", reason: "mind-controlled" }]);
    // No rng consumed on a blocked psi cast.
    expect(state.rng.state).toBe(new Rng(3).state);
  });

  it("is blocked for an untrained caster, a friendly target, and out of range", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2);
    const ally = makeUnit(2, "enemy", { x: 8, y: 5 }, 6);
    const farTarget = makeUnit(3, "player", { x: 29, y: 29 }, 6);
    const state = makeState([commander, ally, farTarget], 1);

    // Friendly target.
    expect(executePsiAttack(state, commander, 2, "panic")).toEqual([
      { type: "blocked", reason: "friendly target" },
    ]);
    // Out of psi range (Chebyshev 24 > PSI.RANGE 20).
    expect(executePsiAttack(state, commander, 3, "panic")).toEqual([
      { type: "blocked", reason: "out of psi range" },
    ]);

    // Untrained caster (psiSkill 0 / unset) cannot use psi.
    const rookie = makeUnit(4, "enemy", { x: 5, y: 6 }, 2);
    state.units.push(rookie);
    expect(executePsiAttack(state, rookie, 3, "panic")).toEqual([
      { type: "blocked", reason: "no psi ability" },
    ]);
  });

  it("is blocked without enough TU", () => {
    const commander = makeCommander(1, { x: 5, y: 5 }, 2, { tu: 5 });
    const target = makeUnit(2, "player", { x: 8, y: 5 }, 6);
    const state = makeState([commander, target], 1);
    expect(executePsiAttack(state, commander, 2, "panic")).toEqual([
      { type: "blocked", reason: "not enough TU" },
    ]);
    expect(commander.tu).toBe(5); // nothing spent on a blocked cast
  });
});

// ---------------------------------------------------------------------------
// Lifecycle via the reducer + AI integration
// ---------------------------------------------------------------------------

describe("psionics: reducer + AI integration", () => {
  it("the player psiAttack command is honored for a trained unit and blocks for an untrained one", () => {
    const trained = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: { ...DEFAULT_STATS, psiSkill: 60, psiStrength: 40 },
    });
    const foe = makeUnit(2, "enemy", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 10 },
    });
    const state = makeState([trained, foe], 3);

    const events = applyCommand(state, { type: "psiAttack", unitId: 1, targetId: 2, kind: "panic" });
    expect(events.some((e) => e.type === "psiUsed")).toBe(true);

    // An untrained player unit (psiSkill unset) cannot cast.
    const rookie = makeUnit(3, "player", { x: 5, y: 6 }, 2);
    state.units.push(rookie);
    const blocked = applyCommand(state, { type: "psiAttack", unitId: 3, targetId: 2, kind: "panic" });
    expect(blocked).toEqual([{ type: "blocked", reason: "no psi ability" }]);
  });

  it("the enemy commander opens its turn with a psi attack when it sees a soldier", () => {
    // Commander has line of sight to one soldier; it leads with psi (mind control
    // while the cap allows). The player ends turn -> the enemy turn fires psiUsed.
    const commander = makeCommander(10, { x: 5, y: 5 }, 2); // facing East
    const soldier = makeUnit(1, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    const state = makeState([commander, soldier], 13);

    const events = applyCommand(state, { type: "endTurn" });
    const psi = events.find(
      (e): e is Extract<GameEvent, { type: "psiUsed" }> => e.type === "psiUsed",
    );
    expect(psi).toBeDefined();
    expect(psi!.attackerId).toBe(10);
    expect(psi!.kind).toBe("mindControl"); // MC preferred while the cap is open
    // TU was actually spent by the caster.
    expect(commander.tu).toBeLessThan(commander.stats.timeUnits);
  });

  it("a mind control applied during the enemy turn reverts when the round ends", () => {
    // Force an MC outcome, then let the full endTurn run to the round boundary
    // where tickMindControl lapses control back to the player.
    const commander = makeCommander(10, { x: 5, y: 5 }, 2);
    const soldier = makeUnit(1, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    // A second player unit keeps the battle alive (so endTurn doesn't end the game
    // if the soldier is seized) and gives the commander a non-MC psi target.
    const helper = makeUnit(2, "player", { x: 12, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });

    // Find a seed where the commander's opening cast is a mind control that lands.
    let seed = 0;
    let seized = false;
    for (let s = 1; s < 5000; s++) {
      const c = makeCommander(10, { x: 5, y: 5 }, 2);
      const sol = makeUnit(1, "player", { x: 8, y: 5 }, 6, { stats: { ...DEFAULT_STATS, psiStrength: 0 } });
      const st = makeState([c, sol], s);
      const ev = executePsiAttack(st, c, 1, "mindControl");
      const used = psiUsedEvent(ev);
      if (used?.success && sol.faction === "enemy") {
        seed = s;
        seized = true;
        break;
      }
    }
    expect(seized).toBe(true);

    const commander2 = makeCommander(10, { x: 5, y: 5 }, 2);
    const soldier2 = makeUnit(1, "player", { x: 8, y: 5 }, 6, {
      stats: { ...DEFAULT_STATS, psiStrength: 0 },
    });
    const state = makeState([commander2, soldier2, helper], seed);

    applyCommand(state, { type: "endTurn" });

    // After the round boundary, the seized soldier is back on the player's side.
    const soldierAfter = unitById(state, 1)!;
    expect(soldierAfter.faction).toBe("player");
    expect(soldierAfter.controlledByFaction).toBeUndefined();
    expect(soldierAfter.mcTurnsLeft).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Content: the commander template is the sole psionic
// ---------------------------------------------------------------------------

describe("content: commander psionic stats", () => {
  it("the commander template is the roster's sole psionic caster", () => {
    expect(TEMPLATES.commander!.stats.psiSkill).toBe(60);
    expect(TEMPLATES.commander!.stats.psiStrength).toBe(70);
    // Player units ship without psi (a future psi-lab unlock).
    expect(TEMPLATES.trooper!.stats.psiSkill).toBeUndefined();
  });
});
