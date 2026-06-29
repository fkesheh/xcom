import { describe, it, expect } from "vitest";
// Side-effect first: registers arctic/jungle/forest into the live THEMES /
// CHAR_TO_ID registries so generateMap's seeded pick spans all six themes.
import "../src/sim/terrain.themes.extra";
import { EXTRA_TILES, EXTRA_THEMES } from "../src/sim/terrain.themes.extra";
import { generateMap } from "../src/sim/mapgen";
import type { GeneratedMap } from "../src/sim/mapgen";
import { Rng } from "../src/sim/rng";
import { blocksMove, cellIndex, inBounds, tileTypeAt } from "../src/sim/grid";
import { CHAR_TO_ID, THEMES, getTheme, themeIds, validateBlock } from "../src/sim/terrain";
import type { Grid, Vec2 } from "../src/sim/types";

const NEW_THEMES = ["arctic", "jungle", "forest"] as const;
const ALL_THEMES = ["farmland", "urban", "desert", "arctic", "jungle", "forest"] as const;
const SEEDS = [1, 2, 3, 17, 12345, 424242, 99999];

/** Dominant ground tile id each new theme paints at palette index 0. */
const DOMINANT_GROUND: Record<string, string> = {
  arctic: "snow",
  jungle: "jungle_floor",
  forest: "forest_floor",
};

/** A signature tile id each theme introduces that must show up somewhere. */
const SIGNATURE_TILE: Record<string, string> = {
  arctic: "ice_block",
  jungle: "log",
  forest: "clearing",
};

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

describe("extra theme pack registration", () => {
  it("adds the three new theme ids to the live registry", () => {
    const ids = themeIds();
    for (const id of NEW_THEMES) {
      expect(ids).toContain(id);
      expect(getTheme(id)).toBeDefined();
    }
  });

  it("preserves the three sealed core themes unchanged", () => {
    for (const id of ["farmland", "urban", "desert"] as const) {
      expect(getTheme(id)?.id).toBe(id);
    }
  });

  it("appends the four new legend chars and leaves core chars intact", () => {
    expect(CHAR_TO_ID.e).toBe("ice");
    expect(CHAR_TO_ID.I).toBe("ice_block");
    expect(CHAR_TO_ID.l).toBe("log");
    expect(CHAR_TO_ID.o).toBe("clearing");
    // A sample of core chars still resolve to their original tile ids.
    expect(CHAR_TO_ID.T).toBe("tree");
    expect(CHAR_TO_ID["#"]).toBe("wall_building");
    expect(CHAR_TO_ID.g).toBe("grass");
  });

  it("every new-theme block is a valid 10x10 rectangle", () => {
    for (const id of NEW_THEMES) {
      const theme = getTheme(id)!;
      for (const b of theme.blocks) {
        expect(validateBlock(b), `${id}.${b.id} is rectangular`).toBe(true);
        expect(b.w).toBe(10);
        expect(b.h).toBe(10);
      }
    }
  });

  it("each new palette is fronted by walkable, cover-0 dominant ground", () => {
    for (const id of NEW_THEMES) {
      const palette = getTheme(id)!.palette;
      const ground = palette[0];
      expect(ground, `${id} palette[0]`).toBeDefined();
      expect(ground!.id).toBe(DOMINANT_GROUND[id]);
      expect(ground!.blocksMove).toBe(false);
      expect(ground!.cover).toBe(0);
    }
  });

  it("EXTRA_TILES flags follow core conventions (ice_block full, log half)", () => {
    const ice = EXTRA_TILES.ice_block;
    expect(ice.cover).toBe(2);
    expect(ice.blocksMove).toBe(true);
    expect(ice.blocksSight).toBe(true);
    const log = EXTRA_TILES.log;
    expect(log.cover).toBe(1);
    expect(log.blocksMove).toBe(true);
    expect(log.blocksSight).toBe(false);
    // Slippery arctic ground is costlier than ordinary grass (moveCost 4).
    expect(EXTRA_TILES.snow.moveCost).toBeGreaterThan(4);
    expect(EXTRA_TILES.ice.moveCost).toBeGreaterThan(EXTRA_TILES.snow.moveCost);
  });
});

