import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  createCampaign,
  recordMissionResult,
  canStartResearch,
  completeResearch,
  canLaunchFinalAssault,
  campaignObjectiveProgress,
  hasContainment,
  loadCampaign,
  saveCampaign,
  CAMPAIGN_VICTORY_OPERATIONS,
  ALIEN_HQ_CREW_SIZE,
  DIFFICULTY_CONFIGS,
  ALIEN_BASE_THEME,
  type MissionCapture,
} from "../src/campaign/storage";
import {
  generateOperation,
  determineMissionType,
  launchFinalAssault,
  alienBaseCrewRanks,
  ufoCrewRanks,
  canDeployToOperationSite,
} from "../src/campaign/operations";
import { CONTAINMENT_FACILITY_ID, CONTAINMENT_CAPACITY } from "../src/campaign/base";
import { isLand } from "../src/campaign/landMask";
import type {
  CampaignState,
  CampaignCaptive,
  CaptiveRank,
  UfoContact,
} from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function withContainment(campaign: CampaignState): CampaignState {
  return { ...campaign, facilities: [...campaign.facilities, CONTAINMENT_FACILITY_ID] };
}

/** Deployed/surviving ids from the starting roster, so roster bookkeeping is well-formed. */
function roster(campaign: CampaignState, n = 4): { deployedSoldierIds: string[]; survivingSoldierIds: string[] } {
  const ids = campaign.soldiers.slice(0, n).map((s) => s.id);
  return { deployedSoldierIds: ids, survivingSoldierIds: ids };
}

function capture(templateId: string, rank: CaptiveRank): MissionCapture {
  return { templateId, rank };
}

/**
 * Drive N successful crash-site operations to advance missionsCompleted. The
 * ops-fallback HQ reveal (and canLaunchFinalAssault) also require the first
 * council report to have fired (lastCouncilMonth >= 1) — stage that directly so
 * these tests can focus on ops/interrogation gating without advancing 30 days.
 */
function winOps(campaign: CampaignState, n: number): CampaignState {
  let c: CampaignState = { ...campaign, lastCouncilMonth: 1 };
  for (let i = 0; i < n; i++) {
    c = recordMissionResult(c, "success", generateOperation(c), {
      ...roster(c),
    });
  }
  return c;
}

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

describe("endgame — HQ seeding", () => {
  it("seeds the alien HQ on a land location, hidden, at campaign creation", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(campaign.alienHq).toBeDefined();
    const hq = campaign.alienHq!;
    expect(hq.revealed).toBe(false);
    expect(typeof hq.location.region).toBe("string");
    expect(hq.location.region.length).toBeGreaterThan(0);
    expect(isLand(hq.location.lat, hq.location.lon)).toBe(true);
  });

  it("seeds the HQ deterministically for a given seed", () => {
    const a = createCampaign(BASE, SEED).alienHq!;
    const b = createCampaign(BASE, SEED).alienHq!;
    expect(a).toEqual(b);
    const different = createCampaign(BASE, SEED + 1).alienHq!;
    expect(different.location).not.toEqual(a.location);
  });
});

describe("endgame — captive intake at debrief", () => {
  it("secures captures as captives when containment is built", () => {
    const campaign = withContainment(createCampaign(BASE, SEED));
    const after = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("sentinel", "navigator"), capture("commander", "commander")],
    });
    expect(after.captives).toHaveLength(2);
    const ranks = after.captives!.map((c) => c.rank).sort();
    expect(ranks).toEqual(["commander", "navigator"]);
    for (const c of after.captives!) {
      expect(typeof c.id).toBe("string");
      expect(c.capturedAtHour).toBe(after.clock.elapsedHours);
    }
    // Debrief surfaces the intake to the UI via the mission summary.
    expect(after.lastMission?.summary).toMatch(/alien/i);
  });

  it("loses all captures when no containment exists", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(hasContainment(campaign)).toBe(false);
    const after = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("sentinel", "navigator")],
    });
    expect(after.captives ?? []).toHaveLength(0);
    expect(after.lastMission?.summary).toMatch(/lost/i);
  });

  it("caps stored captives at containment capacity, losing the excess", () => {
    let campaign = withContainment(createCampaign(BASE, SEED));
    const captures: MissionCapture[] = Array.from({ length: CONTAINMENT_CAPACITY + 3 }, () =>
      capture("drone", "soldier"),
    );
    campaign = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures,
    });
    expect(campaign.captives).toHaveLength(CONTAINMENT_CAPACITY);
    // Ids are unique.
    const ids = new Set(campaign.captives!.map((c) => c.id));
    expect(ids.size).toBe(CONTAINMENT_CAPACITY);
  });

  it("does not intake captures on a failed mission", () => {
    const campaign = withContainment(createCampaign(BASE, SEED));
    const ids = campaign.soldiers.slice(0, 4).map((s) => s.id);
    const after = recordMissionResult(campaign, "failure", generateOperation(campaign), {
      deployedSoldierIds: ids,
      survivingSoldierIds: [],
      captures: [capture("commander", "commander")],
    });
    expect(after.captives ?? []).toHaveLength(0);
  });
});

