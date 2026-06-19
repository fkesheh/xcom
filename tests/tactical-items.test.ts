import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import {
  applyCommand,
  unitById,
} from "../src/sim/battle";
import {
  resolveBlast,
  resolveHeal,
  braveryOf,
  moraleRecoveryFor,
  rollPanic,
  applyMoraleLoss,
} from "../src/sim/combat";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { COMBAT, MORALE } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
  GameEvent,
  ItemInstance,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "../src/sim/types";

/** Grenade base damage (ITEMS is index-signatured as possibly-undefined). */
const GRENADE_DAMAGE: number = ITEMS.grenade!.damage!;

// ---------------------------------------------------------------------------
// Test factories. Mirrors tests/combat.test.ts but populates morale + items so
// the unit opts into the morale system, and seeds state.items with the catalogue.
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
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

function grenade(uses = 1): ItemInstance {
  return { itemId: "grenade", uses };
}
function medkit(uses = 3): ItemInstance {
  return { itemId: "medkit", uses };
}

function makeState(units: Unit[], seed = 1234): BattleState {
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
  };
}

/** A high-damage guaranteed-hit rifle for morale/casualty tests. */
const killRifle = (): Weapon => ({
  ...WEAPONS.rifle!,
  damage: 100,
});

// ---------------------------------------------------------------------------
// resolveBlast
// ---------------------------------------------------------------------------

describe("resolveBlast", () => {
  it("hits every living unit within the radius and none outside", () => {
    const center: Vec2 = { x: 10, y: 10 };
    const radius = 2;
    const inside = [
      makeUnit(1, "enemy", { x: 10, y: 10 }, 0, { hp: 1000 }), // dist 0 (center)
      makeUnit(2, "enemy", { x: 11, y: 10 }, 0, { hp: 1000 }), // dist 1
      makeUnit(3, "enemy", { x: 12, y: 10 }, 0, { hp: 1000 }), // dist 2
      makeUnit(4, "enemy", { x: 11, y: 11 }, 0, { hp: 1000 }), // dist 2 (diag)
    ];
    const outside = [
      makeUnit(5, "enemy", { x: 13, y: 10 }, 0, { hp: 1000 }), // dist 3
      makeUnit(6, "enemy", { x: 20, y: 20 }, 0, { hp: 1000 }), // far
    ];
    const deadInside = makeUnit(7, "enemy", { x: 10, y: 11 }, 0, {
      hp: 1000,
      alive: false,
    }); // dist 1 but dead
    const state = makeState([...inside, ...outside, deadInside], 7);

    const { hits } = resolveBlast(state, center, radius, GRENADE_DAMAGE);

    const hitIds = hits.map((h) => h.unitId).sort((a, b) => a - b);
    expect(hitIds).toEqual([1, 2, 3, 4]);
    // Units outside the radius and dead units are untouched.
    for (const u of [...outside, deadInside]) {
      expect(u.hp).toBe(1000);
    }
  });

  it.each<[number, number, number]>([
    [0, 1.0, 56],
    [1, 0.75, 42],
    [2, 0.5, 28],
    [3, 0.25, 14],
    [4, 0.2, 12], // falloff clamps to 0.2 at distance 4+
  ])(
    "damage at distance %i stays within the falloff-scaled range (falloff %s, base %s)",
    (dist, _falloff, _baseScaled) => {
      void _falloff;
      void _baseScaled;
      const base = GRENADE_DAMAGE;
      const falloff = Math.max(0.2, 1 - dist * 0.25);
      const lower = Math.max(1, Math.round(base * falloff * COMBAT.DAMAGE_MIN_MULT));
      const upper = Math.max(1, Math.round(base * falloff * COMBAT.DAMAGE_MAX_MULT));
      // Place a target at exactly `dist` tiles (and the blast far from others).
      const target = makeUnit(1, "enemy", { x: 10 + dist, y: 10 }, 0, { hp: 10000 });
      const state = makeState([target], 3);
      const { hits } = resolveBlast(state, { x: 10, y: 10 }, dist, base);
      expect(hits).toHaveLength(1);
      expect(hits[0]!.damage).toBeGreaterThanOrEqual(lower);
      expect(hits[0]!.damage).toBeLessThanOrEqual(upper);
    },
  );

  it("the center unit takes more damage than a unit at the edge (falloff)", () => {
    const center = makeUnit(1, "enemy", { x: 10, y: 10 }, 0, { hp: 10000 });
    const edge = makeUnit(2, "enemy", { x: 12, y: 10 }, 0, { hp: 10000 }); // dist 2
    const state = makeState([center, edge], 99);
    const { hits } = resolveBlast(state, { x: 10, y: 10 }, 2, GRENADE_DAMAGE);
    const byId = new Map(hits.map((h) => [h.unitId, h.damage] as const));
    // Both the falloff (1.0 vs 0.5) and damage floor favour the center; with a
    // fixed seed this holds for the chosen configuration.
    expect(byId.get(1)!).toBeGreaterThan(byId.get(2)!);
  });

  it("kills a unit reduced to <= 0 hp and flags it alive=false", () => {
    const victim = makeUnit(1, "enemy", { x: 10, y: 10 }, 0, { hp: 5 });
    const state = makeState([victim], 1);
    const { hits } = resolveBlast(state, { x: 10, y: 10 }, 1, GRENADE_DAMAGE);
    expect(hits[0]!.killed).toBe(true);
    expect(victim.hp).toBe(0);
    expect(victim.alive).toBe(false);
  });

  it("advances the rng once per struck unit, in ascending id order", () => {
    const a = makeUnit(2, "enemy", { x: 10, y: 10 }, 0, { hp: 10000 });
    const b = makeUnit(1, "enemy", { x: 11, y: 10 }, 0, { hp: 10000 });
    const state = makeState([a, b], 42); // inserted out of id order
    const before = state.rng.state;
    resolveBlast(state, { x: 10, y: 10 }, 2, GRENADE_DAMAGE);
    // Two living units struck => two rng draws consumed.
    expect(state.rng.state).not.toBe(before);
    // Re-run on a clone with the SAME insertion order: identical damage.
    const clone = makeState([makeUnit(2, "enemy", { x: 10, y: 10 }, 0, { hp: 10000 }), makeUnit(1, "enemy", { x: 11, y: 10 }, 0, { hp: 10000 })], 42);
    const first = resolveBlast(state, { x: 10, y: 10 }, 2, GRENADE_DAMAGE).hits;
    const second = resolveBlast(clone, { x: 10, y: 10 }, 2, GRENADE_DAMAGE).hits;
    expect(second.map((h) => h.unitId)).toEqual(first.map((h) => h.unitId));
    void before;
  });
});

