/**
 * Facility INTERIOR dioramas for the "enter facility" camera dive. Each of the
 * eight roles is a dense, textured, sculpted diorama the camera flies INTO and
 * reads as a real room: LAB (research vat + server racks), COMMAND (holo war
 * table + console arc), WORKSHOP (gantry + robotic arm + forge), BARRACKS
 * (stacked bunk beds + lockers), HANGAR (interceptor on a pad + crane), RADAR
 * (lathed dish on a mast + antennas), REACTOR (pulsing core + conduits),
 * CONTAINMENT (sealed holding cells + neutralization console — a modest
 * treatment relative to the other seven).
 *
 * ANTI-BLOB CORE: every surface that was a flat color box is now a PROCEDURAL
 * TEXTURE + NORMAL MAP from baseTextures — riveted metal-panel walls/racks,
 * cracked concrete floors, glowing readout screens. Geometry is SCULPTED:
 * racks/crates/beams/beds/ship parts are extruded Shapes WITH bevel (chamfered
 * edges read as crafted), the vat + radar dish are lathed, multi-part
 * silhouettes merge into one read. No naked hard-corner boxes for architecture.
 *
 * All solid colors trace to the frozen basePalette (steel/concrete neutrals +
 * the facility accent). Origin sits at floor center (y = 0 is the floor
 * surface); the room footprint is uniform across roles so it frames reliably
 * under a close 3/4 interior camera, with the front wall open toward +z.
 *
 * Performance + dispose-safety: every geometry AND material is created ONCE at
 * module scope and shared across every interior (mirrors baseFacilities.ts), so
 * a room is cheap to build and teardown can never corrupt another group — no
 * per-call GPU resource exists to dispose. Models are STATIC; animated accents
 * (vat pulse, status blink) tag themselves via userData for the baseView frame
 * loop, matching the existing userData.reactorPulse convention.
 */
import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  ExtrudeGeometry,
  Float32BufferAttribute,
  Group,
  HemisphereLight,
  LatheGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  Shape,
  SphereGeometry,
  Vector2,
} from "three";
import { BASE_PALETTE, type FacilityRole } from "./basePalette";
import {
  accentEmissive,
  concreteMaterial,
  concreteTextures,
  metalPanelMaterial,
  metalPanelTextures,
  screenMaterial,
  wornSteelMaterial,
} from "./baseTextures";

export type { FacilityRole } from "./basePalette";

// --- Room footprint (shared across roles for consistent camera framing) ---
/** Interior width along X. */
const ROOM_W = 6.4;
/** Interior depth along Z; the front (+Z) wall is OPEN toward the camera. */
const ROOM_D = 5.2;
/** Wall height along Y. */
const ROOM_H = 3.2;
/** Architectural wall / slab thickness (reads as crafted, not paper-thin). */
const WALL_T = 0.18;

type Vec3 = readonly [number, number, number];

// ---------------------------------------------------------------------------
// Shared materials (module scope — cached, never disposed by a group).
// Concrete / panel / worn-steel / screens come from baseTextures (procedural
// canvas map + normalMap + PBR). Role accents are palette-derived emissives.
// ---------------------------------------------------------------------------
const MAT = {
  concrete: concreteMaterial(),
  panel: metalPanelMaterial(),
  panelDark: metalPanelMaterial(BASE_PALETTE.steel, { metalness: 0.72, roughness: 0.46 }),
  worn: wornSteelMaterial(),
  /** Cool overhead white derived from the palette's lightest structural grey. */
  stripLight: accentEmissive(BASE_PALETTE.steelEdge, 2.6),
} as const;

// ---------------------------------------------------------------------------
// Interior SHELL materials (floor / walls / ceiling) — brighter than the hub's
// dark concrete/steel so a room reads as a LIT space, not a black void. The hub
// hides its dark floor under bay props; a sparse interior (e.g. radar) shows the
// shell across most of the frame, so the shell itself must hold a luminance floor.
// These keep the shared procedural texture DETAIL + relief (albedo map + normal
// map) but add a cool FLAT self-emissive so the surface never falls below the
// brief's "~0.25 luminance so walls/floor read" — even the shadow side reads.
// Module singletons (built once, tagged shared via add()), so they cost nothing
// per dive and are never disposed by a view teardown.
const _concreteTex = concreteTextures();
const _panelTex = metalPanelTextures();
const SHELL_MAT = {
  floor: new MeshStandardMaterial({
    map: _concreteTex.map,
    normalMap: _concreteTex.normalMap,
    normalScale: new Vector2(0.85, 0.85),
    color: 0xffffff,
    // Soft fill so the room isn't crushed black — low enough that the cracked
    // concrete albedo + normals still read under the vat/work lights.
    emissive: new Color(0x1a222c),
    emissiveIntensity: 0.35,
    metalness: 0.0,
    roughness: 0.95,
  }),
  wall: new MeshStandardMaterial({
    map: _panelTex.map,
    normalMap: _panelTex.normalMap,
    normalScale: new Vector2(0.75, 0.75),
    color: 0xffffff,
    emissive: new Color(0x141a22),
    emissiveIntensity: 0.28,
    metalness: 0.55,
    roughness: 0.52,
  }),
  ceiling: new MeshStandardMaterial({
    map: _panelTex.map,
    normalMap: _panelTex.normalMap,
    normalScale: new Vector2(0.7, 0.7),
    color: 0xffffff,
    emissive: new Color(0x10161e),
    emissiveIntensity: 0.22,
    metalness: 0.58,
    roughness: 0.48,
  }),
} as const;

/** Two lab status-light tints so rack boards read as live (varied), not flat. */
const STATUS = {
  on: accentEmissive(BASE_PALETTE.accent.lab, 1.8),
  dim: accentEmissive(BASE_PALETTE.accent.lab, 0.45),
} as const;

interface AccentSet {
  /** Mid-intensity glow for screens, strips, halos. */
  readonly glow: MeshStandardMaterial;
  /** High-intensity point light / beacon. */
  readonly beacon: MeshStandardMaterial;
}

function makeAccent(role: FacilityRole): AccentSet {
  const hex = BASE_PALETTE.accent[role];
  return { glow: accentEmissive(hex, 1.5), beacon: accentEmissive(hex, 2.8) };
}

/** One shared accent pair per role (used by the generic rooms). */
const ACCENT: Record<FacilityRole, AccentSet> = {
  command: makeAccent("command"),
  lab: makeAccent("lab"),
  workshop: makeAccent("workshop"),
  barracks: makeAccent("barracks"),
  hangar: makeAccent("hangar"),
  radar: makeAccent("radar"),
  reactor: makeAccent("reactor"),
  containment: makeAccent("containment"),
};

/**
 * Matte non-emissive PROP materials for soft/structural props that should NOT
 * glow (fabric, bedding, machinery frames). Every color traces to BASE_PALETTE
 * — never ad-hoc hex. Cached at module scope like MAT/ACCENT (dispose-safe via
 * the baseView disposeObject dedup).
 */
const MAT_PROPS = {
  /** Warm linen (mattresses) — barracks warm-white accent, matte. */
  linen: new MeshStandardMaterial({ color: BASE_PALETTE.accent.barracks, metalness: 0.0, roughness: 0.92 }),
  /** Pillow fabric — light palette steel-grey, matte. */
  pillow: new MeshStandardMaterial({ color: BASE_PALETTE.steelEdge, metalness: 0.0, roughness: 0.96 }),
  /** Personal blanket — palette danger red, matte. */
  blanket: new MeshStandardMaterial({ color: BASE_PALETTE.danger, metalness: 0.0, roughness: 0.96 }),
  /** Matte structural frame (bed frames, lockers, machinery bodies). */
  frame: new MeshStandardMaterial({ color: BASE_PALETTE.steel, metalness: 0.5, roughness: 0.6 }),
  /** Dark undersides / recessed bases. */
  dark: new MeshStandardMaterial({ color: BASE_PALETTE.rockLight, metalness: 0.4, roughness: 0.7 }),
} as const;

// ---------------------------------------------------------------------------
// Shared geometry (module scope — cached, never disposed by a group).
// ---------------------------------------------------------------------------

/** Scale a geometry's UV attribute so a cached texture tiles N times. Per-geo,
 * never touches the shared cached texture's own repeat. */
function tileUV(geo: BufferGeometry, rx: number, ry: number): void {
  const uv = geo.getAttribute("uv");
  if (!uv) return;
  for (let i = 0; i < uv.count; i++) {
    uv.setX(i, uv.getX(i) * rx);
    uv.setY(i, uv.getY(i) * ry);
  }
  uv.needsUpdate = true;
}