describe("endgame — captive intake report (findings 4 & 8)", () => {
  it("reports 'no containment facility' when none exists (hadContainment false)", () => {
    const campaign = createCampaign(BASE, SEED);
    const after = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("drone", "soldier"), capture("drone", "soldier")],
    });
    const intake = after.lastCaptiveIntake!;
    expect(intake.hadContainment).toBe(false);
    expect(intake.secured).toHaveLength(0);
    expect(intake.lost).toBe(2);
    expect(after.lastMission?.summary).toMatch(/no containment facility/i);
  });

  it("reports 'containment full (N/8)' when the facility exists but is at capacity", () => {
    // Pre-fill containment to capacity, then capture one more with a facility built.
    const full: CampaignCaptive[] = Array.from({ length: CONTAINMENT_CAPACITY }, (_, i) => ({
      id: `held-${i}`,
      templateId: "drone",
      rank: "soldier" as CaptiveRank,
      capturedAtHour: 0,
    }));
    const campaign = { ...withContainment(createCampaign(BASE, SEED)), captives: full };
    const after = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("drone", "soldier")],
    });
    const intake = after.lastCaptiveIntake!;
    expect(intake.hadContainment).toBe(true);
    expect(intake.secured).toHaveLength(0);
    expect(intake.lost).toBe(1);
    expect(intake.held).toBe(CONTAINMENT_CAPACITY);
    expect(intake.capacity).toBe(CONTAINMENT_CAPACITY);
    expect(after.lastMission?.summary).toMatch(
      new RegExp(`containment full ${CONTAINMENT_CAPACITY}/${CONTAINMENT_CAPACITY}`, "i"),
    );
  });

  it("intake report survives an interrogation consuming a just-secured captive (finding 4)", () => {
    // A leaderInterrogation completing INSIDE recordMissionResult consumes the leader
    // captive secured this very mission — but the intake report still counts it.
    const campaign: CampaignState = {
      ...withContainment(createCampaign(BASE, SEED)),
      activeResearch: { projectId: "leaderInterrogation", startedAtHour: 0, completesAtHour: 0 },
    };
    const after = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("sectoidLeader", "leader")],
    });
    // The research completed and consumed the leader — it's gone from the roster.
    expect(after.completedResearch).toContain("leaderInterrogation");
    expect((after.captives ?? []).some((c) => c.rank === "leader")).toBe(false);
    // ...but the debrief-facing intake report still counts it as secured.
    expect(after.lastCaptiveIntake?.secured.map((s) => s.rank)).toEqual(["leader"]);
    expect(after.lastCaptiveIntake?.lost).toBe(0);
    expect(after.lastMission?.summary).toMatch(/taken alive/i);
  });
});

