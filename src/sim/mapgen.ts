/**
 * Block-assembly battlescape generation.
 *
 * Deterministic + PURE: every random choice flows through the single {@link Rng}
 * handed in by {@link createSkirmish}, so `same seed => identical map + spawns`.
 * Nothing here touches three.js / the DOM, and we never call Math.random/Date.
 *
 * Pipeline (see {@link generateMap}):
 *  1. Pick a terrain theme + snap the requested size up to a block grid.
 *  2. Build ONE Grid palette = theme palette + UFO/dropship prefab tiles, and a
 *     matching char->index legend, so theme blocks AND prefabs share indices.
 *  3. Stamp a handcrafted (optionally rotated) theme block into every slot.
 *  4. Stamp the squad DROPSHIP near the south (deployment) edge and the
 *     recoverable UFO somewhere in the northern interior.
 *  5. Carve a guaranteed walkable trunk from the dropship bay to the UFO so the
 *     two are connected, then derive spawns ONLY from the connected component —
 *     which makes every returned spawn mutually reachable by construction.
 */

import type { Grid, TileType, Vec2 } from "./types";
import type { Rng } from "./rng";
import type { Legend, TerrainBlock, TerrainTheme } from "./terrain";
import {
  DROPSHIP_PREFAB,
  GROUND_INDEX,
  UFO_PREFAB,
  appendPrefabTiles,
  blockCell,
  buildLegend,
  getTheme,
  paletteIndexById,
  themeIds,
} from "./terrain";
import { blocksMove, cellIndex, inBounds, makeGrid, setTile, tileTypeAt } from "./grid";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------

/** Side length of every handcrafted theme block (the blocks are 10x10). */
const BLOCK_SIZE = 10;
/** Generated maps are clamped to this range (then snapped up to a block grid). */
const MIN_DIM = 20;
const MAX_DIM = 40;
const DEFAULT_DIM = 30;

/** Fraction of the map height (from the top) scattered enemies may occupy. */
const SCATTER_NORTH_FRACTION = 0.55;
/** Scattered enemies must stand at least this far (chebyshev) from every player. */
const SCATTER_MIN_PLAYER_DIST = 8;
/** Minimum chebyshev spacing between two scattered enemy spawns. */
const SCATTER_SPACING = 3;
/** Open ground reserved around the UFO so themed structures never intersect it. */
const UFO_CLEARANCE = 2;
/** Caps so we always return "enough" spawns without flooding the lists. */
const PLAYER_SPAWN_CAP = 10;
const ENEMY_SPAWN_CAP = 12;
const SCATTER_CAP = 8;

// ---------------------------------------------------------------------------
// Public shape
// ---------------------------------------------------------------------------

/** Axis-aligned tile rectangle (origin + size). */
export interface MapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The full result of generating a battlescape. */
export interface GeneratedMap {
  grid: Grid;
  themeId: string;
  /** Deployment tiles near the dropship (dropship deck first, then its apron). */
  playerSpawns: Vec2[];
  /** A mix of UFO-interior/apron tiles and scattered tiles, all far from players. */
  enemySpawns: Vec2[];
  /** The stamped UFO footprint (contains ufo_hull + ufo_floor tiles). */
  ufo: MapRect;
}

export interface GenerateMapOptions {
  /** Accepted for interface symmetry with createSkirmish; randomness uses `rng`. */
  seed?: number;
  width?: number;
  height?: number;
  themeId?: string;
}

// ---------------------------------------------------------------------------
// Small pure geometry helpers
// ---------------------------------------------------------------------------

