import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  activeFlightPosition,
  autoResolveInterception,
  canLaunchInterceptor,
  canResolveInterception,
  createUfoContact,
  executeInterceptionAction,
  ENGAGEMENT_RANGE_KM,
  fireWeapon,
  GEOSCAPE_SCAN_HOURS,
  interceptionRangeKm,
  interceptUfo,
  POINT_BLANK_KM,
  startInterceptionEncounter,
  UFO_AGILITY,
  UFO_TYPE_PROFILES,
} from "../src/campaign/geoscape";
import { AIR_WEAPONS, airWeapon, ammoFor, craftLoadout, evasionChance } from "../src/campaign/airWeapons";
import { canDeployToOperationSite, generateOperation } from "../src/campaign/operations";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignState, Craft, DifficultyLevel, MissionType, UfoContact } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;
// (4, 22) is land (Africa): a UFO forced down there seeds an assaultable crash site.
const LAND_LAT = 4;
const LAND_LON = 22;

function freshCampaign(seed = SEED): CampaignState {
  return createCampaign(BASE, seed);
}

function withDifficulty(campaign: CampaignState, difficulty: DifficultyLevel): CampaignState {
  return { ...campaign, strategic: { ...campaign.strategic, difficulty } };
}

const PHANTOM: Craft = {
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

/** A tracked crash-site contact of a given UFO type at a chosen position. */
function trackedContact(
  ufoType: NonNullable<UfoContact["ufoType"]>,
  lat: number,
  lon: number,
  overrides: Partial<UfoContact> = {},
): UfoContact {
  const profile = UFO_TYPE_PROFILES[ufoType];
  return {
    id: `UFO-${ufoType}`,
    status: "tracked",
    missionType: "crashSite",
    ufoType,
    lat,
    lon,
    region: "Africa",
    detectedAtHour: 18,
    expiresAtHour: 18 + profile.lifetimeHours,
    missionSeed: 0x1234,
    strength: profile.strength,
    heading: 45,
    speed: profile.speed,
    ...overrides,
  };
}

/** Stage a campaign around a contact with no leftover patrols (unambiguous range). */
function stage(campaign: CampaignState, contact: UfoContact, extraFleet: Craft[] = []): CampaignState {
  return {
    ...campaign,
    fleet: [...campaign.fleet!, ...extraFleet],
    clock: { ...campaign.clock, elapsedHours: contact.detectedAtHour },
    ufoContact: contact,
    interception: undefined,
    activeFlights: [],
  };
}

/** Drive an encounter's pursuit act to THE ZOOM (engagement), returning the engaged state. */
function toEngagement(state: CampaignState): CampaignState {
  let s = state;
  let guard = 0;
  while (s.interception?.phase === "pursuit" && guard < 200) {
    s = executeInterceptionAction(s, "keepChasing");
    guard += 1;
  }
  return s;
}

// ===========================================================================
// 1. WEAPON DATA MODEL — catalog + loadouts
// ===========================================================================

describe("air-combat weapon catalog + loadouts", () => {
  it("pins the frozen catalog numbers", () => {
    expect(AIR_WEAPONS.avalanche).toMatchObject({ cls: "heavy", rangeKm: 95, damage: 60, shots: 2, lockBeats: 3, canVaporize: true });
    expect(AIR_WEAPONS.stingray).toMatchObject({ cls: "light", rangeKm: 65, damage: 28, shots: 5, canVaporize: false });
    expect(AIR_WEAPONS.cannon).toMatchObject({ cls: "cannon", rangeKm: 10, damage: 12, shots: 40, canVaporize: false });
    expect(airWeapon("nope")).toBeUndefined();
  });

  it("gives a Raptor stingray+cannon and a Phantom avalanche+stingray(6)+cannon", () => {
    const raptor = freshCampaign().fleet!.find((c) => c.id === "int-1")!;
    expect(raptor.loadout).toEqual(["stingray", "cannon"]);
    const raptorLoad = craftLoadout(raptor);
    expect(raptorLoad.map((w) => w.id)).toEqual(["stingray", "cannon"]);
    expect(ammoFor(raptorLoad)).toEqual({ stingray: 5, cannon: 40 });

    const phantomLoad = craftLoadout(PHANTOM);
    expect(phantomLoad.map((w) => w.id)).toEqual(["avalanche", "stingray", "cannon"]);
    // The heavy platform runs a deeper Stingray magazine (6 vs 5).
    expect(ammoFor(phantomLoad)).toEqual({ avalanche: 2, stingray: 6, cannon: 40 });

    // A transport never carries an air-to-air loadout.
    const skyranger = freshCampaign().fleet!.find((c) => c.kind === "transport")!;
    expect(craftLoadout(skyranger)).toEqual([]);
  });

  it("scales evasion UP with range and hull agility (dramatic long-range jinks)", () => {
    // A jinky scout at max Avalanche reach approaches the 0.9 cap; a battleship at
    // point-blank cannon range is a barn (near-zero dodge).
    expect(evasionChance(UFO_AGILITY.scout, 95, AIR_WEAPONS.avalanche)).toBeCloseTo(0.9, 5);
    const barn = evasionChance(UFO_AGILITY.battleship, 8, AIR_WEAPONS.cannon);
    expect(barn).toBeLessThan(0.1);
    // Same weapon: closer range dodges less than farther range.
    expect(evasionChance(UFO_AGILITY.scout, 20, AIR_WEAPONS.stingray)).toBeLessThan(
      evasionChance(UFO_AGILITY.scout, 60, AIR_WEAPONS.stingray),
    );
  });
});

// ===========================================================================
// 2. ENCOUNTER START — pursuit vs engagement, seeded ammo + agility
// ===========================================================================

describe("startInterceptionEncounter (km model)", () => {
  it("begins a PURSUIT at the real km gap for a distant contact", () => {
    const detected = stage(freshCampaign(), trackedContact("scout", LAND_LAT, LAND_LON));
    expect(canResolveInterception(detected)).toBe(false);

    const started = startInterceptionEncounter(detected);
    const enc = started.interception!;
    expect(started.ufoContact?.status).toBe("engaging");
    expect(canResolveInterception(started)).toBe(true);
    expect(enc.contactId).toBe(detected.ufoContact?.id);
    expect(enc.phase).toBe("pursuit");
    expect(enc.rangeKm).toBeGreaterThan(ENGAGEMENT_RANGE_KM);
    expect(enc.rangeKm).toBeCloseTo(interceptionRangeKm(detected), 5);
    expect(enc.closingSpeedKmH).toBeGreaterThan(0); // a Raptor catches a scout
    expect(enc.ufoHp).toBe(enc.ufoHpMax);
    expect(enc.ufoHpMax).toBe(20 + detected.ufoContact!.strength * 10);
    expect(enc.ammo).toEqual({ stingray: 5, cannon: 40 });
    expect(enc.ufoAgility).toBe(UFO_AGILITY.scout);
    expect(enc.roundsElapsed).toBe(0);
    expect(enc.log).toContain("Interception engaged");
  });

  it("drops straight into ENGAGEMENT when the interceptor is already within 100km", () => {
    // ~47km from base -> already at the zoom threshold.
    const near = stage(freshCampaign(), trackedContact("scout", 2.3, 14.5));
    const started = startInterceptionEncounter(near);
    expect(started.interception?.phase).toBe("engagement");
    expect(started.interception?.rangeKm).toBeLessThanOrEqual(ENGAGEMENT_RANGE_KM);
  });
});

// ===========================================================================
// 3. PURSUIT ACT — keep chasing closes to THE ZOOM (or the UFO outruns you)
// ===========================================================================

describe("pursuit act (globe km)", () => {
  it("launches a physical interceptor and closes the chase as strategic time advances", () => {
    const started = startInterceptionEncounter(stage(freshCampaign(), trackedContact("scout", LAND_LAT, LAND_LON)));
    const launched = started.activeFlights?.find((flight) => flight.id.startsWith("patrol:"));
    expect(launched).toBeDefined();
    expect(launched?.purpose).toBe("patrol");
    expect(launched?.progress).toBe(0);

    const advanced = advanceGeoscape(started, 0.05);
    const inFlight = advanced.activeFlights?.find((flight) => flight.id === launched?.id);
    expect(inFlight?.progress).toBeGreaterThan(0);
    expect(advanced.ufoContact?.lat).not.toBe(started.ufoContact?.lat);
    expect(advanced.interception?.rangeKm).toBeLessThan(started.interception!.rangeKm);
  });

  it("closes the gap on keepChasing and crosses into engagement at 100km (THE ZOOM)", () => {
    const started = startInterceptionEncounter(stage(freshCampaign(), trackedContact("scout", LAND_LAT, LAND_LON)));
    const first = executeInterceptionAction(started, "keepChasing");
    expect(first.interception!.rangeKm).toBeLessThan(started.interception!.rangeKm);
    const engaged = toEngagement(started);
    expect(engaged.interception?.phase).toBe("engagement");
    expect(engaged.interception?.rangeKm).toBe(ENGAGEMENT_RANGE_KM);
  });

  it("a stern chase (outrun) opens the gap and the UFO escapes — never crashes", () => {
    // A terror ship (40.2) outruns a Raptor (36.2): closing speed is negative.
    const started = startInterceptionEncounter(stage(freshCampaign(), trackedContact("terror", LAND_LAT, LAND_LON)));
    expect(started.interception!.closingSpeedKmH).toBeLessThan(0);
    const opened = executeInterceptionAction(started, "keepChasing");
    // Either the range opened, or it already broke off (started far past STERN_ESCAPE).
    if (opened.interception) {
      expect(opened.interception.rangeKm).toBeGreaterThanOrEqual(started.interception!.rangeKm);
    }
    const done = autoResolveInterception(started);
    expect(done.outcome.kind).toBe("escaped");
    expect(done.campaign.ufoContact).toBeUndefined();
    expect(done.campaign.lastInterceptionReport?.result).toBe("escaped");
  });

  it("turns a resolved interceptor sortie into a visible return leg", () => {
    const contact = trackedContact("scout", LAND_LAT, LAND_LON);
    const patrol = {
      id: `patrol:int-1:${contact.id}`,
      craftId: "int-1",
      kind: "interceptor" as const,
      fromLat: BASE.lat,
      fromLon: BASE.lon,
      toLat: contact.lat,
      toLon: contact.lon,
      progress: 0.65,
      speedDegPerHour: 36.2,
      startedAtHour: contact.detectedAtHour,
      purpose: "patrol" as const,
    };
    const staged = {
      ...stage(freshCampaign(), contact),
      activeFlights: [patrol],
    };
    const expectedOrigin = activeFlightPosition(patrol);
    const resolved = autoResolveInterception(startInterceptionEncounter(staged)).campaign;
    const returning = resolved.activeFlights?.find((flight) => flight.id.startsWith("return:int-1:"));

    expect(returning).toBeDefined();
    expect(returning?.purpose).toBe("return");
    expect(returning?.fromLat).toBeCloseTo(expectedOrigin.lat, 5);
    expect(returning?.fromLon).toBeCloseTo(expectedOrigin.lon, 5);
    expect(returning?.toLat).toBe(BASE.lat);
    expect(returning?.toLon).toBe(BASE.lon);
    expect(returning?.progress).toBe(0);
  });
});

// ===========================================================================
// 4. ENGAGEMENT ACT — firing weapons, evasion, ammo, return fire
// ===========================================================================

describe("engagement act (dogfight)", () => {
  it("fires a weapon: decrements ammo, elapses a beat, and cannot exceed weapon range", () => {
    const engaged = toEngagement(startInterceptionEncounter(stage(freshCampaign(), trackedContact("harvester", LAND_LAT, LAND_LON))));
    const enc = engaged.interception!;
    // At 100km a Raptor's Stingray (65km) is out of range — an explicit fire no-ops.
    expect(enc.rangeKm).toBe(ENGAGEMENT_RANGE_KM);
    expect(fireWeapon(engaged, "stingray")).toBe(engaged);

    // Close inside Stingray range, then fire it.
    let s = engaged;
    let guard = 0;
    while (s.interception && s.interception.rangeKm > AIR_WEAPONS.stingray.rangeKm && guard < 10) {
      s = executeInterceptionAction(s, "close");
      guard += 1;
    }
    const ammoBefore = s.interception!.ammo.stingray;
    if (ammoBefore === undefined) throw new Error("expected ammo.stingray to be seeded");
    const beatsBefore = s.interception!.roundsElapsed;
    const fired = fireWeapon(s, "stingray");
    expect(fired.interception!.ammo.stingray).toBe(ammoBefore - 1);
    expect(fired.interception!.roundsElapsed).toBe(beatsBefore + 1);
    expect(fired.interception!.log.length).toBeGreaterThan(s.interception!.log.length);
  });

  it("lets the pilot trade range for two beats of defensive countermeasures", () => {
    const engaged = toEngagement(
      startInterceptionEncounter(stage(freshCampaign(), trackedContact("harvester", LAND_LAT, LAND_LON))),
    );
    const closeState: CampaignState = {
      ...engaged,
      interception: { ...engaged.interception!, rangeKm: 10, evasionBeatsLeft: 0 },
    };
    const defensive = executeInterceptionAction(closeState, "evade");
    expect(defensive.interception!.rangeKm).toBeGreaterThan(closeState.interception!.rangeKm);
    expect(defensive.interception!.evasionBeatsLeft).toBe(2);
    expect(defensive.interception!.log.at(-1)).toContain("countermeasures primed");

    // Identical close beat and seed: defensive flying must blunt the UFO snap-fire.
    const protectedClose: CampaignState = {
      ...closeState,
      interception: { ...closeState.interception!, evasionBeatsLeft: 2 },
    };
    const exposed = executeInterceptionAction(closeState, "close");
    const protectedResult = executeInterceptionAction(protectedClose, "close");
    expect(exposed.interception).toBeDefined();
    expect(protectedResult.interception).toBeDefined();
    const exposedDamage = closeState.interception!.interceptorHp - exposed.interception!.interceptorHp;
    const protectedDamage = closeState.interception!.interceptorHp - protectedResult.interception!.interceptorHp;
    expect(exposedDamage).toBeGreaterThan(0);
    expect(protectedDamage).toBeGreaterThan(0);
    expect(protectedDamage).toBeLessThan(exposedDamage);
  });

  it("a heavy missile burns lock beats before the shot leaves the rail", () => {
    // Phantom Avalanche: 3 lock beats -> launches on the 3rd fire beat.
    const engaged = toEngagement(startInterceptionEncounter(stage(freshCampaign(), trackedContact("battleship", LAND_LAT, LAND_LON), [PHANTOM])));
    let s = engaged;
    let guard = 0;
    while (s.interception && s.interception.rangeKm > AIR_WEAPONS.avalanche.rangeKm && guard < 10) {
      s = executeInterceptionAction(s, "close");
      guard += 1;
    }
    const ammoBefore = s.interception!.ammo.avalanche;
    if (ammoBefore === undefined) throw new Error("expected ammo.avalanche to be seeded");
    const lock1 = fireWeapon(s, "avalanche");
    expect(lock1.interception!.lockingWeaponId).toBe("avalanche");
    expect(lock1.interception!.lockBeatsLeft).toBe(2);
    expect(lock1.interception!.ammo.avalanche).toBe(ammoBefore); // no shot yet
    const lock2 = fireWeapon(lock1, "avalanche");
    expect(lock2.interception!.lockBeatsLeft).toBe(1);
    const launched = fireWeapon(lock2, "avalanche");
    // The shot left the rail: ammo spent, lock cleared.
    expect(launched.interception ? launched.interception.ammo.avalanche : ammoBefore - 1).toBe(ammoBefore - 1);
  });
});

// ===========================================================================
// 5. OUTCOMES — crashed{salvageQuality} / vaporized / escaped / brokeOff
// ===========================================================================

describe("interception outcomes", () => {
  it("shoots a UFO down over land into a recoverable crash site carrying salvage quality", () => {
    const start = stage(freshCampaign(), trackedContact("harvester", LAND_LAT, LAND_LON));
    const { campaign: resolved, outcome } = autoResolveInterception(startInterceptionEncounter(start));

    expect(outcome.kind).toBe("crashed");
    expect(outcome.salvageQuality).toBeGreaterThan(0);
    expect(outcome.salvageQuality).toBeLessThanOrEqual(1);
    expect(resolved.ufoContact?.status).toBe("crashed");
    expect(resolved.ufoContact?.salvageQuality).toBe(outcome.salvageQuality);
    expect(resolved.ufoContact?.overOcean).toBe(false);
    expect(resolved.lastInterceptionReport?.outcome).toBe("crashed");
    expect(resolved.lastInterceptionReport?.result).toBe("crashed");
    expect(resolved.lastInterceptionReport?.summary).toContain("forced down");
    expect(resolved.interceptor.sorties).toBe(1);
    expect(resolved.interceptor.damage).toBeGreaterThan(0);
    // The forced-down contact seeds a recoverable crash-site operation.
    const op = generateOperation(resolved);
    expect(op.missionType).toBe("crashSite");
    expect(canDeployToOperationSite(resolved, op)).toBe(true);
  });

  it("VAPORIZES a small hull under heavy ordnance — no crash site, only debris", () => {
    // Phantom Avalanche (90 dmg) at point-blank against a scout (30 HP) leaves no wreck.
    const start = stage(freshCampaign(1), trackedContact("scout", 2.3, 14.5), [PHANTOM]);
    let s = toEngagement(startInterceptionEncounter(start));
    let guard = 0;
    while (s.interception && s.interception.rangeKm > POINT_BLANK_KM + 1 && guard < 20) {
      s = executeInterceptionAction(s, "close");
      guard += 1;
    }
    const creditsBefore = s.resources.credits;
    guard = 0;
    while (s.interception && s.ufoContact?.status === "engaging" && guard < 8) {
      s = fireWeapon(s, "avalanche");
      guard += 1;
    }
    expect(s.lastInterceptionReport?.outcome).toBe("vaporized");
    expect(s.lastInterceptionReport?.salvageQuality).toBe(0);
    // No crash site: the contact is cleared like an escape (nothing to assault).
    expect(s.ufoContact).toBeUndefined();
    // Only a small flat debris credit reward is granted.
    expect(s.resources.credits).toBe(creditsBefore + 30);
    expect(s.interceptor.sorties).toBe(1);
  });

  it("lets an outrun UFO escape and clears the contact", () => {
    const resolved = interceptUfo(stage(freshCampaign(5), trackedContact("terror", 2, 30)));
    expect(resolved.ufoContact).toBeUndefined();
    expect(resolved.lastInterceptionReport?.outcome).toBe("escaped");
    expect(resolved.lastInterceptionReport?.result).toBe("escaped");
    expect(resolved.lastInterceptionReport?.summary).toContain("escaped");
    expect(resolved.interceptor.sorties).toBe(1);
    // An outrun exits from pursuit before return fire can occur.
    expect(resolved.interceptor.damage).toBe(0);
  });

  it("breaks off (interceptor destroyed) when a lopsided hull is lost — UFO gets away", () => {
    // A near-wrecked, cannon-only Raptor must close INSIDE a battleship's return-fire
    // envelope (missiles would kill from safe range) — where its 4% hull is fatal.
    const detected = stage(freshCampaign(), trackedContact("battleship", 2.3, 14.5, { speed: 10 }));
    const fragile: CampaignState = {
      ...detected,
      fleet: detected.fleet!.map((c) =>
        c.id === "int-1" ? { ...c, damage: 96, loadout: ["cannon"] } : c,
      ),
      interceptor: { damage: 96, sorties: 0 },
    };
    const { campaign: resolved, outcome } = autoResolveInterception(startInterceptionEncounter(fragile));
    expect(outcome.kind).toBe("brokeOff");
    expect(resolved.ufoContact).toBeUndefined();
    expect(resolved.lastInterceptionReport?.outcome).toBe("brokeOff");
    expect(resolved.interceptor.damage).toBe(100);
    expect(resolved.interceptor.sorties).toBe(1);
  });

  it("disengages cleanly back to tracked without further damage", () => {
    const started = startInterceptionEncounter(stage(freshCampaign(), trackedContact("scout", LAND_LAT, LAND_LON)));
    const damageBefore = started.interceptor.damage;
    const disengaged = executeInterceptionAction(started, "disengage");
    expect(disengaged.ufoContact?.status).toBe("tracked");
    expect(disengaged.interception).toBeUndefined();
    expect(canResolveInterception(disengaged)).toBe(false);
    expect(disengaged.interceptor.damage).toBe(damageBefore);
    expect(canLaunchInterceptor(disengaged)).toBe(true);
  });

  it("a Phantom runs down and crashes the very battleship a Raptor cannot catch", () => {
    const battleship = trackedContact("battleship", LAND_LAT, LAND_LON);
    const raptorRun = interceptUfo(stage(freshCampaign(), battleship));
    expect(raptorRun.lastInterceptionReport?.result).toBe("escaped");

    const phantomRun = interceptUfo(stage(freshCampaign(), battleship, [PHANTOM]));
    expect(phantomRun.ufoContact?.status).toBe("crashed");
    expect(phantomRun.lastInterceptionReport?.result).toBe("crashed");
  });
});

// ===========================================================================
// 6. AUTO-RESOLVE / interceptUfo harness parity + determinism
// ===========================================================================

describe("headless interceptUfo", () => {
  it("resolves a tracked contact in a single call with no lingering encounter", () => {
    // Month-0 contactInterval is stretched to round(18 * 1.6) = 29h (see the
    // arc-stretch ramp in contactInterval). Seed 98 rolls an easily-interceptable
    // scout at that hour (the default SEED now rolls a UFO that outruns pursuit).
    const detected = advanceGeoscape(freshCampaign(98), 29);
    const intercepted = interceptUfo(detected);
    expect(intercepted.interception).toBeUndefined();
    expect(intercepted.lastInterceptionReport).toBeDefined();
    expect(intercepted.lastInterceptionReport?.result).toBe("crashed");
    expect(intercepted.ufoContact?.status).toBe("crashed");
    expect(intercepted.interceptor.sorties).toBe(1);
    expect(intercepted.lastInterceptionReport?.contactId).toBe(detected.ufoContact?.id);
  });

  it("is deterministic — the same staged contact resolves identically", () => {
    const start = stage(freshCampaign(7), trackedContact("harvester", LAND_LAT, LAND_LON));
    const a = autoResolveInterception(startInterceptionEncounter(start));
    const b = autoResolveInterception(startInterceptionEncounter(start));
    expect(a.outcome).toEqual(b.outcome);
    expect(a.campaign.ufoContact).toEqual(b.campaign.ufoContact);
    expect(a.campaign.lastInterceptionReport).toEqual(b.campaign.lastInterceptionReport);
  });

  it("rejects non-crashSite contacts (ground assaults are not shoot-downs)", () => {
    const campaign = freshCampaign();
    const landed = createUfoContact(campaign, 18, "landedUfo");
    const withLanded: CampaignState = { ...campaign, ufoContact: landed };
    expect(landed.status).toBe("landed");
    expect(canLaunchInterceptor(withLanded)).toBe(false);
    expect(interceptUfo(withLanded)).toBe(withLanded);
    expect(startInterceptionEncounter(withLanded)).toBe(withLanded);
    expect(executeInterceptionAction(withLanded, "attack")).toBe(withLanded);
  });

  it("ignores actions when no encounter is in progress", () => {
    const detected = stage(freshCampaign(), trackedContact("scout", LAND_LAT, LAND_LON));
    expect(executeInterceptionAction(detected, "attack")).toBe(detected);
    expect(executeInterceptionAction(detected, "close")).toBe(detected);
    expect(executeInterceptionAction(detected, "keepChasing")).toBe(detected);
    expect(executeInterceptionAction(detected, "disengage")).toBe(detected);
    expect(fireWeapon(detected, "stingray")).toBe(detected);
  });
});

// ===========================================================================
// 7. SALVAGE -> LOOT — crash quality degrades the recoverable haul + core
// ===========================================================================

describe("salvage quality drives crash-site loot", () => {
  function crashedContactWith(quality: number): CampaignState {
    const c = freshCampaign();
    return {
      ...c,
      ufoContact: {
        ...trackedContact("harvester", LAND_LAT, LAND_LON),
        status: "crashed",
        salvageQuality: quality,
      },
    };
  }

  it("a clean forced landing yields the full haul; a burned wreck yields less and loses the core", () => {
    const clean = generateOperation(crashedContactWith(1)).reward;
    const burned = generateOperation(crashedContactWith(0.3)).reward;

    expect(burned.alloys).toBeLessThan(clean.alloys);
    // Below the core-recovery threshold the elerium core is damaged beyond recovery.
    expect(clean.elerium).toBeGreaterThan(0);
    expect(burned.elerium).toBe(0);
    // Council credits are unaffected by wreck condition.
    expect(burned.credits).toBe(clean.credits);
  });
});

// ===========================================================================
// 8. DIFFICULTY — the dogfight scales with difficulty
// ===========================================================================

describe("difficulty scaling", () => {
  it("stays deterministic per difficulty and remains a valid terminal outcome", () => {
    const runAt = (difficulty: DifficultyLevel): ReturnType<typeof autoResolveInterception> =>
      autoResolveInterception(
        startInterceptionEncounter(stage(withDifficulty(freshCampaign(3), difficulty), trackedContact("terror", LAND_LAT, LAND_LON), [PHANTOM])),
      );
    for (const difficulty of ["rookie", "veteran", "commander"] as const) {
      const a = runAt(difficulty);
      const b = runAt(difficulty);
      expect(a.outcome).toEqual(b.outcome);
      expect(["crashed", "vaporized"]).toContain(a.outcome.kind);
    }
  });
});

// ===========================================================================
// 9. CONTACT MISSION-VARIETY SPAWNING (unchanged model)
// ===========================================================================

describe("contact mission-variety spawning", () => {
  it("defaults createUfoContact to a tracked crashSite contact", () => {
    const contact = createUfoContact(freshCampaign(), 18);
    expect(contact.status).toBe("tracked");
    expect(contact.missionType).toBe("crashSite");
  });

  it("spawns ground assaults in the landed status", () => {
    const campaign = freshCampaign();
    expect(createUfoContact(campaign, 18, "terror").status).toBe("landed");
    expect(createUfoContact(campaign, 18, "baseDefense").status).toBe("landed");
  });

  it("rolls a deterministic mix of mission types across a seeded run", () => {
    const runVariety = (seed: number): MissionType[] => {
      let state = createCampaign(BASE, seed);
      const spawned: MissionType[] = [];
      const seen = new Set<number>();
      for (let i = 0; i < 120; i++) {
        state = advanceGeoscape(state, GEOSCAPE_SCAN_HOURS);
        const contact = state.ufoContact;
        if (contact && !seen.has(contact.detectedAtHour)) {
          seen.add(contact.detectedAtHour);
          spawned.push(contact.missionType ?? "crashSite");
        }
      }
      return spawned;
    };
    expect(runVariety(SEED)).toEqual(runVariety(SEED));
    const types = new Set(runVariety(SEED));
    expect(types.has("crashSite")).toBe(true);
    expect(types.has("landedUfo") || types.has("terror")).toBe(true);
  });
});