describe("endgame — ufoContact preservation (finding 5)", () => {
  const LIVE_CONTACT: UfoContact = {
    id: "ufo-live",
    status: "tracked",
    lat: 10,
    lon: 20,
    region: "Europe",
    detectedAtHour: 0,
    expiresAtHour: 9999,
    missionSeed: 1,
    strength: 3,
  };

  it("a normal operation consumes the live UFO contact", () => {
    const campaign = { ...createCampaign(BASE, SEED), ufoContact: { ...LIVE_CONTACT } };
    const op = generateOperation(campaign);
    expect(op.missionType).not.toBe("alienBaseAssault");
    const after = recordMissionResult(campaign, "success", op, { ...roster(campaign) });
    expect(after.ufoContact).toBeUndefined();
  });

  it("the final alien-base assault preserves an unrelated live UFO contact", () => {
    let campaign = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    expect(canLaunchFinalAssault(campaign)).toBe(true);
    const assaultOp = launchFinalAssault(campaign)!;
    expect(assaultOp.missionType).toBe("alienBaseAssault");
    campaign = { ...campaign, ufoContact: { ...LIVE_CONTACT } };
    const after = recordMissionResult(campaign, "success", assaultOp, { ...roster(campaign) });
    expect(after.ufoContact).toEqual(LIVE_CONTACT);
  });
});

describe("endgame — assault bypasses the contact deploy guard (finding 2)", () => {
  const OVER_OCEAN_CRASH: UfoContact = {
    id: "ufo-sea",
    status: "crashed",
    lat: 0,
    lon: -30,
    region: "Atlantic sector",
    detectedAtHour: 0,
    expiresAtHour: 9999,
    missionSeed: 1,
    strength: 3,
    overOcean: true,
  };

  it("refuses a regular op whose crash is lost at sea", () => {
    const campaign = { ...createCampaign(BASE, SEED), ufoContact: { ...OVER_OCEAN_CRASH } };
    const op = generateOperation(campaign);
    expect(op.missionType).not.toBe("alienBaseAssault");
    expect(canDeployToOperationSite(campaign, op)).toBe(false);
  });

  it("launches the final assault even with a stale over-ocean crash contact present", () => {
    let campaign = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    campaign = { ...campaign, ufoContact: { ...OVER_OCEAN_CRASH } };
    const assaultOp = launchFinalAssault(campaign)!;
    expect(assaultOp.missionType).toBe("alienBaseAssault");
    // The over-ocean guard that blocks a regular op is bypassed for the assault.
    expect(canDeployToOperationSite(campaign, assaultOp)).toBe(true);
  });
});

describe("endgame — objective progress states (finding 6)", () => {
  it("HIDDEN: an un-revealed HQ shows the containment objective", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(campaign.alienHq?.revealed).toBe(false);
    const progress = campaignObjectiveProgress(campaign);
    expect(progress.title).toBe("Containment objective");
  });

  it("REVEALED-BUT-LOCKED: a leader-revealed HQ that is not yet launchable prompts a commander interrogation or more ops", () => {
    // Reveal the HQ without unlocking the assault (no commander interrogation, ops < milestone).
    const campaign = {
      ...createCampaign(BASE, SEED),
      alienHq: { ...createCampaign(BASE, SEED).alienHq!, revealed: true },
    };
    expect(canLaunchFinalAssault(campaign)).toBe(false);
    const progress = campaignObjectiveProgress(campaign);
    expect(progress.title).toBe("Alien HQ located");
    expect(progress.summary).toMatch(/interrogate an alien commander/i);
    expect(progress.summary).toMatch(/operation/i);
  });

  it("READY: an unlocked assault shows 'Final assault ready'", () => {
    const campaign = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    expect(canLaunchFinalAssault(campaign)).toBe(true);
    const progress = campaignObjectiveProgress(campaign);
    expect(progress.title).toBe("Final assault ready");
  });
});

describe("endgame — legacy save alienHq backfill (finding 1)", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("backfills a hidden HQ (deterministic) for a legacy save missing alienHq", () => {
    const fresh = createCampaign(BASE, SEED);
    // A pre-endgame save has no alienHq: JSON.stringify drops the undefined key.
    saveCampaign({ ...fresh, alienHq: undefined });
    const loaded = loadCampaign();
    expect(loaded?.alienHq).toBeDefined();
    expect(loaded?.alienHq?.revealed).toBe(false);
    // Re-seeded deterministically from the campaign seed — same location as a fresh campaign.
    expect(loaded?.alienHq?.location).toEqual(fresh.alienHq?.location);
  });

  it("reveals the backfilled HQ when the legacy save already reached the fallback milestone", () => {
    const advanced = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    expect(advanced.missionsCompleted).toBeGreaterThanOrEqual(CAMPAIGN_VICTORY_OPERATIONS);
    saveCampaign({ ...advanced, alienHq: undefined });
    const loaded = loadCampaign();
    expect(loaded?.alienHq?.revealed).toBe(true);
    expect(canLaunchFinalAssault(loaded!)).toBe(true);
  });
});

