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
  | "mindShield"
  | "alienPropulsion"
  | "alienInterrogation"
  | "leaderInterrogation"
  | "commanderInterrogation";

/**
 * Rank of a captured alien. Mirrors the sim's EnemyRank union (kept decoupled so
 * the campaign layer does not import the sim); the game layer bridges a captured
 * unit's rank to this value. Gates interrogation research: leaderInterrogation
 * needs a "leader"+ captive, commanderInterrogation a "commander".
 */
export type CaptiveRank = "soldier" | "navigator" | "leader" | "commander";
export type CampaignStatus = "active" | "won" | "lost";
export type SoldierStatus = "active" | "wounded" | "kia";
export type SoldierRank = "rookie" | "squaddie" | "sergeant" | "captain";
export type CampaignWeaponId = "rifle" | "pistol" | "plasma" | "cannon";
export type ManufacturingProjectId =
  | "rifle"
  | "pistol"
  | "plasma"
  | "cannon"
  | "sniper"
  | "grenade"
  | "medkit"
  | "armor"
  | "phantom";
export type DifficultyLevel = "rookie" | "veteran" | "commander";
export type MissionType = "crashSite" | "terror" | "landedUfo" | "baseDefense" | "alienBaseAssault";
/** Classification of a detected UFO, driving its strength / speed / lifetime profile. */
export type UfoType = "scout" | "harvester" | "terror" | "battleship";
/**
 * Per-hull agility (dodge scalar): scout jinks easily, a battleship is a barn. A shot's
 * evasion chance scales UP with range and this agility (see airWeapons.evasionChance).
 * Lives here beside UfoType — the single source of truth — so both the geoscape combat
 * model (re-exports it) and the save-load normalizer derive the SAME value from a
 * contact's ufoType, with no circular import between geoscape.ts and storage.ts.
 */
export const UFO_AGILITY: Readonly<Record<UfoType, number>> = {
  scout: 0.9,
  harvester: 0.55,
  terror: 0.4,
  battleship: 0.15,
};
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
  /** Stock of consumable items (grenades, medkits) available to assign to soldiers. */
  items?: Record<string, number>;
}

