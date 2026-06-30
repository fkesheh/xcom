/**
 * Data-driven game content: weapons, items, unit templates, and flavour name pools.
 *
 * Everything here is generic and rebrandable — no trademarked names. Tuning
 * lives in data so balance is one edit away. Accuracy stays on the classic
 * 0..120 scale (interpreted as a percentage by the combat model).
 */

import type { Item, UnitTemplate, Weapon } from "./types";

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
    damage: 34,
    range: 14,
    magazineSize: 8,
    reloadTuPercent: 24,
    modes: [
      { kind: "snap", tuPercent: 30, accuracy: 50, shots: 1 },
      { kind: "aimed", tuPercent: 55, accuracy: 100, shots: 1 },
    ],
  },
  cannon: {
    id: "cannon",
    name: "Assault Cannon",
    // Heavy hitter: high base damage in exchange for short range, low
    // accuracy, and a steep TU cost. A single landed shot defines a turn.
    damage: 45,
    range: 7,
    magazineSize: 6,
    reloadTuPercent: 30,
    modes: [
      { kind: "snap", tuPercent: 45, accuracy: 45, shots: 1 },
      { kind: "aimed", tuPercent: 70, accuracy: 80, shots: 1 },
    ],
  },
  sniper: {
    id: "sniper",
    name: "Marksman Rifle",
    // Precision tool: very high accuracy multiplier and long effective range,
    // priced at a very high TU cost so it fires one deliberate shot per turn.
    damage: 45,
    range: 20,
    magazineSize: 5,
    reloadTuPercent: 28,
    modes: [
      { kind: "snap", tuPercent: 40, accuracy: 75, shots: 1 },
      { kind: "aimed", tuPercent: 80, accuracy: 140, shots: 1 },
    ],
  },
};

/** Consumable item catalogue. Keyed by stable id. */
export const ITEMS: Record<string, Item> = {
  grenade: {
    id: "grenade",
    name: "Frag Grenade",
    kind: "grenade",
    tuPercent: 30,
    blastRadius: 2,
    damage: 56,
    throwRange: 8,
  },
  medkit: {
    id: "medkit",
    name: "Medkit",
    kind: "medkit",
    tuPercent: 40,
    healAmount: 30,
  },
  smoke: {
    id: "smoke",
    name: "Smoke Grenade",
    kind: "smoke",
    tuPercent: 30,
    // Radius doubles as the cloud's Chebyshev coverage; the cloud itself deals
    // no damage — it blocks line of sight/fire across its tiles for N turns.
    blastRadius: 2,
    throwRange: 8,
  },
  scanner: {
    id: "scanner",
    name: "Motion Scanner",
    kind: "scanner",
    tuPercent: 25,
    // Chebyshev radius of the through-wall reveal applied to the user this turn.
    scanRadius: 8,
  },
  proxMine: {
    id: "proxMine",
    name: "Proximity Mine",
    kind: "proxMine",
    tuPercent: 35,
    blastRadius: 2,
    damage: 50,
    throwRange: 8,
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
      bravery: 55,
    },
    weaponId: "rifle",
    items: ["grenade", "medkit"],
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
      bravery: 90,
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
      bravery: 60,
    },
    weaponId: "plasma",
    items: ["grenade"],
    sightRange: 18,
    visionHalfAngleDeg: 45,
  },
  heavy: {
    id: "heavy",
    name: "Heavy",
    faction: "enemy",
    // Tank: soaks damage with the highest HP in the roster and brings the
    // cannon to bear. Slow TUs mean it advances deliberately and fires once.
    stats: {
      timeUnits: 42,
      health: 80,
      reactions: 30,
      firingAccuracy: 55,
      strength: 60,
      bravery: 70,
    },
    weaponId: "cannon",
    sightRange: 16,
    visionHalfAngleDeg: 45,
  },
  stalker: {
    id: "stalker",
    name: "Stalker",
    faction: "enemy",
    // Glass cannon: lowest enemy HP but fast TUs, sharp reactions, and a
    // sniper rifle. Kills at range from cover, dies to a single burst.
    stats: {
      timeUnits: 75,
      health: 20,
      reactions: 70,
      firingAccuracy: 80,
      strength: 30,
      bravery: 50,
    },
    weaponId: "sniper",
    sightRange: 22,
    visionHalfAngleDeg: 40,
  },
  commander: {
    id: "commander",
    name: "Commander",
    faction: "enemy",
    // Priority target: high reactions and the roster's top bravery make it a
    // steady, panic-proof leader that presses the attack, carries a grenade, and
    // is the roster's sole psionic — it can break a soldier's nerve or seize
    // control of one (hard-capped at a single mind control per battle).
    stats: {
      timeUnits: 58,
      health: 50,
      reactions: 75,
      firingAccuracy: 62,
      strength: 40,
      bravery: 90,
      psiSkill: 60,
      psiStrength: 70,
    },
    weaponId: "plasma",
    items: ["grenade"],
    sightRange: 20,
    visionHalfAngleDeg: 45,
  },
  civilian: {
    id: "civilian",
    name: "Civilian",
    faction: "civilian",
    stats: {
      timeUnits: 40,
      health: 8,
      reactions: 20,
      firingAccuracy: 10,
      strength: 20,
      bravery: 30,
    },
    // Armed in data only so spawnUnit can resolve a magazine; civilians NEVER
    // take a turn, so the pistol is never fired.
    weaponId: "pistol",
    sightRange: 10,
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

/** Name pool for civilians caught in a terror-site strike zone. */
export const CIVILIAN_NAMES: string[] = [
  "Anya",
  "Tariq",
  "Mira",
  "Jonas",
  "Sora",
  "Felipe",
  "Inga",
  "Dev",
  "Lena",
  "Olek",
  "Priya",
  "Marco",
  "Yuki",
  "Hana",
  "Bilal",
  "Nadia",
];
