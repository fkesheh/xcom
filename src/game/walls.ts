/**
 * Neighbor-aware THIN wall geometry.
 *
 * Presentation-only (three.js). Where {@link ./props} draws a tree / crate /
 * rock as a self-contained tile object, walls are different: a building or a
 * hull is a CONTINUOUS thin wall that must FUSE across many tiles into real
 * corners (L), tees (T), crosses (+) and straight runs. So each wall tile is
 * rendered as a central HUB plus ARMS that extend ONLY toward adjacent wall
 * tiles. Two neighbouring wall tiles each build half of the wall on their
 * shared edge; the arms meet flush at the edge and read as one wall. The tile's
 * floor shows through everywhere the thin wall isn't — open-top rooms, no roofs,
 * classic X-COM, so units inside stay visible.
 *
 * This is RENDER-ONLY. The sim still treats wall tiles as solid
 * (blocksMove / blocksSight); we merely draw them as thin architecture.
 *
 * Coordinate convention (matches the renderer): a tile at grid (x, y) is placed
 * at world (x, 0, y), Y up. Its orthogonal neighbours map to directions:
 *   n = (x, y-1) -> -Z,   s = (x, y+1) -> +Z,
 *   e = (x+1, y) -> +X,   w = (x-1, y) -> -X.
 * Every object's base sits at y = 0, centred on the tile origin.
 *
 * Materials come from {@link ./materials} (shared, cached PBR instances), so a
 * wall does NOT own them; {@link disposeWall} releases only the geometry. The
 * structural body (hub + arms + coping) is merged into ONE geometry per tile;
 * emissive trim and translucent panes are separate accent meshes (own material).
 * Everything is deterministic: no Math.random anywhere.
 */

import { BoxGeometry, Group, Mesh } from "three";
import type { BufferGeometry, MeshStandardMaterial, Object3D } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";

import { getEmissiveMaterial, getTerrainMaterial } from "./materials";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type WallFamily = "building" | "interior" | "ufo" | "dropship" | "fence";

export interface WallNeighbors {
  n: boolean;
  e: boolean;
  s: boolean;
  w: boolean;
  /** Diagonal wall neighbours (for diagonal wall runs). */
  ne: boolean;
  nw: boolean;
  se: boolean;
  sw: boolean;
}

export type WallOpening = "none" | "window" | "door";

// ---------------------------------------------------------------------------
// Tunables (a tile is 1.0 wide)
// ---------------------------------------------------------------------------

const THICK = 0.34; // wall thickness (chunky enough to read as a solid wall)
const HALF = 0.5; // tile half-extent (centre -> edge)
const ARM = HALF; // an arm spans centre -> edge
const HUB = 0.36; // central hub footprint
const SOLID = 0.84; // footprint of an isolated wall tile (a solid block, not a post)

const COPE_H = 0.12; // coping (top cap) height
const COPE_THICK = 0.44; // coping cross-thickness (a slight overhang)
const COPE_HUB = 0.46; // coping hub footprint

const NODE_HALF = 0.3; // half-width of an opening's central node (gap = 0.6)
const JAMB_W = 0.1; // door/window jamb post width
const PANE_THIN = 0.05; // translucent window pane thickness

/** Emissive accent colours (sRGB hex), tuned to trip the renderer's bloom. */
const GLOW = {
  ufo: 0x6ee7ff, // cyan alien running lights
  ufoDoor: 0x39d6c0, // teal hatch sill
  window: 0xffce82, // warm lit building windows
  dropship: 0xff8a3c, // amber human-tech trim
} as const;

type Axis = "x" | "z";

/** Where a family's glow sits: a top running-light belt, or a mid lit-window band. */
type GlowStyle = "belt" | "windows";

interface FamilyConfig {
  /** Wall height; base at y = 0. */
  height: number;
  /** Render category whose shared material clads the wall body. */
  category: string;
  /** Draw a flush top coping/cap (finished masonry look). */
  coping: boolean;
  /** Emissive accent, or null for a matte wall. */
  glow: { color: number; intensity: number; style: GlowStyle } | null;
}

const FAMILY: Record<WallFamily, FamilyConfig> = {
  building: {
    height: 1.9,
    category: "wall_building",
    coping: true,
    glow: { color: GLOW.window, intensity: 1.4, style: "windows" },
  },
  interior: { height: 1.3, category: "wall_interior", coping: true, glow: null },
  ufo: {
    height: 1.6,
    category: "ufo_hull",
    coping: false,
    glow: { color: GLOW.ufo, intensity: 2.2, style: "belt" },
  },
  dropship: {
    height: 1.5,
    category: "dropship_hull",
    coping: false,
    glow: { color: GLOW.dropship, intensity: 1.8, style: "belt" },
  },
  fence: { height: 0.6, category: "fence", coping: false, glow: null },
};

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

