import type {
  ActiveFlight,
  BaseLocation,
  CampaignClock,
  CampaignResources,
  CampaignState,
  CouncilGrade,
  CouncilRegion,
  CouncilRegionRating,
  CouncilReport,
  Craft,
  DifficultyLevel,
  FundingReport,
  InterceptionEncounter,
  InterceptionOutcome,
  InterceptionOutcomeKind,
  InterceptionReport,
  InterceptionResult,
  MissionType,
  ProjectReport,
  StrategicState,
  UfoContact,
  UfoType,
} from "./types";
export type { InterceptionOutcome, InterceptionOutcomeKind } from "./types";
// Per-hull agility now lives in types.ts (the dependency leaf) as the single source of
// truth shared with the save-load normalizer; re-export here to keep the frozen
// contract surface (`import { UFO_AGILITY } from ".../geoscape"`) intact.
import { UFO_AGILITY } from "./types";
export { UFO_AGILITY };
import { airWeapon, ammoFor, craftLoadout, resolveShot, type AirWeapon } from "./airWeapons";
import { summarizeBaseFacilities } from "./base";
import { isLand } from "./landMask";
import {
  activeSoldiers,
  adjustRegionalInfiltration,
  adjustRegionalPanic,
  allBases,
  campaignInfiltration,
  canRecruitSoldier,
  chooseInterceptor,
  COUNCIL_REGIONS,
  councilRegionFor,
  craftHullPoints,
  craftSpeedDegPerHour,
  craftWeaponPower,
  DEFAULT_CRAFT_HULL_POINTS,
  DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR,
  completeFinishedBaseConstruction,
  completeFinishedConstruction,
  completeFinishedResearch,
  completeFinishedManufacturing,
  constructedFacilities,
  damageCraft,
  defectedRegions,
  difficultyConfig,
  hasBaseFacility,
  highestRegionalPanic,
  livingSoldiers,
  PATROL_ID_PREFIX,
  PROJECT_REPORT_LIMIT,
  PANIC_LOSS_THRESHOLD,
  recoverWoundedSoldiers,
  readyInterceptors,
  repairFleet,
  restockMarket,
  RETURN_ID_PREFIX,
  THREAT_LOSS_THRESHOLD,
} from "./storage";

export const GEOSCAPE_SCAN_HOURS = 6;

export interface UfoTypeProfile {
  strength: number;
  speed: number; // tracked-flight speed, deg/hour
  lifetimeHours: number; // tracked/landed contact lifetime
  infiltrationMult: number;
  panicMult: number;
}

// Cruise speeds recreate the original X-COM's air-war arc: bigger hulls cruise
// FASTER, so a starting Raptor (36.2 deg/h ≈ 4,023 km/h) catches scouts/harvesters
// but is outrun by terror ships and battleships until an advanced interceptor is
// built. Speeds are authored as real-world km/h (comments) and stored as the internal
// deg/hour (≈ km/h ÷ 111.19); each preserves its historical catchability RATIO vs the
// Raptor so the classification invariants hold. Lifetimes/panic/infiltration unchanged.
//   scout      ratio .78  → 3,130 km/h ≈ 28.2 deg/h   (caught)
//   harvester  ratio .61  → 2,460 km/h ≈ 22.1 deg/h   (caught)
//   terror     ratio 1.11 → 4,470 km/h ≈ 40.2 deg/h   (outruns a Raptor)
//   battleship ratio 1.50 → 6,030 km/h ≈ 54.3 deg/h   (outruns a Raptor; Phantom catches)
export const UFO_TYPE_PROFILES: Record<UfoType, UfoTypeProfile> = {
  scout: { strength: 1, speed: 28.2, lifetimeHours: 30, infiltrationMult: 0.5, panicMult: 0.5 },
  harvester: { strength: 3, speed: 22.1, lifetimeHours: 44, infiltrationMult: 1.0, panicMult: 1.0 },
  terror: { strength: 5, speed: 40.2, lifetimeHours: 66, infiltrationMult: 1.6, panicMult: 1.6 },
  battleship: { strength: 8, speed: 54.3, lifetimeHours: 96, infiltrationMult: 2.2, panicMult: 2.2 },
};

export interface UfoTypeInfo {
  label: string;
  icon: string;
  color: number;
  threat: string;
}

export function ufoTypeInfo(ufoType?: UfoType): UfoTypeInfo {
  switch (ufoType) {
    case "scout":
      return { label: "Scout", icon: "◈", color: 0x67e8f9, threat: "Low" };
    case "harvester":
      return { label: "Harvester", icon: "◆", color: 0xfbbf24, threat: "Moderate" };
    case "terror":
      return { label: "Terror Ship", icon: "▲", color: 0xf97316, threat: "High" };
    case "battleship":
      return { label: "Battleship", icon: "⬢", color: 0xef4444, threat: "Critical" };
    default:
      return { label: "Unknown", icon: "?", color: 0x64748b, threat: "Unknown" };
  }
}

// The harvester profile is the identity/default lifetime (×1.0); legacy code that
// pinned UFO_CONTACT_LIFETIME_HOURS reads it from here so the two never drift.
export const UFO_CONTACT_LIFETIME_HOURS = UFO_TYPE_PROFILES.harvester.lifetimeHours;
export const CRASH_SITE_LIFETIME_HOURS = 48;
export const FUNDING_REPORT_INTERVAL_HOURS = 24 * 30;
export const INTERCEPTOR_REPAIR_MIN_HOURS = 6;
export const INTERCEPTOR_REPAIR_MAX_HOURS = 72;
const INTERCEPTOR_BASE_SCORE = 74;
const UFO_BASE_SCORE = 40;

// ---------------------------------------------------------------------------
// AIR-COMBAT REDESIGN — engagement geometry (real km).
// Pursuit-on-globe (km) -> ZOOM at <=100km -> cinematic dogfight (missiles/cannon).
// ---------------------------------------------------------------------------
/** THE ZOOM threshold: pursuit -> engagement transition. */
export const ENGAGEMENT_RANGE_KM = 100;
/** Floor rangeKm can close to inside the dogfight. */
export const POINT_BLANK_KM = 5;
/** km an engagement "close" (afterburner) beat cuts, when not outrun. */
export const CLOSE_STEP_KM = 18;
/** Pursuit rangeKm past which an outrun UFO breaks contact (stern-chase escape). */
export const STERN_ESCAPE_KM = 140;
/** Fixed great-circle deg -> km conversion. */
export const DEG_TO_KM = 111.19;
/** Heaviest hull an overkilling heavy missile can vaporize (scout 30 / harvester 50). */
export const VAPORIZE_HULL_CAP = 55;
/** Blow >= ufoHpMax * this on a vaporizable hull leaves no crash site. */
export const VAPORIZE_FACTOR = 1.4;
/** Below this salvage quality the elerium core is damaged/lost. */
export const CORE_RECOVER_THRESHOLD = 0.5;

// UFO_AGILITY is imported from and re-exported at the top of this module (it lives in
// types.ts now so storage.ts can derive the same value without a circular import).

/** Classification thresholds for craftSpeed / ufoSpeed. */
const SPEED_ADVANTAGE_RATIO = 1.05;
const SPEED_OUTRUN_RATIO = 0.95;
/** Salt for the deterministic mission-type roll on contact spawn. */
const MISSION_TYPE_ROLL_SALT = 0x9e3779ba;
/** Salt for the deterministic UFO-type roll on contact spawn (independent of missionType). */
const UFO_TYPE_ROLL_SALT = 0x433a5c7b;
/** Hit/damage scaling salts for interactive encounter rounds. */
const ENCOUNTER_INTERCEPTOR_SALT = 0x1b1b1b1b;
const ENCOUNTER_UFO_SALT = 0x2d2d2d2d;
/** Salt for a tracked UFO's deterministic flight heading (deg). Speed comes from the UFO-type profile. */
const UFO_HEADING_SALT = 0x5f3759df;
// --- Ship fuel --------------------------------------------------------------
/** Fuel capacity assumed when a craft has no explicit maxFuel (legacy fixtures). */
const CRAFT_MAX_FUEL_DEFAULT = 100;
/** Fuel burned per great-circle degree a craft travels in flight. */
const FUEL_BURN_PER_DEG = 0.5;
/** At or below this fraction of maxFuel an airborne craft turns back for base. */
const FUEL_RESERVE_FRACTION = 0.2;
/** Fuel added per hour to a craft sitting repaired in the hangar. */
const REFUEL_PER_HOUR = 10;
/** Fuel burned by the engaging interceptor for each Attack round of a dogfight. */
const ENCOUNTER_FUEL_PER_ATTACK = 5;

export interface InterceptionForecast {
  contactId: string;
  region: string;
  strength: number;
  interceptorScore: number;
  ufoScore: number;
  damage: number;
  succeeds: boolean;
  canLaunch: boolean;
  risk: "favorable" | "dangerous";
  summary: string;
}

const CONTACT_ZONES = [
  { region: "North America", lat: 44.6, lon: -97.3 },
  { region: "South America", lat: -14.2, lon: -52.8 },
  { region: "Europe", lat: 48.2, lon: 14.6 },
  { region: "Africa", lat: 4.8, lon: 22.1 },
  { region: "Middle East", lat: 31.4, lon: 47.6 },
  { region: "South Asia", lat: 21.6, lon: 77.4 },
  { region: "East Asia", lat: 35.9, lon: 116.3 },
  { region: "Oceania", lat: -24.8, lon: 133.7 },
] as const;

function hash(seed: number): number {
  let x = seed >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return x >>> 0;
}

/** Month-0 spawn intervals are stretched ~1.6x (≈-38% spawn rate); the multiplier
 * decays back toward baseline (1.0) by ~month 4 as the campaign escalates. */
const CONTACT_INTERVAL_EARLY_FACTOR = 1.6;
const CONTACT_INTERVAL_MONTH_STEP = 0.12;
// Floor at baseline (1.0), not below it: the ramp front-loads FEWER spawns early and
// settles back at the ORIGINAL rate by ~month 5 — it must never overshoot into a
// higher-than-baseline late-game spawn rate, which would pile threat pressure onto
// the back half of the now-longer (8-ops) victory arc.
const CONTACT_INTERVAL_FLOOR_FACTOR = 1.0;

/**
 * The stretched victory arc (CAMPAIGN_VICTORY_OPERATIONS 4->8, see storage.ts) roughly
 * doubles the number of UFO contacts a campaign must weather before it can win. Threat,
 * regional panic, and funding lost to an escaped/ignored contact never decay on their
 * own (only mission SUCCESS relieves them), so without retuning, doubling contact
 * exposure pushes most campaigns past THREAT_LOSS_THRESHOLD / PANIC_LOSS_THRESHOLD / a
 * dry funding well long before reaching 8 wins. Scale down the per-event escape/ignore
 * penalties so the total risk budget across a full 8-op arc lands back in the
 * balance-harness target band (see tests/balance-sim.test.ts). Commander's much
 * higher threatGainMult/panicMult (DIFFICULTY_CONFIGS, storage.ts) under-corrects
 * at a flat scale, so relief is difficulty-scaled (mirrors storage.ts's
 * arcFailureRelief for mission-failure penalties).
 */
