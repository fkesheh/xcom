import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { applyCommand, tickSmokeClouds } from "../src/sim/battle";
import { previewShot } from "../src/sim/combat";
import { canSee } from "../src/sim/los";
import { ITEMS, TEMPLATES, WEAPONS } from "../src/sim/content";
import { SMOKE } from "../src/sim/types";
import type {
  BattleState,
  Faction,
  ItemInstance,
  Unit,
  UnitId,
  Vec2,
  Dir8,
} from "../src/sim/types";

/**
 * Smoke grenade coverage: throwing deploys a line-of-sight-blocking cloud,
 * shots/vision through it are blocked, and the cloud dissipates after a fixed
 * number of rounds. All scenarios build deterministic open-grid battles.
 */

function unitFromTemplate(
  id: UnitId,
  templateId: string,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  const tpl = TEMPLATES[templateId]!;
  return {
    id,
    name: `u${id}`,
    templateId: tpl.id,
    faction: tpl.faction,
    pos,
    facing,
    stats: { ...tpl.stats },
    tu: tpl.stats.timeUnits,
    hp: tpl.stats.health,
    weaponId: tpl.weaponId,
    ammo: WEAPONS[tpl.weaponId]?.magazineSize ?? 0,
    alive: true,
    reserve: "none",
    sightRange: tpl.sightRange,
    visionHalfAngleDeg: tpl.visionHalfAngleDeg,
    ...overrides,
  };
}

function openBattle(units: Unit[], seed = 1, activeFaction: Faction = "player"): BattleState {
  return {
    grid: makeGrid(24, 24),
    units,
    weapons: WEAPONS,
    items: { ...ITEMS },
    turn: 1,
    activeFaction,
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

const SMOKE_INSTANCE: ItemInstance = { itemId: "smoke", uses: 1 };

describe("smoke grenade catalogue", () => {
  it("is registered as a smoke item with cloud radius and TU cost", () => {
    const def = ITEMS.smoke;
    expect(def).toBeDefined();
    expect(def!.kind).toBe("smoke");
    expect(def!.tuPercent).toBe(30);
    expect(def!.blastRadius).toBe(2);
    expect(def!.throwRange).toBeGreaterThan(0);
  });
});

describe("throwing a smoke grenade", () => {
  it("deploys a smokeCloud at the target instead of a blast", () => {
    const thrower = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4, {
      items: [SMOKE_INSTANCE],
    });
    const state = openBattle([thrower]);

    expect(state.smokeClouds).toBeUndefined();

    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 5, y: 8 },
      itemId: "smoke",
    });

    // A cloud is created with the item's radius and the configured duration.
    expect(state.smokeClouds).toBeDefined();
    expect(state.smokeClouds).toHaveLength(1);
    const cloud = state.smokeClouds![0]!;
    expect(cloud.pos).toEqual({ x: 5, y: 8 });
    expect(cloud.radius).toBe(2);
    expect(cloud.turnsLeft).toBe(SMOKE.DURATION_TURNS);

    // The throw cost TU and consumed the single charge.
    expect(thrower.tu).toBe(60 - Math.ceil((60 * 30) / 100));
    expect(thrower.items?.some((i) => i.itemId === "smoke" && i.uses > 0)).toBe(false);

    // An itemThrown event fired; crucially, no blastDetonated follows (smoke is
    // non-damaging) and nothing was blocked.
    expect(events.some((e) => e.type === "itemThrown")).toBe(true);
    expect(events.some((e) => e.type === "blastDetonated")).toBe(false);
    expect(events.some((e) => e.type === "blocked")).toBe(false);
  });

  it("is rejected for a non-throwable item id", () => {
    const thrower = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4, {
      items: [{ itemId: "medkit", uses: 1 }],
    });
    const state = openBattle([thrower]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 5, y: 8 },
      itemId: "medkit",
    });
    expect(events[0]?.type).toBe("blocked");
    expect(state.smokeClouds).toBeUndefined();
  });
});

