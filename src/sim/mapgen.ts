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
// Building footprint model
// ---------------------------------------------------------------------------

/** Perimeter materials that legitimately close a room (blocksMove, not a door). */
const PERIMETER_WALL_IDS: ReadonlySet<string> = new Set(["wall_building", "wall_interior", "window"]);
/** Tile ids that identify "this cell belongs to a building" for footprint detection. */
const STRUCTURAL_IDS: ReadonlySet<string> = new Set([
  ...PERIMETER_WALL_IDS,
  "door",
  "floor_wood",
  "floor_concrete",
]);
/** Interior-floor ids: a room needs at least one of these to count as a "building". */
const INTERIOR_FLOOR_IDS: ReadonlySet<string> = new Set(["floor_wood", "floor_concrete"]);

/** A detected building: the tight bounding rect of its walls/floor/door tiles. */
export interface BuildingFootprint {
  rect: MapRect;
}

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
// Building footprint detection, hull-clearance yielding, and perimeter repair
// ---------------------------------------------------------------------------

/**
 * Find every building footprint by scanning block-aligned slots (the same
 * BLOCK_SIZE grid the generator stamps into), reporting the tight bounding
 * rect of {@link STRUCTURAL_IDS} tiles within each slot that contains at
 * least one interior floor tile (i.e. is an actual room, not a bare
 * fence/rubble scatter). Scoping the scan to slots — rather than a global
 * connected-component flood — matters: a building can never legitimately
 * exceed its own slot, but two adjacent full-perimeter buildings (e.g. two
 * `urban_office`s stacked vertically) touch walls at the shared slot edge and
 * WOULD flood-merge into one bogus blob, silently treating one building's
 * interior door — which actually opens into its neighbour's solid wall — as
 * if it were on the merged shape's outer, valid perimeter. Slot-scoping keeps
 * each building's own perimeter/door validation honest. Pure read of grid
 * state, so it doubles as the ground truth for both the generator's repair
 * pass and the test suite.
 */
export function detectBuildingFootprints(grid: Grid, blockSize: number = BLOCK_SIZE): BuildingFootprint[] {
  const out: BuildingFootprint[] = [];
  const blocksX = Math.ceil(grid.width / blockSize);
  const blocksY = Math.ceil(grid.height / blockSize);
  for (let by = 0; by < blocksY; by++) {
    for (let bx = 0; bx < blocksX; bx++) {
      const sx = bx * blockSize;
      const sy = by * blockSize;
      const ex = Math.min(grid.width, sx + blockSize);
      const ey = Math.min(grid.height, sy + blockSize);
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      let hasFloor = false;
      for (let y = sy; y < ey; y++) {
        for (let x = sx; x < ex; x++) {
          const id = tileTypeAt(grid, x, y)?.id;
          if (!id || !STRUCTURAL_IDS.has(id)) continue;
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
          minY = Math.min(minY, y);
          maxY = Math.max(maxY, y);
          if (INTERIOR_FLOOR_IDS.has(id)) hasFloor = true;
        }
      }
      if (hasFloor) {
        out.push({ rect: { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } });
      }
    }
  }
  return out;
}

/**
 * Drop (fully, never partially) any footprint overlapping `rect` expanded by
 * `margin`, converting its whole rect back to open ground first. This is how
 * the UFO/dropship "yield" against buildings: a slot that would be gouged is
 * discarded wholesale rather than left as a gutted half-building.
 */
function clearFootprintsOverlapping(
  grid: Grid,
  footprints: BuildingFootprint[],
  rect: MapRect,
  margin: number,
): BuildingFootprint[] {
  const remaining: BuildingFootprint[] = [];
  for (const fp of footprints) {
    if (rectsOverlap(fp.rect, rect, margin)) {
      for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
        for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
          setTile(grid, x, y, GROUND_INDEX);
        }
      }
    } else {
      remaining.push(fp);
    }
  }
  return remaining;
}

