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
 * Models are STATIC — the baseView frame loop owns all animation (the reactor
 * core flags itself via userData.reactorPulse for the view to pulse). Each Group
 * is ~15-30 parts, uniformly enlarged to ~1.5x so silhouettes read at gameplay
 * distance (baseView sizes the bays to fit), with its origin at the floor center
 * (y = 0 is the floor surface).
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
  // Art-upgrade: stronger emissive accents so each facility's signature glow
  // reads at gameplay distance (glow = panels/strips, beacon = bright points).
  // Tuned just above the original (1.55/3.0) but below the ACES bleach point so
  // the signature COLOR survives tone mapping instead of washing to white.
  return { glow: accentMaterial(role, 1.8), beacon: accentMaterial(role, 3.2) };
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

/**
 * Uniform art-upgrade scale: every facility model is enlarged so its silhouette
 * reads at gameplay distance. Applied once on the finished Group so all relative
 * proportions are preserved and no extra geometry/material is allocated.
 * baseView sizes the bays to fit these larger modules + the corridor grid.
 */
const MODEL_SCALE = 1.5;

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
  // Enlarge the finished diorama uniformly so it reads at distance. Group-level
  // scaling is allocation-free and transparent to raycasting (world matrices
  // absorb it), so baseView's hover/click behavior is unchanged.
  group.scale.setScalar(MODEL_SCALE);
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
  // Two tall server racks with status lights — enlarged so they read as racks.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.32, 0.46, -0.28], [0.3, 0.9, 0.2]);
    add(group, GEO.box, MAT.steel, [sx * 0.32, 0.92, -0.28], [0.32, 0.08, 0.22]);
    for (let row = 0; row < 4; row++) {
      for (let col = -1; col <= 1; col++) {
        add(group, GEO.dot, accent.glow, [sx * 0.32 + col * 0.08, 0.2 + row * 0.18, -0.175]);
      }
    }
  }
  // Tall glowing research vat — the lab's signature cyan column, enlarged.
  add(group, GEO.core, MAT.steel, [0, 0.48, 0.14], [0.46, 0.96, 0.46]);
  add(group, GEO.core, accent.beacon, [0, 0.5, 0.14], [0.32, 0.86, 0.32]);
  add(group, GEO.disk, MAT.steel, [0, 0.96, 0.14], [0.92, 1, 0.92], [0.46, 1, 0.46]);
  add(group, GEO.disk, accent.glow, [0, 0.98, 0.14], [0.58, 1, 0.58]);
  add(group, GEO.bead, accent.beacon, [0, 1.02, 0.14]);
  // Ceiling strip light.
  add(group, GEO.slab, accent.glow, [0, 0.96, -0.05], [0.6, 1, 0.08]);
  addBeacon(group, "lab", 0.4, 0.5, 0.36);
}

/** Workshop (amber): fabrication gantry, forge glow, tool racks. */
function buildWorkshop(group: Group): void {
  const accent = ACCENT.workshop;
  addPad(group);
  // Overhead fabrication gantry — enlarged so the frame reads as machinery.
  for (const sx of [-1, 1]) {
    add(group, GEO.post, MAT.steel, [sx * 0.4, 0.46, -0.1], [1.2, 0.9, 1.2]);
  }
  add(group, GEO.box, MAT.steel, [0, 0.9, -0.1], [0.9, 0.1, 0.12]); // crossbeam
  add(group, GEO.box, MAT.steel, [0.14, 0.58, -0.1], [0.1, 0.58, 0.1]); // arm
  add(group, GEO.box, accent.glow, [0.14, 0.32, -0.1], [0.26, 0.08, 0.18]); // weld head glow
  add(group, GEO.box, MAT.steel, [0.14, 0.29, -0.1], [0.24, 0.06, 0.16]); // weld head
  // Forge with amber glow — the workshop's signature, enlarged + brighter.
  add(group, GEO.box, MAT.steel, [-0.28, 0.24, 0.2], [0.3, 0.4, 0.3]);
  add(group, GEO.cone, accent.beacon, [-0.28, 0.44, 0.2], [0.28, 0.32, 0.28]);
  add(group, GEO.box, accent.glow, [-0.28, 0.14, 0.2], [0.22, 0.08, 0.22]);
  add(group, GEO.bead, accent.beacon, [-0.28, 0.5, 0.2]);
  // Tool rack against the back.
  add(group, GEO.box, MAT.steel, [0.3, 0.4, -0.32], [0.14, 0.72, 0.07]);
  for (let i = 0; i < 4; i++) {
    add(group, GEO.post, accent.glow, [0.3, 0.18 + i * 0.16, -0.28], [1.1, 0.08, 1.1]);
  }
  addBeacon(group, "workshop", -0.4, 0.5, -0.36);
}