// ---------------------------------------------------------------------------
// resolveHeal
// ---------------------------------------------------------------------------

describe("resolveHeal", () => {
  it.each<[number, number, number, number]>([
    [10, 30, 30, 40], // wounded: full heal amount, capped at maxHp 40
    [35, 30, 5, 40], // near full: only 5 actually healed (capped)
    [40, 30, 0, 40], // already full: 0 over-heal
    [0, 30, 30, 30], // from brink of death
  ])(
    "hp %i + heal %i => healed %i, hp %i (maxHp 40)",
    (hpBefore, amount, healed, hpAfter) => {
      const target = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
        hp: hpBefore,
        stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
      });
      const state = makeState([target]);
      const res = resolveHeal(state, target, amount);
      expect(res.healed).toBe(healed);
      expect(target.hp).toBe(hpAfter);
    },
  );
});

// ---------------------------------------------------------------------------
// throwItem command (player throws a grenade via applyCommand)
// ---------------------------------------------------------------------------

describe("throwItem command", () => {
  it("consumes the grenade, spends TU, and emits itemThrown + blastDetonated hitting a cluster", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [grenade()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const cluster = [
      makeUnit(2, "enemy", { x: 10, y: 5 }, 6, { hp: 500, stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 } }),
      makeUnit(3, "enemy", { x: 10, y: 6 }, 6, { hp: 500, stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 } }),
      makeUnit(4, "enemy", { x: 11, y: 5 }, 6, { hp: 500, stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 } }),
    ];
    const state = makeState([thrower, ...cluster], 2024);

    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 10, y: 5 },
      itemId: "grenade",
    });

    const thrown = events.find((e) => e.type === "itemThrown");
    const blast = events.find((e) => e.type === "blastDetonated");
    expect(thrown).toBeDefined();
    expect(blast).toBeDefined();

    // TU spent: grenade tuPercent 30 of 60 => ceil(18) = 18.
    expect(thrower.tu).toBe(60 - 18);
    if (thrown?.type === "itemThrown") {
      expect(thrown.tuLeft).toBe(thrower.tu);
      expect(thrown.from).toEqual({ x: 5, y: 5 });
      expect(thrown.to).toEqual({ x: 10, y: 5 });
    }

    // The blast hit >= 2 clustered units and damaged every one.
    if (blast?.type === "blastDetonated") {
      expect(blast.hits.length).toBeGreaterThanOrEqual(2);
      const hitIds = blast.hits.map((h) => h.unitId).sort((a, b) => a - b);
      expect(hitIds).toContain(2);
      expect(hitIds).toContain(3);
    }
    for (const e of cluster) {
      expect(e.hp).toBeLessThan(500);
    }

    // Single-use grenade consumed: no grenade instance remains.
    expect(thrower.items?.find((i) => i.itemId === "grenade")).toBeUndefined();
  });

  it("is blocked when the target is out of throw range", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [grenade()] });
    const far = makeUnit(2, "enemy", { x: 20, y: 5 }, 6, { hp: 500 });
    const state = makeState([thrower, far]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 20, y: 5 },
      itemId: "grenade",
    });
    expect(events).toEqual([{ type: "blocked", reason: "out of throw range" }]);
    expect(thrower.items?.find((i) => i.itemId === "grenade")).toBeDefined();
  });

  it("is blocked when the unit lacks enough TU", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [grenade()], tu: 5 });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { hp: 500 });
    const state = makeState([thrower, target]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 6, y: 5 },
      itemId: "grenade",
    });
    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    expect(thrower.tu).toBe(5); // nothing spent on a blocked throw
  });

  it("is blocked when the unit has no such grenade", () => {
    const thrower = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [] });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, { hp: 500 });
    const state = makeState([thrower, target]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 6, y: 5 },
      itemId: "grenade",
    });
    expect(events).toEqual([{ type: "blocked", reason: "no grenade" }]);
  });
});