/** True when (x, y) is one of the four corners of `rect`. */
function isCorner(rect: MapRect, x: number, y: number): boolean {
  const atH = x === rect.x || x === rect.x + rect.w - 1;
  const atV = y === rect.y || y === rect.y + rect.h - 1;
  return atH && atV;
}

/** The tile just outside `rect` from perimeter cell (x, y), or undefined for a corner. */
function outwardOf(rect: MapRect, x: number, y: number): Vec2 | undefined {
  if (y === rect.y) return { x, y: y - 1 };
  if (y === rect.y + rect.h - 1) return { x, y: y + 1 };
  if (x === rect.x) return { x: x - 1, y };
  if (x === rect.x + rect.w - 1) return { x: x + 1, y };
  return undefined;
}

/** Every cell on the border ring of `rect` (each cell exactly once). */
function perimeterCells(rect: MapRect): Vec2[] {
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

/**
 * Repair a building's perimeter in place: close any gap that isn't a `door`
 * (rotation/edge interactions should never leave one, but this is the safety
 * net), then guarantee at least one door whose OUTSIDE tile is walkable — a
 * door facing a map edge or another structure's wall is not a usable entrance,
 * so it gets resealed and a fresh one is cut on an open-facing wall.
 */
function repairFootprint(grid: Grid, palette: TileType[], rect: MapRect): void {
  const wallIdx = paletteIndexById(palette, "wall_building");
  const doorIdx = paletteIndexById(palette, "door");
  if (wallIdx < 0 || doorIdx < 0) return;

  const perimeter = perimeterCells(rect);
  for (const c of perimeter) {
    const t = tileTypeAt(grid, c.x, c.y);
    if (t && (t.id === "door" || PERIMETER_WALL_IDS.has(t.id))) continue;
    setTile(grid, c.x, c.y, wallIdx);
  }

  const isValidDoor = (c: Vec2): boolean => {
    const out = outwardOf(rect, c.x, c.y);
    return !!out && inBounds(grid, out.x, out.y) && !blocksMove(grid, out.x, out.y);
  };
  const nonCorner = perimeter.filter((c) => !isCorner(rect, c.x, c.y));
  const doors = nonCorner.filter((c) => tileTypeAt(grid, c.x, c.y)?.id === "door");
  if (doors.some(isValidDoor)) return;

  // Every existing door (if any) is sealed against a wall/edge — reseal it and
  // cut a fresh one wherever the outside is actually open ground.
  for (const d of doors) setTile(grid, d.x, d.y, wallIdx);
  const candidate = nonCorner.find(isValidDoor);
  if (candidate) {
    setTile(grid, candidate.x, candidate.y, doorIdx);
    return;
  }
  // Last resort: boxed in on every side. Force one open and clear its outside
  // tile too, so the room is never left permanently sealed.
  const fallback = nonCorner[0];
  if (!fallback) return;
  setTile(grid, fallback.x, fallback.y, doorIdx);
  const out = outwardOf(rect, fallback.x, fallback.y);
  if (out && inBounds(grid, out.x, out.y)) setTile(grid, out.x, out.y, GROUND_INDEX);
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

/** Per-step cost model for the corridor pathfind: cheap over open ground. */
const CORRIDOR_OPEN_COST = 1;
/** Expensive but crossable: forces the router to prefer detouring around walls. */
const CORRIDOR_WALL_COST = 1000;

/** Dijkstra step cost entering (x, y); hull is impassable (Infinity), forcing a route around. */
function corridorStepCost(grid: Grid, x: number, y: number): number {
  if (!inBounds(grid, x, y)) return Infinity;
  const t = tileTypeAt(grid, x, y);
  if (!t) return Infinity;
  if (t.id === "ufo_hull" || t.id === "dropship_hull") return Infinity;
  return t.blocksMove ? CORRIDOR_WALL_COST : CORRIDOR_OPEN_COST;
}

/** Minimal binary min-heap of (priority, cell index) pairs, keyed by priority. */
class MinHeap {
  private readonly priorities: number[] = [];
  private readonly values: number[] = [];

  get size(): number {
    return this.priorities.length;
  }

  push(priority: number, value: number): void {
    this.priorities.push(priority);
    this.values.push(value);
    let i = this.priorities.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if ((this.priorities[parent] as number) <= (this.priorities[i] as number)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  popMin(): number {
    const top = this.values[0] as number;
    const lastIdx = this.priorities.length - 1;
    this.priorities[0] = this.priorities[lastIdx] as number;
    this.values[0] = this.values[lastIdx] as number;
    this.priorities.pop();
    this.values.pop();
    let i = 0;
    const n = this.priorities.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && (this.priorities[l] as number) < (this.priorities[smallest] as number)) smallest = l;
      if (r < n && (this.priorities[r] as number) < (this.priorities[smallest] as number)) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
    return top;
  }

  private swap(i: number, j: number): void {
    const pi = this.priorities[i] as number;
    const pj = this.priorities[j] as number;
    this.priorities[i] = pj;
    this.priorities[j] = pi;
    const vi = this.values[i] as number;
    const vj = this.values[j] as number;
    this.values[i] = vj;
    this.values[j] = vi;
  }
}

/**
 * Cheapest-path search from `a` to `b` that treats open tiles as cheap, any
 * blocking tile (except hull) as expensive-but-crossable, and hull as an
 * outright wall. Runs a heap-based Dijkstra (O((V+E) log V)) so it stays fast
 * even at the larger map sizes and across the many seeds the test suite
 * exercises. Returns the path (inclusive of both ends), or undefined if `b`
 * is unreachable at any finite cost.
 */
function findCorridorPath(grid: Grid, a: Vec2, b: Vec2): Vec2[] | undefined {
  const n = grid.width * grid.height;
  const dist = new Float64Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(-1);
  const visited = new Uint8Array(n);
  const startIdx = cellIndex(grid, a.x, a.y);
  const goalIdx = cellIndex(grid, b.x, b.y);
  dist[startIdx] = 0;

  const heap = new MinHeap();
  heap.push(0, startIdx);
  while (heap.size > 0) {
    const u = heap.popMin();
    if (visited[u]) continue;
    visited[u] = 1;
    if (u === goalIdx) break;
    const ux = u % grid.width;
    const uy = Math.floor(u / grid.width);
    for (const [dx, dy] of ORTHO) {
      const vx = ux + dx;
      const vy = uy + dy;
      if (!inBounds(grid, vx, vy)) continue;
      const cost = corridorStepCost(grid, vx, vy);
      if (!Number.isFinite(cost)) continue;
      const v = cellIndex(grid, vx, vy);
      if (visited[v]) continue;
      const nd = (dist[u] as number) + cost;
      if (nd < (dist[v] as number)) {
        dist[v] = nd;
        prev[v] = u;
        heap.push(nd, v);
      }
    }
  }

  if (!Number.isFinite(dist[goalIdx] as number)) return undefined;
  const path: Vec2[] = [];
  let cur = goalIdx;
  for (;;) {
    path.push({ x: cur % grid.width, y: Math.floor(cur / grid.width) });
    if (cur === startIdx) break;
    const p = prev[cur] as number;
    if (p < 0) break;
    cur = p;
  }
  path.reverse();
  return path;
}

/**
 * Carve a guaranteed-walkable corridor from `a` to `b` via a cost-weighted
 * path that prefers already-open ground and only crosses a wall when there is
 * no cheaper route around it. A `wall_building`/`wall_interior` crossing
 * becomes a single `door` tile (a legitimate framed opening — neighbouring
 * jamb tiles stay wall since the path only pays the crossing cost once); any
 * other blocker (tree, fence, rock, crate, ...) becomes plain `walkIndex`, as
 * before. `ufo_hull`/`dropship_hull` are never touched — the pathfind treats
 * them as impassable, so it always exits/enters through an existing hatch.
 */
export function carveCorridor(grid: Grid, palette: TileType[], a: Vec2, b: Vec2, walkIndex: number): void {
  const path = findCorridorPath(grid, a, b);
  if (!path) return;
  const doorIdx = paletteIndexById(palette, "door");
  for (const { x, y } of path) {
    const t = tileTypeAt(grid, x, y);
    if (!t || !t.blocksMove) continue;
    if ((t.id === "wall_building" || t.id === "wall_interior") && doorIdx >= 0) {
      setTile(grid, x, y, doorIdx);
    } else {
      setTile(grid, x, y, walkIndex);
    }
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
 * True when (x, y) is orthogonally adjacent to a `door` tile. Cover must never
 * land directly in a doorway's apron — a sandbag/low-wall stamped there would
 * silently reseal a building entrance (or a corridor's wall-crossing) after
 * the repair/carve passes already proved it open.
 */
function hasDoorNeighbor(grid: Grid, x: number, y: number): boolean {
  for (const [dx, dy] of ORTHO) {
    if (tileTypeAt(grid, x + dx, y + dy)?.id === "door") return true;
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
 *
 * `carveCorridor` only converts BLOCKED tiles it crosses (walls -> door, other
 * blockers -> walkIndex); a corridor leg that already ran over open ground
 * (grass/soil/sand/pavement — i.e. exactly {@link SCATTER_GROUND_IDS}) is left
 * as that ground tile, so it is otherwise a legal cover candidate. If such a
 * leg happens to be a single-tile-wide pinch, dropping blocksMove cover on it
 * would sever the very connectivity the corridor guaranteed. Rather than try
 * to special-case every pinch geometrically, this scatters as usual and then
 * verifies `anchor` can still reach `target`; any placement that turns out to
 * be load-bearing gets undone (most recent first) until connectivity holds
 * again. Fully deterministic: no new randomness, just a flood-fill check.
 */
function scatterCover(
  grid: Grid,
  palette: TileType[],
  rng: Rng,
  avoid: ReadonlyArray<MapRect>,
  connectivity: { anchor: Vec2; target: Vec2 },
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
      if (hasDoorNeighbor(grid, x, y)) continue;
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
  const placed: Array<{ x: number; y: number; prevIndex: number }> = [];
  const isCover = (x: number, y: number): boolean => {
    const t = tileTypeAt(grid, x, y);
    return !!t && t.cover > 0;
  };
  const spacedFrom = (p: Vec2, pts: ReadonlyArray<Vec2>): boolean =>
    pts.every((a) => cheb(a, p) >= COVER_SPACING);
  const place = (x: number, y: number, kind: number): void => {
    placed.push({ x, y, prevIndex: grid.cells[cellIndex(grid, x, y)] as number });
    setTile(grid, x, y, kind);
  };

  for (const c of candidates) {
    if (anchors.length >= target) break;
    if (isCover(c.x, c.y) || !spacedFrom(c, anchors)) continue;
    const kind = chooseKind();
    place(c.x, c.y, kind);
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
      if (hasDoorNeighbor(grid, bx, by)) continue;
      if (!spacedFrom({ x: bx, y: by }, anchors.slice(0, -1))) continue;
      place(bx, by, kind);
      anchors.push({ x: bx, y: by });
      break;
    }
  }

  // Safety net: undo the most recently placed cover, one tile at a time,
  // until the dropship anchor can reach the UFO again. Placements are
  // reverted in LIFO order (arbitrary but deterministic) rather than by
  // geometric analysis of which one is "the" pinch — cheap, exact, and immune
  // to future changes in how/where corridors route.
  if (placed.length > 0) {
    const isConnected = (): boolean => {
      const comp = floodFill(grid, connectivity.anchor);
      return comp.has(cellIndex(grid, connectivity.target.x, connectivity.target.y));
    };
    for (let i = placed.length - 1; i >= 0 && !isConnected(); i--) {
      const p = placed[i] as { x: number; y: number; prevIndex: number };
      setTile(grid, p.x, p.y, p.prevIndex);
    }
  }
}

/**
 * Lightly furnish sealed building interiors with crate/barrel props so rooms
 * read as fightable spaces rather than hollow shells. Outdoor scatterCover
 * deliberately skips floors; this is the complementary indoor pass.
 *
 * Rules:
 *  - Only replace interior floor tiles (floor_wood / floor_concrete).
 *  - Never place on a door or orthogonally adjacent to a door (keep entrances open).
 *  - Cap density low (at most ~1 prop per ~6 floor tiles, hard max 3 per room).
 *  - After placement, undo LIFO until every remaining interior floor cell is
 *    reachable from at least one door of that footprint (no orphaned corners).
 */
function scatterInteriorFurniture(
  grid: Grid,
  palette: TileType[],
  rng: Rng,
  footprints: ReadonlyArray<BuildingFootprint>,
): void {
  const crateIdx = paletteIndexById(palette, "crate");
  const barrelIdx = paletteIndexById(palette, "barrel");
  if (crateIdx < 0 && barrelIdx < 0) return;
  const chooseKind = (): number => {
    if (crateIdx < 0) return barrelIdx;
    if (barrelIdx < 0) return crateIdx;
    return rng.chance(0.65) ? crateIdx : barrelIdx;
  };

  for (const fp of footprints) {
    const floors: Vec2[] = [];
    const doors: Vec2[] = [];
    for (let y = fp.rect.y; y < fp.rect.y + fp.rect.h; y++) {
      for (let x = fp.rect.x; x < fp.rect.x + fp.rect.w; x++) {
        const id = tileTypeAt(grid, x, y)?.id;
        if (!id) continue;
        if (INTERIOR_FLOOR_IDS.has(id)) floors.push({ x, y });
        else if (id === "door") doors.push({ x, y });
      }
    }
    if (floors.length === 0 || doors.length === 0) continue;

    const candidates = floors.filter((c) => !hasDoorNeighbor(grid, c.x, c.y));
    if (candidates.length === 0) continue;
    rng.shuffle(candidates);

    const target = Math.min(3, Math.max(0, Math.floor(floors.length / 6)));
    if (target <= 0) continue;

    const placed: Array<{ x: number; y: number; prevIndex: number }> = [];
    for (const c of candidates) {
      if (placed.length >= target) break;
      // Skip if already covered (authored block may already have a crate).
      const cur = tileTypeAt(grid, c.x, c.y);
      if (!cur || !INTERIOR_FLOOR_IDS.has(cur.id)) continue;
      placed.push({ x: c.x, y: c.y, prevIndex: grid.cells[cellIndex(grid, c.x, c.y)] as number });
      setTile(grid, c.x, c.y, chooseKind());
    }

    if (placed.length === 0) continue;

    // Only doors with a walkable OUTSIDE count as entrances — a door sealed
    // against another wall must not "rescue" floors the player can never reach.
    const entrances = doors.filter((d) => {
      const out = outwardOf(fp.rect, d.x, d.y);
      return !!out && walkable(grid, out.x, out.y);
    });
    if (entrances.length === 0) {
      // No usable entrance — undo every prop so we never worsen a sealed room.
      for (let i = placed.length - 1; i >= 0; i--) {
        const p = placed[i] as { x: number; y: number; prevIndex: number };
        setTile(grid, p.x, p.y, p.prevIndex);
      }
      continue;
    }

    // Reachability from usable entrances into every remaining interior floor cell.
    // Sealed (non-entrance) doors are treated as walls so we cannot "cheat"
    // through them into pockets the player can never enter from outside.
    const entranceKeys = new Set(entrances.map((d) => cellIndex(grid, d.x, d.y)));
    const allFloorsReachable = (): boolean => {
      const seen = new Set<number>();
      const stack: Vec2[] = [...entrances];
      for (const d of entrances) seen.add(cellIndex(grid, d.x, d.y));
      while (stack.length > 0) {
        const cur = stack.pop() as Vec2;
        for (const [dx, dy] of ORTHO) {
          const nx = cur.x + dx;
          const ny = cur.y + dy;
          if (!inBounds(grid, nx, ny)) continue;
          if (!walkable(grid, nx, ny)) continue;
          // Stay inside this footprint — don't flood the whole map.
          if (
            nx < fp.rect.x ||
            nx >= fp.rect.x + fp.rect.w ||
            ny < fp.rect.y ||
            ny >= fp.rect.y + fp.rect.h
          ) {
            continue;
          }
          const idx = cellIndex(grid, nx, ny);
          if (seen.has(idx)) continue;
          const id = tileTypeAt(grid, nx, ny)?.id;
          if (id === "door" && !entranceKeys.has(idx)) continue;
          seen.add(idx);
          stack.push({ x: nx, y: ny });
        }
      }
      for (const f of floors) {
        const id = tileTypeAt(grid, f.x, f.y)?.id;
        if (id && INTERIOR_FLOOR_IDS.has(id) && !seen.has(cellIndex(grid, f.x, f.y))) {
          return false;
        }
      }
      return true;
    };

    for (let i = placed.length - 1; i >= 0 && !allFloorsReachable(); i--) {
      const p = placed[i] as { x: number; y: number; prevIndex: number };
      setTile(grid, p.x, p.y, p.prevIndex);
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

  // Each stamped building block lives entirely inside its own block-aligned
  // slot (blocks are exactly BLOCK_SIZE square and slots tile the grid with no
  // overlap or edge-clipping), so buildings can never overlap each other by
  // construction. The only overlap risk is the UFO/dropship landing on top of
  // one, handled below by having the building slot yield.
  let footprints = detectBuildingFootprints(grid);

  // (d) Dropship near the south (deployment) edge.
  const dsW = DROPSHIP_PREFAB.w;
  const dsH = DROPSHIP_PREFAB.h;
  const dsX = rng.range(2, Math.max(2, width - dsW - 2));
  const dsY = Math.max(0, height - dsH - 1);
  const dsRect: MapRect = { x: dsX, y: dsY, w: dsW, h: dsH };
  footprints = clearFootprintsOverlapping(grid, footprints, dsRect, 0);
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
  // A building inside the UFO's clearance ring yields wholesale — never gouged
  // — before the generic clear blanks the ring for trees/fences/etc.
  footprints = clearFootprintsOverlapping(grid, footprints, ufoRect, UFO_CLEARANCE);
  clearToGround(grid, ufoRect, UFO_CLEARANCE);
  stampBlock(grid, legend, UFO_PREFAB, ufoRect.x, ufoRect.y);

  // Repair every surviving building's perimeter: close any gap that isn't a
  // door (rotation should never leave one given the authored blocks, but this
  // is the safety net), and guarantee a door whose outside is walkable.
  for (const fp of footprints) repairFootprint(grid, palette, fp.rect);

  // (e) Guarantee connectivity: carve one trunk from the dropship bay to the UFO
  // interior, then derive spawns from the resulting connected component so every
  // returned spawn is mutually reachable by construction.
  const anchor = firstTileById(grid, dsRect, "dropship_floor") ?? anyWalkableTile(grid);
  const ufoInterior = firstTileById(grid, ufoRect, "ufo_floor") ?? { x: ufoRect.x, y: ufoRect.y };
  carveCorridor(grid, palette, anchor, ufoInterior, walkIndex);

  // Cover / furniture randomness is branched off the main stream so it never
  // perturbs downstream unit-setup / combat rolls. Interior and outdoor each
  // get their OWN clone so outdoor cover placement stays identical to pre-
  // furniture maps (same seed => same outdoor cover AND same battle).
  scatterInteriorFurniture(grid, palette, rng.clone(), footprints);
  scatterCover(grid, palette, rng.clone(), [dsRect, ufoRect], {
    anchor,
    target: ufoInterior,
  });

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
