import type { CampaignResources } from "./types";

export type FacilityKind =
  | "access"
  | "command"
  | "hangar"
  | "living"
  | "medbay"
  | "lab"
  | "workshop"
  | "stores"
  | "power"
  | "radar"
  | "containment";

export interface BaseFacility {
  id: string;
  label: string;
  kind: FacilityKind;
  x: number;
  y: number;
  w: number;
  h: number;
  powerUse: number;
  powerOutput: number;
  staff: number;
  description: string;
  effect: string;
  constructionHours?: number;
  cost?: CampaignResources;
}

export interface BaseSummary {
  facilities: number;
  powerUsed: number;
  powerCapacity: number;
  staffAssigned: number;
  hangarSlots: number;
}

/**
 * Classic UFO: Enemy Unknown basescape — 6×6 modules.
 * Starter footprint matches OpenXcom `startingBase.rul`:
 *
 *   . . H H . .
 *   . . H H . .
 *   . . A L . .
 *   . R S W K .
 *   H H . . H H
 *   H H . . H H
 *
 * H=hangar 2×2, A=access lift, L=living quarters, R=small radar,
 * S=general stores, W=laboratory, K=workshop.
 */
export const STARTER_BASE_GRID = {
  width: 6,
  height: 6,
} as const;

const NO_COST: CampaignResources = {
  credits: 0,
  alloys: 0,
  elerium: 0,
  alienData: 0,
};

export const STARTER_BASE_FACILITY_IDS = [
  "hangar-1",
  "hangar-2",
  "hangar-3",
  "access-1",
  "living-1",
  "stores-1",
  "lab-1",
  "workshop-1",
  "radar-1",
] as const;

export type BaseFacilityId = string;

/** Facility id of the Alien Containment facility (required to keep live captives). */
export const CONTAINMENT_FACILITY_ID = "containment";

/** Live alien captives a single built containment facility can hold. */
export const CONTAINMENT_CAPACITY = 8;

