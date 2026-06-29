/**
 * Grid access helpers over the palette-indexed {@link Grid}.
 *
 * The grid stores a palette index per cell (row-major, index = y*width + x).
 * These helpers resolve those indices into terrain properties and provide the
 * out-of-bounds-safe queries the movement / LOS / pathfinding layers rely on.
 *
 * Out-of-bounds policy: queries that gate movement or sight treat OOB as a
 * solid wall (blocksMove / blocksSight => true, moveCost => Infinity) so callers
 * never have to bounds-check before asking.
 */

import type { Grid, TileType } from "./types";

/** Palette index of the default walkable floor. */
export const FLOOR = 0;
/** Palette index of the default solid wall. */
export const WALL = 1;
/** Palette index of low / half cover (walkable but pricier to enter). */
export const LOW_COVER = 2;

/**
 * The tile a destructible cover cell becomes once blown apart: a walkable,
 * sight-transparent pile of debris that grants NO cover but can be moved
 * through (the classic "blow up their cover" outcome). It reuses the "rubble"
 * render category so the renderer draws a low scatter of broken chunks without
 * needing a new visual. Lives here (not in terrain.ts) because writing a
 * "destroyed" cell is a grid-layer mutation concern, and defining it here keeps
 * grid.ts self-contained with no upward import into the content layer.
 */
export const DEBRIS_TILE: TileType = {
  id: "debris",
  label: "Debris",
  render: "rubble",
  blocksMove: false,
  blocksSight: false,
  moveCost: 5,
  cover: 0,
  destructible: false,
};

/**
 * Default tile palette. Cells index into this array.
 *  - 0 floor:     walkable, moveCost 4, no cover, transparent.
 *  - 1 wall:      blocks move + sight, full cover, destructible.
 *  - 2 low cover: walkable (moveCost 6), transparent, half cover, destructible.
 */
export const DEFAULT_PALETTE: TileType[] = [
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
    id: "wall",
    label: "Wall",
    blocksMove: true,
    blocksSight: true,
    moveCost: 0,
    cover: 2,
    destructible: true,
  },
  {
    id: "lowcover",
    label: "Low Cover",
    blocksMove: false,
    blocksSight: false,
    moveCost: 6,
    cover: 1,
    destructible: true,
  },
];

/** Create a grid filled with a single palette index (defaults to floor). */
export function makeGrid(
  width: number,
  height: number,
  palette: TileType[] = DEFAULT_PALETTE,
  fillIndex: number = FLOOR,
): Grid {
  const cells = new Uint16Array(width * height);
  if (fillIndex !== 0) cells.fill(fillIndex);
  return { width, height, cells, palette };
}

/** Row-major cell index: y*width + x. Does not bounds-check. */
export function cellIndex(grid: Grid, x: number, y: number): number {
  return y * grid.width + x;
}

/** True when (x, y) lies inside the grid. */
export function inBounds(grid: Grid, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < grid.width && y < grid.height;
}

/** Resolve the tile type at (x, y), or undefined when out of bounds. */
export function tileTypeAt(grid: Grid, x: number, y: number): TileType | undefined {
  if (!inBounds(grid, x, y)) return undefined;
  const paletteIndex = grid.cells[cellIndex(grid, x, y)];
  if (paletteIndex === undefined) return undefined;
  return grid.palette[paletteIndex];
}

/** Set the palette index at (x, y). No-op when out of bounds. */
export function setTile(grid: Grid, x: number, y: number, paletteIndex: number): void {
  if (!inBounds(grid, x, y)) return;
  grid.cells[cellIndex(grid, x, y)] = paletteIndex;
}

/** Whether a unit is forbidden from entering (x, y). OOB => true. */
export function blocksMove(grid: Grid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return true;
  const tile = tileTypeAt(grid, x, y);
  return tile ? tile.blocksMove : true;
}

/** Whether (x, y) blocks line of sight / fire. OOB => true. */
export function blocksSight(grid: Grid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return true;
  const tile = tileTypeAt(grid, x, y);
  return tile ? tile.blocksSight : true;
}

/** Base TU to enter (x, y). Infinity when blocked / out of bounds. */
export function moveCost(grid: Grid, x: number, y: number): number {
  if (!inBounds(grid, x, y)) return Infinity;
  const tile = tileTypeAt(grid, x, y);
  if (!tile || tile.blocksMove) return Infinity;
  return tile.moveCost;
}

/**
 * Palette index of the debris tile in `palette`, appending {@link DEBRIS_TILE}
 * when no "debris" entry is present. Appending is safe: `cells` indexes into
 * `palette`, so a new trailing entry just becomes a usable cell value. This
 * lets a single blast destroy cover on ANY grid (including the bare
 * DEFAULT_PALETTE test grids) without the palette having to list debris up front.
 */
export function ensureDebrisIndex(palette: TileType[]): number {
  let idx = palette.findIndex((t) => t.id === "debris");
  if (idx < 0) {
    idx = palette.length;
    palette.push(DEBRIS_TILE);
  }
  return idx;
}

/**
 * Destroy the cover at (x, y): swap the cell to a walkable, no-cover debris
 * tile (drawn as a low rubble pile). No-op — and returns false — when the cell
 * is out of bounds, has no cover, or is not destructible (rock, UFO/dropship
 * hulls, plain ground all survive a blast). Returns true when the tile changed.
 */
export function destroyCoverAt(grid: Grid, x: number, y: number): boolean {
  if (!inBounds(grid, x, y)) return false;
  const tile = tileTypeAt(grid, x, y);
  if (!tile || tile.cover <= 0 || !tile.destructible) return false;
  setTile(grid, x, y, ensureDebrisIndex(grid.palette));
  return true;
}
