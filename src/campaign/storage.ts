import type {
  ActiveConstruction,
  ActiveFlight,
  ActiveManufacturing,
  ActiveResearch,
  CampaignArmory,
  BaseLocation,
  CampaignClock,
  CampaignStatus,
  FundingReport,
  InterceptionReport,
  InterceptionEncounter,
  InterceptorState,
  CampaignSoldier,
  CampaignResources,
  CampaignState,
  CampaignWeaponId,
  CampaignCaptive,
  CaptiveIntakeReport,
  CaptiveRank,
  AlienHq,
  CouncilGrade,
  CouncilRegion,
  CouncilRegionRating,
  CouncilReport,
  Craft,
  DifficultyLevel,
  EquipmentMarket,
  ManufacturingProjectId,
  ResearchUnlocks,
  SoldierRank,
  SoldierStatBonus,
  SoldierStatGrowth,
  StrategicState,
  MissionReport,
  MissionResult,
  MissionType,
  OperationPlan,
  OperationTheme,
  ProjectReport,
  ResearchId,
  UfoContact,
  UfoType,
} from "./types";
// UFO_AGILITY is a runtime value (per-hull dodge scalar) — imported here so the
// interception normalizer re-derives it from the contact's ufoType (the source of
// truth), never trusting a persisted/tampered value. Lives in types.ts (the leaf) to
// avoid a circular import with geoscape.ts.
import { UFO_AGILITY } from "./types";
import { airWeapon } from "./airWeapons";
import {
  BASE_FACILITIES,
  CONTAINMENT_FACILITY_ID,
  CONTAINMENT_CAPACITY,
  facilitiesForIds,
  facilityCost,
  findBaseFacility,
  starterFacilityIds,
  summarizeBaseFacilities,
  type BaseFacility,
} from "./base";
import { isLand } from "./landMask";
import { canAddToBackpack } from "./backpack";

export const CAMPAIGN_STORAGE_KEY = "blacksite.campaign.v1";
export const CAMPAIGN_VICTORY_OPERATIONS = 8;

/**
 * Scales down FAILURE-side threat/funding/panic penalties (mission failures here,
 * escaped/ignored UFO contacts in campaign/geoscape.ts) so the total risk budget
 * across a full 8-op campaign lands back in the balance-harness's target win-rate
 * band despite needing roughly double the mission attempts of the old 4-op arc.
 * Success rewards are intentionally left unscaled. Commander's much higher
 * threatGainMult/panicMult (see DIFFICULTY_CONFIGS) means a flat relief factor
 * under-corrects it relative to rookie/veteran, so relief is difficulty-scaled.
 */
export const ARC_FAILURE_RELIEF: Record<DifficultyLevel, number> = {
  rookie: 0.3,
  veteran: 0.3,
  commander: 0.28,
};

export function arcFailureRelief(campaign: CampaignState): number {
  return ARC_FAILURE_RELIEF[campaign.strategic.difficulty ?? "veteran"];
}

/**
 * Real-world speed conversion. The globe is a unit sphere modelled in great-circle
 * DEGREES; the internal air-war math (patrol progress, tracked-UFO drift, pursuit
 * classification) all runs in deg/hour. But the player thinks in km/h, so craft/UFO
 * speeds are AUTHORED as km/h (the source of truth in every design comment) and
 * converted to deg/h with this factor. One degree of great-circle arc ≈ 111.19 km.
 */
export const KM_PER_DEGREE = 111.19;
/** km/h → internal deg/hour. e.g. kmhToDegPerHour(4023) ≈ 36.18 (a 2,500 mph Raptor). */
export function kmhToDegPerHour(kmh: number): number {
  return kmh / KM_PER_DEGREE;
}
/** internal deg/hour → km/h, for the DOM speed chips (formatSpeed renders km/h). */
export function degPerHourToKmh(degPerHour: number): number {
  return degPerHour * KM_PER_DEGREE;
}

/**
 * Endgame arc constants. The true campaign victory is winning the alien-base
 * assault at the revealed HQ. CAMPAIGN_VICTORY_OPERATIONS remains a FALLBACK
 * milestone that auto-reveals the HQ (so a capture-free campaign stays winnable,
 * preserving the tuned difficulty curve). Losing the assault does NOT end the run.
 * Set to 4 so the fallback path's total wins-to-victory (4 ops + the assault)
 * matches the 5-operation campaign length the difficulty curve was tuned on.
 */
export const ALIEN_HQ_CREW_SIZE = 12;
/** Operation theme used for the alien-base assault map. */
export const ALIEN_BASE_THEME: OperationTheme = "alienBase";

/** Ordered rank hierarchy for captive-requirement comparisons (low → high). */
export const CAPTIVE_RANK_ORDER: readonly CaptiveRank[] = [
  "soldier",
  "navigator",
  "leader",
  "commander",
];

/** Per-UFO-type crew rank composition. Bigger UFOs field leaders; terror/battleship can field a commander. */
export interface UfoCrewProfile {
  /** Crew includes a leader-rank (navigator/leader) alien. */
  hasLeader: boolean;
  /** Deterministic 0..1 chance the crew includes a commander. */
  commanderChance: number;
}

export const UFO_CREW_PROFILES: Record<UfoType, UfoCrewProfile> = {
  scout: { hasLeader: false, commanderChance: 0 },
  harvester: { hasLeader: true, commanderChance: 0 },
  terror: { hasLeader: true, commanderChance: 0.35 },
  battleship: { hasLeader: true, commanderChance: 0.6 },
};
// Doom-clock ceilings. Raised from 100 so a competent player has time to recover
// CAMPAIGN_VICTORY_OPERATIONS cores before the clock collapses. The per-difficulty
// SLOPE (threatGainMult / panicMult) discriminates rookie vs commander; the
// threshold itself is shared so the slope is what does the tuning.
export const THREAT_LOSS_THRESHOLD = 150;
export const PANIC_LOSS_THRESHOLD = 150;
export const DEPLOYMENT_SIZE = 4;
export const RECRUIT_COST = 60;
export const MEDBAY_FACILITY_ID = "medbay-2";
export const MEDBAY_WOUND_RECOVERY_MULTIPLIER = 0.75;
export const WOUND_RECOVERY_MIN_HOURS = 12;
export const WOUND_RECOVERY_MAX_HOURS = 72;
export const PROJECT_REPORT_LIMIT = 6;
export const NEW_BASE_COST: CampaignResources = { credits: 2000, alloys: 0, elerium: 0, alienData: 0 };
export const MAX_EXTRA_BASES = 3;
export const NEW_BASE_CONSTRUCTION_HOURS = 48;
export const CAMPAIGN_WEAPON_IDS = ["rifle", "pistol", "plasma", "cannon"] as const satisfies readonly CampaignWeaponId[];
export const STARTING_INTERCEPTOR: InterceptorState = {
  damage: 0,
  sorties: 0,
};

/**
 * The hangar fleet the player starts with: two interceptors (Raptor-1 / Raptor-2)
 * for air-to-air UFO interception, plus one Skyranger transport for ground missions.
 * Mirrors the original game's starting complement.
 */
export const STARTING_FLEET: readonly Craft[] = [
  { id: "int-1", kind: "interceptor", name: "Raptor-1", damage: 0, sorties: 0, fuel: 100, maxFuel: 100, speedDegPerHour: 36.2, loadout: ["stingray", "cannon"] },
  { id: "int-2", kind: "interceptor", name: "Raptor-2", damage: 0, sorties: 0, fuel: 100, maxFuel: 100, speedDegPerHour: 36.2, loadout: ["stingray", "cannon"] },
  { id: "sky-1", kind: "transport", name: "Skyranger", damage: 0, sorties: 0, fuel: 100, maxFuel: 100, speedDegPerHour: 24.6 },
];

/** Craft id synthesized for the legacy single-interceptor field when no fleet exists. */
export const LEGACY_CRAFT_ID = "int-legacy";

/**
 * Active-flight id conventions. A patrol id is `patrol:<craftId>:<contactId>` and a
 * return-to-base leg is `return:<craftId>:<hour>`. They live here (beside the fleet
 * logic) so the engaging-craft picker can tell a craft flying THIS contact's patrol
 * apart from one merely returning home or patrolling a different contact.
 */
export const PATROL_ID_PREFIX = "patrol:";
export const RETURN_ID_PREFIX = "return:";

/** True when `flight` is the patrol pursuing the given contact (not a return leg / other patrol). */
function isPatrolFlightForContact(flight: ActiveFlight, contactId: string | undefined): boolean {
  return (
    contactId !== undefined &&
    flight.id.startsWith(PATROL_ID_PREFIX) &&
    flight.id.endsWith(`:${contactId}`)
  );
}

/** Damage fraction at or above which an interceptor is too banged up to be "ready". */
const INTERCEPTOR_DAMAGE_MAX = 100;

/**
 * Cruise/pursuit speed a craft with no explicit speedDegPerHour falls back to — the
 * starting Raptor's cruise: 2,500 mph = 4,023 km/h ≈ 36.2 deg/hour. Legacy saves and
 * hand-built fixtures without the field behave as a starting interceptor.
 */
export const DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR = 36.2;
/**
 * Cruise speed a TRANSPORT with no explicit speedDegPerHour falls back to — the
 * starting Skyranger's cruise: 1,700 mph = 2,736 km/h ≈ 24.6 deg/hour. At that speed
 * a 180-degree antipodal crossing takes ~7.3 game-hours (the design target: "anywhere
 * in the world in ~7-8h"). Still kind-aware and slower than a Phantom's 64.3, so a
 * legacy Skyranger's hangar chip reads the transport number, not the interceptor's.
 */
export const DEFAULT_TRANSPORT_SPEED_DEG_PER_HOUR = 24.6;
/**
 * Sanity floor (deg/hour) below which a persisted craft speed is treated as LEGACY.
 * Every real-world craft now cruises far above this (transport 24.6, interceptor 36.2,
 * Phantom 64.3), so any saved craft speed under the floor predates the km/h retune
 * (old magnitudes were 0.7 / 0.9 / 1.6 / 2.5). normalizeCraft drops such a value so the
 * craft re-derives its kind's current default instead of crawling at a pre-retune rate.
 */
export const LEGACY_SPEED_FLOOR_DEG_PER_HOUR = 5;
/** Hull points an encounter craft fields when it has no explicit hullPoints. */
export const DEFAULT_CRAFT_HULL_POINTS = 100;

/**
 * A craft's own cruise/pursuit speed (deg/hour). A missing value falls back to the
 * starting cruise for the craft's KIND (transport 24.6, interceptor 36.2) so legacy
 * craft and synthesized fleet rows report the same speed a fresh craft of that kind
 * would, regardless of save vintage.
 */
export function craftSpeedDegPerHour(craft: Craft): number {
  if (typeof craft.speedDegPerHour === "number" && craft.speedDegPerHour > 0) {
    return craft.speedDegPerHour;
  }
  return craft.kind === "transport"
    ? DEFAULT_TRANSPORT_SPEED_DEG_PER_HOUR
    : DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR;
}

/** A craft's air-combat hull points, defaulting to DEFAULT_CRAFT_HULL_POINTS. */
export function craftHullPoints(craft: Craft): number {
  return typeof craft.hullPoints === "number" && craft.hullPoints > 0
    ? craft.hullPoints
    : DEFAULT_CRAFT_HULL_POINTS;
}

/** A craft's outgoing air-combat damage multiplier, defaulting to 1. */
export function craftWeaponPower(craft: Craft): number {
  return typeof craft.weaponPower === "number" && craft.weaponPower > 0 ? craft.weaponPower : 1;
}

/**
 * The effective fleet for interception purposes. A real `fleet` is used when present;
 * otherwise a single synthesized craft is derived from the legacy `interceptor` field
 * so old saves and manually-staged fixtures without a fleet keep working.
 */
function effectiveFleet(campaign: CampaignState): Craft[] {
  if (Array.isArray(campaign.fleet) && campaign.fleet.length > 0) {
    return campaign.fleet;
  }
  const legacy = campaign.interceptor;
  return [
    {
      id: LEGACY_CRAFT_ID,
      kind: "interceptor",
      name: "Interceptor",
      damage: legacy.damage,
      sorties: legacy.sorties,
      fuel: 100,
      maxFuel: 100,
      ...(legacy.repairedAtHour !== undefined ? { repairedAtHour: legacy.repairedAtHour } : {}),
    },
  ];
}

/** Interceptors that can launch right now (no repair pending or repair already complete). */
export function readyInterceptors(campaign: CampaignState): Craft[] {
  return effectiveFleet(campaign).filter(
    (craft) =>
      craft.kind === "interceptor" &&
      (craft.repairedAtHour === undefined || craft.repairedAtHour <= campaign.clock.elapsedHours),
  );
}

/**
 * The interceptor that engages the current UFO: the FASTEST ready craft that is
 * actually available to this contact. A craft flying a RETURN leg home — or a patrol
 * against a DIFFERENT contact — is committed elsewhere and excluded, so the engaging
 * craft stays in lockstep with the one visibly flying the pursuit on the globe (the
 * patrol layer's chooseIdleInterceptor). A craft idle in the hangar, or already
 * flying THIS contact's patrol, is eligible. A manufactured advanced interceptor
 * (Phantom) is thus scrambled ahead of a slower Raptor once it is in the hangar, but
 * a Phantom that happens to be flying home is NOT mistaken for the engaging craft.
 * Ties keep the earliest craft in fleet order (stable).
 */
export function chooseInterceptor(campaign: CampaignState): Craft | undefined {
  const flights = campaign.activeFlights ?? [];
  const contactId = campaign.ufoContact?.id;
  const committedElsewhere = new Set(
    flights
      .filter((flight) => !isPatrolFlightForContact(flight, contactId))
      .map((flight) => flight.craftId),
  );
  const ready = readyInterceptors(campaign).filter((craft) => !committedElsewhere.has(craft.id));
  if (ready.length === 0) return undefined;
  let best = ready[0]!;
  for (let i = 1; i < ready.length; i++) {
    if (craftSpeedDegPerHour(ready[i]!) > craftSpeedDegPerHour(best)) best = ready[i]!;
  }
  return best;
}

/** The Skyranger transport craft, if the fleet has one. */
export function transportCraft(campaign: CampaignState): Craft | undefined {
  return (campaign.fleet ?? []).find((craft) => craft.kind === "transport");
}

/** Id prefix for a non-blocking deployment run: `deploy:<craftId>:<contactId>`. */
export const DEPLOY_ID_PREFIX = "deploy:";

/**
 * Launch a NON-BLOCKING deployment: appends a `purpose:"deployment"` ActiveFlight
 * for the transport, flying the base -> contact great-circle arc. The globe stays
 * live while it flies (unlike the old blocking deployment overlay); on arrival the
 * geoscape flags it `arrived` and offers a DEPLOY chip. Pure/additive — returns a
 * new CampaignState with the flight appended. No-op (returns campaign unchanged) if
 * the contact is unknown or a deployment for it is already in flight.
 */
export function launchDeploymentFlight(campaign: CampaignState, contactId: string): CampaignState {
  const contact = campaign.ufoContact?.id === contactId ? campaign.ufoContact : undefined;
  if (!contact) return campaign;
  const flights = campaign.activeFlights ?? [];
  const flightId = `${DEPLOY_ID_PREFIX}${contactId}`;
  if (flights.some((flight) => flight.id === flightId)) return campaign;
  const transport = transportCraft(campaign);
  const craftId = transport?.id ?? "sky-1";
  const speedDegPerHour = transport
    ? craftSpeedDegPerHour(transport)
    : DEFAULT_TRANSPORT_SPEED_DEG_PER_HOUR;
  const flight: ActiveFlight = {
    id: flightId,
    craftId,
    kind: "transport",
    fromLat: campaign.base.lat,
    fromLon: campaign.base.lon,
    toLat: contact.lat,
    toLon: contact.lon,
    progress: 0,
    speedDegPerHour,
    startedAtHour: campaign.clock.elapsedHours,
    purpose: "deployment",
    deployContactId: contactId,
    arrived: false,
  };
  return { ...campaign, activeFlights: [...flights, flight] };
}

/**
 * Removes every deployment-purpose flight from an active-flight roster, preserving
 * interceptor patrols. Returns undefined for an empty result to match the fresh /
 * normalized "no flights" shape. Used to retire the squad's Skyranger run once its
 * mission resolves.
 */
export function dropDeploymentFlights(
  flights: readonly ActiveFlight[] | undefined,
): ActiveFlight[] | undefined {
  if (!flights || flights.length === 0) return undefined;
  const kept = flights.filter((flight) => flight.purpose !== "deployment");
  return kept.length > 0 ? kept : undefined;
}

/**
 * Repair-duration for a damaged craft, matching the legacy interceptor formula: longer
 * for heavier damage, shortened by a workshop. Duplicated from geoscape.interceptorRepairHours
 * to keep storage free of a reverse dependency on the geoscape module.
 */
function craftRepairHours(campaign: CampaignState, damage: number): number {
  const workshopBonus = hasBaseFacility(campaign, "workshop-2") ? 10 : 0;
  return Math.max(6, Math.min(72, Math.ceil(damage * 1.15) - workshopBonus));
}

/**
 * Applies interception damage to a single craft: sets total damage, records a sortie,
 * and schedules its repair. The legacy `interceptor` field is mirrored to the damaged
 * craft so UI/migration code that still reads it stays consistent. No-op if the craft
 * is not in the fleet.
 */
export function damageCraft(campaign: CampaignState, craftId: string, damage: number): CampaignState {
  const totalDamage = Math.max(0, Math.min(INTERCEPTOR_DAMAGE_MAX, Math.floor(damage)));
  const repairedAtHour = campaign.clock.elapsedHours + craftRepairHours(campaign, totalDamage);
  if (Array.isArray(campaign.fleet) && campaign.fleet.length > 0) {
    const idx = campaign.fleet.findIndex((craft) => craft.id === craftId);
    if (idx === -1) return campaign;
    const craft = campaign.fleet[idx]!;
    const sorties = craft.sorties + 1;
    // Spread the existing craft so per-craft stats (speed/hull/weaponPower) survive
    // a sortie — rebuilding field-by-field would silently drop them (the field-list gotcha).
    const updated: Craft = {
      ...craft,
      damage: totalDamage,
      sorties,
      repairedAtHour,
    };
    const fleet = [...campaign.fleet.slice(0, idx), updated, ...campaign.fleet.slice(idx + 1)];
    return {
      ...campaign,
      fleet,
      interceptor: { damage: totalDamage, sorties, repairedAtHour },
    };
  }
  // Legacy fallback (no fleet): apply directly to the single interceptor.
  const sorties = campaign.interceptor.sorties + 1;
  return {
    ...campaign,
    interceptor: { damage: totalDamage, sorties, repairedAtHour },
  };
}

/**
 * Completes any fleet repairs whose scheduled time has arrived. Each interceptor craft
 * is repaired on its own `repairedAtHour`; the legacy `interceptor` field is repaired
 * on its own schedule too (the two are kept in sync at damage-write time, but repairing
 * them independently avoids clobbering either when they happen to diverge).
 */
export function repairFleet(campaign: CampaignState, currentHour?: number): CampaignState {
  const deadline =
    typeof currentHour === "number" ? Math.max(0, Math.floor(currentHour)) : campaign.clock.elapsedHours;
  let next = campaign;
  if (Array.isArray(campaign.fleet) && campaign.fleet.length > 0) {
    let changed = false;
    const fleet = campaign.fleet.map((craft) => {
      if (
        craft.kind === "interceptor" &&
        craft.repairedAtHour !== undefined &&
        craft.repairedAtHour <= deadline
      ) {
        changed = true;
        // Spread to preserve per-craft combat stats; clear damage + the repair window.
        const { repairedAtHour: _repaired, ...rest } = craft;
        return { ...rest, damage: 0 } satisfies Craft;
      }
      return craft;
    });
    if (changed) next = { ...next, fleet };
  }
  const legacyRepairedAt = next.interceptor.repairedAtHour;
  if (legacyRepairedAt !== undefined && legacyRepairedAt <= deadline) {
    next = { ...next, interceptor: { damage: 0, sorties: next.interceptor.sorties } };
  }
  return next;
}


export const STARTING_RESOURCES: CampaignResources = {
  credits: 800,
  alloys: 0,
  elerium: 0,
  alienData: 0,
};

export const STARTING_STRATEGIC: StrategicState = {
  status: "active",
  threat: 20,
  funding: 640,
  score: 0,
};

