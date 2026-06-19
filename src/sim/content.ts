/**
 * Data-driven game content: weapons, unit templates, and flavour name pools.
 *
 * Everything here is generic and rebrandable — no trademarked names. Tuning
 * lives in data so balance is one edit away. Accuracy stays on the classic
 * 0..120 scale (interpreted as a percentage by the combat model).
 */

import type { UnitTemplate, Weapon } from "./types";

/** Weapon catalogue. Keyed by stable id (also stored on the weapon). */
export const WEAPONS: Record<string, Weapon> = {
  rifle: {
    id: "rifle",
    name: "Service Rifle",
    damage: 26,
    range: 12,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 35, shots: 3 },
    ],
  },
  pistol: {
    id: "pistol",
    name: "Sidearm",
    damage: 18,
    range: 8,
    magazineSize: 12,
    reloadTuPercent: 18,
    modes: [
      { kind: "snap", tuPercent: 18, accuracy: 55, shots: 1 },
      { kind: "aimed", tuPercent: 40, accuracy: 95, shots: 1 },
    ],
  },
  plasma: {
    id: "plasma",
    name: "Plasma Caster",
    damage: 40,
    range: 14,
    magazineSize: 8,
    reloadTuPercent: 24,
    modes: [
      { kind: "snap", tuPercent: 30, accuracy: 50, shots: 1 },
      { kind: "aimed", tuPercent: 55, accuracy: 100, shots: 1 },
    ],
  },
};

/** Spawnable unit templates. Keyed by stable id (also stored on the template). */
export const TEMPLATES: Record<string, UnitTemplate> = {
  trooper: {
    id: "trooper",
    name: "Trooper",
    faction: "player",
    stats: {
      timeUnits: 60,
      health: 40,
      reactions: 50,
      firingAccuracy: 65,
      strength: 35,
    },
    weaponId: "rifle",
    sightRange: 16,
    visionHalfAngleDeg: 45,
  },
  drone: {
    id: "drone",
    name: "Drone",
    faction: "enemy",
    stats: {
      timeUnits: 50,
      health: 32,
      reactions: 35,
      firingAccuracy: 50,
      strength: 40,
    },
    weaponId: "plasma",
    sightRange: 18,
    visionHalfAngleDeg: 50,
  },
  sentinel: {
    id: "sentinel",
    name: "Sentinel",
    faction: "enemy",
    stats: {
      timeUnits: 55,
      health: 46,
      reactions: 45,
      firingAccuracy: 58,
      strength: 50,
    },
    weaponId: "plasma",
    sightRange: 18,
    visionHalfAngleDeg: 45,
  },
};

/** Call-sign style name pool for friendly units. */
export const PLAYER_NAMES: string[] = [
  "Vega",
  "Rook",
  "Mason",
  "Pike",
  "Cole",
  "Reyes",
  "Knox",
  "Drake",
  "Sloane",
  "Hart",
  "Frost",
  "Wren",
];

/** Designation pool for hostile units. */
export const ENEMY_NAMES: string[] = [
  "Zeta-1",
  "Xen-4",
  "Vorn",
  "Krall",
  "Threx",
  "Nyx-9",
  "Skarn",
  "Ulor",
  "Vris",
  "Morth",
];