/** Barracks (warm white): stacked bunk beds, footlockers, warm ceiling lamp. */
function buildBarracks(group: Group): void {
  const accent = ACCENT.barracks;
  addPad(group);
  // Two bunk beds along the sides (four corner posts each, two mattresses).
  // Enlarged + brighter mattress glow so the stacked beds read at a glance.
  for (const sx of [-1, 1]) {
    for (const ox of [-1, 1]) {
      for (const oz of [-1, 1]) {
        add(group, GEO.post, MAT.steel, [sx * 0.34 + ox * 0.17, 0.34, oz * 0.22], [1.1, 0.66, 1.1]);
      }
    }
    for (const by of [0.2, 0.48]) {
      add(group, GEO.slab, MAT.steel, [sx * 0.34, by, 0], [0.38, 1, 0.5]);
      add(group, GEO.slab, accent.beacon, [sx * 0.34, by + 0.035, 0], [0.34, 1, 0.46]);
      add(group, GEO.box, accent.glow, [sx * 0.34, by + 0.06, 0.18], [0.3, 0.04, 0.12]); // pillow
    }
  }
  // Footlockers at the foot of each bed.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.34, 0.1, 0.34], [0.3, 0.16, 0.14]);
  }
  // Warm ceiling lamp.
  add(group, GEO.post, MAT.steel, [0, 0.82, -0.2], [1, 0.18, 1]);
  add(group, GEO.disk, accent.beacon, [0, 0.9, -0.2], [0.6, 1, 0.6]);
  addBeacon(group, "barracks", 0, 0.5, 0.36);
}

/** Hangar (green): the X-COM ship on a pad, launch ramp, overhead gantry. */
function buildHangar(group: Group): void {
  const accent = ACCENT.hangar;
  add(group, GEO.disk, MAT.concrete, [0, 0.02, 0.04], [1.84, 1, 1.84]); // landing pad
  addHalo(group, accent, 0.46, 0.05);
  // Pad edge lights.
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    add(group, GEO.dot, accent.glow, [Math.cos(a) * 0.46, 0.06, 0.04 + Math.sin(a) * 0.46]);
  }
  // The interceptor — long fuselage, broad swept wings, tall tail, twin glowing
  // engines. Enlarged + accented so the silhouette reads as a ship at distance.
  add(group, GEO.core, MAT.steel, [0, 0.32, 0.0], [0.52, 0.36, 1.78]); // fuselage
  add(group, GEO.box, accent.glow, [0, 0.52, 0.0], [0.07, 0.03, 1.5]); // dorsal spine stripe
  add(group, GEO.dome, accent.beacon, [0, 0.4, 0.72], [0.5, 0.42, 0.5], [-Math.PI / 2, 0, 0]); // cockpit canopy
  add(group, GEO.box, MAT.steel, [0, 0.54, -0.46], [0.2, 0.5, 0.2]); // vertical tail
  add(group, GEO.box, accent.glow, [0, 0.6, -0.46], [0.04, 0.34, 0.16]); // tail fin stripe
  add(group, GEO.box, MAT.steel, [0, 0.44, -0.24], [0.82, 0.06, 0.26]); // horizontal stabilizer
  // Broad swept wings with bright green leading edges — the ship's signature.
  add(group, GEO.box, MAT.steel, [0.4, 0.31, 0.04], [0.9, 0.08, 0.36], [0, -0.5, 0.22]); // starboard wing
  add(group, GEO.box, MAT.steel, [-0.4, 0.31, 0.04], [0.9, 0.08, 0.36], [0, 0.5, 0.22]); // port wing
  add(group, GEO.box, accent.glow, [0.4, 0.335, 0.2], [0.9, 0.025, 0.05], [0, -0.5, 0.22]); // starboard leading edge
  add(group, GEO.box, accent.glow, [-0.4, 0.335, 0.2], [0.9, 0.025, 0.05], [0, 0.5, 0.22]); // port leading edge
  add(group, GEO.box, accent.beacon, [0.42, 0.315, -0.12], [0.14, 0.05, 0.26]); // starboard wingtip strobe
  add(group, GEO.box, accent.beacon, [-0.42, 0.315, -0.12], [0.14, 0.05, 0.26]); // port wingtip strobe
  // Twin glowing engines — the ship's bright green signature at the tail.
  add(group, GEO.core, accent.beacon, [0.13, 0.32, -0.84], [0.26, 0.26, 0.2]);
  add(group, GEO.core, accent.beacon, [-0.13, 0.32, -0.84], [0.26, 0.26, 0.2]);
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
  add(group, GEO.pillar, MAT.steel, [0, 0.2, -0.05], [1.2, 0.28, 1.2]);
  add(group, GEO.dome, MAT.steel, [0, 0.38, -0.05], [0.98, 0.48, 0.98], [-1.0, 0.4, 0]); // dish shell
  add(group, GEO.dome, accent.glow, [0, 0.38, -0.05], [0.8, 0.4, 0.8], [-1.0, 0.4, 0]); // dish face glow
  add(group, GEO.bead, accent.beacon, [0, 0.48, 0.04], [1.4, 1.4, 1.4]); // receiver horn
  // Antenna mast with crossbars.
  add(group, GEO.post, MAT.steel, [-0.32, 0.56, 0.3], [1, 1.06, 1]);
  for (const my of [0.44, 0.68]) {
    add(group, GEO.post, MAT.steel, [-0.32, my, 0.3], [1, 0.04, 1], [0, 0, Math.PI / 2]);
    add(group, GEO.dot, accent.glow, [-0.32, my, 0.3]);
  }
  add(group, GEO.bead, accent.beacon, [-0.32, 1.1, 0.3]);
  // Base equipment cabinet.
  add(group, GEO.box, MAT.steel, [0.22, 0.2, 0.26], [0.3, 0.34, 0.24]);
  add(group, GEO.box, accent.glow, [0.22, 0.32, 0.14], [0.2, 0.09, 0.02]);
  addBeacon(group, "radar", 0.38, 0.5, -0.34);
}

