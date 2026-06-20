import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  createUfoContact,
  CRASH_SITE_LIFETIME_HOURS,
  formatCampaignClock,
  interceptUfo,
} from "../src/campaign/geoscape";
import { isLand } from "../src/campaign/landMask";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignClock, CampaignState, UfoContact } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

/** Clock whose day/hour are derived consistently with clockAt for a given elapsedHours. */
function clockAtElapsed(elapsedHours: number, overrides: Partial<CampaignClock> = {}): CampaignClock {
  return {
    day: 1 + Math.floor(elapsedHours / 24),
    hour: Math.floor(elapsedHours) % 24,
    elapsedHours,
    lastContactHour: overrides.lastContactHour ?? 0,
    lastFundingHour: overrides.lastFundingHour ?? 0,
  };
}

/** A minimal tracked crashSite contact parked at (lat, lon) with a low strength (guaranteed crash). */
function trackedContactAt(lat: number, lon: number, region: string): UfoContact {
  return {
    id: "UFO-TEST",
    status: "tracked",
    missionType: "crashSite",
    lat,
    lon,
    region,
    detectedAtHour: 10,
    expiresAtHour: 40,
    missionSeed: 1,
    strength: 1,
    heading: 45,
    speed: 0.5,
  };
}

// ===========================================================================
// 1. MINUTE CLOCK — formatCampaignClock derives HH:MM from fractional elapsedHours
// ===========================================================================

describe("formatCampaignClock — minute granularity", () => {
  it.each([
    [0, "Day 1 00:00"],
    [1.5, "Day 1 01:30"],
    [6, "Day 1 06:00"],
    [23.75, "Day 1 23:45"],
    [25.25, "Day 2 01:15"],
    [48.5, "Day 3 00:30"],
  ])("derives HH:MM from elapsedHours %s h", (elapsedHours, expected) => {
    expect(formatCampaignClock(clockAtElapsed(elapsedHours))).toBe(expected);
  });

  it("shows :30 after advancing a fresh campaign by a fractional 1.5 hours", () => {
    const advanced = advanceGeoscape(freshCampaign(), 1.5);
    expect(advanced.clock.elapsedHours).toBe(1.5);
    expect(formatCampaignClock(advanced.clock)).toBe("Day 1 01:30");
  });
});

// ===========================================================================
// 2. FRACTIONAL ADVANCE — clock advances + funding/expiry still fire at thresholds
// ===========================================================================

describe("advanceGeoscape — fractional hours keep events deterministic", () => {
  it("advances elapsedHours by the fractional amount", () => {
    const start = freshCampaign();
    const advanced = advanceGeoscape(start, 2.25);
    expect(advanced.clock.elapsedHours).toBe(2.25);
    expect(advanced.clock.hour).toBe(2);
  });

  it("fires a funding report exactly when the fractional clock reaches the 720h threshold", () => {
    // Park the campaign a half-hour short of the first funding report (lastFundingHour 0 + 720h).
    const elapsedHours = 719.5;
    const near: CampaignState = {
      ...freshCampaign(),
      clock: clockAtElapsed(elapsedHours, { lastContactHour: elapsedHours, lastFundingHour: 0 }),
      ufoContact: undefined,
    };
    // A fractional advance that stays below the threshold must NOT fire.
    const heldBelow = advanceGeoscape(near, 0.4);
    expect(heldBelow.clock.elapsedHours).toBe(719.9);
    expect(heldBelow.lastFundingReport).toBeUndefined();
    expect(heldBelow.clock.lastFundingHour).toBe(0);
    // Crossing the threshold by a fractional half-hour fires exactly one report.
    const crossed = advanceGeoscape(near, 0.5);
    expect(crossed.clock.elapsedHours).toBe(720);
    expect(crossed.lastFundingReport).toBeDefined();
    expect(crossed.clock.lastFundingHour).toBe(720);
    expect(crossed.lastFundingReport?.completedAtHour).toBe(720);
  });

  it("expires a tracked contact only once elapsedHours crosses its fractional expiry", () => {
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAtElapsed(10, { lastContactHour: 10 }),
      ufoContact: { ...trackedContactAt(10, 10, "Africa"), expiresAtHour: 10.5 },
    };
    // 0.4h short of the fractional expiry: contact still present.
    const heldBelow = advanceGeoscape(start, 0.4);
    expect(heldBelow.clock.elapsedHours).toBe(10.4);
    expect(heldBelow.ufoContact).toBeDefined();
    // Reaching the fractional 10.5h expiry crosses the (<=) boundary and clears it.
    const expired = advanceGeoscape(start, 0.5);
    expect(expired.clock.elapsedHours).toBe(10.5);
    expect(expired.ufoContact).toBeUndefined();
  });
});