export const CONTACT_PENALTY_SCALE: Record<DifficultyLevel, number> = {
  rookie: 0.3,
  veteran: 0.3,
  commander: 0.28,
};

export function contactPenaltyScale(campaign: CampaignState): number {
  return CONTACT_PENALTY_SCALE[campaign.strategic.difficulty ?? "veteran"];
}

function contactIntervalMonthFactor(elapsedHours: number): number {
  const monthIndex = Math.floor(elapsedHours / FUNDING_REPORT_INTERVAL_HOURS);
  return Math.max(
    CONTACT_INTERVAL_FLOOR_FACTOR,
    CONTACT_INTERVAL_EARLY_FACTOR - CONTACT_INTERVAL_MONTH_STEP * monthIndex,
  );
}

function contactInterval(campaign: CampaignState, elapsedHours: number): number {
  const base = hasBaseFacility(campaign, "radar-2") ? 12 : 18;
  const extra = campaign.bases?.length ?? 0;
  const raw = base - extra * 3;
  const monthFactor = contactIntervalMonthFactor(elapsedHours);
  return Math.max(6, Math.round(raw * monthFactor));
}

/** Squared great-circle-ish distance from a base to a lat/lon (lat/lon weighted by cos(lat)). */
function baseDistanceSq(a: BaseLocation, lat: number, lon: number): number {
  const dLat = a.lat - lat;
  const dLon = (a.lon - lon) * Math.cos((lat * Math.PI) / 180);
  return dLat * dLat + dLon * dLon;
}

