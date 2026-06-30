import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  createUfoContact,
  CRASH_SITE_LIFETIME_HOURS,
  interceptUfo,
  UFO_CONTACT_LIFETIME_HOURS,
} from "../src/campaign/geoscape";
import { generateOperation } from "../src/campaign/operations";
import { createCampaign, regionalPanicFor } from "../src/campaign/storage";
import type { CampaignState, MissionType, UfoContact } from "../src/campaign/types";

const BASE = { lat: 48.2, lon: 14.6, region: "Europe" };

function freshCampaign(seed = 4242): CampaignState {
  return createCampaign(BASE, seed);
}

/** A campaign carrying a landed terror contact whose 30h window is about to expire. */
function campaignWithExpiringTerror(seed = 4242): {
  campaign: CampaignState;
  contact: UfoContact;
} {
  const campaign = freshCampaign(seed);
  const contact = createUfoContact(campaign, 0, "terror");
  return { campaign: { ...campaign, ufoContact: contact }, contact };
}

describe("un-addressed UFOs carry out their mission and cause terror", () => {
  it("raises the contact's regional panic and logs a terror report when a terror contact expires", () => {
    const { campaign, contact } = campaignWithExpiringTerror();
    const region = contact.region;
    const panicBefore = regionalPanicFor(campaign, region)!;

    const expired = advanceGeoscape(campaign, UFO_CONTACT_LIFETIME_HOURS);

    // Baseline ignore penalty (18, no radar) + terror mission bonus (18) at veteran panicMult 1.0.
    expect(expired.ufoContact).toBeUndefined();
    expect(regionalPanicFor(expired, region)!).toBe(panicBefore + 18 + 18);

    const report = expired.projectReports.find((entry) => entry.title === "Alien terror strike");
    expect(report).toBeDefined();
    expect(report!.summary).toContain(region);
    expect(report!.summary).toContain("+36 panic");
  });

  it("is fully deterministic across repeated runs from the same seed", () => {
    const runA = advanceGeoscape(campaignWithExpiringTerror(99).campaign, UFO_CONTACT_LIFETIME_HOURS);
    const runB = advanceGeoscape(campaignWithExpiringTerror(99).campaign, UFO_CONTACT_LIFETIME_HOURS);

    expect(runA.regionalPanic).toEqual(runB.regionalPanic);
    expect(runA.projectReports).toEqual(runB.projectReports);
  });

  it("does NOT trigger the terror penalty for a freshly-intercepted (shot-down) crashed contact", () => {
    // Seed 12345 spawns a tracked crashSite contact at hour 18 that interceptUfo forces down.
    const detected = advanceGeoscape(freshCampaign(12345), 18);
    expect(detected.ufoContact?.status).toBe("tracked");
    const shot = interceptUfo(detected);
    expect(shot.ufoContact?.status).toBe("crashed");

    const region = shot.ufoContact!.region;
    const panicBefore = regionalPanicFor(shot, region)!;

    // Let the crash-site recovery window lapse.
    const expired = advanceGeoscape(shot, CRASH_SITE_LIFETIME_HOURS);

    // Only the baseline ignore penalty fires (+18); no mission-type terror bonus, no report.
    expect(expired.projectReports.some((entry) => entry.id.startsWith("alien-activity-"))).toBe(false);
    expect(regionalPanicFor(expired, region)!).toBe(panicBefore + 18);
  });

  it("scales the terror panic up at commander difficulty via panicMult", () => {
    const rookieSeed = 7;
    const commanderSeed = 7;
    const rookieBase = freshCampaign(rookieSeed);
    const commanderBase = freshCampaign(commanderSeed);
    const rookie = {
      ...campaignWithExpiringTerror(rookieSeed).campaign,
      strategic: { ...rookieBase.strategic, difficulty: "rookie" as const },
    };
    const commander = {
      ...campaignWithExpiringTerror(commanderSeed).campaign,
      strategic: { ...commanderBase.strategic, difficulty: "commander" as const },
    };
    const rookieRegion = rookie.ufoContact!.region;
    const commanderRegion = commander.ufoContact!.region;

    const rookieExpired = advanceGeoscape(rookie, UFO_CONTACT_LIFETIME_HOURS);
    const commanderExpired = advanceGeoscape(commander, UFO_CONTACT_LIFETIME_HOURS);

    const rookieDelta =
      regionalPanicFor(rookieExpired, rookieRegion)! - regionalPanicFor(rookie, rookieRegion)!;
    const commanderDelta =
      regionalPanicFor(commanderExpired, commanderRegion)! - regionalPanicFor(commander, commanderRegion)!;

    // Baseline (18) is unscaled; only the terror bonus (18) is multiplied by panicMult.
    expect(rookieDelta).toBe(18 + Math.round(18 * 0.65));
    expect(commanderDelta).toBe(18 + Math.round(18 * 1.3));
    expect(commanderDelta).toBeGreaterThan(rookieDelta);
  });
});

describe("generateOperation crash-site vs landed-UFO crew", () => {
  function withContact(
    campaign: CampaignState,
    missionType: MissionType,
    status: UfoContact["status"],
  ): CampaignState {
    const contact: UfoContact = {
      id: "UFO-TEST",
      status,
      lat: 10,
      lon: 20,
      region: "Europe",
      detectedAtHour: 0,
      expiresAtHour: 100,
      missionSeed: 4242,
      strength: 2,
      missionType,
    };
    return { ...campaign, ufoContact: contact };
  }

  it("fields a reduced crew for a crash site vs the full crew of an intact landed UFO", () => {
    const campaign = freshCampaign();
    const crash = generateOperation(withContact(campaign, "crashSite", "crashed"));
    const landed = generateOperation(withContact(campaign, "landedUfo", "landed"));

    expect(crash.enemyCount).toBeLessThan(landed.enemyCount);
    // The shot-down wreck keeps ~60-70% of the intact crew.
    const ratio = crash.enemyCount / landed.enemyCount;
    expect(ratio).toBeGreaterThanOrEqual(0.6);
    expect(ratio).toBeLessThanOrEqual(0.7);

    // Briefings call out the wreckage vs the intact full crew.
    expect(crash.briefing).toContain("reduced");
    expect(landed.briefing).toContain("full");
    expect(landed.briefing).toContain("intact");
  });

  it("keeps the crash-site count deterministic and unchanged from the legacy formula", () => {
    const campaign = freshCampaign();
    const crash = generateOperation(withContact(campaign, "crashSite", "crashed"));
    const again = generateOperation(withContact(campaign, "crashSite", "crashed"));

    expect(crash.enemyCount).toBe(again.enemyCount);
    // Legacy contract: a no-contact-default mission seeds a crashSite with >= 3 enemies.
    expect(generateOperation(campaign).enemyCount).toBeGreaterThanOrEqual(3);
  });
});
