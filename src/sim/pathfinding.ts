/**
 * A* pathfinding on the 8-connected battle grid, with Time Units as edge cost.
 *
 * Determinism: the open set is a binary min-heap keyed by f-cost and then by a
 * monotonically increasing insertion sequence, so equal-cost frontiers are
 * always expanded in the same order. No reliance on Map/object iteration order.
 */

import type { Grid, Vec2 } from "./types";
import { TU_COST } from "./types";
import { inBounds, blocksMove, moveCost } from "./grid";

export interface PathResult {
  /** Tiles to walk, EXCLUDING the start and INCLUDING the goal. */
  path: Vec2[];
  /** Total TU cost of the path (integer). */
  cost: number;
}

interface FindPathOptions {
  /** Prune any node whose g-cost would exceed this (TU budget). */
  maxCost?: number;
  /** Mark tiles occupied by other units as impassable. The goal is exempt. */
  isBlocked?: (x: number, y: number) => boolean;
  /**
   * Uniform per-step TU multiplier (e.g. a kneeling unit's
   * `STANCE.KNEEL_MOVE_MULT` surcharge — see battle.ts `executeMove`), applied
   * after the diagonal multiplier and floored, mirroring the executor's cost
   * model so a previewed path's reported `cost` matches what actually gets
   * spent. Defaults to 1 (no surcharge). Uniform across all steps, so route
   * selection is unchanged — only the reported cost scales.
   */
  stanceMult?: number;
}

/** Chebyshev (8-direction / king-move) distance — the A* heuristic basis. */
export function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

interface HeapEntry {
  idx: number;
  f: number;
  seq: number;
}

/** Binary min-heap ordered by (f, seq) for deterministic tie-breaking. */
class MinHeap {
  private readonly items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: HeapEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.less(items[i]!, items[parent]!)) {
        this.swap(i, parent);
        i = parent;
      } else {
        break;
      }
    }
  }

  pop(): HeapEntry | undefined {
    const items = this.items;
    const top = items[0];
    if (top === undefined) return undefined;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftDown(start: number): void {
    const items = this.items;
    const n = items.length;
    let i = start;
    for (;;) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.less(items[left]!, items[smallest]!)) smallest = left;
      if (right < n && this.less(items[right]!, items[smallest]!)) smallest = right;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private less(a: HeapEntry, b: HeapEntry): boolean {
    if (a.f !== b.f) return a.f < b.f;
    return a.seq < b.seq;
  }

  private swap(i: number, j: number): void {
    const items = this.items;
    const tmp = items[i]!;
    items[i] = items[j]!;
    items[j] = tmp;
  }
}

/**
 * Find the cheapest 8-connected path from `start` to `goal` in Time Units.
 *
 * Movement rules:
 *  - Orthogonal entry costs moveCost(dest); diagonal entry costs
 *    floor(moveCost(dest) * TU_COST.DIAGONAL_MULT).
 *  - Diagonal moves may not cut corners: both orthogonally-adjacent tiles must
 *    be terrain-passable.
 *  - `isBlocked` (units) makes a tile impassable, EXCEPT the goal tile itself,
 *    which stays reachable as a destination.
 *  - `maxCost`, when given, prunes nodes whose g-cost would exceed it.
 *
 * @returns the path/cost, or null when unreachable within the constraints.
 */
export function findPath(
  grid: Grid,
  start: Vec2,
  goal: Vec2,
  opts: FindPathOptions = {},
): PathResult | null {
  const { maxCost, isBlocked, stanceMult = 1 } = opts;
  const { width, height } = grid;

  if (!inBounds(grid, start.x, start.y) || !inBounds(grid, goal.x, goal.y)) {
    return null;
  }
  if (start.x === goal.x && start.y === goal.y) {
    return { path: [], cost: 0 };
  }
  // The goal must be terrain-passable; isBlocked (units) is ignored for it.
  if (blocksMove(grid, goal.x, goal.y)) return null;

  const goalIdx = goal.y * width + goal.x;
  const startIdx = start.y * width + start.x;

  // Admissible heuristic: chebyshev distance times the cheapest possible step.
  let minStep = Infinity;
  for (const tile of grid.palette) {
    if (!tile.blocksMove) minStep = Math.min(minStep, tile.moveCost);
  }
  if (!Number.isFinite(minStep)) minStep = 0;

  const size = width * height;
  const gScore = new Float64Array(size).fill(Infinity);
  const cameFrom = new Int32Array(size).fill(-1);
  const closed = new Uint8Array(size);

  gScore[startIdx] = 0;

  const heap = new MinHeap();
  let seq = 0;
  heap.push({ idx: startIdx, f: chebyshev(start, goal) * minStep, seq: seq++ });

  // Local copy of the direction table avoids importing it as a value cycle.
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [0, -1],
    [1, -1],
    [1, 0],
    [1, 1],
    [0, 1],
    [-1, 1],
    [-1, 0],
    [-1, -1],
  ];

  while (heap.size > 0) {
    const current = heap.pop()!;
    const cIdx = current.idx;
    if (closed[cIdx]) continue;
    closed[cIdx] = 1;

    if (cIdx === goalIdx) break;

    const cx = cIdx % width;
    const cy = (cIdx - cx) / width;
    const cg = gScore[cIdx] ?? Infinity;

    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inBounds(grid, nx, ny)) continue;
      if (blocksMove(grid, nx, ny)) continue; // terrain wall: never enter

      const nIdx = ny * width + nx;
      if (closed[nIdx]) continue;

      const isGoal = nIdx === goalIdx;
      // Units block the tile unless it is the goal destination.
      if (!isGoal && isBlocked && isBlocked(nx, ny)) continue;

      const diagonal = dx !== 0 && dy !== 0;
      if (diagonal) {
        // No corner-cutting: both orthogonal neighbours must be passable.
        if (blocksMove(grid, cx + dx, cy) || blocksMove(grid, cx, cy + dy)) {
          continue;
        }
      }

      const base = moveCost(grid, nx, ny);
      const diagonalMult = diagonal ? TU_COST.DIAGONAL_MULT : 1;
      const enter = Math.floor(base * diagonalMult * stanceMult);
      const tentative = cg + enter;

      if (maxCost !== undefined && tentative > maxCost) continue;
      if (tentative < (gScore[nIdx] ?? Infinity)) {
        gScore[nIdx] = tentative;
        cameFrom[nIdx] = cIdx;
        const f = tentative + chebyshev({ x: nx, y: ny }, goal) * minStep;
        heap.push({ idx: nIdx, f, seq: seq++ });
      }
    }
  }

  if (!closed[goalIdx]) return null;

  const path: Vec2[] = [];
  let cur = goalIdx;
  while (cur !== startIdx) {
    path.push({ x: cur % width, y: Math.floor(cur / width) });
    const prev = cameFrom[cur];
    if (prev === undefined || prev < 0) return null;
    cur = prev;
  }
  path.reverse();

  return { path, cost: gScore[goalIdx] ?? Infinity };
}
