import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile } from "../src/sim/grid";
import { coverDefenseFor, previewShot, resolveShot } from "../src/sim/combat";
import { applyCommand, executeMove } from "../src/sim/battle";
import type {
  BattleState,
  Dir8,
  Faction,
  TileType,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "../src/sim/types";

// Test palette: a walkable floor plus two "hedge" cover tiles that block
// movement but can be fired over (blocksSight=false), matching the cover-tile
// contract in types.ts. This lets cover affect hit odds without breaking LoF.
const FLOOR = 0;
const HEDGE_FULL = 1;
const HEDGE_HALF = 2;

const PALETTE: TileType[] = [
  {
    id: "floor",
    label: "Floor",
    blocksMove: false,
    blocksSight: false,
    moveCost: 4,
    cover: 0,
    destructible: false,
  },
  {
    id: "hedge_full",
    label: "Full Hedge",
    blocksMove: true,
    blocksSight: false,
    moveCost: 0,
    cover: 2,
    destructible: true,
  },
  {
    id: "hedge_half",
    label: "Half Hedge",
    blocksMove: true,
    blocksSight: false,
    moveCost: 0,
    cover: 1,
    destructible: true,
  },
];

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
    templateId: "t",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 30,
      reactions: 30,
      firingAccuracy: 60,
      strength: 30,
    },
    tu: 60,
    hp: 30,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 45,
    ...overrides,
  };
}

function makeWeapon(overrides: Partial<Weapon> = {}): Weapon {
  return {
    id: "rifle",
    name: "Rifle",
    damage: 20,
    range: 15,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 35, shots: 3 },
    ],
    ...overrides,
  };
}

function makeState(units: Unit[], weapon: Weapon = makeWeapon(), seed = 1234): BattleState {
  return {
    grid: makeGrid(30, 30, PALETTE),
    units,
    weapons: { [weapon.id]: weapon },
    turn: 1,
    activeFaction: "player",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

describe("coverDefenseFor", () => {
  it("returns 0 in the open (no cover between defender and shooter)", () => {
    const grid = makeGrid(30, 30, PALETTE);
    // defender (5,5), shooter due east at (9,5): facing neighbor (6,5) is floor.
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 })).toBe(0);
  });

  it("returns the facing tile's cover value toward the shooter", () => {
    const grid = makeGrid(30, 30, PALETTE);
    setTile(grid, 6, 5, HEDGE_FULL); // between defender (5,5) and shooter (9,5)
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 })).toBe(2);
    setTile(grid, 6, 5, HEDGE_HALF);
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 })).toBe(1);
  });

  it("ignores cover on the side away from the shooter", () => {
    const grid = makeGrid(30, 30, PALETTE);
    setTile(grid, 4, 5, HEDGE_FULL); // west of defender; shooter is east
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 })).toBe(0);
  });

  it("takes the max cover across both cardinal neighbors for a diagonal shooter", () => {
    const grid = makeGrid(30, 30, PALETTE);
    // defender (5,5), shooter SE at (9,9): cardinal neighbors (6,5) and (5,6).
    setTile(grid, 6, 5, HEDGE_FULL); // cover 2 along x
    setTile(grid, 5, 6, HEDGE_HALF); // cover 1 along y
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 9 })).toBe(2);

    // Swap: the higher cover is now on the y-axis neighbor; still the max (2).
    setTile(grid, 6, 5, HEDGE_HALF);
    setTile(grid, 5, 6, HEDGE_FULL);
    expect(coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 9 })).toBe(2);

    // Neither neighbor has cover => 0 even though a far tile does.
    const open = makeGrid(30, 30, PALETTE);
    setTile(open, 7, 7, HEDGE_FULL); // not a facing neighbor
    expect(coverDefenseFor(open, { x: 5, y: 5 }, { x: 9, y: 9 })).toBe(0);
  });

  it("is pure: identical inputs yield identical output and no rng is touched", () => {
    const grid = makeGrid(30, 30, PALETTE);
    setTile(grid, 6, 5, HEDGE_FULL);
    const a = coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 });
    const b = coverDefenseFor(grid, { x: 5, y: 5 }, { x: 9, y: 5 });
    expect(a).toBe(2);
    expect(b).toBe(a);
  });
});

