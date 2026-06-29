/**
 * Line of sight, vision cones, and fog-of-war reveal.
 *
 * Geometry uses floats (bearings, distances); everything that feeds integer
 * game state (which tiles are revealed, which enemies are seen) reduces to
 * booleans. Bearings use atan2 in the grid frame where +y is "south".
 */

import type { BattleState, Dir8, Faction, Grid, SmokeCloud, Unit, UnitId, Vec2 } from "./types";
import { DIR8_VECTORS } from "./types";
import { blocksSight, inBounds } from "./grid";

const DEG = 180 / Math.PI;
const ANGLE_EPSILON = 1e-9;

/**
 * Whether `pos` lies inside any active smoke cloud. A cloud covers every tile
 * within Chebyshev `radius` of its centre (same metric as grenade blasts). Used
 * to occlude lines of sight/fire exactly like a blocksSight tile.
 */
function tileInAnySmoke(pos: Vec2, clouds: readonly SmokeCloud[] | undefined): boolean {
  if (!clouds || clouds.length === 0) return false;
  for (const c of clouds) {
    if (Math.max(Math.abs(pos.x - c.pos.x), Math.abs(pos.y - c.pos.y)) <= c.radius) return true;
  }
  return false;
}

/** Bearing (radians) of the ray from -> to, via atan2(dy, dx). */
export function octileBearingRad(from: Vec2, to: Vec2): number {
  return Math.atan2(to.y - from.y, to.x - from.x);
}

/** Smallest absolute angular difference between two bearings, in radians. */
function angleDiff(a: number, b: number): number {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Math.abs(d);
}

/** Bearing (radians) of a Dir8 facing. */
function dir8Bearing(dir: Dir8): number {
  const v = DIR8_VECTORS[dir] ?? { x: 0, y: -1 };
  return Math.atan2(v.y, v.x);
}

/**
 * Supercover-style integer ray from (x0,y0) to (x1,y1), returning every tile
 * the line passes through (endpoints included). Used for LOS occlusion tests.
 */
function supercoverLine(x0: number, y0: number, x1: number, y1: number): Vec2[] {
  const points: Vec2[] = [{ x: x0, y: y0 }];
  const dx = x1 - x0;
  const dy = y1 - y0;
  const nx = Math.abs(dx);
  const ny = Math.abs(dy);
  const signX = dx > 0 ? 1 : -1;
  const signY = dy > 0 ? 1 : -1;

  let px = x0;
  let py = y0;
  let ix = 0;
  let iy = 0;
  while (ix < nx || iy < ny) {
    const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
    if (decision === 0) {
      px += signX;
      py += signY;
      ix++;
      iy++;
    } else if (decision < 0) {
      px += signX;
      ix++;
    } else {
      py += signY;
      iy++;
    }
    points.push({ x: px, y: py });
  }
  return points;
}

/**
 * Clear line of sight between two tiles. Intermediate tiles that block sight
 * occlude the ray; the `from` and `to` tiles are never treated as blockers.
 * Smoke clouds occlude the same way: any intermediate tile inside a cloud
 * blocks the ray (see {@link tileInAnySmoke}).
 */
export function hasLineOfSight(
  grid: Grid,
  from: Vec2,
  to: Vec2,
  smokeClouds?: readonly SmokeCloud[],
): boolean {
  const line = supercoverLine(from.x, from.y, to.x, to.y);
  for (let i = 1; i < line.length; i++) {
    const prev = line[i - 1]!;
    const cur = line[i]!;
    // A perfectly diagonal step squeezes the ray through a lattice corner
    // between two orthogonal tiles. If BOTH flanking tiles block sight the
    // corner is solid and the ray cannot pass — mirroring pathfinding's
    // no-corner-cutting rule so you can't see/shoot/react through a wall
    // corner you couldn't walk through.
    if (prev.x !== cur.x && prev.y !== cur.y) {
      if (blocksSight(grid, prev.x, cur.y) && blocksSight(grid, cur.x, prev.y)) {
        return false;
      }
    }
    // Only intermediate tiles occlude; the `to` endpoint is never a blocker.
    // A smoke cloud counts as an occluder on every tile it covers.
    if (
      i < line.length - 1 &&
      (blocksSight(grid, cur.x, cur.y) || tileInAnySmoke(cur, smokeClouds))
    ) {
      return false;
    }
  }
  return true;
}

/** Result of a line-of-fire query: whether a shot connects, and from where. */
export interface LineResult {
  /** True when the shot can reach the target directly or by leaning aside. */
  clear: boolean;
  /** The tile the shot is fired from: the shooter's tile, or the lean tile. */
  origin: Vec2;
}

