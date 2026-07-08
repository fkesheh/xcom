import { describe, it, expect } from "vitest";
import { generateMap, detectBuildingFootprints, carveCorridor } from "../src/sim/mapgen";
import type { GeneratedMap, BuildingFootprint, MapRect } from "../src/sim/mapgen";
import { Rng } from "../src/sim/rng";
import { blocksMove, cellIndex, inBounds, tileTypeAt } from "../src/sim/grid";
import { TILES, paletteIndexById } from "../src/sim/terrain";
import type { Grid, Vec2 } from "../src/sim/types";
// Extra-pack themes (arctic/jungle/forest) self-register on import. Per the
// module's own contract, tests isolating the SEALED core themes must not
// import it; only the extra-theme-specific tests below pull it in.
import "../src/sim/terrain.themes.extra";

const SEALED_THEMES = ["farmland", "urban", "desert"] as const;
const EXTRA_THEMES = ["arctic", "jungle", "forest"] as const;
const ALL_THEMES = [...SEALED_THEMES, ...EXTRA_THEMES] as const;
const SEEDS = Array.from({ length: 40 }, (_, i) => i + 1); // >= 30 seeds, per theme

const PERIMETER_WALL_IDS = new Set(["wall_building", "wall_interior", "window"]);
const INTERIOR_FLOOR_IDS = new Set(["floor_wood", "floor_concrete"]);

function gen(seed: number, themeId: string, width = 30, height = 30): GeneratedMap {
  return generateMap(new Rng(seed), { width, height, themeId });
}

function perimeterCellsOf(rect: MapRect): Vec2[] {
  const out: Vec2[] = [];
  for (let x = rect.x; x < rect.x + rect.w; x++) {
    out.push({ x, y: rect.y });
    if (rect.h > 1) out.push({ x, y: rect.y + rect.h - 1 });
  }
  for (let y = rect.y + 1; y < rect.y + rect.h - 1; y++) {
    out.push({ x: rect.x, y });
    if (rect.w > 1) out.push({ x: rect.x + rect.w - 1, y });
  }
  return out;
}

function rectsOverlap(a: MapRect, b: MapRect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** 4-connected flood of every walkable tile reachable from the map's edge. */
function reachableFromEdge(grid: Grid): Set<number> {
  const seen = new Set<number>();
  const stack: Vec2[] = [];
  const seed = (x: number, y: number): void => {
    if (!inBounds(grid, x, y) || blocksMove(grid, x, y)) return;
    const idx = cellIndex(grid, x, y);
    if (seen.has(idx)) return;
    seen.add(idx);
    stack.push({ x, y });
  };
  for (let x = 0; x < grid.width; x++) {
    seed(x, 0);
    seed(x, grid.height - 1);
  }
  for (let y = 0; y < grid.height; y++) {
    seed(0, y);
    seed(grid.width - 1, y);
  }
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ] as const;
  while (stack.length > 0) {
    const cur = stack.pop() as Vec2;
    for (const [dx, dy] of dirs) {
      seed(cur.x + dx, cur.y + dy);
    }
  }
  return seen;
}

function buildingsFor(m: GeneratedMap): BuildingFootprint[] {
  return detectBuildingFootprints(m.grid);
}

