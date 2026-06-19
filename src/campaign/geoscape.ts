import type {
  CampaignClock,
  CampaignResources,
  CampaignState,
  FundingReport,
  InterceptionReport,
  StrategicState,
  UfoContact,
} from "./types";
import { summarizeBaseFacilities } from "./base";
import {
  activeSoldiers,
  adjustRegionalPanic,
  canRecruitSoldier,
  completeFinishedConstruction,
  completeFinishedResearch,
  completeFinishedManufacturing,
  constructedFacilities,
  hasBaseFacility,
  highestRegionalPanic,
  livingSoldiers,
  recoverWoundedSoldiers,
} from "./storage";

export const GEOSCAPE_SCAN_HOURS = 6;
export const UFO_CONTACT_LIFETIME_HOURS = 30;
export const CRASH_SITE_LIFETIME_HOURS = 24;
export const FUNDING_REPORT_INTERVAL_HOURS = 24 * 30;
export const INTERCEPTOR_REPAIR_MIN_HOURS = 6;
export const INTERCEPTOR_REPAIR_MAX_HOURS = 72;
const INTERCEPTOR_BASE_SCORE = 68;
const UFO_BASE_SCORE = 44;

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
  return hasBaseFacility(campaign, "radar-2") ? 12 : 18;
}

function clockAt(clock: CampaignClock, elapsedHours: number): CampaignClock {
  const elapsed = Math.max(0, Math.floor(elapsedHours));
  return {
    day: 1 + Math.floor(elapsed / 24),
    hour: elapsed % 24,
    elapsedHours: elapsed,
    lastContactHour: Math.max(0, Math.floor(clock.lastContactHour)),
    lastFundingHour: Math.max(0, Math.floor(clock.lastFundingHour)),
  };
}

function offset(seed: number, magnitude: number): number {
  return ((seed % 2001) / 1000 - 1) * magnitude;
}

export function createUfoContact(campaign: CampaignState, detectedAtHour: number): UfoContact {
  const seed = hash(campaign.seed ^ (campaign.missionsAttempted * 0x9e3779b9) ^ detectedAtHour);
  const zone = CONTACT_ZONES[seed % CONTACT_ZONES.length]!;
  const lat = Math.max(-56, Math.min(68, zone.lat + offset(hash(seed ^ 0xa511e9b3), 7)));
  const lonRaw = zone.lon + offset(hash(seed ^ 0x63d83595), 11);
  const lon = lonRaw > 180 ? lonRaw - 360 : lonRaw < -180 ? lonRaw + 360 : lonRaw;
  return {
    id: `UFO-${String(campaign.missionsAttempted + 1).padStart(2, "0")}-${seed.toString(16).slice(0, 4).toUpperCase()}`,
    status: "tracked",
    lat: Math.round(lat * 10) / 10,
    lon: Math.round(lon * 10) / 10,
    region: zone.region,
    detectedAtHour,
    expiresAtHour: detectedAtHour + UFO_CONTACT_LIFETIME_HOURS,
    missionSeed: hash(seed ^ 0x85ebca6b),
    strength: 1 + (hash(seed ^ 0xc2b2ae35) % 3),
  };
}

export function canLaunchInterceptor(campaign: CampaignState): boolean {
  return (
    campaign.strategic.status === "active" &&
    campaign.ufoContact?.status === "tracked" &&
    isInterceptorReady(campaign)
  );
}

export function isInterceptorReady(campaign: CampaignState): boolean {
  return !campaign.interceptor.repairedAtHour || campaign.interceptor.repairedAtHour <= campaign.clock.elapsedHours;
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
    Math.floor(campaign.interceptor.damage / 2)
  );
}

function ufoEngagementScore(contact: UfoContact): number {
  return UFO_BASE_SCORE + contact.strength * 9;
}

