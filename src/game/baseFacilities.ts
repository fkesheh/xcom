/**
 * Facility diorama factories for the base "cutaway" (Layer 2). Each role gets a
 * distinct, readable miniature built ONLY from the frozen basePalette vocabulary
 * (steel/concrete/rock + an emissive accent glow in the role's signature color).
 *
 * All primitive geometries and the structural/accent materials are created once
 * at module scope and shared across every bay, so a facility is cheap to build
 * and teardown is safe: only standard MeshStandardMaterials are used (no
 * textures), and three.js re-uploads any shared/disposed GPU resource on the
 * next render, so disposal of one group can never corrupt another.
 *
 * Models are STATIC — the baseView frame loop owns all animation. Each Group is
 * ~15-30 parts, scaled to fill one bay (~1 unit footprint), with its origin at
 * the floor center (y = 0 is the floor surface).
 */
import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  type MeshStandardMaterial,
  type BufferGeometry,
  SphereGeometry,
} from "three";
import {
  accentMaterial,
  concreteMaterial,
  rockMaterial,
  steelMaterial,
  type FacilityRole,
} from "./basePalette";

export type { FacilityRole } from "./basePalette";

/** Shared primitive geometries (unit-ish; scaled per-part via Mesh.scale). */
const GEO = {
  /** Unit cube — slabs, racks, frames, consoles. */
  box: new BoxGeometry(1, 1, 1),
  /** Thin slab — pads, bed platforms, ceiling strips. */
  slab: new BoxGeometry(1, 0.08, 1),
  /** Slim vertical post — beacons, bed frames, gantry legs. */
  post: new CylinderGeometry(0.06, 0.06, 1, 10),
  /** Pillar — command hub pedestal, reactor supports. */
  pillar: new CylinderGeometry(0.12, 0.12, 1, 14),
  /** Unit cylinder — cores, vats, pads (radius 0.5). */
  core: new CylinderGeometry(0.5, 0.5, 1, 28),
  /** Flat disk — holotables, lamps, pads (radius 0.5, height 0.04). */
  disk: new CylinderGeometry(0.5, 0.5, 0.04, 28),
  /** Small beacon sphere (radius 0.05). */
  bead: new SphereGeometry(0.05, 10, 8),
  /** Tiny status-light cube. */
  dot: new BoxGeometry(0.06, 0.06, 0.06),
  /** Hemisphere — radar dish, cockpit canopy. */
  dome: new SphereGeometry(0.5, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
  /** Open cone — forge nozzle / engine bell. */
  cone: new ConeGeometry(0.5, 1, 20, 1, true),
} as const;

/** Shared structural materials (immutable, never per-facility tuned). */
const MAT = {
  steel: steelMaterial(),
  concrete: concreteMaterial(),
  rock: rockMaterial(),
} as const;

interface AccentSet {
  /** Mid-intensity glow for screens, strips, rings. */
  readonly glow: MeshStandardMaterial;
  /** High-intensity beacon light. */
  readonly beacon: MeshStandardMaterial;
}

function makeAccent(role: FacilityRole): AccentSet {
  return { glow: accentMaterial(role, 1.1), beacon: accentMaterial(role, 2.2) };
}

/** One shared accent pair per role. */
const ACCENT: Record<FacilityRole, AccentSet> = {
  command: makeAccent("command"),
  lab: makeAccent("lab"),
  workshop: makeAccent("workshop"),
  barracks: makeAccent("barracks"),
  hangar: makeAccent("hangar"),
  radar: makeAccent("radar"),
  reactor: makeAccent("reactor"),
};

type Vec3 = readonly [number, number, number];

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

/** Thin concrete pad a facility sits on. */
function addPad(group: Group, size = 0.92): Mesh {
  return add(group, GEO.slab, MAT.concrete, [0, 0.02, 0], [size, 1, size]);
}

/** Flat accent halo on the floor around a feature. */
function addHalo(group: Group, accent: AccentSet, radius: number, y = 0.05): Mesh {
  return add(group, GEO.disk, accent.glow, [0, y, 0], [radius * 2, 1, radius * 2]);
}

/** A small identifying beacon: thin mast + bright accent bead. */
function addBeacon(group: Group, role: FacilityRole, x: number, height: number, z: number): void {
  const accent = ACCENT[role];
  add(group, GEO.post, accent.glow, [x, height * 0.5, z], [1, height, 1]);
  add(group, GEO.bead, accent.beacon, [x, height, z]);
}

/**
 * Build a detailed, distinct facility diorama for the given role. The returned
 * Group is tagged with `userData.facilityRole` (as are its accent children) so a
 * caller can drive hover/select feedback if desired. Origin sits at the floor
 * center; the model fills roughly one base bay.
 */
export function buildFacilityModel(role: FacilityRole): Group {
  const group = new Group();
  group.userData.facilityRole = role;
  switch (role) {
    case "command":
      buildCommand(group);
      break;
    case "lab":
      buildLab(group);
      break;
    case "workshop":
      buildWorkshop(group);
      break;
    case "barracks":
      buildBarracks(group);
      break;
    case "hangar":
      buildHangar(group);
      break;
    case "radar":
      buildRadar(group);
      break;
    case "reactor":
      buildReactor(group);
      break;
    default:
      buildFallback(group, role);
      break;
  }
  return group;
}

/** Command/Centre (blue): holographic table, status screens, central pillar. */
function buildCommand(group: Group): void {
  const accent = ACCENT.command;
  addPad(group);
  addHalo(group, accent, 0.3);
  // Central holographic projector — glowing blue dome (command's signature).
  add(group, GEO.pillar, MAT.steel, [0, 0.18, 0], [1.1, 0.28, 1.1]);
  add(group, GEO.disk, accent.glow, [0, 0.34, 0], [1.3, 1, 1.3]);
  add(group, GEO.dome, accent.beacon, [0, 0.38, 0], [0.7, 0.5, 0.7], [-Math.PI / 2, 0, 0]);
  add(group, GEO.disk, MAT.steel, [0, 0.37, 0], [0.6, 1, 0.6]);
  // Back pillar — the hub mast.
  add(group, GEO.pillar, MAT.steel, [0, 0.45, -0.32], [0.7, 0.8, 0.7]);
  add(group, GEO.bead, accent.beacon, [0, 0.86, -0.32]);
  // Wall status screens.
  for (let i = -1; i <= 1; i++) {
    add(group, GEO.box, MAT.steel, [i * 0.26, 0.5, -0.4], [0.18, 0.34, 0.03]);
    add(group, GEO.box, accent.glow, [i * 0.26, 0.5, -0.385], [0.14, 0.28, 0.012]);
  }
  // Operator consoles flanking the table.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.36, 0.13, 0.14], [0.18, 0.22, 0.14]);
    add(group, GEO.box, accent.glow, [sx * 0.36, 0.22, 0.08], [0.14, 0.07, 0.1]);
  }
  addBeacon(group, "command", 0.4, 0.52, -0.4);
}

