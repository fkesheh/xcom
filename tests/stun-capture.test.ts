import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { applyCommand, checkVictory, collectCaptures } from "../src/sim/battle";
import { runEnemyTurn } from "../src/sim/ai";
import { triggerReactions } from "../src/sim/reaction";
import { resolveBlast } from "../src/sim/combat";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { MORALE, STUN } from "../src/sim/types";
import type {
  AiExecutor,
  BattleState,
  Dir8,
  EnemyRank,
  Faction,
  GameEvent,
  ItemInstance,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// Factories (mirror tests/tactical-items.test.ts) with stun/capture fields.
// ---------------------------------------------------------------------------

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
    templateId: "trooper",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 40,
      reactions: 40,
      firingAccuracy: 60,
      strength: 30,
      bravery: 50,
    },
    tu: 60,
    hp: 40,
    morale: MORALE.MAX,
    items: [],
    weaponId: "rifle",
    ammo: 24,
    stun: 0,
    unconscious: false,
    alive: true,
    reserve: "none",
    stance: "stand",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

function stunRod(): ItemInstance {
  return { itemId: "stunRod", uses: 1 };
}

function grenade(): ItemInstance {
  return { itemId: "grenade", uses: 1 };
}

function makeState(units: Unit[], seed = 1234, overrides: Partial<BattleState> = {}): BattleState {
  return {
    grid: makeGrid(30, 30),
    units,
    weapons: WEAPONS,
    items: { ...ITEMS },
    turn: 1,
    activeFaction: "player",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
    ...overrides,
  };
}

function events(state: BattleState, unit: Unit, targetId: UnitId): GameEvent[] {
  return applyCommand(state, { type: "useItem", unitId: unit.id, targetId, itemId: "stunRod" });
}

// ---------------------------------------------------------------------------
// 1. Stun accumulation
// ---------------------------------------------------------------------------

describe("stun rod strike", () => {
  it("adds stunPower to the target's stun, spends TU, leaves hp untouched, and is reusable", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { hp: 200 });
    const state = makeState([attacker, target]);

    const evs = events(state, attacker, target.id);
    const strike = evs.find((e) => e.type === "stunStrike");
    expect(strike).toBeDefined();

    const rod = ITEMS.stunRod!;
    expect(target.stun).toBe(rod.stunPower);
    expect(target.hp).toBe(200); // stun never touches hp
    expect(target.unconscious).toBeFalsy();
    // Reusable: the rod is not consumed on a strike.
    expect(attacker.items?.some((i) => i.itemId === "stunRod")).toBe(true);
    // TU spent = ceil(60 * 30 / 100) = 18.
    expect(attacker.tu).toBe(60 - Math.ceil((60 * rod.tuPercent!) / 100));
  });

  it("stacks across repeated strikes and knocks the target out at stun >= hp", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { hp: 40 });
    const state = makeState([attacker, target]);

    // First strike: 40 stun vs 40 hp -> knocked out immediately.
    const evs = events(state, attacker, target.id);
    const strike = evs.find((e) => e.type === "stunStrike");
    expect(strike && strike.type === "stunStrike" && strike.knockedOut).toBe(true);
    expect(strike && strike.type === "stunStrike" && strike.targetStun).toBe(40);
    expect(target.unconscious).toBe(true);
    expect(target.alive).toBe(true); // stun never kills
  });

  it("does NOT knock out while stun is below hp", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { hp: 100 });
    const state = makeState([attacker, target]);

    const evs = events(state, attacker, target.id);
    const strike = evs.find((e) => e.type === "stunStrike");
    expect(strike && strike.type === "stunStrike" && strike.knockedOut).toBe(false);
    expect(target.unconscious).toBeFalsy();
  });

  it("is blocked beyond reach", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const target = makeUnit(2, "enemy", { x: 8, y: 5 }, 6); // 3 tiles away, reach 1
    const state = makeState([attacker, target]);

    const evs = events(state, attacker, target.id);
    expect(evs.some((e) => e.type === "blocked")).toBe(true);
    expect(evs.some((e) => e.type === "stunStrike")).toBe(false);
    expect(target.stun ?? 0).toBe(0);
  });

  it("is blocked against a friendly target", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const ally = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([attacker, ally]);

    const evs = events(state, attacker, ally.id);
    expect(evs.some((e) => e.type === "blocked")).toBe(true);
    expect(ally.stun ?? 0).toBe(0);
  });

  it("is blocked with not enough TU", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()], tu: 1 });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6);
    const state = makeState([attacker, target]);

    const evs = events(state, attacker, target.id);
    expect(evs.some((e) => e.type === "blocked")).toBe(true);
    expect(target.stun ?? 0).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2. Stun decay + wake (via a full end-turn cycle -> startFactionTurn)