/**
 * Cache for {@link bevelBox}: every caller passes constant literal dims, so a
 * finite set of chamfered-box geometries is created ONCE and shared for the life
 * of the page — no per-dive GPU geometry allocation, and (like every other
 * interior geometry) nothing the dive teardown needs to dispose. Keyed on the
 * exact dims+bevel.
 */
const bevelCache = new Map<string, ExtrudeGeometry>();

/** An extruded rectangle WITH bevel, centered on Z — a chamfered box that reads
 * as crafted rather than a naked primitive. Shape spans the XY plane, extruded
 * along Z, then recentered so local origin is the part center. Memoized: repeated
 * dims return the same shared geometry. */
function bevelBox(w: number, h: number, d: number, bevel = 0.03): ExtrudeGeometry {
  const key = `${w}|${h}|${d}|${bevel}`;
  const cached = bevelCache.get(key);
  if (cached) return cached;
  const hw = w / 2;
  const hh = h / 2;
  const shape = new Shape();
  shape.moveTo(-hw, -hh);
  shape.lineTo(hw, -hh);
  shape.lineTo(hw, hh);
  shape.lineTo(-hw, hh);
  shape.lineTo(-hw, -hh);
  const geo = new ExtrudeGeometry(shape, {
    depth: d,
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    steps: 1,
  });
  geo.translate(0, 0, -d / 2);
  bevelCache.set(key, geo);
  return geo;
}

// --- Room shell (floor + 3 walls; front toward +z left open for the camera) ---
const SHELL = {
  floor: new BoxGeometry(ROOM_W, 0.2, ROOM_D),
  backWall: new BoxGeometry(ROOM_W, ROOM_H, WALL_T),
  sideWall: new BoxGeometry(WALL_T, ROOM_H, ROOM_D),
  // A lidded ceiling: closes the top of the room so the dive camera never frames
  // props against the black cavern void above the walls (the interior read as a
  // lit ceiling instead of empty black). Same footprint as the floor slab.
  ceiling: new BoxGeometry(ROOM_W, WALL_T, ROOM_D),
} as const;
tileUV(SHELL.floor, ROOM_W / 1.7, ROOM_D / 1.7); // concrete slabs ~1.7 units
tileUV(SHELL.backWall, ROOM_W / 1.3, ROOM_H / 1.3); // riveted panels
tileUV(SHELL.sideWall, ROOM_D / 1.3, ROOM_H / 1.3);
tileUV(SHELL.ceiling, ROOM_W / 1.5, ROOM_D / 1.5);

// --- Server rack: an extruded beveled cabinet (sculpted, not a box) ---
const RACK_W = 0.62;
const RACK_H = 1.82;
const RACK_D = 0.34;
const RACK_BODY = bevelBox(RACK_W, RACK_H, RACK_D, 0.025);
tileUV(RACK_BODY, 1.4, 2.6);
const RACK_CAP = bevelBox(RACK_W + 0.06, 0.07, RACK_D + 0.06, 0.02);
const RACK_BASE = bevelBox(RACK_W + 0.04, 0.1, RACK_D + 0.04, 0.02);
const RACK_SCREEN = new PlaneGeometry(RACK_W * 0.78, RACK_H * 0.66);

// --- Status dot + small emissive primitives ---
const DOT = new SphereGeometry(0.035, 8, 6);
const BEAD = new SphereGeometry(0.05, 10, 8);
const POST = new CylinderGeometry(0.045, 0.045, 1, 10);
const DISK = new CylinderGeometry(0.5, 0.5, 0.05, 24);

// --- Research vat (lathed flask + fluid + support frame) ---
const VAT_POINTS: Vector2[] = [
  new Vector2(0.02, 0.0),
  new Vector2(0.4, 0.0),
  new Vector2(0.46, 0.07),
  new Vector2(0.46, 0.82),
  new Vector2(0.33, 1.02),
  new Vector2(0.19, 1.15),
  new Vector2(0.24, 1.24),
];
const VAT_FLASK = new LatheGeometry(VAT_POINTS, 48);
const VAT_FRAME_POST = new CylinderGeometry(0.035, 0.035, 1.32, 12);

// --- Workbench ---
const BENCH_TOP = bevelBox(1.2, 0.08, 0.62, 0.02);
const BENCH_LEG = bevelBox(0.08, 0.78, 0.08, 0.01);
const BENCH_SCREEN = new PlaneGeometry(0.54, 0.34);

// --- Props ---
const CRATE = bevelBox(0.5, 0.5, 0.5, 0.04);
tileUV(CRATE, 1.6, 1.6);
const PILLAR = new CylinderGeometry(0.12, 0.14, 1, 14);
const BEAM = bevelBox(0.22, 0.14, ROOM_D - 0.4, 0.02);
const STRIP = new BoxGeometry(0.16, 0.05, ROOM_D - 0.9);
const CABLE_TRAY = new BoxGeometry(0.12, 0.1, 1.4);
const CABLE = new CylinderGeometry(0.018, 0.018, 1, 6);
const STOOL_SEAT = new CylinderGeometry(0.16, 0.16, 0.05, 14);
const STOOL_LEG = new CylinderGeometry(0.03, 0.03, 1, 8);

// --- Role-specific sculpted geometry (module scope — shared + dispose-safe) ---
// Each role's signature shapes: lathe/bevel/cone/cylinder silhouettes that read
// as crafted machinery/furniture up close. Small one-off bevels are still made
// inline at call sites (matching buildWorkbench's established local pattern).

// COMMAND — holo table, console desks, commander podium.
const PODIUM = bevelBox(0.55, 1.0, 0.42, 0.03);
const PODIUM_SCREEN = new PlaneGeometry(0.34, 0.24);
const HOLO_BEAM = new CylinderGeometry(0.025, 0.025, 1, 10);
const HOLO_RIM = new CylinderGeometry(0.64, 0.64, 0.035, 48);
const STATUS_WALL = new PlaneGeometry(2.8, 1.0);
const TACTICAL_MAP = new PlaneGeometry(0.86, 0.62);
const CONSOLE_DESK = bevelBox(1.05, 0.68, 0.52, 0.03);
const DESK_SCREEN = new PlaneGeometry(0.62, 0.34);

// WORKSHOP — fabrication gantry, forge/furnace.
const GANTRY_POST = new CylinderGeometry(0.07, 0.07, 1, 10);
const GANTRY_BEAM_X = bevelBox(2.4, 0.12, 0.12, 0.02);
const GANTRY_BEAM_Z = bevelBox(0.12, 0.12, 2.0, 0.02);
const FORGE = bevelBox(0.85, 0.95, 0.65, 0.04);
tileUV(FORGE, 1.5, 1.5);
const FORGE_GLOW = new PlaneGeometry(0.42, 0.32);
const FORGE_STACK = new CylinderGeometry(0.12, 0.14, 1, 10);
const FORGE_TONGUE = new ConeGeometry(0.05, 0.18, 8);

// BARRACKS — stacked bunk bed system + lockers.
const BED_POST = new CylinderGeometry(0.04, 0.04, 1, 8);
const BED_FRAME = bevelBox(0.9, 0.06, 1.95, 0.015);
const MATTRESS = bevelBox(0.82, 0.12, 1.85, 0.03);
const PILLOW = bevelBox(0.32, 0.1, 0.42, 0.03);
const BLANKET = bevelBox(0.82, 0.04, 1.1, 0.02);
const BED_RAIL = bevelBox(0.86, 0.04, 0.05, 0.01);
const LADDER_RAIL = bevelBox(0.04, 1.0, 0.04, 0.008);
const LADDER_RUNG = bevelBox(0.06, 0.03, 0.3, 0.005);
const FOOTLOCKER = bevelBox(0.62, 0.4, 0.42, 0.03);
tileUV(FOOTLOCKER, 1.3, 1.3);
const LOCKER = bevelBox(0.5, 1.8, 0.5, 0.02);
tileUV(LOCKER, 1.2, 2.4);

// HANGAR — interceptor ship on a pad + overhead crane.
const PAD = new CylinderGeometry(2.0, 2.05, 0.04, 48);
const PAD_RING = new CylinderGeometry(1.92, 1.92, 0.02, 48);
const FUSELAGE = new CylinderGeometry(0.22, 0.16, 2.4, 24);
const NOSE_CONE = new ConeGeometry(0.16, 0.5, 18);
const WING = bevelBox(1.7, 0.06, 0.62, 0.02);
const TAIL_FIN = bevelBox(0.06, 0.5, 0.45, 0.02);
const COCKPIT = new SphereGeometry(0.17, 16, 12);
const ENGINE_NACELLE = new CylinderGeometry(0.11, 0.1, 0.55, 14);
const ENGINE_GLOW = new CylinderGeometry(0.08, 0.08, 0.04, 14);
const LANDING_STRUT = new CylinderGeometry(0.025, 0.025, 1, 8);
const LANDING_FOOT = new CylinderGeometry(0.08, 0.08, 0.04, 10);
const CRANE_BEAM = bevelBox(2.2, 0.12, 0.14, 0.02);
const CRANE_HOIST = bevelBox(0.18, 0.14, 0.18, 0.02);
const TOOL_RACK = bevelBox(0.12, 1.3, 0.32, 0.02);
const FUEL_TANK = new CylinderGeometry(0.32, 0.32, 1.3, 16);
const BAY_POST = new CylinderGeometry(0.07, 0.07, 1, 10);