describe("endgame — interrogation research gating", () => {
  // Generous resources so canAfford never masks the captive-gating under test.
  const RICH = { credits: 5000, alloys: 200, elerium: 200, alienData: 200 } as const;

  function seedCaptives(campaign: CampaignState, ranks: CaptiveRank[]): CampaignState {
    const captives: CampaignCaptive[] = ranks.map((rank, i) => ({
      id: `captive-test-${i}`,
      templateId: rank,
      rank,
      capturedAtHour: 0,
    }));
    return { ...campaign, resources: { ...RICH }, captives };
  }

  function withBiotech(campaign: CampaignState): CampaignState {
    return { ...campaign, completedResearch: ["alienBiotech"] };
  }

  it("blocks alienInterrogation without any captive, allows it with one", () => {
    const base = withBiotech(createCampaign(BASE, SEED));
    expect(canStartResearch(base, "alienInterrogation")).toBe(false);
    const withCaptive = seedCaptives(base, ["soldier"]);
    expect(canStartResearch(withCaptive, "alienInterrogation")).toBe(true);
  });

  it("enforces the leader rank floor (leader or higher qualifies)", () => {
    const base: CampaignState = {
      ...createCampaign(BASE, SEED),
      completedResearch: ["alienBiotech", "alienInterrogation"],
    };
    expect(canStartResearch(seedCaptives(base, ["navigator"]), "leaderInterrogation")).toBe(false);
    expect(canStartResearch(seedCaptives(base, ["leader"]), "leaderInterrogation")).toBe(true);
    expect(canStartResearch(seedCaptives(base, ["commander"]), "leaderInterrogation")).toBe(true);
  });

  it("consumes the lowest qualifying captive and reveals the HQ on leaderInterrogation", () => {
    const base: CampaignState = {
      ...createCampaign(BASE, SEED),
      completedResearch: ["alienBiotech", "alienInterrogation"],
    };
    const staged = seedCaptives(base, ["leader", "commander"]);
    expect(staged.alienHq?.revealed).toBe(false);
    const done = completeResearch(staged, "leaderInterrogation");
    expect(done.completedResearch).toContain("leaderInterrogation");
    // The leader is consumed; the more valuable commander is preserved.
    expect(done.captives).toHaveLength(1);
    expect(done.captives![0]!.rank).toBe("commander");
    expect(done.alienHq?.revealed).toBe(true);
  });

  it("unlocks the final assault when commanderInterrogation completes (HQ revealed)", () => {
    const base: CampaignState = {
      ...createCampaign(BASE, SEED),
      completedResearch: ["alienBiotech", "alienInterrogation", "leaderInterrogation"],
      alienHq: { location: { lat: 10, lon: 10, region: "Africa" }, revealed: true },
      // canLaunchFinalAssault also requires the first council report to have fired
      // (lastCouncilMonth >= 1); stage that directly since this test is about the
      // interrogation-research gate, not council timing.
      lastCouncilMonth: 1,
    };
    expect(canLaunchFinalAssault(base)).toBe(false);
    const staged = seedCaptives(base, ["commander"]);
    const done = completeResearch(staged, "commanderInterrogation");
    expect(done.captives).toHaveLength(0);
    expect(canLaunchFinalAssault(done)).toBe(true);
  });
});

