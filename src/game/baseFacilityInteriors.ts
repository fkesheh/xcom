/**
 * Facility INTERIOR dioramas for the "enter facility" camera dive. The LAB is
 * the hero — a dense, textured, sculpted room the camera flies INTO and reads
 * as a real research lab. The other roles get a solid generic textured room so
 * entering them is never broken; their full detail rolls out in later passes.
 *
 * ANTI-BLOB CORE: every surface that was a flat color box is now a PROCEDURAL
 * TEXTURE + NORMAL MAP from baseTextures — riveted metal-panel walls/racks,
 * cracked concrete floors, glowing readout screens. Geometry is SCULPTED:
 * racks/crates/beams are extruded Shapes WITH bevel (chamfered edges read as
 * crafted), the research vat is lathed, multi-part silhouettes merge into one
 * read. No naked hard-corner boxes for architecture.
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
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Mesh,
  type MeshStandardMaterial,
  PlaneGeometry,
  Shape,
  SphereGeometry,
  Vector2,
} from "three";
import { BASE_PALETTE, type FacilityRole } from "./basePalette";
import {
  accentEmissive,
  concreteMaterial,
  metalPanelMaterial,
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
};

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

/** An extruded rectangle WITH bevel, centered on Z — a chamfered box that reads
 * as crafted rather than a naked primitive. Shape spans the XY plane, extruded
 * along Z, then recentered so local origin is the part center. */
function bevelBox(w: number, h: number, d: number, bevel = 0.03): ExtrudeGeometry {
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
  return geo;
}

// --- Room shell (floor + 3 walls; front toward +z left open for the camera) ---
const SHELL = {
  floor: new BoxGeometry(ROOM_W, 0.2, ROOM_D),
  backWall: new BoxGeometry(ROOM_W, ROOM_H, WALL_T),
  sideWall: new BoxGeometry(WALL_T, ROOM_H, ROOM_D),
} as const;
tileUV(SHELL.floor, ROOM_W / 1.7, ROOM_D / 1.7); // concrete slabs ~1.7 units
tileUV(SHELL.backWall, ROOM_W / 1.3, ROOM_H / 1.3); // riveted panels
tileUV(SHELL.sideWall, ROOM_D / 1.3, ROOM_H / 1.3);

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
const VAT_FLASK = new LatheGeometry(VAT_POINTS, 28);
const VAT_FRAME_POST = new CylinderGeometry(0.035, 0.035, 1.32, 8);

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
  const mesh = new Mesh(geometry, material);
  mesh.position.set(position[0], position[1], position[2]);
  mesh.scale.set(scale[0], scale[1], scale[2]);
  mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  group.add(mesh);
  return mesh;
}

/** Build the shared room shell (textured floor + back/left/right walls). */
function addShell(group: Group): void {
  add(group, SHELL.floor, MAT.concrete, [0, -0.1, 0]);
  add(group, SHELL.backWall, MAT.panel, [0, ROOM_H / 2, -ROOM_D / 2]);
  add(group, SHELL.sideWall, MAT.panel, [-ROOM_W / 2, ROOM_H / 2, 0]);
  add(group, SHELL.sideWall, MAT.panel, [ROOM_W / 2, ROOM_H / 2, 0]);
}

/**
 * Build one server/equipment rack: extruded beveled cabinet (panel texture) with
 * a glowing readout screen and a column of status lights. Status dots tag
 * themselves userData.interiorBlink so the baseView frame loop may animate them
 * (they already read as a live board statically via on/dim variation).
 */
function buildRack(screenLabel: string): Group {
  const rack = new Group();
  // Cabinet body — base sits on the floor (geometry is centered, so y = H/2).
  add(rack, RACK_BODY, MAT.panel, [0, RACK_H / 2, 0]);
  add(rack, RACK_BASE, MAT.panelDark, [0, 0.05, 0]);
  add(rack, RACK_CAP, MAT.panelDark, [0, RACK_H + 0.04, 0]);
  // Recessed glowing screen on the front face.
  const screen = add(
    rack,
    RACK_SCREEN,
    screenMaterial(BASE_PALETTE.accent.lab, screenLabel),
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
      lit ? STATUS.on : STATUS.dim,
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
 * Build a solid GENERIC textured room for a non-hero role: same concrete-floor
 * + steel-panel shell, a large wall readout screen in the role's accent, an
 * accent work-light strip + beacon, and a few props (console, crates, pillar).
 * Entering the role works and reads as that facility; full density comes later.
 */
function buildGenericInterior(role: FacilityRole): Group {
  const g = new Group();
  const accent = ACCENT[role];
  addShell(g);

  // Large back-wall readout screen — the role's identity + interior glow.
  const wallScreen = add(
    g,
    new PlaneGeometry(2.6, 1.3),
    screenMaterial(BASE_PALETTE.accent[role], role.toUpperCase()),
    [0, ROOM_H * 0.62, -ROOM_D / 2 + WALL_T / 2 + 0.02],
  );
  wallScreen.userData.interiorScreen = true;

  // Accent work-light strip mounted high on the right wall + a floor beacon.
  add(g, bevelBox(1.2, 0.14, 0.06, 0.02), accent.glow, [
    ROOM_W / 2 - WALL_T / 2 - 0.04,
    ROOM_H - 0.55,
    0.4,
  ]);
  add(g, POST, accent.glow, [ROOM_W / 2 - 0.4, 0.75, -ROOM_D / 2 + 0.5], [1, 1.5, 1]);
  add(g, BEAD, accent.beacon, [ROOM_W / 2 - 0.4, 1.5, -ROOM_D / 2 + 0.5]);

  // Console against the back-left corner — panel cabinet + small screen.
  const consoleGeo = bevelBox(0.9, 0.92, 0.5, 0.025);
  add(g, consoleGeo, MAT.panel, [-1.6, 0.46, -ROOM_D / 2 + 0.32]);
  add(g, BENCH_SCREEN, screenMaterial(BASE_PALETTE.accent[role], "OPS"), [
    -1.6,
    0.86,
    -ROOM_D / 2 + 0.58,
  ]);

  // Props — crates + corner pillar.
  add(g, CRATE, MAT.worn, [1.7, 0.25, 1.5]);
  add(g, CRATE, MAT.worn, [1.9, 0.75, 1.7], [0.9, 0.9, 0.9]);
  add(g, PILLAR, MAT.panel, [-ROOM_W / 2 + 0.28, ROOM_H / 2, ROOM_D / 2 - 0.28], [1, ROOM_H, 1]);

  // Overhead strip light so the generic room isn't dark.
  add(g, STRIP, MAT.stripLight, [0, ROOM_H - 0.2, 0]);

  return g;
}

/**
 * Build a facility INTERIOR diorama for the given role. The LAB is the dense
 * hero; every other role returns a solid generic textured room. The returned
 * Group is tagged `userData.facilityRole`; animated accents self-tag
 * (userData.interiorPulse / interiorBlink / interiorScreen) for the baseView
 * frame loop. Origin is at floor center (y = 0 is the floor surface); the front
 * wall is open toward +z for the camera.
 */
export function buildFacilityInterior(role: FacilityRole): Group {
  const group = role === "lab" ? buildLabInterior() : buildGenericInterior(role);
  group.userData.facilityRole = role;
  group.userData.interior = true;
  return group;
}