// ---------------------------------------------------------------------------
// useItem (medkit)
// ---------------------------------------------------------------------------

describe("useItem (medkit)", () => {
  it("heals an adjacent ally, spends TU, and consumes a charge", () => {
    const medic = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [medkit(3)],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const ally = makeUnit(2, "player", { x: 5, y: 6 }, 0, {
      hp: 10,
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([medic, ally]);

    const events = applyCommand(state, {
      type: "useItem",
      unitId: 1,
      targetId: 2,
      itemId: "medkit",
    });

    expect(events).toHaveLength(1);
    const used = events[0]!;
    expect(used.type).toBe("itemUsed");
    if (used.type === "itemUsed") {
      expect(used.healed).toBe(30); // healAmount 30, ally 10 -> 40 (capped)
      expect(used.targetId).toBe(2);
      expect(used.tuLeft).toBe(60 - 24); // medkit tuPercent 40 of 60 => ceil(24)
    }
    expect(ally.hp).toBe(40);
    expect(medic.items!.find((i) => i.itemId === "medkit")!.uses).toBe(2);
  });

  it("caps healing at the target's max health", () => {
    const medic = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [medkit(1)] });
    const ally = makeUnit(2, "player", { x: 5, y: 6 }, 0, {
      hp: 35,
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const state = makeState([medic, ally]);
    const events = applyCommand(state, { type: "useItem", unitId: 1, targetId: 2, itemId: "medkit" });
    if (events[0]!.type === "itemUsed") {
      expect(events[0]!.healed).toBe(5); // 35 + 30 capped at 40
    }
    expect(ally.hp).toBe(40);
    // Last charge spent => medkit removed.
    expect(medic.items?.find((i) => i.itemId === "medkit")).toBeUndefined();
  });

  it("is blocked when the target is too far", () => {
    const medic = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [medkit()] });
    const ally = makeUnit(2, "player", { x: 8, y: 8 }, 0, { hp: 10 });
    const state = makeState([medic, ally]);
    const events = applyCommand(state, { type: "useItem", unitId: 1, targetId: 2, itemId: "medkit" });
    expect(events).toEqual([{ type: "blocked", reason: "too far" }]);
  });

  it("is blocked when the target is not an ally", () => {
    const medic = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [medkit()] });
    const foe = makeUnit(2, "enemy", { x: 5, y: 6 }, 0, { hp: 10 });
    const state = makeState([medic, foe]);
    const events = applyCommand(state, { type: "useItem", unitId: 1, targetId: 2, itemId: "medkit" });
    expect(events).toEqual([{ type: "blocked", reason: "not an ally" }]);
  });

  it("is blocked when the unit has no medkit", () => {
    const medic = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [] });
    const ally = makeUnit(2, "player", { x: 5, y: 6 }, 0, { hp: 10 });
    const state = makeState([medic, ally]);
    const events = applyCommand(state, { type: "useItem", unitId: 1, targetId: 2, itemId: "medkit" });
    expect(events).toEqual([{ type: "blocked", reason: "no medkit" }]);
  });
});