/** Reactor (yellow): large visibly-pulsing cylindrical core, conduit pipes, vented cap. */
function buildReactor(group: Group): void {
  const accent = ACCENT.reactor;
  addPad(group);
  addHalo(group, accent, 0.44);
  // Cylindrical core housing — enlarged so the reactor reads as the power heart.
  add(group, GEO.core, MAT.steel, [0, 0.48, 0], [0.72, 0.96, 0.72]);
  // Large glowing inner core — pulses. Dedicated material (not the shared
  // accent) so only the core animates; tagged for the baseView frame loop.
  const coreGlow = accentMaterial("reactor", 2.1);
  const core = add(group, GEO.core, coreGlow, [0, 0.5, 0], [0.52, 0.86, 0.52]);
  core.userData.reactorPulse = true;
  // Vented cap.
  add(group, GEO.disk, MAT.steel, [0, 0.96, 0], [1.44, 1, 1.44], [0.72, 1, 0.72]);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
    add(group, GEO.box, MAT.steel, [Math.cos(a) * 0.3, 1.02, Math.sin(a) * 0.3], [0.09, 0.09, 0.09]);
  }
  // Conduit pipes running out to junction boxes.
  for (const sx of [-1, 1]) {
    add(group, GEO.post, MAT.steel, [sx * 0.42, 0.4, 0], [1, 0.14, 1], [0, 0, Math.PI / 2]);
    add(group, GEO.box, MAT.steel, [sx * 0.5, 0.4, 0], [0.16, 0.28, 0.28]);
    add(group, GEO.dot, accent.glow, [sx * 0.5, 0.52, 0]);
  }
  // Base plinth struts.
  for (const sx of [-1, 1]) {
    add(group, GEO.box, MAT.steel, [sx * 0.24, 0.06, 0], [0.12, 0.12, 0.38]);
  }
  addBeacon(group, "reactor", 0, 1.14, -0.36);
}

/** Unknown/default role: a compact command-style beacon on a steel plinth. */
function buildFallback(group: Group, role: FacilityRole): void {
  addPad(group, 0.6);
  add(group, GEO.pillar, MAT.steel, [0, 0.2, 0], [0.8, 0.34, 0.8]);
  add(group, GEO.disk, MAT.steel, [0, 0.38, 0], [0.5, 1, 0.5]);
  addBeacon(group, role, 0, 0.5, 0);
}
