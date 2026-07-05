import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { applyCommand, unitById } from "../src/sim/battle";
import { findPath } from "../src/sim/pathfinding";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { MORALE, STANCE, TU_COST } from "../src/sim/types";
import type { BattleState, Dir8, Faction, Unit, UnitId, Vec2 } from "../src/sim/types";

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
      timeUnits: 100,
      health: 40,
      reactions: 40,
      firingAccuracy: 60,
      strength: 30,
      bravery: 50,
    },
    tu: 100,
    hp: 40,
    morale: MORALE.MAX,
    items: [],
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    stance: "stand",
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

const FLOOR_MOVE_COST = 4; // src/sim/grid.ts DEFAULT_PALETTE floor tile.

describe("kneel-move surcharge: per-tile cost", () => {
  it("standing orthogonal step costs the base move cost, unchanged", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "stand", tu: 100 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 5 } });
    expect(unitById(state, 1)!.tu).toBe(100 - FLOOR_MOVE_COST);
  });

  it("kneeling orthogonal step costs floor(base * KNEEL_MOVE_MULT)", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "kneel", tu: 100 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 5 } });
    const expectedCost = Math.floor(FLOOR_MOVE_COST * STANCE.KNEEL_MOVE_MULT);
    expect(expectedCost).toBe(6);
    expect(unitById(state, 1)!.tu).toBe(100 - expectedCost);
  });

  it("kneeling diagonal step combines DIAGONAL_MULT and KNEEL_MOVE_MULT before flooring", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "kneel", tu: 100 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 6 } });
    const expectedCost = Math.floor(
      FLOOR_MOVE_COST * TU_COST.DIAGONAL_MULT * STANCE.KNEEL_MOVE_MULT,
    );
    expect(expectedCost).toBe(9);
    expect(unitById(state, 1)!.tu).toBe(100 - expectedCost);
  });

  it("standing diagonal step is byte-for-byte unchanged from before the surcharge", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "stand", tu: 100 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 6 } });
    const expectedCost = Math.floor(FLOOR_MOVE_COST * TU_COST.DIAGONAL_MULT);
    expect(unitById(state, 1)!.tu).toBe(100 - expectedCost);
  });
});

describe("kneel-move surcharge: preview/pathfinding parity with executeMove", () => {
  it("findPath's stance-scaled cost equals what executeMove actually spends over the same path", () => {
    const goal: Vec2 = { x: 8, y: 5 }; // 3 orthogonal steps from (5,5).
    const start: Vec2 = { x: 5, y: 5 };

    const preview = findPath(makeGrid(30, 30), start, goal, {
      stanceMult: STANCE.KNEEL_MOVE_MULT,
    });
    expect(preview).not.toBeNull();

    const unit = makeUnit(1, "player", start, 0, { stance: "kneel", tu: 100 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: goal });
    const spent = 100 - unitById(state, 1)!.tu;

    expect(preview!.cost).toBe(spent);
    expect(preview!.cost).toBe(3 * Math.floor(FLOOR_MOVE_COST * STANCE.KNEEL_MOVE_MULT));
  });

  it("route selection is unchanged by stanceMult (same path, only cost scales)", () => {
    const goal: Vec2 = { x: 8, y: 8 };
    const start: Vec2 = { x: 5, y: 5 };
    const standing = findPath(makeGrid(30, 30), start, goal, { stanceMult: 1 });
    const kneeling = findPath(makeGrid(30, 30), start, goal, {
      stanceMult: STANCE.KNEEL_MOVE_MULT,
    });
    expect(standing).not.toBeNull();
    expect(kneeling).not.toBeNull();
    expect(kneeling!.path).toEqual(standing!.path);
    expect(kneeling!.cost).toBeGreaterThan(standing!.cost);
  });

  it("defaults to stanceMult 1 (standing) when omitted, matching pre-surcharge behavior", () => {
    const goal: Vec2 = { x: 7, y: 5 };
    const start: Vec2 = { x: 5, y: 5 };
    const result = findPath(makeGrid(30, 30), start, goal);
    expect(result!.cost).toBe(2 * FLOOR_MOVE_COST);
  });
});

describe("kneel-move surcharge: truncated walk when TU runs out", () => {
  it("a kneeling unit stops at the correct tile when TU runs out mid-path", () => {
    // Each kneeling orthogonal step costs 6 TU; with 14 TU the unit can afford
    // exactly 2 steps (12 TU) and must stop short of a 3rd (would need 18 total).
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "kneel", tu: 14 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 9, y: 5 } });
    const after = unitById(state, 1)!;
    expect(after.pos).toEqual({ x: 7, y: 5 });
    expect(after.tu).toBe(14 - 2 * 6);
  });

  it("the same TU budget lets a standing unit walk further (surcharge makes kneeling stop earlier)", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0, { stance: "stand", tu: 14 });
    const state = makeState([unit]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 9, y: 5 } });
    const after = unitById(state, 1)!;
    // Standing costs 4/tile: 3 steps = 12 TU, affordable; a 4th would need 16 > 14.
    expect(after.pos).toEqual({ x: 8, y: 5 });
    expect(after.tu).toBe(14 - 3 * 4);
  });

  it("the preview truncates to the same reachable tile the kneeling unit actually reaches", () => {
    const start: Vec2 = { x: 5, y: 5 };
    const budget = 14;
    const result = findPath(makeGrid(30, 30), start, { x: 9, y: 5 }, {
      stanceMult: STANCE.KNEEL_MOVE_MULT,
    });
    expect(result).not.toBeNull();
    let spent = 0;
    let reached = start;
    for (const step of result!.path) {
      const stepCost = Math.floor(FLOOR_MOVE_COST * STANCE.KNEEL_MOVE_MULT);
      if (spent + stepCost > budget) break;
      spent += stepCost;
      reached = step;
    }
    expect(reached).toEqual({ x: 7, y: 5 });
  });
});
