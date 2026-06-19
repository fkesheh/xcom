import { describe, expect, it } from "vitest";

import { determineMissionType, generateOperation, objectiveFor } from "../src/campaign/operations";
import type { CampaignState, MissionType, UfoContact } from "../src/campaign/types";
import { createCampaign } from "../src/campaign/storage";

const BASE_REGION = "Atlantic sector";

function makeCampaign(difficulty?: CampaignState["strategic"]["difficulty"]): CampaignState {
  const campaign = createCampaign({ lat: 12.3, lon: -45.6, region: BASE_REGION }, 98765);
  return difficulty ? { ...campaign, strategic: { ...campaign.strategic, difficulty } } : campaign;
}

function withContact(
  campaign: CampaignState,
  missionType: MissionType | undefined,
  status: UfoContact["status"] = "crashed",
  overrides: Partial<UfoContact> = {},
): CampaignState {
  const baseContact: UfoContact = {
    id: "UFO-TEST",
    status,
    lat: 10,
    lon: 20,
    region: "Europe",
    detectedAtHour: 0,
    expiresAtHour: 100,
    missionSeed: 4242,
    strength: 2,
    ...overrides,
  };
  if (missionType !== undefined) baseContact.missionType = missionType;
  return { ...campaign, ufoContact: baseContact };
}