// RADAR — lathed dish on a mast + antenna arrays.
const MAST_BASE = new CylinderGeometry(0.18, 0.2, 0.1, 16);
const RADAR_MAST = new CylinderGeometry(0.06, 0.08, 2.2, 12);
const RADAR_DISH_POINTS: Vector2[] = [
  new Vector2(0.04, 0.22),
  new Vector2(0.12, 0.14),
  new Vector2(0.28, 0.04),
  new Vector2(0.46, 0.0),
  new Vector2(0.58, 0.06),
  new Vector2(0.62, 0.2),
];
const RADAR_DISH = new LatheGeometry(RADAR_DISH_POINTS, 28);
const ANTENNA_MAST = new CylinderGeometry(0.03, 0.03, 1.2, 8);
const ANTENNA_ARM = bevelBox(0.04, 0.04, 0.7, 0.006);
const RADAR_CONSOLE = bevelBox(0.95, 0.92, 0.52, 0.025);
const SWEEP_SCREEN = new PlaneGeometry(0.7, 0.42);

// REACTOR — cylindrical core + conduit pipes + cooling tanks.
const CORE = new CylinderGeometry(0.55, 0.6, 1.8, 40);
const CORE_TOP = new CylinderGeometry(0.6, 0.55, 0.16, 40);
const CORE_BASE_RING = new CylinderGeometry(0.72, 0.78, 0.22, 40);
const CONDUIT = new CylinderGeometry(0.09, 0.09, 1, 12);
const COOLING_TANK = new CylinderGeometry(0.36, 0.36, 1.5, 24);
const COOLING_CAP = new CylinderGeometry(0.38, 0.36, 0.1, 24);
const REACTOR_CONSOLE = bevelBox(0.9, 0.9, 0.5, 0.025);
const WARN_STRIPE = new BoxGeometry(0.45, 0.13, 0.05);

// CONTAINMENT — sealed holding cells + a facing control console. Modest reuse
// of the panel/bevel vocabulary rather than a bespoke sculpted set.
const CELL_BODY = bevelBox(0.6, 1.7, 0.5, 0.02);
tileUV(CELL_BODY, 1.2, 2.2);
const CELL_FIELD = new PlaneGeometry(0.42, 1.3);
const CELL_CONSOLE = bevelBox(0.9, 0.9, 0.5, 0.025);
// Captive silhouette (a hunched dark humanoid) shown when a cell is occupied.
const SIL_BODY = new CylinderGeometry(0.11, 0.17, 0.82, 12);
const SIL_HEAD = new SphereGeometry(0.12, 12, 10);

/** Violet-magenta psi glow for OCCUPIED containment cells (Style Bible endgame
 *  hue), distinct from the room's acid-green biohazard accent. */
const CONTAINMENT_VIOLET = 0xc86bff;
const CELL_VIOLET = {
  /** Bright neutralization field + status beacon for a held captive. */
  field: accentEmissive(CONTAINMENT_VIOLET, 1.3),
  beacon: accentEmissive(CONTAINMENT_VIOLET, 2.2),
  /** Dim, near-dark field/beacon for an empty cell. */
  fieldDim: accentEmissive(CONTAINMENT_VIOLET, 0.16),
  beaconDim: accentEmissive(CONTAINMENT_VIOLET, 0.3),
} as const;
/** Near-black captive body — reads as a silhouette against the violet field. */
const MAT_SILHOUETTE = new MeshStandardMaterial({
  color: BASE_PALETTE.rock,
  metalness: 0.1,
  roughness: 0.9,
});

// ---------------------------------------------------------------------------
// Composition helpers
// ---------------------------------------------------------------------------

/** Create a mesh from shared geometry/material, transform it, add to a group. */
function add(
  group: Group,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  position: Vec3,
  scale: Vec3 = [1, 1, 1],
  rotation: Vec3 = [0, 0, 0],
): Mesh {
  // Every interior geometry + material is a page-lifetime shared singleton (module
  // caches + the bevelBox/texture caches). Tag them so baseView's scene-teardown
  // (disposeObject) skips them — disposing these freed their GPU maps out from
  // under the NEXT dive, blacking out subsequent facility interiors.
  geometry.userData.shared = true;
  material.userData.shared = true;
  const mesh = new Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** Build the shared room shell (textured floor + faint teal floor grid + the
 *  back/left/right walls that enclose the room so nothing reads as a void). */
function addShell(group: Group): void {
  add(group, SHELL.floor, SHELL_MAT.floor, [0, -0.1, 0]);
  // Faint vector-console floor grid — reinforces the room's spatial read.
  const grid = new LineSegments(FLOOR_GRID_GEO, FLOOR_GRID_MAT);
  grid.geometry.userData.shared = true;
  grid.material.userData.shared = true;
  group.add(grid);
  add(group, SHELL.backWall, SHELL_MAT.wall, [0, ROOM_H / 2, -ROOM_D / 2]);
  add(group, SHELL.sideWall, SHELL_MAT.wall, [-ROOM_W / 2, ROOM_H / 2, 0]);
  add(group, SHELL.sideWall, SHELL_MAT.wall, [ROOM_W / 2, ROOM_H / 2, 0]);
  // Ceiling lid — caps the top so the hero camera frames a lit room, not props
  // floating in the black cavern void above the walls.
  add(group, SHELL.ceiling, SHELL_MAT.ceiling, [0, ROOM_H - WALL_T / 2, 0]);
}

// ---------------------------------------------------------------------------
// Interior LIGHTING RIG + MOTION (self-contained so an interior reads as a lit
// room the moment it mounts, independent of the hub's scene lights).
// ---------------------------------------------------------------------------

/**
 * Faint teal floor-grid line geometry across the shared room footprint, cached
 * once at module scope (mirrors every other interior geometry). disposeObject in
 * baseView disposes LineSegments geometry/material on teardown and three.js
 * re-uploads the shared resource on the next mount.
 */
function buildFloorGridGeo(): BufferGeometry {
  const hw = ROOM_W / 2;
  const hd = ROOM_D / 2;
  const y = 0.015; // just above the floor top (floor box top sits at y = 0)
  const step = 0.8;
  const pts: number[] = [];
  for (let x = -hw; x <= hw + 1e-3; x += step) pts.push(x, y, -hd, x, y, hd);
  for (let z = -hd; z <= hd + 1e-3; z += step) pts.push(-hw, y, z, hw, y, z);
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute(pts, 3));
  return geo;
}
const FLOOR_GRID_GEO = buildFloorGridGeo();
const FLOOR_GRID_MAT = new LineBasicMaterial({
  color: BASE_PALETTE.floorLine,
  transparent: true,
  opacity: 0.22,
});

/**
 * Give an interior a lighting rig so its shell/props read as a real room (never
 * a black void): a cool hemisphere fill (the >=25 luminance floor), a cool
 * overhead room light, and two warm/accent PRACTICALS that contribute actual
 * light (a warm desk lamp + the facility-accent hero glow). All lights are
 * children of the interior Group, so baseView's remove()/disposeObject teardown
 * takes them with the diorama — no leak (they cast no shadows, hold no GPU map).
 */
function addInteriorLighting(group: Group, role: FacilityRole): void {
  // A FIXED four-light rig for EVERY interior (identical count across all roles,
  // so a dive never changes the renderer's visible-light configuration between
  // rooms — no per-room shader recompile). The room is now a closed shell (floor
  // + walls + ceiling) that occludes the hub's external key/rim lights, so this
  // rig alone must carry the room; it is tuned to keep every surface well clear
  // of black (the >=0.25 luminance floor the brief calls for).
  // Cool sky / warm ground hemisphere — the ambient fill that lifts the whole
  // shell (walls/floor/ceiling) off pure black while keeping the console-cool mood.
  const hemi = new HemisphereLight(0x9fb2cc, 0x2a2018, 2.1);
  hemi.position.set(0, ROOM_H, 0);
  group.add(hemi);
  // Cool overhead room light (the strip-light housings sit here) — lifted in
  // intensity now that the ceiling seals off the hub key light.
  const overhead = new PointLight(0xe6eef4, 16, 15, 2);
  overhead.position.set(0, ROOM_H - 0.35, 0.4);
  group.add(overhead);
  // Warm desk practical toward the open front-right (a lamp/console pool).
  const warm = new PointLight(0xffcf9a, 7.5, 9, 2);
  warm.position.set(1.7, 1.25, 1.2);
  group.add(warm);
  // Facility-accent hero glow near the room's centre feature (screen/vat/core).
  const accent = new PointLight(BASE_PALETTE.accent[role], 5.5, 8, 2);
  accent.position.set(0, 1.15, -0.2);
  group.add(accent);
}