export const COUNCIL_REGIONS = [
  "North America",
  "South America",
  "Europe",
  "Africa",
  "Middle East",
  "South Asia",
  "East Asia",
  "Oceania",
] as const satisfies readonly CouncilRegion[];

export const STARTING_REGIONAL_PANIC: Record<CouncilRegion, number> = {
  "North America": 20,
  "South America": 20,
  Europe: 20,
  Africa: 20,
  "Middle East": 20,
  "South Asia": 20,
  "East Asia": 20,
  Oceania: 20,
};

/** Infiltration starts at zero in every council region; it only rises as UFOs slip through. */
export const STARTING_INFILTRATION: Record<CouncilRegion, number> = {
  "North America": 0,
  "South America": 0,
  Europe: 0,
  Africa: 0,
  "Middle East": 0,
  "South Asia": 0,
  "East Asia": 0,
  Oceania: 0,
};

export const STARTING_CLOCK: CampaignClock = {
  day: 1,
  hour: 0,
  elapsedHours: 0,
  lastContactHour: 0,
  lastFundingHour: 0,
};

export interface DifficultyConfig {
  label: string;
  startingThreat: number;
  startingFunding: number;
  startingCredits: number;
  enemyCountMult: number;
  ufoStrengthBonus: number;
  interceptionDamageMult: number;
  fundingPressureMult: number;
  panicMult: number;
  // Scales threat PENALTIES (ignored contacts, escaped intercepts, failed missions).
  // Success relief is intentionally unscaled so winning missions sets the doom clock
  // back by a fixed amount at every difficulty.
  threatGainMult: number;
  upkeepMult: number;
  // Garrison size the final alien-base assault fields at this difficulty. Unlike a
  // normal mission (whose count is enemyCountMult-scaled), the boss crew is set
  // directly here so the climax stays retryable on rookie yet punishing on commander.
  // The "always 1 commander + 1 leader" invariant holds at every size (min 2).
  alienHqCrewSize: number;
}

export const DIFFICULTY_CONFIGS: Record<DifficultyLevel, DifficultyConfig> = {
  rookie: {
    label: "Rookie",
    startingThreat: 12,
    startingFunding: 760,
    startingCredits: 900,
    enemyCountMult: 0.4,
    ufoStrengthBonus: 0,
    interceptionDamageMult: 0.8,
    fundingPressureMult: 0.45,
    panicMult: 0.4,
    threatGainMult: 0.3,
    upkeepMult: 0.8,
    alienHqCrewSize: 5,
  },
  veteran: {
    label: "Veteran",
    startingThreat: STARTING_STRATEGIC.threat,
    startingFunding: STARTING_STRATEGIC.funding,
    startingCredits: STARTING_RESOURCES.credits,
    enemyCountMult: 0.7,
    ufoStrengthBonus: 0,
    interceptionDamageMult: 1.0,
    fundingPressureMult: 0.85,
    panicMult: 0.75,
    threatGainMult: 0.55,
    upkeepMult: 1.0,
    alienHqCrewSize: 6,
  },
  commander: {
    label: "Commander",
    // Was 65, then 30: the 8-op victory arc (was 4) needs roughly double the
    // calendar time to win. Neither 65 nor 30 left enough margin to survive that
    // long — the balance harness (tests/balance-sim.test.ts, 50 campaigns) measured
    // just 16% at startingThreat=30, 10pts under the required 26-42% band (round13
    // §3f). The harness showed the 8-op requirement is THROUGHPUT-bound, not
    // survival-bound: commander's per-mission win rate is close to veteran/rookie,
    // but a starved early economy (low starting funding/credits) meant fewer bases
    // and slower gear upgrades, so fewer contacts got assaulted before the harness's
    // simulated-time ceiling — far short of the ~8 successes needed. Raising
    // starting funding/credits fixed throughput; startingThreat was retuned back up
    // alongside it to keep commander's threat margin tighter than veteran's.
    startingThreat: 25,
    startingFunding: 560,
    startingCredits: 700,
    // ufoStrengthBonus has no live consumer (dead config field; grep confirms it is
    // read nowhere outside this table) so it does not affect balance — only
    // enemyCountMult and the multipliers below do. enemyCountMult matches veteran's
    // (0.7): commander's difficulty now comes from its harsher economy/threat
    // multipliers, ARC_FAILURE_RELIEF/CONTACT_PENALTY_SCALE (storage.ts/geoscape.ts,
    // raised 0.05 -> 0.28 to restore real teeth to failure penalties), and a tighter
    // starting threat margin, rather than from materially bigger tactical battles
    // (which mainly fed more mission-scaled loot and paradoxically raised the win
    // rate further via the same economic snowball that throughput needed).
    enemyCountMult: 0.7,
    ufoStrengthBonus: 0.6,
    interceptionDamageMult: 1.1,
    fundingPressureMult: 1.15,
    panicMult: 1.05,
    threatGainMult: 0.9,
    upkeepMult: 1.15,
    alienHqCrewSize: 7,
  },
};

export function difficultyConfig(campaign: CampaignState): DifficultyConfig {
  return DIFFICULTY_CONFIGS[campaign.strategic.difficulty ?? "veteran"];
}

/** Pricing + restock cadence for a weapon offered by the council market. */
export interface WeaponMarketEntry {
  price: number;
  maxStock: number;
  restockHours: number;
}

/** Weapons the council sells from the start — no research clearance required. */
export const BASE_MARKET_WEAPONS: readonly CampaignWeaponId[] = ["rifle", "pistol"];

/**
 * Weapon ids the council stocks from day one. Each is seeded into the market at
 * full capacity on a fresh campaign and on load; purchase is still clearance-gated
 * by {@link isWeaponAvailable} (plasma sits in stock until plasmaWeapons clears).
 * Research-only weapons such as "cannon" are stocked only once their unlocking
 * project completes, so they are intentionally excluded from this set.
 */
const STOCKED_WEAPON_IDS: readonly CampaignWeaponId[] = ["rifle", "pistol", "plasma"];

export const MARKET_CONFIG: Record<CampaignWeaponId, WeaponMarketEntry> = {
  rifle: { price: 400, maxStock: 6, restockHours: 48 },
  pistol: { price: 250, maxStock: 6, restockHours: 48 },
  plasma: { price: 1200, maxStock: 6, restockHours: 48 },
  cannon: { price: 1800, maxStock: 4, restockHours: 60 },
};

/** Market-entry lookup for any campaign weapon id. */
export function weaponMarketEntry(weaponId: string): WeaponMarketEntry | undefined {
  return isCampaignWeaponId(weaponId) ? MARKET_CONFIG[weaponId] : undefined;
}

export const STARTING_MARKET: EquipmentMarket = {
  stock: Object.fromEntries(STOCKED_WEAPON_IDS.map((id) => [id, MARKET_CONFIG[id].maxStock])),
  restockTimerHours: {},
};

const WEAPON_LABELS: Record<CampaignWeaponId, string> = {
  rifle: "Service rifle",
  pistol: "Sidearm",
  plasma: "Plasma caster",
  cannon: "Heavy plasma cannon",
};

const TERROR_EXTRA_PANIC_LOCAL = 14;
const TERROR_EXTRA_PANIC_SPILLOVER = 4;
const TERROR_RESCUE_CREDITS_PER_CIVILIAN = 20;
const TERROR_RESCUE_FUNDING_PER_CIVILIAN = 5;
const TERROR_RESCUE_SCORE_PER_CIVILIAN = 10;

export const RESEARCH_COSTS: Record<ResearchId, CampaignResources> = {
  plasmaWeapons: {
    credits: 200,
    alloys: 8,
    elerium: 2,
    alienData: 3,
  },
  alloyArmor: {
    credits: 180,
    alloys: 10,
    elerium: 0,
    alienData: 2,
  },
  alienBiotech: {
    credits: 160,
    alloys: 0,
    elerium: 0,
    alienData: 4,
  },
  heavyPlasma: {
    credits: 260,
    alloys: 12,
    elerium: 4,
    alienData: 3,
  },
  advancedMetallurgy: {
    credits: 240,
    alloys: 14,
    elerium: 3,
    alienData: 2,
  },
  improvedMedikit: {
    credits: 180,
    alloys: 2,
    elerium: 1,
    alienData: 4,
  },
  poweredArmor: {
    credits: 320,
    alloys: 18,
    elerium: 6,
    alienData: 3,
  },
  eleriumPowerSource: {
    credits: 360,
    alloys: 16,
    elerium: 10,
    alienData: 5,
  },
  mindShield: {
    credits: 420,
    alloys: 12,
    elerium: 12,
    alienData: 8,
  },
  alienPropulsion: {
    credits: 300,
    alloys: 14,
    elerium: 6,
    alienData: 4,
  },
  alienInterrogation: {
    credits: 200,
    alloys: 0,
    elerium: 0,
    alienData: 4,
  },
  leaderInterrogation: {
    credits: 260,
    alloys: 0,
    elerium: 2,
    alienData: 6,
  },
  commanderInterrogation: {
    credits: 340,
    alloys: 0,
    elerium: 4,
    alienData: 8,
  },
};

export interface ResearchProject {
  id: ResearchId;
  title: string;
  description: string;
  completedDescription: string;
  durationHours: number;
  cost: CampaignResources;
  /** Prerequisite research that must be completed before this project can start. */
  requires: ResearchId[];
  /** Gear unlocked for market purchase / armory stock when this project completes. */
  unlocks?: ResearchUnlocks;
  /** When true, the project can only start if a live captive of ANY rank is held. */
  requiresCaptive?: boolean;
  /**
   * When set, the project can only start if a live captive of AT LEAST this rank
   * is held (rank order: soldier < navigator < leader < commander). Implies
   * requiresCaptive.
   */
  requiresCaptiveRank?: CaptiveRank;
  /** When true, completing the project consumes (removes) the qualifying captive. */
  consumesCaptive?: boolean;
  /** When true, completing the project REVEALS the alien HQ location. */
  revealsAlienHq?: boolean;
  /** When true, completing the project unlocks the final alien-base assault. */
  unlocksFinalAssault?: boolean;
  /**
   * A manufacturing project this research gates (via that project's
   * `requiresResearch`). Set on tech that enables a buildable craft rather than
   * squad gear, so it is exempt from the "declares a weapon/item unlock" rule.
   */
  unlocksManufacturing?: ManufacturingProjectId;
}

/**
 * What a manufacturing project fabricates on completion. Weapons land in
 * `armory.weapons` (one of the fixed CampaignWeaponId slots); everything else
 * lands in the free-form `armory.items` stock as consumables (grenades,
 * medkits). Every product id must resolve to a real battle-side Weapon or Item
 * definition so the gear is visible in the loadout UI and effective in battle;
 * projects whose product has no such definition are intentionally omitted.
 * `quantity` lets a single run fabricate a batch (e.g. of grenades).
 */
/** Spec for a craft a manufacturing project fabricates straight into the hangar fleet. */
export interface ManufacturedCraftSpec {
  kind: "interceptor";
  name: string;
  speedDegPerHour: number;
  hullPoints: number;
  weaponPower: number;
  maxFuel: number;
  /** Air-combat loadout (AIR_WEAPONS ids) the fabricated craft joins the fleet with. */
  loadout: string[];
}

export type ManufacturingProduct =
  | { kind: "weapon"; weaponId: CampaignWeaponId; quantity: number }
  | { kind: "item"; itemId: string; quantity: number }
  | { kind: "craft"; craft: ManufacturedCraftSpec; quantity: 1 };

export interface ManufacturingProject {
  id: ManufacturingProjectId;
  product: ManufacturingProduct;
  title: string;
  description: string;
  durationHours: number;
  cost: CampaignResources;
  /** Prerequisite research that must be completed before this project can start. */
  requiresResearch?: ResearchId;
}

export interface CampaignObjectiveProgress {
  completed: number;
  required: number;
  remaining: number;
  percent: number;
  status: CampaignStatus;
  title: string;
  summary: string;
}

export const RESEARCH_PROJECTS: readonly ResearchProject[] = [
  {
    id: "plasmaWeapons",
    title: "Plasma weapons",
    description: "Reverse-engineer recovered emitters. Adds one plasma caster to the armory.",
    completedDescription: "One plasma caster is available in the armory for squad assignment.",
    durationHours: 24,
    cost: RESEARCH_COSTS.plasmaWeapons,
    requires: [],
    unlocks: { weapons: ["plasma"] },
  },
  {
    id: "alloyArmor",
    title: "Alloy armor",
    description: "Fabricate composite armor plates from recovered alloys. All deployed operatives gain durability.",
    completedDescription: "All deployed operatives gain +6 health and +2 reactions from alloy plate inserts.",
    durationHours: 18,
    cost: RESEARCH_COSTS.alloyArmor,
    requires: [],
    unlocks: { items: ["grenade"] },
  },
  {
    id: "alienBiotech",
    title: "Xenobiology",
    description: "Catalogue recovered alien physiology. Foundation for medical and neural research.",
    completedDescription: "Alien tissue data is archived, unlocking biomedical and psionic lines of inquiry.",
    durationHours: 20,
    cost: RESEARCH_COSTS.alienBiotech,
    requires: [],
    unlocks: { items: ["medkit"] },
  },
  {
    id: "heavyPlasma",
    title: "Heavy plasma cannon",
    description: "Scale recovered emitter technology into a vehicle-grade anti-materiel platform.",
    completedDescription: "Heavy plasma fabrication schematics are ready for workshop integration.",
    durationHours: 30,
    cost: RESEARCH_COSTS.heavyPlasma,
    requires: ["plasmaWeapons"],
    unlocks: { weapons: ["cannon"] },
  },
  {
    id: "advancedMetallurgy",
    title: "Elerium metallurgy",
    description: "Infuse alien alloys with elerium to produce hardened composites for powered systems.",
    completedDescription: "Elerium-doped alloy stock is available for advanced armor and power fabrication.",
    durationHours: 28,
    cost: RESEARCH_COSTS.advancedMetallurgy,
    requires: ["alloyArmor"],
    unlocks: { items: ["grenade"] },
  },
  {
    id: "improvedMedikit",
    title: "Nano-medikit",
    description: "Adapt alien protein synthesis into a rapid field stabilizer for wounded operatives.",
    completedDescription: "Field medics can now stabilize critical wounds in seconds rather than minutes.",
    durationHours: 22,
    cost: RESEARCH_COSTS.improvedMedikit,
    requires: ["alienBiotech"],
    unlocks: { items: ["medkit"] },
  },
  {
    id: "poweredArmor",
    title: "Powered assault armor",
    description: "Bundle elerium-hardened plates with servo assist for a true powered infantry suit.",
    completedDescription: "Powered assault suits dramatically boost operative mobility and survivability.",
    durationHours: 36,
    cost: RESEARCH_COSTS.poweredArmor,
    requires: ["advancedMetallurgy"],
    unlocks: { items: ["smoke"] },
  },
  {
    id: "eleriumPowerSource",
    title: "Elerium power core",
    description: "Contain a sustained elerium reaction to power advanced base and weapons systems.",
    completedDescription: "A stable elerium power core is online, ready to drive next-generation hardware.",
    durationHours: 40,
    cost: RESEARCH_COSTS.eleriumPowerSource,
    requires: ["advancedMetallurgy", "heavyPlasma"],
    unlocks: { items: ["grenade"] },
  },
  {
    id: "mindShield",
    title: "Neural shield",
    description: "Combine xenobiology with elerium power to prototype operative neural shielding.",
    completedDescription: "Neural shields give operatives their first real defense against alien psionics.",
    durationHours: 44,
    cost: RESEARCH_COSTS.mindShield,
    requires: ["alienBiotech", "eleriumPowerSource"],
    unlocks: { items: ["smoke"] },
  },
  {
    id: "alienPropulsion",
    title: "Alien propulsion",
    description:
      "Reverse-engineer the recovered gravitic drive to power a next-generation interceptor that can run down the largest hulls.",
    completedDescription:
      "Gravitic drive schematics are ready — the Phantom advanced interceptor can now be fabricated in the workshop.",
    durationHours: 32,
    cost: RESEARCH_COSTS.alienPropulsion,
    requires: ["alienBiotech"],
    unlocksManufacturing: "phantom",
  },
  {
    id: "alienInterrogation",
    title: "Alien interrogation",
    description: "Interrogate a live captive to extract intel on the invasion's structure and intent.",
    completedDescription: "The captive's debrief charts the alien command chain and hints at a coordinating headquarters.",
    durationHours: 24,
    cost: RESEARCH_COSTS.alienInterrogation,
    requires: ["alienBiotech"],
    requiresCaptive: true,
    consumesCaptive: true,
  },
  {
    id: "leaderInterrogation",
    title: "Leader interrogation",
    description: "Break a captured alien leader to pinpoint the terrestrial headquarters coordinating the invasion.",
    completedDescription: "The leader's intel reveals the alien headquarters — a transport assault is now possible.",
    durationHours: 30,
    cost: RESEARCH_COSTS.leaderInterrogation,
    requires: ["alienInterrogation"],
    requiresCaptiveRank: "leader",
    consumesCaptive: true,
    revealsAlienHq: true,
  },
  {
    id: "commanderInterrogation",
    title: "Commander interrogation",
    description: "Interrogate a captured alien commander to expose the headquarters' defenses and unlock a decapitating strike.",
    completedDescription: "The commander's intel clears the way for the final assault on the alien headquarters.",
    durationHours: 36,
    cost: RESEARCH_COSTS.commanderInterrogation,
    requires: ["leaderInterrogation"],
    requiresCaptiveRank: "commander",
    consumesCaptive: true,
    unlocksFinalAssault: true,
  },
] as const;

export const RESEARCH_IDS: readonly ResearchId[] = RESEARCH_PROJECTS.map((project) => project.id);

/**
 * Reverse index from a weapon id to the research project whose completion
 * unlocks it for market purchase. Derived from each project's `unlocks.weapons`,
 * so adding a new weapon unlock is purely a data change in RESEARCH_PROJECTS.
 */
const WEAPON_UNLOCK_RESEARCH: ReadonlyMap<string, ResearchId> = (() => {
  const map = new Map<string, ResearchId>();
  for (const project of RESEARCH_PROJECTS) {
    for (const weapon of project.unlocks?.weapons ?? []) {
      if (!map.has(weapon)) map.set(weapon, project.id);
    }
  }
  return map;
})();

/**
 * Whether the council market offers `weaponId` for sale in this campaign. Base
 * weapons (rifle, pistol) are always available; every other weapon requires the
 * research project that unlocks it to be complete. Used to gate purchases and to
 * let the market panel show only gear the commander can actually buy.
 */
export function isWeaponAvailable(campaign: CampaignState, weaponId: string): boolean {
  if ((BASE_MARKET_WEAPONS as readonly string[]).includes(weaponId)) return true;
  const required = WEAPON_UNLOCK_RESEARCH.get(weaponId);
  return required !== undefined && hasResearch(campaign, required);
}

export type ResearchStatus = "completed" | "available" | "locked";

export interface ResearchTreeNode {
  project: ResearchProject;
  status: ResearchStatus;
}

