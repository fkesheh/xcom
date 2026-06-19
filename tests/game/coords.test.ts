import { describe, it, expect } from "vitest";
import {
  tileToWorld,
  worldToTile,
  dir8ToAngleY,
  hpFraction,
  hpColor,
  classifyTile,
  lerp,
} from "../../src/game/coords";
import { createSkirmish, livingUnits } from "../../src/sim/index";
import { blocksMove } from "../../src/sim/grid";
import type { Dir8 } from "../../src/sim/types";

describe("tile <-> world mapping", () => {
  it("places a tile at (gx, 0, gy)", () => {
    expect(tileToWorld(3, 5)).toEqual({ x: 3, y: 0, z: 5 });
    expect(tileToWorld(3, 5, 1.4)).toEqual({ x: 3, y: 1.4, z: 5 });
  });

  it("round-trips through worldToTile", () => {
    for (const [gx, gy] of [
      [0, 0],
      [11, 7],
      [23, 17],
    ] as const) {
      const w = tileToWorld(gx, gy);
      expect(worldToTile(w.x, w.z)).toEqual({ x: gx, y: gy });
    }
  });

  it("snaps jittered world points to the nearest tile", () => {
    expect(worldToTile(2.4, 5.6)).toEqual({ x: 2, y: 6 });
    expect(worldToTile(-0.3, 0.49)).toEqual({ x: 0, y: 0 });
  });
});

describe("dir8ToAngleY", () => {
  const cases: ReadonlyArray<readonly [Dir8, number]> = [
    [0, Math.PI], // N -> world -Z
    [2, Math.PI / 2], // E -> world +X
    [4, 0], // S -> world +Z
    [6, -Math.PI / 2], // W -> world -X
  ];
  it.each(cases.map(([d, a]) => ({ d, a })))(
    "maps dir $d to angle $a",
    ({ d, a }) => {
      expect(dir8ToAngleY(d)).toBeCloseTo(a, 6);
    },
  );

  it("rotating local +Z by the angle yields the dir vector direction", () => {
    // local +Z = (0,0,1) under Ry(θ) -> (sinθ, cosθ) which should match (vx, vy)
    const dir: Dir8 = 1; // NE = (1, -1)
    const θ = dir8ToAngleY(dir);
    expect(Math.sin(θ)).toBeCloseTo(1 / Math.SQRT2, 6);
    expect(Math.cos(θ)).toBeCloseTo(-1 / Math.SQRT2, 6);
  });
});

describe("hp helpers", () => {
  it("clamps the fraction", () => {
    expect(hpFraction(40, 40)).toBe(1);
    expect(hpFraction(0, 40)).toBe(0);
    expect(hpFraction(-5, 40)).toBe(0);
    expect(hpFraction(20, 40)).toBe(0.5);
    expect(hpFraction(5, 0)).toBe(0);
  });

  it("bands colour by fraction", () => {
    expect(hpColor(1)).toBe(0x4ade80);
    expect(hpColor(0.6)).toBe(0x4ade80);
    expect(hpColor(0.45)).toBe(0xfacc15);
    expect(hpColor(0.29)).toBe(0xef4444);
  });
});

describe("classifyTile fog precedence", () => {
  const visible = new Set<number>([1, 2]);
  const explored = new Set<number>([2, 3]);
  it("visible beats explored beats hidden", () => {
    expect(classifyTile(1, visible, explored)).toBe("visible");
    expect(classifyTile(2, visible, explored)).toBe("visible");
    expect(classifyTile(3, visible, explored)).toBe("explored");
    expect(classifyTile(9, visible, explored)).toBe("hidden");
  });
});

describe("lerp", () => {
  it("interpolates endpoints", () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.25)).toBe(2.5);
  });
});

describe("sim contract the renderer relies on", () => {
  it("is deterministic for a fixed seed", () => {
    const a = createSkirmish({ seed: 12345, width: 24, height: 18, players: 4, enemies: 5 });
    const b = createSkirmish({ seed: 12345, width: 24, height: 18, players: 4, enemies: 5 });
    expect(a.units.map((u) => ({ id: u.id, x: u.pos.x, y: u.pos.y }))).toEqual(
      b.units.map((u) => ({ id: u.id, x: u.pos.x, y: u.pos.y })),
    );
  });

  it("spawns the requested squads on a sane map", () => {
    const s = createSkirmish({ seed: 12345, width: 24, height: 18, players: 4, enemies: 5 });
    expect(livingUnits(s, "player")).toHaveLength(4);
    expect(livingUnits(s, "enemy")).toHaveLength(5);
    // The themed generator snaps the requested size up to a whole block grid.
    expect(s.grid.width % 10).toBe(0);
    expect(s.grid.height % 10).toBe(0);
    expect(s.grid.width).toBeGreaterThanOrEqual(24);
    expect(s.grid.height).toBeGreaterThanOrEqual(18);
    // Every spawn tile must be walkable and inside the grid.
    for (const u of s.units) {
      expect(u.pos.x).toBeGreaterThanOrEqual(0);
      expect(u.pos.x).toBeLessThan(s.grid.width);
      expect(u.pos.y).toBeGreaterThanOrEqual(0);
      expect(u.pos.y).toBeLessThan(s.grid.height);
      expect(blocksMove(s.grid, u.pos.x, u.pos.y)).toBe(false);
    }
  });
});
