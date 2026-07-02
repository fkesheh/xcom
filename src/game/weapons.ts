import {
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
} from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

export type WeaponVisualKind = "rifle" | "pistol" | "plasma";

function material(color: number, roughness = 0.45, metalness = 0.65): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness });
}

function glow(color: number, intensity = 3): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive: new Color(color),
    emissiveIntensity: intensity,
    roughness: 0.2,
    metalness: 0.25,
  });
}

function add(
  parent: Object3D,
  geometry: BufferGeometry,
  material: MeshStandardMaterial,
  x: number,
  y: number,
  z: number,
): Mesh {
  const result = new Mesh(geometry, material);
  result.position.set(x, y, z);
  result.castShadow = true;
  result.receiveShadow = true;
  parent.add(result);
  return result;
}

function rounded(width: number, height: number, depth: number, radius = 0.02): RoundedBoxGeometry {
  return new RoundedBoxGeometry(width, height, depth, 2, radius);
}

function barrel(
  parent: Object3D,
  radius: number,
  length: number,
  material: MeshStandardMaterial,
  x: number,
  y: number,
  z: number,
): Mesh {
  const result = add(parent, new CylinderGeometry(radius, radius, length, 12), material, x, y, z);
  result.rotation.x = Math.PI / 2;
  return result;
}

function addMuzzle(root: Group, z: number, y = 0): void {
  const muzzle = new Object3D();
  muzzle.name = "weaponMuzzle";
  muzzle.position.set(0, y, z);
  root.add(muzzle);
}

function createRifle(): Group {
  const root = new Group();
  const dark = material(0x101720, 0.38, 0.82);
  const steel = material(0x526272, 0.3, 0.88);
  const furniture = material(0x273443, 0.65, 0.35);
  // Teal optic to match the friendly team accent (FACTION_ACCENT.player, kept in
  // sync by value to avoid a characters.ts <-> weapons.ts import cycle).
  const lens = glow(0x38e8d2, 2.2);

  const stock = add(root, rounded(0.13, 0.16, 0.29, 0.035), furniture, 0, -0.015, -0.18);
  stock.rotation.x = -0.08;
  add(root, rounded(0.14, 0.15, 0.31, 0.025), dark, 0, 0, 0.08);
  add(root, rounded(0.12, 0.12, 0.29), furniture, 0, 0, 0.36);
  barrel(root, 0.025, 0.38, steel, 0, 0.015, 0.62);
  barrel(root, 0.042, 0.105, dark, 0, 0.015, 0.82);

  const grip = add(root, rounded(0.085, 0.22, 0.105, 0.025), dark, 0, -0.145, 0.055);
  grip.rotation.x = -0.24;
  const magazine = add(root, rounded(0.09, 0.25, 0.12), steel, 0, -0.17, 0.22);
  magazine.rotation.x = 0.18;

  add(root, rounded(0.06, 0.065, 0.22, 0.015), dark, 0, 0.105, 0.11);
  const optic = add(root, new CylinderGeometry(0.035, 0.035, 0.13, 12), lens, 0, 0.118, 0.15);
  optic.rotation.x = Math.PI / 2;
  add(root, new BoxGeometry(0.025, 0.025, 0.04), lens, 0.075, 0.02, 0.16);

  addMuzzle(root, 0.885, 0.015);
  return root;
}

function createPistol(): Group {
  const root = new Group();
  const dark = material(0x141a22, 0.42, 0.78);
  const steel = material(0x657383, 0.32, 0.86);
  const accent = material(0x9caebc, 0.28, 0.9);
  const sight = glow(0xff6b45, 2.4);

  add(root, rounded(0.125, 0.105, 0.38, 0.025), steel, 0, 0.035, 0.1);
  add(root, rounded(0.115, 0.095, 0.27), dark, 0, -0.045, 0.035);
  const grip = add(root, rounded(0.11, 0.27, 0.13, 0.028), dark, 0, -0.19, -0.04);
  grip.rotation.x = -0.24;
  barrel(root, 0.025, 0.16, accent, 0, 0.036, 0.34);
  add(root, new BoxGeometry(0.035, 0.025, 0.03), sight, 0, 0.104, 0.225);
  add(root, new BoxGeometry(0.04, 0.025, 0.025), sight, 0, 0.104, -0.045);

  const triggerGuard = add(root, new TorusGeometry(0.064, 0.012, 7, 14, Math.PI), dark, 0, -0.105, 0.08);
  triggerGuard.rotation.z = Math.PI;
  triggerGuard.scale.z = 0.7;

  addMuzzle(root, 0.43, 0.036);
  return root;
}

function createPlasmaCaster(): Group {
  const root = new Group();
  const shell = material(0x25253d, 0.3, 0.72);
  const metal = material(0x7a78a0, 0.26, 0.84);
  const energy = glow(0x8d5cff, 4.2);
  const hotEnergy = glow(0x68f3ff, 5);

  add(root, rounded(0.19, 0.17, 0.38, 0.055), shell, 0, 0, 0.08);
  const core = add(root, new SphereGeometry(0.09, 16, 10), energy, 0, 0.02, 0.1);
  core.scale.set(1.15, 0.72, 1);
  const coil = add(root, new TorusGeometry(0.115, 0.025, 8, 18), metal, 0, 0.02, 0.1);
  coil.rotation.x = Math.PI / 2;

  for (const x of [-0.07, 0.07]) {
    barrel(root, 0.032, 0.39, metal, x, 0, 0.43);
    const shroud = add(root, new ConeGeometry(0.047, 0.105, 10, 1, true), energy, x, 0, 0.65);
    shroud.rotation.x = Math.PI / 2;
  }

  add(root, rounded(0.09, 0.2, 0.12, 0.025), shell, 0, -0.145, 0);
  add(root, new SphereGeometry(0.04, 12, 8), hotEnergy, 0, 0, 0.66);
  add(root, new BoxGeometry(0.035, 0.035, 0.08), hotEnergy, 0.12, 0.01, 0.17);

  addMuzzle(root, 0.71);
  return root;
}

export function weaponKindForId(weaponId: string): WeaponVisualKind {
  if (weaponId === "pistol" || weaponId === "plasma") return weaponId;
  return "rifle";
}

export function createWeaponModel(weaponId: string): Group {
  const kind = weaponKindForId(weaponId);
  const root = kind === "pistol" ? createPistol() : kind === "plasma" ? createPlasmaCaster() : createRifle();
  root.name = "weaponModel";
  root.userData.weaponId = kind;
  return root;
}