function nearestBase(lat: number, lon: number, bases: readonly BaseLocation[]): BaseLocation {
  let best = bases[0]!;
  let bestD = baseDistanceSq(best, lat, lon);
  for (let i = 1; i < bases.length; i++) {
    const b = bases[i]!;
    const d = baseDistanceSq(b, lat, lon);
    if (d < bestD) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

function clockAt(clock: CampaignClock, elapsedHours: number): CampaignClock {
  // Fractional hours are preserved so the geoscape can tick minute-by-minute;
  // the integer hour (0-23) is floored, minutes derive from the fractional part.
  const elapsed = Math.max(0, elapsedHours);
  return {
    day: 1 + Math.floor(elapsed / 24),
    hour: Math.floor(elapsed) % 24,
    elapsedHours: elapsed,
    lastContactHour: Math.max(0, Math.floor(clock.lastContactHour)),
    lastFundingHour: Math.max(0, Math.floor(clock.lastFundingHour)),
  };
}

function offset(seed: number, magnitude: number): number {
  return ((seed % 2001) / 1000 - 1) * magnitude;
}

/** Mission type a contact seeds when assaulted (defaults to a UFO crash-site recovery). */
export function contactMissionType(contact: UfoContact | undefined): MissionType {
  return contact?.missionType ?? "crashSite";
}

/** A contact's UFO type; a missing ufoType defaults to "harvester" (the identity profile, ×1.0). */
function ufoTypeOf(contact: UfoContact): UfoType {
  return contact.ufoType ?? "harvester";
}

/**
 * Deterministic UFO type for a freshly detected contact, rolled from the SAME seed
 * createUfoContact computes (independent of missionType). This guarantees spawn
 * count/timing are untouched and the same (seed, hour) yields the same ufoType — and
 * thus the same strength — regardless of the rolled mission type. Weighted so scouts
 * are common and battleships rare.
 */
function rollUfoType(seed: number): UfoType {
  const roll = hash(seed ^ UFO_TYPE_ROLL_SALT) % 100;
  if (roll < 40) return "scout";
  if (roll < 75) return "harvester";
  if (roll < 93) return "terror";
  return "battleship";
}

/**
 * Deterministic great-circle destination for a tracked UFO's flight. Given a start
 * (lat, lon in degrees), a heading (degrees clockwise from north), and a distance
 * (degrees of arc = speed * hours), returns the new lat/lon. Pure trigonometry.
 */
export function greatCircleDestination(
  lat: number,
  lon: number,
  headingDeg: number,
  distanceDeg: number,
): { lat: number; lon: number } {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = lat * toRad;
  const lambda1 = lon * toRad;
  const theta = headingDeg * toRad;
  const delta = distanceDeg * toRad;
  const sinPhi1 = Math.sin(phi1);
  const cosPhi1 = Math.cos(phi1);
  const sinDelta = Math.sin(delta);
  const cosDelta = Math.cos(delta);
  const phi2 = Math.asin(sinPhi1 * cosDelta + cosPhi1 * sinDelta * Math.cos(theta));
  const lambda2 =
    lambda1 + Math.atan2(Math.sin(theta) * sinDelta * cosPhi1, cosDelta - sinPhi1 * Math.sin(phi2));
  return { lat: phi2 * toDeg, lon: lambda2 * toDeg };
}

/**
 * Advances a tracked UFO along its deterministic heading/speed for the elapsed
 * hours. Longitude wraps the antimeridian; latitude is clamped to the plausible
 * detection band. The strategic region stays anchored to the detection site (the
 * council region where panic is attributed); only the displayed position drifts.
 */
function moveTrackedContact(contact: UfoContact, hours: number): UfoContact {
  if (contact.status !== "tracked") return contact;
  const heading = contact.heading;
  // A heading marks a flying (crashSite) contact; ground assaults hold position and
  // carry none. Speed comes from the live ufoType profile (contactSpeedDegPerHour), so
  // a reloaded contact with no denormalized speed still drifts at the right rate.
  if (heading === undefined || hours <= 0) return contact;
  const speed = contactSpeedDegPerHour(contact);
  const next = greatCircleDestination(contact.lat, contact.lon, heading, speed * hours);
  const lon = next.lon > 180 ? next.lon - 360 : next.lon < -180 ? next.lon + 360 : next.lon;
  const lat = Math.max(-56, Math.min(68, next.lat));
  return {
    ...contact,
    lat: Math.round(lat * 10) / 10,
    lon: Math.round(lon * 10) / 10,
  };
}

export function createUfoContact(
  campaign: CampaignState,
  detectedAtHour: number,
  missionType: MissionType = "crashSite",
): UfoContact {
  const seed = hash(campaign.seed ^ (campaign.missionsAttempted * 0x9e3779b9) ^ detectedAtHour);
  const zone = CONTACT_ZONES[seed % CONTACT_ZONES.length]!;
  // A base-defense assault strikes the player's base directly, so it spawns at the
  // base's own lat/lon and is attributed to the base's region. Every other contact
  // spawns at a deterministically chosen contact zone.
  const atBase = missionType === "baseDefense";
  const zoneLat = Math.max(-56, Math.min(68, zone.lat + offset(hash(seed ^ 0xa511e9b3), 7)));
  const lonRaw = zone.lon + offset(hash(seed ^ 0x63d83595), 11);
  const zoneLon = lonRaw > 180 ? lonRaw - 360 : lonRaw < -180 ? lonRaw + 360 : lonRaw;
  const lat = atBase ? campaign.base.lat : zoneLat;
  const lon = atBase ? campaign.base.lon : zoneLon;
  const all = allBases(campaign);
  const region = atBase
    ? campaign.base.region
    : all.length > 1
      ? nearestBase(lat, lon, all).region
      : zone.region;
  // Ground assaults (landed UFO, terror, base defense) spawn already on the ground;
  // only crash-site contacts begin tracked for an air-to-air shoot-down.
  const groundAssault = missionType !== "crashSite";
  // The UFO type is rolled from the same seed (independent of missionType) and drives
  // the contact's strength, tracked-flight speed, and lifetime.
  const ufoType = rollUfoType(seed);
  const profile = UFO_TYPE_PROFILES[ufoType];
  // Tracked UFOs fly: a deterministic heading (deg) + the profile speed (deg/hour)
  // advance their lat/lon as the geoscape clock ticks. Ground-assault contacts hold position.
  const heading = rollFraction(hash(seed ^ UFO_HEADING_SALT)) * 360;
  const speed = profile.speed;
  return {
    id: `UFO-${String(campaign.missionsAttempted + 1).padStart(2, "0")}-${seed.toString(16).slice(0, 4).toUpperCase()}`,
    status: groundAssault ? "landed" : "tracked",
    missionType,
    ufoType,
    lat: Math.round(lat * 10) / 10,
    lon: Math.round(lon * 10) / 10,
    region,
    detectedAtHour,
    expiresAtHour: detectedAtHour + profile.lifetimeHours,
    missionSeed: hash(seed ^ 0x85ebca6b),
    strength: profile.strength,
    ...(groundAssault ? {} : { heading, speed }),
  };
}

export function canLaunchInterceptor(campaign: CampaignState): boolean {
  const contact = campaign.ufoContact;
  return (
    campaign.strategic.status === "active" &&
    contact?.status === "tracked" &&
    contactMissionType(contact) === "crashSite" &&
    isInterceptorReady(campaign)
  );
}

export function isInterceptorReady(campaign: CampaignState): boolean {
  return readyInterceptors(campaign).length > 0;
}

/** How a pursuing craft's cruise speed compares to a UFO's own speed. */
export type InterceptionSpeedAdvantage = "advantage" | "matched" | "outrun";

/**
 * A contact's own cruise speed (deg/hour). ufoType is the source of truth (its profile
 * cruise); an explicit per-contact `speed` override is honored for freshly created /
 * hand-built contacts, but a reloaded contact carries no speed (the load normalizer
 * drops the denormalized copy) and so always derives against the live profile.
 */
export function contactSpeedDegPerHour(contact: UfoContact): number {
  return contact.speed ?? UFO_TYPE_PROFILES[ufoTypeOf(contact)].speed;
}

/**
 * Speed matchup between the interceptor that WOULD engage `contact` (the fastest
 * ready craft) and the UFO itself:
 *  - "advantage": the craft is faster — a normal, winnable intercept;
 *  - "matched":   within ±5% — a hard, even chase;
 *  - "outrun":    the UFO is faster — a stern chase the pursuer loses unless it
 *                 forces the range closed (see executeInterceptionAction).
 * With no ready craft it previews the matchup using the starting-interceptor cruise,
 * so the UI can warn the commander before committing a launch.
 */
export function interceptionSpeedAdvantage(
  campaign: CampaignState,
  contact: UfoContact,
): InterceptionSpeedAdvantage {
  const craft = chooseInterceptor(campaign);
  const craftSpeed = craft ? craftSpeedDegPerHour(craft) : DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR;
  const ufoSpeed = contactSpeedDegPerHour(contact);
  if (ufoSpeed <= 0) return "advantage";
  const ratio = craftSpeed / ufoSpeed;
  if (ratio >= SPEED_ADVANTAGE_RATIO) return "advantage";
  if (ratio <= SPEED_OUTRUN_RATIO) return "outrun";
  return "matched";
}

/** Current damage of the interceptor that would engage the next UFO (0 if none is ready). */
function engagingDamage(campaign: CampaignState): number {
  return chooseInterceptor(campaign)?.damage ?? 0;
}

export function interceptorRepairHours(campaign: CampaignState, damage: number): number {
  const workshopBonus = hasBaseFacility(campaign, "workshop-2") ? 10 : 0;
  return Math.max(
    INTERCEPTOR_REPAIR_MIN_HOURS,
    Math.min(INTERCEPTOR_REPAIR_MAX_HOURS, Math.ceil(damage * 1.15) - workshopBonus),
  );
}

function interceptorEngagementScore(campaign: CampaignState): number {
  return (
    INTERCEPTOR_BASE_SCORE +
    (hasBaseFacility(campaign, "radar-2") ? 10 : 0) +
    (hasBaseFacility(campaign, "workshop-2") ? 8 : 0) -
    Math.floor(engagingDamage(campaign) / 2)
  );
}

function ufoEngagementScore(contact: UfoContact): number {
  return UFO_BASE_SCORE + contact.strength * 7;
}

function interceptionDamage(campaign: CampaignState, contact: UfoContact, succeeded: boolean): number {
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  const fabricationBay = hasBaseFacility(campaign, "workshop-2");
  const base = succeeded ? 11 : 24;
  const strengthScale = succeeded ? 10 : 12;
  return Math.max(
    succeeded ? 5 : 14,
    base + contact.strength * strengthScale - (trackingUplink ? 5 : 0) - (fabricationBay ? 4 : 0),
  );
}

function makeInterceptionReport(
  contact: UfoContact,
  result: InterceptionReport["result"],
  damage: number,
  completedAtHour: number,
  overOcean: boolean,
): InterceptionReport {
  return {
    contactId: contact.id,
    result,
    region: contact.region,
    strength: contact.strength,
    interceptorDamage: damage,
    completedAtHour,
    summary:
      result === "crashed"
        ? overOcean
          ? `${contact.id} shot down over the ocean and lost at sea. Interceptor took ${damage}% damage.`
          : `${contact.id} forced down over ${contact.region}. Interceptor took ${damage}% damage.`
        : `${contact.id} escaped over ${contact.region}. Interceptor took ${damage}% damage during failed pursuit.`,
  };
}

export function interceptionForecast(campaign: CampaignState): InterceptionForecast | null {
  const contact = campaign.ufoContact?.status === "tracked" ? campaign.ufoContact : undefined;
  if (!contact) return null;
  const interceptorScore = interceptorEngagementScore(campaign);
  const ufoScore = ufoEngagementScore(contact);
  // A UFO that outruns the pursuing craft cannot be forced down at any score — it
  // simply escapes. Only a matched-or-faster craft can convert a score edge into a kill.
  const outrun = interceptionSpeedAdvantage(campaign, contact) === "outrun";
  const succeeds = !outrun && interceptorScore >= ufoScore;
  const damage = interceptionDamage(campaign, contact, succeeds);
  const risk = succeeds ? "favorable" : "dangerous";
  return {
    contactId: contact.id,
    region: contact.region,
    strength: contact.strength,
    interceptorScore,
    ufoScore,
    damage,
    succeeds,
    canLaunch: canLaunchInterceptor(campaign),
    risk,
    summary: outrun
      ? `Forecast dangerous: this UFO outruns the interceptor and will escape the pursuit (est. ${damage}% damage).`
      : succeeds
        ? `Forecast favorable: forced landing likely, estimated interceptor damage ${damage}%.`
        : `Forecast dangerous: UFO may escape, estimated interceptor damage ${damage}%.`,
  };
}

/**
 * Shared outcome resolver for both the headless auto-resolve (`interceptUfo`) and the
 * terminal transitions of an interactive encounter. Applies the interceptor's final
 * damage, records the report (with the richer outcome kind + salvageQuality), and
 * mutates strategic/regional state per the outcome. Always clears any active encounter.
 *
 * Outcome mapping:
 *  - crashed:   UFO forced down -> a recoverable crash site carrying salvageQuality.
 *  - vaporized: a KILL by heavy ordnance on a small hull -> no site (contact cleared),
 *               only a small debris credit; a distinct report.
 *  - escaped:   UFO outran the pursuit or survived to break-off -> contact cleared.
 *  - brokeOff:  the interceptor was destroyed (0 HP) -> UFO gets away, contact cleared.
 */
function applyInterceptionOutcome(
  campaign: CampaignState,
  contact: UfoContact,
  outcome: InterceptionOutcome,
  finalInterceptorDamage: number,
  reportDamage: number,
): CampaignState {
  const totalDamage = Math.max(0, Math.min(100, Math.floor(finalInterceptorDamage)));
  // Route the damage onto the engaging craft (and keep the legacy interceptor field in sync).
  const chosen = chooseInterceptor(campaign);
  const afterCraft = chosen ? damageCraft(campaign, chosen.id, totalDamage) : campaign;
  const kind = outcome.kind;

  // A KILL leaving nothing to recover: the small hull was vaporized by heavy ordnance.
  if (kind === "vaporized") {
    const cfg = difficultyConfig(campaign);
    const report: InterceptionReport = {
      contactId: contact.id,
      result: "crashed",
      region: contact.region,
      strength: contact.strength,
      interceptorDamage: reportDamage,
      completedAtHour: afterCraft.clock.elapsedHours,
      summary: `${contact.id} VAPORIZED over ${contact.region} — heavy ordnance left no crash site. Only scattered debris recovered.`,
      outcome: "vaporized",
      salvageQuality: 0,
    };
    return {
      ...afterCraft,
      clock: { ...afterCraft.clock, lastContactHour: afterCraft.clock.elapsedHours },
      lastInterceptionReport: report,
      strategic: { ...afterCraft.strategic, score: afterCraft.strategic.score + 25 },
      // A confirmed kill still relieves regional panic like a shoot-down.
      regionalPanic: adjustRegionalPanic(afterCraft.regionalPanic, contact.region, -4, 0, cfg.panicMult),
      resources: { ...afterCraft.resources, credits: afterCraft.resources.credits + 30 },
      ufoContact: undefined,
      interception: undefined,
    };
  }

  // The UFO got away (outran the pursuit, or the interceptor was forced to break off).
  if (kind === "escaped" || kind === "brokeOff") {
    const overOcean = false;
    const report = makeInterceptionReport(contact, "escaped", reportDamage, afterCraft.clock.elapsedHours, overOcean);
    report.outcome = kind;
    report.salvageQuality = 0;
    const cfg = difficultyConfig(campaign);
    const relief = contactPenaltyScale(campaign);
    const regionalPanic = adjustRegionalPanic(
      afterCraft.regionalPanic,
      contact.region,
      Math.round(8 * relief),
      Math.round(1 * relief),
      cfg.panicMult,
    );
    const strategic = statusAfterStrategicChange({ ...afterCraft, regionalPanic }, {
      ...afterCraft.strategic,
      threat: Math.min(
        THREAT_LOSS_THRESHOLD,
        afterCraft.strategic.threat + Math.round(6 * cfg.threatGainMult * relief),
      ),
      funding: Math.max(0, afterCraft.strategic.funding - Math.round(15 * relief)),
      score: afterCraft.strategic.score - 20,
    });
    return {
      ...afterCraft,
      clock: { ...afterCraft.clock, lastContactHour: afterCraft.clock.elapsedHours },
      lastInterceptionReport: report,
      strategic,
      regionalPanic,
      ufoContact: undefined,
      interception: undefined,
    };
  }

  // CRASHED: a recoverable wreck. A UFO forced down over open ocean is lost at sea.
  const overOcean = !isLand(contact.lat, contact.lon);
  const report = makeInterceptionReport(contact, "crashed", reportDamage, afterCraft.clock.elapsedHours, overOcean);
  const salvageQuality = Math.max(0, Math.min(1, outcome.salvageQuality));
  report.outcome = "crashed";
  report.salvageQuality = salvageQuality;
  return {
    ...afterCraft,
    lastInterceptionReport: report,
    strategic: {
      ...afterCraft.strategic,
      score: afterCraft.strategic.score + 25,
    },
    regionalPanic: adjustRegionalPanic(afterCraft.regionalPanic, contact.region, -4, 0, difficultyConfig(campaign).panicMult),
    ufoContact: {
      ...contact,
      status: "crashed",
      interceptedAtHour: afterCraft.clock.elapsedHours,
      // Lost at sea: the wreck cannot be assaulted, so it expires immediately.
      expiresAtHour: overOcean
        ? afterCraft.clock.elapsedHours
        : afterCraft.clock.elapsedHours + CRASH_SITE_LIFETIME_HOURS,
      interceptorDamage: reportDamage,
      overOcean,
      salvageQuality,
    },
    interception: undefined,
  };
}

/**
 * Headless interception: begin the encounter and auto-resolve it to a terminal outcome
 * using the same deterministic resolver the interactive dogfight uses. Keeps its legacy
 * signature (the balance harness entry point). No-op unless a tracked crashSite contact
 * can be launched against.
 */
export function interceptUfo(campaign: CampaignState): CampaignState {
  if (!canLaunchInterceptor(campaign)) return campaign;
  const started = startInterceptionEncounter(campaign);
  if (!started.interception) return campaign;
  return autoResolveInterception(started).campaign;
}

// ---------------------------------------------------------------------------
// Air-combat action model (frozen contract). String union so the geoscape
// beat-preview + existing harness paths keep working. `fire:<weaponId>` fires a
// specific weapon; "attack" auto-fires the best in-range weapon (harness/legacy
// convenience); "keepChasing" is the pursuit-only advance.
// ---------------------------------------------------------------------------
export type InterceptionAction =
  | "keepChasing"
  | "close"
  | "attack"
  | "disengage"
  | `fire:${string}`;

/** Convenience: fire a specific weapon by id (equivalent to `fire:<id>`). */
export function fireWeapon(campaign: CampaignState, weaponId: string): CampaignState {
  return executeInterceptionAction(campaign, `fire:${weaponId}` as InterceptionAction);
}

function rollFraction(seed: number): number {
  return (hash(seed) >>> 0) / 0x100000000;
}

function encounterRoundSeed(campaign: CampaignState, contact: UfoContact, round: number): number {
  return (campaign.seed ^ (contact.missionSeed >>> 0) ^ (Math.max(0, round) * 0x9e3779b9)) >>> 0;
}

/** Deterministic per-weapon salt (FNV-1a of the id) so each weapon's shot roll is independent. */
function weaponSalt(id: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h = (h ^ id.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** The UFO returns fire only when the interceptor is inside this envelope (cannon sits inside). */
function returnEnvelopeKm(strength: number): number {
  return 12 + strength * 4;
}

/** Incoming UFO return fire; deadlier the closer the interceptor sits inside the envelope. */
function ufoReturnFireDamageKm(
  rangeKm: number,
  strength: number,
  mult: number,
  roundSeed: number,
  envelope: number,
): number {
  const closeness = Math.max(0, Math.min(1, 1 - rangeKm / Math.max(1, envelope)));
  const base = 3 + strength * 2 + closeness * 8;
  const factor = 0.6 + 0.4 * rollFraction(hash(roundSeed ^ ENCOUNTER_UFO_SALT));
  return Math.max(1, Math.round(base * factor * mult));
}

/** Air-combat weapons the engaging craft brings to the encounter. */
function engagingLoadout(campaign: CampaignState): AirWeapon[] {
  const craft = chooseInterceptor(campaign);
  return craft ? craftLoadout(craft) : [];
}

/** A named weapon from the engaging loadout (or the catalog fallback). */
function loadoutWeapon(campaign: CampaignState, id: string): AirWeapon | undefined {
  return engagingLoadout(campaign).find((w) => w.id === id) ?? airWeapon(id);
}

/** Highest-damage carried weapon that is in range at the current gap and still has ammo. */
function bestInRangeWeapon(
  campaign: CampaignState,
  encounter: InterceptionEncounter,
): AirWeapon | undefined {
  let best: AirWeapon | undefined;
  for (const w of engagingLoadout(campaign)) {
    if (w.rangeKm < encounter.rangeKm) continue;
    if ((encounter.ammo[w.id] ?? 0) <= 0) continue;
    if (!best || w.damage > best.damage) best = w;
  }
  return best;
}

/** Total shots left across every carried weapon this encounter (0 = Winchester). */
function remainingAmmo(encounter: InterceptionEncounter): number {
  return Object.values(encounter.ammo).reduce((sum, n) => sum + Math.max(0, n), 0);
}

/** Real great-circle km gap between the engaging craft's current flight position and the UFO. */
export function interceptionRangeKm(campaign: CampaignState): number {
  const contact = campaign.ufoContact;
  if (!contact) return 0;
  const craft = chooseInterceptor(campaign);
  let lat = campaign.base.lat;
  let lon = campaign.base.lon;
  if (craft) {
    const flight = (campaign.activeFlights ?? []).find(
      (f) => f.craftId === craft.id && f.id.startsWith(PATROL_ID_PREFIX) && f.id.endsWith(`:${contact.id}`),
    );
    if (flight) {
      const pos = activeFlightPosition(flight);
      lat = pos.lat;
      lon = pos.lon;
    }
  }
  return greatCircleDistanceDeg(lat, lon, contact.lat, contact.lon) * DEG_TO_KM;
}

/** craftSpeedKmH - ufoSpeedKmH; <=0 means a stern chase the pursuer loses. */
function closingSpeedKmHFor(campaign: CampaignState, contact: UfoContact): number {
  const craft = chooseInterceptor(campaign);
  const craftSpeed = craft ? craftSpeedDegPerHour(craft) : DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR;
  const ufoSpeed = contactSpeedDegPerHour(contact);
  return (craftSpeed - ufoSpeed) * DEG_TO_KM;
}

function encounterUfoHpMax(contact: UfoContact): number {
  return 20 + contact.strength * 10;
}

/** Air-combat hull points of the craft that would engage (advanced craft are tougher). */
function engagingHullPoints(campaign: CampaignState): number {
  const craft = chooseInterceptor(campaign);
  return craft ? craftHullPoints(craft) : DEFAULT_CRAFT_HULL_POINTS;
}

/** Outgoing air-combat damage multiplier of the craft that would engage. */
function engagingWeaponPower(campaign: CampaignState): number {
  const craft = chooseInterceptor(campaign);
  return craft ? craftWeaponPower(craft) : 1;
}

/** Current encounter HP of the engaging craft, scaled from its hull and accumulated damage. */
function encounterInterceptorHp(campaign: CampaignState): number {
  return Math.max(1, Math.round(engagingHullPoints(campaign) * (1 - engagingDamage(campaign) / 100)));
}

/** An interactive, choice-based interception encounter is currently in progress. */
export function canResolveInterception(campaign: CampaignState): boolean {
  return campaign.interception !== undefined && campaign.ufoContact?.status === "engaging";
}

/**
 * Begins an interception against a tracked crash-site contact. Starts as a PURSUIT at
 * the real km gap (interceptionRangeKm); if the interceptor is already within
 * ENGAGEMENT_RANGE_KM it drops straight into the dogfight. UFO HP scales from strength,
 * interceptor HP from its current condition, ammo is seeded from the craft's loadout.
 * No-op unless the contact is a tracked crashSite and the interceptor is ready.
 */
export function startInterceptionEncounter(campaign: CampaignState): CampaignState {
  const contact = campaign.ufoContact;
  if (!contact || contact.status !== "tracked") return campaign;
  if (contactMissionType(contact) !== "crashSite") return campaign;
  if (!isInterceptorReady(campaign)) return campaign;
  const ufoHpMax = encounterUfoHpMax(contact);
  const interceptorHp = encounterInterceptorHp(campaign);
  const rawRangeKm = Math.max(POINT_BLANK_KM, interceptionRangeKm(campaign));
  const phase: InterceptionEncounter["phase"] = rawRangeKm <= ENGAGEMENT_RANGE_KM ? "engagement" : "pursuit";
  const encounter: InterceptionEncounter = {
    contactId: contact.id,
    phase,
    rangeKm: phase === "engagement" ? Math.min(rawRangeKm, ENGAGEMENT_RANGE_KM) : rawRangeKm,
    closingSpeedKmH: closingSpeedKmHFor(campaign, contact),
    ufoHp: ufoHpMax,
    ufoHpMax,
    interceptorHp,
    interceptorHpMax: engagingHullPoints(campaign),
    ammo: ammoFor(engagingLoadout(campaign)),
    lockBeatsLeft: 0,
    overkillMargin: 0,
    roundsElapsed: 0,
    ufoAgility: UFO_AGILITY[ufoTypeOf(contact)],
    log: ["Interception engaged"],
  };
  return {
    ...campaign,
    ufoContact: { ...contact, status: "engaging" },
    interception: encounter,
  };
}

/** Percentage (0..100) hull damage the engaging craft has taken this encounter. */
function encounterDamagePercent(interceptorHp: number, hull: number): number {
  return Math.max(0, Math.min(100, Math.round((1 - interceptorHp / Math.max(1, hull)) * 100)));
}

/** Killing-blow classification: heavy overkill on a small hull VAPORIZES; else CRASHED. */
function classifyKillingBlow(
  weapon: AirWeapon,
  blowDmg: number,
  hpBefore: number,
  ufoHpMax: number,
): { kind: "crashed" | "vaporized"; overkillMargin: number; salvageQuality: number } {
  const overkillMargin = Math.max(0, (blowDmg - hpBefore) / Math.max(1, ufoHpMax));
  if (weapon.canVaporize && ufoHpMax <= VAPORIZE_HULL_CAP && blowDmg >= ufoHpMax * VAPORIZE_FACTOR) {
    return { kind: "vaporized", overkillMargin, salvageQuality: 0 };
  }
  return { kind: "crashed", overkillMargin, salvageQuality: Math.max(0.2, Math.min(1, 1 - overkillMargin)) };
}

/**
 * Terminal interceptor damage for a resolved encounter: the actual hull lost this
 * fight, floored at a deterministic baseline so a clean long-range kill still costs the
 * interceptor a real (repair-scheduling) dent. Returns { finalDamage (absolute), reportDamage (new) }.
 */
function resolveInterceptorDamage(
  campaign: CampaignState,
  contact: UfoContact,
  interceptorHp: number,
  hull: number,
  crashed: boolean,
): { finalDamage: number; reportDamage: number } {
  const beforeDmg = engagingDamage(campaign);
  const absolute = encounterDamagePercent(interceptorHp, hull);
  const baseline = interceptionDamage(campaign, contact, crashed);
  const finalDamage = Math.min(100, Math.max(absolute, beforeDmg + baseline));
  return { finalDamage, reportDamage: Math.max(0, finalDamage - beforeDmg) };
}

/** A UFO that outran the pursuit (or a matched chase lost). Contact escapes. */
function resolveEscape(campaign: CampaignState, contact: UfoContact, encounter: InterceptionEncounter): CampaignState {
  const dmg = resolveInterceptorDamage(campaign, contact, encounter.interceptorHp, encounter.interceptorHpMax, false);
  return applyInterceptionOutcome(campaign, contact, { kind: "escaped", salvageQuality: 0 }, dmg.finalDamage, dmg.reportDamage);
}

/**
 * Advances one PURSUIT beat: the real km gap closes at the closing speed (or OPENS
 * against a faster UFO). Crossing <=ENGAGEMENT_RANGE_KM is THE ZOOM (phase -> engagement);
 * an outrun UFO that opens past STERN_ESCAPE_KM breaks contact. Fire/attack beats burn a
 * fuel pass (an afterburner ranging run); keepChasing/close are free.
 */
function executePursuitBeat(
  campaign: CampaignState,
  encounter: InterceptionEncounter,
  contact: UfoContact,
  action: InterceptionAction,
): CampaignState {
  const round = encounter.roundsElapsed;
  const closing = encounter.closingSpeedKmH;
  const outrun = closing <= 0;
  const burns = action === "attack" || (typeof action === "string" && action.startsWith("fire:"));
  // Bingo fuel on a fuel-burning beat: the interceptor must RTB — the UFO slips away.
  if (burns && bingoFuel(campaign)) return resolveEscape(campaign, contact, encounter);
  const afterFuel = burns ? burnEngagingFuel(campaign) : campaign;

  if (outrun) {
    const rangeKm = encounter.rangeKm + Math.abs(closing);
    if (rangeKm >= STERN_ESCAPE_KM) {
      return resolveEscape(afterFuel, contact, encounter);
    }
    return {
      ...afterFuel,
      interception: {
        ...encounter,
        rangeKm,
        roundsElapsed: round + 1,
        log: [...encounter.log, `Pursuit: ${contact.id} pulls away — range opens to ${Math.round(rangeKm)} km.`],
      },
    };
  }

  const rangeKm = encounter.rangeKm - closing;
  if (rangeKm <= ENGAGEMENT_RANGE_KM) {
    return {
      ...afterFuel,
      interception: {
        ...encounter,
        phase: "engagement",
        rangeKm: ENGAGEMENT_RANGE_KM,
        roundsElapsed: round + 1,
        log: [...encounter.log, `THE ZOOM — closed to engagement range (${ENGAGEMENT_RANGE_KM} km).`],
      },
    };
  }
  return {
    ...afterFuel,
    interception: {
      ...encounter,
      rangeKm,
      roundsElapsed: round + 1,
      log: [...encounter.log, `Pursuit: closing — range ${Math.round(rangeKm)} km.`],
    },
  };
}

/** Advances one ENGAGEMENT (dogfight) beat: close the gap, or fire a weapon. */
function executeEngagementBeat(
  campaign: CampaignState,
  encounter: InterceptionEncounter,
  contact: UfoContact,
  action: InterceptionAction,
): CampaignState {
  const round = encounter.roundsElapsed;
  const outrun = encounter.closingSpeedKmH <= 0;

  const explicitId =
    typeof action === "string" && action.startsWith("fire:") ? action.slice(5) : undefined;
  const weapon = explicitId ? loadoutWeapon(campaign, explicitId) : bestInRangeWeapon(campaign, encounter);
  const canFire =
    !!weapon && weapon.rangeKm >= encounter.rangeKm && (encounter.ammo[weapon.id] ?? 0) > 0;

  // A plain "close", or an auto "attack" with nothing in range: afterburner nudge (free).
  // An explicit out-of-range/empty fire is a no-op (the button is disabled in the view).
  if (action === "close" || action === "keepChasing" || (action === "attack" && !canFire)) {
    return closeEngagementGap(campaign, encounter, contact, outrun, round);
  }
  if (explicitId && !canFire) {
    return campaign;
  }

  // FIRE. `weapon` is fireable at this range with ammo.
  const w = weapon!;
  // A fire/lock beat burns fuel; bingo fuel forces the interceptor to break off before
  // the shot leaves — the UFO escapes. Restores fuel as a real terminal (see bingoFuel).
  if (bingoFuel(campaign)) return resolveEscape(campaign, contact, encounter);
  const mult = difficultyConfig(campaign).interceptionDamageMult;
  const roundSeed = encounterRoundSeed(campaign, contact, round);

  // Heavy ordnance must burn its lock beats before the shot leaves the rail.
  if (w.lockBeats > 0) {
    const currentLeft = encounter.lockingWeaponId === w.id ? encounter.lockBeatsLeft : w.lockBeats;
    const nextLeft = currentLeft - 1;
    if (nextLeft > 0) {
      const afterFuel = burnEngagingFuel(campaign);
      return {
        ...afterFuel,
        interception: {
          ...encounter,
          lockingWeaponId: w.id,
          lockBeatsLeft: nextLeft,
          roundsElapsed: round + 1,
          log: [...encounter.log, `Acquiring lock on ${contact.id} — ${nextLeft} beat${nextLeft === 1 ? "" : "s"} to launch.`],
        },
      };
    }
  }

  const roll = rollFraction(roundSeed ^ weaponSalt(w.id));
  const shot = resolveShot(w, encounter.rangeKm, encounter.ufoAgility, roll, engagingWeaponPower(campaign), mult);
  const ammo = { ...encounter.ammo, [w.id]: Math.max(0, (encounter.ammo[w.id] ?? 0) - 1) };
  const hpBefore = encounter.ufoHp;
  const ufoHp = shot.hit ? Math.max(0, hpBefore - shot.damage) : hpBefore;

  // UFO return fire only when the interceptor is inside its envelope.
  const envelope = returnEnvelopeKm(contact.strength);
  const ufoDmg = encounter.rangeKm <= envelope ? ufoReturnFireDamageKm(encounter.rangeKm, contact.strength, mult, roundSeed, envelope) : 0;
  const interceptorHp = Math.max(0, encounter.interceptorHp - ufoDmg);
  const hull = encounter.interceptorHpMax;
  const afterFuel = burnEngagingFuel(campaign);
  const log = [
    ...encounter.log,
    shot.hit
      ? `${w.name} hits ${contact.id} for ${Math.round(shot.damage)}${ufoDmg > 0 ? `; ${contact.id} returns ${ufoDmg}` : ""}.`
      : `${contact.id} jinks — ${w.name} misses${ufoDmg > 0 ? `; ${contact.id} returns ${ufoDmg}` : ""}.`,
  ];

  // Terminal: UFO destroyed.
  if (ufoHp <= 0) {
    const cls = classifyKillingBlow(w, shot.damage, hpBefore, encounter.ufoHpMax);
    const dmg = resolveInterceptorDamage(afterFuel, contact, interceptorHp, hull, cls.kind === "crashed");
    return applyInterceptionOutcome(
      afterFuel,
      contact,
      { kind: cls.kind, salvageQuality: cls.salvageQuality },
      dmg.finalDamage,
      dmg.reportDamage,
    );
  }
  // Terminal: interceptor destroyed -> forced to break off, UFO escapes.
  if (interceptorHp <= 0) {
    const beforeDmg = engagingDamage(afterFuel);
    return applyInterceptionOutcome(afterFuel, contact, { kind: "brokeOff", salvageQuality: 0 }, 100, Math.max(0, 100 - beforeDmg));
  }

  return {
    ...afterFuel,
    interception: {
      ...encounter,
      ufoHp,
      interceptorHp,
      ammo,
      lockingWeaponId: undefined,
      lockBeatsLeft: 0,
      roundsElapsed: round + 1,
      log,
    },
  };
}

/** Afterburner close inside the dogfight: cut CLOSE_STEP_KM, or open it against a faster UFO. */
function closeEngagementGap(
  campaign: CampaignState,
  encounter: InterceptionEncounter,
  contact: UfoContact,
  outrun: boolean,
  round: number,
): CampaignState {
  if (outrun) {
    const rangeKm = encounter.rangeKm + CLOSE_STEP_KM;
    if (rangeKm >= STERN_ESCAPE_KM) {
      return resolveEscape(campaign, contact, encounter);
    }
    return {
      ...campaign,
      interception: {
        ...encounter,
        rangeKm,
        roundsElapsed: round + 1,
        log: [...encounter.log, `${contact.id} pulls away — range opens to ${Math.round(rangeKm)} km.`],
      },
    };
  }
  const rangeKm = Math.max(POINT_BLANK_KM, encounter.rangeKm - CLOSE_STEP_KM);
  return {
    ...campaign,
    interception: {
      ...encounter,
      rangeKm,
      roundsElapsed: round + 1,
      log: [...encounter.log, `Closing to ${Math.round(rangeKm)} km.`],
    },
  };
}

/**
 * Single pure entry point for an interception beat. Branches by encounter.phase:
 * pursuit (keep chasing / disengage) or engagement (fire / close / disengage).
 * "disengage" breaks off cleanly (UFO back to tracked, no strategic change).
 * Terminal outcomes reuse the shared resolver. No-op without an active engaging encounter.
 */
export function executeInterceptionAction(
  campaign: CampaignState,
  action: InterceptionAction,
): CampaignState {
  const encounter = campaign.interception;
  const contact = campaign.ufoContact;
  if (!encounter || !contact || contact.status !== "engaging") return campaign;

  if (action === "disengage") {
    return {
      ...campaign,
      ufoContact: { ...contact, status: "tracked" },
      interception: undefined,
    };
  }

  if (encounter.phase === "pursuit") {
    return executePursuitBeat(campaign, encounter, contact, action);
  }
  return executeEngagementBeat(campaign, encounter, contact, action);
}

/**
 * Headless drive of an in-progress encounter to a terminal outcome: keep chasing in
 * pursuit; in engagement fire the best in-range weapon, close when nothing is in range,
 * and (when outrun) open the gap into a stern-chase escape. Exposed for tests + the
 * balance harness. Deterministic.
 */
export function autoResolveInterception(campaign: CampaignState): {
  campaign: CampaignState;
  outcome: InterceptionOutcome;
} {
  let state = campaign;
  let guard = 0;
  while (state.interception && state.ufoContact?.status === "engaging" && guard < 5000) {
    const enc = state.interception;
    let action: InterceptionAction;
    if (enc.phase === "pursuit") {
      action = "keepChasing";
    } else if (enc.closingSpeedKmH <= 0) {
      action = "close";
    } else {
      const w = bestInRangeWeapon(state, enc);
      if (w) {
        action = `fire:${w.id}` as InterceptionAction;
      } else if (remainingAmmo(enc) > 0) {
        // Ammo left but out of range — close the gap into weapon reach.
        action = "close";
      } else {
        // Winchester (out of ammo) with the UFO still alive: the interceptor cannot
        // finish the kill and breaks off — the UFO escapes. Without this terminal the
        // loop would close-to-point-blank forever, exit on the guard, and derive the
        // outcome from a STALE prior report (a zombie "engaging" contact).
        state = resolveEscape(state, state.ufoContact!, enc);
        break;
      }
    }
    const next = executeInterceptionAction(state, action);
    if (next === state) {
      // Defensive: an action that made no progress would otherwise spin the guard —
      // force a clean break-off so the harness never returns a live encounter.
      state = resolveEscape(state, state.ufoContact!, enc);
      break;
    }
    state = next;
    guard += 1;
  }
  // Defensive net: if the guard tripped with the encounter still live, resolve it as an
  // escape so we NEVER attribute a stale, previously-persisted report to this fight.
  if (state.interception && state.ufoContact?.status === "engaging") {
    state = resolveEscape(state, state.ufoContact, state.interception);
  }
  const rep = state.lastInterceptionReport;
  return {
    campaign: state,
    outcome: {
      kind: rep?.outcome ?? "escaped",
      salvageQuality: rep?.salvageQuality ?? 0,
    },
  };
}

function repairInterceptor(campaign: CampaignState): CampaignState {
  return repairFleet(campaign);
}

function statusAfterStrategicChange(campaign: CampaignState, strategic: StrategicState): StrategicState {
  if (strategic.status !== "active") return strategic;
  const canFieldSquad = livingSoldiers(campaign).length > 0 || canRecruitSoldier(campaign);
  const panicCollapse = highestRegionalPanic(campaign).panic >= PANIC_LOSS_THRESHOLD;
  return {
    ...strategic,
    status: strategic.threat >= THREAT_LOSS_THRESHOLD || strategic.funding <= 0 || !canFieldSquad || panicCollapse ? "lost" : "active",
  };
}

function penalizeIgnoredContact(campaign: CampaignState, strategic: StrategicState): CampaignState {
  const cfg = difficultyConfig(campaign);
  const relief = contactPenaltyScale(campaign);
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  // panicMult was previously omitted (hardcoded to 1), so ignored contacts hammered
  // panic at full strength regardless of difficulty. Pass the difficulty scaler now.
  // Spillover is intentionally small: it applies to EVERY council region, so even a
  // low per-region value universalizes panic inflation over a long campaign.
  const regionalPanic = adjustRegionalPanic(
    campaign.regionalPanic,
    campaign.ufoContact?.region ?? campaign.base.region,
    Math.round((trackingUplink ? 12 : 18) * relief),
    Math.round((trackingUplink ? 0 : 1) * relief),
    cfg.panicMult,
  );
  const threatGain = Math.round((trackingUplink ? 4 : 6) * cfg.threatGainMult * relief);
  const next = {
    ...strategic,
    threat: Math.min(THREAT_LOSS_THRESHOLD, strategic.threat + threatGain),
    funding: Math.max(0, strategic.funding - Math.round((trackingUplink ? 10 : 15) * relief)),
    score: strategic.score - 25,
  };
  const updated = { ...campaign, regionalPanic };
  return {
    ...updated,
    strategic: statusAfterStrategicChange(updated, next),
  };
}

/**
 * Extra regional panic an un-addressed UFO's mission heaps on top of the baseline
 * ignore penalty. The mission type sets the base (terror/base/landed assaults are
 * severe; a crashSite recon adds none); the UFO type's panicMult then scales it. A
 * missing ufoType defaults to harvester (×1.0), so legacy contacts behave as before.
 */
function contactTerrorBonus(contact: UfoContact): { local: number; spillover: number } {
  let missionBonus: { local: number; spillover: number };
  switch (contactMissionType(contact)) {
    case "terror":
      missionBonus = { local: 18, spillover: 5 };
      break;
    case "baseDefense":
      missionBonus = { local: 16, spillover: 4 };
      break;
    case "landedUfo":
      missionBonus = { local: 12, spillover: 3 };
      break;
    case "crashSite":
    default:
      missionBonus = { local: 0, spillover: 0 };
      break;
  }
  const panicMult = UFO_TYPE_PROFILES[ufoTypeOf(contact)].panicMult;
  return { local: missionBonus.local * panicMult, spillover: missionBonus.spillover * panicMult };
}

function contactTerrorHeadline(missionType: MissionType): string {
  switch (missionType) {
    case "terror":
      return "Alien terror strike";
    case "baseDefense":
      return "Alien assault unchecked";
    case "landedUfo":
      return "Landed UFO departed";
    case "crashSite":
    default:
      return "Alien recon unchecked";
  }
}

/**
 * Infiltration deepened by an un-addressed UFO. The mission type sets the base (terror
 * and landed assaults advance a region toward defection fastest; a crash-site recon is
 * the slower baseline); the UFO type's infiltrationMult then scales it. Scaled by the
 * difficulty panicMult at apply time so harder campaigns infiltrate faster. A missing
 * ufoType defaults to harvester (×1.0).
 */
function contactInfiltrationGain(contact: UfoContact): number {
  let missionBase: number;
  switch (contactMissionType(contact)) {
    case "terror":
      missionBase = 30;
      break;
    case "baseDefense":
      missionBase = 25;
      break;
    case "landedUfo":
      missionBase = 20;
      break;
    case "crashSite":
    default:
      missionBase = 10;
      break;
  }
  return missionBase * UFO_TYPE_PROFILES[ufoTypeOf(contact)].infiltrationMult;
}

/** Per-nation share of council funding, withdrawn for good when that nation defects. */
function regionalFundingShare(campaign: CampaignState): number {
  return Math.round(difficultyConfig(campaign).startingFunding / COUNCIL_REGIONS.length);
}

/**
 * If the region's infiltration has just crossed 100, the nation signs a pact with
 * the aliens: its council funding share is permanently withdrawn and a pact report
 * is logged. Crossing-detection (before < 100, after >= 100) makes the cut
 * exactly-once — a region pinned at 100 never re-defects, so the funding hit and
 * report fire only the first time it maxes out.
 */
function applyDefection(
  campaign: CampaignState,
  region: string,
  before: Record<CouncilRegion, number>,
  after: Record<CouncilRegion, number>,
): CampaignState {
  const councilRegion = councilRegionFor(region);
  if (!councilRegion) return campaign;
  if ((before[councilRegion] ?? 0) >= 100 || (after[councilRegion] ?? 0) < 100) return campaign;
  const share = regionalFundingShare(campaign);
  const report: ProjectReport = {
    kind: "construction",
    id: `defection-${councilRegion}-${campaign.clock.elapsedHours}`,
    title: `${councilRegion} defects`,
    summary: `${councilRegion} has signed a pact with the aliens. Council funding reduced by ${share}c permanently.`,
    completedAtHour: campaign.clock.elapsedHours,
  };
  return {
    ...campaign,
    strategic: { ...campaign.strategic, funding: Math.max(0, campaign.strategic.funding - share) },
    projectReports: [report, ...campaign.projectReports].slice(0, PROJECT_REPORT_LIMIT),
  };
}

/**
 * Resolves the consequence of a UFO contact that expired while still an active threat
 * (tracked or landed — never shot down). Its mission is carried out: regional panic rises
 * by the baseline ignore penalty plus a mission-type bonus (difficulty-scaled), alien
 * infiltration of the region deepens (scaled by mission type), and a project report is
 * logged. Only the incremental bonus panic is applied here — the baseline was already
 * applied by penalizeIgnoredContact. If infiltration tops out at 100 the nation defects
 * (funding cut, pact report). The report kind reuses an existing ProjectReportKind value
 * (the kind union is frozen); the title/summary carry the alien-activity meaning.
 */
function applyContactTerror(campaign: CampaignState, contact: UfoContact): CampaignState {
  const missionType = contactMissionType(contact);
  const bonus = contactTerrorBonus(contact);
  const panicMult = difficultyConfig(campaign).panicMult;
  // Match the scaled baseline that penalizeIgnoredContact actually applied, so the
  // report's panic total reflects the real effect rather than the raw pre-scale value.
  const baselineLocal = Math.round(
    Math.round((hasBaseFacility(campaign, "radar-2") ? 12 : 18) * contactPenaltyScale(campaign)) * panicMult,
  );
  const bonusLocal = Math.round(bonus.local * panicMult);
  const totalLocal = baselineLocal + bonusLocal;

  let next = campaign;
  if (bonus.local > 0 || bonus.spillover > 0) {
    next = {
      ...next,
      regionalPanic: adjustRegionalPanic(
        next.regionalPanic,
        contact.region,
        bonus.local,
        bonus.spillover,
        panicMult,
      ),
    };
  }

  // An un-addressed UFO deepens alien infiltration of its region, scaled by how brazen
  // the mission was. Infiltration is a one-way ratchet here — only ignored contacts
  // raise it, so a commander who keeps intercepting never loses a nation. It never
  // decays, so over the now roughly-doubled 8-op arc it would defect far more nations
  // (each a PERMANENT funding cut, see applyDefection) than the original 4-op tuning
  // intended — apply the same arc-stretch relief as the other no-decay penalties.
  const infiltrationBefore = campaignInfiltration(next);
  const infiltrationAfter = adjustRegionalInfiltration(
    infiltrationBefore,
    contact.region,
    Math.round(contactInfiltrationGain(contact) * contactPenaltyScale(next)),
    panicMult,
  );
  next = { ...next, infiltration: infiltrationAfter };

  const headline = contactTerrorHeadline(missionType);
  const report: ProjectReport = {
    kind: "construction",
    id: `alien-activity-${contact.id}-${campaign.clock.elapsedHours}`,
    title: headline,
    summary: `${headline} — ${contact.region} (+${totalLocal} panic).`,
    completedAtHour: campaign.clock.elapsedHours,
  };
  next = {
    ...next,
    projectReports: [report, ...next.projectReports].slice(0, PROJECT_REPORT_LIMIT),
  };

  // A region whose infiltration maxes out signs a pact with the aliens. Evaluated
  // after the alien-activity report so the pact surfaces alongside it.
  next = applyDefection(next, contact.region, infiltrationBefore, infiltrationAfter);
  return { ...next, strategic: statusAfterStrategicChange(next, next.strategic) };
}

function addCredits(resources: CampaignResources, credits: number): CampaignResources {
  // Credits are the commander's treasury balance; it is a non-negative quantity.
  // Mandatory monthly upkeep can exceed council income, so floor at 0 to avoid an
  // undefined debt state. The funding report still surfaces the true (possibly
  // negative) net via its own `income - upkeep` computation.
  return {
    ...resources,
    credits: Math.max(0, resources.credits + credits),
  };
}

function monthlyUpkeep(campaign: CampaignState): number {
  const summary = summarizeBaseFacilities(constructedFacilities(campaign));
  const rosterCost = livingSoldiers(campaign).length * 25;
  const facilityCost = summary.facilities * 12 + Math.floor(summary.staffAssigned * 1.5);
  const researchCost = campaign.activeResearch ? 35 : 0;
  return Math.round((rosterCost + facilityCost + researchCost) * difficultyConfig(campaign).upkeepMult);
}

function fundingPressure(threat: number): number {
  if (threat >= 85) return 70;
  if (threat >= 70) return 45;
  if (threat >= 55) return 25;
  return 0;
}

function regionalFundingPressure(campaign: CampaignState): number {
  const values = Object.values(campaign.regionalPanic);
  const max = Math.max(...values);
  const average = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  if (max >= 90) return 80;
  if (max >= 75) return 50;
  if (average >= 60) return 30;
  return 0;
}

/** Difficulty-scaled funding pressure multiplier; veteran/no-difficulty is identity (legacy math). */
function fundingPressureMult(campaign: CampaignState): number {
  return difficultyConfig(campaign).fundingPressureMult;
}

function makeFundingReport(
  campaign: CampaignState,
  reportHour: number,
  income: number,
  upkeep: number,
  strategic: StrategicState,
  threatPressure: number,
  panicPressure: number,
): FundingReport {
  const net = income - upkeep;
  const reportNumber = Math.floor(reportHour / FUNDING_REPORT_INTERVAL_HOURS);
  const pressure = threatPressure + panicPressure;
  const panic = highestRegionalPanic(campaign);
  const defected = defectedRegions(campaign);
  // Each defected nation's funding share has already been withdrawn from `income`
  // (the strategic funding it derives from), so the reduced transfer is the visible
  // cost of defection; the note names how many nations are lost so far.
  const defectionNote =
    defected.length > 0
      ? ` ${defected.length} nation${defected.length === 1 ? "" : "s"} defected.`
      : "";
  const summary =
    (pressure > 0
      ? `Council transfer ${income}c, upkeep ${upkeep}c, net ${net}c. ` +
        `High threat cut future funding by ${threatPressure}c; regional panic cut ${panicPressure}c ` +
        `(${panic.region} ${panic.panic}%).`
      : `Council transfer ${income}c, upkeep ${upkeep}c, net ${net}c. Sponsor confidence is stable.`) +
    defectionNote;
  return {
    reportNumber,
    completedAtHour: reportHour,
    income,
    upkeep,
    net,
    funding: strategic.funding,
    threat: strategic.threat,
    score: strategic.score,
    summary,
  };
}

const COUNCIL_REPORT_HISTORY_LIMIT = 12;

/** Council debrief letter grade from a numeric monthly performance rating. */
function councilGradeFor(rating: number): CouncilGrade {
  if (rating >= 50) return "A";
  if (rating >= 20) return "B";
  if (rating >= 0) return "C";
  if (rating >= -30) return "D";
  return "F";
}

function averageRegionalPanic(campaign: CampaignState): number {
  const values = Object.values(campaign.regionalPanic);
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

/**
 * Build the end-of-month council debrief. Deterministic from campaign state alone
 * (no Math.random): per-region funding deltas are a base regional share cut by that
 * region's panic/infiltration, and the numeric rating blends net funding, overall
 * strategic score, and average regional panic into a letter grade.
 */
function makeCouncilReport(
  campaign: CampaignState,
  reportHour: number,
  income: number,
  upkeep: number,
  strategic: StrategicState,
): CouncilReport {
  const month = Math.floor(reportHour / FUNDING_REPORT_INTERVAL_HOURS);
  const net = income - upkeep;
  const infiltration = campaignInfiltration(campaign);
  const baseShare = income / COUNCIL_REGIONS.length;
  const regions: CouncilRegionRating[] = COUNCIL_REGIONS.map((region) => {
    const panic = campaign.regionalPanic[region] ?? 0;
    const regionInfiltration = infiltration[region] ?? 0;
    const defected = regionInfiltration >= 100;
    const cutFraction = Math.min(1, (panic + regionInfiltration) / 200);
    const fundingDelta = defected ? -Math.round(baseShare) : Math.round(baseShare * (1 - cutFraction));
    return { region, panic, infiltration: regionInfiltration, fundingDelta, defected };
  });
  const totalFundingDelta = regions.reduce((sum, region) => sum + region.fundingDelta, 0);
  const avgPanic = averageRegionalPanic(campaign);
  const rating = Math.round(net / 10 + strategic.score / 5 - avgPanic);
  const grade = councilGradeFor(rating);
  const defectedCount = regions.filter((region) => region.defected).length;
  const defectionNote =
    defectedCount > 0
      ? ` ${defectedCount} nation${defectedCount === 1 ? "" : "s"} lost to the aliens.`
      : "";
  const narrative =
    `Council review — month ${month}: net ${net}c, rating ${rating} (grade ${grade}).` + defectionNote;
  return {
    month,
    completedAtHour: reportHour,
    regions,
    totalFundingDelta,
    income,
    upkeep,
    net,
    rating,
    grade,
    narrative,
  };
}

function applyFundingReports(campaign: CampaignState, clock: CampaignClock): CampaignState {
  let next: CampaignState = { ...campaign, clock };
  while (next.clock.lastFundingHour + FUNDING_REPORT_INTERVAL_HOURS <= clock.elapsedHours) {
    const reportHour = next.clock.lastFundingHour + FUNDING_REPORT_INTERVAL_HOURS;
    const income = next.strategic.funding;
    const upkeep = monthlyUpkeep(next);
    const pressureMult = fundingPressureMult(next);
    // Same arc-stretch relief as the per-event/per-mission failure penalties: this
    // monthly funding cut recurs every 30 days with no decay, so a full 8-op arc
    // (roughly double the old 4-op arc's calendar span) would otherwise starve
    // funding to 0 long before victory, especially on commander (highest
    // fundingPressureMult/startingThreat). See contactPenaltyScale.
    const relief = contactPenaltyScale(next);
    const threatPressure = Math.round(fundingPressure(next.strategic.threat) * pressureMult * relief);
    const panicPressure = Math.round(regionalFundingPressure(next) * pressureMult * relief);
    const pressure = threatPressure + panicPressure;
    const strategic: StrategicState = statusAfterStrategicChange(next, {
      ...next.strategic,
      funding: Math.max(0, next.strategic.funding - pressure),
      score: next.strategic.score + Math.floor((income - upkeep) / 10),
    });
    const councilReport = makeCouncilReport(next, reportHour, income, upkeep, strategic);
    const councilReports = [councilReport, ...(next.councilReports ?? [])].slice(
      0,
      COUNCIL_REPORT_HISTORY_LIMIT,
    );
    next = {
      ...next,
      resources: addCredits(next.resources, income - upkeep),
      strategic,
      clock: { ...next.clock, lastFundingHour: reportHour },
      lastFundingReport: makeFundingReport(next, reportHour, income, upkeep, strategic, threatPressure, panicPressure),
      councilReports,
      lastCouncilMonth: councilReport.month,
    };
  }
  return next;
}

/**
 * Deterministic mission type for a freshly detected contact. ~70% crashSite,
 * ~18% landedUfo, ~12% terror. When regional or campaign threat is very high
 * (>= 85) a rare roll converts the spawn into a baseDefense contact. The roll
 * is derived from the same seed mix createUfoContact uses, so spawn count and
 * timing are untouched.
 */
function rollContactMissionType(campaign: CampaignState, detectedAtHour: number): MissionType {
  const base = hash(campaign.seed ^ (campaign.missionsAttempted * 0x9e3779b9) ^ detectedAtHour);
  const roll = hash(base ^ MISSION_TYPE_ROLL_SALT);
  const threat = Math.max(campaign.strategic.threat, highestRegionalPanic(campaign).panic);
  if (threat >= 85 && roll % 100 < 6) return "baseDefense";
  const bucket = roll % 100;
  if (bucket < 70) return "crashSite";
  if (bucket < 88) return "landedUfo";
  return "terror";
}

// ===========================================================================
// ACTIVE FLIGHTS — friendly craft (patrols/transfers) flying across the globe.
// Pure great-circle maths reusing the same model as tracked-UFO movement; the
// visual layer reads `activeFlights` and renders each marker between its ends.
// ===========================================================================

/**
 * A patrol that has closed to within this fraction of its target UFO shadows it
 * (progress clamped) rather than "arriving": the interceptor tails the UFO until
 * the player engages or the contact expires, so it never teleports home to respawn.
 */
const PATROL_SHADOW_PROGRESS = 0.99;
// PATROL_ID_PREFIX / RETURN_ID_PREFIX are defined in storage (beside the fleet logic)
// so chooseInterceptor can distinguish a contact's patrol from a return leg; imported above.

/** Great-circle angular distance between two lat/lon points, in degrees. */
function greatCircleDistanceDeg(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
): number {
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = fromLat * toRad;
  const phi2 = toLat * toRad;
  const dLon = (toLon - fromLon) * toRad;
  const cosCentral =
    Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(dLon);
  return Math.acos(Math.max(-1, Math.min(1, cosCentral))) * toDeg;
}

/**
 * Position along a great-circle route at a given fraction (0 = from, 1 = to) via
 * spherical linear interpolation of the endpoint unit vectors. Pure maths; the
 * geoscape renderer uses this to place a flight marker between its endpoints.
 */
export function flightPosition(
  fromLat: number,
  fromLon: number,
  toLat: number,
  toLon: number,
  fraction: number,
): { lat: number; lon: number } {
  const p = Math.max(0, Math.min(1, fraction));
  const toRad = Math.PI / 180;
  const toDeg = 180 / Math.PI;
  const phi1 = fromLat * toRad;
  const phi2 = toLat * toRad;
  const lam1 = fromLon * toRad;
  const lam2 = toLon * toRad;
  const cosCentral = Math.max(
    -1,
    Math.min(1, Math.sin(phi1) * Math.sin(phi2) + Math.cos(phi1) * Math.cos(phi2) * Math.cos(lam2 - lam1)),
  );
  const central = Math.acos(cosCentral);
  if (central < 1e-9) return { lat: fromLat, lon: fromLon };
  const sinCentral = Math.sin(central);
  const a = Math.sin((1 - p) * central) / sinCentral;
  const b = Math.sin(p * central) / sinCentral;
  const x = a * Math.cos(phi1) * Math.cos(lam1) + b * Math.cos(phi2) * Math.cos(lam2);
  const y = a * Math.cos(phi1) * Math.sin(lam1) + b * Math.cos(phi2) * Math.sin(lam2);
  const z = a * Math.sin(phi1) + b * Math.sin(phi2);
  return {
    lat: Math.atan2(z, Math.sqrt(x * x + y * y)) * toDeg,
    lon: Math.atan2(y, x) * toDeg,
  };
}

/** Convenience: live lat/lon of a flight along its current route. */
export function activeFlightPosition(flight: ActiveFlight): { lat: number; lon: number } {
  return flightPosition(flight.fromLat, flight.fromLon, flight.toLat, flight.toLon, flight.progress);
}

function isPatrolFlight(flight: ActiveFlight): boolean {
  return flight.id.startsWith(PATROL_ID_PREFIX);
}

/** Moves a flight a fixed `hours` along its route by speedDegPerHour * hours. */
function advanceFlightProgress(flight: ActiveFlight, hours: number): ActiveFlight {
  if (hours <= 0) return flight;
  const distance = greatCircleDistanceDeg(flight.fromLat, flight.fromLon, flight.toLat, flight.toLon);
  if (distance < 1e-9) return { ...flight, progress: 1 };
  const delta = (flight.speedDegPerHour * hours) / distance;
  return { ...flight, progress: Math.min(1, flight.progress + delta) };
}

/**
 * The FASTEST ready interceptor that is not already airborne (patrolling or
 * returning), so a manufactured advanced interceptor is scrambled ahead of a
 * slower Raptor. Ties keep the earliest craft in fleet order (stable).
 */
function chooseIdleInterceptor(
  campaign: CampaignState,
  flights: readonly ActiveFlight[],
): Craft | undefined {
  const airborne = new Set(flights.map((flight) => flight.craftId));
  const idle = readyInterceptors(campaign).filter((craft) => !airborne.has(craft.id));
  if (idle.length === 0) return undefined;
  let best = idle[0]!;
  for (let i = 1; i < idle.length; i++) {
    if (craftSpeedDegPerHour(idle[i]!) > craftSpeedDegPerHour(best)) best = idle[i]!;
  }
  return best;
}

function makePatrolFlight(craft: Craft, campaign: CampaignState, contact: UfoContact): ActiveFlight {
  return {
    id: `${PATROL_ID_PREFIX}${craft.id}:${contact.id}`,
    craftId: craft.id,
    kind: "interceptor",
    fromLat: campaign.base.lat,
    fromLon: campaign.base.lon,
    toLat: contact.lat,
    toLon: contact.lon,
    progress: 0,
    // No rubber-band: the patrol cruises at the craft's OWN speed, so a slow Raptor
    // literally cannot close on a faster UFO (the visual stern chase), while a fast
    // craft still overtakes and shadows a slower one.
    speedDegPerHour: craftSpeedDegPerHour(craft),
    startedAtHour: campaign.clock.elapsedHours,
  };
}

function makeReturnFlight(patrol: ActiveFlight, campaign: CampaignState): ActiveFlight {
  const pos = activeFlightPosition(patrol);
  return {
    id: `${RETURN_ID_PREFIX}${patrol.craftId}:${Math.floor(campaign.clock.elapsedHours)}`,
    craftId: patrol.craftId,
    kind: patrol.kind,
    fromLat: pos.lat,
    fromLon: pos.lon,
    toLat: campaign.base.lat,
    toLon: campaign.base.lon,
    progress: 0,
    speedDegPerHour: patrol.speedDegPerHour,
    startedAtHour: campaign.clock.elapsedHours,
  };
}

/** A patrol only has a live target while its UFO is still tracked (or engaging). */
function patrolTargetLost(contact: UfoContact | undefined): boolean {
  if (!contact) return true;
  return contact.status !== "tracked" && contact.status !== "engaging";
}

function isReturnFlight(flight: ActiveFlight): boolean {
  return flight.id.startsWith(RETURN_ID_PREFIX);
}

function craftMaxFuel(craft: Craft): number {
  return typeof craft.maxFuel === "number" && craft.maxFuel > 0 ? craft.maxFuel : CRAFT_MAX_FUEL_DEFAULT;
}

/** Current fuel of a craft, defaulting to a full tank when unset (legacy fixtures). */
function craftFuel(craft: Craft): number {
  const maxFuel = craftMaxFuel(craft);
  return typeof craft.fuel === "number" && Number.isFinite(craft.fuel)
    ? Math.max(0, Math.min(maxFuel, craft.fuel))
    : maxFuel;
}

function roundFuel(fuel: number): number {
  return Math.round(fuel * 1000) / 1000;
}

/** Great-circle degrees a flight actually covers this tick, capped at the remaining leg. */
function flightDistanceThisTick(flight: ActiveFlight, dt: number): number {
  if (dt <= 0) return 0;
  const route = greatCircleDistanceDeg(flight.fromLat, flight.fromLon, flight.toLat, flight.toLon);
  if (route < 1e-9) return 0;
  const remaining = route * Math.max(0, 1 - flight.progress);
  return Math.max(0, Math.min(flight.speedDegPerHour * dt, remaining));
}

/** Subtracts per-craft flight fuel burn from a copy of the fleet. */
function applyFlightFuelBurn(fleet: readonly Craft[], burnByCraft: ReadonlyMap<string, number>): Craft[] {
  if (burnByCraft.size === 0) return [...fleet];
  return fleet.map((craft) => {
    const burn = burnByCraft.get(craft.id);
    if (burn === undefined || burn <= 0) return craft;
    const maxFuel = craftMaxFuel(craft);
    return { ...craft, fuel: roundFuel(Math.max(0, craftFuel(craft) - burn)), maxFuel };
  });
}

/** True when the craft's fuel has reached the reserve fraction of its capacity. */
function craftFuelBelowReserve(fleet: readonly Craft[], craftId: string): boolean {
  const craft = fleet.find((entry) => entry.id === craftId);
  if (!craft) return false;
  return craftFuel(craft) <= craftMaxFuel(craft) * FUEL_RESERVE_FRACTION;
}

/** Refuels every craft currently in the hangar (no active flight) for `dt` hours. */
function refuelAtBase(fleet: readonly Craft[], flights: readonly ActiveFlight[], dt: number): Craft[] {
  if (dt <= 0) return [...fleet];
  const airborne = new Set(flights.map((flight) => flight.craftId));
  let changed = false;
  const refueled = fleet.map((craft) => {
    if (airborne.has(craft.id)) return craft;
    const maxFuel = craftMaxFuel(craft);
    const fuel = roundFuel(Math.min(maxFuel, craftFuel(craft) + REFUEL_PER_HOUR * dt));
    if (craft.fuel === fuel && craft.maxFuel === maxFuel) return craft;
    changed = true;
    return { ...craft, fuel, maxFuel };
  });
  return changed ? refueled : [...fleet];
}

/**
 * True when the engaging interceptor lacks the fuel for one more combat beat and must
 * bingo out (return to base). Fuel is a REAL limiter again: a fuel-burning beat checks
 * this BEFORE burning and breaks off when the tank can't cover it, so a long pursuit or
 * dogfight can no longer run indefinitely on an empty tank (see burnEngagingFuel — it
 * clamps at 0 with no side effect, so without this guard the encounter never ends).
 */
function bingoFuel(campaign: CampaignState): boolean {
  const engaging = chooseInterceptor(campaign);
  return !!engaging && craftFuel(engaging) < ENCOUNTER_FUEL_PER_ATTACK;
}

/** Burns one Attack round's worth of fuel from the engaging interceptor. */
function burnEngagingFuel(campaign: CampaignState): CampaignState {
  const engaging = chooseInterceptor(campaign);
  const fleet = campaign.fleet;
  if (!engaging || !Array.isArray(fleet) || fleet.length === 0) return campaign;
  const idx = fleet.findIndex((craft) => craft.id === engaging.id);
  if (idx === -1) return campaign;
  const craft = fleet[idx]!;
  const maxFuel = craftMaxFuel(craft);
  const fuel = roundFuel(Math.max(0, craftFuel(craft) - ENCOUNTER_FUEL_PER_ATTACK));
  const nextFleet = [...fleet.slice(0, idx), { ...craft, fuel, maxFuel }, ...fleet.slice(idx + 1)];
  return { ...campaign, fleet: nextFleet };
}

/**
 * Advances every active flight for `dt` hours and reconciles the patrol roster
 * against the current UFO contact — deterministic, no RNG:
 *  - patrol flights re-aim at a tracked UFO's current position each tick (homing),
 *    and shadow it once they close to PATROL_SHADOW_PROGRESS, so the interceptor
 *    visibly gives chase without teleporting home;
 *  - when the UFO is gone (expired/escaped/shot down/assaulted) its patrol turns
 *    back toward the base as a fresh return flight;
 *  - a ready, idle interceptor auto-launches a patrol toward any tracked UFO;
 *  - flights whose progress reaches 1 (arrived) are removed.
 * Fuel: each flight burns FUEL_BURN_PER_DEG per degree traveled from its engaging
 * craft; a craft that drops to the FUEL_RESERVE fraction turns back for base; and
 * any craft with no active flight refuels in the hangar for the elapsed dt. Returns
 * both the resolved flight roster and the fuel-updated fleet.
 */
function manageActiveFlights(
  campaign: CampaignState,
  contact: UfoContact | undefined,
  dt: number,
): { flights: ActiveFlight[]; fleet: Craft[] } {
  const flights = campaign.activeFlights ?? [];
  const tracked = contact?.status === "tracked";
  const baseFleet = campaign.fleet ?? [];
  if (flights.length === 0 && !tracked) {
    return { flights: [], fleet: refuelAtBase(baseFleet, [], dt) };
  }

  // 1. Re-aim existing patrols at the tracked UFO's latest position (homing).
  const reAimed = flights.map((flight) =>
    isPatrolFlight(flight) && tracked ? { ...flight, toLat: contact!.lat, toLon: contact!.lon } : flight,
  );

  // 2. Auto-launch ONE patrol toward a tracked UFO if none is airborne yet and a
  //    ready interceptor is idle. One scramble per UFO (the next craft stays in reserve).
  let withSpawn = reAimed;
  if (tracked && !reAimed.some((flight) => isPatrolFlight(flight))) {
    const idle = chooseIdleInterceptor(campaign, reAimed);
    if (idle) {
      withSpawn = [...reAimed, makePatrolFlight(idle, campaign, contact!)];
    }
  }

  // 3. Advance every flight along its route by dt and burn fuel from each engaging
  //    craft proportional to the great-circle distance it covered this tick.
  const burnByCraft = new Map<string, number>();
  const advanced = withSpawn.map((flight) => {
    const traveled = flightDistanceThisTick(flight, dt);
    if (traveled > 0) {
      burnByCraft.set(flight.craftId, (burnByCraft.get(flight.craftId) ?? 0) + traveled * FUEL_BURN_PER_DEG);
    }
    return advanceFlightProgress(flight, dt);
  });
  const burnedFleet = applyFlightFuelBurn(baseFleet, burnByCraft);

  // 4. Patrols that have caught a still-tracked UFO shadow it (clamp below arrival).
  const shadowed = advanced.map((flight) =>
    isPatrolFlight(flight) && tracked && flight.progress >= PATROL_SHADOW_PROGRESS
      ? { ...flight, progress: PATROL_SHADOW_PROGRESS }
      : flight,
  );

  // 5. Patrols whose UFO is gone OR whose craft is low on fuel turn for home.
  const converted: ActiveFlight[] = [];
  const kept = shadowed.flatMap((flight) => {
    const outOfFuel = !isReturnFlight(flight) && craftFuelBelowReserve(burnedFleet, flight.craftId);
    if (isPatrolFlight(flight) && (patrolTargetLost(contact) || outOfFuel)) {
      converted.push(makeReturnFlight(flight, campaign));
      return [];
    }
    return [flight];
  });
  // Patrol/return legs that reach their end (progress 1) are retired. A NON-BLOCKING
  // deployment run is the exception: on arrival it stays on the globe (progress clamped
  // to 1 by advanceFlightProgress) so the geoscape can detect the arrival, fire the
  // toast, and dock the "DEPLOY — begin assault" chip. It is retired only when the
  // mission it delivered resolves (recordMissionResult -> dropDeploymentFlights) OR —
  // crucially — when the contact it targets vanishes: a UFO/crash site can expire while
  // the transport is still in transit or loitering on-station. If we kept such a flight,
  // the transport would be stranded forever, the DEPLOY chip would become a permanent
  // dead button, and geoscape's `flightInProgress` launch-suppression would block EVERY
  // future ground mission — a save-persisted softlock making the campaign unwinnable.
  // So a deployment flight survives only while its deployContactId still matches the live
  // contact; a stale (or version-skewed, id-less) deployment flight is dropped here.
  const liveContactId = contact?.id;
  const finalFlights = [...kept, ...converted].filter((flight) => {
    if (flight.purpose === "deployment") {
      return flight.deployContactId != null && flight.deployContactId === liveContactId;
    }
    return flight.progress < 1;
  });

  // 6. Refuel crafts sitting in the hangar (no active flight) for the elapsed dt.
  const finalFleet = refuelAtBase(burnedFleet, finalFlights, dt);

  return { flights: finalFlights, fleet: finalFleet };
}

export function advanceGeoscape(
  campaign: CampaignState,
  hours = GEOSCAPE_SCAN_HOURS,
): CampaignState {
  if (campaign.strategic.status !== "active") return campaign;
  // Fractional hours flow through so the clock can tick minute-by-minute; funding,
  // expiry, and spawn checks all use crossing (>=/<=) on elapsedHours, so fractional
  // values fire events at exactly their thresholds.
  const dt = Math.max(0, hours);
  const advanced = clockAt(campaign.clock, campaign.clock.elapsedHours + dt);
  let clock: CampaignClock = { ...advanced };
  let strategic = campaign.strategic;
  let contact = campaign.ufoContact;
  let nextCampaign = applyFundingReports({ ...campaign, clock, strategic, ufoContact: contact }, clock);
  clock = nextCampaign.clock;
  strategic = nextCampaign.strategic;
  contact = nextCampaign.ufoContact;
  // Tracked UFOs fly across the globe as time flows (drifting even with fractional dt).
  if (contact && contact.status === "tracked") {
    contact = moveTrackedContact(contact, dt);
  }

  if (contact && contact.expiresAtHour <= clock.elapsedHours) {
    const expiredContact = contact;
    nextCampaign = penalizeIgnoredContact({ ...nextCampaign, clock, strategic, ufoContact: contact }, strategic);
    strategic = nextCampaign.strategic;
    // A UFO that slips away while still an active threat (tracked/landed — never shot down)
    // carries out its mission: terror, harvesting, or recon raise regional panic, scaled by
    // mission type and difficulty. A crashed (already shot-down) contact only pays the
    // baseline ignore penalty above — its crew is already wrecked.
    if (expiredContact.status !== "crashed") {
      nextCampaign = applyContactTerror(nextCampaign, expiredContact);
      strategic = nextCampaign.strategic;
    }
    contact = undefined;
    clock = { ...clock, lastContactHour: clock.elapsedHours };
  }

  if (!contact && clock.elapsedHours >= clock.lastContactHour + contactInterval(campaign, clock.elapsedHours)) {
    const missionType = rollContactMissionType(nextCampaign, clock.elapsedHours);
    contact = createUfoContact(nextCampaign, clock.elapsedHours, missionType);
    clock = { ...clock, lastContactHour: clock.elapsedHours };
  }

  const { flights: activeFlights, fleet: advancedFleet } = manageActiveFlights(nextCampaign, contact, dt);
  const composed = repairInterceptor(completeFinishedConstruction(completeFinishedManufacturing(recoverWoundedSoldiers(completeFinishedResearch({
    ...nextCampaign,
    clock,
    strategic,
    ufoContact: contact,
    activeFlights,
    fleet: advancedFleet,
  })))));
  return restockMarket(completeFinishedBaseConstruction(composed), Math.max(0, Math.floor(hours)));
}

export function formatCampaignClock(clock: CampaignClock): string {
  // Minutes derive from the fractional part of elapsedHours (the clock has no minute field).
  const minutes = Math.floor((clock.elapsedHours - Math.floor(clock.elapsedHours)) * 60);
  return `Day ${clock.day} ${String(clock.hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
