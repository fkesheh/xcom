/**
 * Pure presentation helpers shared by the renderer.
 *
 * Intentionally three.js-free and DOM-free so they can be unit-tested in node
 * and reused without dragging in the WebGL stack. The renderer turns the plain
 * {x,y,z} results here into THREE.Vector3 values.
 *
 * Coordinate convention: the battle grid's tile (gx, gy) maps to the world
 * point (x = gx, z = gy), with Y as the up axis. This keeps +y "south" (the
 * sim's convention) pointing toward +Z in world space.
 */

import type { Dir8 } from "../sim/index";
import { DIR8_VECTORS } from "../sim/index";

/** A world-space point (Y up). */
export interface World3 {
  x: number;
  y: number;
  z: number;
}

/** Map a tile coordinate to its world-space centre (Y defaults to ground). */
export function tileToWorld(gx: number, gy: number, yUp = 0): World3 {
  return { x: gx, y: yUp, z: gy };
}

/** Map a world XZ point back to the nearest tile coordinate. */
export function worldToTile(wx: number, wz: number): { x: number; y: number } {
  // `+ 0` normalises a possible -0 (from Math.round of small negatives) to 0.
  return { x: Math.round(wx) + 0, y: Math.round(wz) + 0 };
}

/**
 * Y-rotation (radians) that turns an object's local +Z toward the given facing.
 * Local +Z maps to world (sinθ, cosθ); we want that to equal the Dir8 vector
 * (vx, vy), so θ = atan2(vx, vy).
 */
export function dir8ToAngleY(dir: Dir8): number {
  const v = DIR8_VECTORS[dir] ?? { x: 0, y: -1 };
  return Math.atan2(v.x, v.y);
}

/** Clamp hp/max into [0, 1]. */
export function hpFraction(hp: number, max: number): number {
  if (max <= 0) return 0;
  const f = hp / max;
  if (f < 0) return 0;
  if (f > 1) return 1;
  return f;
}

/** Green / amber / red banding for an HP fraction. Returns a hex colour. */
export function hpColor(frac: number): number {
  if (frac >= 0.6) return 0x4ade80;
  if (frac >= 0.3) return 0xfacc15;
  return 0xef4444;
}

export type TileVisibility = "visible" | "explored" | "hidden";

/**
 * Classify a tile for fog rendering. Currently-visible beats explored memory,
 * which beats never-seen.
 */
export function classifyTile(
  idx: number,
  visible: ReadonlySet<number>,
  explored: ReadonlySet<number>,
): TileVisibility {
  if (visible.has(idx)) return "visible";
  if (explored.has(idx)) return "explored";
  return "hidden";
}

/** Linear interpolation (floats only; never feeds integer game state). */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
