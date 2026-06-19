/**
 * Public sim API barrel — the single import surface for the renderer.
 *
 * The renderer should depend ONLY on what is re-exported here. Internal
 * executors and pure-layer internals stay private to the sim package.
 */

// Scenario setup.
export { createSkirmish } from "./setup";
export type { SkirmishOptions } from "./setup";

// Reducer + queries the renderer drives the game through.
export {
  applyCommand,
  canExtractObjective,
  canRecoverObjective,
  previewPlayerShot,
  unitById,
  unitAt,
  livingUnits,
} from "./battle";

// Domain types.
export type * from "./types";

// Runtime constants the renderer / coords helpers need (values, not types).
export { DIR8_VECTORS, DIR8_NAMES, TU_COST, COMBAT } from "./types";

// Deterministic PRNG (for save/load + replays).
export { Rng } from "./rng";

// Pathfinding the renderer uses for move previews.
export { findPath } from "./pathfinding";
export type { PathResult } from "./pathfinding";

// Read-only world helpers the renderer needs for fog / vision / facing.
export { visibleEnemyIds, visibleTiles, canSee, dir8Towards } from "./los";
export { tileTypeAt, inBounds, cellIndex, DEFAULT_PALETTE, FLOOR, WALL } from "./grid";