export const MANUFACTURING_PROJECTS: readonly ManufacturingProject[] = [
  {
    id: "pistol",
    product: { kind: "weapon", weaponId: "pistol", quantity: 1 },
    title: "Sidearm",
    description: "Machine a compact backup weapon for rookies, scouts, or wounded veterans.",
    durationHours: 8,
    cost: { credits: 45, alloys: 2, elerium: 0, alienData: 0 },
  },
  {
    id: "rifle",
    product: { kind: "weapon", weaponId: "rifle", quantity: 1 },
    title: "Service rifle",
    description: "Assemble another standard long arm for replacement troops.",
    durationHours: 12,
    cost: { credits: 80, alloys: 4, elerium: 0, alienData: 0 },
  },
  {
    id: "plasma",
    product: { kind: "weapon", weaponId: "plasma", quantity: 1 },
    title: "Plasma caster",
    description: "Fabricate a recovered emitter around an alien alloy frame.",
    durationHours: 36,
    cost: { credits: 160, alloys: 8, elerium: 2, alienData: 2 },
    requiresResearch: "plasmaWeapons",
  },
  {
    id: "grenade",
    product: { kind: "item", itemId: "grenade", quantity: 2 },
    title: "Frag grenade",
    description: "Press a batch of alloy-cased fragmentation grenades for the squad.",
    durationHours: 6,
    cost: { credits: 50, alloys: 3, elerium: 0, alienData: 0 },
  },
  {
    id: "medkit",
    product: { kind: "item", itemId: "medkit", quantity: 1 },
    title: "Field medkit",
    description: "Assemble a trauma kit so medics can stabilize the wounded in the field.",
    durationHours: 14,
    cost: { credits: 90, alloys: 2, elerium: 1, alienData: 2 },
  },
  {
    id: "cannon",
    product: { kind: "weapon", weaponId: "cannon", quantity: 1 },
    title: "Heavy plasma cannon",
    description: "Fabricate a vehicle-grade anti-materiel plasma platform.",
    durationHours: 40,
    cost: { credits: 200, alloys: 12, elerium: 4, alienData: 2 },
    requiresResearch: "heavyPlasma",
  },
  {
    id: "phantom",
    product: {
      kind: "craft",
      quantity: 1,
      craft: {
        kind: "interceptor",
        // 7,150 km/h ≈ 64.3 deg/hour — scaled to keep the Phantom's historical 1.6/0.9
        // speed ratio over the Raptor (36.2 × 1.6 / 0.9 ≈ 64.3), so it still runs down a
        // battleship (54.3) that outruns a Raptor.
        name: "Phantom",
        speedDegPerHour: 64.3,
        hullPoints: 140,
        weaponPower: 1.5,
        maxFuel: 120,
        loadout: ["avalanche", "stingray", "cannon"],
      },
    },
    title: "Phantom interceptor",
    description:
      "Fabricate an elerium-driven advanced interceptor: fast enough to run down a battleship, tougher, and harder-hitting in the air.",
    durationHours: 60,
    cost: { credits: 900, alloys: 40, elerium: 20, alienData: 0 },
    requiresResearch: "alienPropulsion",
  },
] as const;

export const MANUFACTURING_PROJECT_IDS: readonly ManufacturingProjectId[] = MANUFACTURING_PROJECTS.map(
  (project) => project.id,
);

const STARTING_SOLDIER_NAMES = ["Vega", "Rook", "Mason", "Pike", "Cole", "Reyes"] as const;
const RECRUIT_NAMES = ["Knox", "Drake", "Sloane", "Hart", "Frost", "Wren"] as const;
export const STARTING_ARMORY: CampaignArmory = {
  weapons: {
    rifle: STARTING_SOLDIER_NAMES.length,
    pistol: 2,
    plasma: 0,
    cannon: 0,
  },
  // Stun rods ship from day one so a squad can take aliens alive for containment
  // and interrogation without waiting on research — cheap, reusable capture gear.
  items: { grenade: 8, medkit: 4, smoke: 4, stunRod: 4 },
};

const RANKS: readonly { rank: SoldierRank; minSurvived: number; bonus: SoldierStatBonus }[] = [
  { rank: "rookie", minSurvived: 0, bonus: { timeUnits: 0, health: 0, reactions: 0, firingAccuracy: 0 } },
  { rank: "squaddie", minSurvived: 1, bonus: { timeUnits: 2, health: 2, reactions: 4, firingAccuracy: 4 } },
  { rank: "sergeant", minSurvived: 3, bonus: { timeUnits: 4, health: 5, reactions: 7, firingAccuracy: 8 } },
  { rank: "captain", minSurvived: 5, bonus: { timeUnits: 6, health: 8, reactions: 10, firingAccuracy: 12 } },
];

/** Zero growth — the starting point for every recruit and the default on load. */
const STAT_GROWTH_ZERO: SoldierStatGrowth = { timeUnits: 0, health: 0, reactions: 0, firingAccuracy: 0 };

/**
 * Weighted stat-growth table. Firing accuracy is the most common combat
 * refinement, followed by reactions, health, and time units — so veterans
 * "feel" like sharper shots first, then faster, tougher, and quicker.
 */
const STAT_GROWTH_WEIGHTS: ReadonlyArray<{ stat: keyof SoldierStatGrowth; cutoff: number }> = [
  { stat: "firingAccuracy", cutoff: 0.4 },
  { stat: "reactions", cutoff: 0.7 },
  { stat: "health", cutoff: 0.9 },
  { stat: "timeUnits", cutoff: 1.0 },
];

/**
 * Deterministic PRNG (mulberry32). Same seed => same stream. Mirrors the sim's
 * Rng so campaign-level growth stays reproducible for saves and replays without
 * pulling a cross-module dependency into the campaign layer.
 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Folds the campaign seed, mission number, and soldier id into a stable seed. */