/** Whether the OS/browser asks for reduced motion — cached once (mirrors the
 *  flag baseView captures at construction). Gates every decorative accent. */
let reducedMotionCache: boolean | null = null;
function prefersReducedMotion(): boolean {
  if (reducedMotionCache === null) {
    reducedMotionCache =
      typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  }
  return reducedMotionCache;
}

/** ms -> s for performance.now()-driven decorative motion. */
const MS_TO_S = 0.001;

type Axis = "x" | "y" | "z";

/**
 * Attach a decorative, reduced-motion-gated animation to a single mesh via
 * onBeforeRender (fires each frame the mesh renders — no baseView frame-loop
 * wiring needed, no per-frame allocation, GC'd with the mesh on teardown).
 */
function driveSpin(mesh: Mesh, axis: Axis, speed: number): void {
  const base = mesh.rotation[axis];
  mesh.onBeforeRender = () => {
    if (prefersReducedMotion()) return;
    mesh.rotation[axis] = base + performance.now() * MS_TO_S * speed;
  };
}
function drivePulse(mesh: Mesh, amp: number, periodS: number): void {
  const bx = mesh.scale.x;
  const by = mesh.scale.y;
  const bz = mesh.scale.z;
  const w = (Math.PI * 2) / periodS;
  mesh.onBeforeRender = () => {
    if (prefersReducedMotion()) return;
    const s = 1 + Math.sin(performance.now() * MS_TO_S * w) * amp;
    mesh.scale.set(bx * s, by * s, bz * s);
  };
}
function driveSlide(mesh: Mesh, axis: Axis, amp: number, periodS: number): void {
  const base = mesh.position[axis];
  const w = (Math.PI * 2) / periodS;
  mesh.onBeforeRender = () => {
    if (prefersReducedMotion()) return;
    mesh.position[axis] = base + Math.sin(performance.now() * MS_TO_S * w) * amp;
  };
}

/**
 * Build one server/equipment rack: extruded beveled cabinet (panel texture) with
 * a glowing readout screen and a column of status lights. Status dots tag
 * themselves userData.interiorBlink so the baseView frame loop may animate them
 * (they already read as a live board statically via on/dim variation). `accentHex`
 * recolors the screen + status lights so a rack reads in any facility's accent
 * (default lab cyan — the hero rack row stays identical).
 */
function buildRack(screenLabel: string, accentHex: number = BASE_PALETTE.accent.lab): Group {
  const rack = new Group();
  const statusOn = accentEmissive(accentHex, 1.8);
  const statusDim = accentEmissive(accentHex, 0.45);
  // Cabinet body — base sits on the floor (geometry is centered, so y = H/2).
  add(rack, RACK_BODY, MAT.panel, [0, RACK_H / 2, 0]);
  add(rack, RACK_BASE, MAT.panelDark, [0, 0.05, 0]);
  add(rack, RACK_CAP, MAT.panelDark, [0, RACK_H + 0.04, 0]);
  // Recessed glowing screen on the front face.
  const screen = add(
    rack,
    RACK_SCREEN,
    screenMaterial(accentHex, screenLabel),
    [0, RACK_H * 0.56, RACK_D / 2 + 0.012],
  );
  screen.userData.interiorScreen = true;
  // Status-light column down the right edge — on/dim variation reads as live.
  const heights = [0.28, 0.5, 0.72, 0.94, 1.16, 1.38, 1.6];
  for (let i = 0; i < heights.length; i++) {
    const lit = i % 3 !== 2; // every 3rd dot dim → irregular, active feel
    const dot = add(
      rack,
      DOT,
      lit ? statusOn : statusDim,
      [RACK_W * 0.34, heights[i]!, RACK_D / 2 + 0.02],
    );
    dot.userData.interiorBlink = true;
  }
  return rack;
}

/** Central glowing research vat: lathed flask with emissive fluid + steel frame. */
function buildVat(): Group {
  const vat = new Group();
  // Steel support base + 4 corner posts + top ring cap.
  add(vat, DISK, MAT.panelDark, [0, 0.04, 0], [1.0, 1, 1.0]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    const r = 0.5;
    add(vat, VAT_FRAME_POST, MAT.worn, [Math.cos(a) * r, 0.7, Math.sin(a) * r]);
  }
  add(vat, DISK, MAT.panel, [0, 1.36, 0], [1.05, 1, 1.05]);
  // Dark metal flask casing (the lathed body).
  add(vat, VAT_FLASK, MAT.panelDark, [0, 0.0, 0], [1.0, 1.0, 1.0]);
  // Glowing research fluid inside — slightly smaller, bright cyan emissive.
  // Tagged interiorPulse so the view loop can breathe its intensity.
  const fluid = add(
    vat,
    VAT_FLASK,
    accentEmissive(BASE_PALETTE.accent.lab, 2.3),
    [0, 0.02, 0],
    [0.9, 0.94, 0.9],
  );
  fluid.userData.interiorPulse = true;
  // Bright cap beacon on top.
  add(vat, BEAD, STATUS.on, [0, 1.3, 0]);
  return vat;
}

/** Workbench with instruments + a readout screen, plus a stool. */
function buildWorkbench(): Group {
  const bench = new Group();
  add(bench, BENCH_TOP, MAT.panel, [0, 0.82, 0]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(bench, BENCH_LEG, MAT.worn, [sx * 0.52, 0.39, sz * 0.24]);
    }
  }
  // Instrument block + a small glowing readout screen on a stand.
  add(bench, bevelBox(0.22, 0.16, 0.18), MAT.worn, [0.34, 0.94, 0]);
  add(bench, BENCH_SCREEN, screenMaterial(BASE_PALETTE.accent.lab, "ANALYSIS"), [
    -0.28,
    1.06,
    0.0,
  ]);
  // Stool tucked in front.
  add(bench, STOOL_SEAT, MAT.worn, [0.1, 0.46, 0.42]);
  add(bench, STOOL_LEG, MAT.worn, [0.1, 0.23, 0.42]);
  add(bench, DISK, MAT.worn, [0.1, 0.02, 0.42], [0.22, 1, 0.22]);
  return bench;
}

/**
 * Build a stacked BUNK BED: four corner posts, two mattress platforms, lower +
 * upper bunks (mattress + pillow + blanket each), an upper safety rail, and a
 * side ladder. Matte fabric materials (linen/pillow/blanket) read as bedding,
 * not glowing props. Origin at floor level; footprint ~0.9 x 1.95.
 */
function buildBunkBed(): Group {
  const bed = new Group();
  const postH = 1.92;
  // Four corner posts.
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(bed, BED_POST, MAT_PROPS.frame, [sx * 0.43, postH / 2, sz * 0.92], [1, postH, 1]);
    }
  }
  // Mattress platforms (recessed frames the mattresses rest on).
  add(bed, BED_FRAME, MAT_PROPS.frame, [0, 0.48, 0]);
  add(bed, BED_FRAME, MAT_PROPS.frame, [0, 1.58, 0]);
  // Lower bunk bedding.
  add(bed, MATTRESS, MAT_PROPS.linen, [0, 0.57, 0]);
  add(bed, PILLOW, MAT_PROPS.pillow, [-0.1, 0.66, 0.72]);
  add(bed, BLANKET, MAT_PROPS.blanket, [0, 0.65, -0.35]);
  // Upper bunk bedding.
  add(bed, MATTRESS, MAT_PROPS.linen, [0, 1.67, 0]);
  add(bed, PILLOW, MAT_PROPS.pillow, [-0.1, 1.76, 0.72]);
  add(bed, BLANKET, MAT_PROPS.blanket, [0, 1.75, -0.35]);
  // Upper safety rail along the open side (head-to-foot).
  add(bed, BED_RAIL, MAT_PROPS.frame, [-0.43, 1.78, 0]);
  // Ladder on the opposite side: one rail + three rungs.
  add(bed, LADDER_RAIL, MAT_PROPS.frame, [0.46, 0.95, 0.78], [1, 1.9, 1]);
  for (const ry of [0.45, 0.9, 1.35]) {
    add(bed, LADDER_RUNG, MAT_PROPS.frame, [0.42, ry, 0.78]);
  }
  return bed;
}

