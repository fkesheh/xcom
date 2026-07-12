import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  autoResolveInterception,
  canResolveInterception,
  executeInterceptionAction,
  interceptionForecast,
  interceptionSpeedAdvantage,
  interceptUfo,
  makePatrolFlight,
  startInterceptionEncounter,
  UFO_TYPE_PROFILES,
} from "../src/campaign/geoscape";
import {
  CAMPAIGN_STORAGE_KEY,
  canStartManufacturing,
  chooseInterceptor,
  completeFacilityConstruction,
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
  // Classic starter packs 3 craft into 3 hangars — free a fourth berth so
  // Phantom fabrication tests aren't blocked by hangar capacity.
  return completeFacilityConstruction(
    {
      ...createCampaign(BASE, seed),
      resources: { credits: 8000, alloys: 400, elerium: 200, alienData: 200 },
    },
    "hangar-4",
  );
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
      speedDegPerHour: 64.3,
      hullPoints: 140,
      weaponPower: 1.5,
      loadout: ["avalanche", "stingray", "cannon"],
    };
    const campaign: CampaignState = {
      ...createCampaign(BASE, SEED),
      fleet: [...createCampaign(BASE, SEED).fleet!, phantom],
    };

    saveCampaign(campaign);
    const loaded = loadCampaign();
    expect(loaded).not.toBeNull();

    const raptor = loaded!.fleet!.find((craft) => craft.id === "int-1")!;
    expect(raptor.speedDegPerHour).toBe(36.2);
    // The air-combat loadout is a new Craft field — it must survive the reload
    // (the loadCampaign field-list gotcha), not be silently dropped.
    expect(raptor.loadout).toEqual(["stingray", "cannon"]);

    const restored = loaded!.fleet!.find((craft) => craft.id === "phantom-1")!;
    expect(restored.speedDegPerHour).toBe(64.3);
    expect(restored.hullPoints).toBe(140);
    expect(restored.weaponPower).toBe(1.5);
    expect(restored.loadout).toEqual(["avalanche", "stingray", "cannon"]);
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
    expect(restored!.loadout).toEqual(["avalanche", "stingray", "cannon"]);
  });
});

// ===========================================================================
// 2. RUBBER-BAND GONE — patrol cruise speed = the assigned craft's OWN stat
// ===========================================================================

describe("patrol speed comes from the assigned craft (no rubber-band)", () => {
  it("builds a Raptor patrol at the Raptor's own 36.2 deg/h regardless of UFO speed", () => {
    // A slow harvester and a fast battleship both yield the SAME patrol speed — the
    // craft's own cruise — proving the speed is no longer proportional to the UFO's.
    // (Geoscape no longer auto-scrambles; makePatrolFlight is the Intercept seed.)
    const base = createCampaign(BASE, SEED);
    const craft = (base.fleet ?? []).find((c) => c.kind === "interceptor")!;
    const slowContact = trackedContact("harvester", 10);
    const fastContact = trackedContact("battleship", 10);
    expect(makePatrolFlight(craft, withContact(base, slowContact), slowContact).speedDegPerHour).toBe(36.2);
    expect(makePatrolFlight(craft, withContact(base, fastContact), fastContact).speedDegPerHour).toBe(36.2);
  });

  it("builds a Phantom patrol at the Phantom's own speed when it is the engaging craft", () => {
    let campaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    campaign = startManufacturing(campaign, "phantom");
    campaign = advanceGeoscape(campaign, manufacturingDuration(campaign, "phantom"));
    const withUfo = withContact(campaign, trackedContact("scout", campaign.clock.elapsedHours));
    const phantom = chooseInterceptor(withUfo)!;
    const patrol = makePatrolFlight(phantom, withUfo, withUfo.ufoContact!);
    expect(patrol.craftId).toBe(phantom.id);
    expect(patrol.speedDegPerHour).toBe(64.3);
  });
});

// ===========================================================================
// 2b. KIND-AWARE SPEED DEFAULT — a fieldless craft cruises at its KIND's default
// ===========================================================================

describe("craftSpeedDegPerHour falls back per craft kind", () => {
  it("defaults a legacy transport to the retuned Skyranger cruise (24.6), not the interceptor 36.2", () => {
    const transport: Craft = { id: "sky-legacy", kind: "transport", name: "Skyranger", damage: 0, sorties: 0 };
    const interceptor: Craft = { id: "int-legacy", kind: "interceptor", name: "Raptor", damage: 0, sorties: 0 };
    expect(craftSpeedDegPerHour(transport)).toBe(24.6);
    expect(craftSpeedDegPerHour(interceptor)).toBe(36.2);
  });
});