function statGrowthSeed(campaignSeed: number, missionNumber: number, soldierId: string): number {
  let h = (campaignSeed ^ 0x9e3779b9 ^ Math.imul(missionNumber, 0x85ebca6b)) >>> 0;
  for (let i = 0; i < soldierId.length; i++) {
    h = Math.imul(h ^ soldierId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Rolls the per-mission stat growth for one surviving soldier. Deterministic in
 * (campaign seed, mission number, soldier id): a given operative always earns the
 * same growth from the same operation. Amount is 1..3 to a single weighted stat.
 */
function rollStatGrowth(campaignSeed: number, missionNumber: number, soldierId: string): SoldierStatGrowth {
  const rng = mulberry32(statGrowthSeed(campaignSeed, missionNumber, soldierId));
  const statRoll = rng();
  const amount = 1 + Math.floor(rng() * 3);
  const growth: SoldierStatGrowth = { ...STAT_GROWTH_ZERO };
  const stat = STAT_GROWTH_WEIGHTS.find((entry) => statRoll < entry.cutoff)?.stat ?? "firingAccuracy";
  growth[stat] = amount;
  return growth;
}

function addStatGrowth(a: SoldierStatGrowth, b: SoldierStatGrowth): SoldierStatGrowth {
  return {
    timeUnits: a.timeUnits + b.timeUnits,
    health: a.health + b.health,
    reactions: a.reactions + b.reactions,
    firingAccuracy: a.firingAccuracy + b.firingAccuracy,
  };
}

/** Cities referenced in bio backgrounds (terror-site flavour). */
const BIO_CITIES = [
  "Berlin",
  "Tokyo",
  "São Paulo",
  "Cairo",
  "Sydney",
  "Toronto",
  "Mumbai",
  "Lagos",
  "Mexico City",
  "Seoul",
] as const;

/** Prior service branches for ex-military backgrounds. */
const BIO_BRANCHES = [
  "special forces",
  "infantry",
  "recon",
  "combat engineering",
  "mountain warfare",
  "airborne",
] as const;

interface BioContext {
  city: string;
  years: number;
  branch: string;
}

/**
 * Bio background templates. Each produces one self-contained sentence (no
 * internal periods) so a bio always reads as a single beat. Some templates
 * ignore the rolled context, which is how "civilian volunteer" backgrounds
 * surface alongside professional ones.
 */
const BIO_TEMPLATES: ReadonlyArray<(ctx: BioContext) => string> = [
  (ctx) => `Former paramedic, enlisted after the ${ctx.city} attack.`,
  (ctx) => `Ex-military, ${ctx.years} years ${ctx.branch}.`,
  () => `Civilian volunteer, quick learner.`,
  (ctx) => `Former ${ctx.city} police officer, volunteered for the program.`,
  (ctx) => `Retired from ${ctx.years} years of search-and-rescue work.`,
  () => `Off-duty firefighter who witnessed the first landings.`,
  (ctx) => `Field medic with ${ctx.years} combat tours overseas.`,
  (ctx) => `Former ${ctx.branch} NCO, recalled to active duty.`,
  () => `Gliding instructor turned quiet under fire.`,
  (ctx) => `Coast guard swimmer, reassigned from the ${ctx.city} coastline.`,
];

/** Distinct salt from statGrowthSeed so the bio stream never overlaps it. */
function bioSeed(campaignSeed: number, soldierId: string): number {
  let h = (campaignSeed ^ 0x85ebca77) >>> 0;
  for (let i = 0; i < soldierId.length; i++) {
    h = Math.imul(h ^ soldierId.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * Rolls a one-sentence operative background. Deterministic in (campaign seed,
 * soldier id): the same operative in the same campaign always reads the same
 * bio, for stable saves and replays.
 */
function generateBio(campaignSeed: number, soldierId: string): string {
  const rng = mulberry32(bioSeed(campaignSeed, soldierId));
  const template = BIO_TEMPLATES[Math.floor(rng() * BIO_TEMPLATES.length)]!;
  const ctx: BioContext = {
    city: BIO_CITIES[Math.floor(rng() * BIO_CITIES.length)]!,
    years: 3 + Math.floor(rng() * 18),
    branch: BIO_BRANCHES[Math.floor(rng() * BIO_BRANCHES.length)]!,
  };
  return template(ctx);
}

function campaignId(seed: number): string {
  return `campaign-${seed.toString(16).padStart(8, "0")}`;
}

function soldierId(index: number): string {
  return `soldier-${String(index + 1).padStart(2, "0")}`;
}

function makeSoldier(id: string, name: string, seed: number): CampaignSoldier {
  return {
    id,
    name,
    status: "active",
    rank: "rookie",
    missions: 0,
    survivedMissions: 0,
    statGrowth: { ...STAT_GROWTH_ZERO },
    bio: generateBio(seed, id),
  };
}

function startingSoldiers(seed: number): CampaignSoldier[] {
  return STARTING_SOLDIER_NAMES.map((name, index) => makeSoldier(soldierId(index), name, seed));
}

function startingLoadouts(soldiers: readonly CampaignSoldier[]): Record<string, CampaignWeaponId> {
  return Object.fromEntries(soldiers.map((soldier) => [soldier.id, "rifle" as CampaignWeaponId]));
}

function startingDeployment(soldiers: readonly CampaignSoldier[]): string[] {
  return soldiers.slice(0, DEPLOYMENT_SIZE).map((soldier) => soldier.id);
}

/**
 * Council-region anchor points, used to resolve a free lat/lon (e.g. the seeded
 * alien HQ) to a region string. Kept local to storage so the module stays free of
 * a reverse dependency on the geoscape (which owns the same CONTACT_ZONES table).
 */
const REGION_ANCHORS: readonly { region: string; lat: number; lon: number }[] = [
  { region: "North America", lat: 44.6, lon: -97.3 },
  { region: "South America", lat: -14.2, lon: -52.8 },
  { region: "Europe", lat: 48.2, lon: 14.6 },
  { region: "Africa", lat: 4.8, lon: 22.1 },
  { region: "Middle East", lat: 31.4, lon: 47.6 },
  { region: "South Asia", lat: 21.6, lon: 77.4 },
  { region: "East Asia", lat: 35.9, lon: 116.3 },
  { region: "Oceania", lat: -24.8, lon: 133.7 },
];

/** Nearest council-region anchor to a lat/lon (great-circle-ish, cos-lat weighted). */
function regionForLocation(lat: number, lon: number): string {
  let best = REGION_ANCHORS[0]!;
  let bestD = Infinity;
  for (const anchor of REGION_ANCHORS) {
    const dLat = anchor.lat - lat;
    const dLon = (anchor.lon - lon) * Math.cos((lat * Math.PI) / 180);
    const d = dLat * dLat + dLon * dLon;
    if (d < bestD) {
      best = anchor;
      bestD = d;
    }
  }
  return best.region;
}

/** Salt so the HQ location stream never overlaps the stat-growth / bio streams. */
const ALIEN_HQ_SEED_SALT = 0x5f356495;

/**
 * Deterministically seed the alien HQ on a LAND location. Samples lat/lon from a
 * seeded rng inside the plausible detection band and retries until it lands on
 * land (isLand). Hidden until an interrogation or the fallback milestone reveals it.
 */
function seedAlienHq(seed: number): AlienHq {
  const rng = mulberry32((seed ^ ALIEN_HQ_SEED_SALT) >>> 0);
  let lat = 0;
  let lon = 0;
  for (let attempt = 0; attempt < 1000; attempt++) {
    // Detection band matches the geoscape's contact clamp (-56..68).
    lat = Math.round((rng() * 124 - 56) * 10) / 10;
    lon = Math.round((rng() * 360 - 180) * 10) / 10;
    if (isLand(lat, lon)) break;
  }
  return { location: { lat, lon, region: regionForLocation(lat, lon) }, revealed: false };
}

export function createCampaign(
  base: BaseLocation,
  seed: number,
  difficulty: DifficultyLevel = "veteran",
): CampaignState {
  const config = DIFFICULTY_CONFIGS[difficulty];
  const soldiers = startingSoldiers(seed);
  const strategic: StrategicState = {
    status: STARTING_STRATEGIC.status,
    threat: config.startingThreat,
    funding: config.startingFunding,
    score: STARTING_STRATEGIC.score,
    // Veteran is the default; omitting the key preserves the historical strategic shape.
    ...(difficulty !== "veteran" ? { difficulty } : {}),
  };
  return {
    version: 1,
    id: campaignId(seed),
    seed: seed >>> 0,
    createdAt: new Date().toISOString(),
    base,
    strategic,
    regionalPanic: { ...STARTING_REGIONAL_PANIC },
    infiltration: { ...STARTING_INFILTRATION },
    clock: { ...STARTING_CLOCK },
    lastFundingReport: undefined,
    interceptor: { ...STARTING_INTERCEPTOR },
    fleet: STARTING_FLEET.map((craft) => ({ ...craft })),
    lastInterceptionReport: undefined,
    resources: { ...STARTING_RESOURCES, credits: config.startingCredits },
    armory: cloneArmory(STARTING_ARMORY),
    market: cloneMarket(STARTING_MARKET),
    soldierLoadouts: startingLoadouts(soldiers),
    deploymentSoldierIds: startingDeployment(soldiers),
    facilities: starterFacilityIds(),
    soldiers,
    completedResearch: [],
    activeResearch: undefined,
    activeManufacturing: undefined,
    activeConstruction: undefined,
    missionsCompleted: 0,
    missionsAttempted: 0,
    projectReports: [],
    alienHq: seedAlienHq(seed),
  };
}

export function updateCampaignBase(campaign: CampaignState, base: BaseLocation): CampaignState {
  return { ...campaign, base };
}

export function campaignMissionSeed(campaign: CampaignState): number {
  return (campaign.seed ^ 0x9e3779b9 ^ campaign.missionsAttempted) >>> 0;
}

export function campaignObjectiveProgress(campaign: CampaignState): CampaignObjectiveProgress {
  const required = CAMPAIGN_VICTORY_OPERATIONS;
  const completed = Math.max(0, Math.min(required, Math.floor(campaign.missionsCompleted)));
  const remaining = Math.max(0, required - completed);
  const percent = Math.round((completed / required) * 100);
  if (campaign.strategic.status === "won") {
    return {
      completed,
      required,
      remaining,
      percent,
      status: campaign.strategic.status,
      title: "Containment achieved",
      summary: "The alien headquarters has fallen. The invasion's command cell is broken.",
    };
  }
  if (campaign.strategic.status === "active") {
    const region = campaign.alienHq?.location.region;
    // READY: the HQ is revealed AND the assault is unlocked (commander interrogation
    // or the CAMPAIGN_VICTORY_OPERATIONS fallback). Launching it is the true victory.
    if (canLaunchFinalAssault(campaign)) {
      return {
        completed,
        required,
        remaining,
        percent,
        status: campaign.strategic.status,
        title: "Final assault ready",
        summary: region
          ? `Alien HQ located in ${region}. Launch the final assault to end the invasion.`
          : "Alien HQ located. Launch the final assault to end the invasion.",
      };
    }
    // REVEALED-BUT-LOCKED: a leader interrogation exposes the HQ location WITHOUT
    // unlocking the assault — the player still needs a commander interrogation or
    // enough operations to plan the strike.
    if (campaign.alienHq?.revealed) {
      const opsClause = `complete ${remaining} more operation${remaining === 1 ? "" : "s"}`;
      return {
        completed,
        required,
        remaining,
        percent,
        status: campaign.strategic.status,
        title: "Alien HQ located",
        summary: `Alien HQ located in ${region}. Interrogate an alien commander — or ${opsClause} — to plan the final assault.`,
      };
    }
  }
  if (campaign.strategic.status === "lost") {
    return {
      completed,
      required,
      remaining,
      percent,
      status: campaign.strategic.status,
      title: "Containment failed",
      summary: `Recovered ${completed}/${required} UFO cores before command collapse.`,
    };
  }
  return {
    completed,
    required,
    remaining,
    percent,
    status: campaign.strategic.status,
    title: "Containment objective",
    summary: `Recover ${remaining} more UFO core${remaining === 1 ? "" : "s"} to expose the invasion cell.`,
  };
}

export function activeSoldiers(campaign: CampaignState): CampaignSoldier[] {
  return campaign.soldiers.filter((soldier) => soldier.status === "active");
}

export function councilRegionFor(region: string): CouncilRegion | undefined {
  if ((COUNCIL_REGIONS as readonly string[]).includes(region)) return region as CouncilRegion;
  if (region === "Central America") return "North America";
  if (region === "Siberia") return "East Asia";
  if (region === "Pacific sector" || region === "Antarctic perimeter") return "Oceania";
  if (region === "Atlantic sector") return "Europe";
  if (region === "Open ocean sector") return undefined;
  return undefined;
}

export function highestRegionalPanic(
  campaign: CampaignState,
): { region: CouncilRegion; panic: number } {
  return COUNCIL_REGIONS.reduce<{ region: CouncilRegion; panic: number }>(
    (worst, region) => {
      const panic = campaign.regionalPanic[region] ?? STARTING_REGIONAL_PANIC[region];
      return panic > worst.panic ? { region, panic } : worst;
    },
    {
      region: COUNCIL_REGIONS[0]!,
      panic: campaign.regionalPanic[COUNCIL_REGIONS[0]!] ?? STARTING_REGIONAL_PANIC[COUNCIL_REGIONS[0]!],
    },
  );
}

export function regionalPanicFor(campaign: CampaignState, region: string): number | undefined {
  const councilRegion = councilRegionFor(region);
  return councilRegion ? campaign.regionalPanic[councilRegion] : undefined;
}

export function adjustRegionalPanic(
  regionalPanic: Record<CouncilRegion, number>,
  region: string,
  localDelta: number,
  spilloverDelta = 0,
  panicMult = 1,
): Record<CouncilRegion, number> {
  const councilRegion = councilRegionFor(region);
  const next = { ...regionalPanic };
  const scaledLocal = Math.round(localDelta * panicMult);
  const scaledSpillover = Math.round(spilloverDelta * panicMult);
  for (const one of COUNCIL_REGIONS) {
    const delta = one === councilRegion ? scaledLocal : scaledSpillover;
    next[one] = Math.max(0, Math.min(PANIC_LOSS_THRESHOLD, Math.round((next[one] ?? STARTING_REGIONAL_PANIC[one]) + delta)));
  }
  return next;
}

/**
 * The full per-region infiltration map for a campaign. Stored values (which may be
 * sparse) are folded over an all-zero base so callers always see a complete record.
 */
export function campaignInfiltration(campaign: CampaignState): Record<CouncilRegion, number> {
  const stored = campaign.infiltration;
  if (!stored) return { ...STARTING_INFILTRATION };
  const result = { ...STARTING_INFILTRATION };
  for (const region of COUNCIL_REGIONS) {
    const value = stored[region];
    if (typeof value === "number") result[region] = value;
  }
  return result;
}

/** Infiltration level of a contact's region, or undefined when the region is not a council region. */
export function regionalInfiltrationFor(campaign: CampaignState, region: string): number | undefined {
  const councilRegion = councilRegionFor(region);
  return councilRegion ? campaignInfiltration(campaign)[councilRegion] : undefined;
}

/**
 * Raises (or lowers) one region's alien infiltration. Unlike panic, infiltration
 * is targeted — there is no spillover to neighbouring regions. The meter is
 * clamped to [0, 100]; a region pinned at 100 is permanently defected.
 */
export function adjustRegionalInfiltration(
  infiltration: Record<CouncilRegion, number>,
  region: string,
  delta: number,
  mult = 1,
): Record<CouncilRegion, number> {
  const councilRegion = councilRegionFor(region);
  if (!councilRegion) return infiltration;
  const next = { ...infiltration };
  const scaled = Math.round(delta * mult);
  next[councilRegion] = Math.max(0, Math.min(100, Math.round((next[councilRegion] ?? 0) + scaled)));
  return next;
}

/** Council regions whose infiltration has maxed out and signed a pact with the aliens. */
export function defectedRegions(campaign: CampaignState): CouncilRegion[] {
  const infiltration = campaignInfiltration(campaign);
  return COUNCIL_REGIONS.filter((region) => infiltration[region] >= 100);
}

export function livingSoldiers(campaign: CampaignState): CampaignSoldier[] {
  return campaign.soldiers.filter((soldier) => soldier.status !== "kia");
}

export function recoverWoundedSoldiers(campaign: CampaignState): CampaignState {
  let changed = false;
  const soldiers = campaign.soldiers.map((soldier) => {
    if (
      soldier.status !== "wounded" ||
      typeof soldier.woundedUntilHour !== "number" ||
      soldier.woundedUntilHour > campaign.clock.elapsedHours
    ) {
      return soldier;
    }
    changed = true;
    return {
      ...soldier,
      status: "active" as const,
      woundedUntilHour: undefined,
    };
  });
  return changed ? { ...campaign, soldiers } : campaign;
}

function campaignClockAt(
  clock: CampaignClock,
  elapsedHours: number,
  lastContactHour = clock.lastContactHour,
): CampaignClock {
  const elapsed = Math.max(0, Math.floor(elapsedHours));
  return {
    day: 1 + Math.floor(elapsed / 24),
    hour: elapsed % 24,
    elapsedHours: elapsed,
    lastContactHour: Math.max(0, Math.floor(lastContactHour)),
    lastFundingHour: Math.max(0, Math.floor(clock.lastFundingHour)),
  };
}

function completedOperationDuration(operation: OperationPlan): number {
  return Number.isFinite(operation.durationHours)
    ? Math.max(0, Math.floor(operation.durationHours))
    : 0;
}

function resolveInterceptorRepair(campaign: CampaignState): CampaignState {
  return repairFleet(campaign);
}

function completeStrategicProgress(campaign: CampaignState): CampaignState {
  return completeFinishedConstruction(
    completeFinishedManufacturing(
      recoverWoundedSoldiers(completeFinishedResearch(resolveInterceptorRepair(campaign))),
    ),
  );
}

export function deploymentSoldiers(campaign: CampaignState): CampaignSoldier[] {
  const activeById = new Map(activeSoldiers(campaign).map((soldier) => [soldier.id, soldier]));
  return campaign.deploymentSoldierIds
    .flatMap((id) => {
      const soldier = activeById.get(id);
      return soldier ? [soldier] : [];
    })
    .slice(0, DEPLOYMENT_SIZE);
}

export function canDeploySoldier(campaign: CampaignState, soldierId: string): boolean {
  if (campaign.strategic.status !== "active") return false;
  const soldier = campaign.soldiers.find((candidate) => candidate.id === soldierId);
  if (!soldier || soldier.status !== "active") return false;
  return campaign.deploymentSoldierIds.includes(soldierId) ||
    deploymentSoldiers(campaign).length < DEPLOYMENT_SIZE;
}

export function setSoldierDeployment(
  campaign: CampaignState,
  soldierId: string,
  deployed: boolean,
): CampaignState {
  const current = normalizeDeploymentSoldierIds(campaign.deploymentSoldierIds, campaign.soldiers);
  const alreadyDeployed = current.includes(soldierId);
  if (!deployed) {
    if (!alreadyDeployed) return campaign;
    return { ...campaign, deploymentSoldierIds: current.filter((id) => id !== soldierId) };
  }
  if (alreadyDeployed || !canDeploySoldier({ ...campaign, deploymentSoldierIds: current }, soldierId)) {
    return { ...campaign, deploymentSoldierIds: current };
  }
  return { ...campaign, deploymentSoldierIds: [...current, soldierId].slice(0, DEPLOYMENT_SIZE) };
}

export function soldierRank(survivedMissions: number): SoldierRank {
  let rank: SoldierRank = "rookie";
  for (const spec of RANKS) {
    if (survivedMissions >= spec.minSurvived) rank = spec.rank;
  }
  return rank;
}

export function soldierStatBonus(soldier: CampaignSoldier): SoldierStatBonus {
  return RANKS.find((spec) => spec.rank === soldier.rank)?.bonus ?? RANKS[0]!.bonus;
}

export function campaignSoldierStatBonus(campaign: CampaignState, soldier: CampaignSoldier): SoldierStatBonus {
  const rankBonus = soldierStatBonus(soldier);
  const armorBonus = hasResearch(campaign, "alloyArmor")
    ? { timeUnits: 0, health: 6, reactions: 2, firingAccuracy: 0 }
    : { timeUnits: 0, health: 0, reactions: 0, firingAccuracy: 0 };
  const growth = soldier.statGrowth ?? STAT_GROWTH_ZERO;
  return {
    timeUnits: rankBonus.timeUnits + armorBonus.timeUnits + growth.timeUnits,
    health: rankBonus.health + armorBonus.health + growth.health,
    reactions: rankBonus.reactions + armorBonus.reactions + growth.reactions,
    firingAccuracy: rankBonus.firingAccuracy + armorBonus.firingAccuracy + growth.firingAccuracy,
  };
}

export function canRecruitSoldier(campaign: CampaignState): boolean {
  return campaign.resources.credits >= RECRUIT_COST;
}

export function recruitSoldier(campaign: CampaignState): CampaignState {
  if (!canRecruitSoldier(campaign)) return campaign;
  const usedNames = new Set(campaign.soldiers.map((soldier) => soldier.name));
  const name =
    RECRUIT_NAMES.find((candidate) => !usedNames.has(candidate)) ??
    `Operative-${campaign.soldiers.length + 1}`;
  const recruit = makeSoldier(soldierId(campaign.soldiers.length), name, campaign.seed);
  return {
    ...campaign,
    armory: addWeapon(campaign.armory, "rifle", 1),
    soldierLoadouts: {
      ...campaign.soldierLoadouts,
      [recruit.id]: "rifle",
    },
    resources: {
      ...campaign.resources,
      credits: campaign.resources.credits - RECRUIT_COST,
    },
    soldiers: [...campaign.soldiers, recruit],
  };
}

export function soldierWeaponId(campaign: CampaignState, soldierId: string): CampaignWeaponId {
  const assigned = campaign.soldierLoadouts[soldierId];
  return isCampaignWeaponId(assigned) && campaign.armory.weapons[assigned] > 0 ? assigned : "rifle";
}

export function assignedWeaponCounts(
  campaign: CampaignState,
  ignoreSoldierId?: string,
): Record<CampaignWeaponId, number> {
  const counts = emptyWeaponCounts();
  for (const soldier of livingSoldiers(campaign)) {
    if (soldier.id === ignoreSoldierId) continue;
    counts[soldierWeaponId(campaign, soldier.id)] += 1;
  }
  return counts;
}

export function availableWeaponCount(
  campaign: CampaignState,
  weaponId: CampaignWeaponId,
  ignoreSoldierId?: string,
): number {
  return Math.max(0, campaign.armory.weapons[weaponId] - assignedWeaponCounts(campaign, ignoreSoldierId)[weaponId]);
}

export function canAssignSoldierWeapon(
  campaign: CampaignState,
  soldierId: string,
  weaponId: CampaignWeaponId,
): boolean {
  if (campaign.strategic.status !== "active") return false;
  const soldier = campaign.soldiers.find((candidate) => candidate.id === soldierId);
  if (!soldier || soldier.status === "kia") return false;
  if (!isCampaignWeaponId(weaponId) || campaign.armory.weapons[weaponId] <= 0) return false;
  return soldierWeaponId(campaign, soldierId) === weaponId || availableWeaponCount(campaign, weaponId, soldierId) > 0;
}

export function assignSoldierWeapon(
  campaign: CampaignState,
  soldierId: string,
  weaponId: CampaignWeaponId,
): CampaignState {
  if (!canAssignSoldierWeapon(campaign, soldierId, weaponId)) return campaign;
  return {
    ...campaign,
    soldierLoadouts: {
      ...campaign.soldierLoadouts,
      [soldierId]: weaponId,
    },
  };
}

export function deploymentWeaponIds(campaign: CampaignState): CampaignWeaponId[] {
  return deploymentSoldiers(campaign).map((soldier) => soldierWeaponId(campaign, soldier.id));
}

export function availableItemCount(campaign: CampaignState, itemId: string): number {
  // The armory item pool is decremented at assign time (and restored on unassign), so
  // the remaining stock IS the available count. Do not subtract loadouts again — that
  // would double-count items already removed from the pool.
  return campaign.armory.items?.[itemId] ?? 0;
}

export function soldierItemIds(campaign: CampaignState, soldierId: string): string[] {
  const soldier = campaign.soldiers.find((candidate) => candidate.id === soldierId);
  return soldier ? [...(soldier.loadoutItems ?? [])] : [];
}

export function canAssignSoldierItem(campaign: CampaignState, soldierId: string, itemId: string): boolean {
  if (campaign.strategic.status !== "active") return false;
  const soldier = campaign.soldiers.find((candidate) => candidate.id === soldierId);
  if (!soldier || soldier.status === "kia") return false;
  if (availableItemCount(campaign, itemId) <= 0) return false;
  // Backpack capacity gate (round 13): the soldier's stowed consumables must not
  // exceed BACKPACK_SLOTS once this item is added.
  return canAddToBackpack(soldier.loadoutItems ?? [], itemId);
}

function addItemStock(armory: CampaignArmory, itemId: string, delta: number): CampaignArmory {
  const current = armory.items?.[itemId] ?? 0;
  return {
    ...armory,
    items: {
      ...(armory.items ?? {}),
      [itemId]: Math.max(0, current + Math.floor(delta)),
    },
  };
}

export function assignSoldierItem(campaign: CampaignState, soldierId: string, itemId: string): CampaignState {
  if (!canAssignSoldierItem(campaign, soldierId, itemId)) return campaign;
  const soldiers = campaign.soldiers.map((soldier) =>
    soldier.id === soldierId
      ? { ...soldier, loadoutItems: [...(soldier.loadoutItems ?? []), itemId] }
      : soldier,
  );
  return {
    ...campaign,
    armory: addItemStock(campaign.armory, itemId, -1),
    soldiers,
  };
}

export function unassignSoldierItem(campaign: CampaignState, soldierId: string, itemId: string): CampaignState {
  const soldier = campaign.soldiers.find((candidate) => candidate.id === soldierId);
  if (!soldier || soldier.status === "kia") return campaign;
  const items = soldier.loadoutItems ?? [];
  const at = items.indexOf(itemId);
  if (at === -1) return campaign;
  const loadoutItems = items.filter((_, index) => index !== at);
  const soldiers = campaign.soldiers.map((entry) =>
    entry.id === soldierId ? { ...entry, loadoutItems } : entry,
  );
  return {
    ...campaign,
    armory: addItemStock(campaign.armory, itemId, 1),
    soldiers,
  };
}

export function deploymentItemIds(campaign: CampaignState): string[][] {
  return deploymentSoldiers(campaign).map((soldier) => [...(soldier.loadoutItems ?? [])]);
}

export function canPurchaseWeapon(
  campaign: CampaignState,
  weaponId: CampaignWeaponId,
): { ok: boolean; reason?: string } {
  if (!isWeaponAvailable(campaign, weaponId)) {
    return { ok: false, reason: `${WEAPON_LABELS[weaponId]} is not yet available` };
  }
  const stock = campaign.market?.stock[weaponId] ?? 0;
  if (stock <= 0) {
    return { ok: false, reason: `${WEAPON_LABELS[weaponId]} is out of stock` };
  }
  if (campaign.resources.credits < MARKET_CONFIG[weaponId].price) {
    return { ok: false, reason: `Insufficient credits for ${WEAPON_LABELS[weaponId]}` };
  }
  return { ok: true };
}

export function purchaseWeapon(campaign: CampaignState, weaponId: CampaignWeaponId): CampaignState {
  if (!canPurchaseWeapon(campaign, weaponId).ok) return campaign;
  const price = MARKET_CONFIG[weaponId].price;
  const market = campaign.market ?? cloneMarket(STARTING_MARKET);
  const stock = Math.max(0, (market.stock[weaponId] ?? 0) - 1);
  return {
    ...campaign,
    resources: { ...campaign.resources, credits: campaign.resources.credits - price },
    armory: addWeapon(campaign.armory, weaponId, 1),
    market: {
      stock: { ...market.stock, [weaponId]: stock },
      restockTimerHours: { ...market.restockTimerHours },
    },
  };
}

export function restockMarket(campaign: CampaignState, hoursAdvanced: number): CampaignState {
  const hours = Math.max(0, Math.floor(hoursAdvanced));
  if (hours <= 0) return campaign;
  const market = campaign.market ?? cloneMarket(STARTING_MARKET);
  const stock = { ...market.stock };
  const restockTimerHours = { ...market.restockTimerHours };
  for (const id of CAMPAIGN_WEAPON_IDS) {
    const config = MARKET_CONFIG[id];
    const maxStock = config.maxStock;
    const currentStock = typeof stock[id] === "number" ? stock[id]! : maxStock;
    if (currentStock >= maxStock) {
      restockTimerHours[id] = 0;
      continue;
    }
    let timer = (typeof restockTimerHours[id] === "number" ? restockTimerHours[id]! : 0) + hours;
    let nextStock = currentStock;
    while (timer >= config.restockHours && nextStock < maxStock) {
      nextStock += 1;
      timer -= config.restockHours;
    }
    stock[id] = nextStock;
    restockTimerHours[id] = nextStock >= maxStock ? 0 : timer;
  }
  return { ...campaign, market: { stock, restockTimerHours } };
}

export function constructedFacilities(campaign: CampaignState): BaseFacility[] {
  return facilitiesForIds(campaign.facilities);
}

export function hasBaseFacility(campaign: CampaignState, id: string): boolean {
  return campaign.facilities.includes(id) && findBaseFacility(id) !== undefined;
}

/** Whether any base can hold live captives (a built Alien Containment facility). */
export function hasContainment(campaign: CampaignState): boolean {
  return hasBaseFacility(campaign, CONTAINMENT_FACILITY_ID);
}

export function availableBaseFacilities(campaign: CampaignState): BaseFacility[] {
  return BASE_FACILITIES.filter(
    (facility) =>
      facility.cost &&
      !hasBaseFacility(campaign, facility.id) &&
      campaign.activeConstruction?.facilityId !== facility.id,
  );
}

export function canBuildFacility(campaign: CampaignState, id: string): boolean {
  if (
    campaign.strategic.status !== "active" ||
    hasBaseFacility(campaign, id) ||
    !!campaign.activeConstruction
  ) {
    return false;
  }
  const facility = findBaseFacility(id);
  if (!facility?.cost || !canAfford(campaign.resources, facility.cost)) return false;
  return hasPowerForFacility(campaign, facility);
}

export function buildFacility(campaign: CampaignState, id: string): CampaignState {
  if (!canBuildFacility(campaign, id)) return campaign;
  const facility = findBaseFacility(id)!;
  return {
    ...campaign,
    resources: spend(campaign.resources, facilityCost(facility)),
    activeConstruction: {
      facilityId: facility.id,
      startedAtHour: campaign.clock.elapsedHours,
      completesAtHour: campaign.clock.elapsedHours + facilityConstructionDuration(campaign, facility.id),
    },
  };
}

export function facilityConstructionDuration(campaign: CampaignState, id: string): number {
  const base = findBaseFacility(id)?.constructionHours ?? 24;
  return Math.max(6, base - (hasBaseFacility(campaign, "workshop-2") ? 6 : 0));
}

export function completeFacilityConstruction(campaign: CampaignState, id: string): CampaignState {
  if (hasBaseFacility(campaign, id)) return campaign;
  const facility = findBaseFacility(id);
  if (!facility?.cost) return campaign;
  if (campaign.activeConstruction?.facilityId === id) {
    return addProjectReport({
      ...campaign,
      activeConstruction: undefined,
      facilities: [...campaign.facilities, id],
    }, constructionReport(facility, campaign.clock.elapsedHours));
  }
  if (!canBuildFacility(campaign, id)) return campaign;
  return addProjectReport({
    ...campaign,
    resources: spend(campaign.resources, facilityCost(facility)),
    facilities: [...campaign.facilities, id],
  }, constructionReport(facility, campaign.clock.elapsedHours));
}

export function completeFinishedConstruction(campaign: CampaignState): CampaignState {
  const active = campaign.activeConstruction;
  if (!active || campaign.clock.elapsedHours < active.completesAtHour) return campaign;
  const facility = findBaseFacility(active.facilityId);
  if (!facility || hasBaseFacility(campaign, active.facilityId)) {
    return { ...campaign, activeConstruction: undefined };
  }
  return addProjectReport({
    ...campaign,
    activeConstruction: undefined,
    facilities: [...campaign.facilities, active.facilityId],
  }, constructionReport(facility, campaign.clock.elapsedHours));
}

export interface NewBaseOutcome {
  ok: boolean;
  reason?: string;
}

/** Primary base plus every extra radar base built on the globe. */
export function allBases(campaign: CampaignState): BaseLocation[] {
  return [campaign.base, ...(campaign.bases ?? [])];
}

export function canBuildNewBase(campaign: CampaignState): NewBaseOutcome {
  if (campaign.strategic.status !== "active") return { ok: false, reason: "Campaign not active" };
  if (campaign.activeBaseConstruction) return { ok: false, reason: "A base is already under construction" };
  if ((campaign.bases?.length ?? 0) >= MAX_EXTRA_BASES) return { ok: false, reason: "Maximum number of bases reached" };
  if (!canAfford(campaign.resources, NEW_BASE_COST)) return { ok: false, reason: "Not enough credits" };
  return { ok: true };
}

export function buildNewBase(campaign: CampaignState, location: BaseLocation): CampaignState {
  if (!canBuildNewBase(campaign).ok) return campaign;
  const startedAtHour = campaign.clock.elapsedHours;
  return {
    ...campaign,
    resources: spend(campaign.resources, NEW_BASE_COST),
    bases: [...(campaign.bases ?? []), location],
    activeBaseConstruction: {
      location,
      startedAtHour,
      completesAtHour: startedAtHour + NEW_BASE_CONSTRUCTION_HOURS,
    },
  };
}

export function completeFinishedBaseConstruction(campaign: CampaignState): CampaignState {
  const active = campaign.activeBaseConstruction;
  if (!active || campaign.clock.elapsedHours < active.completesAtHour) return campaign;
  const report: ProjectReport = {
    kind: "construction",
    id: `base-built-${campaign.clock.elapsedHours}`,
    title: "Base construction complete",
    summary: `New radar base online at ${active.location.region} (${active.location.lat.toFixed(1)}°, ${active.location.lon.toFixed(1)}°). UFO detection range extended.`,
    completedAtHour: campaign.clock.elapsedHours,
  };
  return addProjectReport({ ...campaign, activeBaseConstruction: undefined }, report);
}

export function manufacturingProject(id: ManufacturingProjectId): ManufacturingProject {
  return MANUFACTURING_PROJECTS.find((project) => project.id === id)!;
}

/** Total hangar berths across the base's built hangar facilities. */
export function hangarSlots(campaign: CampaignState): number {
  return summarizeBaseFacilities(constructedFacilities(campaign)).hangarSlots;
}

/** Free hangar berths = total slots minus the craft already parked in the fleet. */
export function freeHangarSlots(campaign: CampaignState): number {
  const used = (campaign.fleet ?? []).length;
  return Math.max(0, hangarSlots(campaign) - used);
}

/**
 * Deposits a fabricated product into the armory: weapons into `weapons`, items
 * into `items`. Craft products are NOT armory gear — they join the fleet in
 * {@link completeFinishedManufacturing} — so this leaves the armory untouched.
 */
function addManufacturingProduct(armory: CampaignArmory, product: ManufacturingProduct): CampaignArmory {
  if (product.kind === "weapon") return addWeapon(armory, product.weaponId, product.quantity);
  if (product.kind === "item") return addItemStock(armory, product.itemId, product.quantity);
  return armory;
}

/** Appends a freshly-fabricated craft to the fleet with a deterministic unique id. */
function addManufacturedCraft(campaign: CampaignState, spec: ManufacturedCraftSpec): CampaignState {
  const fleet = campaign.fleet ?? [];
  const serial = fleet.filter((craft) => craft.id.startsWith(`${spec.name.toLowerCase()}-`)).length + 1;
  const built: Craft = {
    id: `${spec.name.toLowerCase()}-${serial}`,
    kind: spec.kind,
    name: spec.name,
    damage: 0,
    sorties: 0,
    fuel: spec.maxFuel,
    maxFuel: spec.maxFuel,
    speedDegPerHour: spec.speedDegPerHour,
    hullPoints: spec.hullPoints,
    weaponPower: spec.weaponPower,
    ...(spec.loadout.length ? { loadout: [...spec.loadout] } : {}),
  };
  return { ...campaign, fleet: [...fleet, built] };
}

export function manufacturingDuration(campaign: CampaignState, id: ManufacturingProjectId): number {
  const base = manufacturingProject(id).durationHours;
  return Math.max(4, base - (hasBaseFacility(campaign, "workshop-2") ? 8 : 0));
}

export function manufacturingCost(campaign: CampaignState, id: ManufacturingProjectId): CampaignResources {
  const base = manufacturingProject(id).cost;
  if (!hasBaseFacility(campaign, "workshop-2")) return { ...base };
  return {
    credits: Math.max(0, base.credits - 20),
    alloys: base.alloys,
    elerium: base.elerium,
    alienData: base.alienData,
  };
}

export function canStartManufacturing(campaign: CampaignState, id: ManufacturingProjectId): boolean {
  const project = manufacturingProject(id);
  // A craft product needs a free hangar berth to receive the finished aircraft.
  if (project.product.kind === "craft" && freeHangarSlots(campaign) < 1) return false;
  return (
    campaign.strategic.status === "active" &&
    !campaign.activeManufacturing &&
    (!project.requiresResearch || hasResearch(campaign, project.requiresResearch)) &&
    canAfford(campaign.resources, manufacturingCost(campaign, id))
  );
}

export function startManufacturing(campaign: CampaignState, id: ManufacturingProjectId): CampaignState {
  if (!canStartManufacturing(campaign, id)) return campaign;
  return {
    ...campaign,
    resources: spend(campaign.resources, manufacturingCost(campaign, id)),
    activeManufacturing: {
      projectId: id,
      startedAtHour: campaign.clock.elapsedHours,
      completesAtHour: campaign.clock.elapsedHours + manufacturingDuration(campaign, id),
    },
  };
}

export function completeFinishedManufacturing(campaign: CampaignState): CampaignState {
  const active = campaign.activeManufacturing;
  if (!active || campaign.clock.elapsedHours < active.completesAtHour) return campaign;
  const project = manufacturingProject(active.projectId);
  const delivered =
    project.product.kind === "craft"
      ? addManufacturedCraft({ ...campaign, activeManufacturing: undefined }, project.product.craft)
      : {
          ...campaign,
          activeManufacturing: undefined,
          armory: addManufacturingProduct(campaign.armory, project.product),
        };
  return addProjectReport(delivered, manufacturingReport(project, campaign.clock.elapsedHours));
}

function addProjectReport(campaign: CampaignState, report: ProjectReport): CampaignState {
  return {
    ...campaign,
    projectReports: [report, ...campaign.projectReports].slice(0, PROJECT_REPORT_LIMIT),
  };
}

function constructionReport(facility: BaseFacility, completedAtHour: number): ProjectReport {
  return {
    kind: "construction",
    id: facility.id,
    title: `${facility.label} online`,
    summary: facility.effect,
    completedAtHour,
  };
}

function manufacturingReport(project: ManufacturingProject, completedAtHour: number): ProjectReport {
  const { product } = project;
  if (product.kind === "craft") {
    return {
      kind: "manufacturing",
      id: project.id,
      title: `${project.title} complete`,
      summary: `Workshop rolled out one ${product.craft.name} interceptor into the hangar.`,
      completedAtHour,
    };
  }
  const delivered =
    product.quantity === 1
      ? `one ${project.title.toLowerCase()}`
      : `${product.quantity} ${product.kind === "weapon" ? product.weaponId : product.itemId}s`;
  return {
    kind: "manufacturing",
    id: project.id,
    title: `${project.title} complete`,
    summary: `Workshop delivered ${delivered} to the armory.`,
    completedAtHour,
  };
}

function researchReport(project: ResearchProject, completedAtHour: number): ProjectReport {
  return {
    kind: "research",
    id: project.id,
    title: `${project.title} complete`,
    summary: project.completedDescription,
    completedAtHour,
  };
}

export interface MissionRosterOutcome {
  deployedSoldierIds: readonly string[];
  survivingSoldierIds: readonly string[];
  survivorHealth?: Readonly<Record<string, { hp: number; maxHp: number }>>;
  /** Terror missions: civilians on the map and their outcome. */
  civilianCount?: number;
  civiliansRescued?: number;
  civilianCasualties?: number;
  /**
   * Enemy units left unconscious at a player victory, taken as captures. The game
   * builds this from the battle's still-unconscious hostiles; the debrief turns
   * each into a {@link CampaignCaptive} IF a base has a built containment facility.
   */
  captures?: readonly MissionCapture[];
}

/** One captured (unconscious-at-victory) alien reported from a battle. */
export interface MissionCapture {
  /** Sim unit-template id of the captured species. */
  templateId: string;
  rank: CaptiveRank;
}

interface CaptiveIntake {
  /** Full captive list after intake (existing + newly secured). */
  captives: CampaignCaptive[];
  /** The debrief-facing outcome, computed now so later captive consumption can't skew it. */
  report: CaptiveIntakeReport;
}

/**
 * Turn a mission's captures into stored captives at debrief. Requires a built
 * Alien Containment facility; without it every capture is lost. Stored captives
 * are capped at CONTAINMENT_CAPACITY across all bases — excess captures are lost.
 * Ids are minted deterministically from the mission number + capture index. The
 * returned `report` records whether a facility existed (from hasContainment at
 * intake time) so the debrief can tell "no facility" from "facility full" rather
 * than inferring it from a zero secured count.
 */
function intakeCaptives(
  campaign: CampaignState,
  captures: readonly MissionCapture[] | undefined,
  missionNumber: number,
  capturedAtHour: number,
): CaptiveIntake {
  const existing = campaign.captives ?? [];
  const hadContainment = hasContainment(campaign);
  const capacity = CONTAINMENT_CAPACITY;
  if (!captures || captures.length === 0) {
    return {
      captives: existing,
      report: { secured: [], lost: 0, hadContainment, held: existing.length, capacity },
    };
  }
  if (!hadContainment) {
    return {
      captives: existing,
      report: { secured: [], lost: captures.length, hadContainment: false, held: existing.length, capacity },
    };
  }
  const room = Math.max(0, capacity - existing.length);
  const securedCount = Math.min(room, captures.length);
  const added: CampaignCaptive[] = captures.slice(0, securedCount).map((capture, index) => ({
    id: `captive-${missionNumber}-${index + 1}`,
    templateId: capture.templateId,
    rank: capture.rank,
    capturedAtHour,
  }));
  const captivesAfter = [...existing, ...added];
  return {
    captives: captivesAfter,
    report: {
      secured: added.map((c) => ({ rank: c.rank, templateId: c.templateId })),
      lost: captures.length - securedCount,
      hadContainment: true,
      held: captivesAfter.length,
      capacity,
    },
  };
}

/** Debrief clause reporting the captive intake, appended to the mission summary. */
function captiveIntakeSummary(report: CaptiveIntakeReport): string {
  const parts: string[] = [];
  const securedCount = report.secured.length;
  if (securedCount > 0) {
    parts.push(securedCount === 1 ? " One alien was taken alive." : ` ${securedCount} aliens were taken alive.`);
  }
  if (report.lost > 0) {
    const noun = report.lost === 1 ? "captive was" : "captives were";
    parts.push(
      report.hadContainment
        ? ` ${report.lost} ${noun} lost (containment full ${report.held}/${report.capacity}).`
        : ` ${report.lost} ${noun} lost (no containment facility).`,
    );
  }
  return parts.join("");
}

export function recordMissionResult(
  campaign: CampaignState,
  result: MissionResult,
  operation: OperationPlan,
  rosterOutcomeOrCompletedAt?: MissionRosterOutcome | string,
  completedAtArg = new Date().toISOString(),
): CampaignState {
  const rosterOutcome =
    typeof rosterOutcomeOrCompletedAt === "string" ? undefined : rosterOutcomeOrCompletedAt;
  const completedAt =
    typeof rosterOutcomeOrCompletedAt === "string" ? rosterOutcomeOrCompletedAt : completedAtArg;
  const durationHours = completedOperationDuration(operation);
  const completedHour = campaign.clock.elapsedHours + durationHours;
  const completedClock = campaignClockAt(campaign.clock, completedHour, completedHour);
  const deployedSoldierIds = rosterOutcome?.deployedSoldierIds ?? [];
  const survivingSoldierIds = new Set(rosterOutcome?.survivingSoldierIds ?? []);
  const kiaSoldierIds = deployedSoldierIds.filter((id) => !survivingSoldierIds.has(id));
  const woundRecovery = woundedSoldierRecovery(
    campaign,
    deployedSoldierIds,
    survivingSoldierIds,
    rosterOutcome?.survivorHealth,
    completedHour,
  );
  const woundedSoldierIds = [...woundRecovery.keys()];
  const updatedSoldiers = updateRoster(
    campaign.soldiers,
    deployedSoldierIds,
    survivingSoldierIds,
    result,
    woundRecovery,
    campaign.seed,
    operation.missionNumber,
  );
  const terrorRescue = terrorRescueBonus(operation, result, rosterOutcome);
  // Captures are only recovered from a victory (the squad held the field).
  const captiveIntake = intakeCaptives(
    campaign,
    result === "success" ? rosterOutcome?.captures : undefined,
    operation.missionNumber,
    completedHour,
  );
  const baseSummary =
    result === "success"
      ? missionSuccessSummary(
          operation.codename,
          kiaSoldierIds.length,
          woundedSoldierIds.length,
          promotionSummary(campaign.soldiers, updatedSoldiers, deployedSoldierIds),
        )
      : missionFailureSummary(kiaSoldierIds.length, deployedSoldierIds.length - kiaSoldierIds.length);
  const report: MissionReport = {
    missionNumber: operation.missionNumber,
    missionSeed: operation.missionSeed,
    codename: operation.codename,
    result,
    region: operation.region,
    themeId: operation.themeId,
    missionType: operation.missionType,
    enemyCount: operation.enemyCount,
    durationHours,
    reward: result === "success" ? operation.reward : failureReward(),
    civilianCount: rosterOutcome?.civilianCount,
    civiliansRescued: rosterOutcome?.civiliansRescued,
    civilianCasualties: rosterOutcome?.civilianCasualties,
    deployedSoldierIds: [...deployedSoldierIds],
    kiaSoldierIds,
    woundedSoldierIds,
    completedAt,
    summary: baseSummary + captiveIntakeSummary(captiveIntake.report),
  };
  const missionsCompleted = campaign.missionsCompleted + (result === "success" ? 1 : 0);
  const baseResources = awardMissionResources(campaign.resources, report.reward);
  const resources = terrorRescue.credits > 0
    ? { ...baseResources, credits: baseResources.credits + terrorRescue.credits }
    : baseResources;
  const regionalPanic = updateRegionalPanicForMission(campaign, operation, result, rosterOutcome);
  const strategic = applyTerrorRescueBonus(
    updateStrategic(campaign, result, operation, resources, updatedSoldiers, regionalPanic),
    terrorRescue,
  );

  // Fallback endgame unlock: reaching CAMPAIGN_VICTORY_OPERATIONS reveals the HQ
  // and (via canLaunchFinalAssault) unlocks the assault — keeping a capture-free
  // campaign winnable. It does NOT set "won"; only winning the assault does.
  let nextAlienHq = campaign.alienHq;
  let projectReports = campaign.projectReports;
  if (
    strategic.status === "active" &&
    missionsCompleted >= CAMPAIGN_VICTORY_OPERATIONS &&
    (campaign.lastCouncilMonth ?? 0) >= 1 &&
    nextAlienHq &&
    !nextAlienHq.revealed
  ) {
    nextAlienHq = { ...nextAlienHq, revealed: true };
    const revealReport: ProjectReport = {
      kind: "research",
      id: "alienHqRevealed",
      title: "Alien HQ located",
      summary: `Intel from ${missionsCompleted} operations pinpoints the alien headquarters in ${nextAlienHq.location.region}. Launch the final assault.`,
      completedAtHour: completedHour,
    };
    projectReports = [revealReport, ...projectReports].slice(0, PROJECT_REPORT_LIMIT);
  }

  return completeStrategicProgress({
    ...campaign,
    clock: completedClock,
    // A final alien-base assault launches from the revealed HQ, NOT from a UFO
    // contact — completing it must not erase an unrelated live contact. Every
    // other operation consumes the contact it was launched against.
    ufoContact: operation.missionType === "alienBaseAssault" ? campaign.ufoContact : undefined,
    // The non-blocking deployment run that carried the squad here is done once the
    // mission resolves — clear it so an arrived Skyranger (and its DEPLOY chip) does
    // not linger on the globe pointing at a now-consumed contact. Interceptor patrols
    // are independent air ops and are left untouched.
    activeFlights: dropDeploymentFlights(campaign.activeFlights),
    strategic,
    regionalPanic,
    resources,
    soldiers: updatedSoldiers,
    deploymentSoldierIds: normalizeDeploymentSoldierIds(campaign.deploymentSoldierIds, updatedSoldiers),
    missionsAttempted: operation.missionNumber,
    missionsCompleted,
    lastMission: report,
    captives: captiveIntake.captives,
    // Expose the intake outcome for the debrief BEFORE completeStrategicProgress
    // may run an interrogation that consumes a just-secured captive.
    lastCaptiveIntake: captiveIntake.report,
    alienHq: nextAlienHq,
    projectReports,
  });
}

function updateRegionalPanicForMission(
  campaign: CampaignState,
  operation: OperationPlan,
  result: MissionResult,
  rosterOutcome: MissionRosterOutcome | undefined,
): Record<CouncilRegion, number> {
  const panicMult = difficultyConfig(campaign).panicMult;
  const relief = arcFailureRelief(campaign);
  const region = operation.region;
  // The final HQ assault is the retryable climax: the world already knows the base
  // is located, so a failed assault does not spike global panic (mirrors the frozen
  // doom clock in updateStrategic). Without this, repeated big-boss attempts would
  // silently panic-collapse a campaign that is otherwise winning the war.
  if (result === "failure" && operation.missionType === "alienBaseAssault") {
    return campaign.regionalPanic;
  }
  const regionalPanic =
    result === "success"
      ? adjustRegionalPanic(campaign.regionalPanic, region, -18, 0, panicMult)
      : adjustRegionalPanic(
          campaign.regionalPanic,
          region,
          Math.round(18 * relief),
          Math.round(2 * relief),
          panicMult,
        );

  if (operation.missionType === "terror") {
    const civilianCasualties = rosterOutcome?.civilianCasualties ?? 0;
    if (result === "failure" || civilianCasualties > 0) {
      // Extra panic for terror missions where civilians were lost; pre-scaled by panicMult.
      return adjustRegionalPanic(
        regionalPanic,
        region,
        Math.round(TERROR_EXTRA_PANIC_LOCAL * panicMult * (result === "failure" ? relief : 1)),
        Math.round(TERROR_EXTRA_PANIC_SPILLOVER * panicMult * (result === "failure" ? relief : 1)),
      );
    }
  }
  return regionalPanic;
}

function terrorRescueBonus(
  operation: OperationPlan,
  result: MissionResult,
  rosterOutcome: MissionRosterOutcome | undefined,
): { credits: number; funding: number; score: number } {
  if (operation.missionType !== "terror" || result !== "success") {
    return { credits: 0, funding: 0, score: 0 };
  }
  const rescued = Math.max(0, rosterOutcome?.civiliansRescued ?? 0);
  if (rescued <= 0) return { credits: 0, funding: 0, score: 0 };
  return {
    credits: rescued * TERROR_RESCUE_CREDITS_PER_CIVILIAN,
    funding: rescued * TERROR_RESCUE_FUNDING_PER_CIVILIAN,
    score: rescued * TERROR_RESCUE_SCORE_PER_CIVILIAN,
  };
}

function applyTerrorRescueBonus(
  strategic: StrategicState,
  bonus: { funding: number; score: number },
): StrategicState {
  if (bonus.funding <= 0 && bonus.score <= 0) return strategic;
  return {
    ...strategic,
    funding: strategic.funding + bonus.funding,
    score: strategic.score + bonus.score,
  };
}

function missionFailureSummary(casualties: number, survivors: number): string {
  if (survivors > 0) {
    const casualtyText =
      casualties === 0
        ? "No operatives were lost."
        : casualties === 1
          ? "One operative was lost."
          : `${casualties} operatives were lost.`;
    return `Operation aborted before recovery. ${survivors} operatives returned to base. ${casualtyText}`;
  }
  return "Strike team lost. Command staff are preparing a replacement operation.";
}

function missionSuccessSummary(codename: string, casualties: number, wounded: number, promotionText: string): string {
  const casualtyText =
    casualties === 0
      ? "No operatives lost."
      : casualties === 1
        ? "One operative was lost."
        : `${casualties} operatives were lost.`;
  const woundText =
    wounded === 0
      ? ""
      : wounded === 1
        ? " One survivor is in medical recovery."
        : ` ${wounded} survivors are in medical recovery.`;
  return `Operation ${codename} secured. Recovered material is ready for analysis. ${casualtyText}${woundText}${promotionText}`;
}

function promotionSummary(
  before: readonly CampaignSoldier[],
  after: readonly CampaignSoldier[],
  deployedSoldierIds: readonly string[],
): string {
  const deployed = new Set(deployedSoldierIds);
  const promotions = after.flatMap((soldier) => {
    if (!deployed.has(soldier.id)) return [];
    const previous = before.find((candidate) => candidate.id === soldier.id);
    if (!previous || previous.rank === soldier.rank) return [];
    return [`${soldier.name} to ${soldier.rank}`];
  });
  return promotions.length > 0 ? ` Promotions: ${promotions.join(", ")}.` : "";
}

function updateRoster(
  soldiers: readonly CampaignSoldier[],
  deployedSoldierIds: readonly string[],
  survivingSoldierIds: ReadonlySet<string>,
  result: MissionResult,
  woundRecovery: ReadonlyMap<string, number>,
  campaignSeed: number,
  missionNumber: number,
): CampaignSoldier[] {
  const deployed = new Set(deployedSoldierIds);
  return soldiers.map((soldier) => {
    if (!deployed.has(soldier.id) || soldier.status === "kia") return soldier;
    const survived = survivingSoldierIds.has(soldier.id);
    const creditedSurvival = result === "success" && survived;
    const survivedMissions = soldier.survivedMissions + (creditedSurvival ? 1 : 0);
    const woundedUntilHour = woundRecovery.get(soldier.id);
    const previousGrowth = soldier.statGrowth ?? STAT_GROWTH_ZERO;
    // Surviving a mission — even a failed one — is combat experience: the soldier
    // earns a small, deterministic stat increase. KIA soldiers do not grow.
    const statGrowth = survived
      ? addStatGrowth(previousGrowth, rollStatGrowth(campaignSeed, missionNumber, soldier.id))
      : previousGrowth;
    return {
      ...soldier,
      status: survived ? (woundedUntilHour ? "wounded" : "active") : "kia",
      missions: soldier.missions + 1,
      survivedMissions,
      rank: creditedSurvival ? soldierRank(survivedMissions) : soldier.rank,
      woundedUntilHour: survived ? woundedUntilHour : undefined,
      statGrowth,
    };
  });
}

function woundedSoldierRecovery(
  campaign: CampaignState,
  deployedSoldierIds: readonly string[],
  survivingSoldierIds: ReadonlySet<string>,
  survivorHealth: Readonly<Record<string, { hp: number; maxHp: number }>> | undefined,
  currentHour: number,
): Map<string, number> {
  const recovery = new Map<string, number>();
  for (const id of deployedSoldierIds) {
    if (!survivingSoldierIds.has(id)) continue;
    const health = survivorHealth?.[id];
    if (!health || health.maxHp <= 0 || health.hp >= health.maxHp) continue;
    const missingRatio = Math.max(0, Math.min(1, (health.maxHp - Math.max(0, health.hp)) / health.maxHp));
    const baseHours = Math.min(
      WOUND_RECOVERY_MAX_HOURS,
      Math.max(WOUND_RECOVERY_MIN_HOURS, Math.ceil(missingRatio * WOUND_RECOVERY_MAX_HOURS)),
    );
    const hours = hasBaseFacility(campaign, MEDBAY_FACILITY_ID)
      ? Math.max(WOUND_RECOVERY_MIN_HOURS, Math.ceil(baseHours * MEDBAY_WOUND_RECOVERY_MULTIPLIER))
      : baseHours;
    recovery.set(id, currentHour + hours);
  }
  return recovery;
}

function updateStrategic(
  campaign: CampaignState,
  result: MissionResult,
  operation: OperationPlan,
  resources: CampaignResources,
  soldiers: readonly CampaignSoldier[],
  regionalPanic: Record<CouncilRegion, number>,
): StrategicState {
  const strategic = campaign.strategic;
  if (strategic.status !== "active") return strategic;

  const success = result === "success";
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  // The final HQ assault is the retryable climax: once the base is located the
  // invasion can't escalate FURTHER, so a failed assault does not advance the doom
  // clock and only lightly dents funding. This keeps "retry on loss" a real option
  // (regroup and hit the HQ again) instead of a hidden death spiral, without
  // touching the pacing of the normal-mission war that precedes it.
  const failedAssault = !success && operation.missionType === "alienBaseAssault";
  // Relief (success) stays flat; only penalties are eased on easier difficulties.
  // Success relief is deliberately large so a player who wins missions outruns the
  // doom clock — that positive feedback is the intended X-COM survival loop.
  const rawThreatDelta = success ? (trackingUplink ? -28 : -25) : failedAssault ? 0 : trackingUplink ? 12 : 16;
  // ARC_FAILURE_RELIEF: CAMPAIGN_VICTORY_OPERATIONS now requires roughly double the
  // mission attempts (4 -> 8 wins), so a fixed per-failure penalty on the doom clock
  // and funding would double the cumulative punishment across a full campaign, well
  // past what the balance harness (tests/balance-sim.test.ts) tolerates. Only the
  // FAILURE-side penalty is eased — success relief is untouched, preserving "winning
  // outruns the doom clock" as the intended survival loop.
  const relief = arcFailureRelief(campaign);
  const threatDelta =
    rawThreatDelta > 0
      ? Math.round(rawThreatDelta * difficultyConfig(campaign).threatGainMult * relief)
      : rawThreatDelta;
  const threat = Math.max(0, Math.min(THREAT_LOSS_THRESHOLD, strategic.threat + threatDelta));
  const funding = Math.max(
    0,
    strategic.funding + (success ? 100 : failedAssault ? -25 : Math.round(-75 * relief)),
  );
  const score = strategic.score + (success ? 100 + operation.enemyCount * 10 : -50);
  const canFieldSquad =
    soldiers.some((soldier) => soldier.status !== "kia") ||
    resources.credits >= RECRUIT_COST;
  const panicCollapse = Math.max(...Object.values(regionalPanic)) >= PANIC_LOSS_THRESHOLD;
  // Victory is ONLY winning the alien-base assault. Reaching
  // CAMPAIGN_VICTORY_OPERATIONS no longer wins — recordMissionResult instead
  // reveals the HQ and unlocks the assault (the fallback path). A LOST assault
  // never forces "lost"; the normal loss conditions below still apply.
  const wonAssault = operation.missionType === "alienBaseAssault" && success;
  const status = wonAssault
    ? "won"
    : threat >= THREAT_LOSS_THRESHOLD || funding <= 0 || !canFieldSquad || panicCollapse
      ? "lost"
      : "active";

  return { status, threat, funding, score };
}

function failureReward(): CampaignResources {
  return { credits: 50, alloys: 0, elerium: 0, alienData: 0 };
}

function awardMissionResources(resources: CampaignResources, reward: CampaignResources): CampaignResources {
  return {
    credits: resources.credits + reward.credits,
    alloys: resources.alloys + reward.alloys,
    elerium: resources.elerium + reward.elerium,
    alienData: resources.alienData + reward.alienData,
  };
}

function canAfford(resources: CampaignResources, cost: CampaignResources): boolean {
  return (
    resources.credits >= cost.credits &&
    resources.alloys >= cost.alloys &&
    resources.elerium >= cost.elerium &&
    resources.alienData >= cost.alienData
  );
}

function spend(resources: CampaignResources, cost: CampaignResources): CampaignResources {
  return {
    credits: resources.credits - cost.credits,
    alloys: resources.alloys - cost.alloys,
    elerium: resources.elerium - cost.elerium,
    alienData: resources.alienData - cost.alienData,
  };
}

/** Ordinal of a captive rank in CAPTIVE_RANK_ORDER (soldier=0 … commander=3). */
function captiveRankIndex(rank: CaptiveRank): number {
  return CAPTIVE_RANK_ORDER.indexOf(rank);
}

/** Whether a captive satisfies a project's captive requirement (rank floor is "at least"). */
function captiveQualifies(captive: CampaignCaptive, project: ResearchProject): boolean {
  if (project.requiresCaptiveRank) {
    return captiveRankIndex(captive.rank) >= captiveRankIndex(project.requiresCaptiveRank);
  }
  return true;
}

/** True when the project has no captive requirement or a qualifying captive is held. */
function hasQualifyingCaptive(campaign: CampaignState, project: ResearchProject): boolean {
  if (!project.requiresCaptive && !project.requiresCaptiveRank) return true;
  return (campaign.captives ?? []).some((captive) => captiveQualifies(captive, project));
}

/**
 * Remove exactly one qualifying captive for a consumesCaptive project, preferring
 * the LOWEST qualifying rank (and earliest captured on a tie) so more valuable
 * captives are preserved for later interrogations.
 */
function consumeQualifyingCaptive(campaign: CampaignState, project: ResearchProject): CampaignState {
  const captives = campaign.captives ?? [];
  let chosen = -1;
  let chosenRank = Infinity;
  for (let i = 0; i < captives.length; i++) {
    const captive = captives[i]!;
    if (!captiveQualifies(captive, project)) continue;
    const rankIndex = captiveRankIndex(captive.rank);
    if (rankIndex < chosenRank) {
      chosenRank = rankIndex;
      chosen = i;
    }
  }
  if (chosen < 0) return campaign;
  return { ...campaign, captives: captives.filter((_, i) => i !== chosen) };
}

/**
 * Whether the final alien-base assault can be launched. Requires the HQ to be
 * REVEALED and the campaign to be unlocked — either by completing
 * commanderInterrogation (the research path) OR by reaching the
 * CAMPAIGN_VICTORY_OPERATIONS fallback milestone (which also reveals the HQ).
 */
export function canLaunchFinalAssault(campaign: CampaignState): boolean {
  if (campaign.strategic.status !== "active") return false;
  if (!campaign.alienHq?.revealed) return false;
  if ((campaign.lastCouncilMonth ?? 0) < 1) return false;
  return (
    campaign.completedResearch.includes("commanderInterrogation") ||
    campaign.missionsCompleted >= CAMPAIGN_VICTORY_OPERATIONS
  );
}

export function canStartResearch(campaign: CampaignState, id: ResearchId): boolean {
  const project = RESEARCH_PROJECTS.find((candidate) => candidate.id === id);
  if (!project) return false;
  return (
    campaign.strategic.status === "active" &&
    !campaign.activeResearch &&
    !campaign.completedResearch.includes(id) &&
    project.requires.every((required) => campaign.completedResearch.includes(required)) &&
    hasQualifyingCaptive(campaign, project) &&
    canAfford(campaign.resources, researchCost(campaign, id))
  );
}

export function researchTree(campaign: CampaignState): readonly ResearchTreeNode[] {
  const completed = new Set(campaign.completedResearch);
  const activeProjectId = campaign.activeResearch?.projectId;
  return RESEARCH_PROJECTS.map((project) => {
    if (completed.has(project.id)) {
      return { project, status: "completed" as const };
    }
    const prerequisitesMet = project.requires.every((required) => completed.has(required));
    const blockedByActiveResearch =
      campaign.activeResearch !== undefined && activeProjectId !== project.id;
    if (prerequisitesMet && !blockedByActiveResearch) {
      return { project, status: "available" as const };
    }
    return { project, status: "locked" as const };
  });
}

export function canCompleteResearch(campaign: CampaignState, id: ResearchId): boolean {
  return canStartResearch(campaign, id);
}

export function startResearch(campaign: CampaignState, id: ResearchId): CampaignState {
  if (!canStartResearch(campaign, id)) return campaign;
  return {
    ...campaign,
    resources: spend(campaign.resources, researchCost(campaign, id)),
    activeResearch: {
      projectId: id,
      startedAtHour: campaign.clock.elapsedHours,
      completesAtHour: campaign.clock.elapsedHours + researchDuration(campaign, id),
    },
  };
}

export function completeResearch(campaign: CampaignState, id: ResearchId): CampaignState {
  if (campaign.completedResearch.includes(id)) return campaign;
  if (campaign.activeResearch?.projectId === id) {
    return completeResearchProject({
      ...campaign,
      activeResearch: undefined,
      completedResearch: [...campaign.completedResearch, id],
    }, id);
  }
  if (!canStartResearch(campaign, id)) return campaign;
  return completeResearchProject({
    ...campaign,
    resources: spend(campaign.resources, researchCost(campaign, id)),
    completedResearch: [...campaign.completedResearch, id],
  }, id);
}

export function hasResearch(campaign: CampaignState, id: ResearchId): boolean {
  return campaign.completedResearch.includes(id);
}

export function completeFinishedResearch(campaign: CampaignState): CampaignState {
  const active = campaign.activeResearch;
  if (!active || campaign.clock.elapsedHours < active.completesAtHour) return campaign;
  if (campaign.completedResearch.includes(active.projectId)) {
    return { ...campaign, activeResearch: undefined };
  }
  return completeResearchProject({
    ...campaign,
    activeResearch: undefined,
    completedResearch: [...campaign.completedResearch, active.projectId],
  }, active.projectId);
}

export function researchDuration(campaign: CampaignState, id: ResearchId): number {
  const base = RESEARCH_PROJECTS.find((project) => project.id === id)?.durationHours ?? 24;
  return Math.max(6, base - (hasBaseFacility(campaign, "lab-2") ? 6 : 0));
}

export function researchCost(campaign: CampaignState, id: ResearchId): CampaignResources {
  const base = RESEARCH_COSTS[id];
  if (!hasBaseFacility(campaign, "lab-2")) return { ...base };
  return {
    credits: Math.max(0, base.credits - 40),
    alloys: base.alloys,
    elerium: base.elerium,
    alienData: Math.max(0, base.alienData - 1),
  };
}

function emptyWeaponCounts(): Record<CampaignWeaponId, number> {
  return { rifle: 0, pistol: 0, plasma: 0, cannon: 0 };
}

function cloneArmory(armory: CampaignArmory): CampaignArmory {
  return {
    weapons: { ...armory.weapons },
    ...(armory.items ? { items: { ...armory.items } } : {}),
  };
}

function cloneMarket(market: EquipmentMarket): EquipmentMarket {
  return {
    stock: { ...market.stock },
    restockTimerHours: { ...market.restockTimerHours },
  };
}

function isCampaignWeaponId(value: unknown): value is CampaignWeaponId {
  return value === "rifle" || value === "pistol" || value === "plasma" || value === "cannon";
}

function isResearchId(value: unknown): value is ResearchId {
  return typeof value === "string" && (RESEARCH_IDS as readonly string[]).includes(value);
}

function isManufacturingProjectId(value: unknown): value is ManufacturingProjectId {
  return typeof value === "string" && (MANUFACTURING_PROJECT_IDS as readonly string[]).includes(value);
}

function addWeapon(armory: CampaignArmory, weaponId: CampaignWeaponId, count: number): CampaignArmory {
  return {
    weapons: {
      ...armory.weapons,
      [weaponId]: Math.max(0, armory.weapons[weaponId] + Math.floor(count)),
    },
    ...(armory.items ? { items: { ...armory.items } } : {}),
  };
}

/**
 * Stock added to the armory for each item id a completed project unlocks. Items
 * are consumables (medkits, grenades, smoke), so a research dividend is a small
 * one-time resupply rather than a permanent unlock.
 */
const UNLOCK_ITEM_STOCK = 4;

function applyResearchReward(campaign: CampaignState, id: ResearchId): CampaignState {
  const project = RESEARCH_PROJECTS.find((candidate) => candidate.id === id);
  const unlocks = project?.unlocks;
  if (id !== "plasmaWeapons" && !unlocks) return campaign;

  let next = campaign;
  // plasmaWeapons still grants one prototype plasma caster to the armory (the
  // reverse-engineered unit), on top of unlocking the weapon for market purchase.
  if (id === "plasmaWeapons") {
    next = { ...next, armory: addWeapon(next.armory, "plasma", 1) };
  }
  if (unlocks?.weapons?.length) {
    next = { ...next, market: seedMarketWeapons(next, unlocks.weapons) };
  }
  if (unlocks?.items?.length) {
    next = { ...next, armory: addUnlockedItems(next.armory, unlocks.items) };
  }
  return next;
}

/**
 * Adds newly-offered weapons to market stock at full capacity. Weapons already
 * present in the market (e.g. pre-positioned council inventory) are left
 * untouched; weapons with no configured market entry are skipped.
 */
function seedMarketWeapons(
  campaign: CampaignState,
  weaponIds: readonly string[],
): EquipmentMarket {
  const market = campaign.market ?? cloneMarket(STARTING_MARKET);
  const stock = { ...market.stock };
  for (const weaponId of weaponIds) {
    const entry = weaponMarketEntry(weaponId);
    if (!entry) continue;
    const current = stock[weaponId];
    if (typeof current !== "number" || current <= 0) {
      stock[weaponId] = entry.maxStock;
    }
  }
  return { stock, restockTimerHours: { ...market.restockTimerHours } };
}

/** Grants a one-time consumable resupply for each unlocked item id. */
function addUnlockedItems(armory: CampaignArmory, itemIds: readonly string[]): CampaignArmory {
  let next = armory;
  for (const itemId of itemIds) {
    next = addItemStock(next, itemId, UNLOCK_ITEM_STOCK);
  }
  return next;
}

function completeResearchProject(campaign: CampaignState, id: ResearchId): CampaignState {
  const project = RESEARCH_PROJECTS.find((candidate) => candidate.id === id);
  if (!project) return campaign;
  let next = addProjectReport(applyResearchReward(campaign, id), researchReport(project, campaign.clock.elapsedHours));
  if (project.consumesCaptive) {
    next = consumeQualifyingCaptive(next, project);
  }
  if (project.revealsAlienHq && next.alienHq && !next.alienHq.revealed) {
    next = { ...next, alienHq: { ...next.alienHq, revealed: true } };
  }
  // unlocksFinalAssault needs no state change: canLaunchFinalAssault reads
  // completedResearch (commanderInterrogation) directly.
  return next;
}

export function loadCampaign(): CampaignState | null {
  if (typeof localStorage === "undefined") return null;
  const raw = localStorage.getItem(CAMPAIGN_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<CampaignState>;
    if (
      parsed.version !== 1 ||
      typeof parsed.id !== "string" ||
      typeof parsed.seed !== "number" ||
      typeof parsed.createdAt !== "string" ||
      typeof parsed.missionsCompleted !== "number" ||
      !parsed.base ||
      typeof parsed.base.lat !== "number" ||
      typeof parsed.base.lon !== "number" ||
      typeof parsed.base.region !== "string"
    ) {
      return null;
    }
    const resources = normalizeResources(parsed.resources);
    const soldiers = normalizeSoldiers(parsed.soldiers, parsed.seed);
    const regionalPanic = normalizeRegionalPanic(parsed.regionalPanic);
    const infiltration = normalizeInfiltration(parsed.infiltration);
    const strategic = normalizeCampaignStatus(normalizeStrategic(parsed.strategic), resources, soldiers, regionalPanic);
    const clock = normalizeClock(parsed.clock);
    const completedResearch = normalizeResearch(parsed.completedResearch);
    const armory = normalizeArmory(parsed.armory, soldiers, completedResearch);
    const interceptor = normalizeInterceptor(parsed.interceptor, clock);
    // Reconcile the contact/encounter pair on load. The interception wire schema changed
    // (abstract `range` band -> real `rangeKm`, plus new required fields), so a save
    // captured mid-engagement on a previous build normalizes to a DROPPED interception
    // while ufoContact.status stays "engaging" — a stuck contact that can neither be
    // re-engaged (startInterceptionEncounter needs "tracked") nor act, sitting inert
    // until it expires and wrongly penalizes the player. Keep the encounter only when it
    // forms a valid engaging pair; otherwise reopen the contact to "tracked" and drop the
    // orphan. (Cross-version recovery, not a hard version bump — a v2 gate would discard
    // every otherwise-good save.)
    let ufoContact = normalizeUfoContact(parsed.ufoContact, clock);
    let interception = normalizeInterception(parsed.interception, ufoContact);
    const validEngagement =
      ufoContact?.status === "engaging" &&
      interception !== undefined &&
      interception.contactId === ufoContact.id;
    if (!validEngagement) {
      if (ufoContact?.status === "engaging") ufoContact = { ...ufoContact, status: "tracked" };
      interception = undefined;
    }
    const normalized: CampaignState = {
      version: 1,
      id: parsed.id,
      seed: parsed.seed,
      createdAt: parsed.createdAt,
      base: parsed.base,
      strategic,
      regionalPanic,
      infiltration,
      clock,
      lastFundingReport: normalizeFundingReport(parsed.lastFundingReport),
      interceptor,
      fleet: normalizeFleet(parsed.fleet, interceptor, clock),
      activeFlights: normalizeActiveFlights(parsed.activeFlights),
      lastInterceptionReport: normalizeInterceptionReport(parsed.lastInterceptionReport),
      ufoContact,
      interception,
      resources,
      armory,
      market: normalizeMarket(parsed.market),
      soldierLoadouts: normalizeSoldierLoadouts(parsed.soldierLoadouts, soldiers, armory),
      deploymentSoldierIds: normalizeDeploymentSoldierIds(parsed.deploymentSoldierIds, soldiers),
      facilities: normalizeFacilities(parsed.facilities),
      soldiers,
      completedResearch,
      activeResearch: normalizeActiveResearch(parsed.activeResearch, clock, completedResearch),
      activeManufacturing: normalizeActiveManufacturing(parsed.activeManufacturing, clock),
      activeConstruction: normalizeActiveConstruction(parsed.activeConstruction, clock, parsed.facilities),
      bases: normalizeBases(parsed.bases),
      activeBaseConstruction: normalizeActiveBaseConstruction(parsed.activeBaseConstruction, clock),
      missionsCompleted: parsed.missionsCompleted,
      missionsAttempted:
        typeof parsed.missionsAttempted === "number"
          ? parsed.missionsAttempted
          : parsed.missionsCompleted,
      lastMission:
        parsed.lastMission &&
        typeof parsed.lastMission.missionNumber === "number" &&
        typeof parsed.lastMission.missionSeed === "number" &&
        (parsed.lastMission.result === "success" || parsed.lastMission.result === "failure") &&
        typeof parsed.lastMission.region === "string" &&
        typeof parsed.lastMission.completedAt === "string" &&
        typeof parsed.lastMission.summary === "string"
          ? normalizeMissionReport(parsed.lastMission)
          : undefined,
      projectReports: normalizeProjectReports(parsed.projectReports),
      captives: normalizeCaptives(parsed.captives),
      // Legacy pre-endgame saves have no alienHq. With the ops-milestone win
      // removed, such a campaign is unwinnable unless the HQ is backfilled:
      // re-seed it deterministically from the campaign seed (hidden), and mark it
      // revealed when the save already qualifies for the fallback unlock.
      alienHq: normalizeAlienHq(parsed.alienHq) ?? backfillAlienHq(parsed.seed, parsed.missionsCompleted),
      councilReports: normalizeCouncilReports(parsed.councilReports),
      lastCouncilMonth:
        typeof parsed.lastCouncilMonth === "number"
          ? Math.max(0, Math.floor(parsed.lastCouncilMonth))
          : 0,
    };
    return completeFinishedBaseConstruction(completeFinishedConstruction(completeFinishedManufacturing(recoverWoundedSoldiers(completeFinishedResearch(normalized)))));
  } catch {
    return null;
  }
}

function normalizeCampaignStatus(
  strategic: StrategicState,
  resources: CampaignResources,
  soldiers: readonly CampaignSoldier[],
  regionalPanic: Record<CouncilRegion, number>,
): StrategicState {
  if (strategic.status !== "active") return strategic;
  const canFieldSquad =
    soldiers.some((soldier) => soldier.status !== "kia") ||
    resources.credits >= RECRUIT_COST;
  const panicCollapse = Math.max(...Object.values(regionalPanic)) >= PANIC_LOSS_THRESHOLD;
  return canFieldSquad && !panicCollapse ? strategic : { ...strategic, status: "lost" };
}

function normalizeStrategic(value: unknown): StrategicState {
  if (!value || typeof value !== "object") {
    return { ...STARTING_STRATEGIC, difficulty: "veteran" };
  }
  const maybe = value as Partial<StrategicState>;
  const status =
    maybe.status === "active" || maybe.status === "won" || maybe.status === "lost"
      ? maybe.status
      : STARTING_STRATEGIC.status;
  return {
    status,
    threat: typeof maybe.threat === "number" ? Math.max(0, Math.min(THREAT_LOSS_THRESHOLD, maybe.threat)) : STARTING_STRATEGIC.threat,
    funding: typeof maybe.funding === "number" ? Math.max(0, maybe.funding) : STARTING_STRATEGIC.funding,
    score: typeof maybe.score === "number" ? maybe.score : STARTING_STRATEGIC.score,
    difficulty: normalizeDifficultyLevel(maybe.difficulty),
  };
}

function normalizeDifficultyLevel(value: unknown): DifficultyLevel {
  return value === "rookie" || value === "veteran" || value === "commander" ? value : "veteran";
}

function normalizeRegionalPanic(value: unknown): Record<CouncilRegion, number> {
  if (!value || typeof value !== "object") return { ...STARTING_REGIONAL_PANIC };
  const maybe = value as Partial<Record<CouncilRegion, unknown>>;
  const result = { ...STARTING_REGIONAL_PANIC };
  for (const region of COUNCIL_REGIONS) {
    const panic = maybe[region];
    result[region] = typeof panic === "number"
      ? Math.max(0, Math.min(PANIC_LOSS_THRESHOLD, Math.round(panic)))
      : STARTING_REGIONAL_PANIC[region];
  }
  return result;
}

/** Per-region infiltration on load: clamps each value to [0, 100], defaulting to 0. */
function normalizeInfiltration(value: unknown): Record<CouncilRegion, number> {
  if (!value || typeof value !== "object") return { ...STARTING_INFILTRATION };
  const maybe = value as Partial<Record<CouncilRegion, unknown>>;
  const result = { ...STARTING_INFILTRATION };
  for (const region of COUNCIL_REGIONS) {
    const infiltration = maybe[region];
    result[region] =
      typeof infiltration === "number" ? Math.max(0, Math.min(100, Math.round(infiltration))) : 0;
  }
  return result;
}

const COUNCIL_GRADES: readonly CouncilGrade[] = ["A", "B", "C", "D", "F"];
const COUNCIL_REPORT_HISTORY_LIMIT = 12;

function normalizeCouncilGrade(value: unknown): CouncilGrade {
  return (COUNCIL_GRADES as readonly unknown[]).includes(value) ? (value as CouncilGrade) : "C";
}

function normalizeCouncilRegionRating(value: unknown): CouncilRegionRating | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<CouncilRegionRating>;
  const region = councilRegionFor(typeof maybe.region === "string" ? maybe.region : "");
  if (
    !region ||
    typeof maybe.panic !== "number" ||
    typeof maybe.infiltration !== "number" ||
    typeof maybe.fundingDelta !== "number"
  ) {
    return undefined;
  }
  return {
    region,
    panic: Math.max(0, Math.min(100, Math.round(maybe.panic))),
    infiltration: Math.max(0, Math.min(100, Math.round(maybe.infiltration))),
    fundingDelta: Math.round(maybe.fundingDelta),
    defected: maybe.defected === true,
  };
}

function normalizeCouncilReport(value: unknown): CouncilReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<CouncilReport>;
  if (
    typeof maybe.month !== "number" ||
    typeof maybe.completedAtHour !== "number" ||
    typeof maybe.income !== "number" ||
    typeof maybe.upkeep !== "number" ||
    typeof maybe.net !== "number" ||
    typeof maybe.totalFundingDelta !== "number" ||
    typeof maybe.rating !== "number" ||
    typeof maybe.narrative !== "string" ||
    !Array.isArray(maybe.regions)
  ) {
    return undefined;
  }
  const regions = maybe.regions
    .map(normalizeCouncilRegionRating)
    .filter((rating): rating is CouncilRegionRating => rating !== undefined);
  return {
    month: Math.max(0, Math.floor(maybe.month)),
    completedAtHour: Math.max(0, Math.floor(maybe.completedAtHour)),
    regions,
    totalFundingDelta: Math.round(maybe.totalFundingDelta),
    income: Math.round(maybe.income),
    upkeep: Math.round(maybe.upkeep),
    net: Math.round(maybe.net),
    rating: Math.round(maybe.rating),
    grade: normalizeCouncilGrade(maybe.grade),
    narrative: maybe.narrative,
  };
}

/** Council debrief history on load: validates each entry's shape/clamps, capped to the history limit. */
function normalizeCouncilReports(value: unknown): CouncilReport[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(normalizeCouncilReport)
    .filter((report): report is CouncilReport => report !== undefined)
    .slice(0, COUNCIL_REPORT_HISTORY_LIMIT);
}

function normalizeClock(value: unknown): CampaignClock {
  if (!value || typeof value !== "object") return { ...STARTING_CLOCK };
  const maybe = value as Partial<CampaignClock>;
  const elapsedHours =
    typeof maybe.elapsedHours === "number" ? Math.max(0, Math.floor(maybe.elapsedHours)) : STARTING_CLOCK.elapsedHours;
  return {
    day: typeof maybe.day === "number" ? Math.max(1, Math.floor(maybe.day)) : 1 + Math.floor(elapsedHours / 24),
    hour: typeof maybe.hour === "number" ? Math.max(0, Math.min(23, Math.floor(maybe.hour))) : elapsedHours % 24,
    elapsedHours,
    lastContactHour:
      typeof maybe.lastContactHour === "number" ? Math.max(0, Math.floor(maybe.lastContactHour)) : 0,
    lastFundingHour:
      typeof maybe.lastFundingHour === "number" ? Math.max(0, Math.floor(maybe.lastFundingHour)) : 0,
  };
}

function normalizeFundingReport(value: unknown): FundingReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<FundingReport>;
  if (
    typeof maybe.reportNumber !== "number" ||
    typeof maybe.completedAtHour !== "number" ||
    typeof maybe.income !== "number" ||
    typeof maybe.upkeep !== "number" ||
    typeof maybe.net !== "number" ||
    typeof maybe.funding !== "number" ||
    typeof maybe.threat !== "number" ||
    typeof maybe.score !== "number" ||
    typeof maybe.summary !== "string"
  ) {
    return undefined;
  }
  return {
    reportNumber: Math.max(1, Math.floor(maybe.reportNumber)),
    completedAtHour: Math.max(0, Math.floor(maybe.completedAtHour)),
    income: Math.floor(maybe.income),
    upkeep: Math.max(0, Math.floor(maybe.upkeep)),
    net: Math.floor(maybe.net),
    funding: Math.max(0, Math.floor(maybe.funding)),
    threat: Math.max(0, Math.min(THREAT_LOSS_THRESHOLD, Math.floor(maybe.threat))),
    score: Math.floor(maybe.score),
    summary: maybe.summary,
  };
}

function normalizeInterceptionReport(value: unknown): InterceptionReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<InterceptionReport>;
  if (
    typeof maybe.contactId !== "string" ||
    (maybe.result !== "crashed" && maybe.result !== "escaped") ||
    typeof maybe.region !== "string" ||
    typeof maybe.strength !== "number" ||
    typeof maybe.interceptorDamage !== "number" ||
    typeof maybe.completedAtHour !== "number" ||
    typeof maybe.summary !== "string"
  ) {
    return undefined;
  }
  const outcome =
    maybe.outcome === "crashed" ||
    maybe.outcome === "vaporized" ||
    maybe.outcome === "escaped" ||
    maybe.outcome === "brokeOff"
      ? maybe.outcome
      : undefined;
  return {
    contactId: maybe.contactId,
    result: maybe.result,
    region: maybe.region,
    strength: Math.max(1, Math.floor(maybe.strength)),
    interceptorDamage: Math.max(0, Math.min(100, Math.floor(maybe.interceptorDamage))),
    completedAtHour: Math.max(0, Math.floor(maybe.completedAtHour)),
    summary: maybe.summary,
    ...(outcome ? { outcome } : {}),
    ...(typeof maybe.salvageQuality === "number" && Number.isFinite(maybe.salvageQuality)
      ? { salvageQuality: Math.max(0, Math.min(1, maybe.salvageQuality)) }
      : {}),
  };
}

function normalizeInterceptor(value: unknown, clock: CampaignClock): InterceptorState {
  if (!value || typeof value !== "object") return { ...STARTING_INTERCEPTOR };
  const maybe = value as Partial<InterceptorState>;
  const repairedAtHour =
    typeof maybe.repairedAtHour === "number" ? Math.max(0, Math.floor(maybe.repairedAtHour)) : undefined;
  const damage = typeof maybe.damage === "number" ? Math.max(0, Math.min(100, Math.floor(maybe.damage))) : 0;
  if (repairedAtHour !== undefined && repairedAtHour <= clock.elapsedHours) {
    return {
      damage: 0,
      sorties: typeof maybe.sorties === "number" ? Math.max(0, Math.floor(maybe.sorties)) : 0,
    };
  }
  return {
    damage,
    sorties: typeof maybe.sorties === "number" ? Math.max(0, Math.floor(maybe.sorties)) : 0,
    repairedAtHour,
  };
}

/** Validates a single in-flight interceptor/transport; drops anything malformed. */
function normalizeActiveFlight(value: unknown): ActiveFlight | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<ActiveFlight>;
  if (
    typeof maybe.id !== "string" ||
    typeof maybe.craftId !== "string" ||
    (maybe.kind !== "interceptor" && maybe.kind !== "transport") ||
    typeof maybe.fromLat !== "number" ||
    typeof maybe.fromLon !== "number" ||
    typeof maybe.toLat !== "number" ||
    typeof maybe.toLon !== "number" ||
    typeof maybe.progress !== "number" ||
    typeof maybe.speedDegPerHour !== "number" ||
    typeof maybe.startedAtHour !== "number"
  ) {
    return undefined;
  }
  return {
    id: maybe.id,
    craftId: maybe.craftId,
    kind: maybe.kind,
    fromLat: Math.max(-90, Math.min(90, maybe.fromLat)),
    fromLon: Math.max(-180, Math.min(180, maybe.fromLon)),
    toLat: Math.max(-90, Math.min(90, maybe.toLat)),
    toLon: Math.max(-180, Math.min(180, maybe.toLon)),
    progress: Math.max(0, Math.min(1, maybe.progress)),
    speedDegPerHour: Math.max(0, maybe.speedDegPerHour),
    startedAtHour: Math.max(0, maybe.startedAtHour),
    // Non-blocking deployment fields (additive-optional). Only reconstruct a
    // deployment run's markers — a legacy patrol has none of these and stays a patrol.
    ...(maybe.purpose === "deployment" ? { purpose: "deployment" as const } : {}),
    ...(typeof maybe.deployContactId === "string" ? { deployContactId: maybe.deployContactId } : {}),
    ...(typeof maybe.arrived === "boolean" ? { arrived: maybe.arrived } : {}),
  };
}

/**
 * Preserves in-flight interceptors/transports across save/load so an interception
 * begun before saving is still rendered (and still progressing) after reload.
 * Returns undefined for an empty/absent roster to match a fresh campaign.
 */
function normalizeActiveFlights(value: unknown): ActiveFlight[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const flights = value
    .map((item) => normalizeActiveFlight(item))
    .filter((flight): flight is ActiveFlight => flight !== undefined);
  return flights.length > 0 ? flights : undefined;
}

/**
 * Normalizes the hangar fleet on load. A valid fleet array (with at least one
 * interceptor) is kept; anything missing or malformed is rebuilt from the legacy
 * single interceptor so old saves migrate to the 3-craft complement.
 */
function normalizeFleet(value: unknown, interceptor: InterceptorState, clock: CampaignClock): Craft[] {
  if (Array.isArray(value)) {
    const crafts = value
      .map((item) => normalizeCraft(item, clock))
      .filter((craft): craft is Craft => craft !== undefined);
    if (crafts.some((craft) => craft.kind === "interceptor")) {
      return crafts;
    }
  }
  return migrateLegacyFleet(interceptor);
}

function normalizeCraft(value: unknown, clock: CampaignClock): Craft | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<Craft>;
  if (
    typeof maybe.id !== "string" ||
    typeof maybe.name !== "string" ||
    (maybe.kind !== "interceptor" && maybe.kind !== "transport")
  ) {
    return undefined;
  }
  const damage =
    typeof maybe.damage === "number" ? Math.max(0, Math.min(100, Math.floor(maybe.damage))) : 0;
  const sorties = typeof maybe.sorties === "number" ? Math.max(0, Math.floor(maybe.sorties)) : 0;
  const repairedAtHour =
    typeof maybe.repairedAtHour === "number" ? Math.max(0, Math.floor(maybe.repairedAtHour)) : undefined;
  // Fuel capacity defaults to 100; a missing fuel level is treated as a full tank.
  const maxFuel = typeof maybe.maxFuel === "number" && maybe.maxFuel > 0 ? Math.floor(maybe.maxFuel) : 100;
  const fuel =
    typeof maybe.fuel === "number" && Number.isFinite(maybe.fuel)
      ? Math.max(0, Math.min(maxFuel, maybe.fuel))
      : maxFuel;
  // Combat/pursuit stats are optional; a missing value falls back to the craft-stat
  // defaults (craftSpeedDegPerHour / craftHullPoints / craftWeaponPower) at read time,
  // so legacy craft keep working. Persist any explicit value so advanced craft survive reload.
  // LEGACY SPEED MIGRATION: a save from before the km/h retune carries a pre-scale speed
  // (old magnitudes 0.7 / 0.9 / 1.6 / 2.5, all below LEGACY_SPEED_FLOOR_DEG_PER_HOUR). Drop
  // any such value — for BOTH kinds — so the craft re-derives its kind's current default
  // (transport 24.6, interceptor 36.2) instead of crawling ~40× too slow. Any real (post-
  // retune) speed is well above the floor and is preserved verbatim.
  const rawSpeed =
    typeof maybe.speedDegPerHour === "number" && maybe.speedDegPerHour > 0 ? maybe.speedDegPerHour : undefined;
  const speedDegPerHour =
    rawSpeed !== undefined && rawSpeed < LEGACY_SPEED_FLOOR_DEG_PER_HOUR ? undefined : rawSpeed;
  const hullPoints =
    typeof maybe.hullPoints === "number" && maybe.hullPoints > 0 ? Math.floor(maybe.hullPoints) : undefined;
  const weaponPower =
    typeof maybe.weaponPower === "number" && maybe.weaponPower > 0 ? maybe.weaponPower : undefined;
  // Air-combat loadout is a new Craft field: per the loadCampaign field-list gotcha it is
  // SILENTLY DROPPED on reload unless reconstructed here. Keep only known weapon ids.
  const loadout = Array.isArray(maybe.loadout)
    ? maybe.loadout.filter((w): w is string => typeof w === "string" && airWeapon(w) !== undefined)
    : undefined;
  const combatStats = {
    ...(speedDegPerHour !== undefined ? { speedDegPerHour } : {}),
    ...(hullPoints !== undefined ? { hullPoints } : {}),
    ...(weaponPower !== undefined ? { weaponPower } : {}),
    ...(loadout && loadout.length ? { loadout } : {}),
  };
  // A repair whose scheduled time has already passed is treated as complete.
  if (repairedAtHour !== undefined && repairedAtHour <= clock.elapsedHours) {
    return { id: maybe.id, kind: maybe.kind, name: maybe.name, damage: 0, sorties, fuel, maxFuel, ...combatStats };
  }
  return {
    id: maybe.id,
    kind: maybe.kind,
    name: maybe.name,
    damage,
    sorties,
    fuel,
    maxFuel,
    ...combatStats,
    ...(repairedAtHour !== undefined ? { repairedAtHour } : {}),
  };
}