export const BASE_FACILITIES: readonly BaseFacility[] = [
  {
    id: "hangar-1",
    label: "Hangar",
    kind: "hangar",
    x: 2,
    y: 0,
    w: 2,
    h: 2,
    powerUse: 3,
    powerOutput: 0,
    staff: 10,
    description: "Aircraft berth, recovery crane, and munitions turntable.",
    effect: "Houses one craft — Skyranger or interceptor.",
  },
  {
    id: "hangar-2",
    label: "Hangar",
    kind: "hangar",
    x: 0,
    y: 4,
    w: 2,
    h: 2,
    powerUse: 3,
    powerOutput: 0,
    staff: 10,
    description: "Aircraft berth, recovery crane, and munitions turntable.",
    effect: "Houses one craft — Skyranger or interceptor.",
  },
  {
    id: "hangar-3",
    label: "Hangar",
    kind: "hangar",
    x: 4,
    y: 4,
    w: 2,
    h: 2,
    powerUse: 3,
    powerOutput: 0,
    staff: 10,
    description: "Aircraft berth, recovery crane, and munitions turntable.",
    effect: "Houses one craft — Skyranger or interceptor.",
  },
  {
    id: "access-1",
    label: "Access Lift",
    kind: "access",
    x: 2,
    y: 2,
    w: 1,
    h: 1,
    powerUse: 2,
    // Classic access lift feeds the whole installation — starter power budget.
    powerOutput: 55,
    staff: 4,
    description: "Armored shaft to the surface camouflaged as industrial plant.",
    effect: "Surface access and primary power feed for the underground base.",
  },
  {
    id: "living-1",
    label: "Living Quarters",
    kind: "living",
    x: 3,
    y: 2,
    w: 1,
    h: 1,
    powerUse: 3,
    powerOutput: 0,
    staff: 18,
    description: "Bunks, mess, med alcove, and decompression lock.",
    effect: "Supports recruitment and keeps off-duty operatives housed.",
  },
  {
    id: "stores-1",
    label: "General Stores",
    kind: "stores",
    x: 2,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 1,
    powerOutput: 0,
    staff: 5,
    description: "Secure storage for weapons, alloys, and recovered components.",
    effect: "Stores recovered alloys, elerium, and field equipment.",
  },
  {
    id: "lab-1",
    label: "Laboratory",
    kind: "lab",
    x: 3,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 5,
    powerOutput: 0,
    staff: 12,
    description: "Recovered material analysis and autopsy prep.",
    effect: "Allows scientists to turn recovered data into field upgrades.",
  },
  {
    id: "workshop-1",
    label: "Workshop",
    kind: "workshop",
    x: 4,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 4,
    powerOutput: 0,
    staff: 10,
    description: "Prototype fabrication and field-kit repair benches.",
    effect: "Keeps conventional weapons and armor serviceable between missions.",
  },
  {
    id: "radar-1",
    label: "Small Radar System",
    kind: "radar",
    x: 1,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 8,
    powerOutput: 0,
    staff: 6,
    description: "Surface array for early UFO tracking.",
    effect: "Maintains regional UFO detection from the access lift.",
  },
  // --- Buildable expansions on empty dirt cells ---
  {
    id: "hangar-4",
    label: "Hangar",
    kind: "hangar",
    x: 0,
    y: 0,
    w: 2,
    h: 2,
    powerUse: 3,
    powerOutput: 0,
    staff: 10,
    cost: {
      credits: 200,
      alloys: 5,
      elerium: 0,
      alienData: 0,
    },
    constructionHours: 25,
    description: "Additional aircraft berth for a fourth craft.",
    effect: "Houses one additional craft.",
  },
  {
    id: "command-1",
    label: "Command Center",
    kind: "command",
    x: 1,
    y: 2,
    w: 1,
    h: 1,
    powerUse: 6,
    powerOutput: 0,
    staff: 14,
    cost: {
      credits: 180,
      alloys: 4,
      elerium: 0,
      alienData: 1,
    },
    constructionHours: 20,
    description: "Dedicated ops room with world-map tracking and encrypted comms.",
    effect: "Coordinates the campaign, funding reports, and tactical deployments.",
  },
  {
    id: "power-1",
    label: "Power Plant",
    kind: "power",
    x: 4,
    y: 1,
    w: 1,
    h: 1,
    powerUse: 0,
    powerOutput: 30,
    staff: 7,
    cost: {
      credits: 160,
      alloys: 4,
      elerium: 0,
      alienData: 0,
    },
    constructionHours: 18,
    description: "Shielded generator room with redundant cooling.",
    effect: "Adds 30 power capacity for future construction.",
  },
  {
    id: "radar-2",
    label: "Tracking Uplink",
    kind: "radar",
    x: 4,
    y: 2,
    w: 1,
    h: 1,
    powerUse: 7,
    powerOutput: 0,
    staff: 6,
    cost: {
      credits: 220,
      alloys: 6,
      elerium: 0,
      alienData: 2,
    },
    constructionHours: 24,
    description: "Paired radar mast and signal correlator for cleaner UFO tracks.",
    effect: "Missions contain one fewer contact, recover +1 data, and failures raise less threat.",
  },
  {
    id: "lab-2",
    label: "Research Annex",
    kind: "lab",
    x: 4,
    y: 0,
    w: 2,
    h: 1,
    powerUse: 5,
    powerOutput: 0,
    staff: 10,
    cost: {
      credits: 200,
      alloys: 6,
      elerium: 0,
      alienData: 4,
    },
    constructionHours: 30,
    description: "Additional clean room, containment bench, and analysis terminals.",
    effect: "Research projects cost 40 fewer credits and one fewer alien data.",
  },
  {
    id: "medbay-2",
    label: "Med Bay",
    kind: "medbay",
    x: 2,
    y: 4,
    w: 1,
    h: 1,
    powerUse: 4,
    powerOutput: 0,
    staff: 6,
    cost: {
      credits: 170,
      alloys: 5,
      elerium: 0,
      alienData: 2,
    },
    constructionHours: 24,
    description: "Trauma pods, sterile surgery suite, and accelerated rehab station.",
    effect: "Cuts wound recovery time by 25% for surviving operatives.",
  },
  {
    id: "workshop-2",
    label: "Fabrication Bay",
    kind: "workshop",
    x: 0,
    y: 2,
    w: 1,
    h: 1,
    powerUse: 5,
    powerOutput: 0,
    staff: 8,
    cost: {
      credits: 180,
      alloys: 8,
      elerium: 1,
      alienData: 1,
    },
    constructionHours: 30,
    description: "Alien alloy tooling and automated ammunition presses.",
    effect: "Recovered sites yield +40 credits and +4 alloys from improved salvage.",
  },
  {
    id: "power-2",
    label: "Auxiliary Power",
    kind: "power",
    x: 3,
    y: 5,
    w: 1,
    h: 1,
    powerUse: 0,
    powerOutput: 24,
    staff: 4,
    cost: {
      credits: 160,
      alloys: 4,
      elerium: 0,
      alienData: 0,
    },
    constructionHours: 18,
    description: "Compact generator room reserved for late-base expansion.",
    effect: "Adds 24 power capacity for future construction.",
  },
  {
    id: CONTAINMENT_FACILITY_ID,
    label: "Alien Containment",
    kind: "containment",
    x: 5,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 6,
    powerOutput: 0,
    staff: 8,
    cost: {
      credits: 220,
      alloys: 8,
      elerium: 2,
      alienData: 2,
    },
    constructionHours: 30,
    description: "Sealed cryo-holding cells and neutralization field for live specimens.",
    effect: "Lets the base hold live alien captives for interrogation; without it captures are lost at debrief.",
  },
];

export const STARTER_BASE_FACILITIES: readonly BaseFacility[] = facilitiesForIds(
  STARTER_BASE_FACILITY_IDS,
);

export function facilityCost(facility: BaseFacility): CampaignResources {
  return facility.cost ? { ...facility.cost } : { ...NO_COST };
}

export function findBaseFacility(id: string): BaseFacility | undefined {
  return BASE_FACILITIES.find((facility) => facility.id === id);
}

export function facilitiesForIds(ids: readonly string[]): BaseFacility[] {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    if (seen.has(id)) return [];
    const facility = findBaseFacility(id);
    if (!facility) return [];
    seen.add(id);
    return [facility];
  });
}

export function starterFacilityIds(): BaseFacilityId[] {
  return [...STARTER_BASE_FACILITY_IDS];
}

export function summarizeBaseFacilities(
  facilities: readonly BaseFacility[] = STARTER_BASE_FACILITIES,
): BaseSummary {
  return facilities.reduce<BaseSummary>(
    (summary, facility) => {
      summary.facilities += 1;
      summary.powerUsed += facility.powerUse;
      summary.powerCapacity += facility.powerOutput;
      summary.staffAssigned += facility.staff;
      // Classic: each hangar berths exactly one craft (not footprint area).
      if (facility.kind === "hangar") summary.hangarSlots += 1;
      return summary;
    },
    {
      facilities: 0,
      powerUsed: 0,
      powerCapacity: 0,
      staffAssigned: 0,
      hangarSlots: 0,
    },
  );
}