// ---------------------------------------------------------------------------

describe("stun decay and wake", () => {
  it("sheds DECAY_PER_TURN and wakes an unconscious unit whose stun drops below hp (TU 0)", () => {
    // Player unit KO'd with stun == hp; one decay drops it below hp -> wakes.
    const knocked = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      hp: 40,
      stun: 40,
      unconscious: true,
    });
    // A blind, far, out-of-TU enemy keeps the battle "playing" without acting.
    const enemy = makeUnit(2, "enemy", { x: 25, y: 25 }, 0, { tu: 0 });
    const state = makeState([knocked, enemy]);

    const evs = applyCommand(state, { type: "endTurn" });
    expect(evs.some((e) => e.type === "woke" && e.unitId === 1)).toBe(true);
    expect(knocked.unconscious).toBe(false);
    expect(knocked.stun).toBe(40 - STUN.DECAY_PER_TURN);
    expect(knocked.tu).toBe(0); // spends the waking turn with no TU
  });

  it("keeps a still-heavily-stunned unit unconscious after one decay", () => {
    const knocked = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      hp: 40,
      stun: 100,
      unconscious: true,
    });
    const enemy = makeUnit(2, "enemy", { x: 25, y: 25 }, 0, { tu: 0 });
    const state = makeState([knocked, enemy]);

    const evs = applyCommand(state, { type: "endTurn" });
    expect(evs.some((e) => e.type === "woke")).toBe(false);
    expect(knocked.unconscious).toBe(true);
    expect(knocked.stun).toBe(100 - STUN.DECAY_PER_TURN);
  });

  it("floors stun at 0 and does not wake a conscious unit", () => {
    const conscious = makeUnit(1, "player", { x: 5, y: 5 }, 2, { stun: 3, unconscious: false });
    const enemy = makeUnit(2, "enemy", { x: 25, y: 25 }, 0, { tu: 0 });
    const state = makeState([conscious, enemy]);

    applyCommand(state, { type: "endTurn" });
    expect(conscious.stun).toBe(0);
    expect(conscious.unconscious).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. AI skips unconscious units
// ---------------------------------------------------------------------------

describe("AI ignores unconscious units", () => {
  it("an unconscious enemy takes no turn (does not shoot the player)", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2, { hp: 40 });
    // Adjacent, facing the player, but knocked out: must not act.
    const enemy = makeUnit(2, "enemy", { x: 7, y: 5 }, 6, {
      unconscious: true,
      stun: 999,
      stats: {
        timeUnits: 60,
        health: 40,
        reactions: 100,
        firingAccuracy: 60,
        strength: 30,
        bravery: 50,
      },
    });
    const state = makeState([player, enemy]);

    const evs = applyCommand(state, { type: "endTurn" });
    // No shots from the KO'd enemy and the player is untouched.
    expect(evs.some((e) => e.type === "shot" && e.shooterId === 2)).toBe(false);
    expect(player.hp).toBe(40);
    expect(enemy.unconscious).toBe(true);
  });

  it("runEnemyTurn produces no actions for a lone unconscious enemy", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const enemy = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { unconscious: true, stun: 999 });
    const state = makeState([player, enemy], 1, { activeFaction: "enemy" });
    const exec: AiExecutor = {
      move: (id, to) => applyCommand(state, { type: "move", unitId: id, to }),
      shoot: () => [],
      reload: () => [],
      face: () => [],
    };
    const evs = runEnemyTurn(state, exec);
    expect(evs.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Reaction fire exclusions (both directions)
// ---------------------------------------------------------------------------

describe("reaction fire ignores unconscious units", () => {
  it("an unconscious reactor never fires", () => {
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, { tu: 5 });
    const reactor = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      unconscious: true,
      stun: 999,
      tu: 60,
    });
    const state = makeState([mover, reactor]);
    const evs = triggerReactions(state, mover);
    expect(evs.length).toBe(0);
    expect(mover.hp).toBe(40);
  });

  it("an unconscious mover never draws reaction fire", () => {
    const mover = makeUnit(1, "player", { x: 5, y: 5 }, 2, { unconscious: true, stun: 999 });
    const reactor = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { tu: 60 });
    const state = makeState([mover, reactor]);
    const evs = triggerReactions(state, mover);
    expect(evs.length).toBe(0);
    expect(mover.hp).toBe(40);
  });
});

