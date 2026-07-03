import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  canResolveInterception,
  executeInterceptionAction,
  interceptionForecast,
  interceptionSpeedAdvantage,
  startInterceptionEncounter,
  UFO_TYPE_PROFILES,
} from "../src/campaign/geoscape";
import {
  CAMPAIGN_STORAGE_KEY,
  canStartManufacturing,
  chooseInterceptor,
  completeResearch,
  craftHullPoints,
  craftSpeedDegPerHour,
  craftWeaponPower,
  createCampaign,
  DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR,
  loadCampaign,
  manufacturingDuration,
  readyInterceptors,
  saveCampaign,
  startManufacturing,
} from "../src/campaign/storage";
import type { ActiveFlight, CampaignState, Craft, UfoContact } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;
// (4, 22) is on land (Africa), so a forced-down UFO seeds an assaultable crash site.
const LAND_LAT = 4;
const LAND_LON = 22;

function richCampaign(seed = SEED): CampaignState {
  return {
    ...createCampaign(BASE, seed),
    resources: { credits: 8000, alloys: 400, elerium: 200, alienData: 200 },
  };
}

/** A tracked crash-site contact of the given UFO type, parked on land, ready to intercept. */
function trackedContact(
  ufoType: UfoContact["ufoType"],
  elapsedHours: number,
  overrides: Partial<UfoContact> = {},
): UfoContact {
  const profile = UFO_TYPE_PROFILES[ufoType!];
  return {
    id: `UFO-${ufoType}`,
    status: "tracked",
    missionType: "crashSite",
    ufoType,
    lat: LAND_LAT,
    lon: LAND_LON,
    region: "Africa",
    detectedAtHour: elapsedHours,
    expiresAtHour: elapsedHours + profile.lifetimeHours,
    missionSeed: 0x1234,
    strength: profile.strength,
    heading: 45,
    speed: profile.speed,
    ...overrides,
  };
}

function withContact(campaign: CampaignState, contact: UfoContact): CampaignState {
  return {
    ...campaign,
    clock: { ...campaign.clock, elapsedHours: contact.detectedAtHour },
    ufoContact: contact,
    interception: undefined,
    // Clear any leftover patrols so a fresh scramble is unambiguous.
    activeFlights: [],
  };
}

// ---------------------------------------------------------------------------
// localStorage shim (node test env has none)
// ---------------------------------------------------------------------------
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

// ===========================================================================
// 1. SPEED / COMBAT FIELDS ROUND-TRIP SAVE/LOAD
// ===========================================================================

describe("craft speed + combat stats round-trip save/load", () => {
  beforeEach(() => installLocalStorageShim());
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("preserves the starting Raptor cruise speed and an advanced craft's speed/hull/weapon stats", () => {
    const phantom: Craft = {
      id: "phantom-1",
      kind: "interceptor",
      name: "Phantom",
      damage: 0,
      sorties: 0,
      fuel: 120,
      maxFuel: 120,
      speedDegPerHour: 1.6,
      hullPoints: 140,
      weaponPower: 1.5,
    };
    const campaign: CampaignState = {
      ...createCampaign(BASE, SEED),
      fleet: [...createCampaign(BASE, SEED).fleet!, phantom],
    };

    saveCampaign(campaign);
    const loaded = loadCampaign();
    expect(loaded).not.toBeNull();

    const raptor = loaded!.fleet!.find((craft) => craft.id === "int-1")!;
    expect(raptor.speedDegPerHour).toBe(0.9);

    const restored = loaded!.fleet!.find((craft) => craft.id === "phantom-1")!;
    expect(restored.speedDegPerHour).toBe(1.6);
    expect(restored.hullPoints).toBe(140);
    expect(restored.weaponPower).toBe(1.5);
  });

  it("keeps a manufactured Phantom's stats through a save/load after it takes a sortie", () => {
    // Build the Phantom for real, damage it in an encounter, then round-trip it.
    let campaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    campaign = startManufacturing(campaign, "phantom");
    campaign = advanceGeoscape(campaign, manufacturingDuration(campaign, "phantom"));
    const built = campaign.fleet!.find((craft) => craft.name === "Phantom")!;
    // A sortie must not wipe the per-craft stats (the field-list gotcha).
    const damaged = withContact(campaign, trackedContact("scout", campaign.clock.elapsedHours));
    const started = startInterceptionEncounter(damaged);
    const afterOne = executeInterceptionAction(started, "attack");

    saveCampaign(afterOne);
    const loaded = loadCampaign()!;
    const restored = loaded.fleet!.find((craft) => craft.name === "Phantom");
    expect(restored).toBeDefined();
    expect(restored!.speedDegPerHour).toBe(built.speedDegPerHour);
    expect(restored!.hullPoints).toBe(built.hullPoints);
    expect(restored!.weaponPower).toBe(built.weaponPower);
  });
});