describe("new-theme map generation", () => {
  it.each(NEW_THEMES)("theme %s: explicit themeId is honoured", (themeId) => {
    expect(gen(1, { themeId }).themeId).toBe(themeId);
  });

  it.each(NEW_THEMES)("theme %s: produces cover (cover > 0) tiles", (themeId) => {
    // Across seeds, at least one generated map must carry real cover.
    let anyCover = false;
    for (const seed of SEEDS) {
      const { grid } = gen(seed, { themeId });
      for (let y = 0; y < grid.height && !anyCover; y++) {
        for (let x = 0; x < grid.width && !anyCover; x++) {
          if ((tileTypeAt(grid, x, y)?.cover ?? 0) > 0) anyCover = true;
        }
      }
      if (anyCover) break;
    }
    expect(anyCover).toBe(true);
  });

  it.each(NEW_THEMES)("theme %s: its signature new tile appears on some map", (themeId) => {
    const sig = SIGNATURE_TILE[themeId];
    let placed = false;
    for (const seed of SEEDS) {
      const { grid } = gen(seed, { themeId });
      for (let y = 0; y < grid.height && !placed; y++) {
        for (let x = 0; x < grid.width && !placed; x++) {
          if (tileTypeAt(grid, x, y)?.id === sig) placed = true;
        }
      }
      if (placed) break;
    }
    expect(placed).toBe(true);
  });

  it.each(NEW_THEMES)("theme %s: dominant ground covers most of the map", (themeId) => {
    const ground = DOMINANT_GROUND[themeId];
    for (const seed of SEEDS) {
      const { grid } = gen(seed, { themeId });
      let count = 0;
      for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
          if (tileTypeAt(grid, x, y)?.id === ground) count++;
        }
      }
      // A 30x30 map is 900 cells; the dominant ground must still dominate.
      expect(count, `${themeId} seed ${seed} ground ${ground}`).toBeGreaterThan(300);
    }
  });

  it.each(NEW_THEMES)("theme %s: returns walkable, in-bounds, non-overlapping spawns", (themeId) => {
    for (const seed of SEEDS) {
      const m = gen(seed, { themeId });
      expect(m.playerSpawns.length).toBeGreaterThan(0);
      expect(m.enemySpawns.length).toBeGreaterThan(0);
      const seen = new Set<number>();
      for (const s of [...m.playerSpawns, ...m.enemySpawns]) {
        expect(inBounds(m.grid, s.x, s.y)).toBe(true);
        expect(blocksMove(m.grid, s.x, s.y)).toBe(false);
        const idx = cellIndex(m.grid, s.x, s.y);
        expect(seen.has(idx)).toBe(false);
        seen.add(idx);
      }
    }
  });

  it.each(NEW_THEMES)("theme %s: player spawn connects to the UFO interior", (themeId) => {
    for (const seed of SEEDS) {
      const m = gen(seed, { themeId });
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

  it.each(NEW_THEMES)("theme %s: is deterministic (same seed => identical map)", (themeId) => {
    for (const seed of SEEDS) {
      const a = gen(seed, { themeId });
      const b = gen(seed, { themeId });
      expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));
      expect(a.playerSpawns).toEqual(b.playerSpawns);
      expect(a.enemySpawns).toEqual(b.enemySpawns);
      expect(a.ufo).toEqual(b.ufo);
    }
  });

  it.each(NEW_THEMES)("theme %s: the UFO stamps hull + deck tiles", (themeId) => {
    for (const seed of SEEDS) {
      const { grid, ufo } = gen(seed, { themeId });
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
});

describe("seeded theme pick spans all six themes", () => {
  it("generateMap with no themeId eventually yields every theme id", () => {
    const seen = new Set<string>();
    // Deterministic generator: a wide seed range guarantees every theme is hit
    // (a uniform pick over six themes). 400 draws makes a miss astronomically
    // unlikely and, being deterministic, reproducible if it ever fails.
    for (let seed = 0; seed < 400; seed++) {
      seen.add(gen(seed).themeId);
      if (seen.size === ALL_THEMES.length) break;
    }
    expect([...seen].sort()).toEqual([...ALL_THEMES].sort());
  });

  it("every picked theme is a registered theme", () => {
    const ids = new Set(themeIds());
    for (let seed = 0; seed < 60; seed++) {
      expect(ids.has(gen(seed).themeId)).toBe(true);
    }
  });
});

describe("extra themes object integrity", () => {
  it("EXTRA_THEMES matches the live registry entries", () => {
    for (const id of NEW_THEMES) {
      expect(EXTRA_THEMES[id]).toBe(getTheme(id));
    }
  });

  it("never overwrote a sealed core theme entry", () => {
    // The core three must remain direct property values of THEMES.
    for (const id of ["farmland", "urban", "desert"] as const) {
      expect(Object.prototype.hasOwnProperty.call(THEMES, id)).toBe(true);
      expect(THEMES[id]?.id).toBe(id);
    }
  });
});
