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
  | "radar";

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

export const STARTER_BASE_GRID = {
  width: 8,
  height: 5,
} as const;

const NO_COST: CampaignResources = {
  credits: 0,
  alloys: 0,
  elerium: 0,
  alienData: 0,
};

export const STARTER_BASE_FACILITY_IDS = [
  "hangar-1",
  "radar-1",
  "lab-1",
  "command-1",
  "workshop-1",
  "access-1",
  "living-1",
  "stores-1",
  "power-1",
] as const;

export type BaseFacilityId = string;

export const BASE_FACILITIES: readonly BaseFacility[] = [
  {
    id: "hangar-1",
    label: "Interceptor Hangar",
    kind: "hangar",
    x: 0,
    y: 0,
    w: 2,
    h: 2,
    powerUse: 3,
    powerOutput: 0,
    staff: 10,
    description: "Aircraft berth, recovery crane, and munitions turntable.",
    effect: "Launches strike teams and keeps one interceptor-ready dropship online.",
  },
  {
    id: "radar-1",
    label: "Long Range Radar",
    kind: "radar",
    x: 3,
    y: 0,
    w: 1,
    h: 1,
    powerUse: 8,
    powerOutput: 0,
    staff: 6,
    description: "Surface array for early UFO tracking.",
    effect: "Maintains regional UFO detection for the command center.",
  },
  {
    id: "lab-1",
    label: "Laboratory",
    kind: "lab",
    x: 5,
    y: 0,
    w: 2,
    h: 1,
    powerUse: 5,
    powerOutput: 0,
    staff: 12,
    description: "Recovered material analysis and autopsy prep.",
    effect: "Allows scientists to turn recovered data into field upgrades.",
  },
  {
    id: "command-1",
    label: "Command Center",
    kind: "command",
    x: 2,
    y: 1,
    w: 2,
    h: 2,
    powerUse: 6,
    powerOutput: 0,
    staff: 14,
    description: "Base operations, world-map tracking, and encrypted comms.",
    effect: "Coordinates the campaign, funding reports, and tactical deployments.",
  },
  {
    id: "workshop-1",
    label: "Workshop",
    kind: "workshop",
    x: 5,
    y: 1,
    w: 2,
    h: 1,
    powerUse: 4,
    powerOutput: 0,
    staff: 10,
    description: "Prototype fabrication and field-kit repair benches.",
    effect: "Keeps conventional weapons and armor serviceable between missions.",
  },
  {
    id: "access-1",
    label: "Access Lift",
    kind: "access",
    x: 3,
    y: 3,
    w: 1,
    h: 1,
    powerUse: 2,
    powerOutput: 0,
    staff: 4,
    description: "Armored shaft to the surface camouflaged as industrial plant.",
    effect: "Connects the underground installation to the hidden surface entrance.",
  },
  {
    id: "living-1",
    label: "Living Quarters",
    kind: "living",
    x: 0,
    y: 3,
    w: 2,
    h: 1,
    powerUse: 3,
    powerOutput: 0,
    staff: 18,
    description: "Bunks, mess, med alcove, and decompression lock.",
    effect: "Supports recruitment and keeps off-duty operatives housed.",
  },
  {
    id: "stores-1",
    label: "Stores",
    kind: "stores",
    x: 5,
    y: 2,
    w: 2,
    h: 1,
    powerUse: 1,
    powerOutput: 0,
    staff: 5,
    description: "Secure storage for weapons, alloys, and recovered components.",
    effect: "Stores recovered alloys, elerium, and field equipment.",
  },
  {
    id: "power-1",
    label: "Power Plant",
    kind: "power",
    x: 5,
    y: 3,
    w: 2,
    h: 1,
    powerUse: 0,
    powerOutput: 55,
    staff: 7,
    description: "Shielded generator room with redundant cooling.",
    effect: "Provides the power budget for the initial base.",
  },
  {
    id: "radar-2",
    label: "Tracking Uplink",
    kind: "radar",
    x: 7,
    y: 0,
    w: 1,
    h: 2,
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
    x: 0,
    y: 4,
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
    x: 3,
    y: 4,
    w: 2,
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
    x: 6,
    y: 4,
    w: 2,
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
      if (facility.kind === "hangar") summary.hangarSlots += facility.w * facility.h;
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