// ===========================================================================
// 2. RUBBER-BAND GONE — patrol cruise speed = the assigned craft's OWN stat
// ===========================================================================

describe("patrol speed comes from the assigned craft (no rubber-band)", () => {
  it("launches a Raptor patrol at the Raptor's own 0.9 deg/h regardless of UFO speed", () => {
    // A slow harvester and a fast battleship both yield the SAME patrol speed — the
    // craft's own cruise — proving the speed is no longer proportional to the UFO's.
    const slow = advanceGeoscape(
      withContact({ ...createCampaign(BASE, SEED), clock: { ...createCampaign(BASE, SEED).clock, lastContactHour: 10 } }, trackedContact("harvester", 10)),
      1,
    );
    const fast = advanceGeoscape(
      withContact({ ...createCampaign(BASE, SEED), clock: { ...createCampaign(BASE, SEED).clock, lastContactHour: 10 } }, trackedContact("battleship", 10)),
      1,
    );
    const patrolSlow = (slow.activeFlights ?? []).find((f) => f.id.startsWith("patrol:"));
    const patrolFast = (fast.activeFlights ?? []).find((f) => f.id.startsWith("patrol:"));
    expect(patrolSlow?.speedDegPerHour).toBe(0.9);
    expect(patrolFast?.speedDegPerHour).toBe(0.9);
  });

  it("scrambles the fastest ready craft and flies the patrol at its own speed", () => {
    let campaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    campaign = startManufacturing(campaign, "phantom");
    campaign = advanceGeoscape(campaign, manufacturingDuration(campaign, "phantom"));
    const withUfo = withContact(campaign, trackedContact("scout", campaign.clock.elapsedHours));
    const advanced = advanceGeoscape(withUfo, 1);
    const patrol = (advanced.activeFlights ?? []).find((f) => f.id.startsWith("patrol:"));
    expect(patrol).toBeDefined();
    // The Phantom (1.6) is the fastest ready craft, so it scrambles at its own speed.
    expect(patrol!.craftId).toBe(chooseInterceptor(withUfo)!.id);
    expect(patrol!.speedDegPerHour).toBe(1.6);
  });
});

// ===========================================================================
// 2b. KIND-AWARE SPEED DEFAULT — a fieldless craft cruises at its KIND's default
// ===========================================================================

describe("craftSpeedDegPerHour falls back per craft kind", () => {
  it("defaults a legacy transport to the Skyranger cruise (0.7), not the interceptor 0.9", () => {
    const transport: Craft = { id: "sky-legacy", kind: "transport", name: "Skyranger", damage: 0, sorties: 0 };
    const interceptor: Craft = { id: "int-legacy", kind: "interceptor", name: "Raptor", damage: 0, sorties: 0 };
    expect(craftSpeedDegPerHour(transport)).toBe(0.7);
    expect(craftSpeedDegPerHour(interceptor)).toBe(0.9);
  });
});

// ===========================================================================
// 3. interceptionSpeedAdvantage classification
// ===========================================================================