/** Lab (cyan): server racks with blinking lights, research vat, ceiling strip. */
function buildLab(group: Group): void {
  const accent = ACCENT.lab;
  addPad(group);
  // Two tall server racks with status lights.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.3, 0.4, -0.28], [0.26, 0.76, 0.18]);
    add(group, GEO.box, MAT.steel, [sx * 0.3, 0.78, -0.28], [0.28, 0.08, 0.2]);
    for (let row = 0; row < 3; row++) {
      for (let col = -1; col <= 1; col++) {
        add(group, GEO.dot, accent.glow, [sx * 0.3 + col * 0.07, 0.22 + row * 0.16, -0.185]);
      }
    }
  }
  // Tall glowing research vat — the lab's signature cyan column.
  add(group, GEO.core, MAT.steel, [0, 0.42, 0.12], [0.4, 0.82, 0.4]);
  add(group, GEO.core, accent.beacon, [0, 0.44, 0.12], [0.26, 0.74, 0.26]);
  add(group, GEO.disk, MAT.steel, [0, 0.84, 0.12], [0.82, 1, 0.82], [0.41, 1, 0.41]);
  add(group, GEO.disk, accent.glow, [0, 0.86, 0.12], [0.5, 1, 0.5]);
  // Ceiling strip light.
  add(group, GEO.slab, accent.glow, [0, 0.86, -0.05], [0.5, 1, 0.08]);
  addBeacon(group, "lab", 0.4, 0.5, 0.36);
}

