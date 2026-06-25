import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  createUfoContact,
  executeInterceptionAction,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import {
  CAMPAIGN_STORAGE_KEY,
  clearCampaign,
  createCampaign,
  loadCampaign,
  saveCampaign,
  STARTING_FLEET,
} from "../src/campaign/storage";
import type { ActiveFlight, CampaignClock, CampaignState, Craft, UfoContact } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

/** REFUEL_PER_HOUR / FUEL_BURN_PER_DEG / ENCOUNTER_FUEL_PER_ATTACK mirror geoscape.ts. */
const REFUEL_PER_HOUR = 10;
const FUEL_BURN_PER_DEG = 0.5;
const ENCOUNTER_FUEL_PER_ATTACK = 5;
const FUEL_RESERVE_FRACTION = 0.2;
const MAX_FUEL = 100;

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

function clockAt(elapsedHours: number, overrides: Partial<CampaignClock> = {}): CampaignClock {
  return {
    day: 1 + Math.floor(elapsedHours / 24),
    hour: Math.floor(elapsedHours) % 24,
    elapsedHours,
    lastContactHour: overrides.lastContactHour ?? 0,
    lastFundingHour: overrides.lastFundingHour ?? 0,
  };
}

/** Replace a single craft in the fleet (by id) with a patched copy. */
function patchCraft(campaign: CampaignState, craftId: string, patch: Partial<Craft>): CampaignState {
  const fleet = (campaign.fleet ?? []).map((craft) =>
    craft.id === craftId ? { ...craft, ...patch } : craft,
  );
  return { ...campaign, fleet };
}

/** A tracked crashSite contact parked at (lat, lon) that survives past the test window. */
function trackedContactAt(lat: number, lon: number, region: string): UfoContact {
  return {
    id: "UFO-FUEL-TEST",
    status: "tracked",
    missionType: "crashSite",
    lat,
    lon,
    region,
    detectedAtHour: 10,
    expiresAtHour: 200,
    missionSeed: 1,
    strength: 1,
    heading: 45,
    speed: 0.5,
  };
}

function craft(campaign: CampaignState, craftId: string): Craft {
  const found = (campaign.fleet ?? []).find((entry) => entry.id === craftId);
  if (!found) throw new Error(`craft ${craftId} not in fleet`);
  return found;
}

/** Strongly-typed fuel reader: every campaign in these tests carries explicit fuel. */
function fuelOf(campaign: CampaignState, craftId: string): number {
  const fuel = craft(campaign, craftId).fuel;
  if (typeof fuel !== "number") throw new Error(`fuel missing on ${craftId}`);
  return fuel;
}

/**
 * The vitest environment is "node" (no localStorage), so the save/load path is a
 * dead branch there. Install a minimal shim on globalThis to exercise fuel
 * normalization end to end.
 */
