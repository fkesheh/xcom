import { describe, it, expect } from "vitest";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import { findPath, chebyshev } from "../src/sim/pathfinding";
import { TU_COST } from "../src/sim/types";

describe("chebyshev", () => {
  it("is the king-move distance", () => {
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 0 })).toBe(3);
    expect(chebyshev({ x: 0, y: 0 }, { x: 3, y: 5 })).toBe(5);
    expect(chebyshev({ x: 2, y: 2 }, { x: 2, y: 2 })).toBe(0);
  });
});

describe("findPath", () => {
  it("returns an empty path with zero cost when start === goal", () => {
    const g = makeGrid(5, 5);
    const r = findPath(g, { x: 1, y: 1 }, { x: 1, y: 1 });
    expect(r).toEqual({ path: [], cost: 0 });
  });

  it("walks a straight orthogonal line at base move cost", () => {
    const g = makeGrid(6, 1);
    const r = findPath(g, { x: 0, y: 0 }, { x: 3, y: 0 });
    expect(r).not.toBeNull();
    expect(r!.path).toEqual([
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
    ]);
    expect(r!.cost).toBe(3 * 4);
  });

  it("charges the diagonal multiplier for diagonal steps", () => {
    const g = makeGrid(5, 5);
    const r = findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(r).not.toBeNull();
    expect(r!.path).toEqual([{ x: 1, y: 1 }]);
    expect(r!.cost).toBe(Math.floor(4 * TU_COST.DIAGONAL_MULT)); // 6
  });

  it("routes around a wall (detour) instead of through it", () => {
    const g = makeGrid(5, 5);
    // Vertical wall on column x=2 for rows 0..3, leaving a gap at y=4.
    setTile(g, 2, 0, WALL);
    setTile(g, 2, 1, WALL);
    setTile(g, 2, 2, WALL);
    setTile(g, 2, 3, WALL);
    const r = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 });
    expect(r).not.toBeNull();
    // It must never step onto a wall tile.
    for (const p of r!.path) {
      expect(p).not.toEqual({ x: 2, y: 0 });
      expect(p).not.toEqual({ x: 2, y: 1 });
      expect(p).not.toEqual({ x: 2, y: 2 });
      expect(p).not.toEqual({ x: 2, y: 3 });
    }
    // Last tile is the goal.
    expect(r!.path[r!.path.length - 1]).toEqual({ x: 4, y: 0 });
  });

  it("forbids diagonal corner-cutting around an L of walls", () => {
    const g = makeGrid(3, 3);
    // Block both orthogonal neighbours of the (0,0)->(1,1) diagonal.
    setTile(g, 1, 0, WALL);
    setTile(g, 0, 1, WALL);
    const r = findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 });
    // (0,0) is fully boxed in for the diagonal; the only neighbours are walls,
    // so there is no legal path.
    expect(r).toBeNull();
  });

  it("allows the diagonal when only ONE orthogonal neighbour is open", () => {
    const g = makeGrid(3, 3);
    // Block just one orthogonal neighbour: corner-cutting still forbidden,
    // so the path must go around (right then up), never the bare diagonal.
    setTile(g, 1, 0, WALL);
    const r = findPath(g, { x: 0, y: 0 }, { x: 1, y: 1 });
    expect(r).not.toBeNull();
    // The single diagonal step (cost 6) is illegal here; an orthogonal detour
    // costs more than 6.
    expect(r!.cost).toBeGreaterThan(6);
  });

  it("prunes paths that exceed maxCost", () => {
    const g = makeGrid(10, 1);
    // Straight line of length 5 costs 20 TU; a budget of 10 cannot reach it.
    const tooTight = findPath(g, { x: 0, y: 0 }, { x: 5, y: 0 }, { maxCost: 10 });
    expect(tooTight).toBeNull();
    const enough = findPath(g, { x: 0, y: 0 }, { x: 5, y: 0 }, { maxCost: 20 });
    expect(enough).not.toBeNull();
    expect(enough!.cost).toBe(20);
  });

  it("treats isBlocked tiles as impassable but keeps the goal reachable", () => {
    const g = makeGrid(5, 1);
    // Block (2,0) — the only orthogonal path on a 1-row grid must reroute,
    // but a 1-row grid has no detour, so it is unreachable.
    const blockedMid = findPath(g, { x: 0, y: 0 }, { x: 4, y: 0 }, {
      isBlocked: (x, y) => x === 2 && y === 0,
    });
    expect(blockedMid).toBeNull();

    // The goal itself may be flagged blocked (occupied) yet remain reachable.
    const g2 = makeGrid(5, 1);
    const blockedGoal = findPath(g2, { x: 0, y: 0 }, { x: 3, y: 0 }, {
      isBlocked: (x, y) => x === 3 && y === 0,
    });
    expect(blockedGoal).not.toBeNull();
    expect(blockedGoal!.path[blockedGoal!.path.length - 1]).toEqual({ x: 3, y: 0 });
  });

  it("routes around a unit-blocked tile when a detour exists", () => {
    const g = makeGrid(5, 5);
    const r = findPath(g, { x: 0, y: 2 }, { x: 4, y: 2 }, {
      isBlocked: (x, y) => x === 2 && y === 2,
    });
    expect(r).not.toBeNull();
    for (const p of r!.path) {
      expect(p).not.toEqual({ x: 2, y: 2 });
    }
  });

  it("returns null when start or goal is out of bounds", () => {
    const g = makeGrid(3, 3);
    expect(findPath(g, { x: -1, y: 0 }, { x: 1, y: 1 })).toBeNull();
    expect(findPath(g, { x: 0, y: 0 }, { x: 9, y: 9 })).toBeNull();
  });

  it("returns null when the goal is a wall", () => {
    const g = makeGrid(3, 3);
    setTile(g, 2, 2, WALL);
    expect(findPath(g, { x: 0, y: 0 }, { x: 2, y: 2 })).toBeNull();
  });

  it("is deterministic across repeated runs", () => {
    const build = () => {
      const g = makeGrid(7, 7);
      setTile(g, 3, 0, WALL);
      setTile(g, 3, 1, WALL);
      setTile(g, 3, 2, WALL);
      setTile(g, 3, 3, WALL);
      return g;
    };
    const a = findPath(build(), { x: 0, y: 0 }, { x: 6, y: 6 });
    const b = findPath(build(), { x: 0, y: 0 }, { x: 6, y: 6 });
    expect(a).toEqual(b);
  });
});