/**
 * Migration path for pre-fleet saves: the legacy single interceptor becomes int-1
 * (carrying its damage/sorties/repair), and a fresh int-2 + Skyranger are added.
 */
function migrateLegacyFleet(interceptor: InterceptorState): Craft[] {
  const int1: Craft = {
    id: "int-1",
    kind: "interceptor",
    name: "Raptor-1",
    damage: interceptor.damage,
    sorties: interceptor.sorties,
    fuel: 100,
    maxFuel: 100,
    ...(interceptor.repairedAtHour !== undefined ? { repairedAtHour: interceptor.repairedAtHour } : {}),
  };
  return [int1, { ...STARTING_FLEET[1]! }, { ...STARTING_FLEET[2]! }];
}

function normalizeUfoContact(value: unknown, clock: CampaignClock): UfoContact | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<UfoContact>;
  if (
    typeof maybe.id !== "string" ||
    typeof maybe.lat !== "number" ||
    typeof maybe.lon !== "number" ||
    typeof maybe.region !== "string" ||
    typeof maybe.detectedAtHour !== "number" ||
    typeof maybe.expiresAtHour !== "number" ||
    typeof maybe.missionSeed !== "number" ||
    typeof maybe.strength !== "number" ||
    maybe.expiresAtHour <= clock.elapsedHours
  ) {
    return undefined;
  }
  // applyInterceptionOutcome clears ufoContact on escape, so a persisted "escaped"
  // contact is stale (the UFO is gone for good) — drop it rather than revive it.
  if (maybe.status === "escaped") return undefined;
  return {
    id: maybe.id,
    status:
      maybe.status === "crashed" ||
      maybe.status === "landed" ||
      maybe.status === "engaging" ||
      maybe.status === "tracked" ||
      maybe.status === "escaped"
        ? maybe.status
        : "tracked",
    lat: Math.max(-90, Math.min(90, Math.round(maybe.lat * 10) / 10)),
    lon: Math.max(-180, Math.min(180, Math.round(maybe.lon * 10) / 10)),
    region: maybe.region,
    detectedAtHour: Math.max(0, Math.floor(maybe.detectedAtHour)),
    interceptedAtHour:
      typeof maybe.interceptedAtHour === "number" ? Math.max(0, Math.floor(maybe.interceptedAtHour)) : undefined,
    expiresAtHour: Math.max(0, Math.floor(maybe.expiresAtHour)),
    missionSeed: maybe.missionSeed >>> 0,
    strength: Math.max(1, Math.floor(maybe.strength)),
    missionType: normalizeUfoContactMissionType(maybe.missionType),
    // ufoType drives panic/infiltration multipliers (UFO_TYPE_PROFILES) and the
    // geoscape marker label; persist it so post-reload expiry uses the right profile.
    ufoType:
      maybe.ufoType === "scout" ||
      maybe.ufoType === "harvester" ||
      maybe.ufoType === "terror" ||
      maybe.ufoType === "battleship"
        ? maybe.ufoType
        : undefined,
    interceptorDamage:
      typeof maybe.interceptorDamage === "number" ? Math.max(0, Math.floor(maybe.interceptorDamage)) : undefined,
    // Tracked-UFO flight vector + ocean flag are optional; default to undefined on load.
    heading: typeof maybe.heading === "number" ? maybe.heading : undefined,
    // `speed` is a denormalized copy of the ufoType's profile cruise (UFO_TYPE_PROFILES);
    // ufoType is the source of truth. We deliberately do NOT rehydrate a persisted speed:
    // a save written under a previous speed tune would otherwise keep a stale value that
    // inverts the air war (a legacy scout classified "outrun", a battleship "advantage").
    // Consumers derive the current speed from ufoType (contactSpeedDegPerHour), so a
    // reloaded contact always cruises/classifies against the live profile.
    overOcean: typeof maybe.overOcean === "boolean" ? maybe.overOcean : undefined,
    // Crash-site salvage condition (0..1) set at shoot-down; drives crash loot + core
    // recovery. A new UfoContact field — reconstruct it or it is dropped on reload.
    salvageQuality:
      typeof maybe.salvageQuality === "number" && Number.isFinite(maybe.salvageQuality)
        ? Math.max(0, Math.min(1, maybe.salvageQuality))
        : undefined,
  };
}

