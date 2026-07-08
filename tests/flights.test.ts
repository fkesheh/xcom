import { describe, expect, it } from "vitest";

import { advanceGeoscape, makePatrolFlight } from "../src/campaign/geoscape";
import { createCampaign } from "../src/campaign/storage";
import type { ActiveFlight, CampaignClock, CampaignState, UfoContact } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

/** Clock whose day/hour derive from elapsedHours, consistent with the sim's clockAt. */
function clockAt(elapsedHours: number, overrides: Partial<CampaignClock> = {}): CampaignClock {
  return {
    day: 1 + Math.floor(elapsedHours / 24),
    hour: Math.floor(elapsedHours) % 24,
    elapsedHours,
    lastContactHour: overrides.lastContactHour ?? 0,
    lastFundingHour: overrides.lastFundingHour ?? 0,
  };
}

/** A minimal tracked crashSite contact parked at (lat, lon) with a low strength. */
function trackedContactAt(
  lat: number,
  lon: number,
  region: string,
  opts: { speed?: number; expiresAtHour?: number } = {},
): UfoContact {
  return {
    id: "UFO-FLIGHT-TEST",
    status: "tracked",
    missionType: "crashSite",
    lat,
    lon,
    region,
    detectedAtHour: 10,
    expiresAtHour: opts.expiresAtHour ?? 40,
    missionSeed: 1,
    strength: 1,
    heading: 45,
    speed: opts.speed ?? 0.5,
  };
}

function patrolOf(state: CampaignState): ActiveFlight | undefined {
  return (state.activeFlights ?? []).find((flight) => flight.id.startsWith("patrol:"));
}

/** Seed a manual patrol (player Intercept path) — geoscape no longer auto-scrambles. */
function withManualPatrol(state: CampaignState): CampaignState {
  const contact = state.ufoContact;
  const craft = (state.fleet ?? []).find((c) => c.kind === "interceptor");
  if (!contact || !craft) return state;
  return { ...state, activeFlights: [makePatrolFlight(craft, state, contact)] };
}

// ===========================================================================
// 1. NO AUTO-SCRAMBLE — craft stay in hangar until the player hits Intercept
// ===========================================================================

describe("active patrol flights", () => {
  it("does not auto-launch an interceptor when a UFO is merely tracked", () => {
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(4, 22, "Africa"),
    };

    const advanced = advanceGeoscape(start, 1);
    expect(patrolOf(advanced)).toBeUndefined();
    expect(advanced.activeFlights ?? []).toEqual([]);
  });

  it("advances a player-launched patrol toward the tracked UFO", () => {
    const start = withManualPatrol({
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(4, 22, "Africa"),
    });

    const advanced = advanceGeoscape(start, 1);
    const patrol = patrolOf(advanced);
    expect(patrol).toBeDefined();
    expect(patrol!.craftId).toMatch(/^int-/);
    expect(patrol!.kind).toBe("interceptor");
    expect(patrol!.fromLat).toBe(BASE.lat);
    expect(patrol!.fromLon).toBe(BASE.lon);
    expect(patrol!.toLat).toBe(advanced.ufoContact!.lat);
    expect(patrol!.toLon).toBe(advanced.ufoContact!.lon);
    expect(patrol!.speedDegPerHour).toBe(36.2);
    expect(patrol!.progress).toBeGreaterThanOrEqual(0);
    expect(patrol!.progress).toBeLessThan(1);
  });

  it("does not spawn a second patrol while one is already airborne", () => {
    const start = withManualPatrol({
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(4, 22, "Africa"),
    });
    const first = advanceGeoscape(start, 1);
    const second = advanceGeoscape(first, 1);
    const patrols = (second.activeFlights ?? []).filter((flight) =>
      flight.id.startsWith("patrol:"),
    );
    expect(patrols.length).toBe(1);
  });

  it("does not launch a patrol while no UFO is tracked", () => {
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
    };
    const advanced = advanceGeoscape(start, 1);
    expect(advanced.activeFlights ?? []).toEqual([]);
  });
});

// ===========================================================================
// 2. DETERMINISM — identical inputs advance to identical flight state
// ===========================================================================

describe("flight advance determinism", () => {
  it("advances a patrol deterministically (identical inputs -> identical flights)", () => {
    const start = withManualPatrol({
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(20, 20, "Africa"),
    });

    const a = advanceGeoscape(start, 3);
    const b = advanceGeoscape(start, 3);
    expect(a.activeFlights).toEqual(b.activeFlights);

    const patrol = patrolOf(a);
    expect(patrol).toBeDefined();
    expect(patrol!.progress).toBeGreaterThan(0);
    expect(patrol!.progress).toBeLessThan(1);
  });
});

// ===========================================================================
// 3. ARRIVAL — a flight reaching progress >= 1 is removed
// ===========================================================================

describe("flight arrival", () => {
  it("removes a flight once its progress reaches 1", () => {
    // A return leg almost home: ~1.4 deg of arc left, cruising at 5 deg/hour.
    const almostHome: ActiveFlight = {
      id: "return:int-1:0",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: BASE.lat + 1,
      fromLon: BASE.lon + 1,
      toLat: BASE.lat,
      toLon: BASE.lon,
      progress: 0.98,
      speedDegPerHour: 5,
      startedAtHour: 0,
    };
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      activeFlights: [almostHome],
      ufoContact: undefined,
    };

    const advanced = advanceGeoscape(start, 1);
    expect(advanced.activeFlights ?? []).toEqual([]);
  });
});

// ===========================================================================
// 4. RETURN TO BASE — a patrol turns home when its UFO expires
// ===========================================================================

describe("patrol return to base", () => {
  it("converts a patrol into a return-to-base flight when the UFO expires", () => {
    const start = withManualPatrol({
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(20, 20, "Africa", { expiresAtHour: 14 }),
    });

    // First leg: UFO still tracked (now hour 12) -> patrol advances.
    const patrolling = advanceGeoscape(start, 2);
    const patrol = patrolOf(patrolling);
    expect(patrol).toBeDefined();

    // Second leg: UFO expires (12 + 2 = 14 <= 14) -> the patrol turns for home.
    const returned = advanceGeoscape(patrolling, 2);
    const back = (returned.activeFlights ?? []).find((flight) => flight.craftId === patrol!.craftId);
    expect(back).toBeDefined();
    expect(back!.id.startsWith("return:")).toBe(true);
    expect(back!.toLat).toBe(BASE.lat);
    expect(back!.toLon).toBe(BASE.lon);
    expect(back!.progress).toBeGreaterThanOrEqual(0);
    expect(back!.progress).toBeLessThan(1);
    // No patrol remains once the UFO is gone.
    expect(patrolOf(returned)).toBeUndefined();
  });
});
