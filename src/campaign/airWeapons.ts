import type { Craft } from "./types";

// ============================================================================
// AIR-COMBAT WEAPON DATA MODEL  (frozen contract v1)
// Heavy / light missiles + a close-range cannon. Data-driven per-craft loadouts.
// ============================================================================

export type AirWeaponClass = "heavy" | "light" | "cannon";

// The finite, frozen set of AIR_WEAPONS catalog keys — keeping this as its own
// union lets AIR_WEAPONS be typed so literal-key access (AIR_WEAPONS.stingray)
// is non-optional under noUncheckedIndexedAccess, while dynamic string lookups
// (craft.loadout ids) still go through the `airWeapon()` helper below.
export type AirWeaponId = "avalanche" | "stingray" | "cannon";

export interface AirWeapon {
  id: string; // "avalanche" | "stingray" | "cannon"
  name: string; // display ("Avalanche-class missile")
  cls: AirWeaponClass;
  rangeKm: number; // max engagement distance a shot can be fired at
  damage: number; // raw damage vs encounter UFO HP (encounterUfoHpMax)
  shots: number; // rounds carried per sortie (cannon = burst pool)
  lockBeats: number; // engagement beats to acquire lock before the shot leaves the rail
  // Evasion coupling: multiplies the range-scaled, agility-scaled dodge chance.
  evasionMult: number;
  // Only heavy ordnance can vaporize a small hull (see resolveShot / geoscape terminal).
  canVaporize: boolean;
}

// FROZEN CATALOG — id is the source of truth; loadouts reference these ids.
export const AIR_WEAPONS: Readonly<Record<AirWeaponId, AirWeapon>> = {
  avalanche: {
    id: "avalanche",
    name: "Avalanche-class missile",
    cls: "heavy",
    rangeKm: 95,
    damage: 60,
    shots: 2,
    lockBeats: 3,
    evasionMult: 1.0,
    canVaporize: true,
  },
  stingray: {
    id: "stingray",
    name: "Stingray-class missile",
    cls: "light",
    rangeKm: 65,
    damage: 28,
    shots: 5,
    lockBeats: 1,
    evasionMult: 0.85,
    canVaporize: false,
  },
  cannon: {
    id: "cannon",
    name: "Gauss cannon",
    cls: "cannon",
    rangeKm: 10,
    damage: 12,
    shots: 40,
    lockBeats: 0,
    evasionMult: 0.5,
    canVaporize: false,
  },
};

/** Catalog lookup by weapon id. */
export function airWeapon(id: string): AirWeapon | undefined {
  return (AIR_WEAPONS as Readonly<Record<string, AirWeapon>>)[id];
}

/** Kind-aware default loadout when a craft carries no explicit `loadout`. */
function defaultLoadoutIds(craft: Craft): string[] {
  // Only interceptors engage in air-to-air; a transport never fires.
  return craft.kind === "interceptor" ? ["stingray", "cannon"] : [];
}

/**
 * Ordered air-combat weapons a craft brings to a sortie. An explicit `craft.loadout`
 * (AIR_WEAPONS ids) wins; otherwise the kind default. A heavy platform (one carrying
 * the Avalanche — the Phantom) runs a deeper Stingray magazine (6 vs 5), the
 * "more/better ordnance" the advanced interceptor is spec'd to carry.
 */
export function craftLoadout(craft: Craft): AirWeapon[] {
  const ids =
    Array.isArray(craft.loadout) && craft.loadout.length > 0 ? craft.loadout : defaultLoadoutIds(craft);
  const heavy = ids.includes("avalanche");
  const weapons: AirWeapon[] = [];
  for (const id of ids) {
    const w = (AIR_WEAPONS as Readonly<Record<string, AirWeapon>>)[id];
    if (!w) continue;
    if (w.id === "stingray" && heavy) {
      weapons.push({ ...w, shots: 6 });
    } else {
      weapons.push(w);
    }
  }
  return weapons;
}

/** Remaining-shots map seeded from a loadout at encounter start (weaponId -> shots). */
export function ammoFor(loadout: AirWeapon[]): Record<string, number> {
  const ammo: Record<string, number> = {};
  for (const w of loadout) {
    ammo[w.id] = w.shots;
  }
  return ammo;
}

/**
 * The UFO's dodge chance against a specific shot: scales UP with range (fraction of the
 * weapon's reach) and the hull's agility, then by the weapon's evasion coupling. Capped
 * at 0.9 so nothing is a guaranteed miss. A telegraphing heavy missile at max reach vs a
 * jinky scout approaches the cap (near-guaranteed jink — the thrill); a cannon at
 * point-blank vs a battleship is near zero (a barn, almost always hit).
 */
export function evasionChance(agility: number, rangeKm: number, weapon: AirWeapon): number {
  const reachFrac = Math.min(1, rangeKm / weapon.rangeKm);
  const raw = agility * (0.25 + 0.75 * reachFrac) * weapon.evasionMult;
  return Math.max(0, Math.min(0.9, raw));
}

export interface ShotResult {
  hit: boolean;
  damage: number;
  evasion: number;
}

/**
 * Deterministic per-shot resolution. `roll` is a caller-provided 0..1 fraction
 * (seeded upstream); the shot connects when the roll clears the evasion chance. A hit's
 * damage scales the weapon's raw damage by the engaging craft's weapon power and the
 * difficulty multiplier. Pure — no RNG, no allocation beyond the result.
 */
export function resolveShot(
  weapon: AirWeapon,
  rangeKm: number,
  agility: number,
  roll: number,
  weaponPower: number,
  damageMult: number,
): ShotResult {
  const evasion = evasionChance(agility, rangeKm, weapon);
  const hit = roll >= evasion;
  const damage = hit ? weapon.damage * weaponPower * damageMult : 0;
  return { hit, damage, evasion };
}