// ===========================================================================
// 3. interceptionSpeedAdvantage classification
// ===========================================================================

describe("interceptionSpeedAdvantage classification", () => {
  it("classifies each UFO type against a starting Raptor (36.2 deg/h)", () => {
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
  it("is a losing stern chase — the gap opens and the battleship escapes", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("battleship", 18));
    const started = startInterceptionEncounter(campaign);
    // A battleship (54.3) outruns a Raptor (36.2): a negative closing speed, phase pursuit.
    expect(started.interception?.phase).toBe("pursuit");
    expect(started.interception!.closingSpeedKmH).toBeLessThan(0);

    const { campaign: state, outcome } = autoResolveInterception(started);
    expect(outcome.kind).toBe("escaped");
    expect(state.interception).toBeUndefined();
    expect(state.ufoContact).toBeUndefined();
    expect(state.lastInterceptionReport?.result).toBe("escaped");
    // A faster UFO escaped before the interceptor ever reached the combat envelope.
    // No hostile shot was exchanged, so a pure stern chase must not create repair damage.
    expect(state.lastInterceptionReport?.interceptorDamage).toBe(0);
    expect(state.fleet?.find((craft) => craft.id === "int-1")?.damage).toBe(0);
  });

  it("keepChasing never closes the gap on a faster UFO — it only opens or breaks off", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("battleship", 18));
    const started = startInterceptionEncounter(campaign);
    const rangeBefore = started.interception!.rangeKm;

    const chased = executeInterceptionAction(started, "keepChasing");
    if (chased.interception) {
      // Still in the chase: the range grew, never shrank.
      expect(chased.interception.rangeKm).toBeGreaterThanOrEqual(rangeBefore);
    } else {
      // Or it already broke off — a stern chase lost, never a crash.
      expect(chased.lastInterceptionReport?.result).toBe("escaped");
    }
  });
});

// ===========================================================================
// 4b. STERN CHASE — an outrun UFO honors the forecast's "cannot force down" gate
// ===========================================================================

describe("an outrun UFO cannot be forced down", () => {
  it("a terror ship always escapes, never crashes, however you press it", () => {
    const campaign = withContact(createCampaign(BASE, SEED), trackedContact("terror", 18));
    // The forecast declares it uncatchable; the encounter must agree.
    expect(interceptionForecast(campaign)?.succeeds).toBe(false);

    let state = startInterceptionEncounter(campaign);
    let guard = 0;
    // Any mix of pressing the chase / closing / firing still ends in an escape.
    while (canResolveInterception(state) && guard < 500) {
      const action = guard % 3 === 0 ? "attack" : guard % 3 === 1 ? "keepChasing" : "close";
      state = executeInterceptionAction(state, action);
      guard += 1;
    }
    expect(guard).toBeLessThan(500); // terminated, not an unbounded loop
    expect(state.ufoContact?.status).not.toBe("crashed");
    expect(state.lastInterceptionReport?.result).not.toBe("crashed");
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
      speedDegPerHour: 64.3,
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
      speedDegPerHour: 64.3,
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
    expect(craftSpeedDegPerHour(chosen)).toBe(36.2);
    // Advantage is computed against the Raptor (36.2 vs harvester 22.1), not the Phantom.
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
      speedDegPerHour: 64.3,
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
      speedDegPerHour: 64.3,
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
    // The denormalized copy is dropped; the live scout profile (28.2) wins.
    expect(loaded.ufoContact?.speed).toBeUndefined();
    expect(interceptionSpeedAdvantage(loaded, loaded.ufoContact!)).toBe("advantage");
    expect(interceptionForecast(loaded)?.succeeds).toBe(true);
  });

  it("re-classifies a pre-retune battleship (old speed 0.15) as 'outrun', not trivially caught", () => {
    const loaded = reloadWithStaleContact({ ...trackedContact("battleship", 5), speed: 0.15 });
    expect(interceptionSpeedAdvantage(loaded, loaded.ufoContact!)).toBe("outrun");
    expect(interceptionForecast(loaded)?.succeeds).toBe(false);
  });

  it("migrates a legacy transport persisted at the old 0.7 cruise up to the new 24.6 default", () => {
    const base = createCampaign(BASE, SEED);
    const legacyFleet = (base.fleet ?? []).map((craft) =>
      craft.kind === "transport" ? { ...craft, speedDegPerHour: 0.7 } : craft,
    );
    localStorage.setItem(
      CAMPAIGN_STORAGE_KEY,
      JSON.stringify(JSON.parse(JSON.stringify({ ...base, fleet: legacyFleet }))),
    );
    const loaded = loadCampaign()!;
    const transport = loaded.fleet!.find((craft) => craft.kind === "transport")!;
    // The stale 0.7 is dropped (below the legacy floor), so the craft re-reads the retuned default.
    expect(craftSpeedDegPerHour(transport)).toBe(24.6);
    // A non-legacy (faster) transport speed is preserved, not clobbered.
    const fastFleet = (base.fleet ?? []).map((craft) =>
      craft.kind === "transport" ? { ...craft, speedDegPerHour: 30 } : craft,
    );
    localStorage.setItem(
      CAMPAIGN_STORAGE_KEY,
      JSON.stringify(JSON.parse(JSON.stringify({ ...base, fleet: fastFleet }))),
    );
    const fast = loadCampaign()!.fleet!.find((craft) => craft.kind === "transport")!;
    expect(craftSpeedDegPerHour(fast)).toBe(30);
  });
});