/**
 * Can a shot reach `to` from `from`, possibly by leaning around a corner?
 *
 * A unit hugging full cover has its center-to-center line blocked even when a
 * clear angle exists just to the side. lineOfFire first tries the direct line;
 * failing that it considers the 8 neighbours of `from` that are in bounds, do
 * NOT block sight themselves (you can't lean through/into a wall) and are not
 * the target tile, and picks the one with a clear line to `to` that is closest
 * to `to` (ties broken by Dir8 index ascending). That tile is returned as the
 * firing `origin`; with no peek available the line is not clear.
 */
export function lineOfFire(
  grid: Grid,
  from: Vec2,
  to: Vec2,
  smokeClouds?: readonly SmokeCloud[],
): LineResult {
  if (hasLineOfSight(grid, from, to, smokeClouds)) {
    return { clear: true, origin: { x: from.x, y: from.y } };
  }
  let best: Vec2 | undefined;
  let bestD2 = Infinity;
  for (let i = 0; i < DIR8_VECTORS.length; i++) {
    const v = DIR8_VECTORS[i];
    if (!v) continue;
    const px = from.x + v.x;
    const py = from.y + v.y;
    if (!inBounds(grid, px, py)) continue;
    if (blocksSight(grid, px, py)) continue; // can't lean through/into a wall
    if (px === to.x && py === to.y) continue; // the lean tile can't be the target
    if (!hasLineOfSight(grid, { x: px, y: py }, to, smokeClouds)) continue;
    const dx = to.x - px;
    const dy = to.y - py;
    const d2 = dx * dx + dy * dy; // integer compare: deterministic, no float ties
    // Strict `<` plus ascending Dir8 iteration keeps the lowest index on a tie.
    if (d2 < bestD2) {
      bestD2 = d2;
      best = { x: px, y: py };
    }
  }
  if (best) return { clear: true, origin: best };
  return { clear: false, origin: { x: from.x, y: from.y } };
}

/** Nearest of the 8 facings pointing from -> to (0 = N when from === to). */
export function dir8Towards(from: Vec2, to: Vec2): Dir8 {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 0;
  const target = Math.atan2(dy, dx);
  let best: Dir8 = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < DIR8_VECTORS.length; i++) {
    const v = DIR8_VECTORS[i];
    if (!v) continue;
    const diff = angleDiff(target, Math.atan2(v.y, v.x));
    if (diff < bestDiff - ANGLE_EPSILON) {
      bestDiff = diff;
      best = i as Dir8;
    }
  }
  return best;
}

/**
 * Whether `target` falls inside the unit's forward vision cone. The unit
 * always "sees" its own tile.
 */
export function inVisionCone(unit: Unit, target: Vec2): boolean {
  if (target.x === unit.pos.x && target.y === unit.pos.y) return true;
  const facing = dir8Bearing(unit.facing);
  const toTarget = octileBearingRad(unit.pos, target);
  const diffDeg = angleDiff(facing, toTarget) * DEG;
  return diffDeg <= unit.visionHalfAngleDeg + ANGLE_EPSILON;
}

/**
 * Can `observer` see `targetPos`? Requires Euclidean range and the target in
 * the forward vision cone (both measured from the observer's actual pos/facing,
 * since leaning never rotates the unit), plus a clear line of fire — which may
 * peek around a corner, so a front-but-corner-blocked target becomes visible
 * while a target behind the observer stays out of the cone.
 */
export function canSee(
  grid: Grid,
  observer: Unit,
  targetPos: Vec2,
  smokeClouds?: readonly SmokeCloud[],
): boolean {
  const dx = targetPos.x - observer.pos.x;
  const dy = targetPos.y - observer.pos.y;
  if (Math.hypot(dx, dy) > observer.sightRange) return false;
  if (!inVisionCone(observer, targetPos)) return false;
  return lineOfFire(grid, observer.pos, targetPos, smokeClouds).clear;
}

/** Every tile the unit can currently see (for fog reveal). Includes own tile. */
export function visibleTiles(grid: Grid, unit: Unit): Vec2[] {
  const out: Vec2[] = [];
  const r = Math.ceil(unit.sightRange);
  const minX = unit.pos.x - r;
  const maxX = unit.pos.x + r;
  const minY = unit.pos.y - r;
  const maxY = unit.pos.y + r;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (!inBounds(grid, x, y)) continue;
      if (canSee(grid, unit, { x, y })) out.push({ x, y });
    }
  }
  return out;
}

/**
 * Union of enemy unit ids visible to any LIVING unit of `faction`.
 * "Enemy" means a unit whose faction differs from `faction`.
 */
export function visibleEnemyIds(state: BattleState, faction: Faction): Set<UnitId> {
  const seen = new Set<UnitId>();
  const observers = state.units.filter((u) => u.faction === faction && u.alive);
  const enemies = state.units.filter((u) => u.faction !== faction && u.alive);
  for (const observer of observers) {
    for (const enemy of enemies) {
      if (seen.has(enemy.id)) continue;
      if (canSee(state.grid, observer, enemy.pos, state.smokeClouds)) seen.add(enemy.id);
    }
  }
  return seen;
}