// ---------------------------------------------------------------------------
// Role interiors
// ---------------------------------------------------------------------------

/**
 * Build the LAB interior — the hero diorama. A textured concrete-floor room
 * (open front) walled in riveted steel panel, dense with: a row of server racks
 * along the back wall + a side rack, a central glowing research vat, a
 * workbench with instruments and a screen, overhead strip-light beams, a cyan
 * accent work-light, and prop density (crates, pillar, cable trays).
 */
function buildLabInterior(): Group {
  const g = new Group();
  addShell(g);

  // Back-wall server rack row (3 racks) — the lab's signature equipment wall.
  const rackZ = -ROOM_D / 2 + RACK_D / 2 + WALL_T / 2;
  for (let i = 0; i < 3; i++) {
    const rack = buildRack(`SRV-${i + 1}`);
    rack.position.set(-0.95 + i * 0.95, 0, rackZ);
    g.add(rack);
  }
  // One side rack against the left wall, facing the room (+X).
  const sideRack = buildRack("AUX");
  sideRack.position.set(-ROOM_W / 2 + RACK_D / 2 + WALL_T / 2, 0, 0.6);
  sideRack.rotation.y = Math.PI / 2;
  g.add(sideRack);

  // Central glowing research vat — the room's hero element.
  const vat = buildVat();
  vat.position.set(0, 0, -0.2);
  vat.scale.setScalar(1.35);
  g.add(vat);

  // Workbench in the right-front quadrant.
  const bench = buildWorkbench();
  bench.position.set(1.85, 0, 1.15);
  bench.rotation.y = -Math.PI / 7;
  g.add(bench);

  // Lab centrifuge on a plinth (front-centre open floor) — a spinning rotor is
  // this room's motion accent (reduced-motion-gated inside driveSpin).
  add(g, DISK, MAT.panelDark, [0.7, 0.05, 1.6], [0.6, 1, 0.6]);
  add(g, POST, MAT.worn, [0.7, 0.3, 1.6], [1.1, 0.5, 1.1]);
  const centrifuge = add(g, bevelBox(0.44, 0.12, 0.13, 0.02), MAT.worn, [0.7, 0.6, 1.6]);
  driveSpin(centrifuge, "y", 3.0);

  // Overhead beams carrying strip lights (exposed — keeps the 3/4 sightline open).
  for (const sx of [-1, 1]) {
    add(g, BEAM, MAT.panel, [sx * 2.0, ROOM_H - 0.12, 0]);
    const strip = add(g, STRIP, MAT.stripLight, [sx * 2.0, ROOM_H - 0.2, 0]);
    strip.userData.interiorBlink = false;
  }
  // Cyan accent work-light mounted high on the right wall (over the bench).
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), ACCENT.lab.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    1.1,
  ]);

  // Props — crates, corner pillar, cable trays (density + cohesion).
  add(g, CRATE, MAT.worn, [-2.3, 0.25, 1.7]);
  add(g, CRATE, MAT.worn, [-2.0, 0.75, 1.9], [0.9, 0.9, 0.9], [0, 0.4, 0]);
  add(g, PILLAR, MAT.panel, [ROOM_W / 2 - 0.28, ROOM_H / 2, -ROOM_D / 2 + 0.28], [1, ROOM_H, 1]);
  // Cable tray along the left wall near the racks, with a few drooping cables.
  const tray = add(g, CABLE_TRAY, MAT.worn, [-ROOM_W / 2 + 0.18, 1.7, -1.4]);
  tray.rotation.z = Math.PI / 2;
  for (let i = 0; i < 4; i++) {
    const c = add(
      g,
      CABLE,
      MAT.panelDark,
      [-ROOM_W / 2 + 0.18, 1.5 - i * 0.02, -1.9 + i * 0.32],
      [1, 1, 1],
      [0.15, 0, 0],
    );
    c.scale.y = 0.5;
  }

  return g;
}

/**
 * Build the COMMAND interior — blue holographic war room. A central holo
 * projection table (emissive disk + tactical map + light beam to the ceiling),
 * three curved console desks arranged in an arc facing it, a large status wall
 * display, a commander podium, overhead strip lights, and prop density.
 */