// ===========================================================================
// 5. PROGRESSION — research -> manufacture -> Phantom joins fleet -> wins chase
// ===========================================================================

describe("Phantom progression arc", () => {
  it("gates the Phantom behind alienPropulsion research and a free hangar slot", () => {
    const base = richCampaign();
    // richCampaign already frees a hangar — strip it to prove the slot gate.
    const full = {
      ...createCampaign(BASE, SEED),
      resources: { credits: 8000, alloys: 400, elerium: 200, alienData: 200 },
    };
    expect(canStartManufacturing(full, "phantom")).toBe(false); // needs research + hangar
    const withBio = completeResearch(full, "alienBiotech");
    expect(canStartManufacturing(withBio, "phantom")).toBe(false); // still needs propulsion
    const researched = completeResearch(withBio, "alienPropulsion");
    expect(canStartManufacturing(researched, "phantom")).toBe(false); // hangars full
    expect(canStartManufacturing(base, "phantom")).toBe(false); // rich has hangar but not research
    const ready = completeResearch(completeResearch(base, "alienBiotech"), "alienPropulsion");
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
    expect(craftSpeedDegPerHour(phantom!)).toBe(64.3);
    expect(craftHullPoints(phantom!)).toBe(140);
    expect(craftWeaponPower(phantom!)).toBe(1.5);
    // The fastest ready craft is scrambled for interception.
    expect(readyInterceptors(campaign).some((c) => c.id === phantom!.id)).toBe(true);
    expect(chooseInterceptor(campaign)!.id).toBe(phantom!.id);
  });

  it("beats the very battleship chase a Raptor loses", () => {
    // Same battleship contact, two fleets: Raptor-only loses, Phantom wins.
    const battleship = trackedContact("battleship", 40);

    // Raptor-only: outrun -> stern chase -> escape.
    const raptorRun = withContact(createCampaign(BASE, SEED), battleship);
    const rState = interceptUfo(raptorRun);
    expect(rState.lastInterceptionReport?.result).toBe("escaped");

    // Phantom: fast enough to run it down -> ZOOM -> forced down.
    let phantomCampaign = completeResearch(completeResearch(richCampaign(), "alienBiotech"), "alienPropulsion");
    phantomCampaign = startManufacturing(phantomCampaign, "phantom");
    phantomCampaign = advanceGeoscape(phantomCampaign, manufacturingDuration(phantomCampaign, "phantom"));
    const phantomRun = withContact(phantomCampaign, { ...battleship, detectedAtHour: phantomCampaign.clock.elapsedHours, expiresAtHour: phantomCampaign.clock.elapsedHours + 96 });
    expect(interceptionSpeedAdvantage(phantomRun, phantomRun.ufoContact!)).toBe("advantage");
    expect(startInterceptionEncounter(phantomRun).interception!.closingSpeedKmH).toBeGreaterThan(0);

    const pState = interceptUfo(phantomRun);
    expect(pState.ufoContact?.status).toBe("crashed");
    expect(pState.lastInterceptionReport?.result).toBe("crashed");
  });
});