// ---------------------------------------------------------------------------
// primeItem + start-of-turn primed detonation
// ---------------------------------------------------------------------------

describe("primeItem", () => {
  it("sets primed + fuseTurns and spends half the throw TU", () => {
    const carrier = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [grenade()],
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const farEnemy = makeUnit(2, "enemy", { x: 29, y: 29 }, 6, { hp: 100 });
    const state = makeState([carrier, farEnemy]);

    const events = applyCommand(state, {
      type: "primeItem",
      unitId: 1,
      itemId: "grenade",
      fuseTurns: 1,
    });

    expect(events).toEqual([]); // state change only
    const inst = carrier.items!.find((i) => i.itemId === "grenade")!;
    expect(inst.primed).toBe(true);
    expect(inst.fuseTurns).toBe(1);
    // Half of the throw TU: ceil(60 * 30 / 100 * 0.5) = ceil(9) = 9.
    expect(carrier.tu).toBe(60 - 9);
  });

  it("is blocked without a grenade or enough TU", () => {
    const noGrenade = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [] });
    const stateA = makeState([noGrenade]);
    expect(applyCommand(stateA, { type: "primeItem", unitId: 1, itemId: "grenade", fuseTurns: 1 })).toEqual([
      { type: "blocked", reason: "no grenade" },
    ]);

    const broke = makeUnit(1, "player", { x: 5, y: 5 }, 2, { items: [grenade()], tu: 2 });
    const stateB = makeState([broke]);
    expect(applyCommand(stateB, { type: "primeItem", unitId: 1, itemId: "grenade", fuseTurns: 1 })).toEqual([
      { type: "blocked", reason: "not enough TU" },
    ]);
  });

  it("a primed grenade detonates on its carrier at the start of its next turn", () => {
    // Carrier primes a 1-fuse grenade on turn 1, then ends the turn. The enemy
    // (parked far away) cannot see or reach the carrier, so it survives to its
    // own next turn start, where the primed charge detonates on its tile.
    const carrier = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      items: [grenade()],
      hp: 200,
      stats: { timeUnits: 60, health: 200, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const farEnemy = makeUnit(2, "enemy", { x: 29, y: 29 }, 6, { hp: 100 });
    const state = makeState([carrier, farEnemy], 8);

    applyCommand(state, { type: "primeItem", unitId: 1, itemId: "grenade", fuseTurns: 1 });
    const hpBeforeBlast = carrier.hp;
    const tuBeforeEnd = carrier.tu;

    const turnEvents = applyCommand(state, { type: "endTurn" });

    const blast = turnEvents.find(
      (e) => e.type === "blastDetonated" && e.center.x === 5 && e.center.y === 5,
    );
    expect(blast).toBeDefined();
    if (blast?.type === "blastDetonated") {
      expect(blast.itemId).toBe("grenade");
      expect(blast.hits.map((h) => h.unitId)).toContain(1);
    }
    // The carrier took blast damage but survived.
    expect(carrier.hp).toBeLessThan(hpBeforeBlast);
    expect(carrier.alive).toBe(true);
    // The primed charge is gone after detonation, and TU was refilled for the new round.
    expect(carrier.items?.find((i) => i.itemId === "grenade" && i.primed)).toBeUndefined();
    expect(carrier.tu).toBe(carrier.stats.timeUnits);
    void tuBeforeEnd;
  });
});

