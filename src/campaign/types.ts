export interface BaseLocation {
  lat: number;
  lon: number;
  region: string;
}

export type MissionResult = "success" | "failure";
export type ResearchId = "plasmaWeapons" | "alloyArmor";
export type CampaignStatus = "active" | "won" | "lost";
export type SoldierStatus = "active" | "wounded" | "kia";
export type SoldierRank = "rookie" | "squaddie" | "sergeant" | "captain";
export type CampaignWeaponId = "rifle" | "pistol" | "plasma";
export type ManufacturingProjectId = "rifle" | "pistol" | "plasma";
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
  status: "tracked" | "crashed";
  lat: number;
  lon: number;
  region: string;
  detectedAtHour: number;
  interceptedAtHour?: number;
  expiresAtHour: number;
  missionSeed: number;
  strength: number;
  interceptorDamage?: number;
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

export interface OperationPlan {
  missionNumber: number;
  missionSeed: number;
  codename: string;
  region: string;
  themeId: OperationTheme;
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
  enemyCount: number;
  durationHours: number;
  reward: CampaignResources;
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