describe("cover + stance in previewShot", () => {
  it("a target behind full cover is harder to hit than one in the open", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);

    const open = makeState([shooter, target]);
    const openPreview = previewShot(open, shooter, target.pos, "snap");

    const covered = makeState([shooter, target]);
    setTile(covered.grid, 5, 5, HEDGE_FULL); // adjacent to target, toward shooter
    const coveredPreview = previewShot(covered, shooter, target.pos, "snap");

    expect(openPreview.possible).toBe(true);
    expect(coveredPreview.possible).toBe(true); // hedge is shoot-over (blocksSight=false)
    expect(coveredPreview.hitChance).toBeLessThan(openPreview.hitChance);
  });

  it("half cover hurts less than full cover (monotonic in cover value)", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);

    const open = makeState([shooter, target]);
    const half = makeState([shooter, target]);
    setTile(half.grid, 5, 5, HEDGE_HALF);
    const full = makeState([shooter, target]);
    setTile(full.grid, 5, 5, HEDGE_FULL);

    const o = previewShot(open, shooter, target.pos, "snap").hitChance;
    const h = previewShot(half, shooter, target.pos, "snap").hitChance;
    const f = previewShot(full, shooter, target.pos, "snap").hitChance;
    expect(o).toBeGreaterThan(h);
    expect(h).toBeGreaterThan(f);
  });

  it("a kneeling firer has higher hitChance than a standing one", () => {
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const standing = makeUnit(1, "enemy", { x: 1, y: 5 }, 2, { stance: "stand" });
    const kneeling = makeUnit(3, "enemy", { x: 1, y: 5 }, 2, { stance: "kneel" });

    const sPreview = previewShot(makeState([standing, target]), standing, target.pos, "snap");
    const kPreview = previewShot(makeState([kneeling, target]), kneeling, target.pos, "snap");

    expect(sPreview.possible).toBe(true);
    expect(kPreview.possible).toBe(true);
    expect(kPreview.hitChance).toBeGreaterThan(sPreview.hitChance);
  });

  it("a kneeling target has lower hitChance against than a standing one", () => {
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2);
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6);
    const state = makeState([shooter, target]);

    const standingPreview = previewShot(state, shooter, target.pos, "snap");
    target.stance = "kneel";
    const kneelingPreview = previewShot(state, shooter, target.pos, "snap");

    expect(kneelingPreview.hitChance).toBeLessThan(standingPreview.hitChance);
  });

  it("preview and resolve agree: sampled hit rate tracks the defended odds", () => {
    // Full cover + kneeling target + a strong firer: the dice must match the HUD.
    const shooter = makeUnit(1, "enemy", { x: 1, y: 5 }, 2, {
      stats: { timeUnits: 60, health: 30, reactions: 30, firingAccuracy: 100, strength: 30 },
      ammo: 9_999,
    });
    const target = makeUnit(2, "player", { x: 6, y: 5 }, 6, {
      hp: 1_000_000,
      stance: "kneel",
    });
    const state = makeState([shooter, target], makeWeapon(), 4321);
    setTile(state.grid, 5, 5, HEDGE_FULL);

    const preview = previewShot(state, shooter, target.pos, "snap");
    expect(preview.possible).toBe(true);
    expect(preview.hitChance).toBeLessThan(0.99); // defense actually bites

    const N = 4000;
    let hits = 0;
    for (let i = 0; i < N; i++) {
      if (resolveShot(state, shooter, target.pos, "snap").rounds[0]!.hit) hits++;
    }
    const frac = hits / N;
    expect(Math.abs(frac - preview.hitChance)).toBeLessThan(0.03);
  });
});

describe("setStance command", () => {
  it("spends TU and emits a stanceChanged event", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const state = makeState([unit]);

    const events = applyCommand(state, { type: "setStance", unitId: 1, stance: "kneel" });

    expect(events).toEqual([
      { type: "stanceChanged", unitId: 1, stance: "kneel", tuLeft: 56 },
    ]);
    expect(unit.stance).toBe("kneel");
    expect(unit.tu).toBe(56);
  });

  it("is blocked when TU is insufficient (no state change)", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 2, { tu: 3 });
    const state = makeState([unit]);

    const events = applyCommand(state, { type: "setStance", unitId: 1, stance: "kneel" });

    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    expect(unit.stance).toBeUndefined();
    expect(unit.tu).toBe(3);
  });

  it("can toggle stand <-> kneel, paying TU each time", () => {
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 2);
    const state = makeState([unit]);

    applyCommand(state, { type: "setStance", unitId: 1, stance: "kneel" });
    const events = applyCommand(state, { type: "setStance", unitId: 1, stance: "stand" });

    expect(events[0]).toMatchObject({ type: "stanceChanged", stance: "stand" });
    expect(unit.stance).toBe("stand");
    expect(unit.tu).toBe(52); // 60 - TOGGLE_TU - TOGGLE_TU
  });
});

describe("kneeling movement cost", () => {
  it("a kneeling step costs more TU than a standing step (same tile)", () => {
    const standUnit = makeUnit(1, "player", { x: 5, y: 5 }, 2, { stance: "stand" });
    const kneelUnit = makeUnit(2, "player", { x: 5, y: 5 }, 2, { stance: "kneel" });

    const standState = makeState([standUnit]);
    const kneelState = makeState([kneelUnit]);

    const standEvents = executeMove(standState, 1, { x: 6, y: 5 });
    const kneelEvents = executeMove(kneelState, 2, { x: 6, y: 5 });

    expect(standEvents.some((e) => e.type === "moveStep")).toBe(true);
    expect(kneelEvents.some((e) => e.type === "moveStep")).toBe(true);

    // Floor moveCost 4; kneeling: floor(4 * 1.5) = 6 > 4.
    expect(60 - standUnit.tu).toBe(4);
    expect(60 - kneelUnit.tu).toBe(6);
    expect(60 - kneelUnit.tu).toBeGreaterThan(60 - standUnit.tu);
  });
});