/** Gear a completed research project unlocks for purchase at the council market. */
export interface ResearchUnlocks {
  /** Weapon ids made available for market purchase (e.g. "plasma", "cannon"). */
  weapons?: string[];
  /** Consumable item ids granted as armory stock when the project completes. */
  items?: string[];
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

/** Letter grade for a monthly council performance rating. */
export type CouncilGrade = "A" | "B" | "C" | "D" | "F";

/** Per-region line in an end-of-month council debrief. */
export interface CouncilRegionRating {
  region: CouncilRegion;
  /** Region panic 0..100 at report time. */
  panic: number;
  /** Region alien infiltration 0..100 at report time. */
  infiltration: number;
  /** This region's council funding change this month (credits; negative = cut). */
  fundingDelta: number;
  /** Whether this region has signed a pact with the aliens (infiltration maxed). */
  defected: boolean;
}

/**
 * End-of-month council debrief. Fired once per 30-day boundary by advanceGeoscape
 * (see FUNDING_REPORT_INTERVAL_HOURS). Surfaced as a blocking review modal by the
 * geoscape UI. Persisted in CampaignState.councilReports (normalized by
 * loadCampaign); the UI decides whether to re-show the modal on reload.
 */
export interface CouncilReport {
  /** 1-based month index (first end-of-month report is month 1). */
  month: number;
  /** Campaign clock elapsedHours at which the report fired. */
  completedAtHour: number;
  regions: CouncilRegionRating[];
  /** Sum of all region funding deltas this month (credits). */
  totalFundingDelta: number;
  /** Council income transferred this month (credits, pre-upkeep). */
  income: number;
  /** Monthly base/facility/soldier upkeep (credits). */
  upkeep: number;
  /** income - upkeep (credits). */
  net: number;
  /** Numeric monthly performance rating (higher is better; drives the grade). */
  rating: number;
  grade: CouncilGrade;
  /** One-line narrative debrief for the modal. */
  narrative: string;
}

export interface InterceptorState {
  damage: number;
  sorties: number;
  repairedAtHour?: number;
}

/** A craft in the hangar: interceptors shoot down UFOs; the transport carries soldiers to ground missions. */
export interface Craft {
  id: string;
  kind: "interceptor" | "transport";
  name: string;
  damage: number;
  sorties: number;
  repairedAtHour?: number;
  /** Current fuel (0..maxFuel). Consumed during flight; refills at base. */
  fuel?: number;
  /** Fuel capacity. */
  maxFuel?: number;
  /**
   * Cruise / pursuit speed in great-circle degrees per hour. Drives the patrol
   * flight's globe speed and the stern-chase comparison against a UFO's own
   * speed. Optional so legacy saves migrate; defaults to a starting-interceptor
   * cruise (DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR) when absent.
   */
  speedDegPerHour?: number;
  /** Hull points fielded in an air-combat encounter (default 100). Advanced craft are tougher. */
  hullPoints?: number;
  /** Multiplier on this craft's outgoing damage in an air-combat encounter (default 1). */
  weaponPower?: number;
  /**
   * Ordered air-combat weapon ids (AIR_WEAPONS keys). Absent => the kind default from
   * craftLoadout() (interceptor -> ["stingray","cannon"]; transport -> []).
   */
  loadout?: string[];
}

/** A friendly craft in transit on the globe (patrol toward UFO, return to base). */
export interface ActiveFlight {
  id: string;
  craftId: string;
  kind: "interceptor" | "transport";
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  progress: number;
  speedDegPerHour: number;
  startedAtHour: number;
  /**
   * What this flight is for. Absent (or "patrol") means a legacy interceptor
   * patrol/return leg; "deployment" is a non-blocking Skyranger run carrying the
   * squad to a mission site — the globe stays live while it flies.
   */
  purpose?: "patrol" | "deployment";
  /** For a deployment flight: the ufoContact id this run is assaulting. */
  deployContactId?: string;
  /** For a deployment flight: true once it reached the site and is awaiting the player's DEPLOY click. */
  arrived?: boolean;
}

export interface UfoContact {
  id: string;
  status: "tracked" | "landed" | "engaging" | "crashed" | "escaped";
  /** Mission type this contact seeds when assaulted (defaults to crashSite). */
  missionType?: MissionType;
  /** Rolled UFO classification driving strength/speed/lifetime; defaults to "harvester". */
  ufoType?: UfoType;
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
  /** 0..1 crash-site condition set at shoot-down; drives crash-site loot + core recovery. Absent => 1 (clean). */
  salvageQuality?: number;
}

export type InterceptionResult = "crashed" | "escaped";

/** Terminal air-combat outcome kinds (richer than the legacy crashed|escaped result). */
export type InterceptionOutcomeKind = "crashed" | "vaporized" | "escaped" | "brokeOff";

export interface InterceptionOutcome {
  kind: InterceptionOutcomeKind;
  /** Meaningful only when kind === "crashed" (0..1); else 0. */
  salvageQuality: number;
}

export interface InterceptionReport {
  contactId: string;
  result: InterceptionResult;
  region: string;
  strength: number;
  interceptorDamage: number;
  completedAtHour: number;
  summary: string;
  /** Richer terminal classification (crashed/vaporized/escaped/brokeOff). */
  outcome?: InterceptionOutcomeKind;
  /** Crash-site salvage condition (0..1), surfaced verbatim in the debrief copy. */
  salvageQuality?: number;
}

/** Buyable equipment market: per-item stock and hours until restock. */
export interface EquipmentMarket {
  stock: Record<string, number>;
  restockTimerHours: Record<string, number>;
}

/**
 * In-progress interactive interception encounter (choice-based, deterministic).
 * Two acts: a pursuit on the globe (real km gap) that ZOOMs at <=100km into a
 * cinematic dogfight (missiles/cannon). The abstract 0..3 range band is gone.
 */
export interface InterceptionEncounter {
  contactId: string;
  /** The two acts of an interception. */
  phase: "pursuit" | "engagement";
  /** Real great-circle km gap (source of truth). */
  rangeKm: number;
  /** craftSpeedKmH - ufoSpeedKmH; <=0 means a stern chase the pursuer loses. */
  closingSpeedKmH: number;
  ufoHp: number;
  ufoHpMax: number;
  interceptorHp: number;
  interceptorHpMax: number;
  /** Remaining shots per weapon id (seeded via ammoFor). */
  ammo: Record<string, number>;
  /** Heavy weapon currently acquiring lock (engagement). */
  lockingWeaponId?: string;
  /** Beats remaining on the active lock (0 = ready). */
  lockBeatsLeft: number;
  /** Set on the killing blow: max(0,(blowDmg-hpBeforeBlow)/hpMax). */
  overkillMargin: number;
  roundsElapsed: number;
  /** Denormalized hull agility (UFO_AGILITY) for view/evasion. */
  ufoAgility: number;
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
  /** Consumable items this soldier is carrying into battle (grenades, medkits). */
  loadoutItems?: string[];
  /** Accumulated per-stat growth granted for surviving missions. Starts at zero. */
  statGrowth?: SoldierStatGrowth;
  /** Short procedurally-generated background, rolled deterministically on recruit. */
  bio?: string;
}

/** Per-stat growth a soldier has accumulated over a career of survived missions. */
export interface SoldierStatGrowth {
  timeUnits: number;
  health: number;
  reactions: number;
  firingAccuracy: number;
}

export interface SoldierStatBonus {
  timeUnits: number;
  health: number;
  reactions: number;
  firingAccuracy: number;
}

export type OperationTheme = "farmland" | "urban" | "desert" | "arctic" | "jungle" | "forest" | "alienBase";

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

/**
 * A live alien captive held at a base. Produced at debrief when an unconscious
 * enemy is recovered AND a base has a built Alien Containment facility (otherwise
 * the captive is lost). Consumed by interrogation research projects.
 */
export interface CampaignCaptive {
  /** Stable per-captive id (e.g. `captive-<n>`). */
  id: string;
  /** Sim unit-template id of the captured species (e.g. "sentinel", "commander"). */
  templateId: string;
  rank: CaptiveRank;
  /** Campaign clock `elapsedHours` at which the captive was taken. */
  capturedAtHour: number;
}

/**
 * The debrief-facing outcome of a mission's captive intake, computed at intake
 * time (before any interrogation research consumes a freshly-secured captive).
 * Reading THIS instead of diffing the captive roster keeps the debrief tally
 * accurate and lets the UI distinguish "no containment facility" from
 * "containment full".
 */
export interface CaptiveIntakeReport {
  /** Aliens newly secured into containment this mission (rank + species template). */
  secured: { rank: CaptiveRank; templateId: string }[];
  /** Captures lost this mission — either no facility, or capacity overflow. */
  lost: number;
  /** Whether a built Alien Containment facility existed when the intake resolved. */
  hadContainment: boolean;
  /** Total captives held after intake, and the containment capacity (for "N/8"). */
  held: number;
  capacity: number;
}

/**
 * The alien headquarters, seeded on land at campaign start. Hidden until an
 * interrogation (or the 5-operations fallback milestone) reveals it, after which
 * a transport can launch the alienBaseAssault final mission at its location.
 */
export interface AlienHq {
  /** Reuses the shared geo coordinate type used for bases/UFOs. */
  location: BaseLocation;
  /** Whether the HQ location has been revealed to the player. */
  revealed: boolean;
}

export interface CampaignState {
  version: 1;
  id: string;
  seed: number;
  createdAt: string;
  base: BaseLocation;
  strategic: StrategicState;
  regionalPanic: Record<CouncilRegion, number>;
  /**
   * Per-council-region alien infiltration meter (0..100). Each UFO contact that
   * expires un-intercepted raises its region's infiltration (scaled by mission
   * type). When a region reaches 100 that nation signs a pact with the aliens:
   * its council funding is permanently withdrawn and it counts as defected.
   * Defaults to 0 everywhere on a fresh campaign; loadCampaign normalizes it.
   */
  infiltration?: Partial<Record<CouncilRegion, number>>;
  clock: CampaignClock;
  lastFundingReport?: FundingReport;
  /**
   * End-of-month council debriefs, newest first (bounded history). Appended by
   * advanceGeoscape at each month boundary. loadCampaign MUST normalize this or it
   * silently drops on reload.
   */
  councilReports?: CouncilReport[];
  /**
   * Highest month index for which a council report has already fired. Guards
   * against re-firing when a fast-forward crosses several month boundaries in one
   * tick, and against re-firing on reload. Defaults to 0. loadCampaign MUST
   * normalize this.
   */
  lastCouncilMonth?: number;
  interceptor: InterceptorState;
  /** The hangar fleet: 2 interceptors + 1 transport (Skyranger) at start. */
  fleet?: Craft[];
  /** Active flights (patrols/transfers) on the globe during time-flow. */
  activeFlights?: ActiveFlight[];
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
  /** Extra radar bases built on the globe. The primary base is `base`, NOT in this list. */
  bases?: BaseLocation[];
  /** In-progress extra-base construction (completion fires a project report ~48h later). */
  activeBaseConstruction?: { location: BaseLocation; startedAtHour: number; completesAtHour: number };
  missionsCompleted: number;
  missionsAttempted: number;
  lastMission?: MissionReport;
  projectReports: ProjectReport[];
  /**
   * Live alien captives held across all bases. Only retained if some base has a
   * built Alien Containment facility; interrogation research consumes them.
   */
  captives?: CampaignCaptive[];
  /** The alien HQ (seeded on land at campaign start; revealed via interrogation or the fallback milestone). */
  alienHq?: AlienHq;
  /**
   * Outcome of the most recent mission's captive intake, set by recordMissionResult
   * for the debrief to read. Transient/session-scoped: recomputed each mission and
   * not reconstructed on load (the debrief only shows immediately after a mission).
   */
  lastCaptiveIntake?: CaptiveIntakeReport;
}
