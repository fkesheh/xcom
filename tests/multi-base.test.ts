import { describe, expect, it } from "vitest";
import {
  allBases,
  buildNewBase,
  canBuildNewBase,
  completeFinishedBaseConstruction,
  createCampaign,
  MAX_EXTRA_BASES,
  NEW_BASE_CONSTRUCTION_HOURS,
  NEW_BASE_COST,
} from "../src/campaign/storage";
import { advanceGeoscape, createUfoContact } from "../src/campaign/geoscape";
import type { BaseLocation, CampaignState } from "../src/campaign/types";

/**
 * The multi-base feature adds two optional fields to CampaignState. They are
 * declared here (additive, optional) so this test file type-checks against the
 * current CampaignState today; once the implementation lands the real type gains
 * the same fields and this extension is a no-op. CampaignState is structurally
 * assignable to this intersection because every added field is optional.
 */
interface ActiveBaseConstruction {
  location: BaseLocation;
  startedAtHour: number;
  completesAtHour: number;
}

type MultiBaseCampaign = CampaignState & {
  bases?: BaseLocation[];
  activeBaseConstruction?: ActiveBaseConstruction;
};

const BASE: BaseLocation = { lat: 0, lon: 0, region: "Africa" };
const SEED = 42;
const EXTRA_LOC: BaseLocation = { lat: 48, lon: 2, region: "Europe" };

/** Fresh campaign annotated as multi-base-capable (no cast needed: extras are optional). */
function freshCampaign(credits = 5000): MultiBaseCampaign {
  const fresh = createCampaign(BASE, SEED);
  return { ...fresh, resources: { ...fresh.resources, credits } };
}