function normalizeUfoContactMissionType(value: unknown): MissionType {
  return value === "crashSite" || value === "terror" || value === "landedUfo" || value === "baseDefense"
    ? value
    : "crashSite";
}

function normalizeMissionReport(report: MissionReport): MissionReport {
  return {
    missionNumber: report.missionNumber,
    missionSeed: report.missionSeed,
    codename: typeof report.codename === "string" ? report.codename : `Mission ${report.missionNumber}`,
    result: report.result,
    region: report.region,
    themeId: normalizeTheme(report.themeId),
    missionType: normalizeMissionType(report.missionType),
    enemyCount: typeof report.enemyCount === "number" ? report.enemyCount : 0,
    durationHours: typeof report.durationHours === "number" ? Math.max(0, Math.floor(report.durationHours)) : 0,
    reward: normalizeResources(report.reward),
    civilianCount: normalizeOptionalCount(report.civilianCount),
    civiliansRescued: normalizeOptionalCount(report.civiliansRescued),
    civilianCasualties: normalizeOptionalCount(report.civilianCasualties),
    deployedSoldierIds: normalizeStringList(report.deployedSoldierIds),
    kiaSoldierIds: normalizeStringList(report.kiaSoldierIds),
    woundedSoldierIds: normalizeStringList(report.woundedSoldierIds),
    completedAt: report.completedAt,
    summary: report.summary,
  };
}