function interceptionDamage(campaign: CampaignState, contact: UfoContact, succeeded: boolean): number {
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  const fabricationBay = hasBaseFacility(campaign, "workshop-2");
  const base = succeeded ? 14 : 30;
  const strengthScale = succeeded ? 12 : 14;
  return Math.max(
    succeeded ? 6 : 18,
    base + contact.strength * strengthScale - (trackingUplink ? 5 : 0) - (fabricationBay ? 4 : 0),
  );
}

function makeInterceptionReport(
  contact: UfoContact,
  result: InterceptionReport["result"],
  damage: number,
  completedAtHour: number,
): InterceptionReport {
  return {
    contactId: contact.id,
    result,
    region: contact.region,
    strength: contact.strength,
    interceptorDamage: damage,
    completedAtHour,
    summary: result === "crashed"
      ? `${contact.id} forced down over ${contact.region}. Interceptor took ${damage}% damage.`
      : `${contact.id} escaped over ${contact.region}. Interceptor took ${damage}% damage during failed pursuit.`,
  };
}

export function interceptionForecast(campaign: CampaignState): InterceptionForecast | null {
  const contact = campaign.ufoContact?.status === "tracked" ? campaign.ufoContact : undefined;
  if (!contact) return null;
  const interceptorScore = interceptorEngagementScore(campaign);
  const ufoScore = ufoEngagementScore(contact);
  const succeeds = interceptorScore >= ufoScore;
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
    summary: succeeds
      ? `Forecast favorable: forced landing likely, estimated interceptor damage ${damage}%.`
      : `Forecast dangerous: UFO may escape, estimated interceptor damage ${damage}%.`,
  };
}

export function interceptUfo(campaign: CampaignState): CampaignState {
  const forecast = interceptionForecast(campaign);
  if (!forecast?.canLaunch) return campaign;
  const contact = campaign.ufoContact!;
  const succeeded = forecast.succeeds;
  const damage = forecast.damage;
  const totalDamage = Math.min(100, campaign.interceptor.damage + damage);
  const interceptor = {
    damage: totalDamage,
    sorties: campaign.interceptor.sorties + 1,
    repairedAtHour: campaign.clock.elapsedHours + interceptorRepairHours(campaign, totalDamage),
  };
  const report = makeInterceptionReport(
    contact,
    succeeded ? "crashed" : "escaped",
    damage,
    campaign.clock.elapsedHours,
  );
  if (!succeeded) {
    const regionalPanic = adjustRegionalPanic(campaign.regionalPanic, contact.region, 12, 1);
    const strategic = statusAfterStrategicChange({ ...campaign, regionalPanic }, {
      ...campaign.strategic,
      threat: Math.min(100, campaign.strategic.threat + 8),
      funding: Math.max(0, campaign.strategic.funding - 20),
      score: campaign.strategic.score - 20,
    });
    return {
      ...campaign,
      clock: { ...campaign.clock, lastContactHour: campaign.clock.elapsedHours },
      interceptor,
      lastInterceptionReport: report,
      strategic,
      regionalPanic,
      ufoContact: undefined,
    };
  }
  return {
    ...campaign,
    interceptor,
    lastInterceptionReport: report,
    strategic: {
      ...campaign.strategic,
      score: campaign.strategic.score + 25,
    },
    regionalPanic: adjustRegionalPanic(campaign.regionalPanic, contact.region, -4),
    ufoContact: {
      ...contact,
      status: "crashed",
      interceptedAtHour: campaign.clock.elapsedHours,
      expiresAtHour: campaign.clock.elapsedHours + CRASH_SITE_LIFETIME_HOURS,
      interceptorDamage: damage,
    },
  };
}

function repairInterceptor(campaign: CampaignState): CampaignState {
  const repairedAt = campaign.interceptor.repairedAtHour;
  if (repairedAt === undefined || repairedAt > campaign.clock.elapsedHours) return campaign;
  return {
    ...campaign,
    interceptor: {
      damage: 0,
      sorties: campaign.interceptor.sorties,
    },
  };
}