/** Chebyshev (king-move) distance between two tiles. */
function cheb(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Squared euclidean distance (cheap, exact integer compare for sorting). */
function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function inRect(rect: MapRect, x: number, y: number): boolean {
  return x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h;
}

function rectsOverlap(a: MapRect, b: MapRect, margin = 0): boolean {
  return (
    a.x - margin < b.x + b.w &&
    a.x + a.w + margin > b.x &&
    a.y - margin < b.y + b.h &&
    a.y + a.h + margin > b.y
  );
}

/** True when (x, y) is in bounds and walkable in the given grid. */
function walkable(grid: Grid, x: number, y: number): boolean {
  return inBounds(grid, x, y) && !blocksMove(grid, x, y);
}

/** Round a requested dimension into [MIN_DIM, MAX_DIM], snapped up to BLOCK_SIZE. */
function snapDim(requested: number | undefined): number {
  const v = requested ?? DEFAULT_DIM;
  const clamped = Math.max(MIN_DIM, Math.min(MAX_DIM, Math.floor(v)));
  const blocks = Math.max(2, Math.ceil(clamped / BLOCK_SIZE));
  return blocks * BLOCK_SIZE;
}

// ---------------------------------------------------------------------------
// Block stamping (with rotation)
// ---------------------------------------------------------------------------

/**
 * Rotate a block clockwise by `turns` quarter-turns (pure). For a square block
 * (all theme blocks are 10x10) dimensions are unchanged; the helper is general
 * so it stays correct if non-square blocks are added later.
 */
function rotateBlock(b: TerrainBlock, turns: number): TerrainBlock {
  const t = ((turns % 4) + 4) % 4;
  let rows = b.rows;
  let w = b.w;
  let h = b.h;
  for (let k = 0; k < t; k++) {
    const next: string[] = [];
    for (let x = 0; x < w; x++) {
      let line = "";
      for (let y = h - 1; y >= 0; y--) {
        line += (rows[y] ?? "").charAt(x);
      }
      next.push(line);
    }
    rows = next;
    const tmp = w;
    w = h;
    h = tmp;
  }
  return { id: `${b.id}@${t}`, w, h, rows };
}

/** Stamp `block` into `grid` at offset (ox, oy); out-of-range cells are skipped. */
function stampBlock(grid: Grid, legend: Legend, block: TerrainBlock, ox: number, oy: number): void {
  for (let ly = 0; ly < block.h; ly++) {
    for (let lx = 0; lx < block.w; lx++) {
      const x = ox + lx;
      const y = oy + ly;
      if (!inBounds(grid, x, y)) continue;
      setTile(grid, x, y, blockCell(block, legend, lx, ly));
    }
  }
}

/** Replace a rectangle plus margin with the theme's dominant open ground. */
function clearToGround(grid: Grid, rect: MapRect, margin: number): void {
  const minX = Math.max(0, rect.x - margin);
  const minY = Math.max(0, rect.y - margin);
  const maxX = Math.min(grid.width, rect.x + rect.w + margin);
  const maxY = Math.min(grid.height, rect.y + rect.h + margin);
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      setTile(grid, x, y, GROUND_INDEX);
    }
  }
}

// ---------------------------------------------------------------------------
// Connectivity
// ---------------------------------------------------------------------------

const ORTHO: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * 4-connected flood fill over walkable tiles from `start`, returning the set of
 * reachable cell indices. 4-connectivity is a safe under-approximation of the
 * 8-connected pathfinder: anything orthogonally reachable is reachable by A*.
 */
function floodFill(grid: Grid, start: Vec2): Set<number> {
  const seen = new Set<number>();
  if (!walkable(grid, start.x, start.y)) return seen;
  const stack: Vec2[] = [start];
  seen.add(cellIndex(grid, start.x, start.y));
  while (stack.length > 0) {
    const cur = stack.pop() as Vec2;
    for (const [dx, dy] of ORTHO) {
      const nx = cur.x + dx;
      const ny = cur.y + dy;
      if (!walkable(grid, nx, ny)) continue;
      const idx = cellIndex(grid, nx, ny);
      if (seen.has(idx)) continue;
      seen.add(idx);
      stack.push({ x: nx, y: ny });
    }
  }
  return seen;
}

/**
 * Carve an L-shaped (orthogonal) corridor from `a` to `b`, converting only the
 * tiles that currently BLOCK movement into `walkIndex`. Tiles that are already
 * walkable keep their themed look, so the corridor is invisible over open ground
 * and only punches road where it must cross an obstacle.
 */
