import { describe, it, expect } from "vitest";
import { generateMap } from "../src/sim/mapgen";
import { Rng } from "../src/sim/rng";
import { blocksMove, cellIndex, inBounds, tileTypeAt } from "../src/sim/grid";
import { TILES } from "../src/sim/terrain";
import type { Grid, Vec2 } from "../src/sim/types";

const THEMES = ["farmland", "urban", "desert"] as const;
const SEEDS = [1, 2, 3, 17, 424242, 99999];
/** Tile ids the cover scatter is allowed to place. */
const SCATTER_IDS = new Set(["sandbags", "low_wall"]);

function gen(seed: number, themeId: string) {
  return generateMap(new Rng(seed), { width: 30, height: 30, themeId });
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

describe("cover palette", () => {
  it("sandbags is half cover: blocksMove, transparent, cover 1", () => {
    const t = TILES.sandbags;
    expect(t.cover).toBe(1);
    expect(t.blocksMove).toBe(true);
    expect(t.blocksSight).toBe(false);
    expect(t.destructible).toBe(true);
    expect(t.render).toBe("sandbags");
  });

  it("low_wall is full shoot-over cover: blocksMove, transparent, cover 2", () => {
    const t = TILES.low_wall;
    expect(t.cover).toBe(2);
    expect(t.blocksMove).toBe(true);
    expect(t.blocksSight).toBe(false);
    expect(t.destructible).toBe(true);
    expect(t.render).toBe("low_wall");
  });
});

describe("scattered cover on generated maps", () => {
  it.each(THEMES)("theme %s produces some cover (cover > 0) tiles", (themeId) => {
    let anyCover = false;
    for (const seed of SEEDS) {
      const { grid } = gen(seed, themeId);
      for (let y = 0; y < grid.height && !anyCover; y++) {
        for (let x = 0; x < grid.width && !anyCover; x++) {
          const t = tileTypeAt(grid, x, y);
          if (t && t.cover > 0) anyCover = true;
        }
      }
      if (anyCover) break;
    }
    expect(anyCover).toBe(true);
  });

  it.each(THEMES)("theme %s actually places scattered sandbags/low_wall", (themeId) => {
    let placed = false;
    for (const seed of SEEDS) {
      const { grid } = gen(seed, themeId);
      for (let y = 0; y < grid.height && !placed; y++) {
        for (let x = 0; x < grid.width && !placed; x++) {
          if (SCATTER_IDS.has(tileTypeAt(grid, x, y)?.id ?? "")) placed = true;
        }
      }
      if (placed) break;
    }
    expect(placed).toBe(true);
  });

  it.each(THEMES)(
    "theme %s: every scattered cover tile blocksMove, is transparent, and provides cover",
    (themeId) => {
      for (const seed of SEEDS) {
        const { grid } = gen(seed, themeId);
        for (let y = 0; y < grid.height; y++) {
          for (let x = 0; x < grid.width; x++) {
            const t = tileTypeAt(grid, x, y);
            if (!t || !SCATTER_IDS.has(t.id)) continue;
            expect(t.blocksMove, `${t.id} ${themeId} seed ${seed} at ${x},${y}`).toBe(true);
            expect(t.blocksSight, `${t.id} ${themeId} seed ${seed} at ${x},${y}`).toBe(false);
            expect(t.cover, `${t.id} ${themeId} seed ${seed} at ${x},${y}`).toBeGreaterThan(0);
          }
        }
      }
    },
  );

  it.each(THEMES)("theme %s: scattered cover never lands on a spawn tile", (themeId) => {
    for (const seed of SEEDS) {
      const m = gen(seed, themeId);
      for (const s of [...m.playerSpawns, ...m.enemySpawns]) {
        const id = tileTypeAt(m.grid, s.x, s.y)?.id ?? "";
        expect(SCATTER_IDS.has(id), `${id} on spawn ${themeId} seed ${seed}`).toBe(false);
      }
    }
  });

  it.each(THEMES)("theme %s: scattered cover never lands in the UFO footprint", (themeId) => {
    for (const seed of SEEDS) {
      const { grid, ufo } = gen(seed, themeId);
      for (let y = ufo.y; y < ufo.y + ufo.h; y++) {
        for (let x = ufo.x; x < ufo.x + ufo.w; x++) {
          const id = tileTypeAt(grid, x, y)?.id ?? "";
          expect(SCATTER_IDS.has(id), `${id} in UFO ${themeId} seed ${seed}`).toBe(false);
        }
      }
    }
  });

  it.each(THEMES)("theme %s: cover density stays moderate", (themeId) => {
    for (const seed of SEEDS) {
      const { grid } = gen(seed, themeId);
      let cover = 0;
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          if (SCATTER_IDS.has(tileTypeAt(grid, x, y)?.id ?? "")) cover++;
        }
      }
      const ratio = cover / (grid.width * grid.height);
      expect(ratio, `${themeId} seed ${seed} cover ${(ratio * 100).toFixed(1)}%`).toBeLessThan(0.08);
    }
  });

  it.each(THEMES)("theme %s: cover does not sever dropship-to-UFO connectivity", (themeId) => {
    for (const seed of SEEDS) {
      const m = gen(seed, themeId);
      const anchor = m.playerSpawns[0];
      expect(anchor, `no player spawn ${themeId} seed ${seed}`).toBeDefined();
      const reach = reachable(m.grid, anchor!);
      let ufoReachable = false;
      for (let y = m.ufo.y; y < m.ufo.y + m.ufo.h; y++) {
        for (let x = m.ufo.x; x < m.ufo.x + m.ufo.w; x++) {
          if (tileTypeAt(m.grid, x, y)?.id === "ufo_floor" && reach.has(cellIndex(m.grid, x, y))) {
            ufoReachable = true;
          }
        }
      }
      expect(ufoReachable, `UFO unreachable ${themeId} seed ${seed}`).toBe(true);
    }
  });

  it("mapgen is deterministic: same seed => identical cells (including cover)", () => {
    for (const themeId of THEMES) {
      for (const seed of SEEDS) {
        const a = gen(seed, themeId);
        const b = gen(seed, themeId);
        expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));
        expect(a.playerSpawns).toEqual(b.playerSpawns);
        expect(a.enemySpawns).toEqual(b.enemySpawns);
      }
    }
  });
});