function statusAfterStrategicChange(campaign: CampaignState, strategic: StrategicState): StrategicState {
  if (strategic.status !== "active") return strategic;
  const canFieldSquad = livingSoldiers(campaign).length > 0 || canRecruitSoldier(campaign);
  const panicCollapse = highestRegionalPanic(campaign).panic >= 100;
  return {
    ...strategic,
    status: strategic.threat >= 100 || strategic.funding <= 0 || !canFieldSquad || panicCollapse ? "lost" : "active",
  };
}

function penalizeIgnoredContact(campaign: CampaignState, strategic: StrategicState): CampaignState {
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  const regionalPanic = adjustRegionalPanic(
    campaign.regionalPanic,
    campaign.ufoContact?.region ?? campaign.base.region,
    trackingUplink ? 14 : 22,
    trackingUplink ? 1 : 3,
  );
  const next = {
    ...strategic,
    threat: Math.min(100, strategic.threat + (trackingUplink ? 6 : 10)),
    funding: Math.max(0, strategic.funding - (trackingUplink ? 15 : 25)),
    score: strategic.score - 25,
  };
  const updated = { ...campaign, regionalPanic };
  return {
    ...updated,
    strategic: statusAfterStrategicChange(updated, next),
  };
}

function addCredits(resources: CampaignResources, credits: number): CampaignResources {
  return {
    ...resources,
    credits: resources.credits + credits,
  };
}

function monthlyUpkeep(campaign: CampaignState): number {
  const summary = summarizeBaseFacilities(constructedFacilities(campaign));
  const rosterCost = livingSoldiers(campaign).length * 25;
  const facilityCost = summary.facilities * 12 + Math.floor(summary.staffAssigned * 1.5);
  const researchCost = campaign.activeResearch ? 35 : 0;
  return rosterCost + facilityCost + researchCost;
}

function fundingPressure(threat: number): number {
  if (threat >= 85) return 90;
  if (threat >= 70) return 60;
  if (threat >= 55) return 30;
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
  const summary =
    pressure > 0
      ? `Council transfer ${income}c, upkeep ${upkeep}c, net ${net}c. ` +
        `High threat cut future funding by ${threatPressure}c; regional panic cut ${panicPressure}c ` +
        `(${panic.region} ${panic.panic}%).`
      : `Council transfer ${income}c, upkeep ${upkeep}c, net ${net}c. Sponsor confidence is stable.`;
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
    const threatPressure = fundingPressure(next.strategic.threat);
    const panicPressure = regionalFundingPressure(next);
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

export function advanceGeoscape(
  campaign: CampaignState,
  hours = GEOSCAPE_SCAN_HOURS,
): CampaignState {
  if (campaign.strategic.status !== "active") return campaign;
  const advanced = clockAt(campaign.clock, campaign.clock.elapsedHours + Math.max(0, Math.floor(hours)));
  let clock: CampaignClock = { ...advanced };
  let strategic = campaign.strategic;
  let contact = campaign.ufoContact;
  let nextCampaign = applyFundingReports({ ...campaign, clock, strategic, ufoContact: contact }, clock);
  clock = nextCampaign.clock;
  strategic = nextCampaign.strategic;
  contact = nextCampaign.ufoContact;

  if (contact && contact.expiresAtHour <= clock.elapsedHours) {
    nextCampaign = penalizeIgnoredContact({ ...nextCampaign, clock, strategic, ufoContact: contact }, strategic);
    strategic = nextCampaign.strategic;
    contact = undefined;
    clock = { ...clock, lastContactHour: clock.elapsedHours };
  }

  if (!contact && clock.elapsedHours >= clock.lastContactHour + contactInterval(campaign)) {
    contact = createUfoContact(nextCampaign, clock.elapsedHours);
    clock = { ...clock, lastContactHour: clock.elapsedHours };
  }

  return repairInterceptor(completeFinishedConstruction(completeFinishedManufacturing(recoverWoundedSoldiers(completeFinishedResearch({
    ...nextCampaign,
    clock,
    strategic,
    ufoContact: contact,
  })))));
}

export function formatCampaignClock(clock: CampaignClock): string {
  return `Day ${clock.day} ${String(clock.hour).padStart(2, "0")}:00`;
}