/** The wall categories that map directly onto a {@link WallFamily}. */
const FAMILY_OF_CATEGORY: Record<string, WallFamily> = {
  wall_building: "building",
  wall_interior: "interior",
  ufo_hull: "ufo",
  dropship_hull: "dropship",
  fence: "fence",
  // An alien hatch unambiguously belongs to the UFO hull, so resolve it here;
  // the generic door/window below stay `null` so the renderer can infer
  // building-vs-interior from the wall they sit in.
  ufo_door: "ufo",
};

/**
 * Resolve a render category to its wall family, or `null` for generic openings
 * (`door` / `window`) whose family the renderer infers from a connecting wall
 * neighbour (falling back to `building`). `ufo_door` resolves to `ufo`.
 */
export function wallFamilyOf(category: string): WallFamily | null {
  return FAMILY_OF_CATEGORY[category] ?? null;
}

/** The opening a category punches through the wall line (else `"none"`). */
export function openingOf(category: string): WallOpening {
  if (category === "window") return "window";
  if (category === "door" || category === "ufo_door") return "door";
  return "none";
}

/**
 * Does a neighbour tile EXTEND this wall's run (so an arm grows toward it)?
 *
 * Connection matrix (a neighbour category -> which families it continues):
 *   building  : wall_building, wall_interior, door, window
 *   interior  : wall_building, wall_interior, door, window
 *   ufo       : ufo_hull, ufo_door
 *   dropship  : dropship_hull, door
 *   fence     : fence
 *
 * So masonry partitions fuse with outer masonry walls and run through their
 * doors/windows; the UFO hull only fuses with itself and its hatches; the
 * dropship hull with itself and its door; fences only with fences. Openings
 * connect like the wall they belong to, keeping the wall line continuous as it
 * passes through a doorway or window.
 */