/** Workshop (amber): fabrication gantry, forge glow, tool racks. */
function buildWorkshop(group: Group): void {
  const accent = ACCENT.workshop;
  addPad(group);
  // Overhead fabrication gantry.
  for (const sx of [-1, 1]) {
    add(group, GEO.post, MAT.steel, [sx * 0.38, 0.4, -0.1], [1, 0.78, 1]);
  }
  add(group, GEO.box, MAT.steel, [0, 0.78, -0.1], [0.8, 0.08, 0.1]); // crossbeam
  add(group, GEO.box, MAT.steel, [0.12, 0.5, -0.1], [0.08, 0.5, 0.08]); // arm
  add(group, GEO.box, MAT.steel, [0.12, 0.27, -0.1], [0.22, 0.06, 0.16]); // weld head
  // Forge with amber glow.
  add(group, GEO.box, MAT.steel, [-0.26, 0.2, 0.18], [0.24, 0.32, 0.24]);
  add(group, GEO.cone, accent.beacon, [-0.26, 0.36, 0.18], [0.2, 0.22, 0.2]);
  add(group, GEO.box, accent.glow, [-0.26, 0.12, 0.18], [0.16, 0.06, 0.16]);
  // Tool rack against the back.
  add(group, GEO.box, MAT.steel, [0.28, 0.34, -0.32], [0.12, 0.6, 0.06]);
  for (let i = 0; i < 3; i++) {
    add(group, GEO.post, accent.glow, [0.28, 0.2 + i * 0.16, -0.28], [1, 0.08, 1]);
  }
  addBeacon(group, "workshop", -0.4, 0.5, -0.36);
}

/** Barracks (warm white): stacked bunk beds, footlockers, warm ceiling lamp. */
function buildBarracks(group: Group): void {
  const accent = ACCENT.barracks;
  addPad(group);
  // Two bunk beds along the sides (four corner posts each, two mattresses).
  for (const sx of [-1, 1]) {
    for (const ox of [-1, 1]) {
      for (const oz of [-1, 1]) {
        add(group, GEO.post, MAT.steel, [sx * 0.34 + ox * 0.15, 0.3, oz * 0.2], [1, 0.58, 1]);
      }
    }
    for (const by of [0.18, 0.42]) {
      add(group, GEO.slab, MAT.steel, [sx * 0.34, by, 0], [0.34, 1, 0.46]);
      add(group, GEO.slab, accent.beacon, [sx * 0.34, by + 0.03, 0], [0.3, 1, 0.42]);
    }
  }
  // Footlockers at the foot of each bed.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.34, 0.08, 0.3], [0.26, 0.12, 0.12]);
  }
  // Warm ceiling lamp.
  add(group, GEO.post, MAT.steel, [0, 0.78, -0.2], [1, 0.16, 1]);
  add(group, GEO.disk, accent.beacon, [0, 0.86, -0.2], [0.5, 1, 0.5]);
  addBeacon(group, "barracks", 0, 0.5, 0.36);
}

/** Hangar (green): the X-COM ship on a pad, launch ramp, overhead gantry. */
function buildHangar(group: Group): void {
  const accent = ACCENT.hangar;
  add(group, GEO.disk, MAT.concrete, [0, 0.02, 0.04], [1.7, 1, 1.7]); // landing pad
  addHalo(group, accent, 0.42, 0.05);
  // Pad edge lights.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(group, GEO.dot, accent.glow, [Math.cos(a) * 0.42, 0.06, 0.04 + Math.sin(a) * 0.42]);
  }
  // The interceptor — long fuselage, broad swept wings, tall tail, twin glowing
  // engines. Sized to read as a ship at distance (the 2x2 bay has the room).
  add(group, GEO.core, MAT.steel, [0, 0.3, 0.0], [0.4, 0.3, 1.5]); // fuselage
  add(group, GEO.dome, accent.glow, [0, 0.36, 0.62], [0.44, 0.44, 0.44], [-Math.PI / 2, 0, 0]); // cockpit canopy
  add(group, GEO.box, MAT.steel, [0, 0.5, -0.42], [0.16, 0.4, 0.18]); // vertical tail
  add(group, GEO.box, MAT.steel, [0, 0.42, -0.22], [0.7, 0.05, 0.22]); // horizontal stabilizer
  add(group, GEO.box, MAT.steel, [0.34, 0.29, 0.04], [0.74, 0.07, 0.3], [0, -0.5, 0.2]); // starboard wing
  add(group, GEO.box, MAT.steel, [-0.34, 0.29, 0.04], [0.74, 0.07, 0.3], [0, 0.5, 0.2]); // port wing
  add(group, GEO.box, accent.beacon, [0.34, 0.295, -0.08], [0.12, 0.04, 0.22]); // starboard wingtip strobe
  add(group, GEO.box, accent.beacon, [-0.34, 0.295, -0.08], [0.12, 0.04, 0.22]); // port wingtip strobe
  // Twin glowing engines — the ship's bright green signature at the tail.
  add(group, GEO.core, accent.beacon, [0.11, 0.3, -0.72], [0.2, 0.2, 0.16]);
  add(group, GEO.core, accent.beacon, [-0.11, 0.3, -0.72], [0.2, 0.2, 0.16]);
  // Launch ramp / bay doors at the back.
  add(group, GEO.box, MAT.steel, [0, 0.12, -0.4], [0.7, 0.06, 0.12], [0.35, 0, 0]);
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.3, 0.3, -0.42], [0.22, 0.5, 0.04]); // bay doors
  }
  // Overhead gantry.
  for (const sx of [-1, 1]) {
    add(group, GEO.post, MAT.steel, [sx * 0.4, 0.5, 0.3], [1, 0.9, 1]);
  }
  add(group, GEO.box, MAT.steel, [0, 0.92, 0.3], [0.8, 0.06, 0.1]);
  addBeacon(group, "hangar", 0.42, 0.6, -0.34);
}

