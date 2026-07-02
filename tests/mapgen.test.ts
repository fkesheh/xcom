import { describe, it, expect } from "vitest";
import { generateMap } from "../src/sim/mapgen";
import type { GeneratedMap } from "../src/sim/mapgen";
import { getTheme, themeIds } from "../src/sim/terrain";
import { Rng } from "../src/sim/rng";
import { blocksMove, cellIndex, inBounds, tileTypeAt } from "../src/sim/grid";
import type { Grid, Vec2 } from "../src/sim/types";

const SEEDS = [1, 2, 3, 12345, 424242, 99999];
const STRUCTURE_IDS = new Set([
  "wall_building",
  "wall_interior",
  "window",
  "door",
  "floor_wood",
  "floor_concrete",
]);

function gen(seed: number, opts: Partial<Parameters<typeof generateMap>[1]> = {}): GeneratedMap {
  return generateMap(new Rng(seed), { width: 30, height: 30, ...opts });
}

/** 4-connected flood of walkable tiles from `start`, returning reachable indices. */
function reachable(grid: Grid, start: Vec2): Set<number> {
  const seen = new Set<number>();
  if (!inBounds(grid, start.x, start.y) || blocksMove(grid, start.x, start.y)) return seen;
  const stack: Vec2[] = [start];
  seen.add(cellIndex(grid, start.x, start.y));
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (stack.length > 0) {
    const cur = stack.pop()!;
    for (const [dx, dy] of dirs) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!inBounds(grid, nx, ny) || blocksMove(grid, nx, ny)) continue;
      const idx = cellIndex(grid, nx, ny);
      if (seen.has(idx)) continue;
      seen.add(idx);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

describe("generateMap", () => {
  it("is deterministic: same seed => identical cells, spawns, ufo, theme", () => {
    for (const seed of SEEDS) {
      const a = gen(seed);
      const b = gen(seed);
      expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));
      expect(a.playerSpawns).toEqual(b.playerSpawns);
      expect(a.enemySpawns).toEqual(b.enemySpawns);
      expect(a.ufo).toEqual(b.ufo);
      expect(a.themeId).toBe(b.themeId);
    }
  });

  it("snaps the size up to a whole block grid", () => {
    const m = gen(1, { width: 24, height: 18 });
    expect(m.grid.width % 10).toBe(0);
    expect(m.grid.height % 10).toBe(0);
    expect(m.grid.width).toBe(30);
    expect(m.grid.height).toBe(20);
  });

  it("honours an explicit theme and falls back to a seeded pick otherwise", () => {
    expect(gen(1, { themeId: "urban" }).themeId).toBe("urban");
    expect(gen(1, { themeId: "desert" }).themeId).toBe("desert");
    for (const seed of SEEDS) {
      expect(["farmland", "urban", "desert"]).toContain(gen(seed).themeId);
    }
  });

  it("resolves the special 'alienBase' theme for every caller, aliasing urban (finding 10)", () => {
    // alienBase is registered so it resolves deterministically for ALL callers.
    expect(getTheme("alienBase")).toBeDefined();
    // It is excluded from the RANDOM-pick pool so a normal mission never rolls it.
    expect(themeIds()).not.toContain("alienBase");
    for (const seed of SEEDS) {
      expect(gen(seed).themeId).not.toBe("alienBase");
    }
    // An explicit alienBase request yields the alienBase-labelled map...
    const alien = gen(12345, { themeId: "alienBase" });
    expect(alien.themeId).toBe("alienBase");
    // ...and aliases the urban layout: same seed => byte-identical grid to urban.
    const urban = gen(12345, { themeId: "urban" });
    expect(alien.grid.cells).toEqual(urban.grid.cells);
    expect(alien.playerSpawns).toEqual(urban.playerSpawns);
    expect(alien.enemySpawns).toEqual(urban.enemySpawns);
  });

  it("throws LOUDLY on an unknown explicit theme instead of a silent random fallback (finding 10)", () => {
    expect(() => gen(1, { themeId: "nonexistent-theme" })).toThrow(/unknown terrain theme/i);
  });

  it("returns walkable, in-bounds, non-overlapping spawns", () => {
    for (const seed of SEEDS) {
      const m = gen(seed);
      expect(m.playerSpawns.length).toBeGreaterThan(0);
      expect(m.enemySpawns.length).toBeGreaterThan(0);

      const seen = new Set<number>();
      for (const s of [...m.playerSpawns, ...m.enemySpawns]) {
        expect(inBounds(m.grid, s.x, s.y)).toBe(true);
        expect(blocksMove(m.grid, s.x, s.y)).toBe(false);
        const idx = cellIndex(m.grid, s.x, s.y);
        expect(seen.has(idx)).toBe(false); // no two spawns share a tile
        seen.add(idx);
      }
    }
  });

  it("stamps a recoverable UFO containing hull and deck tiles", () => {
    for (const seed of SEEDS) {
      const { grid, ufo } = gen(seed);
      const ids = new Set<string>();
      for (let y = ufo.y; y < ufo.y + ufo.h; y++) {
        for (let x = ufo.x; x < ufo.x + ufo.w; x++) {
          const id = tileTypeAt(grid, x, y)?.id;
          if (id) ids.add(id);
        }
      }
      expect(ids.has("ufo_hull")).toBe(true);
      expect(ids.has("ufo_floor")).toBe(true);
    }
  });

  it("keeps a two-tile landing perimeter clear around the UFO", () => {
    for (const themeId of ["farmland", "urban", "desert"]) {
      for (let seed = 1; seed <= 40; seed++) {
        const { grid, ufo } = gen(seed, { width: 20, height: 20, themeId });
        for (let y = Math.max(0, ufo.y - 2); y < Math.min(grid.height, ufo.y + ufo.h + 2); y++) {
          for (let x = Math.max(0, ufo.x - 2); x < Math.min(grid.width, ufo.x + ufo.w + 2); x++) {
            if (x >= ufo.x && x < ufo.x + ufo.w && y >= ufo.y && y < ufo.y + ufo.h) {
              continue;
            }
            expect(
              STRUCTURE_IDS.has(tileTypeAt(grid, x, y)?.id ?? ""),
              `${themeId} seed ${seed} has a structure at ${x},${y} beside the UFO`,
            ).toBe(false);
          }
        }
      }
    }
  });

  it("does not generate water tiles", () => {
    for (const themeId of ["farmland", "urban", "desert"]) {
      for (let seed = 1; seed <= 40; seed++) {
        const { grid } = gen(seed, { themeId });
        for (let y = 0; y < grid.height; y++) {
          for (let x = 0; x < grid.width; x++) {
            expect(
              tileTypeAt(grid, x, y)?.id,
              `${themeId} seed ${seed} has water at ${x},${y}`,
            ).not.toBe("water");
          }
        }
      }
    }
  });

  it("connectivity: a flood-fill from a player spawn reaches every spawn", () => {
    for (const seed of SEEDS) {
      const m = gen(seed);
      const anchor = m.playerSpawns[0]!;
      const comp = reachable(m.grid, anchor);
      for (const s of [...m.playerSpawns, ...m.enemySpawns]) {
        expect(comp.has(cellIndex(m.grid, s.x, s.y))).toBe(true);
      }
    }
  });

  it("keeps the dropship and enemy spawns spatially separated", () => {
    for (const seed of SEEDS) {
      const m = gen(seed);
      for (const p of m.playerSpawns) {
        for (const e of m.enemySpawns) {
          const cheb = Math.max(Math.abs(p.x - e.x), Math.abs(p.y - e.y));
          expect(cheb).toBeGreaterThan(1);
        }
      }
    }
  });
});