export function connectsTo(family: WallFamily, neighborCategory: string): boolean {
  switch (family) {
    case "building":
    case "interior":
      return (
        neighborCategory === "wall_building" ||
        neighborCategory === "wall_interior" ||
        neighborCategory === "door" ||
        neighborCategory === "window"
      );
    case "ufo":
      return neighborCategory === "ufo_hull" || neighborCategory === "ufo_door";
    case "dropship":
      return neighborCategory === "dropship_hull" || neighborCategory === "door";
    case "fence":
      return neighborCategory === "fence";
  }
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

/** A box of the given size, translated so its centre is at (cx, cy, cz). */
function boxAt(
  sx: number,
  sy: number,
  sz: number,
  cx: number,
  cy: number,
  cz: number,
): BufferGeometry {
  const g = new BoxGeometry(sx, sy, sz);
  g.translate(cx, cy, cz);
  return g;
}

/**
 * A box oriented along a wall axis: `alongSize` runs down the wall line,
 * `crossSize` across its thickness. For axis "x" the run is on X (cross on Z);
 * for axis "z" the run is on Z (cross on X). `alongCenter` positions it along
 * the run; the cross axis is centred on the tile.
 */
function axisBox(
  axis: Axis,
  alongCenter: number,
  alongSize: number,
  crossSize: number,
  y: number,
  ySize: number,
): BufferGeometry {
  if (axis === "x") return boxAt(alongSize, ySize, crossSize, alongCenter, y, 0);
  return boxAt(crossSize, ySize, alongSize, 0, y, alongCenter);
}

/** A thin wall arm running diagonally from the tile centre to the (sx, sz) corner. */
function diagArm(h: number, thick: number, sx: number, sz: number): BufferGeometry {
  const g = new BoxGeometry(Math.SQRT1_2, h, thick); // length: centre -> tile corner
  g.rotateY(Math.atan2(-sz, sx)); // point the long (local +X) axis at the corner
  g.translate(sx * (HALF / 2), h / 2, sz * (HALF / 2)); // span centre -> corner
  return g;
}

/** A solid, shadow-casting/receiving mesh (structural wall surfaces). */
function solid(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** A decorative accent (emissive trim / translucent pane): no shadow interaction. */
function accent(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  return mesh;
}

/** Merge a batch of placed geometries into one (and dispose the sources). */
function mergePlaced(geometries: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(geometries, false);
  for (const g of geometries) g.dispose();
  return merged;
}

// ---------------------------------------------------------------------------
// Solid wall (no opening): hub + arms (+ coping, + glow)
// ---------------------------------------------------------------------------

function buildSolidWall(
  group: Group,
  cfg: FamilyConfig,
  wallMat: MeshStandardMaterial,
  n: WallNeighbors,
): void {
  const h = cfg.height;
  const body: BufferGeometry[] = [];

  // A diagonal connection only counts as a genuine diagonal RUN when neither
  // flanking orthogonal cell is also a wall (otherwise the corner is already
  // bridged by orthogonal arms and a diagonal would just clutter it).
  const dNE = n.ne && !n.n && !n.e;
  const dNW = n.nw && !n.n && !n.w;
  const dSE = n.se && !n.s && !n.e;
  const dSW = n.sw && !n.s && !n.w;
  const connected = n.n || n.s || n.e || n.w || dNE || dNW || dSE || dSW;

  // Isolated wall tile (no connecting neighbour): a solid block, NOT a spindly
  // hub post — so a lone wall / a tile whose neighbours weren't detected still
  // reads as a chunk of wall.
  if (!connected) {
    body.push(boxAt(SOLID, h, SOLID, 0, h / 2, 0));
    if (cfg.coping) body.push(boxAt(SOLID + 0.06, COPE_H, SOLID + 0.06, 0, h - COPE_H / 2, 0));
    group.add(solid(mergePlaced(body), wallMat));
    if (cfg.glow) {
      const belt = cfg.glow.style === "belt";
      addBelt(group, n, cfg.glow.color, cfg.glow.intensity, belt ? h - 0.22 : h * 0.5, belt ? 0.08 : 0.3, 0.04);
    }
    return;
  }

  // Central hub + a straight arm toward every connected orthogonal neighbour.
  body.push(boxAt(HUB, h, HUB, 0, h / 2, 0));
  if (n.n) body.push(boxAt(THICK, h, ARM, 0, h / 2, -ARM / 2));
  if (n.s) body.push(boxAt(THICK, h, ARM, 0, h / 2, ARM / 2));
  if (n.e) body.push(boxAt(ARM, h, THICK, ARM / 2, h / 2, 0));
  if (n.w) body.push(boxAt(ARM, h, THICK, -ARM / 2, h / 2, 0));
  // Diagonal arms (45°) toward genuine diagonal runs.
  if (dNE) body.push(diagArm(h, THICK, 1, -1));
  if (dNW) body.push(diagArm(h, THICK, -1, -1));
  if (dSE) body.push(diagArm(h, THICK, 1, 1));
  if (dSW) body.push(diagArm(h, THICK, -1, 1));

  if (cfg.coping) {
    const cy = h - COPE_H / 2; // flush top: the cap occupies the top COPE_H
    body.push(boxAt(COPE_HUB, COPE_H, COPE_HUB, 0, cy, 0));
    if (n.n) body.push(boxAt(COPE_THICK, COPE_H, ARM, 0, cy, -ARM / 2));
    if (n.s) body.push(boxAt(COPE_THICK, COPE_H, ARM, 0, cy, ARM / 2));
    if (n.e) body.push(boxAt(ARM, COPE_H, COPE_THICK, ARM / 2, cy, 0));
    if (n.w) body.push(boxAt(ARM, COPE_H, COPE_THICK, -ARM / 2, cy, 0));
  }

  group.add(solid(mergePlaced(body), wallMat));

  if (cfg.glow) {
    if (cfg.glow.style === "belt") {
      addBelt(group, n, cfg.glow.color, cfg.glow.intensity, h - 0.22, 0.08, 0.04);
    } else {
      // Lit-window band wrapping the wall at mid height (reads as a glowing
      // facade where contiguous building tiles line up).
      addBelt(group, n, cfg.glow.color, cfg.glow.intensity, h * 0.5, 0.3, 0.03);
    }
  }
}

/** An emissive band wrapping the hub + arms (a continuous glowing line). */
function addBelt(
  group: Group,
  n: WallNeighbors,
  color: number,
  intensity: number,
  y: number,
  bandH: number,
  proud: number,
): void {
  const w = THICK + proud; // slightly proud so the line reads from the side
  const geo: BufferGeometry[] = [];
  geo.push(boxAt(w, bandH, w, 0, y, 0));
  if (n.n) geo.push(boxAt(w, bandH, ARM, 0, y, -ARM / 2));
  if (n.s) geo.push(boxAt(w, bandH, ARM, 0, y, ARM / 2));
  if (n.e) geo.push(boxAt(ARM, bandH, w, ARM / 2, y, 0));
  if (n.w) geo.push(boxAt(ARM, bandH, w, -ARM / 2, y, 0));
  group.add(accent(mergePlaced(geo), getEmissiveMaterial(color, intensity)));
}

// ---------------------------------------------------------------------------
// Opening wall (door / window): solid arms + jambs + lintel/sill + pane
// ---------------------------------------------------------------------------

/** The axis the opening's gap runs along (the wall line through the tile). */
function openingAxis(n: WallNeighbors): Axis {
  const hasX = n.e || n.w;
  const hasZ = n.n || n.s;
  if (hasZ && !hasX) return "z";
  return "x"; // straight E-W wall, a corner/tee, or an isolated frame
}

function buildOpeningWall(
  group: Group,
  family: WallFamily,
  cfg: FamilyConfig,
  wallMat: MeshStandardMaterial,
  n: WallNeighbors,
  opening: WallOpening,
): void {
  const h = cfg.height;
  const axis = openingAxis(n);
  const negN = axis === "x" ? n.w : n.n; // neighbour on the negative-along edge
  const posN = axis === "x" ? n.e : n.s; // neighbour on the positive-along edge
  const seg = HALF - NODE_HALF; // length of a solid wall segment beside the gap
  const segC = (HALF + NODE_HALF) / 2; // its centre along the axis

  const body: BufferGeometry[] = [];

  // Solid wall segments either side of the gap, toward connected neighbours, so
  // the wall line stays continuous through the opening.
  if (negN) body.push(axisBox(axis, -segC, seg, THICK, h / 2, h));
  if (posN) body.push(axisBox(axis, segC, seg, THICK, h / 2, h));

  // Full-height jamb posts at both gap edges (always present, so the frame is
  // self-supporting even at the end of a wall).
  body.push(axisBox(axis, -NODE_HALF, JAMB_W, THICK, h / 2, h));
  body.push(axisBox(axis, NODE_HALF, JAMB_W, THICK, h / 2, h));

  // Perpendicular arms toward any neighbour off the gap axis (corner / tee).
  addPerpArms(body, axis, n, h, THICK, h / 2);

  if (opening === "door") {
    const lintelH = 0.35;
    body.push(axisBox(axis, 0, 2 * NODE_HALF, THICK, h - lintelH / 2, lintelH));
  } else {
    const sillH = 0.5;
    const lintelH = 0.4;
    const paneH = h - sillH - lintelH;
    body.push(axisBox(axis, 0, 2 * NODE_HALF, THICK, sillH / 2, sillH));
    body.push(axisBox(axis, 0, 2 * NODE_HALF, THICK, h - lintelH / 2, lintelH));
    if (paneH > 0.05) {
      const paneY = sillH + paneH / 2;
      body.push(axisBox(axis, 0, JAMB_W * 0.5, THICK, paneY, paneH)); // central mullion
      // Translucent pane: shoot/see-through, matching the sim (window blocks
      // move, not sight).
      group.add(accent(axisBox(axis, 0, 2 * NODE_HALF, PANE_THIN, paneY, paneH), getTerrainMaterial("window")));
    }
  }

  if (cfg.coping) addOpeningCoping(body, axis, n, negN, posN, h, seg, segC);

  group.add(solid(mergePlaced(body), wallMat));

  // Alien / human hatches get a glowing threshold sill on the floor.
  if (opening === "door" && (family === "ufo" || family === "dropship")) {
    const color = family === "ufo" ? GLOW.ufoDoor : GLOW.dropship;
    group.add(
      accent(axisBox(axis, 0, 2 * NODE_HALF, THICK * 0.7, 0.03, 0.05), getEmissiveMaterial(color, 1.9)),
    );
  }

  // Hull running lights continue along the top of an opening tile (the top is
  // solid everywhere: arms, jambs and the lintel).
  if (cfg.glow && cfg.glow.style === "belt") {
    addOpeningBelt(group, axis, n, negN, posN, cfg.glow.color, cfg.glow.intensity, h - 0.22, seg, segC);
  }
}

/** Full solid arms toward neighbours perpendicular to the opening axis. */
function addPerpArms(
  body: BufferGeometry[],
  axis: Axis,
  n: WallNeighbors,
  ySize: number,
  cross: number,
  y: number,
): void {
  if (axis === "x") {
    if (n.n) body.push(boxAt(cross, ySize, ARM, 0, y, -ARM / 2));
    if (n.s) body.push(boxAt(cross, ySize, ARM, 0, y, ARM / 2));
  } else {
    if (n.e) body.push(boxAt(ARM, ySize, cross, ARM / 2, y, 0));
    if (n.w) body.push(boxAt(ARM, ySize, cross, -ARM / 2, y, 0));
  }
}

/** A flush top cap following an opening tile's wall segments + node + perp arms. */
function addOpeningCoping(
  body: BufferGeometry[],
  axis: Axis,
  n: WallNeighbors,
  negN: boolean,
  posN: boolean,
  h: number,
  seg: number,
  segC: number,
): void {
  const cy = h - COPE_H / 2;
  body.push(axisBox(axis, 0, 2 * NODE_HALF, COPE_THICK, cy, COPE_H));
  if (negN) body.push(axisBox(axis, -segC, seg, COPE_THICK, cy, COPE_H));
  if (posN) body.push(axisBox(axis, segC, seg, COPE_THICK, cy, COPE_H));
  addPerpArms(body, axis, n, COPE_H, COPE_THICK, cy);
}

/** Running-light belt along an opening tile's top (node + segments + perp arms). */
function addOpeningBelt(
  group: Group,
  axis: Axis,
  n: WallNeighbors,
  negN: boolean,
  posN: boolean,
  color: number,
  intensity: number,
  y: number,
  seg: number,
  segC: number,
): void {
  const w = THICK + 0.04;
  const bandH = 0.08;
  const geo: BufferGeometry[] = [];
  geo.push(axisBox(axis, 0, 2 * NODE_HALF, w, y, bandH));
  if (negN) geo.push(axisBox(axis, -segC, seg, w, y, bandH));
  if (posN) geo.push(axisBox(axis, segC, seg, w, y, bandH));
  addPerpArms(geo, axis, n, bandH, w, y);
  group.add(accent(mergePlaced(geo), getEmissiveMaterial(color, intensity)));
}

// ---------------------------------------------------------------------------
// Fence (no opening, no coping): a hub post + low rails along the arms
// ---------------------------------------------------------------------------

function buildFence(group: Group, n: WallNeighbors): void {
  const mat = getTerrainMaterial("fence");
  const h = FAMILY.fence.height;
  const body: BufferGeometry[] = [];

  body.push(boxAt(0.1, h, 0.1, 0, h / 2, 0)); // hub post
  for (const ry of [0.2, 0.44] as const) {
    if (n.n) body.push(boxAt(0.05, 0.06, ARM, 0, ry, -ARM / 2));
    if (n.s) body.push(boxAt(0.05, 0.06, ARM, 0, ry, ARM / 2));
    if (n.e) body.push(boxAt(ARM, 0.06, 0.05, ARM / 2, ry, 0));
    if (n.w) body.push(boxAt(ARM, 0.06, 0.05, -ARM / 2, ry, 0));
  }

  group.add(solid(mergePlaced(body), mat));
}

// ---------------------------------------------------------------------------
// Public factory
// ---------------------------------------------------------------------------

/**
 * Build a single wall tile's thin-wall object. The result's base sits at y = 0,
 * centred on the tile origin — place it at world (x = gx, z = gy). Arms grow
 * only toward `neighbors` flagged true, so contiguous wall tiles fuse into one
 * continuous wall with real corners / tees / crosses. `opening` punches a
 * doorway or window through the wall line while keeping it continuous.
 *
 * `opts.variant` is accepted for API parity with {@link ./props}; walls are
 * fully determined by family + neighbours + opening, so no per-tile jitter is
 * applied (and none would desync anything).
 */
export function buildWall(
  family: WallFamily,
  neighbors: WallNeighbors,
  opening: WallOpening,
  _opts?: { variant?: number },
): Object3D {
  const group = new Group();
  const cfg = FAMILY[family];

  if (family === "fence") {
    buildFence(group, neighbors);
    return group;
  }

  const wallMat = getTerrainMaterial(cfg.category);
  if (opening === "none") {
    buildSolidWall(group, cfg, wallMat, neighbors);
  } else {
    buildOpeningWall(group, family, cfg, wallMat, neighbors, opening);
  }
  return group;
}

/**
 * Release a wall's GPU geometry. Materials are SHARED/cached by
 * {@link ./materials} (or cloned + owned by the renderer for per-tile fog
 * dimming), so they are intentionally NOT disposed here.
 */
export function disposeWall(obj: Object3D): void {
  obj.traverse((node) => {
    if (node instanceof Mesh) node.geometry.dispose();
  });
}
