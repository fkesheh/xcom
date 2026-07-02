/**
 * Procedural unit figures.
 *
 * Presentation-only: assembles low-poly humanoid / creature meshes from
 * three.js primitives so the renderer can drop the plain capsule. Every figure
 * is built CENTERED ON THE ORIGIN, with feet at y = 0 and local +Z pointing
 * "forward". The renderer rotates the whole group with
 * {@link import("./coords").dir8ToAngleY} to face a unit's Dir8, so a separate
 * facing wedge is no longer needed — the rifle / eye / visor reads as the front.
 *
 * Look: rounded boxes + capsules + spheres give smooth, readable silhouettes
 * while staying low-poly. Materials are PBR MeshStandardMaterials (so they pick
 * up the scene's image-based lighting / reflections set by the renderer) with
 * team-tinted armour and a self-lit visor / eye that survives ACES tone mapping
 * and trips the bloom pass. Every body mesh casts (and receives) shadows.
 *
 * Nothing here touches game state; all geometry/colour/material is cosmetic and
 * deterministic (no randomness). Each figure OWNS its geometries + materials, so
 * {@link disposeCharacter} can release them without touching shared resources.
 */

import {
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  CapsuleGeometry,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

import type { Unit } from "../sim/index";
import { createWeaponModel } from "./weapons";

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

/**
 * Faction-read accent tokens (Style Bible, Layer 1 — do not drift). These are
 * the single source of truth for the "who is this?" colour: the figure's
 * emissive visor/eye is tinted from here, and the renderer imports the same
 * tokens to tint the selection ring, the mind-control halo, the KO ground ring
 * and the overhead HP/TU pips so every readability cue agrees on one hue per
 * class. Friendly reads teal, hostile reads signal-red, a seized unit reads
 * violet — never mixed.
 */
export const FACTION_ACCENT = {
  /** Friendly / interactive — teal (Style Bible primary accent). */
  player: 0x38e8d2,
  /** Hostile / alien — signal red. */
  enemy: 0xff4a3a,
  /** Civilian — neutral warm. */
  civilian: 0xf0c8a0,
  /** Mind-controlled / psi — violet-magenta. */
  mindControlled: 0xc86bff,
  /** Unconscious (KO'd / captured) — desaturated steel for the ground ring. */
  unconscious: 0x5a6472,
} as const;

/** Cosmetic colour set for one figure. */
interface Palette {
  /** Main armour / shell colour. */
  primary: number;
  /** Darker accent: joints, undersuit, hoods. */
  secondary: number;
  /** Hard parts: weapon, claws, struts. */
  metal: number;
  /** Emissive accent: visor / eye / energy. */
  glow: number;
}

// Friendly: steel-blue armour trimmed with the teal team accent (visor / chest
// light) so a trooper reads teal at a glance.
const PLAYER_PALETTE: Palette = {
  primary: 0x3766a8,
  secondary: 0x16263d,
  metal: 0x9aa6b2,
  glow: FACTION_ACCENT.player,
};

// Hostiles: distinct silhouettes (floating pod vs hunched biped) but both carry
// the same signal-red eye/visor so "red = enemy" is unambiguous. Shell shades
// stay distinct (crimson vs maroon) for per-template variety; magenta is
// retired here so it can't be confused with the violet psi/MC cue.
const DRONE_PALETTE: Palette = {
  primary: 0x8f2230,
  secondary: 0x260a0d,
  metal: 0x6a5560,
  glow: FACTION_ACCENT.enemy,
};

const SENTINEL_PALETTE: Palette = {
  primary: 0x96202b,
  secondary: 0x270a0d,
  metal: 0x595059,
  glow: FACTION_ACCENT.enemy,
};

function paletteFor(unit: Unit): Palette {
  if (unit.faction === "player") return PLAYER_PALETTE;
  if (unit.templateId === "drone") return DRONE_PALETTE;
  return SENTINEL_PALETTE; // sentinel + any other hostile template
}

// ---------------------------------------------------------------------------
// Small build helpers
// ---------------------------------------------------------------------------

const UP = new Vector3(0, 1, 0);

interface MatOpts {
  rough?: number;
  metal?: number;
  /** Faceted (true, default) for low-poly armour plates; false for sleek shells. */
  flat?: boolean;
  /** scene.environment contribution (soft reflections); defaults to 0.85. */
  env?: number;
}

/** A PBR MeshStandardMaterial; flat-shaded by default for the low-poly read. */
function mat(color: number, opts: MatOpts = {}): MeshStandardMaterial {
  const material = new MeshStandardMaterial({
    color,
    roughness: opts.rough ?? 0.6,
    metalness: opts.metal ?? 0.3,
    flatShading: opts.flat ?? true,
  });
  material.envMapIntensity = opts.env ?? 0.85;
  return material;
}

/**
 * Self-lit accent (visor / eye / vent). A near-black base with a strong
 * emissive so it dominates after ACES tone mapping and crosses the renderer's
 * bloom threshold (author intensity >= ~1.6). Owned per figure.
 */
function emissiveMat(color: number, intensity = 2.2): MeshStandardMaterial {
  const material = new MeshStandardMaterial({ color: 0x05070a, roughness: 0.35, metalness: 0 });
  material.emissive = new Color(color);
  material.emissiveIntensity = intensity;
  return material;
}

/** Build a mesh that casts + receives shadows (every body part should). */
function makeMesh(geometry: BufferGeometry, material: MeshStandardMaterial): Mesh {
  const mesh = new Mesh(geometry, material);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

/** Create a mesh, position it, parent it, and return it for further tweaks. */
function add(
  parent: Object3D,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  x = 0,
  y = 0,
  z = 0,
): Mesh {
  const mesh = makeMesh(geometry, material);
  mesh.position.set(x, y, z);
  parent.add(mesh);
  return mesh;
}

/** A rounded box (cheap bevels). Radius is clamped to stay valid for the dims. */
function rbox(w: number, h: number, d: number, r = 0.05): RoundedBoxGeometry {
  const radius = Math.max(0.005, Math.min(r, Math.min(w, h, d) * 0.5 - 0.001));
  return new RoundedBoxGeometry(w, h, d, 2, radius);
}

/** A smooth capsule spanning two points (limbs, struts), capped at each end. */
function capsule(
  parent: Object3D,
  a: Vector3,
  b: Vector3,
  r: number,
  material: MeshStandardMaterial,
  radialSegments = 8,
): Mesh {
  const dir = new Vector3().subVectors(b, a);
  const len = Math.max(0.001, dir.length());
  const cyl = Math.max(0.01, len - r * 2);
  const mesh = makeMesh(new CapsuleGeometry(r, cyl, 3, radialSegments), material);
  mesh.position.copy(a).lerp(b, 0.5);
  mesh.quaternion.setFromUnitVectors(UP, dir.normalize());
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Player: armoured soldier holding a rifle (rifle = +Z forward cue)
// ---------------------------------------------------------------------------

function buildSoldier(root: Group, p: Palette, weaponId: string): void {
  const armor = mat(p.primary, { rough: 0.5, metal: 0.45, env: 0.9 });
  const armorLite = mat(p.primary, { rough: 0.42, metal: 0.5, flat: false, env: 1.0 });
  const dark = mat(p.secondary, { rough: 0.75, metal: 0.3 });
  const steel = mat(p.metal, { rough: 0.3, metal: 0.9, flat: false, env: 1.0 });
  const visor = emissiveMat(p.glow, 2.4);
  const light = emissiveMat(p.glow, 2.0);

  // Legs: capsule thigh + armoured shin, knee pad, forward boot.
  for (const side of [-1, 1] as const) {
    const x = 0.13 * side;
    const leg = new Group();
    leg.name = side < 0 ? "leftLeg" : "rightLeg";
    leg.position.set(x, 0.84, -0.01);
    root.add(leg);
    capsule(leg, new Vector3(0, 0, 0), new Vector3(0, -0.37, 0.03), 0.085, dark);
    capsule(leg, new Vector3(0, -0.37, 0.03), new Vector3(0, -0.71, -0.01), 0.07, armor);
    add(leg, new SphereGeometry(0.08, 10, 8), armor, 0, -0.37, 0.05);
    add(leg, rbox(0.17, 0.12, 0.32, 0.04), dark, 0, -0.77, 0.07);
  }

  // Pelvis.
  add(root, rbox(0.38, 0.2, 0.26, 0.05), dark, 0, 0.86, 0);

  // Torso: capsule core under a chest plate + backpack + glowing team light.
  const torso = add(root, new CapsuleGeometry(0.18, 0.14, 3, 10), dark, 0, 1.02, 0);
  torso.scale.set(1.05, 1, 0.82);
  add(root, rbox(0.36, 0.3, 0.16, 0.05), armor, 0, 1.04, 0.06);
  add(root, rbox(0.3, 0.34, 0.16, 0.05), dark, 0, 1.02, -0.15);
  add(root, new SphereGeometry(0.03, 8, 8), light, 0, 1.1, 0.16);

  // Pauldrons.
  for (const side of [-1, 1] as const) {
    const pauldron = add(root, new SphereGeometry(0.13, 12, 10), armor, 0.26 * side, 1.16, 0);
    pauldron.scale.set(1.1, 0.85, 1.15);
  }

  // Neck + head + helmet + glowing visor (forward cue) + antenna.
  add(root, new CylinderGeometry(0.07, 0.075, 0.08, 10), dark, 0, 1.24, 0);
  add(root, new SphereGeometry(0.1, 12, 10), dark, 0, 1.32, 0);
  const helmet = add(root, new SphereGeometry(0.135, 16, 12), armorLite, 0, 1.34, -0.01);
  helmet.scale.set(1, 1.0, 1.1);
  add(root, rbox(0.2, 0.06, 0.06, 0.025), visor, 0, 1.33, 0.115);
  const antenna = add(root, new CylinderGeometry(0.006, 0.01, 0.22, 6), steel, -0.1, 1.5, -0.06);
  antenna.rotation.x = -0.18;

  // Left arm braces under the barrel.
  const supportArm = new Group();
  supportArm.name = "leftArm";
  supportArm.position.set(-0.25, 1.14, 0);
  root.add(supportArm);
  capsule(supportArm, new Vector3(0, 0, 0), new Vector3(0.05, -0.21, 0.16), 0.06, armor);
  capsule(
    supportArm,
    new Vector3(0.05, -0.21, 0.16),
    new Vector3(0.19, -0.28, 0.34),
    0.05,
    dark,
  );
  add(supportArm, new SphereGeometry(0.05, 8, 8), dark, 0.19, -0.28, 0.34);

  // Right arm + rifle live in a pivot group so the pose can swing them.
  const weaponArm = new Group();
  weaponArm.name = "weaponArm";
  weaponArm.position.set(0.26, 1.14, 0.02);
  root.add(weaponArm);

  // Upper arm down to the trigger hand.
  capsule(weaponArm, new Vector3(0, 0, 0), new Vector3(-0.04, -0.2, 0.12), 0.06, armor);
  capsule(weaponArm, new Vector3(-0.04, -0.2, 0.12), new Vector3(-0.18, -0.12, 0.24), 0.05, dark);
  add(weaponArm, new SphereGeometry(0.05, 8, 8), dark, -0.18, -0.12, 0.26);

  const weapon = createWeaponModel(weaponId);
  weapon.position.set(-0.18, -0.08, 0.12);
  weapon.scale.setScalar(0.82);
  weaponArm.add(weapon);
}

// ---------------------------------------------------------------------------
// Enemy "drone": floating pod, single glowing eye (+Z), tripod claws to ground
// ---------------------------------------------------------------------------

function buildDrone(root: Group, p: Palette, weaponId: string): void {
  const shell = mat(p.primary, { rough: 0.35, metal: 0.7, flat: false, env: 1.1 });
  const dark = mat(p.secondary, { rough: 0.55, metal: 0.5 });
  const steel = mat(p.metal, { rough: 0.3, metal: 0.85, flat: false, env: 1.0 });
  const eye = emissiveMat(p.glow, 2.6);
  const thruster = emissiveMat(p.glow, 1.8);
  const rig = new Group();
  rig.name = "droneRig";
  root.add(rig);

  // Forward-leaning ovoid core + equatorial panel ring.
  const body = add(rig, new SphereGeometry(0.3, 20, 16), shell, 0, 0.86, 0);
  body.scale.set(1, 0.82, 1.18);
  body.rotation.x = -0.2;
  const ring = add(rig, new TorusGeometry(0.31, 0.035, 10, 24), steel, 0, 0.86, 0);
  ring.rotation.x = Math.PI / 2 - 0.2;

  // Dark cowl hooding the top.
  const cowl = add(
    rig,
    new SphereGeometry(0.28, 18, 10, 0, Math.PI * 2, 0, Math.PI * 0.6),
    dark,
    0,
    0.92,
    -0.02,
  );
  cowl.scale.set(1.12, 0.95, 1.2);
  cowl.rotation.x = -0.2;

  // Glowing eye + socket + iris ring on +Z (forward cue).
  add(rig, new SphereGeometry(0.14, 14, 12), dark, 0, 0.85, 0.2);
  add(rig, new SphereGeometry(0.09, 16, 14), eye, 0, 0.86, 0.3);
  add(rig, new TorusGeometry(0.1, 0.018, 8, 20), eye, 0, 0.86, 0.31);

  // Mandible spikes flanking the eye.
  const spikeGeo = new ConeGeometry(0.04, 0.18, 8);
  for (const side of [-1, 1] as const) {
    const spike = add(rig, spikeGeo, steel, 0.16 * side, 0.74, 0.24);
    spike.rotation.set(1.2, 0, -0.4 * side);
  }

  // Tripod landing struts (feet at y = 0) with claw tips.
  const hub = new Vector3(0, 0.6, 0);
  const feet = [
    [0, 0.26],
    [-0.24, -0.16],
    [0.24, -0.16],
  ] as const;
  const clawGeo = new ConeGeometry(0.04, 0.13, 8);
  for (const foot of feet) {
    const tip = new Vector3(foot[0], 0.04, foot[1]);
    capsule(rig, hub, tip, 0.03, steel, 6);
    const claw = add(rig, clawGeo, dark, foot[0], 0.06, foot[1]);
    claw.rotation.x = Math.PI; // point the claw into the floor
  }

  // Under-thruster glow (floating cue + bloom).
  const jet = add(rig, new ConeGeometry(0.12, 0.16, 16, 1, true), thruster, 0, 0.6, 0);
  jet.rotation.x = Math.PI; // open downward

  // Two forward manipulators with claw tips.
  const manipClaw = new ConeGeometry(0.035, 0.13, 8);
  for (const side of [-1, 1] as const) {
    const shoulder = new Vector3(0.2 * side, 0.82, 0.14);
    const wrist = new Vector3(0.3 * side, 0.6, 0.36);
    capsule(rig, shoulder, wrist, 0.028, steel, 6);
    const claw = add(rig, manipClaw, dark, 0.32 * side, 0.55, 0.42);
    claw.rotation.set(1.1, 0, -0.4 * side);
  }

  const weapon = createWeaponModel(weaponId);
  weapon.position.set(0, 0.67, 0.29);
  weapon.scale.setScalar(0.64);
  rig.add(weapon);
}

// ---------------------------------------------------------------------------
// Enemy "sentinel": hunched biped, oversized shoulders, low glowing visor
// ---------------------------------------------------------------------------

function buildSentinel(root: Group, p: Palette, weaponId: string): void {
  const shell = mat(p.primary, { rough: 0.5, metal: 0.5, env: 0.95 });
  const dark = mat(p.secondary, { rough: 0.72, metal: 0.35 });
  const steel = mat(p.metal, { rough: 0.35, metal: 0.8, flat: false, env: 1.0 });
  const visor = emissiveMat(p.glow, 2.2);
  const vent = emissiveMat(p.glow, 1.6);

  // Digitigrade legs reaching the ground (feet at y = 0).
  const footGeo = rbox(0.17, 0.1, 0.32, 0.03);
  for (const side of [-1, 1] as const) {
    const x = 0.15 * side;
    const leg = new Group();
    leg.name = side < 0 ? "leftLeg" : "rightLeg";
    leg.position.set(x, 0.8, -0.02);
    root.add(leg);
    const hip = new Vector3(0, 0, 0);
    const knee = new Vector3(0.03 * side, -0.34, 0.16);
    const ankle = new Vector3(0, -0.62, -0.08);
    capsule(leg, hip, knee, 0.09, dark); // thigh
    capsule(leg, knee, ankle, 0.07, shell); // shin
    add(leg, new SphereGeometry(0.07, 10, 8), shell, 0.03 * side, -0.34, 0.16); // knee
    add(leg, footGeo, dark, 0, -0.75, 0.1); // forward foot
  }

  // Pelvis.
  add(root, rbox(0.36, 0.2, 0.26, 0.05), dark, 0, 0.82, -0.02);

  // Hunched upper body: a hip-pivoted group tilted forward.
  const torso = new Group();
  torso.name = "torso";
  torso.position.set(0, 0.84, -0.02);
  torso.rotation.x = 0.34; // the menacing forward lean
  root.add(torso);

  // Torso shell (capsule) + glowing chest vent.
  const shellMesh = add(torso, new CapsuleGeometry(0.2, 0.16, 3, 10), shell, 0, 0.22, 0);
  shellMesh.scale.set(1.05, 1, 0.85);
  add(torso, rbox(0.26, 0.14, 0.06, 0.02), vent, 0, 0.26, 0.17);

  // Back spines for menace.
  const spineGeo = new ConeGeometry(0.04, 0.16, 6);
  for (let i = 0; i < 3; i++) {
    const spine = add(torso, spineGeo, steel, 0, 0.18 + i * 0.12, -0.16);
    spine.rotation.x = -0.5;
  }

  // Oversized shoulders, set ABOVE the head for a hunched silhouette.
  for (const side of [-1, 1] as const) {
    const shoulder = add(torso, new SphereGeometry(0.18, 14, 12), shell, 0.32 * side, 0.44, -0.02);
    shoulder.scale.set(1.1, 0.9, 1.1);
  }

  // Small head slung low/forward with a glowing visor band (+Z cue).
  add(torso, rbox(0.22, 0.18, 0.24, 0.04), dark, 0, 0.36, 0.12);
  add(torso, rbox(0.2, 0.05, 0.05, 0.02), visor, 0, 0.36, 0.25);

  // Long arms ending in claws, hanging forward.
  const clawGeo = new ConeGeometry(0.06, 0.2, 6);
  for (const side of [-1, 1] as const) {
    const shoulder = new Vector3(0.32 * side, 0.42, -0.02);
    const elbow = new Vector3(0.38 * side, 0.12, 0.14);
    const wrist = new Vector3(0.3 * side, -0.14, 0.28);
    const arm = new Group();
    arm.name = side < 0 ? "leftArm" : "rightArm";
    arm.position.copy(shoulder);
    torso.add(arm);
    const localElbow = elbow.clone().sub(shoulder);
    const localWrist = wrist.clone().sub(shoulder);
    capsule(arm, new Vector3(0, 0, 0), localElbow, 0.075, steel); // upper arm
    capsule(arm, localElbow, localWrist, 0.06, dark); // forearm
    const claw = add(
      arm,
      clawGeo,
      steel,
      0.3 * side - shoulder.x,
      -0.22 - shoulder.y,
      0.32 - shoulder.z,
    );
    claw.rotation.x = Math.PI * 0.8;

    if (side === 1) {
      const weapon = createWeaponModel(weaponId);
      weapon.position.set(localWrist.x - 0.04, localWrist.y, localWrist.z + 0.02);
      weapon.scale.setScalar(0.72);
      arm.add(weapon);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Build a faction/template-specific figure: feet at y = 0, ~1.4–1.5 units
 * tall, local +Z forward. Every body mesh casts + receives shadows and the
 * visor / eye / vent is emissive so the renderer's bloom pass makes it glow.
 * Every descendant carries `userData.unitId` so the renderer can pick a unit
 * with a recursive raycast against the group.
 */
export function createCharacterMesh(unit: Unit): Group {
  const root = new Group();
  const palette = paletteFor(unit);

  if (unit.faction === "player") {
    buildSoldier(root, palette, unit.weaponId);
  } else if (unit.templateId === "drone") {
    buildDrone(root, palette, unit.weaponId);
  } else {
    buildSentinel(root, palette, unit.weaponId);
  }

  setCharacterWalkPose(root, 0, 0);
  root.userData.unitId = unit.id;
  root.traverse((obj) => {
    obj.userData.unitId = unit.id;
  });
  return root;
}

/**
 * Cheap idle/aim tweak: only the soldier's rifle arm responds. Aiming levels
 * the weapon; otherwise it rests slightly low. Safe to call on any figure.
 */
export function setCharacterPose(group: Group, opts: { aiming?: boolean }): void {
  const arm = group.getObjectByName("weaponArm");
  if (arm) arm.rotation.x = opts.aiming ? -0.14 : 0.06;
}

/**
 * Apply a procedural walk pose at `progress` in [0, 1]. A full tile step runs
 * one complete stride, so progress 0 and 1 both return to the neutral pose.
 * `amount = 0` is an explicit reset used after movement and state resync.
 */
export function setCharacterWalkPose(group: Group, progress: number, amount = 1): void {
  const phase = Math.max(0, Math.min(1, progress)) * Math.PI * 2;
  const stride = Math.sin(phase) * amount;
  const bounce = Math.abs(Math.sin(phase)) * amount;
  const leftLeg = group.getObjectByName("leftLeg");
  const rightLeg = group.getObjectByName("rightLeg");
  const leftArm = group.getObjectByName("leftArm");
  const rightArm = group.getObjectByName("rightArm");
  const weaponArm = group.getObjectByName("weaponArm");
  const torso = group.getObjectByName("torso");
  const droneRig = group.getObjectByName("droneRig");

  group.position.y = bounce * 0.045;
  group.rotation.z = stride * 0.025;

  if (leftLeg) leftLeg.rotation.x = stride * 0.58;
  if (rightLeg) rightLeg.rotation.x = -stride * 0.58;
  if (leftArm) leftArm.rotation.x = -stride * 0.2;
  if (rightArm) rightArm.rotation.x = stride * 0.2;
  if (weaponArm) weaponArm.rotation.x = 0.06 + stride * 0.11;

  if (torso) {
    torso.rotation.x = 0.34 + bounce * 0.045;
    torso.rotation.z = -stride * 0.035;
  }
  if (droneRig) {
    group.position.y = bounce * 0.1;
    droneRig.rotation.x = -stride * 0.07;
    droneRig.rotation.z = stride * 0.1;
  }
}

/** Dispose every unique geometry/material under the figure (no leaks). */
export function disposeCharacter(group: Group): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  group.traverse((obj) => {
    if (obj instanceof Mesh) {
      geometries.add(obj.geometry);
      const m = obj.material;
      if (Array.isArray(m)) for (const one of m) materials.add(one);
      else materials.add(m);
    }
  });
  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}