describe("smoke blocks line of sight and fire", () => {
  // Trooper faces South (+y); the drone sits due south on a clear line.
  const setup = (): { state: BattleState; trooper: Unit; drone: Unit } => {
    const trooper = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4);
    const drone = unitFromTemplate(2, "drone", { x: 5, y: 11 }, 0);
    const state = openBattle([trooper, drone]);
    return { state, trooper, drone };
  };

  it("has a clear baseline shot and vision without smoke", () => {
    const { state, trooper, drone } = setup();
    expect(previewShot(state, trooper, drone.pos, "snap").possible).toBe(true);
    expect(canSee(state.grid, trooper, drone.pos)).toBe(true);
  });

  it("blocks previewShot (no line of fire) and canSee through a cloud", () => {
    const { state, trooper, drone } = setup();
    // Cloud at (5,8) radius 2 covers every intermediate tile on the line.
    state.smokeClouds = [{ pos: { x: 5, y: 8 }, radius: 2, turnsLeft: SMOKE.DURATION_TURNS }];

    const preview = previewShot(state, trooper, drone.pos, "snap");
    expect(preview.possible).toBe(false);
    expect(preview.reason).toBe("no line of fire");

    // Direct canSee call must hand the clouds in to be blocked.
    expect(canSee(state.grid, trooper, drone.pos, state.smokeClouds)).toBe(false);
    // Without the clouds argument the geometry itself is still clear, proving the
    // block comes from the smoke, not an obstacle.
    expect(canSee(state.grid, trooper, drone.pos, undefined)).toBe(true);
  });

  it("blocks a real shot via executeShoot (target not visible through smoke)", () => {
    const { state, drone } = setup();
    state.smokeClouds = [{ pos: { x: 5, y: 8 }, radius: 2, turnsLeft: SMOKE.DURATION_TURNS }];

    const events = applyCommand(state, {
      type: "shoot",
      unitId: 1,
      target: drone.pos,
      mode: "snap",
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("blocked");
    // No rounds were resolved and the target is unharmed.
    expect(drone.hp).toBe(drone.stats.health);
  });
});

describe("smoke dissipation", () => {
  it("tickSmokeClouds decrements turnsLeft each round and removes expired clouds", () => {
    const units = [unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4)];
    const state = openBattle(units);
    state.smokeClouds = [
      { pos: { x: 5, y: 8 }, radius: 2, turnsLeft: SMOKE.DURATION_TURNS },
    ];

    for (let i = SMOKE.DURATION_TURNS - 1; i > 0; i--) {
      tickSmokeClouds(state);
      expect(state.smokeClouds).toHaveLength(1);
      expect(state.smokeClouds![0]!.turnsLeft).toBe(i);
    }

    // The final tick clears the cloud entirely (and drops the array).
    tickSmokeClouds(state);
    expect(state.smokeClouds).toBeUndefined();
  });

  it("ticks once per round through endTurn and restores line of sight when gone", () => {
    // Neither side can damage the other across the enemy turn, so the battle
    // stays "playing" and the cloud is the only state that changes: the trooper
    // has no ammo (so no reaction fire) and the drone has no weapon at all (so
    // it can neither shoot nor reload). Deterministic for the fixed seed.
    const trooper = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4, {
      items: [SMOKE_INSTANCE],
      ammo: 0,
    });
    const drone = unitFromTemplate(2, "drone", { x: 5, y: 11 }, 0, {
      weaponId: "none",
      ammo: 0,
    });
    const state = openBattle([trooper, drone], 42);

    applyCommand(state, { type: "throwItem", unitId: 1, target: { x: 5, y: 8 }, itemId: "smoke" });
    expect(state.smokeClouds![0]!.turnsLeft).toBe(SMOKE.DURATION_TURNS);

    // Vision through the fresh cloud is broken.
    expect(canSee(state.grid, trooper, drone.pos, state.smokeClouds)).toBe(false);

    // End N-1 rounds: the cloud is still up, just older.
    for (let i = SMOKE.DURATION_TURNS - 1; i > 0; i--) {
      applyCommand(state, { type: "endTurn" });
      expect(state.status).toBe("playing");
      expect(state.smokeClouds).toBeDefined();
      expect(state.smokeClouds![0]!.turnsLeft).toBe(i);
    }

    // The round that burns the last charge dissolves the cloud; LOS returns.
    applyCommand(state, { type: "endTurn" });
    expect(state.smokeClouds).toBeUndefined();
    expect(canSee(state.grid, trooper, drone.pos)).toBe(true);
  });
});