function carveCorridor(grid: Grid, a: Vec2, b: Vec2, walkIndex: number): void {
  let x = a.x;
  let y = a.y;
  const open = (tx: number, ty: number): void => {
    if (inBounds(grid, tx, ty) && blocksMove(grid, tx, ty)) setTile(grid, tx, ty, walkIndex);
  };
  open(x, y);
  while (x !== b.x) {
    x += x < b.x ? 1 : -1;
    open(x, y);
  }
  while (y !== b.y) {
    y += y < b.y ? 1 : -1;
    open(x, y);
  }
}

// ---------------------------------------------------------------------------
// Tile scans
// ---------------------------------------------------------------------------

function firstTileById(grid: Grid, rect: MapRect, id: string): Vec2 | undefined {
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (!inBounds(grid, x, y)) continue;
      if (tileTypeAt(grid, x, y)?.id === id) return { x, y };
    }
  }
  return undefined;
}

function anyWalkableTile(grid: Grid): Vec2 {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (walkable(grid, x, y)) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

// ---------------------------------------------------------------------------
// Spawn collection (all filtered to the connected component `comp`)
// ---------------------------------------------------------------------------

/** Walkable tiles in the ring just outside `rect` that are in `comp`. */
function ringTiles(grid: Grid, rect: MapRect, comp: Set<number>): Vec2[] {
  const out: Vec2[] = [];
  for (let y = rect.y - 1; y <= rect.y + rect.h; y++) {
    for (let x = rect.x - 1; x <= rect.x + rect.w; x++) {
      if (inRect(rect, x, y)) continue;
      if (!walkable(grid, x, y)) continue;
      if (!comp.has(cellIndex(grid, x, y))) continue;
      out.push({ x, y });
    }
  }
  return out;
}

/** Dropship deck tiles first, then the connected apron tiles around the craft. */
function collectPlayerSpawns(grid: Grid, ds: MapRect, comp: Set<number>): Vec2[] {
  const out: Vec2[] = [];
  for (let y = ds.y; y < ds.y + ds.h; y++) {
    for (let x = ds.x; x < ds.x + ds.w; x++) {
      if (!walkable(grid, x, y)) continue;
      if (!comp.has(cellIndex(grid, x, y))) continue;
      if (tileTypeAt(grid, x, y)?.id === "dropship_floor") out.push({ x, y });
    }
  }
  const center: Vec2 = { x: ds.x + ds.w / 2, y: ds.y + ds.h / 2 };
  const ring = ringTiles(grid, ds, comp).sort(
    (a, b) => dist2(a, center) - dist2(b, center) || a.y - b.y || a.x - b.x,
  );
  for (const t of ring) {
    if (out.length >= PLAYER_SPAWN_CAP) break;
    out.push(t);
  }
  return out.slice(0, PLAYER_SPAWN_CAP);
}

/** UFO deck tiles, then its connected apron — all live in the northern interior. */
function collectUfoSpawns(grid: Grid, ufo: MapRect, comp: Set<number>): Vec2[] {
  const out: Vec2[] = [];
  for (let y = ufo.y; y < ufo.y + ufo.h; y++) {
    for (let x = ufo.x; x < ufo.x + ufo.w; x++) {
      if (!walkable(grid, x, y)) continue;
      if (!comp.has(cellIndex(grid, x, y))) continue;
      if (tileTypeAt(grid, x, y)?.id === "ufo_floor") out.push({ x, y });
    }
  }
  out.push(...ringTiles(grid, ufo, comp));
  return out;
}

/** Open, connected tiles in the northern band, spaced out and far from players. */
function collectScatter(
  grid: Grid,
  ufo: MapRect,
  playerSpawns: Vec2[],
  comp: Set<number>,
  rng: Rng,
): Vec2[] {
  const northLimit = Math.floor(grid.height * SCATTER_NORTH_FRACTION);
  const candidates: Vec2[] = [];
  for (let y = 0; y < northLimit; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (!walkable(grid, x, y)) continue;
      if (!comp.has(cellIndex(grid, x, y))) continue;
      if (x >= ufo.x - 1 && x < ufo.x + ufo.w + 1 && y >= ufo.y - 1 && y < ufo.y + ufo.h + 1) {
        continue; // leave the UFO apron to collectUfoSpawns
      }
      if (playerSpawns.some((p) => cheb(p, { x, y }) < SCATTER_MIN_PLAYER_DIST)) continue;
      candidates.push({ x, y });
    }
  }
  rng.shuffle(candidates);
  const chosen: Vec2[] = [];
  for (const c of candidates) {
    if (chosen.some((s) => cheb(s, c) < SCATTER_SPACING)) continue;
    chosen.push(c);
    if (chosen.length >= SCATTER_CAP) break;
  }
  chosen.sort((a, b) => a.y - b.y || a.x - b.x);
  return chosen;
}