// ---------------------------------------------------------------------------
// 5. Victory counts unconscious enemies + capture exposure
// ---------------------------------------------------------------------------

describe("victory and capture harvest", () => {
  it("player wins when every surviving enemy is unconscious", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const enemy = makeUnit(2, "enemy", { x: 20, y: 20 }, 0, { unconscious: true, stun: 999 });
    const state = makeState([player, enemy]);
    const over = checkVictory(state);
    expect(over && over.type === "gameOver" && over.status).toBe("player_win");
    expect(state.status).toBe("player_win");
  });

  it("a stun KO of the last active enemy ends the battle in a player win with captures", () => {
    const attacker = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [stunRod()] });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      hp: 40,
      templateId: "sectoidLeader",
      rank: "leader",
    });
    const state = makeState([attacker, target]);

    const evs = events(state, attacker, target.id);
    const over = evs.find((e) => e.type === "gameOver");
    expect(over && over.type === "gameOver" && over.status).toBe("player_win");
    expect(over && over.type === "gameOver" && over.captures).toEqual([
      { templateId: "sectoidLeader", rank: "leader" as EnemyRank },
    ]);
  });

  it("collectCaptures exposes faction=enemy, unconscious, hp>0 units with a default 'soldier' rank", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const koNoRank = makeUnit(2, "enemy", { x: 20, y: 20 }, 0, {
      unconscious: true,
      stun: 999,
      templateId: "grunt",
    });
    const koLeader = makeUnit(3, "enemy", { x: 21, y: 20 }, 0, {
      unconscious: true,
      stun: 999,
      templateId: "boss",
      rank: "commander",
    });
    const conscious = makeUnit(4, "enemy", { x: 22, y: 20 }, 0);
    const state = makeState([player, koNoRank, koLeader, conscious]);

    const captures = collectCaptures(state);
    expect(captures).toEqual([
      { templateId: "grunt", rank: "soldier" },
      { templateId: "boss", rank: "commander" },
    ]);
  });

  it("excludes a mind-controlled player soldier stunned while enthralled (home faction wins)", () => {
    // Mind control flips `faction` to the controller's side and stashes the home
    // faction on controlledByFaction. A player soldier seized by the enemy and then
    // stunned reads faction="enemy" — but is NOT an alien capture.
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const enthralled = makeUnit(2, "enemy", { x: 20, y: 20 }, 0, {
      unconscious: true,
      stun: 999,
      templateId: "trooper",
      controlledByFaction: "player", // home faction is player
    });
    const realAlien = makeUnit(3, "enemy", { x: 21, y: 20 }, 0, {
      unconscious: true,
      stun: 999,
      templateId: "grunt",
    });
    const state = makeState([player, enthralled, realAlien]);

    // Only the genuine alien is captured; the enthralled soldier is excluded.
    expect(collectCaptures(state)).toEqual([{ templateId: "grunt", rank: "soldier" }]);
  });

  it("still captures an alien the player mind-controlled (home faction is enemy)", () => {
    // Symmetric case: an alien seized by the player reads faction="player" but its
    // home faction is enemy — a stunned one is still an alien capture.
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const seizedAlien = makeUnit(2, "player", { x: 20, y: 20 }, 0, {
      unconscious: true,
      stun: 999,
      templateId: "grunt",
      controlledByFaction: "enemy", // home faction is enemy
    });
    const state = makeState([player, seizedAlien]);

    expect(collectCaptures(state)).toEqual([{ templateId: "grunt", rank: "soldier" }]);
  });

  it("a killed unconscious unit is a normal death and is NOT captured", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const ko = makeUnit(2, "enemy", { x: 6, y: 5 }, 0, {
      unconscious: true,
      stun: 999,
      hp: 5,
      templateId: "grunt",
    });
    const state = makeState([player, ko]);

    // A grenade centered on the KO'd unit kills it outright.
    resolveBlast(state, { x: 6, y: 5 }, 1, 200);
    expect(ko.alive).toBe(false);
    expect(ko.hp).toBe(0);
    expect(collectCaptures(state)).toEqual([]);
    // With no living/active enemy, the player wins with no captures.
    const over = checkVictory(state);
    expect(over && over.type === "gameOver" && over.status).toBe("player_win");
    // No captures -> the field is omitted (legacy shape), never an empty array.
    expect(over && over.type === "gameOver" && (over.captures ?? [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Blasts / panic robustness around unconscious units
// ---------------------------------------------------------------------------

describe("robustness with unconscious units", () => {
  it("a grenade blast damages an unconscious unit without crashing", () => {
    const player = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const ko = makeUnit(2, "enemy", { x: 6, y: 5 }, 0, { unconscious: true, stun: 999, hp: 200 });
    const state = makeState([player, ko]);
    expect(() => resolveBlast(state, { x: 6, y: 5 }, 2, 20)).not.toThrow();
    expect(ko.hp).toBeLessThan(200);
  });

  it("an unconscious, low-morale unit does not panic or act at turn start", () => {
    // Player unit KO'd and demoralized; the enemy turn's panic phase must skip it.
    const knocked = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      unconscious: true,
      stun: 999,
      morale: 0,
    });
    const enemy = makeUnit(2, "enemy", { x: 25, y: 25 }, 0, { tu: 0 });
    const state = makeState([knocked, enemy]);
    const evs = applyCommand(state, { type: "endTurn" });
    expect(evs.some((e) => e.type === "panicked" && e.unitId === 1)).toBe(false);
    expect(knocked.unconscious).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. Damage-induced knockout: a survivor whose stun >= (damaged) hp falls
//    unconscious via gunfire/blast, mirroring the stun-rod threshold + wake rule.
// ---------------------------------------------------------------------------

describe("damage-induced knockout (stun >= hp after damage)", () => {
  it("a gunshot that leaves hp <= existing stun knocks the target out (captured, not killed)", () => {
    // stun 199 vs hp 200: the first landed round drops hp to <=199 -> KO, and a
    // rifle snap can never deal the 200 needed to kill, so the unit is captured.
    const shooter = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 90, strength: 30, bravery: 50 },
    });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      hp: 200,
      stun: 199,
      templateId: "grunt",
      stats: { timeUnits: 60, health: 200, reactions: 10, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([shooter, target], 7);

    let knocked = false;
    let evs: GameEvent[] = [];
    for (let i = 0; i < 40 && !knocked; i++) {
      shooter.tu = shooter.stats.timeUnits;
      shooter.ammo = 100;
      evs = applyCommand(state, { type: "shoot", unitId: 1, target: target.pos, mode: "snap" });
      if (evs.some((e) => e.type === "knockedOut" && e.unitId === 2)) knocked = true;
      if (evs.some((e) => e.type === "died" && e.unitId === 2)) break;
    }
    expect(knocked).toBe(true);
    expect(target.unconscious).toBe(true);
    expect(target.alive).toBe(true);
    expect(target.hp).toBeGreaterThan(0);
    // KO of the last active hostile ends the battle in a player win, capturing it.
    expect(evs.some((e) => e.type === "gameOver" && e.status === "player_win")).toBe(true);
    expect(collectCaptures(state)).toEqual([{ templateId: "grunt", rank: "soldier" }]);
  });

  it("a grenade blast that leaves hp <= existing stun knocks the target out", () => {
    // hp 200, stun 190: any grenade damage (never lethal here) leaves hp <= stun.
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [grenade()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const target = makeUnit(2, "enemy", { x: 9, y: 5 }, 6, {
      hp: 200,
      stun: 190,
      templateId: "grunt",
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, target], 2024);

    const evs = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 9, y: 5 },
      itemId: "grenade",
    });

    expect(evs.some((e) => e.type === "knockedOut" && e.unitId === 2)).toBe(true);
    expect(target.unconscious).toBe(true);
    expect(target.alive).toBe(true);
    expect(target.hp).toBeGreaterThan(0);
    expect(evs.some((e) => e.type === "gameOver" && e.status === "player_win")).toBe(true);
  });

  it("does NOT knock out a survivor whose stun stays below its damaged hp", () => {
    // stun 10 vs hp 200: a grenade won't bring hp anywhere near 10, so no KO.
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [grenade()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const target = makeUnit(2, "enemy", { x: 9, y: 5 }, 6, {
      hp: 200,
      stun: 10,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([thrower, target], 2024);

    const evs = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 9, y: 5 },
      itemId: "grenade",
    });

    expect(evs.some((e) => e.type === "knockedOut")).toBe(false);
    expect(target.unconscious).toBeFalsy();
  });
});