describe("interceptionSpeedAdvantage classification", () => {
  it("classifies each UFO type against a starting Raptor (0.9 deg/h)", () => {
    const c = createCampaign(BASE, SEED);
    expect(interceptionSpeedAdvantage(c, trackedContact("scout", 0))).toBe("advantage");
    expect(interceptionSpeedAdvantage(c, trackedContact("harvester", 0))).toBe("advantage");
    expect(interceptionSpeedAdvantage(c, trackedContact("terror", 0))).toBe("outrun");
    expect(interceptionSpeedAdvantage(c, trackedContact("battleship", 0))).toBe("outrun");
    // A UFO within ±5% of the craft's speed is a matched chase.
    const matched = trackedContact("scout", 0, { speed: DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR });
    expect(interceptionSpeedAdvantage(c, matched)).toBe("matched");
  });

  it("flips a battleship to 'advantage' once a Phantom is the fastest ready craft", () => {
    let campaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    campaign = startManufacturing(campaign, "phantom");
    campaign = advanceGeoscape(campaign, manufacturingDuration(campaign, "phantom"));
    expect(interceptionSpeedAdvantage(campaign, trackedContact("battleship", 0))).toBe("advantage");
  });
});

// ===========================================================================
// 4. STERN CHASE — a Raptor is outrun by a battleship: range opens, UFO escapes
// ===========================================================================

describe("stern chase: a Raptor cannot catch a battleship", () => {
  it("opens the range on every attack and finally lets the battleship escape", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("battleship", 18));
    let state = startInterceptionEncounter(campaign);
    expect(state.interception?.range).toBe(3);

    const ranges: number[] = [];
    let guard = 0;
    while (canResolveInterception(state) && guard < 20) {
      state = executeInterceptionAction(state, "attack");
      if (state.interception) ranges.push(state.interception.range);
      guard += 1;
    }

    // The range strictly widened each beat (never closed) until the break-off.
    for (let i = 1; i < ranges.length; i++) {
      expect(ranges[i]!).toBeGreaterThan(ranges[i - 1]!);
    }
    // The UFO escaped — a stern chase lost.
    expect(state.interception).toBeUndefined();
    expect(state.ufoContact).toBeUndefined();
    expect(state.lastInterceptionReport?.result).toBe("escaped");
  });

  it("cannot close the range on a faster UFO — Close only holds station and burns fuel", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("battleship", 18));
    const started = startInterceptionEncounter(campaign);
    const engaging = chooseInterceptor(campaign)!;
    const fuelBefore = campaign.fleet!.find((c) => c.id === engaging.id)!.fuel!;

    const closed = executeInterceptionAction(started, "close");
    // A slower craft physically cannot claw the gap shut: the range holds (honoring the
    // forecast's "cannot be forced down" gate) while the afterburner still burns fuel.
    expect(closed.interception?.range).toBe(3);
    const fuelAfter = closed.fleet!.find((c) => c.id === engaging.id)!.fuel!;
    expect(fuelAfter).toBeLessThan(fuelBefore);
  });
});

// ===========================================================================
// 4b. STERN CHASE — an outrun UFO honors the forecast's "cannot force down" gate
// ===========================================================================

describe("an outrun UFO cannot be forced down interactively", () => {
  it("closes the alternating Attack/Close pin — a terror ship always escapes, never crashes", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("terror", 18));
    // The forecast declares it uncatchable; the interactive encounter must agree.
    expect(interceptionForecast(campaign)?.succeeds).toBe(false);

    let state = startInterceptionEncounter(campaign);
    let guard = 0;
    // Alternating Attack/Close was the exploit that pinned the range at a lethal band.
    while (canResolveInterception(state) && guard < 200) {
      state = executeInterceptionAction(state, guard % 2 === 0 ? "attack" : "close");
      guard += 1;
    }
    expect(state.ufoContact?.status).not.toBe("crashed");
    expect(state.lastInterceptionReport?.result).not.toBe("crashed");
  });

  it("breaks off the pursuit when the engaging craft runs its tank dry", () => {
    // Close against a faster UFO only burns fuel; spamming it must eventually strand the
    // craft (fuel is a real limiter), not spin forever at a clamped-zero tank.
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("battleship", 18));
    let state = startInterceptionEncounter(campaign);
    let guard = 0;
    while (canResolveInterception(state) && guard < 500) {
      state = executeInterceptionAction(state, "close");
      guard += 1;
    }
    expect(guard).toBeLessThan(500); // terminated (broke off), not an unbounded loop
    expect(state.ufoContact?.status).not.toBe("crashed");
  });
});