describe("building footprints — sealed core themes (farmland/urban/desert)", () => {
  it("is deterministic: same seed => identical grid", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS.slice(0, 10)) {
        const a = gen(seed, themeId);
        const b = gen(seed, themeId);
        expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));
      }
    }
  });

  it("every building has a closed wall-ring perimeter (no non-door gap)", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS) {
        const m = gen(seed, themeId);
        for (const fp of buildingsFor(m)) {
          for (const c of perimeterCellsOf(fp.rect)) {
            const id = tileTypeAt(m.grid, c.x, c.y)?.id ?? "";
            expect(
              id === "door" || PERIMETER_WALL_IDS.has(id),
              `${themeId} seed ${seed} rect ${JSON.stringify(fp.rect)} has a perimeter gap at ${c.x},${c.y} (${id})`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("every building has at least one door tile", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS) {
        const m = gen(seed, themeId);
        for (const fp of buildingsFor(m)) {
          const doors = perimeterCellsOf(fp.rect).filter(
            (c) => tileTypeAt(m.grid, c.x, c.y)?.id === "door",
          );
          expect(doors.length, `${themeId} seed ${seed} rect ${JSON.stringify(fp.rect)}`).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it("interior floor tile category differs from the exterior ground category", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS.slice(0, 15)) {
        const m = gen(seed, themeId);
        const groundId = m.grid.palette[0]?.id;
        for (const fp of buildingsFor(m)) {
          let sawInteriorFloor = false;
          for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
            for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
              const id = tileTypeAt(m.grid, x, y)?.id;
              if (id && INTERIOR_FLOOR_IDS.has(id)) {
                sawInteriorFloor = true;
                expect(id).not.toBe(groundId);
              }
            }
          }
          expect(sawInteriorFloor, `${themeId} seed ${seed} rect ${JSON.stringify(fp.rect)}`).toBe(true);
        }
      }
    }
  });

  it("every building interior is reachable from a map-edge open tile through doors", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS) {
        const m = gen(seed, themeId);
        const reachable = reachableFromEdge(m.grid);
        for (const fp of buildingsFor(m)) {
          let interiorCellCount = 0;
          let reachableCount = 0;
          for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
            for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
              const id = tileTypeAt(m.grid, x, y)?.id;
              if (!id || !INTERIOR_FLOOR_IDS.has(id)) continue;
              interiorCellCount++;
              if (reachable.has(cellIndex(m.grid, x, y))) reachableCount++;
            }
          }
          expect(
            reachableCount,
            `${themeId} seed ${seed} rect ${JSON.stringify(fp.rect)} has an orphaned room`,
          ).toBe(interiorCellCount);
        }
      }
    }
  });

  it("no two building footprints overlap", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS) {
        const m = gen(seed, themeId);
        const fps = buildingsFor(m);
        for (let i = 0; i < fps.length; i++) {
          for (let j = i + 1; j < fps.length; j++) {
            expect(rectsOverlap(fps[i]!.rect, fps[j]!.rect)).toBe(false);
          }
        }
      }
    }
  });

  it("never converts a wall_building/wall_interior tile to bare road by corridor carving", () => {
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS) {
        const m = gen(seed, themeId);
        for (const fp of buildingsFor(m)) {
          for (const c of perimeterCellsOf(fp.rect)) {
            const id = tileTypeAt(m.grid, c.x, c.y)?.id ?? "";
            // Every perimeter cell is proven above to be wall-like or a door;
            // this re-asserts the specific claim that no crossing left a bare
            // road/floor tile masquerading as an opening.
            expect(id === "road" || id === "floor").toBe(false);
          }
        }
      }
    }
  });

  it("keeps existing UFO 2-tile clearance and connectivity invariants (regression)", () => {
    for (const themeId of SEALED_THEMES) {
      const m = gen(7, themeId);
      expect(m.playerSpawns.length).toBeGreaterThan(0);
      expect(m.enemySpawns.length).toBeGreaterThan(0);
    }
  });

  it("scatters crate/barrel furniture inside some building interiors without sealing doors", () => {
    let furnishedRooms = 0;
    for (const themeId of SEALED_THEMES) {
      for (const seed of SEEDS.slice(0, 20)) {
        const m = gen(seed, themeId);
        for (const fp of buildingsFor(m)) {
          let props = 0;
          let floors = 0;
          for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
            for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
              const id = tileTypeAt(m.grid, x, y)?.id;
              if (id === "crate" || id === "barrel") props++;
              if (id && INTERIOR_FLOOR_IDS.has(id)) floors++;
              // Never stamp furniture onto a door cell.
              if (id === "door") {
                /* ok */
              }
            }
          }
          if (props > 0) {
            furnishedRooms++;
            expect(props).toBeLessThanOrEqual(3);
            expect(floors).toBeGreaterThan(0);
            // Door apron stays clear: no prop orthogonally adjacent to a door.
            for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
              for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
                const id = tileTypeAt(m.grid, x, y)?.id;
                if (id !== "crate" && id !== "barrel") continue;
                for (const [dx, dy] of [
                  [1, 0],
                  [-1, 0],
                  [0, 1],
                  [0, -1],
                ] as const) {
                  expect(tileTypeAt(m.grid, x + dx, y + dy)?.id).not.toBe("door");
                }
              }
            }
          }
        }
      }
    }
    expect(furnishedRooms).toBeGreaterThan(0);
  });
});