function buildCommandInterior(): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.command;
  const accent = ACCENT.command;
  addShell(g);

  // Central holographic projection table — the room's hero.
  add(g, DISK, MAT.panelDark, [0, 0.4, 0], [1.6, 16, 1.6]); // pedestal
  add(g, DISK, MAT.panel, [0, 0.83, 0], [1.5, 1, 1.5]); // tabletop
  const rim = add(g, HOLO_RIM, accent.glow, [0, 0.85, 0]);
  rim.userData.interiorPulse = true;
  const map = add(
    g,
    TACTICAL_MAP,
    screenMaterial(hex, "TACTICAL"),
    [0, 0.86, 0],
    [1, 1, 1],
    [-Math.PI / 2, 0, 0],
  );
  map.userData.interiorScreen = true;
  const beam = add(g, HOLO_BEAM, accent.beacon, [0, 1.85, 0], [1, 1.95, 1]);
  beam.userData.interiorPulse = true;
  // Motion accent: the holo projection beam breathes vertically (>=2s period).
  drivePulse(beam, 0.06, 3.0);

  // Three console desks arrayed in an arc facing the table (front, open side).
  const arcZ = 1.35;
  const arcOffsets: ReadonlyArray<readonly [number, number]> = [
    [-1.55, 0.5],
    [0, 0],
    [1.55, 0.5],
  ];
  for (const [x, yaw] of arcOffsets) {
    add(g, CONSOLE_DESK, MAT.panel, [x, 0.34, arcZ], [1, 1, 1], [0, yaw, 0]);
    const screen = add(
      g,
      DESK_SCREEN,
      screenMaterial(hex, "OPS"),
      [x, 0.74, arcZ + 0.18],
      [1, 1, 1],
      [-0.5, yaw, 0],
    );
    screen.userData.interiorScreen = true;
    // Stool tucked at each desk.
    add(g, STOOL_SEAT, MAT.worn, [x, 0.46, arcZ + 0.62]);
    add(g, STOOL_LEG, MAT.worn, [x, 0.23, arcZ + 0.62]);
  }

  // Large status wall display high on the back wall.
  const wall = add(
    g,
    STATUS_WALL,
    screenMaterial(hex, "STATUS"),
    [0, ROOM_H * 0.72, -ROOM_D / 2 + WALL_T / 2 + 0.02],
  );
  wall.userData.interiorScreen = true;

  // Commander podium at the back-left, facing the room.
  add(g, PODIUM, MAT.panelDark, [-2.25, 0.5, -1.5]);
  const podiumScreen = add(
    g,
    PODIUM_SCREEN,
    screenMaterial(hex, "CMDR"),
    [-2.25, 0.72, -1.29],
    [1, 1, 1],
    [-0.2, 0, 0],
  );
  podiumScreen.userData.interiorScreen = true;

  // Overhead strip-light beams (exposed).
  for (const sx of [-1, 1]) {
    add(g, BEAM, MAT.panel, [sx * 2.0, ROOM_H - 0.12, 0]);
    add(g, STRIP, MAT.stripLight, [sx * 2.0, ROOM_H - 0.2, 0]);
  }
  // Blue accent work-light on the right wall.
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    0.4,
  ]);

  // Status beacons around the table rim + a floor beacon.
  for (const sx of [-1, 0, 1]) {
    add(g, DOT, accent.beacon, [sx * 0.6, 0.88, 0], [1, 1, 1], [0, 0, 0]);
  }
  add(g, POST, accent.glow, [ROOM_W / 2 - 0.4, 0.75, -ROOM_D / 2 + 0.5], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [ROOM_W / 2 - 0.4, 1.5, -ROOM_D / 2 + 0.5]);

  // Props — crates + corner pillars.
  add(g, CRATE, MAT.worn, [2.2, 0.25, 1.5]);
  add(g, CRATE, MAT.worn, [2.35, 0.75, 1.7], [0.9, 0.9, 0.9]);
  add(g, PILLAR, MAT.panel, [ROOM_W / 2 - 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);
  add(g, PILLAR, MAT.panel, [-ROOM_W / 2 + 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build the WORKSHOP interior — amber fabrication bay. An overhead fabrication
 * gantry carrying a robotic arm, a glowing forge/furnace with a chimney, a
 * workbench with tools + readout, raw-material crates, hanging cable trays, and
 * prop density.
 */
function buildWorkshopInterior(): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.workshop;
  const accent = ACCENT.workshop;
  addShell(g);

  // Fabrication gantry: four posts + overhead beam frame.
  const gx = 1.05;
  const gz = [-1.35, 0.5];
  for (const sx of [-1, 1]) {
    for (const z of gz) {
      add(g, GANTRY_POST, MAT_PROPS.frame, [sx * gx, ROOM_H / 2, z], [1, ROOM_H, 1]);
    }
  }
  for (const z of gz) {
    add(g, GANTRY_BEAM_X, MAT.panel, [0, ROOM_H - 0.08, z]);
  }
  add(g, GANTRY_BEAM_Z, MAT.panel, [0, ROOM_H - 0.08, -0.42]);
  // Motion accent: a service carriage slides along the gantry beam (>=2s period).
  const carriage = add(g, bevelBox(0.3, 0.14, 0.3, 0.02), MAT.worn, [0, ROOM_H - 0.22, -0.42]);
  driveSlide(carriage, "x", 0.9, 4.0);

  // Robotic arm hanging from the gantry's center beam.
  add(g, bevelBox(0.22, 0.1, 0.22, 0.02), MAT.worn, [0, ROOM_H - 0.18, -0.42]); // sled
  add(g, BEAD, MAT.worn, [0, ROOM_H - 0.4, -0.42]); // shoulder
  add(g, bevelBox(0.1, 0.5, 0.1, 0.015), MAT_PROPS.frame, [0, ROOM_H - 0.68, -0.42], [1, 1, 1], [0.3, 0, 0]);
  add(g, BEAD, MAT.worn, [0, ROOM_H - 0.92, -0.42]); // elbow
  add(g, bevelBox(0.08, 0.42, 0.08, 0.012), MAT_PROPS.frame, [0, ROOM_H - 1.15, -0.42], [1, 1, 1], [-0.4, 0, 0]);
  add(g, bevelBox(0.14, 0.1, 0.14, 0.02), MAT.worn, [0, ROOM_H - 1.38, -0.42]); // effector
  const torch = add(g, DOT, accent.beacon, [0, ROOM_H - 1.5, -0.42]); // welder tip
  torch.userData.interiorPulse = true;

  // Forge / furnace against the left wall — body, glowing mouth, chimney, beacon.
  add(g, FORGE, MAT.panelDark, [-2.2, 0.475, -0.6]);
  const glow = add(g, FORGE_GLOW, accentEmissive(hex, 2.5), [-2.2, 0.5, -0.275]);
  glow.userData.interiorPulse = true;
  add(g, FORGE_STACK, MAT.worn, [-2.2, 1.5, -0.6], [1, 1.9, 1]);
  add(g, BEAD, accent.beacon, [-2.2, 1.95, -0.6]);
  add(g, DISK, MAT_PROPS.dark, [-2.2, 0.04, -0.6], [1.4, 1, 1.6]);

  // Workbench in the right-front quadrant — top, legs, amber screen, tools.
  add(g, BENCH_TOP, MAT.panel, [1.9, 0.82, 0.7]);
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      add(g, BENCH_LEG, MAT.worn, [1.9 + sx * 0.52, 0.39, 0.7 + sz * 0.24]);
    }
  }
  const benchScreen = add(
    g,
    BENCH_SCREEN,
    screenMaterial(hex, "MFG"),
    [1.6, 1.06, 0.7],
    [1, 1, 1],
    [0, 0.6, 0],
  );
  benchScreen.userData.interiorScreen = true;
  // Tools on the bench (lathe-style instruments).
  add(g, BEAD, MAT_PROPS.frame, [2.15, 0.92, 0.5]);
  add(g, FORGE_TONGUE, MAT_PROPS.dark, [1.7, 0.94, 0.9], [1, 1, 1], [Math.PI / 2, 0, 0]);
  add(g, bevelBox(0.18, 0.06, 0.12, 0.01), MAT.worn, [2.2, 0.89, 0.9]);

  // Raw-material crates stacked at the front-left.
  add(g, CRATE, MAT.worn, [-1.4, 0.25, 1.6]);
  add(g, CRATE, MAT.worn, [-1.0, 0.25, 1.85]);
  add(g, CRATE, MAT.worn, [-1.2, 0.75, 1.75], [0.9, 0.9, 0.9]);

  // Hanging cable trays + drooping cables near the gantry.
  for (const z of [-1.0, 0.2]) {
    add(g, CABLE_TRAY, MAT.worn, [0, ROOM_H - 0.3, z], [1, 1, 1], [Math.PI / 2, 0, 0]);
  }
  for (let i = 0; i < 3; i++) {
    const c = add(g, CABLE, MAT.panelDark, [-0.5 + i * 0.5, ROOM_H - 0.55, -0.4], [1, 1, 1], [0.2, 0, 0]);
    c.scale.y = 0.6;
  }

  // Overhead strip light + amber wall work-light + status beacons.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 1.6]);
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    -0.8,
  ]);
  add(g, POST, accent.glow, [ROOM_W / 2 - 0.4, 0.75, -ROOM_D / 2 + 0.5], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [ROOM_W / 2 - 0.4, 1.5, -ROOM_D / 2 + 0.5]);
  add(g, PILLAR, MAT.panel, [-ROOM_W / 2 + 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build the BARRACKS interior — warm-white living quarters. Two stacked bunk
 * beds (mattresses/pillows/blankets + ladders), footlockers, personal lockers
 * against the back wall, warm standing lamps, personal items, and warm overhead
 * lighting.
 */
function buildBarracksInterior(): Group {
  const g = new Group();
  const warm = accentEmissive(BASE_PALETTE.accent.barracks, 2.1);
  addShell(g);

  // Two bunk beds against the side walls, facing the room.
  const bedL = buildBunkBed();
  bedL.position.set(-2.0, 0, -0.3);
  g.add(bedL);
  const bedR = buildBunkBed();
  bedR.position.set(2.0, 0, -0.3);
  bedR.rotation.y = Math.PI;
  g.add(bedR);

  // Footlockers at the foot of each bed.
  add(g, FOOTLOCKER, MAT_PROPS.frame, [-2.0, 0.2, 0.9]);
  add(g, FOOTLOCKER, MAT_PROPS.frame, [2.0, 0.2, 0.9]);
  // Personal items atop the footlockers.
  add(g, bevelBox(0.16, 0.1, 0.16, 0.01), MAT_PROPS.pillow, [-1.75, 0.45, 0.9]);
  add(g, bevelBox(0.14, 0.14, 0.14, 0.01), MAT_PROPS.blanket, [1.8, 0.47, 0.9]);

  // Personal lockers along the back wall.
  add(g, LOCKER, MAT_PROPS.frame, [-0.7, 0.9, -ROOM_D / 2 + 0.28]);
  add(g, LOCKER, MAT_PROPS.frame, [0.7, 0.9, -ROOM_D / 2 + 0.28]);

  // Warm standing lamps between the beds — a slow paired breathe is this quiet
  // room's motion accent (gentle, >=3s period, reduced-motion-gated).
  for (const x of [-0.6, 0.6]) {
    add(g, POST, MAT_PROPS.frame, [x, 0.9, -0.3], [1, 1.8, 1]);
    const lamp = add(g, BEAD, warm, [x, 1.85, -0.3], [1.4, 1, 1.4]);
    drivePulse(lamp, 0.14, 3.6);
  }

  // Warm overhead strip lighting (not the cool strip) + a corner pillar.
  add(g, STRIP, warm, [0, ROOM_H - 0.2, 0]);
  add(g, PILLAR, MAT.panel, [ROOM_W / 2 - 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build the HANGAR interior — green interceptor bay. A sculpted interceptor
 * (fuselage + nose cone + swept wings + cockpit + twin engines + landing gear)
 * parked on a marked pad, an overhead gantry crane with a hoist, a tool rack,
 * horizontal fuel tanks with a feed line, bay-door posts, and prop density.
 */
function buildHangarInterior(): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.hangar;
  const accent = ACCENT.hangar;
  addShell(g);

  // Landing pad — concrete disk with a painted emissive ring.
  add(g, PAD, MAT.concrete, [0, 0.02, -0.2]);
  const ring = add(g, PAD_RING, accent.glow, [0, 0.05, -0.2]);
  ring.userData.interiorPulse = true;

  // Interceptor fuselage (cylinder laid along Z) + nose cone + tail fin.
  const shipY = 0.75;
  add(g, FUSELAGE, MAT.panel, [0, shipY, 0], [1, 1, 1], [Math.PI / 2, 0, 0]);
  add(g, NOSE_CONE, MAT.panel, [0, shipY, 1.45], [1, 1, 1], [Math.PI / 2, 0, 0]);
  add(g, TAIL_FIN, MAT_PROPS.frame, [0, shipY + 0.28, -1.15]);
  // Swept wings.
  add(g, WING, MAT.panel, [-1.05, shipY - 0.04, -0.15], [1, 1, 1], [0, -0.35, 0]);
  add(g, WING, MAT.panel, [1.05, shipY - 0.04, -0.15], [1, 1, 1], [0, 0.35, 0]);
  // Cockpit canopy.
  add(g, COCKPIT, MAT_PROPS.dark, [0, shipY + 0.16, 0.55]);
  // Twin engine nacelles + glowing exhausts.
  for (const sx of [-1, 1]) {
    add(g, ENGINE_NACELLE, MAT_PROPS.dark, [sx * 0.28, shipY, -1.2], [1, 1, 1], [Math.PI / 2, 0, 0]);
    const exh = add(
      g,
      ENGINE_GLOW,
      accentEmissive(hex, 2.6),
      [sx * 0.28, shipY, -1.5],
      [1, 1, 1],
      [Math.PI / 2, 0, 0],
    );
    exh.userData.interiorPulse = true;
  }
  // Landing gear — three struts with foot pads.
  for (const gear of [
    [-0.5, 0.7],
    [0.5, 0.7],
    [0, -0.9],
  ] as const) {
    add(g, LANDING_STRUT, MAT_PROPS.frame, [gear[0], 0.36, gear[1]], [1, 0.72, 1]);
    add(g, LANDING_FOOT, MAT_PROPS.dark, [gear[0], 0.04, gear[1]]);
  }

  // Overhead gantry crane along the left wall — posts + rail + hoist + hook.
  for (const z of [-1.5, 1.0]) {
    add(g, BAY_POST, MAT_PROPS.frame, [-2.3, ROOM_H / 2, z], [1, ROOM_H, 1]);
  }
  add(g, CRANE_BEAM, MAT.panel, [-2.3, ROOM_H - 0.1, -0.25], [1, 1, 1], [0, Math.PI / 2, 0]);
  add(g, CRANE_HOIST, MAT.worn, [-1.4, ROOM_H - 0.45, -0.25]);
  add(g, BEAD, MAT_PROPS.dark, [-1.4, ROOM_H - 0.75, -0.25]);
  // Motion accent: a bright service light travels along the crane rail (>=2s).
  const service = add(g, BEAD, accent.beacon, [-1.4, ROOM_H - 0.58, -0.25], [1.2, 1, 1.2]);
  driveSlide(service, "z", 1.0, 5.0);

  // Tool rack against the right wall + tools.
  add(g, TOOL_RACK, MAT_PROPS.frame, [2.45, 0.65, -0.4]);
  for (let i = 0; i < 3; i++) {
    add(g, ANTENNA_MAST, MAT_PROPS.dark, [2.3, 0.5 + i * 0.32, -0.4 + i * 0.12], [1, 0.45, 1]);
  }

  // Horizontal fuel tanks in the back-right corner + feed pipe.
  add(g, FUEL_TANK, MAT_PROPS.frame, [1.7, 0.65, -1.7], [1, 1, 1], [0, 0, Math.PI / 2]);
  add(g, FUEL_TANK, MAT_PROPS.frame, [1.7, 1.15, -1.7], [0.8, 0.8, 0.8], [0, 0, Math.PI / 2]);
  add(g, CONDUIT, MAT_PROPS.dark, [1.2, 0.65, -1.7], [1.2, 1, 1], [0, 0, Math.PI / 2]);
  add(g, COOLING_CAP, accent.glow, [1.7, 1.45, -1.7], [0.9, 1, 0.9]);

  // Bay-door frame posts at the front opening + green wall work-light.
  add(g, BAY_POST, MAT_PROPS.frame, [-ROOM_W / 2 + 0.3, ROOM_H / 2, ROOM_D / 2 - 0.3], [1, ROOM_H, 1]);
  add(g, BAY_POST, MAT_PROPS.frame, [ROOM_W / 2 - 0.3, ROOM_H / 2, ROOM_D / 2 - 0.3], [1, ROOM_H, 1]);
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    1.4,
  ]);

  // Overhead strip + pad status beacons + a prop crate.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 1.4]);
  add(g, DOT, accent.beacon, [-1.6, 0.08, -1.8]);
  add(g, DOT, accent.beacon, [1.6, 0.08, -1.8]);
  add(g, CRATE, MAT.worn, [-2.3, 0.25, 1.6]);

  return g;
}

/**
 * Build the RADAR interior — purple sensor command. A large lathed radar dish on
 * a mast (tilted to face the room, tagged for future rotation), antenna arrays
 * along the walls, a server rack, a console with a sweeping display, and prop
 * density.
 */
function buildRadarInterior(): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.radar;
  const accent = ACCENT.radar;
  addShell(g);

  // Radar mast + lathed dish (back-center), tilted to face the room.
  const mx = 0;
  const mz = -0.7;
  add(g, MAST_BASE, MAT_PROPS.dark, [mx, 0.05, mz]);
  add(g, RADAR_MAST, MAT.panelDark, [mx, 1.1, mz]);
  const dish = add(
    g,
    RADAR_DISH,
    MAT.panel,
    [mx, 2.25, mz + 0.15],
    [1, 1, 1],
    [-0.85, 0, 0],
  );
  // Motion accent: the dish sweeps by spinning about the vertical mast axis.
  // YXZ Euler order applies the fixed tilt (x) BEFORE the animated spin (y) so
  // the tilted dish rotates cleanly on the mast instead of coning.
  dish.rotation.order = "YXZ";
  dish.userData.interiorRotor = { axis: "y", speed: 0.4 };
  driveSpin(dish, "y", 0.5);
  // Emissive emitter at the dish's focal point.
  const emitter = add(g, BEAD, accent.beacon, [mx, 2.32, mz + 0.35], [1.3, 1, 1.3]);
  emitter.userData.interiorPulse = true;
  // Support arm bracing the dish to the mast.
  add(g, ANTENNA_ARM, MAT_PROPS.frame, [mx, 2.05, mz + 0.05], [1, 1, 1], [0.6, 0, 0]);

  // Three antenna arrays along the walls (mast + two crossed arms).
  const arraySpots: ReadonlyArray<readonly [number, number]> = [
    [-2.3, -1.6],
    [2.3, -1.6],
    [-2.3, 1.4],
  ];
  for (const [x, z] of arraySpots) {
    add(g, ANTENNA_MAST, MAT_PROPS.frame, [x, 1.0, z], [1, 1.7, 1]);
    add(g, ANTENNA_ARM, MAT_PROPS.frame, [x, 1.55, z]);
    add(g, ANTENNA_ARM, MAT_PROPS.frame, [x, 1.3, z], [1, 1, 1], [0, Math.PI / 2, 0]);
    add(g, DOT, accent.beacon, [x, 1.78, z]);
  }

  // Server rack against the right wall (purple readouts).
  const rack = buildRack("SRV-1", hex);
  rack.position.set(ROOM_W / 2 - RACK_D / 2 - WALL_T / 2, 0, 0.3);
  rack.rotation.y = -Math.PI / 2;
  g.add(rack);

  // Console with a sweeping display (front-left).
  add(g, RADAR_CONSOLE, MAT.panel, [-1.9, 0.46, 1.1]);
  const sweep = add(g, SWEEP_SCREEN, screenMaterial(hex, "SWEEP"), [-1.9, 0.96, 1.37]);
  sweep.userData.interiorScreen = true;

  // Overhead strip + purple wall work-light + floor beacon.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 0]);
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    -0.6,
  ]);
  add(g, POST, accent.glow, [-ROOM_W / 2 + 0.4, 0.75, -ROOM_D / 2 + 0.5], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [-ROOM_W / 2 + 0.4, 1.5, -ROOM_D / 2 + 0.5]);

  // Cable tray + drooping cables + corner pillar.
  add(g, CABLE_TRAY, MAT.worn, [0, ROOM_H - 0.35, -1.8], [1, 1, 1], [Math.PI / 2, 0, 0]);
  for (let i = 0; i < 2; i++) {
    const c = add(g, CABLE, MAT.panelDark, [-0.3 + i * 0.6, ROOM_H - 0.6, -1.8], [1, 1, 1], [0.2, 0, 0]);
    c.scale.y = 0.6;
  }
  add(g, PILLAR, MAT.panel, [ROOM_W / 2 - 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build the REACTOR interior — yellow power core. A large cylindrical reactor
 * core (dark casing + pulsing emissive inner column), conduit pipes routing to
 * the walls, cooling tanks in the corners, two control consoles, hazard
 * warning-stripes along the wall base, and prop density.
 */
function buildReactorInterior(): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.reactor;
  const accent = ACCENT.reactor;
  addShell(g);

  // Reactor core — base ring, dark casing, pulsing inner column, cap, beacon.
  add(g, CORE_BASE_RING, MAT_PROPS.dark, [0, 0.11, 0]);
  add(g, CORE, MAT_PROPS.dark, [0, 1.05, 0]);
  const inner = add(
    g,
    CORE,
    accentEmissive(hex, 2.2),
    [0, 1.05, 0],
    [0.78, 0.96, 0.78],
  );
  inner.userData.interiorPulse = true;
  // Motion accent: the core breathes (scale pulse, >=2s period).
  drivePulse(inner, 0.045, 2.4);
  add(g, CORE_TOP, MAT_PROPS.dark, [0, 2.0, 0]);
  add(g, BEAD, accent.beacon, [0, 2.12, 0]);

  // Hazard band around the core base.
  add(g, DISK, accent.glow, [0, 0.24, 0], [1.5, 1, 1.5]);

  // Conduit pipes routing from the core out toward the walls (horizontal).
  add(g, CONDUIT, MAT_PROPS.frame, [-1.0, 1.1, 0], [1.4, 1, 1], [0, 0, Math.PI / 2]);
  add(g, CONDUIT, MAT_PROPS.frame, [1.0, 1.1, 0], [1.4, 1, 1], [0, 0, Math.PI / 2]);
  add(g, CONDUIT, MAT_PROPS.frame, [0, 1.1, -1.1], [1.4, 1, 1], [Math.PI / 2, 0, 0]);
  add(g, CONDUIT, MAT_PROPS.frame, [-1.0, 1.5, 0], [1.4, 1, 1], [0, 0, Math.PI / 2]);

  // Cooling tanks in the back corners + caps.
  for (const sx of [-1, 1]) {
    add(g, COOLING_TANK, MAT_PROPS.frame, [sx * 1.9, 0.75, -1.7]);
    add(g, COOLING_CAP, accent.glow, [sx * 1.9, 1.55, -1.7], [0.95, 1, 0.95]);
  }

  // Two control consoles (front-left + front-right) facing the room.
  for (const sx of [-1, 1]) {
    add(g, REACTOR_CONSOLE, MAT.panel, [sx * 1.7, 0.45, 1.3], [1, 1, 1], [0, sx * 0.5, 0]);
    const scr = add(
      g,
      BENCH_SCREEN,
      screenMaterial(hex, "CORE"),
      [sx * 1.7, 0.86, 1.56],
      [1, 1, 1],
      [-0.35, sx * 0.5, 0],
    );
    scr.userData.interiorScreen = true;
  }

  // Hazard warning-stripes along the back wall base (alternating yellow/dark).
  for (let i = 0; i < 7; i++) {
    const x = -1.8 + i * 0.6;
    add(g, WARN_STRIPE, i % 2 === 0 ? accentEmissive(hex, 0.7) : MAT_PROPS.dark, [
      x,
      0.32,
      -ROOM_D / 2 + 0.04,
    ]);
  }

  // Overhead strip + yellow wall work-light + floor beacon + pillar.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 1.6]);
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    0.2,
  ]);
  add(g, POST, accent.glow, [-ROOM_W / 2 + 0.4, 0.75, ROOM_D / 2 - 0.6], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [-ROOM_W / 2 + 0.4, 1.5, ROOM_D / 2 - 0.6]);
  add(g, PILLAR, MAT.panel, [ROOM_W / 2 - 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build the CONTAINMENT interior — sickly toxic-green holding block. A MODEST
 * treatment (matching the bay diorama in baseFacilities.ts): three sealed
 * holding cells along the back wall, each with a pulsing neutralization-field
 * pane and a status beacon, a control console facing them, hazard floor
 * stripes, and the standard prop/lighting dressing shared with the other
 * rooms.
 */
function buildContainmentInterior(captiveCount: number): Group {
  const g = new Group();
  const hex = BASE_PALETTE.accent.containment;
  const accent = ACCENT.containment;
  addShell(g);

  // Three sealed holding cells along the back wall — the room's signature row.
  // Occupied cells glow violet (psi hue) with a captive silhouette + a faint
  // violet backlight; empty cells stay dark. Occupancy comes from the live
  // captive roster (see buildFacilityInterior / readCaptiveCount).
  const cellX = [-1.6, 0, 1.6];
  const cellZ = -ROOM_D / 2 + 0.35;
  for (let i = 0; i < cellX.length; i++) {
    const x = cellX[i]!;
    const occupied = i < captiveCount;
    add(g, CELL_BODY, MAT.panelDark, [x, 0.85, cellZ]);
    const field = add(
      g,
      CELL_FIELD,
      occupied ? CELL_VIOLET.field : CELL_VIOLET.fieldDim,
      [x, 0.9, cellZ + 0.26],
    );
    field.userData.interiorPulse = true;
    // Motion accent: occupied fields flicker faintly (>=2s period).
    drivePulse(field, occupied ? 0.06 : 0.02, 2.6);
    add(g, BEAD, occupied ? CELL_VIOLET.beacon : CELL_VIOLET.beaconDim, [x, 1.78, cellZ]);
    if (occupied) {
      // Captive silhouette held inside the cell against the emissive violet field
      // (CELL_VIOLET.field already glows — no per-cell PointLight, so the interior
      // keeps a constant light count regardless of occupancy: no shader recompile).
      add(g, SIL_BODY, MAT_SILHOUETTE, [x, 0.56, cellZ + 0.08]);
      add(g, SIL_HEAD, MAT_SILHOUETTE, [x, 1.08, cellZ + 0.08]);
    }
  }

  // Control console facing the cells, with a status readout screen.
  add(g, CELL_CONSOLE, MAT.panel, [0, 0.45, 1.1]);
  const screen = add(g, BENCH_SCREEN, screenMaterial(hex, "HOLD"), [0, 0.86, 1.36]);
  screen.userData.interiorScreen = true;

  // Hazard warning-stripes along the back wall base (mirrors the reactor's
  // convention, recolored to the containment accent).
  for (let i = 0; i < 5; i++) {
    const x = -1.6 + i * 0.8;
    add(g, WARN_STRIPE, i % 2 === 0 ? accentEmissive(hex, 0.7) : MAT_PROPS.dark, [
      x,
      0.32,
      -ROOM_D / 2 + 0.04,
    ]);
  }

  // Overhead strip + accent wall work-light + floor beacon + corner pillar.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 1.2]);
  add(g, bevelBox(0.5, 0.16, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.6,
    0.4,
  ]);
  add(g, POST, accent.glow, [ROOM_W / 2 - 0.4, 0.75, -ROOM_D / 2 + 0.5], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [ROOM_W / 2 - 0.4, 1.5, -ROOM_D / 2 + 0.5]);
  add(g, PILLAR, MAT.panel, [-ROOM_W / 2 + 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  return g;
}

/**
 * Build a facility INTERIOR diorama for the given role. Each of the eight roles
 * gets its own dense, textured, sculpted diorama (the LAB remains the hero; the
 * other six are detailed to the same quality, and CONTAINMENT is deliberately
 * modest). The returned Group is tagged
 * `userData.facilityRole`; animated accents self-tag (userData.interiorPulse /
 * interiorBlink / interiorScreen / interiorRotor) for the baseView frame loop.
 * Origin is at floor center (y = 0 is the floor surface); the front wall is open
 * toward +z for the camera.
 */
export function buildFacilityInterior(role: FacilityRole, captiveCount?: number): Group {
  const group = (() => {
    switch (role) {
      case "lab":
        return buildLabInterior();
      case "command":
        return buildCommandInterior();
      case "workshop":
        return buildWorkshopInterior();
      case "barracks":
        return buildBarracksInterior();
      case "hangar":
        return buildHangarInterior();
      case "radar":
        return buildRadarInterior();
      case "reactor":
        return buildReactorInterior();
      case "containment":
        // Prefer an injected count (e.g. from baseView's campaign); otherwise
        // fall back to the persisted campaign so occupancy reads correctly even
        // without a call-site change.
        return buildContainmentInterior(captiveCount ?? readCaptiveCount());
    }
  })();
  // Every interior gets its own lighting rig so it reads as a lit room the
  // instant it mounts (never a black void), independent of the hub scene lights.
  addInteriorLighting(group, role);
  group.userData.facilityRole = role;
  group.userData.interior = true;
  return group;
}

/**
 * Best-effort read of how many live captives are held, from the persisted
 * campaign. Used only as a fallback when the caller does not inject a count
 * (baseView currently calls buildFacilityInterior(role) with no count). Guarded:
 * any storage/parse failure yields 0 (empty containment). Deterministic given
 * the same persisted state.
 */
function readCaptiveCount(): number {
  try {
    const raw =
      typeof localStorage !== "undefined" ? localStorage.getItem("blacksite.campaign.v1") : null;
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as { captives?: unknown };
    return Array.isArray(parsed.captives) ? parsed.captives.length : 0;
  } catch {
    return 0;
  }
}