// ===========================================================================
// 4c. ENGAGING-CRAFT PICK — never a craft committed elsewhere (return leg)
// ===========================================================================

describe("chooseInterceptor stays in lockstep with the craft flying the pursuit", () => {
  it("excludes a Phantom flying home on a return leg and picks the idle Raptor", () => {
    const phantom: Craft = {
      id: "phantom-1",
      kind: "interceptor",
      name: "Phantom",
      damage: 0,
      sorties: 0,
      fuel: 120,
      maxFuel: 120,
      speedDegPerHour: 1.6,
      hullPoints: 140,
      weaponPower: 1.5,
    };
    const base = createCampaign(BASE, SEED);
    const contact = trackedContact("harvester", 18);
    const returnLeg: ActiveFlight = {
      id: `return:phantom-1:18`,
      craftId: "phantom-1",
      kind: "interceptor",
      fromLat: 10,
      fromLon: 10,
      toLat: BASE.lat,
      toLon: BASE.lon,
      progress: 0.3,
      speedDegPerHour: 1.6,
      startedAtHour: 18,
    };
    const campaign: CampaignState = {
      ...base,
      fleet: [...base.fleet!, phantom],
      ufoContact: contact,
      clock: { ...base.clock, elapsedHours: 18 },
      activeFlights: [returnLeg],
    };

    const chosen = chooseInterceptor(campaign)!;
    // The Phantom is committed to a return leg, so it is NOT the engaging craft even
    // though it is the fastest ready hull — the chip/forecast track the Raptor on patrol.
    expect(chosen.id).not.toBe("phantom-1");
    expect(craftSpeedDegPerHour(chosen)).toBe(0.9);
    // Advantage is computed against the Raptor (0.9 vs harvester 0.55), not the Phantom.
    expect(interceptionSpeedAdvantage(campaign, contact)).toBe("advantage");
  });

  it("does pick the Phantom once it is flying THIS contact's patrol", () => {
    const phantom: Craft = {
      id: "phantom-1",
      kind: "interceptor",
      name: "Phantom",
      damage: 0,
      sorties: 0,
      fuel: 120,
      maxFuel: 120,
      speedDegPerHour: 1.6,
      hullPoints: 140,
      weaponPower: 1.5,
    };
    const base = createCampaign(BASE, SEED);
    const contact = trackedContact("terror", 18);
    const patrol: ActiveFlight = {
      id: `patrol:phantom-1:${contact.id}`,
      craftId: "phantom-1",
      kind: "interceptor",
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: contact.lat,
      toLon: contact.lon,
      progress: 0.5,
      speedDegPerHour: 1.6,
      startedAtHour: 18,
    };
    const campaign: CampaignState = {
      ...base,
      fleet: [...base.fleet!, phantom],
      ufoContact: contact,
      clock: { ...base.clock, elapsedHours: 18 },
      activeFlights: [patrol],
    };
    expect(chooseInterceptor(campaign)?.id).toBe("phantom-1");
  });
});

// ===========================================================================
// 4d. LEGACY SAVE — a stale per-contact speed is re-derived from ufoType on load
// ===========================================================================

describe("legacy save migration: stale contact speed does not invert the air war", () => {
  beforeEach(() => installLocalStorageShim());
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  function reloadWithStaleContact(contact: UfoContact): CampaignState {
    const base = createCampaign(BASE, SEED);
    const staged = {
      ...base,
      clock: { ...base.clock, elapsedHours: 5, lastContactHour: 5 },
      ufoContact: contact,
    };
    // Bypass save-side normalization: persist the raw pre-retune blob, then load it.
    localStorage.setItem(CAMPAIGN_STORAGE_KEY, JSON.stringify(JSON.parse(JSON.stringify(staged))));
    return loadCampaign()!;
  }

  it("re-classifies a pre-retune scout (old speed 1.4) as catchable, not 'outrun'", () => {
    const loaded = reloadWithStaleContact({ ...trackedContact("scout", 5), speed: 1.4 });
    // The denormalized copy is dropped; the live scout profile (0.7) wins.
    expect(loaded.ufoContact?.speed).toBeUndefined();
    expect(interceptionSpeedAdvantage(loaded, loaded.ufoContact!)).toBe("advantage");
    expect(interceptionForecast(loaded)?.succeeds).toBe(true);
  });

  it("re-classifies a pre-retune battleship (old speed 0.15) as 'outrun', not trivially caught", () => {
    const loaded = reloadWithStaleContact({ ...trackedContact("battleship", 5), speed: 0.15 });
    expect(interceptionSpeedAdvantage(loaded, loaded.ufoContact!)).toBe("outrun");
    expect(interceptionForecast(loaded)?.succeeds).toBe(false);
  });
});