// ---------------------------------------------------------------------------
// Cover scatter
// ---------------------------------------------------------------------------

/**
 * Outdoor open ground ids the cover scatter may upgrade into a cover prop.
 * Restricted to natural ground so cover lands in the fighting lanes — beside
 * roads, around structures — and never on the carved road corridor (the trunk
 * that guarantees dropship-to-UFO connectivity), on floors, or inside a
 * structure. Scattered cover is tactical furniture, not a re-skin of walls.
 */
const SCATTER_GROUND_IDS: ReadonlySet<string> = new Set([
  "grass", "soil", "crop", "sand", "pavement",
]);

/** Minimum chebyshev spacing between two cover cluster anchors (no solid walls). */
const COVER_SPACING = 2;
/** Margin around the dropship/UFO rects kept clear of scattered cover. */
const COVER_KEEP_CLEAR = 1;
/** Probability a placed anchor grows a single adjacent buddy (a 2-tile nest). */
const COVER_CLUSTER_CHANCE = 0.2;
/**
 * Fraction of the feature-adjacent candidate pool turned into cover. Kept low so
 * cover never chokes movement: a tactical accent along roads and walls, not a maze.
 */
const COVER_FRACTION = 0.035;
/** Hard caps so density stays tactically meaningful without choking movement. */
const COVER_MIN = 4;
const COVER_MAX = 18;

/** 8-way offsets used to grow a 2-tile cover cluster off a placed anchor. */
const CLUSTER_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
];

/** True when (x, y) borders at least one non-ground feature (road/structure/cover). */
function hasFeatureNeighbor(grid: Grid, x: number, y: number): boolean {
  for (const [dx, dy] of CLUSTER_DIRS) {
    const t = tileTypeAt(grid, x + dx, y + dy);
    if (t && !SCATTER_GROUND_IDS.has(t.id)) return true;
  }
  return false;
}

/**
 * Deterministically scatter half/full cover props (sandbags + low walls) across
 * outdoor open ground. Consumes only `rng` (same seed => identical placements),
 * never overwrites roads, structures, floors, spawns, or the UFO/dropship
 * footprints, and only ever upgrades bare natural ground (cover 0) so no
 * existing cover/wall is lost. Cover is placed only where it borders a feature
 * (a road, structure, or existing cover) — the tactical seams — so open movement
 * lanes stay clear; clusters are spaced at least {@link COVER_SPACING} apart so
 * cover never walls off movement, and the road trunk stays open, keeping the
 * dropship-to-UFO connection intact. Run before the connectivity flood so cover
 * tiles are naturally excluded from the spawn candidates.
 */
