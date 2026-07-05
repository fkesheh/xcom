import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { applyCommand, unitById } from "../src/sim/battle";
import { createSkirmish } from "../src/sim/setup";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { BACKPACK, MORALE } from "../src/sim/types";
import type {
  BattleState,
  Dir8,
  Faction,
  ItemInstance,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";
import {
  BACKPACK_SLOTS,
  canAddToBackpack,
  backpackRemainingSlots,
  itemSize,
} from "../src/campaign/backpack";

// ---------------------------------------------------------------------------
// Test factories (mirrors tests/items-extra.test.ts).
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

function grenade(uses = 1, location: ItemInstance["location"] = "hand"): ItemInstance {
  return { itemId: "grenade", uses, location };
}
function medkit(uses = 3, location: ItemInstance["location"] = "hand"): ItemInstance {
  return { itemId: "medkit", uses, location };
}

describe("setup: loadout items start stowed", () => {
  it("createSkirmish stows every player trooper's consumables in the backpack", () => {
    const state = createSkirmish({ seed: 1, players: 1, enemies: 1 });
    const trooper = state.units.find((u) => u.faction === "player")!;
    expect(trooper.items && trooper.items.length).toBeGreaterThan(0);
    for (const inst of trooper.items ?? []) {
      expect(inst.location).toBe("backpack");
    }
  });

  it("extra playerItems (loadout add-ons) also start stowed", () => {
    const state = createSkirmish({
      seed: 2,
      players: 1,
      enemies: 1,
      playerItems: [["scanner"]],
    });
    const trooper = state.units.find((u) => u.faction === "player")!;
    const scanner = trooper.items?.find((it) => it.itemId === "scanner");
    expect(scanner?.location).toBe("backpack");
  });
});

describe("executeRetrieveItem", () => {
  it("moves a stowed item to hand and deducts floor(maxTu*15/100) TU", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "backpack")],
      tu: 60,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, { type: "retrieveItem", unitId: 1, itemId: "grenade" });
    expect(events).not.toEqual([{ type: "blocked", reason: expect.any(String) }]);
    const after = unitById(state, 1)!;
    const expectedCost = Math.floor((60 * BACKPACK.RETRIEVE_TU_PERCENT) / 100);
    expect(expectedCost).toBe(9);
    expect(after.tu).toBe(60 - expectedCost);
    expect(after.items?.find((it) => it.itemId === "grenade")?.location).toBe("hand");
  });

  it("is blocked with insufficient TU, spending nothing and leaving location unchanged", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "backpack")],
      tu: 2,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, { type: "retrieveItem", unitId: 1, itemId: "grenade" });
    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    const after = unitById(state, 1)!;
    expect(after.tu).toBe(2);
    expect(after.items?.find((it) => it.itemId === "grenade")?.location).toBe("backpack");
  });

  it("is blocked when no such stowed item exists", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { items: [], tu: 60 });
    const state = makeState([unit]);
    const events = applyCommand(state, { type: "retrieveItem", unitId: 1, itemId: "grenade" });
    expect(events).toEqual([{ type: "blocked", reason: "no such item" }]);
  });
});

describe("executeStowItem", () => {
  it("moves a hand item to backpack and deducts floor(maxTu*8/100) TU", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "hand")],
      tu: 60,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, { type: "stowItem", unitId: 1, itemId: "grenade" });
    expect(events).not.toEqual([{ type: "blocked", reason: expect.any(String) }]);
    const after = unitById(state, 1)!;
    const expectedCost = Math.floor((60 * BACKPACK.STOW_TU_PERCENT) / 100);
    expect(expectedCost).toBe(4);
    expect(after.tu).toBe(60 - expectedCost);
    expect(after.items?.find((it) => it.itemId === "grenade")?.location).toBe("backpack");
  });

  it("is blocked with insufficient TU, spending nothing and leaving location unchanged", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "hand")],
      tu: 1,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, { type: "stowItem", unitId: 1, itemId: "grenade" });
    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    const after = unitById(state, 1)!;
    expect(after.tu).toBe(1);
    expect(after.items?.find((it) => it.itemId === "grenade")?.location).toBe("hand");
  });
});

describe("stowed items cannot be used/thrown/primed", () => {
  it("throwItem is blocked on a stowed grenade", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "backpack")],
      tu: 60,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 6, y: 5 },
      itemId: "grenade",
    });
    expect(events).toEqual([{ type: "blocked", reason: "stowed - retrieve first" }]);
    expect(unitById(state, 1)!.tu).toBe(60);
  });

  it("useItem (medkit) is blocked on a stowed medkit", () => {
    const healer = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [medkit(3, "backpack")],
      tu: 60,
    });
    const ally = makeUnit(2, "player", { x: 5, y: 6 }, 0, { hp: 10 });
    const state = makeState([healer, ally]);
    const events = applyCommand(state, {
      type: "useItem",
      unitId: 1,
      targetId: 2,
      itemId: "medkit",
    });
    expect(events).toEqual([{ type: "blocked", reason: "stowed - retrieve first" }]);
  });

  it("primeItem is blocked on a stowed grenade", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "backpack")],
      tu: 60,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, {
      type: "primeItem",
      unitId: 1,
      itemId: "grenade",
      fuseTurns: 1,
    });
    expect(events).toEqual([{ type: "blocked", reason: "stowed - retrieve first" }]);
  });

  it("a hand-carried grenade still throws normally", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, {
      items: [grenade(1, "hand")],
      tu: 60,
    });
    const state = makeState([unit]);
    const events = applyCommand(state, {
      type: "throwItem",
      unitId: 1,
      target: { x: 6, y: 5 },
      itemId: "grenade",
    });
    expect(events.some((e) => e.type === "itemThrown")).toBe(true);
  });
});

describe("campaign/backpack capacity helpers (imported read-only)", () => {
  it("canAddToBackpack refuses a size-2 item into 1 free slot", () => {
    // rocket is size 2 (see ITEM_SIZE); fill to leave exactly 1 slot free.
    const carried = ["grenade", "grenade", "medkit"]; // 3 used, 1 free
    expect(backpackRemainingSlots(carried)).toBe(BACKPACK_SLOTS - 3);
    expect(itemSize("rocket")).toBe(2);
    expect(canAddToBackpack(carried, "rocket")).toBe(false);
  });

  it("canAddToBackpack allows a size-1 item into 1 free slot", () => {
    const carried = ["grenade", "grenade", "medkit"];
    expect(canAddToBackpack(carried, "scanner")).toBe(true);
  });

  it("canAddToBackpack refuses anything once the backpack is full", () => {
    const carried = ["grenade", "grenade", "medkit", "scanner"]; // 4/4
    expect(backpackRemainingSlots(carried)).toBe(0);
    expect(canAddToBackpack(carried, "medkit")).toBe(false);
  });
});