// ===========================================================================
// 3. UFO FLIGHT — tracked contacts fly along a deterministic heading/speed
// ===========================================================================

describe("tracked UFO flight", () => {
  it("gives a tracked crashSite contact a deterministic heading and speed", () => {
    const contact = createUfoContact(freshCampaign(), 10, "crashSite");
    expect(contact.status).toBe("tracked");
    expect(typeof contact.heading).toBe("number");
    expect(contact.heading).toBeGreaterThanOrEqual(0);
    expect(contact.heading).toBeLessThan(360);
    expect(typeof contact.speed).toBe("number");
    expect(contact.speed).toBeGreaterThan(0);
    // Recreating from the same inputs yields the identical flight vector.
    const again = createUfoContact(freshCampaign(), 10, "crashSite");
    expect(again.heading).toBe(contact.heading);
    expect(again.speed).toBe(contact.speed);
  });

  it("leaves ground-assault contacts without a flight vector (they hold position)", () => {
    const landed = createUfoContact(freshCampaign(), 10, "landedUfo");
    expect(landed.status).toBe("landed");
    expect(landed.heading).toBeUndefined();
    expect(landed.speed).toBeUndefined();
  });

  it("moves a tracked contact's lat/lon over time and stays deterministic", () => {
    const detected = createUfoContact(freshCampaign(), 10, "crashSite");
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAtElapsed(10, { lastContactHour: 10 }),
      ufoContact: detected,
    };

    const moved = advanceGeoscape(start, 6);
    const movedContact = moved.ufoContact;
    expect(movedContact).toBeDefined();
    expect(movedContact?.status).toBe("tracked");
    // The flight vector is preserved through the advance.
    expect(movedContact?.heading).toBe(detected.heading);
    expect(movedContact?.speed).toBe(detected.speed);
    // The position drifted from the detection point (at least one coord changed).
    const dLat = Math.abs(movedContact!.lat - detected.lat);
    const dLon = Math.abs(movedContact!.lon - detected.lon);
    expect(dLat + dLon).toBeGreaterThan(0);
    // The strategic region stays anchored to the detection site.
    expect(movedContact?.region).toBe(detected.region);

    // Determinism: identical inputs advance to an identical position.
    const movedAgain = advanceGeoscape(start, 6);
    expect(movedAgain.ufoContact?.lat).toBe(movedContact?.lat);
    expect(movedAgain.ufoContact?.lon).toBe(movedContact?.lon);
  });
});

// ===========================================================================
// 4. OCEAN CRASH — shot down over ocean = lost at sea; over land = assaultable
// ===========================================================================

describe("ocean vs land crash outcome", () => {
  it("marks a UFO shot down over the ocean as lost at sea (immediate expiry, not assaultable)", () => {
    expect(isLand(0, -160)).toBe(false); // sanity: open ocean
    const start: CampaignState = { ...freshCampaign(), ufoContact: trackedContactAt(0, -160, "Oceania") };
    const crash = interceptUfo(start);
    expect(crash.ufoContact?.status).toBe("crashed");
    expect(crash.ufoContact?.overOcean).toBe(true);
    expect(crash.ufoContact?.expiresAtHour).toBe(start.clock.elapsedHours);
    expect(crash.lastInterceptionReport?.summary).toContain("lost at sea");
  });

  it("keeps the crash-site lifetime for a UFO forced down over land", () => {
    expect(isLand(4, 22)).toBe(true); // sanity: land
    const start: CampaignState = { ...freshCampaign(), ufoContact: trackedContactAt(4, 22, "Africa") };
    const crash = interceptUfo(start);
    expect(crash.ufoContact?.status).toBe("crashed");
    expect(crash.ufoContact?.overOcean).toBe(false);
    expect(crash.ufoContact?.expiresAtHour).toBe(start.clock.elapsedHours + CRASH_SITE_LIFETIME_HOURS);
    expect(crash.lastInterceptionReport?.summary).toContain("forced down");
    expect(crash.lastInterceptionReport?.summary).not.toContain("lost at sea");
  });
});