function normalizeMissionType(value: unknown): MissionType | undefined {
  return value === "crashSite" || value === "terror" || value === "landedUfo" || value === "baseDefense"
    ? value
    : undefined;
}

function normalizeOptionalCount(value: unknown): number | undefined {
  return typeof value === "number" ? Math.max(0, Math.floor(value)) : undefined;
}

function normalizeProjectReports(value: unknown): ProjectReport[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): ProjectReport[] => {
    if (!item || typeof item !== "object") return [];
    const maybe = item as Partial<ProjectReport>;
    if (
      (maybe.kind !== "research" && maybe.kind !== "manufacturing" && maybe.kind !== "construction") ||
      typeof maybe.id !== "string" ||
      typeof maybe.title !== "string" ||
      typeof maybe.summary !== "string" ||
      typeof maybe.completedAtHour !== "number"
    ) {
      return [];
    }
    return [{
      kind: maybe.kind,
      id: maybe.id,
      title: maybe.title,
      summary: maybe.summary,
      completedAtHour: Math.max(0, Math.floor(maybe.completedAtHour)),
    }];
  }).slice(0, PROJECT_REPORT_LIMIT);
}

function normalizeTheme(value: unknown): OperationTheme {
  return value === "farmland" || value === "urban" || value === "desert" ||
    value === "arctic" || value === "jungle" || value === "forest" || value === "alienBase"
    ? value
    : "farmland";
}