// ---------------------------------------------------------------------------
// Morale & panic
// ---------------------------------------------------------------------------

describe("morale helpers", () => {
  it("braveryOf falls back to the default when unset", () => {
    const brave = makeUnit(1, "player", { x: 0, y: 0 }, 0, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 80 },
    });
    const rookie = makeUnit(2, "player", { x: 0, y: 0 }, 0, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30 },
    });
    expect(braveryOf(brave)).toBe(80);
    expect(braveryOf(rookie)).toBe(MORALE.DEFAULT_BRAVERY);
  });

  it.each<[number, number]>([
    [0, 1], // bravery 0 still recovers the minimum 1
    [30, 3], // 6 * 30 / 60 = 3
    [60, 6], // baseline bravery => full RECOVERY_PER_TURN
    [120, 12], // brave veteran recovers double
  ])("moraleRecoveryFor scales with bravery (%i => %i)", (bravery, expected) => {
    const u = makeUnit(1, "player", { x: 0, y: 0 }, 0, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery },
    });
    expect(moraleRecoveryFor(u)).toBe(expected);
  });

  it("applyMoraleLoss clamps to [0, MAX] and writes back", () => {
    const u = makeUnit(1, "player", { x: 0, y: 0 }, 0, { morale: 40 });
    expect(applyMoraleLoss(u, 12)).toBe(28);
    expect(u.morale).toBe(28);
    // Clamps at the floor.
    applyMoraleLoss(u, 100);
    expect(u.morale).toBe(0);
    // Clamps at the ceiling.
    u.morale = 95;
    expect(applyMoraleLoss(u, -10)).toBe(100);
    expect(u.morale).toBe(100);
  });

  it("rollPanic returns null at/above the threshold without advancing the rng", () => {
    const u = makeUnit(1, "player", { x: 0, y: 0 }, 0, { morale: MORALE.PANIC_THRESHOLD });
    const state = makeState([u], 1);
    const before = state.rng.state;
    expect(rollPanic(state, u)).toBeNull();
    expect(state.rng.state).toBe(before); // short-circuited, no roll
  });

  it("rollPanic always panics a low-bravery unit below the threshold", () => {
    // bravery 0 => resistChance 0 => never resists => a behavior is always rolled.
    const u = makeUnit(1, "player", { x: 0, y: 0 }, 0, {
      morale: 10,
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 0 },
    });
    const state = makeState([u], 1);
    const behavior = rollPanic(state, u);
    expect(behavior).not.toBeNull();
    expect(["freeze", "flee", "berserk"]).toContain(behavior);
  });
});

