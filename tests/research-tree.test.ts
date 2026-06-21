import { describe, expect, it } from "vitest";

import {
  canStartResearch,
  completeResearch,
  createCampaign,
  hasResearch,
  RESEARCH_COSTS,
  RESEARCH_IDS,
  RESEARCH_PROJECTS,
  researchTree,
  startResearch,
} from "../src/campaign/storage";
import type { CampaignState, ResearchId } from "../src/campaign/types";

const BASE_LOCATION = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function stock(campaign: CampaignState, credits = 5000): CampaignState {
  return {
    ...campaign,
    resources: { credits, alloys: 200, elerium: 60, alienData: 80 },
  };
}

function nodeFor(id: ResearchId) {
  const node = RESEARCH_PROJECTS.find((project) => project.id === id);
  if (!node) throw new Error(`unknown research id ${id}`);
  return node;
}

describe("research tree", () => {
  it("declares every project cost and prerequisite with no orphan or cyclic ids", () => {
    // Every id has a cost entry and a project entry.
    for (const id of RESEARCH_IDS) {
      expect(RESEARCH_COSTS[id]).toBeDefined();
      expect(RESEARCH_PROJECTS.some((project) => project.id === id)).toBe(true);
    }
    expect(RESEARCH_PROJECTS).toHaveLength(RESEARCH_IDS.length);

    // Every prerequisite references a known project.
    for (const project of RESEARCH_PROJECTS) {
      for (const requirement of project.requires) {
        expect(RESEARCH_IDS).toContain(requirement);
        expect(requirement).not.toBe(project.id);
      }
    }
  });

  it("returns every project with root/dependent statuses for a fresh campaign", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const tree = researchTree(campaign);

    expect(tree).toHaveLength(RESEARCH_PROJECTS.length);
    expect(tree.map((node) => node.project.id).sort()).toEqual([...RESEARCH_IDS].sort());

    const statusFor = (id: ResearchId) =>
      tree.find((node) => node.project.id === id)!.status;

    // Roots with no prerequisites are available; everything that depends on them is locked.
    expect(statusFor("plasmaWeapons")).toBe("available");
    expect(statusFor("alloyArmor")).toBe("available");
    expect(statusFor("alienBiotech")).toBe("available");
    expect(statusFor("heavyPlasma")).toBe("locked");
    expect(statusFor("advancedMetallurgy")).toBe("locked");
    expect(statusFor("improvedMedikit")).toBe("locked");
    expect(statusFor("poweredArmor")).toBe("locked");
    expect(statusFor("eleriumPowerSource")).toBe("locked");
    expect(statusFor("mindShield")).toBe("locked");
  });

  it("marks completed research as completed and unlocks direct dependents", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const withPlasma = completeResearch(stock(campaign), "plasmaWeapons");

    const tree = researchTree(withPlasma);
    const statusFor = (id: ResearchId) =>
      tree.find((node) => node.project.id === id)!.status;

    expect(statusFor("plasmaWeapons")).toBe("completed");
    // heavyPlasma requires only plasmaWeapons -> now available.
    expect(statusFor("heavyPlasma")).toBe("available");
    // advancedMetallurgy still needs alloyArmor -> still locked.
    expect(statusFor("advancedMetallurgy")).toBe("locked");
    // eleriumPowerSource needs advancedMetallurgy + heavyPlasma -> still locked.
    expect(statusFor("eleriumPowerSource")).toBe("locked");
    expect(statusFor("mindShield")).toBe("locked");
  });

  it("unlocks a multi-prerequisite node only once every requirement is done", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const stocked = stock(campaign);
    // heavyPlasma needs plasmaWeapons; advancedMetallurgy needs alloyArmor.
    const withRoots = completeResearch(
      completeResearch(stocked, "plasmaWeapons"),
      "alloyArmor",
    );
    const withBoth = completeResearch(
      completeResearch(withRoots, "advancedMetallurgy"),
      "heavyPlasma",
    );

    const statusFor = (id: ResearchId) =>
      researchTree(withBoth).find((node) => node.project.id === id)!.status;

    // eleriumPowerSource requires advancedMetallurgy AND heavyPlasma.
    expect(statusFor("advancedMetallurgy")).toBe("completed");
    expect(statusFor("heavyPlasma")).toBe("completed");
    expect(statusFor("eleriumPowerSource")).toBe("available");

    // The capstone still needs eleriumPowerSource (and alienBiotech).
    expect(statusFor("mindShield")).toBe("locked");
  });

  it("classifies the active research project as available and others as locked", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const started = startResearch(stock(campaign), "alienBiotech");
    expect(started.activeResearch?.projectId).toBe("alienBiotech");

    const tree = researchTree(started);
    const statusFor = (id: ResearchId) =>
      tree.find((node) => node.project.id === id)!.status;

    // The in-progress project itself counts as available (it is the active one).
    expect(statusFor("alienBiotech")).toBe("available");
    // The lab is busy, so even the other roots are locked until it finishes.
    expect(statusFor("plasmaWeapons")).toBe("locked");
    expect(statusFor("alloyArmor")).toBe("locked");
  });

  it("blocks starting a project whose prerequisite is not completed", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const stocked = stock(campaign);

    expect(canStartResearch(stocked, "heavyPlasma")).toBe(false);
    expect(canStartResearch(stocked, "eleriumPowerSource")).toBe(false);
    expect(canStartResearch(stocked, "mindShield")).toBe(false);

    const withPlasma = completeResearch(stocked, "plasmaWeapons");
    expect(canStartResearch(withPlasma, "heavyPlasma")).toBe(true);
    // eleriumPowerSource still needs advancedMetallurgy on top of heavyPlasma.
    expect(canStartResearch(withPlasma, "eleriumPowerSource")).toBe(false);
  });

  it("lets a dependent be started and completed once its prerequisite is done", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const stocked = stock(campaign);
    const withPlasma = completeResearch(stocked, "plasmaWeapons");

    expect(hasResearch(withPlasma, "heavyPlasma")).toBe(false);
    const started = startResearch(withPlasma, "heavyPlasma");
    expect(started.activeResearch?.projectId).toBe("heavyPlasma");
    const completed = completeResearch(withPlasma, "heavyPlasma");
    expect(hasResearch(completed, "heavyPlasma")).toBe(true);
    expect(completed.completedResearch).toContain("heavyPlasma");
  });

  it("keeps the original plasmaWeapons and alloyArmor projects working end-to-end", () => {
    const campaign = createCampaign(BASE_LOCATION, SEED);
    const stocked = stock(campaign);

    expect(canStartResearch(stocked, "plasmaWeapons")).toBe(true);
    expect(canStartResearch(stocked, "alloyArmor")).toBe(true);

    const plasma = completeResearch(stocked, "plasmaWeapons");
    expect(hasResearch(plasma, "plasmaWeapons")).toBe(true);
    // plasmaWeapons still grants the plasma caster to the armory.
    expect(plasma.armory.weapons.plasma).toBe(1);

    const armored = completeResearch(stocked, "alloyArmor");
    expect(hasResearch(armored, "alloyArmor")).toBe(true);

    // Re-completing an already finished project is a no-op.
    expect(completeResearch(plasma, "plasmaWeapons")).toBe(plasma);
  });

  it("reports prerequisites on the project nodes so the UI can render edges", () => {
    expect(nodeFor("plasmaWeapons").requires).toEqual([]);
    expect(nodeFor("alloyArmor").requires).toEqual([]);
    expect(nodeFor("heavyPlasma").requires).toEqual(["plasmaWeapons"]);
    expect(nodeFor("advancedMetallurgy").requires).toEqual(["alloyArmor"]);
    expect(nodeFor("eleriumPowerSource").requires).toEqual([
      "advancedMetallurgy",
      "heavyPlasma",
    ]);
    expect(nodeFor("mindShield").requires).toEqual(["alienBiotech", "eleriumPowerSource"]);
  });
});