describe("multi-base construction", () => {
  it("allBases returns [campaign.base] on a fresh campaign and extras list is empty", () => {
    const fresh = createCampaign(BASE, SEED);
    const campaign: MultiBaseCampaign = fresh;
    expect(allBases(campaign)).toEqual([campaign.base]);
    expect(campaign.bases ?? []).toEqual([]);
  });

  it("canBuildNewBase is ok on a fresh campaign once credits are granted", () => {
    expect(canBuildNewBase(freshCampaign(5000))).toEqual({ ok: true });
  });

  it.each<{ name: string; reason: string; tweak: (fresh: MultiBaseCampaign) => MultiBaseCampaign }>([
    {
      name: "insufficient credits",
      reason: "Not enough credits",
      tweak: (fresh) => fresh,
    },
    {
      name: "a non-active campaign",
      reason: "Campaign not active",
      tweak: (fresh) => ({
        ...fresh,
        strategic: { ...fresh.strategic, status: "won" },
      }),
    },
  ])("canBuildNewBase returns { ok:false } with reason \"$reason\" for $name", ({ reason, tweak }) => {
    // Unmodified veteran fresh campaign has 650 credits (< NEW_BASE_COST.credits).
    const fresh = createCampaign(BASE, SEED);
    const campaign = tweak(fresh);
    expect(canBuildNewBase(campaign)).toEqual({ ok: false, reason });
  });

  it("buildNewBase deducts the cost, pushes the base, and schedules construction", () => {
    const before = freshCampaign(5000);
    const built = buildNewBase(before, EXTRA_LOC);

    // Cost deducted exactly (assert via the constant, not a hardcoded 2000).
    expect(built.resources.credits).toBe(before.resources.credits - NEW_BASE_COST.credits);
    // Location is available IMMEDIATELY (pushed onto bases during construction).
    expect(built.bases ?? []).toContainEqual(EXTRA_LOC);

    const construction = built.activeBaseConstruction;
    expect(construction).toBeDefined();
    if (!construction) throw new Error("activeBaseConstruction should be set after buildNewBase");
    expect(construction.location).toEqual(EXTRA_LOC);
    expect(construction.startedAtHour).toBe(before.clock.elapsedHours);
    expect(construction.completesAtHour).toBe(construction.startedAtHour + NEW_BASE_CONSTRUCTION_HOURS);
  });

  it("buildNewBase leaves the campaign structurally unchanged when credits are insufficient", () => {
    // Unmodified fresh veteran campaign: 650 credits < 2000 cost.
    const fresh = createCampaign(BASE, SEED);
    const campaign: MultiBaseCampaign = fresh;
    const result = buildNewBase(campaign, EXTRA_LOC);

    expect(result).toEqual(campaign);
    expect(result.resources.credits).toBe(campaign.resources.credits);
    expect(result.bases ?? []).toHaveLength(0);
    expect(result.activeBaseConstruction).toBeUndefined();
  });

  it("canBuildNewBase reports a base already under construction after buildNewBase", () => {
    const built = buildNewBase(freshCampaign(5000), EXTRA_LOC);
    expect(canBuildNewBase(built)).toEqual({ ok: false, reason: "A base is already under construction" });
  });

  it("advanceGeoscape completes construction, keeps the base, and logs a construction report", () => {
    const built = buildNewBase(freshCampaign(5000), EXTRA_LOC);
    // Built at elapsedHours 0 -> completesAtHour = NEW_BASE_CONSTRUCTION_HOURS.
    expect(built.activeBaseConstruction?.completesAtHour).toBe(NEW_BASE_CONSTRUCTION_HOURS);

    const advanced = advanceGeoscape(built, NEW_BASE_CONSTRUCTION_HOURS);

    expect(advanced.activeBaseConstruction).toBeUndefined();
    // The built location was pushed at build time; completion must not re-push or drop it.
    expect(advanced.bases ?? []).toContainEqual(EXTRA_LOC);
    // A ProjectReport of kind "construction" is added on completion.
    expect(advanced.projectReports.some((report) => report.kind === "construction")).toBe(true);
  });

  it("enforces the maximum number of extra bases", () => {
    // Build successive extra bases, clearing construction between each by advancing the
    // geoscape past the construction window. Bases are placed in non-council regions so
    // that any incidental contact-expire panic is a no-op, keeping the campaign "active"
    // regardless of seed and isolating the max-bases gate under test.
    const started = createCampaign(BASE, SEED);
    let campaign: MultiBaseCampaign = {
      ...started,
      resources: { ...started.resources, credits: 50000 },
    };
    for (let i = 0; i < MAX_EXTRA_BASES; i++) {
      campaign = buildNewBase(campaign, {
        lat: 10 * (i + 1),
        lon: 10 * (i + 1),
        region: `Sector ${i + 1}`,
      });
      // advanceGeoscape now also completes finished base construction.
      campaign = advanceGeoscape(campaign, NEW_BASE_CONSTRUCTION_HOURS);
    }

    expect(campaign.bases ?? []).toHaveLength(MAX_EXTRA_BASES);
    expect(canBuildNewBase(campaign)).toEqual({ ok: false, reason: "Maximum number of bases reached" });
  });

  it("more bases tighten the detection interval (extra base => earlier contact)", () => {
    // Two campaigns from the same seed, identical clock, only the second has an extra base.
    const fresh = createCampaign(BASE, SEED);
    const withoutExtra: MultiBaseCampaign = fresh;
    const withExtra: MultiBaseCampaign = { ...fresh, bases: [EXTRA_LOC] };

    // Both start at elapsedHours 0, lastContactHour 0, no active contact.
    expect(withoutExtra.clock.elapsedHours).toBe(0);
    expect(withoutExtra.clock.lastContactHour).toBe(0);
    expect(withExtra.clock.elapsedHours).toBe(0);
    expect(withExtra.clock.lastContactHour).toBe(0);

    // Month-0 contactInterval is stretched by the arc-stretch ramp (round(x * 1.6)):
    // 18 (0 extras) -> 29, 15 (1 extra) -> 24. 26h cleanly separates them:
    // 26 < 29 -> no contact; 26 >= 24 -> contact.
    const afterA = advanceGeoscape(withoutExtra, 26);
    const afterB = advanceGeoscape(withExtra, 26);

    expect(afterA.ufoContact).toBeFalsy();
    expect(afterB.ufoContact).toBeTruthy();
  });

  it("attributes a multi-base contact's region to one of the known bases", () => {
    // Primary base in Africa, one extra base in Europe -> allBases = [Africa, Europe].
    const fresh = createCampaign(BASE, SEED);
    const campaign: MultiBaseCampaign = { ...fresh, bases: [EXTRA_LOC] };

    const contact = createUfoContact(campaign, 10);
    const regions = allBases(campaign).map((base) => base.region);

    // With more than one base the contact region is base-derived (nearest base), so it
    // must be a member of the known base regions rather than a legacy zone label.
    expect(regions).toContain(contact.region);
  });
});

describe("completeFinishedBaseConstruction (direct)", () => {
  it("clears activeBaseConstruction and logs a construction report once the clock reaches completion", () => {
    const built = buildNewBase(freshCampaign(5000), EXTRA_LOC);
    expect(built.activeBaseConstruction).toBeDefined();

    // advanceGeoscape drives the clock and calls completeFinishedBaseConstruction; but the
    // function must also be the no-op gate before the threshold so we assert both sides.
    const notYet = completeFinishedBaseConstruction({ ...built, clock: { ...built.clock, elapsedHours: NEW_BASE_CONSTRUCTION_HOURS - 1 } });
    expect(notYet.activeBaseConstruction).toBeDefined();

    const done = completeFinishedBaseConstruction({ ...built, clock: { ...built.clock, elapsedHours: NEW_BASE_CONSTRUCTION_HOURS } });
    expect(done.activeBaseConstruction).toBeUndefined();
    expect(done.projectReports.some((report) => report.kind === "construction")).toBe(true);
    // Completion does not re-push the location.
    expect(done.bases ?? []).toEqual([EXTRA_LOC]);
  });
});