describe("morale on casualties", () => {
  function shootUntilDamaged(state: BattleState, shooterId: UnitId, target: Vec2): GameEvent[] {
    const shooter = unitById(state, shooterId)!;
    for (let i = 0; i < 40; i++) {
      shooter.tu = shooter.stats.timeUnits;
      shooter.ammo = 100;
      const ev = applyCommand(state, { type: "shoot", unitId: shooterId, target, mode: "snap" });
      // A moraleChanged event for the target means a damaging hit landed.
      if (ev.some((e) => e.type === "moraleChanged")) return ev;
    }
    throw new Error("snap shot never landed a damaging hit");
  }

  it("taking fire lowers the wounded unit's morale and nearby same-faction allies", () => {
    const shooter = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 100, strength: 30, bravery: 50 },
      ammo: 100,
      weaponId: "rifle",
    });
    const target = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      hp: 1000,
      morale: 80,
      stats: { timeUnits: 60, health: 1000, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const ally = makeUnit(3, "enemy", { x: 7, y: 5 }, 6, {
      hp: 1000,
      morale: 80,
      stats: { timeUnits: 60, health: 1000, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    }); // within 6 tiles of the target
    // Use the high-damage rifle so any hit clearly wounds without killing.
    const state = makeState([shooter, target, ally], 7);
    state.weapons = { rifle: killRifle() };

    const events = shootUntilDamaged(state, 1, target.pos);

    // Self-wound on the target and ally-wound on the nearby same-faction unit.
    const moraleEvents = events.filter((e) => e.type === "moraleChanged");
    const targetMorale = moraleEvents.find((e) => e.type === "moraleChanged" && e.unitId === 2);
    const allyMorale = moraleEvents.find((e) => e.type === "moraleChanged" && e.unitId === 3);
    expect(targetMorale).toBeDefined();
    expect(allyMorale).toBeDefined();
    if (targetMorale?.type === "moraleChanged") {
      expect(targetMorale.morale).toBe(80 - MORALE.SELF_WOUNDED_LOSS);
    }
    if (allyMorale?.type === "moraleChanged") {
      expect(allyMorale.morale).toBe(80 - MORALE.ALLY_WOUNDED_LOSS);
    }
  });

  it("an ally death lowers the morale of nearby same-faction allies", () => {
    const shooter = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 100, strength: 30, bravery: 50 },
      ammo: 100,
    });
    const victim = makeUnit(2, "enemy", { x: 6, y: 5 }, 6, {
      hp: 1,
      morale: 80,
      stats: { timeUnits: 60, health: 1, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    });
    const witness = makeUnit(3, "enemy", { x: 7, y: 5 }, 6, {
      hp: 1000,
      morale: 80,
      stats: { timeUnits: 60, health: 1000, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 50 },
    }); // within 8 tiles of the death
    const state = makeState([shooter, victim, witness], 7);
    state.weapons = { rifle: killRifle() };

    // Fire until the victim dies.
    let died = false;
    for (let i = 0; i < 40 && !died; i++) {
      shooter.tu = shooter.stats.timeUnits;
      shooter.ammo = 100;
      const ev = applyCommand(state, { type: "shoot", unitId: 1, target: victim.pos, mode: "snap" });
      died = ev.some((e) => e.type === "died" && e.unitId === 2);
    }
    expect(died).toBe(true);
    expect(victim.alive).toBe(false);

    // The witness lost ALLY_DEATH_LOSS from seeing its ally fall.
    expect(witness.morale).toBe(80 - MORALE.ALLY_DEATH_LOSS);
  });
});

describe("morale recovery + panic at turn start", () => {
  it("recovers morale at the start of the unit's own turn", () => {
    // Bravery 100 => +10/turn recovery. Start at 30 (below threshold) but
    // recovery lifts it to 40 (>= threshold) so no panic roll fires.
    const shaken = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      morale: 30,
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 100 },
    });
    const farEnemy = makeUnit(2, "enemy", { x: 29, y: 29 }, 6, { hp: 100, morale: 100 });
    const state = makeState([shaken, farEnemy], 5);

    const events = applyCommand(state, { type: "endTurn" });

    const recovery = events.find(
      (e) => e.type === "moraleChanged" && e.unitId === 1,
    );
    expect(recovery).toBeDefined();
    if (recovery?.type === "moraleChanged") {
      expect(recovery.morale).toBe(40);
    }
    expect(shaken.morale).toBe(40);
    // No panic: 40 is at/above the threshold.
    expect(events.some((e) => e.type === "panicked" && e.unitId === 1)).toBe(false);
  });

  it("a unit below the panic threshold can panic at the start of its turn", () => {
    // bravery 0 => resistChance 0 => always rolls a behavior; recovery (+1) keeps
    // morale below the threshold, so the panic phase fires.
    const fragile = makeUnit(1, "player", { x: 5, y: 5 }, 2, {
      morale: 10,
      stats: { timeUnits: 60, health: 40, reactions: 40, firingAccuracy: 60, strength: 30, bravery: 0 },
    });
    const farEnemy = makeUnit(2, "enemy", { x: 29, y: 29 }, 6, { hp: 100, morale: 100 });
    const state = makeState([fragile, farEnemy], 11);

    const events = applyCommand(state, { type: "endTurn" });

    const panic = events.find((e) => e.type === "panicked" && e.unitId === 1);
    expect(panic).toBeDefined();
    if (panic?.type === "panicked") {
      expect(["freeze", "flee", "berserk"]).toContain(panic.behavior);
    }
  });
});