function scatterCover(
  grid: Grid,
  palette: TileType[],
  rng: Rng,
  avoid: ReadonlyArray<MapRect>,
): void {
  const halfIdx = paletteIndexById(palette, "sandbags");
  const fullIdx = paletteIndexById(palette, "low_wall");
  if (halfIdx < 0 && fullIdx < 0) return;

  // Choose the cover palette index for the next prop (favour half cover: it is
  // more common and less movement-restricting than a full shoot-over wall).
  const chooseKind = (): number => {
    if (halfIdx < 0) return fullIdx;
    if (fullIdx < 0) return halfIdx;
    return rng.chance(0.7) ? halfIdx : fullIdx;
  };

  // True when (x, y) sits inside any avoid rect expanded by COVER_KEEP_CLEAR.
  const isKeptClear = (x: number, y: number): boolean => {
    for (const r of avoid) {
      if (
        x >= r.x - COVER_KEEP_CLEAR &&
        x < r.x + r.w + COVER_KEEP_CLEAR &&
        y >= r.y - COVER_KEEP_CLEAR &&
        y < r.y + r.h + COVER_KEEP_CLEAR
      ) {
        return true;
      }
    }
    return false;
  };

  // Row-major candidate scan gives a deterministic order before the shuffle.
  const candidates: Vec2[] = [];
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      const tile = tileTypeAt(grid, x, y);
      if (!tile || !SCATTER_GROUND_IDS.has(tile.id)) continue;
      if (isKeptClear(x, y)) continue;
      // Only nest cover against a feature (road / structure / cover) — the
      // tactical seams — so open movement lanes stay clear and clusters read as
      // props beside roads and around buildings, not a uniform grid.
      if (!hasFeatureNeighbor(grid, x, y)) continue;
      candidates.push({ x, y });
    }
  }
  if (candidates.length === 0) return;
  rng.shuffle(candidates);

  const target = Math.max(
    COVER_MIN,
    Math.min(COVER_MAX, Math.round(candidates.length * COVER_FRACTION)),
  );
  const anchors: Vec2[] = [];
  const isCover = (x: number, y: number): boolean => {
    const t = tileTypeAt(grid, x, y);
    return !!t && t.cover > 0;
  };
  const spacedFrom = (p: Vec2, pts: ReadonlyArray<Vec2>): boolean =>
    pts.every((a) => cheb(a, p) >= COVER_SPACING);

  for (const c of candidates) {
    if (anchors.length >= target) break;
    if (isCover(c.x, c.y) || !spacedFrom(c, anchors)) continue;
    const kind = chooseKind();
    setTile(grid, c.x, c.y, kind);
    anchors.push(c);

    // Optionally grow one adjacent buddy to form a small nest. The buddy may
    // sit next to its parent but must stay spaced from every other anchor.
    if (!rng.chance(COVER_CLUSTER_CHANCE)) continue;
    const dirs = [...CLUSTER_DIRS];
    rng.shuffle(dirs);
    for (const [dx, dy] of dirs) {
      const bx = c.x + dx;
      const by = c.y + dy;
      if (!inBounds(grid, bx, by)) continue;
      const bt = tileTypeAt(grid, bx, by);
      if (!bt || !SCATTER_GROUND_IDS.has(bt.id) || isCover(bx, by)) continue;
      if (isKeptClear(bx, by)) continue;
      if (!spacedFrom({ x: bx, y: by }, anchors.slice(0, -1))) continue;
      setTile(grid, bx, by, kind);
      anchors.push({ x: bx, y: by });
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Assemble a themed battlescape from handcrafted blocks plus the dropship and a
 * recoverable UFO, returning the grid and connectivity-valid spawn lists.
 */
export function generateMap(rng: Rng, opts: GenerateMapOptions = {}): GeneratedMap {
  const width = snapDim(opts.width);
  const height = snapDim(opts.height);

  // (a) Theme resolution. An explicit id MUST resolve — an unknown one throws
  //     rather than silently falling through to a random theme (which would also
  //     diverge the rng stream). Only when no id is given do we seed-pick from the
  //     random-eligible pool (special themes excluded).
  const ids = themeIds();
  let theme: TerrainTheme | undefined;
  if (opts.themeId !== undefined) {
    theme = getTheme(opts.themeId);
    if (!theme) {
      throw new Error(`generateMap: unknown terrain theme "${opts.themeId}"`);
    }
  } else {
    theme = getTheme(rng.pick(ids) ?? "farmland") ?? getTheme(ids[0] ?? "farmland");
  }
  if (!theme) throw new Error("no terrain themes available");

  // (b) One palette + legend shared by theme blocks AND prefabs.
  const palette = appendPrefabTiles(theme.palette);
  const legend = buildLegend(palette);
  const grid = makeGrid(width, height, palette, GROUND_INDEX);
  const roadIdx = paletteIndexById(palette, "road");
  const walkIndex = roadIdx >= 0 ? roadIdx : GROUND_INDEX;

  // (c) Stamp a (possibly rotated) theme block into every slot.
  const blocksX = width / BLOCK_SIZE;
  const blocksY = height / BLOCK_SIZE;
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const base = rng.pick(theme.blocks);
      if (!base) continue;
      const block = rotateBlock(base, rng.range(0, 3));
      stampBlock(grid, legend, block, bx * BLOCK_SIZE, by * BLOCK_SIZE);
    }
  }

  // (d) Dropship near the south (deployment) edge.
  const dsW = DROPSHIP_PREFAB.w;
  const dsH = DROPSHIP_PREFAB.h;
  const dsX = rng.range(2, Math.max(2, width - dsW - 2));
  const dsY = Math.max(0, height - dsH - 1);
  const dsRect: MapRect = { x: dsX, y: dsY, w: dsW, h: dsH };
  stampBlock(grid, legend, DROPSHIP_PREFAB, dsX, dsY);

  // (d) UFO in the northern interior, not overlapping the dropship.
  const ufoW = UFO_PREFAB.w;
  const ufoH = UFO_PREFAB.h;
  const minUfoX = UFO_CLEARANCE;
  const maxUfoX = Math.max(minUfoX, width - ufoW - UFO_CLEARANCE);
  const minUfoY = UFO_CLEARANCE;
  const maxUfoY = Math.max(minUfoY, Math.floor(height * 0.5) - ufoH);
  let ufoRect: MapRect = { x: minUfoX, y: minUfoY, w: ufoW, h: ufoH };
  for (let attempt = 0; attempt < 12; attempt++) {
    const ux = rng.range(minUfoX, maxUfoX);
    const uy = rng.range(minUfoY, maxUfoY);
    const candidate: MapRect = { x: ux, y: uy, w: ufoW, h: ufoH };
    if (!rectsOverlap(candidate, dsRect, UFO_CLEARANCE)) {
      ufoRect = candidate;
      break;
    }
    if (attempt === 11) ufoRect = candidate; // bands separate vertically; safe fallback
  }
  clearToGround(grid, ufoRect, UFO_CLEARANCE);
  stampBlock(grid, legend, UFO_PREFAB, ufoRect.x, ufoRect.y);

  // (e) Guarantee connectivity: carve one trunk from the dropship bay to the UFO
  // interior, then derive spawns from the resulting connected component so every
  // returned spawn is mutually reachable by construction.
  const anchor = firstTileById(grid, dsRect, "dropship_floor") ?? anyWalkableTile(grid);
  const ufoInterior = firstTileById(grid, ufoRect, "ufo_floor") ?? { x: ufoRect.x, y: ufoRect.y };
  carveCorridor(grid, anchor, ufoInterior, walkIndex);

  // Scatter deterministic tactical cover (sandbags + low walls) over outdoor
  // open ground — beside the road trunk, around structures — keeping spawns,
  // the corridor, and the UFO/dropship footprints clear. Run before the flood
  // so cover tiles are naturally excluded from the spawn candidates. Cover
  // randomness is branched off the main stream so it never perturbs the downstream
  // unit-setup / combat rolls (same seed => identical cover AND identical battle).
  const coverRng = rng.clone();
  scatterCover(grid, palette, coverRng, [dsRect, ufoRect]);

  const comp = floodFill(grid, anchor);

  const playerSpawns = collectPlayerSpawns(grid, dsRect, comp);
  const ufoSpawns = collectUfoSpawns(grid, ufoRect, comp);
  const scatter = collectScatter(grid, ufoRect, playerSpawns, comp, rng);

  // Interleave UFO defenders with scattered hostiles for a varied first N.
  const playerKeys = new Set(playerSpawns.map((p) => cellIndex(grid, p.x, p.y)));
  const enemySpawns: Vec2[] = [];
  const seenEnemy = new Set<number>();
  const pushEnemy = (t: Vec2 | undefined): void => {
    if (!t || enemySpawns.length >= ENEMY_SPAWN_CAP) return;
    const idx = cellIndex(grid, t.x, t.y);
    if (playerKeys.has(idx) || seenEnemy.has(idx)) return;
    seenEnemy.add(idx);
    enemySpawns.push(t);
  };
  let i = 0;
  let j = 0;
  while ((i < ufoSpawns.length || j < scatter.length) && enemySpawns.length < ENEMY_SPAWN_CAP) {
    pushEnemy(ufoSpawns[i++]);
    pushEnemy(scatter[j++]);
  }

  return { grid, themeId: theme.id, playerSpawns, enemySpawns, ufo: ufoRect };
}