// ===========================================================================
// 5. PROGRESSION — research -> manufacture -> Phantom joins fleet -> wins chase
// ===========================================================================

describe("Phantom progression arc", () => {
  it("gates the Phantom behind alienPropulsion research and a free hangar slot", () => {
    const base = richCampaign();
    expect(canStartManufacturing(base, "phantom")).toBe(false); // needs research
    const withBio = completeResearch(base, "alienBiotech");
    expect(canStartManufacturing(withBio, "phantom")).toBe(false); // still needs propulsion
    const ready = completeResearch(withBio, "alienPropulsion");
    expect(canStartManufacturing(ready, "phantom")).toBe(true);
  });

  it("manufactures a Phantom that joins the fleet and becomes the chosen interceptor", () => {
    let campaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    const fleetBefore = campaign.fleet!.length;
    campaign = startManufacturing(campaign, "phantom");
    expect(campaign.activeManufacturing?.projectId).toBe("phantom");
    campaign = advanceGeoscape(campaign, manufacturingDuration(campaign, "phantom"));

    const phantom = campaign.fleet!.find((craft) => craft.name === "Phantom");
    expect(phantom).toBeDefined();
    expect(campaign.fleet!.length).toBe(fleetBefore + 1);
    expect(craftSpeedDegPerHour(phantom!)).toBe(1.6);
    expect(craftHullPoints(phantom!)).toBe(140);
    expect(craftWeaponPower(phantom!)).toBe(1.5);
    // The fastest ready craft is scrambled for interception.
    expect(readyInterceptors(campaign).some((c) => c.id === phantom!.id)).toBe(true);
    expect(chooseInterceptor(campaign)!.id).toBe(phantom!.id);
  });

  it("beats the very battleship chase a Raptor loses", () => {
    // Same battleship contact, two fleets: Raptor-only loses, Phantom wins.
    const battleship = trackedContact("battleship", 40);

    // Raptor-only: stern chase -> escape.
    const raptorRun = withContact(createCampaign(BASE, SEED), battleship);
    let rState = startInterceptionEncounter(raptorRun);
    let guard = 0;
    while (canResolveInterception(rState) && guard < 20) {
      rState = executeInterceptionAction(rState, "attack");
      guard += 1;
    }
    expect(rState.lastInterceptionReport?.result).toBe("escaped");

    // Phantom: advantage -> close then hammer -> forced down.
    let phantomCampaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    phantomCampaign = startManufacturing(phantomCampaign, "phantom");
    phantomCampaign = advanceGeoscape(phantomCampaign, manufacturingDuration(phantomCampaign, "phantom"));
    const phantomRun = withContact(phantomCampaign, { ...battleship, detectedAtHour: phantomCampaign.clock.elapsedHours, expiresAtHour: phantomCampaign.clock.elapsedHours + 96 });
    expect(interceptionSpeedAdvantage(phantomRun, phantomRun.ufoContact!)).toBe("advantage");

    let pState = startInterceptionEncounter(phantomRun);
    guard = 0;
    while (canResolveInterception(pState) && guard < 40) {
      const range = pState.interception!.range;
      pState = executeInterceptionAction(pState, range > 0 ? "close" : "attack");
      guard += 1;
    }
    expect(pState.ufoContact?.status).toBe("crashed");
    expect(pState.lastInterceptionReport?.result).toBe("crashed");
  });
});
