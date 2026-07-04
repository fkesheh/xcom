import type {
  ActiveFlight,
  BaseLocation,
  CampaignClock,
  CampaignResources,
  CampaignState,
  CouncilRegion,
  Craft,
  FundingReport,
  InterceptionEncounter,
  InterceptionReport,
  InterceptionResult,
  MissionType,
  ProjectReport,
  StrategicState,
  UfoContact,
  UfoType,
} from "./types";
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
// FASTER, so a starting Raptor (0.9 deg/h) catches scouts/harvesters but is
// outrun by terror ships and battleships until an advanced interceptor is built.
// Lifetimes/panic/infiltration are unchanged — only the speed column is re-tuned.
export const UFO_TYPE_PROFILES: Record<UfoType, UfoTypeProfile> = {
  scout: { strength: 1, speed: 0.7, lifetimeHours: 30, infiltrationMult: 0.5, panicMult: 0.5 },
  harvester: { strength: 3, speed: 0.55, lifetimeHours: 44, infiltrationMult: 1.0, panicMult: 1.0 },
  terror: { strength: 5, speed: 1.0, lifetimeHours: 66, infiltrationMult: 1.6, panicMult: 1.6 },
  battleship: { strength: 8, speed: 1.35, lifetimeHours: 96, infiltrationMult: 2.2, panicMult: 2.2 },
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

/** Starting engagement range for an interactive interception encounter. */
const ENCOUNTER_START_RANGE = 3;
/**
 * Range at which a stern chase breaks off: when the UFO outruns the pursuer, every
 * Attack beat OPENS the range by one; once it reaches this value the UFO escapes.
 */
const ENCOUNTER_STERN_ESCAPE_RANGE = ENCOUNTER_START_RANGE + 3;
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

function contactInterval(campaign: CampaignState): number {
  const base = hasBaseFacility(campaign, "radar-2") ? 12 : 18;
  const extra = campaign.bases?.length ?? 0;
  return Math.max(6, base - extra * 3);
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
function greatCircleDestination(
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
 * Shared outcome resolver for both the instant auto-resolve (`interceptUfo`) and
 * the terminal transitions of an interactive encounter. Applies the interceptor's
 * final damage, records the report, and mutates strategic/regional state per the
 * result. A resolved outcome always clears any active encounter.
 */
function applyInterceptionOutcome(
  campaign: CampaignState,
  contact: UfoContact,
  result: InterceptionResult,
  finalInterceptorDamage: number,
  reportDamage: number,
): CampaignState {
  const totalDamage = Math.max(0, Math.min(100, Math.floor(finalInterceptorDamage)));
  // Route the damage onto the engaging craft (and keep the legacy interceptor field in sync).
  const chosen = chooseInterceptor(campaign);
  const afterCraft = chosen ? damageCraft(campaign, chosen.id, totalDamage) : campaign;
  // A UFO forced down over open ocean is lost — no assault mission can reach the wreck.
  const overOcean = result === "crashed" && !isLand(contact.lat, contact.lon);
  const report = makeInterceptionReport(contact, result, reportDamage, afterCraft.clock.elapsedHours, overOcean);
  if (result === "escaped") {
    const cfg = difficultyConfig(campaign);
    const regionalPanic = adjustRegionalPanic(afterCraft.regionalPanic, contact.region, 8, 1, cfg.panicMult);
    const strategic = statusAfterStrategicChange({ ...afterCraft, regionalPanic }, {
      ...afterCraft.strategic,
      threat: Math.min(THREAT_LOSS_THRESHOLD, afterCraft.strategic.threat + Math.round(6 * cfg.threatGainMult)),
      funding: Math.max(0, afterCraft.strategic.funding - 15),
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
    },
    interception: undefined,
  };
}

export function interceptUfo(campaign: CampaignState): CampaignState {
  const forecast = interceptionForecast(campaign);
  if (!forecast?.canLaunch) return campaign;
  const contact = campaign.ufoContact!;
  const result: InterceptionResult = forecast.succeeds ? "crashed" : "escaped";
  const finalDamage = Math.min(100, engagingDamage(campaign) + forecast.damage);
  return applyInterceptionOutcome(campaign, contact, result, finalDamage, forecast.damage);
}

/** Player choice during an interactive interception encounter. */
export type InterceptionAction = "close" | "attack" | "disengage";

function rollFraction(seed: number): number {
  return (hash(seed) >>> 0) / 0x100000000;
}

function encounterRoundSeed(campaign: CampaignState, contact: UfoContact, round: number): number {
  return (campaign.seed ^ (contact.missionSeed >>> 0) ^ (Math.max(0, round) * 0x9e3779b9)) >>> 0;
}

/**
 * Outgoing interceptor damage at the current range; closer range hits harder and
 * the engaging craft's weaponPower (>1 for advanced interceptors) scales it.
 */
function interceptorAttackDamage(range: number, mult: number, roundSeed: number, power: number): number {
  const base = 10 + (ENCOUNTER_START_RANGE - range) * 8;
  const factor = 0.6 + 0.4 * rollFraction(hash(roundSeed ^ ENCOUNTER_INTERCEPTOR_SALT));
  return Math.max(1, Math.round(base * factor * mult * power));
}

/** Incoming UFO return fire at the current range; closer range is deadlier both ways. */
function ufoReturnFireDamage(range: number, strength: number, mult: number, roundSeed: number): number {
  const base = 5 + strength * 2 + (ENCOUNTER_START_RANGE - range) * 3;
  const factor = 0.6 + 0.4 * rollFraction(hash(roundSeed ^ ENCOUNTER_UFO_SALT));
  return Math.max(1, Math.round(base * factor * mult));
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
 * Begins an interactive interception against a tracked crash-site contact. Scales
 * UFO HP from the contact's strength and interceptor HP from its current condition.
 * No-op unless the contact is a tracked crashSite and the interceptor is ready.
 */
export function startInterceptionEncounter(campaign: CampaignState): CampaignState {
  const contact = campaign.ufoContact;
  if (!contact || contact.status !== "tracked") return campaign;
  if (contactMissionType(contact) !== "crashSite") return campaign;
  if (!isInterceptorReady(campaign)) return campaign;
  const ufoHpMax = encounterUfoHpMax(contact);
  const interceptorHp = encounterInterceptorHp(campaign);
  const encounter: InterceptionEncounter = {
    contactId: contact.id,
    ufoHp: ufoHpMax,
    ufoHpMax,
    interceptorHp,
    interceptorHpMax: engagingHullPoints(campaign),
    range: ENCOUNTER_START_RANGE,
    roundsElapsed: 0,
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

/**
 * Resolves one round of an active encounter. "close" cuts range (improving future
 * damage), "attack" exchanges fire at the current range, "disengage" returns the
 * UFO to tracked without further interceptor damage.
 *
 * STERN CHASE: when the UFO outruns the engaging craft (interceptionSpeedAdvantage
 * === "outrun"), every Attack beat OPENS the range by one and "close" CANNOT reduce
 * it — a slower craft physically cannot close the gap, it can only burn afterburner
 * fuel to hold station. So the range only ever grows: after at most a few firing
 * passes (each at longer, weaker range) the UFO reaches ENCOUNTER_STERN_ESCAPE_RANGE
 * and breaks off. This makes the interactive encounter honor the forecast's hard gate
 * — an outrun UFO genuinely cannot be forced down at any score (matching
 * interceptionForecast), so a battleship really is uncatchable with a slow Raptor.
 *
 * FUEL: attack and afterburner-close burn the engaging craft's fuel. A craft that can
 * no longer afford a round breaks off and returns to base — fuel is a real limiter on
 * how long a pursuit can be pressed, not a value that silently clamps at zero.
 *
 * Terminal outcomes (UFO down or interceptor lost) reuse the shared auto-resolve
 * resolver. No-op without an active engaging encounter.
 */
export function executeInterceptionAction(
  campaign: CampaignState,
  action: InterceptionAction,
): CampaignState {
  const encounter = campaign.interception;
  const contact = campaign.ufoContact;
  if (!encounter || !contact || contact.status !== "engaging") return campaign;

  const round = encounter.roundsElapsed;
  const roundLabel = `Round ${round + 1}`;
  const outrun = interceptionSpeedAdvantage(campaign, contact) === "outrun";

  if (action === "disengage") {
    return {
      ...campaign,
      ufoContact: { ...contact, status: "tracked" },
      interception: undefined,
    };
  }

  // A fuel-burning beat (any Attack, or an afterburner Close against a faster UFO)
  // needs at least one round's fuel in the tank. Out of fuel, the interceptor cannot
  // sustain the chase: it breaks off and the UFO drops back to tracked (the patrol
  // layer then flies the empty craft home to refuel).
  const burnsFuel = action === "attack" || (action === "close" && outrun);
  if (burnsFuel) {
    const engaging = chooseInterceptor(campaign);
    if (engaging && craftFuel(engaging) < ENCOUNTER_FUEL_PER_ATTACK) {
      return {
        ...campaign,
        ufoContact: { ...contact, status: "tracked" },
        interception: undefined,
      };
    }
  }

  if (action === "close") {
    // Against a faster UFO the range cannot be reduced — closing only holds station
    // and burns afterburner fuel; against a matched/slower UFO a Close cuts the range
    // (and costs no fuel) to set up a harder-hitting pass.
    const range = outrun ? encounter.range : Math.max(0, encounter.range - 1);
    const afterFuel = outrun ? burnEngagingFuel(campaign) : campaign;
    return {
      ...afterFuel,
      interception: {
        ...encounter,
        range,
        roundsElapsed: round + 1,
        log: [
          ...encounter.log,
          outrun
            ? `${roundLabel}: burning fuel to hold at range ${range}, but ${contact.id} is faster — the gap will not close.`
            : `${roundLabel}: closing to range ${range}.`,
        ],
      },
    };
  }

  const mult = difficultyConfig(campaign).interceptionDamageMult;
  const roundSeed = encounterRoundSeed(campaign, contact, round);
  const power = engagingWeaponPower(campaign);
  const interceptorDmg = interceptorAttackDamage(encounter.range, mult, roundSeed, power);
  const ufoDmg = ufoReturnFireDamage(encounter.range, contact.strength, mult, roundSeed);
  const ufoHp = Math.max(0, encounter.ufoHp - interceptorDmg);
  const interceptorHp = Math.max(0, encounter.interceptorHp - ufoDmg);
  const hull = encounter.interceptorHpMax;
  const log = [
    ...encounter.log,
    `${roundLabel}: interceptor hits ${contact.id} for ${interceptorDmg}; UFO returns ${ufoDmg}.`,
  ];

  // Each Attack round burns fuel from the engaging interceptor.
  const afterFuel = burnEngagingFuel(campaign);

  // A simultaneous kill is resolved in the interceptor's favor (UFO forced down).
  if (ufoHp <= 0) {
    const finalInterceptorDamage = encounterDamagePercent(interceptorHp, hull);
    const reportDamage = Math.max(0, finalInterceptorDamage - engagingDamage(afterFuel));
    return applyInterceptionOutcome(afterFuel, contact, "crashed", finalInterceptorDamage, reportDamage);
  }
  if (interceptorHp <= 0) {
    const reportDamage = Math.max(0, 100 - engagingDamage(afterFuel));
    return applyInterceptionOutcome(afterFuel, contact, "escaped", 100, reportDamage);
  }

  // STERN CHASE: the UFO is faster, so a fire pass lets it open the gap. When the
  // range widens past the break-off threshold the UFO escapes with the interceptor
  // carrying whatever damage it took during the pursuit.
  if (outrun) {
    const openedRange = encounter.range + 1;
    if (openedRange >= ENCOUNTER_STERN_ESCAPE_RANGE) {
      const finalInterceptorDamage = encounterDamagePercent(interceptorHp, hull);
      const reportDamage = Math.max(0, finalInterceptorDamage - engagingDamage(afterFuel));
      return applyInterceptionOutcome(afterFuel, contact, "escaped", finalInterceptorDamage, reportDamage);
    }
    return {
      ...afterFuel,
      interception: {
        ...encounter,
        ufoHp,
        interceptorHp,
        range: openedRange,
        roundsElapsed: round + 1,
        log: [...log, `${roundLabel}: ${contact.id} outruns the pursuit — range opens to ${openedRange}.`],
      },
    };
  }

  return {
    ...afterFuel,
    interception: {
      ...encounter,
      ufoHp,
      interceptorHp,
      roundsElapsed: round + 1,
      log,
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
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  // panicMult was previously omitted (hardcoded to 1), so ignored contacts hammered
  // panic at full strength regardless of difficulty. Pass the difficulty scaler now.
  // Spillover is intentionally small: it applies to EVERY council region, so even a
  // low per-region value universalizes panic inflation over a long campaign.
  const regionalPanic = adjustRegionalPanic(
    campaign.regionalPanic,
    campaign.ufoContact?.region ?? campaign.base.region,
    trackingUplink ? 12 : 18,
    trackingUplink ? 0 : 1,
    cfg.panicMult,
  );
  const threatGain = Math.round((trackingUplink ? 4 : 6) * cfg.threatGainMult);
  const next = {
    ...strategic,
    threat: Math.min(THREAT_LOSS_THRESHOLD, strategic.threat + threatGain),
    funding: Math.max(0, strategic.funding - (trackingUplink ? 10 : 15)),
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
  const baselineLocal = Math.round((hasBaseFacility(campaign, "radar-2") ? 12 : 18) * panicMult);
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
  // raise it, so a commander who keeps intercepting never loses a nation.
  const infiltrationBefore = campaignInfiltration(next);
  const infiltrationAfter = adjustRegionalInfiltration(
    infiltrationBefore,
    contact.region,
    contactInfiltrationGain(contact),
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

function applyFundingReports(campaign: CampaignState, clock: CampaignClock): CampaignState {
  let next: CampaignState = { ...campaign, clock };
  while (next.clock.lastFundingHour + FUNDING_REPORT_INTERVAL_HOURS <= clock.elapsedHours) {
    const reportHour = next.clock.lastFundingHour + FUNDING_REPORT_INTERVAL_HOURS;
    const income = next.strategic.funding;
    const upkeep = monthlyUpkeep(next);
    const pressureMult = fundingPressureMult(next);
    const threatPressure = Math.round(fundingPressure(next.strategic.threat) * pressureMult);
    const panicPressure = Math.round(regionalFundingPressure(next) * pressureMult);
    const pressure = threatPressure + panicPressure;
    const strategic: StrategicState = statusAfterStrategicChange(next, {
      ...next.strategic,
      funding: Math.max(0, next.strategic.funding - pressure),
      score: next.strategic.score + Math.floor((income - upkeep) / 10),
    });
    next = {
      ...next,
      resources: addCredits(next.resources, income - upkeep),
      strategic,
      clock: { ...next.clock, lastFundingHour: reportHour },
      lastFundingReport: makeFundingReport(next, reportHour, income, upkeep, strategic, threatPressure, panicPressure),
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

  if (!contact && clock.elapsedHours >= clock.lastContactHour + contactInterval(campaign)) {
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