/** Radar (purple): rotating dish silhouette, antenna mast, base unit. */
function buildRadar(group: Group): void {
  const accent = ACCENT.radar;
  addPad(group);
  // Tilted parabolic dish on a stout base — the radar's signature (1x1 bay).
  add(group, GEO.pillar, MAT.steel, [0, 0.18, -0.05], [1.1, 0.24, 1.1]);
  add(group, GEO.dome, MAT.steel, [0, 0.34, -0.05], [0.86, 0.42, 0.86], [-1.0, 0.4, 0]); // dish shell
  add(group, GEO.dome, accent.glow, [0, 0.34, -0.05], [0.7, 0.34, 0.7], [-1.0, 0.4, 0]); // dish face glow
  add(group, GEO.bead, accent.beacon, [0, 0.42, 0.02]); // receiver horn
  // Antenna mast with crossbars.
  add(group, GEO.post, MAT.steel, [-0.32, 0.5, 0.3], [1, 0.94, 1]);
  for (const my of [0.4, 0.62]) {
    add(group, GEO.post, MAT.steel, [-0.32, my, 0.3], [1, 0.04, 1], [0, 0, Math.PI / 2]);
    add(group, GEO.dot, accent.glow, [-0.32, my, 0.3]);
  }
  add(group, GEO.bead, accent.beacon, [-0.32, 0.98, 0.3]);
  // Base equipment cabinet.
  add(group, GEO.box, MAT.steel, [0.2, 0.18, 0.26], [0.26, 0.3, 0.22]);
  add(group, GEO.box, accent.glow, [0.2, 0.28, 0.15], [0.18, 0.08, 0.02]);
  addBeacon(group, "radar", 0.38, 0.5, -0.34);
}

/** Reactor (yellow): large visibly-pulsing cylindrical core, conduit pipes, vented cap. */
function buildReactor(group: Group): void {
  const accent = ACCENT.reactor;
  addPad(group);
  addHalo(group, accent, 0.4);
  // Cylindrical core housing.
  add(group, GEO.core, MAT.steel, [0, 0.42, 0], [0.62, 0.82, 0.62]);
  // Large glowing inner core — pulses. Dedicated material (not the shared
  // accent) so only the core animates; tagged for the baseView frame loop.
  const coreGlow = accentMaterial("reactor", 1.4);
  const core = add(group, GEO.core, coreGlow, [0, 0.44, 0], [0.42, 0.74, 0.42]);
  core.userData.reactorPulse = true;
  // Vented cap.
  add(group, GEO.disk, MAT.steel, [0, 0.84, 0], [1.28, 1, 1.28], [0.64, 1, 0.64]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    add(group, GEO.box, MAT.steel, [Math.cos(a) * 0.26, 0.9, Math.sin(a) * 0.26], [0.08, 0.08, 0.08]);
  }
  // Conduit pipes running out to junction boxes.
  for (const sx of [-1, 1]) {
    add(group, GEO.post, MAT.steel, [sx * 0.4, 0.36, 0], [1, 0.12, 1], [0, 0, Math.PI / 2]);
    add(group, GEO.box, MAT.steel, [sx * 0.47, 0.36, 0], [0.14, 0.24, 0.24]);
    add(group, GEO.dot, accent.glow, [sx * 0.47, 0.46, 0]);
  }
  // Base plinth struts.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.22, 0.06, 0], [0.1, 0.12, 0.34]);
  }
  addBeacon(group, "reactor", 0, 1.02, -0.36);
}

/** Unknown/default role: a compact command-style beacon on a steel plinth. */
function buildFallback(group: Group, role: FacilityRole): void {
  addPad(group, 0.6);
  add(group, GEO.pillar, MAT.steel, [0, 0.2, 0], [0.8, 0.34, 0.8]);
  add(group, GEO.disk, MAT.steel, [0, 0.38, 0], [0.5, 1, 0.5]);
  addBeacon(group, role, 0, 0.5, 0);
}
