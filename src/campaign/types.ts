export interface BaseLocation {
  lat: number;
  lon: number;
  region: string;
}

export type MissionResult = "success" | "failure";
export type ResearchId =
  | "plasmaWeapons"
  | "alloyArmor"
  | "alienBiotech"
  | "heavyPlasma"
  | "advancedMetallurgy"
  | "improvedMedikit"
  | "poweredArmor"
  | "eleriumPowerSource"
  | "mindShield";
export type CampaignStatus = "active" | "won" | "lost";
export type SoldierStatus = "active" | "wounded" | "kia";
export type SoldierRank = "rookie" | "squaddie" | "sergeant" | "captain";
export type CampaignWeaponId = "rifle" | "pistol" | "plasma";
export type ManufacturingProjectId = "rifle" | "pistol" | "plasma";
export type DifficultyLevel = "rookie" | "veteran" | "commander";
export type MissionType = "crashSite" | "terror" | "landedUfo" | "baseDefense";
export type CouncilRegion =
  | "North America"
  | "South America"
  | "Europe"
  | "Africa"
  | "Middle East"
  | "South Asia"
  | "East Asia"
  | "Oceania";

export interface CampaignResources {
  credits: number;
  alloys: number;
  elerium: number;
  alienData: number;
}

export interface CampaignArmory {
  weapons: Record<CampaignWeaponId, number>;
}

export interface StrategicState {
  status: CampaignStatus;
  threat: number;
  funding: number;
  score: number;
  /** Chosen at campaign creation; scales enemy counts, UFO strength, funding pressure. */
  difficulty?: DifficultyLevel;
}

export interface CampaignClock {
  day: number;
  hour: number;
  elapsedHours: number;
  lastContactHour: number;
  lastFundingHour: number;
}

export interface FundingReport {
  reportNumber: number;
  completedAtHour: number;
  income: number;
  upkeep: number;
  net: number;
  funding: number;
  threat: number;
  score: number;
  summary: string;
}

export interface InterceptorState {
  damage: number;
  sorties: number;
  repairedAtHour?: number;
}

export interface UfoContact {
  id: string;
  status: "tracked" | "landed" | "engaging" | "crashed" | "escaped";
  /** Mission type this contact seeds when assaulted (defaults to crashSite). */
  missionType?: MissionType;
  lat: number;
  lon: number;
  region: string;
  detectedAtHour: number;
  interceptedAtHour?: number;
  expiresAtHour: number;
  missionSeed: number;
  strength: number;
  interceptorDamage?: number;
  /** Tracked UFOs fly: heading (deg) + speed (deg/hour) advance lat/lon as time flows. */
  heading?: number;
  speed?: number;
  /** A UFO shot down over the ocean is lost (no assault mission). */
  overOcean?: boolean;
}

export type InterceptionResult = "crashed" | "escaped";

export interface InterceptionReport {
  contactId: string;
  result: InterceptionResult;
  region: string;
  strength: number;
  interceptorDamage: number;
  completedAtHour: number;
  summary: string;
}

/** Buyable equipment market: per-item stock and hours until restock. */
export interface EquipmentMarket {
  stock: Record<string, number>;
  restockTimerHours: Record<string, number>;
}

/** In-progress interactive interception encounter (choice-based, deterministic). */
export interface InterceptionEncounter {
  contactId: string;
  ufoHp: number;
  ufoHpMax: number;
  interceptorHp: number;
  interceptorHpMax: number;
  /** Engagement range in arbitrary units (0 = point-blank; affects hit odds). */
  range: number;
  roundsElapsed: number;
  log: string[];
}

export interface ActiveResearch {
  projectId: ResearchId;
  startedAtHour: number;
  completesAtHour: number;
}

export interface ActiveManufacturing {
  projectId: ManufacturingProjectId;
  startedAtHour: number;
  completesAtHour: number;
}

export interface ActiveConstruction {
  facilityId: string;
  startedAtHour: number;
  completesAtHour: number;
}

export interface CampaignSoldier {
  id: string;
  name: string;
  status: SoldierStatus;
  rank: SoldierRank;
  missions: number;
  survivedMissions: number;
  woundedUntilHour?: number;
}

export interface SoldierStatBonus {
  timeUnits: number;
  health: number;
  reactions: number;
  firingAccuracy: number;
}

export type OperationTheme = "farmland" | "urban" | "desert";

/** Per-mission-type context (civilians for terror, facility for base defense). */
export interface MissionContext {
  civilianCount?: number;
  defenderFacility?: string;
}

export interface OperationPlan {
  missionNumber: number;
  missionSeed: number;
  codename: string;
  region: string;
  themeId: OperationTheme;
  missionType?: MissionType;
  missionContext?: MissionContext;
  enemyCount: number;
  durationHours: number;
  width: number;
  height: number;
  reward: CampaignResources;
  briefing: string;
  objective: string;
}

export interface MissionReport {
  missionNumber: number;
  missionSeed: number;
  codename: string;
  result: MissionResult;
  region: string;
  themeId: OperationTheme;
  missionType?: MissionType;
  enemyCount: number;
  durationHours: number;
  reward: CampaignResources;
  /** Terror missions: civilians on the map. */
  civilianCount?: number;
  civiliansRescued?: number;
  civilianCasualties?: number;
  deployedSoldierIds: string[];
  kiaSoldierIds: string[];
  woundedSoldierIds: string[];
  completedAt: string;
  summary: string;
}

export type ProjectReportKind = "research" | "manufacturing" | "construction";

export interface ProjectReport {
  kind: ProjectReportKind;
  id: string;
  title: string;
  summary: string;
  completedAtHour: number;
}

export interface CampaignState {
  version: 1;
  id: string;
  seed: number;
  createdAt: string;
  base: BaseLocation;
  strategic: StrategicState;
  regionalPanic: Record<CouncilRegion, number>;
  clock: CampaignClock;
  lastFundingReport?: FundingReport;
  interceptor: InterceptorState;
  lastInterceptionReport?: InterceptionReport;
  ufoContact?: UfoContact;
  resources: CampaignResources;
  armory: CampaignArmory;
  market?: EquipmentMarket;
  /** Active interactive interception encounter, if one is in progress. */
  interception?: InterceptionEncounter;
  soldierLoadouts: Record<string, CampaignWeaponId>;
  deploymentSoldierIds: string[];
  facilities: string[];
  soldiers: CampaignSoldier[];
  completedResearch: ResearchId[];
  activeResearch?: ActiveResearch;
  activeManufacturing?: ActiveManufacturing;
  activeConstruction?: ActiveConstruction;
  missionsCompleted: number;
  missionsAttempted: number;
  lastMission?: MissionReport;
  projectReports: ProjectReport[];
}