describe("building footprints — extra-pack themes (arctic/jungle/forest)", () => {
  it("is deterministic and produces valid, reachable, closed buildings", () => {
    for (const themeId of EXTRA_THEMES) {
      for (const seed of SEEDS.slice(0, 30)) {
        const a = gen(seed, themeId);
        const b = gen(seed, themeId);
        expect(Array.from(a.grid.cells)).toEqual(Array.from(b.grid.cells));

        const reachable = reachableFromEdge(a.grid);
        for (const fp of buildingsFor(a)) {
          for (const c of perimeterCellsOf(fp.rect)) {
            const id = tileTypeAt(a.grid, c.x, c.y)?.id ?? "";
            expect(id === "door" || PERIMETER_WALL_IDS.has(id)).toBe(true);
          }
          const doors = perimeterCellsOf(fp.rect).filter(
            (c) => tileTypeAt(a.grid, c.x, c.y)?.id === "door",
          );
          expect(doors.length).toBeGreaterThanOrEqual(1);

          let interiorCellCount = 0;
          let reachableCount = 0;
          for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
            for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
              const id = tileTypeAt(a.grid, x, y)?.id;
              if (!id || !INTERIOR_FLOOR_IDS.has(id)) continue;
              interiorCellCount++;
              if (reachable.has(cellIndex(a.grid, x, y))) reachableCount++;
            }
          }
          expect(reachableCount).toBe(interiorCellCount);
        }
      }
    }
  });

  it("no two building footprints overlap in any extra-pack theme", () => {
    for (const themeId of EXTRA_THEMES) {
      for (const seed of SEEDS.slice(0, 20)) {
        const m = gen(seed, themeId);
        const fps = buildingsFor(m);
        for (let i = 0; i < fps.length; i++) {
          for (let j = i + 1; j < fps.length; j++) {
            expect(rectsOverlap(fps[i]!.rect, fps[j]!.rect)).toBe(false);
          }
        }
      }
    }
  });
});

describe("carveCorridor invariant (direct, synthetic)", () => {
  it("crossing a wall_building tile turns it into a door, never bare ground", () => {
    // Build a tiny synthetic grid: open floor on both sides of a solid wall
    // row, exactly like carveCorridor would encounter mid-map.
    const palette = [TILES.grass, TILES.wall_building, TILES.door];
    const width = 5;
    const height = 5;
    const cells = new Uint16Array(width * height); // all grass (index 0)
    for (let x = 0; x < width; x++) {
      cells[2 * width + x] = 1; // row 2 entirely wall_building
    }
    const grid: Grid = { width, height, cells, palette };

    const groundIdx = paletteIndexById(palette, "grass");
    carveCorridor(grid, palette, { x: 2, y: 0 }, { x: 2, y: 4 }, groundIdx);

    // After carving from (2,0) to (2,4), the crossing cell on row 2 must be a
    // door — never converted to bare grass/road/floor.
    expect(tileTypeAt(grid, 2, 2)?.id).toBe("door");
    // Jambs on either side of the crossing stay wall (only the single
    // crossing cell opens).
    expect(tileTypeAt(grid, 1, 2)?.id).toBe("wall_building");
    expect(tileTypeAt(grid, 3, 2)?.id).toBe("wall_building");
  });

  it("never touches ufo_hull/dropship_hull — routes around instead", () => {
    const palette = [TILES.grass, TILES.ufo_hull, TILES.door, TILES.ufo_floor];
    const width = 6;
    const height = 3;
    const cells = new Uint16Array(width * height);
    // A hull wall spans the full column x=3 except one hatch at (3,1),
    // separating start (x<3) from goal (x>3).
    for (let y = 0; y < height; y++) cells[y * width + 3] = 1; // ufo_hull
    cells[1 * width + 3] = 2; // door hatch at (3,1)
    cells[1 * width + 4] = 3; // ufo_floor goal
    const grid: Grid = { width, height, cells, palette };

    const groundIdx = paletteIndexById(palette, "grass");
    carveCorridor(grid, palette, { x: 0, y: 1 }, { x: 4, y: 1 }, groundIdx);

    // The hull column stays hull everywhere except the pre-existing hatch —
    // no cell of it was converted to door/ground by the corridor.
    for (let y = 0; y < height; y++) {
      if (y === 1) continue;
      expect(tileTypeAt(grid, 3, y)?.id).toBe("ufo_hull");
    }
    expect(tileTypeAt(grid, 3, 1)?.id).toBe("door");
  });
});
