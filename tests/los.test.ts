import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import {
  octileBearingRad,
  hasLineOfSight,
  lineOfFire,
  dir8Towards,
  inVisionCone,
  canSee,
  visibleTiles,
  visibleEnemyIds,
} from "../src/sim/los";
import type {
  BattleState,
  Dir8,
  Faction,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

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
      timeUnits: 50,
      health: 30,
      reactions: 30,
      firingAccuracy: 60,
      strength: 30,
    },
    tu: 50,
    hp: 30,
    weaponId: "w",
    ammo: 0,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 45,
    ...overrides,
  };
}

describe("octileBearingRad", () => {
  it("matches atan2 in the grid frame (+y is south)", () => {
    expect(octileBearingRad({ x: 0, y: 0 }, { x: 1, y: 0 })).toBeCloseTo(0);
    expect(octileBearingRad({ x: 0, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(Math.PI / 2);
    expect(octileBearingRad({ x: 0, y: 0 }, { x: 0, y: -1 })).toBeCloseTo(-Math.PI / 2);
  });
});

describe("dir8Towards", () => {
  it("maps cardinal and diagonal directions to the nearest facing", () => {
    const o = { x: 5, y: 5 };
    expect(dir8Towards(o, { x: 5, y: 0 })).toBe(0); // N
    expect(dir8Towards(o, { x: 9, y: 1 })).toBe(1); // NE
    expect(dir8Towards(o, { x: 9, y: 5 })).toBe(2); // E
    expect(dir8Towards(o, { x: 9, y: 9 })).toBe(3); // SE
    expect(dir8Towards(o, { x: 5, y: 9 })).toBe(4); // S
    expect(dir8Towards(o, { x: 1, y: 9 })).toBe(5); // SW
    expect(dir8Towards(o, { x: 0, y: 5 })).toBe(6); // W
    expect(dir8Towards(o, { x: 1, y: 1 })).toBe(7); // NW
  });

  it("returns N (0) when from === to", () => {
    expect(dir8Towards({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe("hasLineOfSight", () => {
  it("is clear across open floor", () => {
    const g = makeGrid(10, 10);
    expect(hasLineOfSight(g, { x: 0, y: 5 }, { x: 9, y: 5 })).toBe(true);
  });

  it("is blocked by an intervening wall", () => {
    const g = makeGrid(10, 10);
    setTile(g, 5, 5, WALL);
    expect(hasLineOfSight(g, { x: 0, y: 5 }, { x: 9, y: 5 })).toBe(false);
  });

  it("is blocked along a diagonal by a wall on the line", () => {
    const g = makeGrid(6, 6);
    setTile(g, 2, 2, WALL);
    expect(hasLineOfSight(g, { x: 0, y: 0 }, { x: 4, y: 4 })).toBe(false);
  });

  it("does not count the from/to tiles themselves as blockers", () => {
    const g = makeGrid(6, 1);
    // Walls sitting on both endpoints; the path between is clear.
    setTile(g, 0, 0, WALL);
    setTile(g, 5, 0, WALL);
    expect(hasLineOfSight(g, { x: 0, y: 0 }, { x: 5, y: 0 })).toBe(true);
  });

  it("is trivially clear from a tile to itself", () => {
    const g = makeGrid(4, 4);
    setTile(g, 1, 1, WALL);
    expect(hasLineOfSight(g, { x: 1, y: 1 }, { x: 1, y: 1 })).toBe(true);
  });

  it("cannot see diagonally through a solid wall corner", () => {
    const g = makeGrid(4, 4);
    // (1,1) is open floor, but the corner the diagonal ray squeezes through is
    // walled on BOTH flanking tiles -- you can't walk it, you can't see it.
    setTile(g, 1, 0, WALL);
    setTile(g, 0, 1, WALL);
    expect(hasLineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(false);
  });

  it("still sees diagonally past a single corner wall (only one side blocks)", () => {
    const g = makeGrid(4, 4);
    setTile(g, 1, 0, WALL); // only one flanking tile of the corner is solid
    expect(hasLineOfSight(g, { x: 0, y: 0 }, { x: 2, y: 2 })).toBe(true);
  });
});

describe("lineOfFire", () => {
  it("returns a direct shot from the shooter's own tile when the line is clear", () => {
    const g = makeGrid(10, 10);
    const result = lineOfFire(g, { x: 1, y: 5 }, { x: 8, y: 5 });
    expect(result.clear).toBe(true);
    expect(result.origin).toEqual({ x: 1, y: 5 });
  });

  it("leans to an open side tile when a full wall sits directly between", () => {
    const g = makeGrid(10, 10);
    // Wall directly between the shooter (2,5) and the target (4,5): the
    // center-to-center line is blocked, but the corner just NE is clear.
    setTile(g, 3, 5, WALL);
    const result = lineOfFire(g, { x: 2, y: 5 }, { x: 4, y: 5 });
    expect(result.clear).toBe(true);
    // Of the equidistant open peeks (3,4)=NE and (3,6)=SE, the lower Dir8
    // index (NE) wins the tie-break.
    expect(result.origin).toEqual({ x: 3, y: 4 });
  });

  it("is not clear when the shooter is boxed in on every open side", () => {
    const g = makeGrid(10, 10);
    // Wall all 8 neighbours of the shooter: no lean tile is available.
    const offsets: ReadonlyArray<readonly [number, number]> = [
      [-1, -1],
      [0, -1],
      [1, -1],
      [-1, 0],
      [1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
    ];
    for (const [dx, dy] of offsets) {
      setTile(g, 5 + dx, 5 + dy, WALL);
    }
    const result = lineOfFire(g, { x: 5, y: 5 }, { x: 5, y: 8 });
    expect(result.clear).toBe(false);
    expect(result.origin).toEqual({ x: 5, y: 5 });
  });
});

describe("inVisionCone", () => {
  it("includes targets within the half-angle and excludes those outside", () => {
    const g = makeGrid(10, 10);
    void g;
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0 /* N */, {
      visionHalfAngleDeg: 45,
    });
    // Directly north: dead centre.
    expect(inVisionCone(unit, { x: 5, y: 0 })).toBe(true);
    // North-east: 45° off, exactly on the boundary -> inside.
    expect(inVisionCone(unit, { x: 9, y: 1 })).toBe(true);
    // Due east: 90° off -> outside a 45° half-angle.
    expect(inVisionCone(unit, { x: 9, y: 5 })).toBe(false);
    // Directly south (behind): outside.
    expect(inVisionCone(unit, { x: 5, y: 9 })).toBe(false);
  });

  it("always sees its own tile regardless of facing", () => {
    const unit = makeUnit(1, "player", { x: 3, y: 3 }, 4 /* S */);
    expect(inVisionCone(unit, { x: 3, y: 3 })).toBe(true);
  });
});

describe("canSee", () => {
  it("sees an unobstructed target in range and arc", () => {
    const g = makeGrid(15, 15);
    const unit = makeUnit(1, "player", { x: 1, y: 7 }, 2 /* E */);
    expect(canSee(g, unit, { x: 10, y: 7 })).toBe(true);
  });

  it("cannot see a target beyond sight range", () => {
    const g = makeGrid(40, 5);
    const unit = makeUnit(1, "player", { x: 0, y: 2 }, 2 /* E */, {
      sightRange: 5,
    });
    expect(canSee(g, unit, { x: 30, y: 2 })).toBe(false);
  });

  it("cannot see a target walled off with no open side to lean past", () => {
    const g = makeGrid(15, 15);
    // A full wall column (not a lone tile) leaves no open angle to peek through.
    for (let y = 0; y < 15; y++) setTile(g, 5, y, WALL);
    const unit = makeUnit(1, "player", { x: 1, y: 7 }, 2 /* E */);
    expect(canSee(g, unit, { x: 10, y: 7 })).toBe(false);
  });

  it("peeks around full cover to see a corner-blocked target in range and arc", () => {
    const g = makeGrid(15, 15);
    // Wall hugged directly between observer (5,7, facing N) and target (5,5).
    // The center line is blocked, but the open side tiles give a clear angle.
    setTile(g, 5, 6, WALL);
    const unit = makeUnit(1, "player", { x: 5, y: 7 }, 0 /* N */);
    // Direct LOS is blocked...
    expect(hasLineOfSight(g, unit.pos, { x: 5, y: 5 })).toBe(false);
    // ...but the target is in range + cone and reachable by leaning aside.
    expect(canSee(g, unit, { x: 5, y: 5 })).toBe(true);
  });

  it("cannot see a target fully walled off even with peeking", () => {
    const g = makeGrid(15, 15);
    // A wall band across the row seals every lean angle to the target.
    for (let x = 3; x <= 7; x++) setTile(g, x, 6, WALL);
    const unit = makeUnit(1, "player", { x: 5, y: 7 }, 0 /* N */);
    expect(canSee(g, unit, { x: 5, y: 5 })).toBe(false);
  });

  it("cannot see a target outside the vision cone", () => {
    const g = makeGrid(15, 15);
    const unit = makeUnit(1, "player", { x: 7, y: 7 }, 0 /* N */, {
      visionHalfAngleDeg: 45,
    });
    expect(canSee(g, unit, { x: 14, y: 7 })).toBe(false); // due east, behind arc
  });

  it("does not see a target directly behind it even with a clear line (leaning never rotates)", () => {
    const g = makeGrid(15, 15);
    const unit = makeUnit(1, "player", { x: 7, y: 7 }, 0 /* N */, {
      visionHalfAngleDeg: 45,
    });
    // Open floor due south: a clear line exists, but it is behind the cone.
    expect(hasLineOfSight(g, unit.pos, { x: 7, y: 12 })).toBe(true);
    expect(canSee(g, unit, { x: 7, y: 12 })).toBe(false);
  });
});

describe("visibleTiles", () => {
  it("always includes the unit's own tile", () => {
    const g = makeGrid(10, 10);
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0);
    const tiles = visibleTiles(g, unit);
    expect(tiles.some((t) => t.x === 5 && t.y === 5)).toBe(true);
  });

  it("never reveals tiles outside the grid and respects walls", () => {
    const g = makeGrid(10, 10);
    // A wall band (not a lone tile) so leaning can't reveal the shadow behind.
    for (let x = 4; x <= 6; x++) setTile(g, x, 3, WALL);
    const unit = makeUnit(1, "player", { x: 5, y: 5 }, 0 /* N */, {
      visionHalfAngleDeg: 60,
      sightRange: 8,
    });
    const tiles = visibleTiles(g, unit);
    for (const t of tiles) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
      expect(t.x).toBeLessThan(10);
      expect(t.y).toBeLessThan(10);
    }
    // A tile directly behind the blocking wall is not revealed.
    expect(tiles.some((t) => t.x === 5 && t.y === 1)).toBe(false);
  });
});

describe("visibleEnemyIds", () => {
  function makeState(units: Unit[]): BattleState {
    return {
      grid: makeGrid(20, 20),
      units,
      weapons: {},
      turn: 1,
      activeFaction: "player",
      rng: new Rng(1234),
      status: "playing",
      explored: new Set<number>(),
      log: [],
    };
  }

  it("collects enemies seen by any living unit of the faction", () => {
    const player = makeUnit(1, "player", { x: 1, y: 10 }, 2 /* E */);
    const enemy = makeUnit(2, "enemy", { x: 10, y: 10 }, 6 /* W */);
    const state = makeState([player, enemy]);
    const seen = visibleEnemyIds(state, "player");
    expect(seen.has(2)).toBe(true);
    expect(seen.size).toBe(1);
  });

  it("returns nothing when the observer faces away from the enemy", () => {
    const player = makeUnit(1, "player", { x: 1, y: 10 }, 6 /* W */);
    const enemy = makeUnit(2, "enemy", { x: 10, y: 10 }, 6 /* W */);
    const state = makeState([player, enemy]);
    expect(visibleEnemyIds(state, "player").size).toBe(0);
  });

  it("ignores dead observers and dead enemies", () => {
    const deadObserver = makeUnit(1, "player", { x: 1, y: 10 }, 2, { alive: false });
    const enemy = makeUnit(2, "enemy", { x: 10, y: 10 }, 6);
    expect(visibleEnemyIds(makeState([deadObserver, enemy]), "player").size).toBe(0);

    const observer = makeUnit(3, "player", { x: 1, y: 10 }, 2);
    const deadEnemy = makeUnit(4, "enemy", { x: 10, y: 10 }, 6, { alive: false });
    expect(visibleEnemyIds(makeState([observer, deadEnemy]), "player").size).toBe(0);
  });

  it("does not see enemies blocked by a wall", () => {
    const player = makeUnit(1, "player", { x: 1, y: 10 }, 2 /* E */);
    const enemy = makeUnit(2, "enemy", { x: 10, y: 10 }, 6 /* W */);
    const state = makeState([player, enemy]);
    // Full wall column: no open angle to lean past and spot the enemy.
    for (let y = 0; y < 20; y++) setTile(state.grid, 5, y, WALL);
    expect(visibleEnemyIds(state, "player").size).toBe(0);
  });
});