function installLocalStorageShim(): void {
  const store = new Map<string, string>();
  const shim: Storage = {
    get length(): number {
      return store.size;
    },
    clear(): void {
      store.clear();
    },
    getItem(key: string): string | null {
      return store.has(key) ? store.get(key)! : null;
    },
    key(index: number): string | null {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      store.delete(key);
    },
    setItem(key: string, value: string): void {
      store.set(key, String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", { value: shim, configurable: true, writable: true });
}

beforeEach(() => {
  installLocalStorageShim();
});

afterEach(() => {
  clearCampaign();
  // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

// ===========================================================================
// 0. STARTING STATE — every starting craft is fueled to capacity
// ===========================================================================

describe("starting fuel", () => {
  it("gives every starting craft a full tank (fuel === maxFuel === 100)", () => {
    expect(STARTING_FLEET.every((craft) => craft.fuel === 100 && craft.maxFuel === 100)).toBe(true);

    const campaign = freshCampaign();
    expect(campaign.fleet!.every((craft) => craft.fuel === 100 && craft.maxFuel === 100)).toBe(true);
  });
});

// ===========================================================================
// 1. FLIGHT BURN — a craft in transit consumes fuel proportional to distance
// ===========================================================================

describe("flight fuel burn", () => {
  it("burns fuel from the engaging craft as it travels (38 deg leg, 2h @ 5 deg/h)", () => {
    // A return leg coming home: from lat 40 -> base lat 2, same longitude => 38 deg arc.
    const returnFlight: ActiveFlight = {
      id: "return:int-1:0",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: 40,
      fromLon: BASE.lon,
      toLat: BASE.lat,
      toLon: BASE.lon,
      progress: 0,
      speedDegPerHour: 5,
      startedAtHour: 10,
    };
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
      activeFlights: [returnFlight],
    };

    const advanced = advanceGeoscape(start, 2);
    // Distance covered = min(5 * 2, 38) = 10 deg; burn = 10 * 0.5 = 5.
    expect(fuelOf(advanced, "int-1")).toBeCloseTo(MAX_FUEL - 10 * FUEL_BURN_PER_DEG, 3);
    expect(fuelOf(advanced, "int-1")).toBeLessThan(MAX_FUEL);
    // A grounded craft (int-2) neither burns nor refuels beyond full here.
    expect(fuelOf(advanced, "int-2")).toBe(MAX_FUEL);
  });

  it("does not burn fuel when no craft is airborne", () => {
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
      activeFlights: [],
    };
    const advanced = advanceGeoscape(start, 2);
    expect(fuelOf(advanced, "int-1")).toBe(MAX_FUEL);
  });
});

// ===========================================================================
// 2. AUTO-RETURN — a craft at/below the reserve fraction turns back for base
// ===========================================================================

describe("low-fuel auto-return", () => {
  it("converts a low-fuel patrol into a return-to-base flight while the UFO is still tracked", () => {
    const patrol: ActiveFlight = {
      id: "patrol:int-1:UFO-LOW",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: 40,
      toLon: BASE.lon,
      progress: 0.1,
      speedDegPerHour: 5,
      startedAtHour: 10,
    };
    const start: CampaignState = {
      ...patchCraft(freshCampaign(), "int-1", { fuel: 15 }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(40, BASE.lon, "Africa"),
      activeFlights: [patrol],
    };

    const advanced = advanceGeoscape(start, 1);
    const int1Flight = (advanced.activeFlights ?? []).find((flight) => flight.craftId === "int-1");
    expect(int1Flight).toBeDefined();
    // The patrol was recalled because int-1 sat below the 20% reserve.
    expect(int1Flight!.id.startsWith("return:")).toBe(true);
    expect(int1Flight!.toLat).toBe(BASE.lat);
    expect(int1Flight!.toLon).toBe(BASE.lon);
  });

  it("keeps a well-fueled patrol on station when the UFO is still tracked", () => {
    const patrol: ActiveFlight = {
      id: "patrol:int-1:UFO-OK",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: 40,
      toLon: BASE.lon,
      progress: 0.1,
      speedDegPerHour: 5,
      startedAtHour: 10,
    };
    const start: CampaignState = {
      ...freshCampaign(),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(40, BASE.lon, "Africa"),
      activeFlights: [patrol],
    };

    const advanced = advanceGeoscape(start, 1);
    const int1Flight = (advanced.activeFlights ?? []).find((flight) => flight.craftId === "int-1");
    expect(int1Flight).toBeDefined();
    expect(int1Flight!.id.startsWith("patrol:")).toBe(true);
  });

  it("treats the reserve threshold exactly at the boundary as low fuel", () => {
    // fuel === 20 is exactly 20% of maxFuel 100 => reserve boundary, recall.
    const patrol: ActiveFlight = {
      id: "patrol:int-1:UFO-EDGE",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: 40,
      toLon: BASE.lon,
      progress: 0.5,
      speedDegPerHour: 5,
      startedAtHour: 10,
    };
    const start: CampaignState = {
      ...patchCraft(freshCampaign(), "int-1", { fuel: MAX_FUEL * FUEL_RESERVE_FRACTION }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(40, BASE.lon, "Africa"),
      activeFlights: [patrol],
    };

    const advanced = advanceGeoscape(start, 1);
    const int1Flight = (advanced.activeFlights ?? []).find((flight) => flight.craftId === "int-1");
    expect(int1Flight!.id.startsWith("return:")).toBe(true);
  });
});

// ===========================================================================
// 3. REFUEL — a craft sitting in the hangar refills over time, capped at maxFuel
// ===========================================================================

describe("hangar refuel", () => {
  it("refuels a grounded craft proportional to elapsed hours", () => {
    const start: CampaignState = {
      ...patchCraft(freshCampaign(), "int-1", { fuel: 50 }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
      activeFlights: [],
    };

    const advanced = advanceGeoscape(start, 3);
    expect(fuelOf(advanced, "int-1")).toBe(50 + REFUEL_PER_HOUR * 3);
    // Other grounded crafts stay topped up.
    expect(fuelOf(advanced, "int-2")).toBe(MAX_FUEL);
    expect(fuelOf(advanced, "sky-1")).toBe(MAX_FUEL);
  });

  it("caps refuel at maxFuel", () => {
    const start: CampaignState = {
      ...patchCraft(freshCampaign(), "int-1", { fuel: 95 }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
      activeFlights: [],
    };

    const advanced = advanceGeoscape(start, 3);
    expect(fuelOf(advanced, "int-1")).toBe(MAX_FUEL);
  });

  it("does not refuel an airborne craft", () => {
    const returnFlight: ActiveFlight = {
      id: "return:int-1:0",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: 40,
      fromLon: BASE.lon,
      toLat: BASE.lat,
      toLon: BASE.lon,
      progress: 0,
      speedDegPerHour: 5,
      startedAtHour: 10,
    };
    const start: CampaignState = {
      ...patchCraft(freshCampaign(), "int-1", { fuel: 40 }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: undefined,
      activeFlights: [returnFlight],
    };

    const advanced = advanceGeoscape(start, 1);
    // int-1 is airborne: it only burns fuel, never refuels.
    const int1 = craft(advanced, "int-1");
    expect(int1.fuel).toBeLessThan(40);
  });
});

// ===========================================================================
// 4. INTERCEPTION — each Attack round burns fuel from the engaging interceptor
// ===========================================================================

describe("interception fuel burn", () => {
  function engagingCampaign(): CampaignState {
    const campaign = freshCampaign();
    const contact = createUfoContact(campaign, 18, "crashSite");
    const staged: CampaignState = {
      ...campaign,
      clock: { ...campaign.clock, elapsedHours: 18 },
      ufoContact: contact,
    };
    const engaging = startInterceptionEncounter(staged);
    expect(engaging.interception).toBeDefined();
    expect(engaging.ufoContact!.status).toBe("engaging");
    return engaging;
  }

  it("burns fuel from the engaging interceptor on each Attack round", () => {
    const engaging = engagingCampaign();
    const fuelBefore = fuelOf(engaging, "int-1");

    const afterAttack = executeInterceptionAction(engaging, "attack");
    // Round resolved without a kill (strong UFO, fresh interceptor) — encounter persists.
    expect(afterAttack.interception).toBeDefined();
    expect(afterAttack.interception!.roundsElapsed).toBe(1);
    // The engaging interceptor (int-1) paid one Attack round's worth of fuel.
    expect(fuelOf(afterAttack, "int-1")).toBe(fuelBefore - ENCOUNTER_FUEL_PER_ATTACK);
  });

  it("does not burn fuel on a Close round", () => {
    const engaging = engagingCampaign();
    const fuelBefore = fuelOf(engaging, "int-1");

    const afterClose = executeInterceptionAction(engaging, "close");
    expect(afterClose.interception).toBeDefined();
    expect(fuelOf(afterClose, "int-1")).toBe(fuelBefore);
  });

  it("accumulates fuel burn across consecutive Attack rounds", () => {
    const engaging = engagingCampaign();
    const fuelBefore = fuelOf(engaging, "int-1");

    const first = executeInterceptionAction(engaging, "attack");
    const second = executeInterceptionAction(first, "attack");
    // Both rounds resolved (encounter may still be live); int-1 paid twice.
    expect(fuelOf(second, "int-1")).toBe(fuelBefore - ENCOUNTER_FUEL_PER_ATTACK * 2);
  });
});

// ===========================================================================
// 5. LOAD NORMALIZATION — fuel/maxFuel normalize on load (default full)
// ===========================================================================

describe("fuel load normalization", () => {
  it("defaults a missing fuel level to a full tank on load", () => {
    const campaign = freshCampaign();
    const raw = JSON.parse(JSON.stringify(campaign)) as CampaignState;
    const int1Raw = raw.fleet!.find((entry) => entry.id === "int-1")!;
    delete int1Raw.fuel;
    delete int1Raw.maxFuel;
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(raw));

    const loaded = loadCampaign()!;
    const int1 = craft(loaded, "int-1");
    expect(int1.fuel).toBe(MAX_FUEL);
    expect(int1.maxFuel).toBe(MAX_FUEL);
  });

  it("preserves an explicit fuel level across save/load", () => {
    const campaign = patchCraft(freshCampaign(), "int-2", { fuel: 37 });
    saveCampaign(campaign);

    const loaded = loadCampaign()!;
    expect(craft(loaded, "int-2").fuel).toBe(37);
    expect(craft(loaded, "int-2").maxFuel).toBe(MAX_FUEL);
  });

  it("clamps an out-of-range fuel level into [0, maxFuel] on load", () => {
    const campaign = freshCampaign();
    const raw = JSON.parse(JSON.stringify(campaign)) as CampaignState;
    raw.fleet!.find((entry) => entry.id === "int-1")!.fuel = 250;
    raw.fleet!.find((entry) => entry.id === "int-2")!.fuel = -5;
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(raw));

    const loaded = loadCampaign()!;
    expect(craft(loaded, "int-1").fuel).toBe(MAX_FUEL);
    expect(craft(loaded, "int-2").fuel).toBe(0);
  });
});

// ===========================================================================
// 6. DETERMINISM — identical inputs advance to identical fuel state
// ===========================================================================

describe("fuel determinism", () => {
  it("advances fuel identically for identical inputs", () => {
    const patrol: ActiveFlight = {
      id: "patrol:int-1:UFO-DET",
      craftId: "int-1",
      kind: "interceptor",
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: 35,
      toLon: 30,
      progress: 0.2,
      speedDegPerHour: 4,
      startedAtHour: 10,
    };
    const build = (): CampaignState => ({
      ...patchCraft(freshCampaign(), "int-1", { fuel: 60 }),
      clock: clockAt(10, { lastContactHour: 10 }),
      ufoContact: trackedContactAt(35, 30, "Africa"),
      activeFlights: [patrol],
    });

    const a = advanceGeoscape(build(), 5);
    const b = advanceGeoscape(build(), 5);
    expect(a.fleet).toEqual(b.fleet);
    expect(a.activeFlights).toEqual(b.activeFlights);
  });
});
