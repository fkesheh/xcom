/**
 * Frozen art vocabulary for the base "cutaway" diorama (Layer 1). Both the
 * base scene builder (baseView.ts) and the facility-model factories
 * (baseFacilities.ts) import these so every part of the base traces to one
 * curated palette and one material model — never ad-hoc colors.
 *
 * Mood: an underground command facility carved into rock — a cross-section
 * "ant-farm" diorama. Cool steel architecture sunk in blue-black rock, each
 * facility bay glowing with its own signature work-light.
 *
 * Material model: stylized PBR (MeshStandardMaterial). Steel/concrete/rock are
 * rough matte-to-metallic; each facility has an EMISSIVE accent so it reads at a
 * glance and glows from within. Never flat-shaded, never ad-hoc hex.
 */
import { Color, MeshStandardMaterial } from "three";

/** Named palette — all base colors trace here. */
export const BASE_PALETTE = {
  /** Deep blue-black rock the base is carved into (also the void + fog color). */
  rock: 0x0b0f16,
  rockLight: 0x141c28,
  /** Brushed-steel architecture. */
  steel: 0x3a4250,
  steelEdge: 0x707b8c,
  /** Matte concrete floor + walls. */
  concrete: 0x20242c,
  /** Subtle teal floor grid lines. */
  floorLine: 0x2f7a72,
  /** Facility identity accents (emissive). */
  accent: {
    command: 0x6aa8ff,
    lab: 0x38e1d6,
    workshop: 0xf0a040,
    barracks: 0xf2dcc0,
    hangar: 0x50e06a,
    radar: 0xc060ff,
    reactor: 0xffce5a,
  },
  /** Danger / offline / low-power. */
  danger: 0xe05060,
} as const;

export type FacilityRole = keyof typeof BASE_PALETTE.accent;

/** Slight sheen steel for structural members (walls, frames, gantries). */
export function steelMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: BASE_PALETTE.steel, metalness: 0.55, roughness: 0.55 });
}

/** Matte concrete for floors / heavy walls. */
export function concreteMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: BASE_PALETTE.concrete, metalness: 0.0, roughness: 0.95 });
}

/** Dark rock for the carved cavity walls. */
export function rockMaterial(): MeshStandardMaterial {
  return new MeshStandardMaterial({ color: BASE_PALETTE.rockLight, metalness: 0.0, roughness: 1.0 });
}

/**
 * An emissive "work-light" material in a facility's signature accent color.
 * `intensity` controls the glow (0.4 subtle, 1.2+ a bright beacon).
 */
export function accentMaterial(role: FacilityRole, intensity = 0.8): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color: BASE_PALETTE.accent[role],
    emissive: new Color(BASE_PALETTE.accent[role]),
    emissiveIntensity: intensity,
    metalness: 0.2,
    roughness: 0.4,
  });
}

/** Pick a facility accent role from a facility id/kind hint (best-effort). */
export function roleForKind(kind: string): FacilityRole {
  const k = kind.toLowerCase();
  if (k.includes("lab") || k.includes("research") || k.includes("sci")) return "lab";
  if (k.includes("work") || k.includes("shop") || k.includes("eng") || k.includes("fact")) return "workshop";
  if (k.includes("live") || k.includes("bar") || k.includes("quart")) return "barracks";
  if (k.includes("hang") || k.includes("craft") || k.includes("sky")) return "hangar";
  if (k.includes("radar") || k.includes("sensor") || k.includes("comm")) return "radar";
  if (k.includes("react") || k.includes("power") || k.includes("gen")) return "reactor";
  if (k.includes("command") || k.includes("centre") || k.includes("ops")) return "command";
  return "command";
}