function normalizeCaptiveRank(value: unknown): CaptiveRank | undefined {
  return (CAPTIVE_RANK_ORDER as readonly string[]).includes(value as string)
    ? (value as CaptiveRank)
    : undefined;
}

/**
 * Reconstruct the live captive list. Drops any entry with a bad shape/rank.
 * Returns undefined when absent so a fresh campaign keeps its historical shape.
 */
function normalizeCaptives(value: unknown): CampaignCaptive[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const captives: CampaignCaptive[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const maybe = entry as Partial<CampaignCaptive>;
    const rank = normalizeCaptiveRank(maybe.rank);
    if (
      typeof maybe.id !== "string" ||
      typeof maybe.templateId !== "string" ||
      rank === undefined ||
      typeof maybe.capturedAtHour !== "number"
    ) {
      continue;
    }
    captives.push({ id: maybe.id, templateId: maybe.templateId, rank, capturedAtHour: maybe.capturedAtHour });
  }
  return captives;
}

/** Reconstruct the alien HQ record. Returns undefined when absent or malformed. */
/**
 * Deterministically re-seed the alien HQ for a legacy save that predates the
 * endgame arc. Mirrors createCampaign's seeding (hidden by default) and reveals
 * it when the campaign has already reached the CAMPAIGN_VICTORY_OPERATIONS
 * fallback threshold, so an old advanced campaign stays winnable.
 */
function backfillAlienHq(seed: number, missionsCompleted: number): AlienHq {
  return {
    ...seedAlienHq(seed >>> 0),
    revealed: missionsCompleted >= CAMPAIGN_VICTORY_OPERATIONS,
  };
}

function normalizeAlienHq(value: unknown): AlienHq | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<AlienHq>;
  const loc = maybe.location;
  if (
    !loc ||
    typeof loc.lat !== "number" ||
    typeof loc.lon !== "number" ||
    typeof loc.region !== "string"
  ) {
    return undefined;
  }
  return {
    location: { lat: loc.lat, lon: loc.lon, region: loc.region },
    revealed: maybe.revealed === true,
  };
}

function normalizeResources(value: unknown): CampaignResources {
  if (!value || typeof value !== "object") return { ...STARTING_RESOURCES };
  const maybe = value as Partial<CampaignResources>;
  return {
    credits: typeof maybe.credits === "number" ? maybe.credits : STARTING_RESOURCES.credits,
    alloys: typeof maybe.alloys === "number" ? maybe.alloys : STARTING_RESOURCES.alloys,
    elerium: typeof maybe.elerium === "number" ? maybe.elerium : STARTING_RESOURCES.elerium,
    alienData: typeof maybe.alienData === "number" ? maybe.alienData : STARTING_RESOURCES.alienData,
  };
}

function normalizeMarket(value: unknown): EquipmentMarket {
  if (!value || typeof value !== "object") return cloneMarket(STARTING_MARKET);
  const maybe = value as Partial<EquipmentMarket>;
  const rawStock =
    maybe.stock && typeof maybe.stock === "object" ? (maybe.stock as Record<string, unknown>) : {};
  const rawTimers =
    maybe.restockTimerHours && typeof maybe.restockTimerHours === "object"
      ? (maybe.restockTimerHours as Record<string, unknown>)
      : {};
  const stock: Record<string, number> = {};
  const restockTimerHours: Record<string, number> = {};
  for (const id of STOCKED_WEAPON_IDS) {
    const storedStock = rawStock[id];
    stock[id] =
      typeof storedStock === "number"
        ? Math.max(0, Math.min(MARKET_CONFIG[id].maxStock, Math.floor(storedStock)))
        : MARKET_CONFIG[id].maxStock;
    const storedTimer = rawTimers[id];
    restockTimerHours[id] = typeof storedTimer === "number" ? Math.max(0, Math.floor(storedTimer)) : 0;
  }
  // Preserve any other market stock verbatim (e.g. the research-unlocked "cannon"
  // once heavyPlasma completes) so completed-research gear survives a save/load
  // cycle without being seeded onto fresh campaigns.
  const stocked = STOCKED_WEAPON_IDS as readonly string[];
  for (const [key, value] of Object.entries(rawStock)) {
    if (stocked.includes(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      stock[key] = Math.max(0, Math.floor(value));
    }
  }
  // Mirror the stock-preservation loop for restock timers: research-gated gear
  // (e.g. cannon) is excluded from STOCKED_WEAPON_IDS, so without this its
  // in-flight restock timer would reset to 0 on every save/load cycle.
  for (const [key, value] of Object.entries(rawTimers)) {
    if (stocked.includes(key)) continue;
    if (typeof value === "number" && Number.isFinite(value)) {
      restockTimerHours[key] = Math.max(0, Math.floor(value));
    }
  }
  return { stock, restockTimerHours };
}

function normalizeInterception(
  value: unknown,
  contact: UfoContact | undefined,
): InterceptionEncounter | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<InterceptionEncounter>;
  if (
    typeof maybe.contactId !== "string" ||
    typeof maybe.ufoHp !== "number" ||
    typeof maybe.ufoHpMax !== "number" ||
    typeof maybe.interceptorHp !== "number" ||
    typeof maybe.interceptorHpMax !== "number" ||
    typeof maybe.rangeKm !== "number" ||
    typeof maybe.roundsElapsed !== "number" ||
    !Array.isArray(maybe.log)
  ) {
    return undefined;
  }
  // Ammo is a weaponId -> shots map; keep only known weapon ids with a finite count.
  const ammo: Record<string, number> = {};
  if (maybe.ammo && typeof maybe.ammo === "object") {
    for (const [id, count] of Object.entries(maybe.ammo as Record<string, unknown>)) {
      if (airWeapon(id) !== undefined && typeof count === "number" && Number.isFinite(count)) {
        ammo[id] = Math.max(0, Math.floor(count));
      }
    }
  }
  const lockingWeaponId =
    typeof maybe.lockingWeaponId === "string" && airWeapon(maybe.lockingWeaponId) !== undefined
      ? maybe.lockingWeaponId
      : undefined;
  return {
    contactId: maybe.contactId,
    phase: maybe.phase === "pursuit" ? "pursuit" : "engagement",
    rangeKm: Math.max(0, maybe.rangeKm),
    closingSpeedKmH: typeof maybe.closingSpeedKmH === "number" ? maybe.closingSpeedKmH : 0,
    ufoHp: Math.max(0, Math.floor(maybe.ufoHp)),
    ufoHpMax: Math.max(1, Math.floor(maybe.ufoHpMax)),
    interceptorHp: Math.max(0, Math.floor(maybe.interceptorHp)),
    interceptorHpMax: Math.max(1, Math.floor(maybe.interceptorHpMax)),
    ammo,
    ...(lockingWeaponId ? { lockingWeaponId } : {}),
    lockBeatsLeft: typeof maybe.lockBeatsLeft === "number" ? Math.max(0, Math.floor(maybe.lockBeatsLeft)) : 0,
    overkillMargin: typeof maybe.overkillMargin === "number" ? Math.max(0, maybe.overkillMargin) : 0,
    roundsElapsed: Math.max(0, Math.floor(maybe.roundsElapsed)),
    // Derive agility from the contact's ufoType (the source of truth) rather than
    // rehydrating the persisted number — same rule as `speed` on UfoContact. A save
    // that predates/omits ufoAgility (or carries a tampered value) would otherwise
    // resolve shots against a wrong dodge chance (0.5 for every hull), diverging a
    // reloaded dogfight from the same fight in-memory. Falls back only if no contact.
    ufoAgility: contact
      ? UFO_AGILITY[contact.ufoType ?? "harvester"]
      : typeof maybe.ufoAgility === "number"
        ? maybe.ufoAgility
        : 0.5,
    log: maybe.log.filter((line): line is string => typeof line === "string"),
  };
}

function normalizeArmory(
  value: unknown,
  soldiers: readonly CampaignSoldier[],
  completedResearch: readonly ResearchId[],
): CampaignArmory {
  const defaultArmory = cloneArmory(STARTING_ARMORY);
  defaultArmory.weapons.rifle = Math.max(defaultArmory.weapons.rifle, soldiers.length);
  defaultArmory.weapons.plasma = completedResearch.includes("plasmaWeapons") ? 1 : 0;

  if (!value || typeof value !== "object") return defaultArmory;
  const maybe = value as Partial<CampaignArmory>;
  const weapons = maybe.weapons && typeof maybe.weapons === "object"
    ? (maybe.weapons as Partial<Record<CampaignWeaponId, number>>)
    : {};
  return {
    weapons: {
      rifle: Math.max(
        soldiers.length,
        typeof weapons.rifle === "number" ? Math.floor(weapons.rifle) : defaultArmory.weapons.rifle,
      ),
      pistol: Math.max(
        0,
        typeof weapons.pistol === "number" ? Math.floor(weapons.pistol) : defaultArmory.weapons.pistol,
      ),
      plasma: Math.max(
        completedResearch.includes("plasmaWeapons") ? 1 : 0,
        typeof weapons.plasma === "number" ? Math.floor(weapons.plasma) : defaultArmory.weapons.plasma,
      ),
      cannon: Math.max(
        0,
        typeof weapons.cannon === "number" ? Math.floor(weapons.cannon) : defaultArmory.weapons.cannon,
      ),
    },
    items: normalizeItemStock(maybe.items, defaultArmory.items ?? {}),
  };
}

function normalizeItemStock(value: unknown, fallback: Record<string, number>): Record<string, number> {
  const items: Record<string, number> = { ...fallback };
  if (!value || typeof value !== "object") return items;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      items[key] = Math.max(0, Math.floor(raw));
    }
  }
  return items;
}

function normalizeSoldierLoadouts(
  value: unknown,
  soldiers: readonly CampaignSoldier[],
  armory: CampaignArmory,
): Record<string, CampaignWeaponId> {
  const raw = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
  const result: Record<string, CampaignWeaponId> = {};
  const used = emptyWeaponCounts();

  for (const soldier of soldiers) {
    const rawWeapon = raw[soldier.id];
    const preferred: CampaignWeaponId = isCampaignWeaponId(rawWeapon) ? rawWeapon : "rifle";
    const weaponId =
      used[preferred] < armory.weapons[preferred] && soldier.status !== "kia"
        ? preferred
        : "rifle";
    result[soldier.id] = weaponId;
    if (soldier.status !== "kia") used[weaponId] += 1;
  }

  return result;
}

function normalizeDeploymentSoldierIds(
  value: unknown,
  soldiers: readonly CampaignSoldier[],
): string[] {
  const activeIds = new Set(soldiers.filter((soldier) => soldier.status === "active").map((soldier) => soldier.id));
  if (!Array.isArray(value)) {
    return startingDeployment(soldiers.filter((soldier) => activeIds.has(soldier.id)));
  }
  const seen = new Set<string>();
  return value.flatMap((id): string[] => {
    if (typeof id !== "string" || seen.has(id) || !activeIds.has(id) || seen.size >= DEPLOYMENT_SIZE) return [];
    seen.add(id);
    return [id];
  });
}

function normalizeSoldiers(value: unknown, seed: number): CampaignSoldier[] {
  if (!Array.isArray(value)) return startingSoldiers(seed);
  const seen = new Set<string>();
  const soldiers = value.flatMap((item, index): CampaignSoldier[] => {
    if (!item || typeof item !== "object") return [];
    const maybe = item as Partial<CampaignSoldier>;
    if (typeof maybe.id !== "string" || typeof maybe.name !== "string" || seen.has(maybe.id)) {
      return [];
    }
    seen.add(maybe.id);
    return [
      {
        id: maybe.id,
        name: maybe.name,
        status:
          maybe.status === "kia"
            ? "kia"
            : maybe.status === "wounded"
              ? "wounded"
              : "active",
        rank:
          maybe.rank === "rookie" ||
          maybe.rank === "squaddie" ||
          maybe.rank === "sergeant" ||
          maybe.rank === "captain"
            ? maybe.rank
            : soldierRank(
                typeof maybe.survivedMissions === "number"
                  ? Math.max(0, Math.floor(maybe.survivedMissions))
                  : 0,
              ),
        missions: typeof maybe.missions === "number" ? Math.max(0, Math.floor(maybe.missions)) : 0,
        survivedMissions:
          typeof maybe.survivedMissions === "number"
            ? Math.max(0, Math.floor(maybe.survivedMissions))
            : 0,
        woundedUntilHour:
          maybe.status === "wounded" && typeof maybe.woundedUntilHour === "number"
            ? Math.max(0, Math.floor(maybe.woundedUntilHour))
            : undefined,
        loadoutItems: normalizeLoadoutItems(maybe.loadoutItems),
        statGrowth: normalizeStatGrowth(maybe.statGrowth),
        bio: typeof maybe.bio === "string" && maybe.bio.length > 0 ? maybe.bio : undefined,
      },
    ];
  });
  return soldiers.length > 0 ? soldiers : startingSoldiers(seed);
}

function normalizeLoadoutItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/** Normalizes accumulated stat growth; missing or malformed values default to zeros. */
function normalizeStatGrowth(value: unknown): SoldierStatGrowth {
  if (!value || typeof value !== "object") return { ...STAT_GROWTH_ZERO };
  const maybe = value as Partial<SoldierStatGrowth>;
  const count = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
  return {
    timeUnits: count(maybe.timeUnits),
    health: count(maybe.health),
    reactions: count(maybe.reactions),
    firingAccuracy: count(maybe.firingAccuracy),
  };
}

function normalizeResearch(value: unknown): ResearchId[] {
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is ResearchId => isResearchId(id));
}

function normalizeActiveResearch(
  value: unknown,
  clock: CampaignClock,
  completedResearch: readonly ResearchId[],
): ActiveResearch | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<ActiveResearch>;
  const projectId = maybe.projectId;
  if (
    !isResearchId(projectId) ||
    completedResearch.includes(projectId) ||
    typeof maybe.startedAtHour !== "number" ||
    typeof maybe.completesAtHour !== "number"
  ) {
    return undefined;
  }
  return {
    projectId,
    startedAtHour: Math.max(0, Math.floor(maybe.startedAtHour)),
    completesAtHour: Math.max(clock.elapsedHours, Math.floor(maybe.completesAtHour)),
  };
}

function normalizeActiveManufacturing(
  value: unknown,
  clock: CampaignClock,
): ActiveManufacturing | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<ActiveManufacturing>;
  if (
    !isManufacturingProjectId(maybe.projectId) ||
    typeof maybe.startedAtHour !== "number" ||
    typeof maybe.completesAtHour !== "number"
  ) {
    return undefined;
  }
  return {
    projectId: maybe.projectId,
    startedAtHour: Math.max(0, Math.floor(maybe.startedAtHour)),
    completesAtHour: Math.max(clock.elapsedHours, Math.floor(maybe.completesAtHour)),
  };
}

function normalizeActiveConstruction(
  value: unknown,
  clock: CampaignClock,
  facilities: unknown,
): ActiveConstruction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<ActiveConstruction>;
  if (
    typeof maybe.facilityId !== "string" ||
    findBaseFacility(maybe.facilityId) === undefined ||
    normalizeFacilities(facilities).includes(maybe.facilityId) ||
    typeof maybe.startedAtHour !== "number" ||
    typeof maybe.completesAtHour !== "number"
  ) {
    return undefined;
  }
  return {
    facilityId: maybe.facilityId,
    startedAtHour: Math.max(0, Math.floor(maybe.startedAtHour)),
    completesAtHour: Math.max(clock.elapsedHours, Math.floor(maybe.completesAtHour)),
  };
}

function normalizeBases(value: unknown): BaseLocation[] {
  if (!Array.isArray(value)) return [];
  const out: BaseLocation[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const maybe = entry as Partial<BaseLocation>;
    if (
      typeof maybe.lat !== "number" ||
      typeof maybe.lon !== "number" ||
      typeof maybe.region !== "string"
    ) {
      continue;
    }
    out.push({
      lat: Math.round(maybe.lat * 10) / 10,
      lon: Math.round(maybe.lon * 10) / 10,
      region: maybe.region,
    });
    if (out.length >= MAX_EXTRA_BASES) break;
  }
  return out;
}

function normalizeActiveBaseConstruction(
  value: unknown,
  clock: CampaignClock,
): CampaignState["activeBaseConstruction"] {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as Partial<NonNullable<CampaignState["activeBaseConstruction"]>>;
  const loc = maybe.location;
  if (
    !loc ||
    typeof loc !== "object" ||
    typeof loc.lat !== "number" ||
    typeof loc.lon !== "number" ||
    typeof loc.region !== "string" ||
    typeof maybe.startedAtHour !== "number" ||
    typeof maybe.completesAtHour !== "number"
  ) {
    return undefined;
  }
  return {
    location: {
      lat: Math.round(loc.lat * 10) / 10,
      lon: Math.round(loc.lon * 10) / 10,
      region: loc.region,
    },
    startedAtHour: Math.max(0, Math.floor(maybe.startedAtHour)),
    completesAtHour: Math.max(clock.elapsedHours, Math.floor(maybe.completesAtHour)),
  };
}

function normalizeFacilities(value: unknown): string[] {
  if (!Array.isArray(value)) return starterFacilityIds();
  const stored = value.filter((item): item is string => typeof item === "string");
  return facilitiesForIds([...starterFacilityIds(), ...stored]).map((facility) => facility.id);
}

function normalizeStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function hasPowerForFacility(campaign: CampaignState, facility: BaseFacility): boolean {
  const summary = summarizeBaseFacilities(constructedFacilities(campaign));
  return summary.powerUsed + facility.powerUse <= summary.powerCapacity + facility.powerOutput;
}

export function saveCampaign(campaign: CampaignState): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(campaign));
    return true;
  } catch (err) {
    // QuotaExceededError (long campaign exceeds the ~5MB cap) or SecurityError
    // (private/incognito in some browsers) must not throw out of every screen
    // transition — flushSave()/debouncedSave() call this synchronously. Catch,
    // warn, and report failure so the caller can surface a non-blocking notice.
    console.warn("saveCampaign: failed to persist campaign", err);
    return false;
  }
}

export function clearCampaign(): boolean {
  if (typeof localStorage === "undefined") return false;
  try {
    localStorage.removeItem(CAMPAIGN_STORAGE_KEY);
    return true;
  } catch (err) {
    console.warn("clearCampaign: failed to clear campaign", err);
    return false;
  }
}