describe("endgame — victory rework and fallback", () => {
  it("no longer wins at 5 operations — instead reveals HQ and unlocks the assault", () => {
    const won = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    expect(won.missionsCompleted).toBe(CAMPAIGN_VICTORY_OPERATIONS);
    expect(won.strategic.status).toBe("active");
    expect(won.alienHq?.revealed).toBe(true);
    expect(canLaunchFinalAssault(won)).toBe(true);
    // A notification is emitted following the project-report pattern.
    expect(won.projectReports.some((r) => /HQ|headquarters/i.test(r.title))).toBe(true);
  });

  it("wins ONLY when the alien-base assault is completed as a player victory", () => {
    const ready = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    const assault = launchFinalAssault(ready);
    expect(assault).toBeDefined();
    expect(assault!.missionType).toBe("alienBaseAssault");
    const after = recordMissionResult(ready, "success", assault!, { ...roster(ready) });
    expect(after.strategic.status).toBe("won");
  });

  it("a lost assault does NOT end the campaign — HQ persists and a retry is allowed", () => {
    const ready = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    const assault = launchFinalAssault(ready)!;
    const ids = ready.soldiers.slice(0, 4).map((s) => s.id);
    const after = recordMissionResult(ready, "failure", assault, {
      deployedSoldierIds: ids,
      survivingSoldierIds: ids.slice(1), // survivors remain -> can still field a squad
    });
    expect(after.strategic.status).toBe("active");
    expect(after.alienHq?.revealed).toBe(true);
    expect(canLaunchFinalAssault(after)).toBe(true);
  });

  it("launchFinalAssault returns undefined when not launchable", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(canLaunchFinalAssault(campaign)).toBe(false);
    expect(launchFinalAssault(campaign)).toBeUndefined();
  });
});

describe("endgame — assault mission generation", () => {
  it("targets the HQ location with the alien-base theme and a large elite crew", () => {
    const ready = winOps(createCampaign(BASE, SEED), CAMPAIGN_VICTORY_OPERATIONS);
    const op = generateOperation(ready, "alienBaseAssault");
    expect(op.missionType).toBe("alienBaseAssault");
    expect(op.themeId).toBe(ALIEN_BASE_THEME);
    expect(op.region).toBe(ready.alienHq!.location.region);
    // The garrison is difficulty-scaled (default campaign is veteran); the boss
    // stays larger than a terror site while remaining retryable.
    expect(op.enemyCount).toBe(DIFFICULTY_CONFIGS.veteran.alienHqCrewSize);
  });

  it("determineMissionType honours an explicit override", () => {
    const campaign = createCampaign(BASE, SEED);
    expect(determineMissionType(campaign)).toBe("crashSite");
    expect(determineMissionType(campaign, "alienBaseAssault")).toBe("alienBaseAssault");
  });

  it("the assault crew includes at least one commander and one leader", () => {
    const ranks = alienBaseCrewRanks(SEED);
    expect(ranks).toHaveLength(ALIEN_HQ_CREW_SIZE);
    expect(ranks.filter((r) => r === "commander").length).toBeGreaterThanOrEqual(1);
    expect(ranks.filter((r) => r === "leader").length).toBeGreaterThanOrEqual(1);
  });

  it("UFO crews field a leader when the profile has one (deterministic)", () => {
    // A battleship (hasLeader, high commanderChance) fields at least one leader-rank alien.
    const crew = ufoCrewRanks("battleship", SEED, 8);
    expect(crew).toHaveLength(8);
    expect(crew.some((r) => r === "leader" || r === "commander")).toBe(true);
    // A scout (no leader) is all rank-and-file.
    const scout = ufoCrewRanks("scout", SEED, 5);
    expect(scout.every((r) => r === "soldier")).toBe(true);
    // Determinism.
    expect(ufoCrewRanks("battleship", SEED, 8)).toEqual(crew);
  });
});

describe("endgame — save/load round-trip", () => {
  beforeEach(() => {
    installLocalStorageShim();
  });
  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete (globalThis as { localStorage?: Storage }).localStorage;
  });

  it("round-trips the seeded HQ (survives save/load)", () => {
    const campaign = createCampaign(BASE, SEED);
    saveCampaign(campaign);
    const loaded = loadCampaign();
    expect(loaded?.alienHq).toEqual(campaign.alienHq);
  });

  it("round-trips captives and a revealed HQ", () => {
    let campaign = withContainment(createCampaign(BASE, SEED));
    campaign = recordMissionResult(campaign, "success", generateOperation(campaign), {
      ...roster(campaign),
      captures: [capture("commander", "commander"), capture("drone", "soldier")],
    });
    campaign = { ...campaign, alienHq: { ...campaign.alienHq!, revealed: true } };
    saveCampaign(campaign);
    const loaded = loadCampaign();
    expect(loaded?.captives).toEqual(campaign.captives);
    expect(loaded?.alienHq?.revealed).toBe(true);
  });
});