describe("generateOperation mission variety", () => {
  it("defaults to a crashSite recovery when no UFO contact is present", () => {
    const campaign = makeCampaign();

    expect(determineMissionType(campaign)).toBe("crashSite");
    expect(generateOperation(campaign).missionType).toBe("crashSite");
  });

  it("produces an unchanged crashSite plan whether or not missionType is explicit (regression)", () => {
    const campaign = makeCampaign();
    const explicit = generateOperation(withContact(campaign, "crashSite"));
    const implicit = generateOperation(withContact(campaign, undefined));

    expect(explicit.missionType).toBe("crashSite");
    expect(implicit.missionType).toBe("crashSite");
    // Every observable field is identical between explicit and defaulted crashSite plans.
    expect(explicit.enemyCount).toBe(implicit.enemyCount);
    expect(explicit.reward).toEqual(implicit.reward);
    expect(explicit.briefing).toBe(implicit.briefing);
    expect(explicit.objective).toBe(implicit.objective);
    expect(explicit.missionContext).toBeUndefined();

    // Regression against the legacy crashSite contract.
    expect(explicit.region).toBe("Europe");
    expect(explicit.missionSeed).toBe(4242);
    expect(explicit.objective).toBe(
      "Recover the UFO power source, extract it to the dropship, or neutralize all contacts.",
    );
    expect(explicit.briefing).toContain("UFO-TEST crash site is confirmed in Europe");
    expect(explicit.briefing).toContain(`Estimated field time is ${explicit.durationHours}h`);
  });

  it("seeds a terror mission with a deterministic civilian count and rescue objective", () => {
    const campaign = makeCampaign();
    const operation = generateOperation(withContact(campaign, "terror"));

    expect(operation.missionType).toBe("terror");
    expect(operation.missionContext?.civilianCount).toBeGreaterThanOrEqual(6);
    expect(operation.missionContext?.civilianCount).toBeLessThanOrEqual(10);
    expect(operation.objective).toBe("Rescue civilians and neutralize the attackers.");
    expect(operation.briefing).toContain("under attack");
    expect(operation.briefing).toContain(`${operation.missionContext?.civilianCount} confirmed in the zone`);
  });

  it("deterministically rerolls the same terror civilian count for the same seed", () => {
    const campaign = makeCampaign();
    const first = generateOperation(withContact(campaign, "terror"));
    const again = generateOperation(withContact(campaign, "terror"));

    expect(first).toEqual(again);
    expect(first.missionContext?.civilianCount).toBe(again.missionContext?.civilianCount);
  });

  it("fields a landedUfo assault with more enemies and richer salvage than a crashSite", () => {
    const campaign = makeCampaign();
    const crash = generateOperation(withContact(campaign, "crashSite"));
    const landed = generateOperation(withContact(campaign, "landedUfo", "landed"));

    expect(landed.missionType).toBe("landedUfo");
    expect(landed.missionContext).toBeUndefined();
    expect(landed.enemyCount).toBeGreaterThan(crash.enemyCount);
    expect(landed.reward.alloys).toBeGreaterThan(crash.reward.alloys);
    expect(landed.reward.elerium).toBeGreaterThan(crash.reward.elerium);
    expect(landed.objective).toBe("Assault the landed UFO, neutralize its crew, and secure the intact craft.");
    expect(landed.briefing).toContain("intact");
  });

  it("defends the base in the base's own region with a survival objective", () => {
    const campaign = makeCampaign();
    const defense = generateOperation(withContact(campaign, "baseDefense"));

    expect(defense.missionType).toBe("baseDefense");
    // Base defense always references the player's base region, never the contact region.
    expect(defense.region).toBe(BASE_REGION);
    expect(defense.missionContext?.defenderFacility).toBe(BASE_REGION);
    expect(defense.objective).toBe("Repel the base assault.");
    expect(defense.briefing).toContain(`our base in ${BASE_REGION}`);
    // Reward is survival-scoped: smaller credits than a crashSite recovery.
    const crash = generateOperation(withContact(campaign, "crashSite"));
    expect(defense.reward.credits).toBeLessThan(crash.reward.credits);
  });

  it.each<MissionType>(["terror", "baseDefense"])(
    "uses a landed %s contact's own seed instead of the campaign seed (regression)",
    (missionType) => {
      const campaign = makeCampaign();
      // createUfoContact spawns ground assaults (terror/baseDefense) already on the ground,
      // i.e. status "landed" — not "crashed". missionContact must still hand that contact
      // through so generateOperation uses its missionSeed/strength rather than the fallbacks.
      const contactSeed = 1171428038;
      const fallbackSeed = generateOperation(campaign).missionSeed;
      expect(fallbackSeed).not.toBe(contactSeed);

      const operation = generateOperation(
        withContact(campaign, missionType, "landed", { missionSeed: contactSeed, strength: 2 }),
      );

      expect(operation.missionType).toBe(missionType);
      expect(operation.missionSeed).toBe(contactSeed);
    },
  );

  it("carries a landed terror contact's region into the operation (regression)", () => {
    const campaign = makeCampaign();
    const contactRegion = "South America";

    const operation = generateOperation(
      withContact(campaign, "terror", "landed", { region: contactRegion }),
    );

    expect(operation.missionType).toBe("terror");
    expect(operation.region).toBe(contactRegion);
  });

  it("keeps baseDefense pinned to the base region even when the landed contact carries another region (regression)", () => {
    const campaign = makeCampaign();

    const operation = generateOperation(
      withContact(campaign, "baseDefense", "landed", { region: "South America" }),
    );

    expect(operation.missionType).toBe("baseDefense");
    // Base defense always references the player's base region, never the contact region.
    expect(operation.region).toBe(BASE_REGION);
  });

  it.each<MissionType>(["crashSite", "landedUfo", "terror", "baseDefense"])(
    "scales enemy counts up at commander difficulty vs rookie for a %s mission",
    (missionType) => {
      const rookie = makeCampaign("rookie");
      const commander = makeCampaign("commander");
      const status: UfoContact["status"] = missionType === "landedUfo" ? "landed" : "crashed";

      const rookieOp = generateOperation(withContact(rookie, missionType, status));
      const commanderOp = generateOperation(withContact(commander, missionType, status));

      expect(commanderOp.enemyCount).toBeGreaterThan(rookieOp.enemyCount);
    },
  );

  it("keeps crashSite enemy counts unchanged when no difficulty is set (legacy default)", () => {
    const campaign = makeCampaign();
    const operation = generateOperation(withContact(campaign, "crashSite"));

    // With no difficulty, multiplier is identity, so enemyCount matches the legacy formula.
    expect(operation.enemyCount).toBeGreaterThanOrEqual(3);
    expect(determineMissionType(campaign)).toBe("crashSite");
  });

  it("exposes stable objective text per mission type via objectiveFor", () => {
    expect(objectiveFor("crashSite")).toBe(
      "Recover the UFO power source, extract it to the dropship, or neutralize all contacts.",
    );
    expect(objectiveFor("terror")).toBe("Rescue civilians and neutralize the attackers.");
    expect(objectiveFor("baseDefense")).toBe("Repel the base assault.");
    expect(objectiveFor("landedUfo")).toBe(
      "Assault the landed UFO, neutralize its crew, and secure the intact craft.",
    );
  });
});
