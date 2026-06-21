import { describe, expect, it } from "vitest";

import {
  STARTER_BASE_FACILITY_IDS,
  STARTER_BASE_FACILITIES,
  STARTER_BASE_GRID,
  summarizeBaseFacilities,
} from "../src/campaign/base";
import {
  advanceGeoscape,
  canLaunchInterceptor,
  CRASH_SITE_LIFETIME_HOURS,
  FUNDING_REPORT_INTERVAL_HOURS,
  interceptUfo,
  interceptionForecast,
  interceptorRepairHours,
  isInterceptorReady,
  UFO_CONTACT_LIFETIME_HOURS,
} from "../src/campaign/geoscape";
import { generateOperation } from "../src/campaign/operations";
import {
  activeSoldiers,
  assignSoldierWeapon,
  availableBaseFacilities,
  availableWeaponCount,
  buildFacility,
  CAMPAIGN_VICTORY_OPERATIONS,
  campaignMissionSeed,
  canAssignSoldierWeapon,
  canBuildFacility,
  canDeploySoldier,
  canCompleteResearch,
  canRecruitSoldier,
  canStartResearch,
  canStartManufacturing,
  campaignObjectiveProgress,
  completeFacilityConstruction,
  completeResearch,
  constructedFacilities,
  createCampaign,
  deploymentSoldiers,
  deploymentWeaponIds,
  campaignSoldierStatBonus,
  hasBaseFacility,
  hasResearch,
  highestRegionalPanic,
  livingSoldiers,
  manufacturingCost,
  manufacturingDuration,
  MEDBAY_FACILITY_ID,
  RESEARCH_COSTS,
  facilityConstructionDuration,
  researchDuration,
  researchCost,
  RECRUIT_COST,
  recruitSoldier,
  regionalPanicFor,
  recordMissionResult,
  setSoldierDeployment,
  soldierStatBonus,
  soldierWeaponId,
  startManufacturing,
  startResearch,
  STARTING_REGIONAL_PANIC,
  updateCampaignBase,
} from "../src/campaign/storage";

describe("campaign state", () => {
  it("creates a persistent campaign record from a base location", () => {
    const campaign = createCampaign({ lat: 12.3, lon: -45.6, region: "Atlantic sector" }, 12345);

    expect(campaign.version).toBe(1);
    expect(campaign.id).toBe("campaign-00003039");
    expect(campaign.seed).toBe(12345);
    expect(campaign.base.region).toBe("Atlantic sector");
    expect(campaign.strategic).toEqual({ status: "active", threat: 25, funding: 600, score: 0 });
    expect(campaign.regionalPanic).toEqual(STARTING_REGIONAL_PANIC);
    expect(highestRegionalPanic(campaign)).toEqual({ region: "North America", panic: 20 });
    expect(campaign.clock).toEqual({
      day: 1,
      hour: 0,
      elapsedHours: 0,
      lastContactHour: 0,
      lastFundingHour: 0,
    });
    expect(campaign.lastFundingReport).toBeUndefined();
    expect(campaign.interceptor).toEqual({ damage: 0, sorties: 0 });
    expect(campaign.lastInterceptionReport).toBeUndefined();
    expect(campaign.ufoContact).toBeUndefined();
    expect(campaign.resources).toEqual({ credits: 650, alloys: 0, elerium: 0, alienData: 0 });
    expect(campaign.armory.weapons).toEqual({ rifle: 6, pistol: 2, plasma: 0 });
    expect(campaign.facilities).toEqual([...STARTER_BASE_FACILITY_IDS]);
    expect(campaign.soldiers).toHaveLength(6);
    expect(Object.values(campaign.soldierLoadouts)).toEqual(["rifle", "rifle", "rifle", "rifle", "rifle", "rifle"]);
    expect(campaign.soldiers.every((soldier) => soldier.rank === "rookie")).toBe(true);
    expect(activeSoldiers(campaign)).toHaveLength(6);
    expect(deploymentSoldiers(campaign).map((soldier) => soldier.name)).toEqual(["Vega", "Rook", "Mason", "Pike"]);
    expect(deploymentWeaponIds(campaign)).toEqual(["rifle", "rifle", "rifle", "rifle"]);
    expect(campaign.completedResearch).toEqual([]);
    expect(campaign.activeResearch).toBeUndefined();
    expect(campaign.activeManufacturing).toBeUndefined();
    expect(campaign.activeConstruction).toBeUndefined();
    expect(campaign.projectReports).toEqual([]);
    expect(campaign.missionsCompleted).toBe(0);
    expect(campaign.missionsAttempted).toBe(0);
    expect(campaignObjectiveProgress(campaign)).toMatchObject({
      completed: 0,
      required: CAMPAIGN_VICTORY_OPERATIONS,
      remaining: CAMPAIGN_VICTORY_OPERATIONS,
      percent: 0,
      status: "active",
      title: "Containment objective",
    });
  });

  it("derives deterministic mission seeds from attempts and preserves campaign identity when relocating", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const relocated = updateCampaignBase(campaign, { lat: 48.8, lon: 2.3, region: "Europe" });

    expect(campaignMissionSeed(campaign)).toBe(campaignMissionSeed(relocated));
    expect(relocated.id).toBe(campaign.id);
    expect(relocated.base.region).toBe("Europe");
  });

  it("assigns limited armory weapons to campaign soldiers", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const firstSoldier = campaign.soldiers[0]!;
    const secondSoldier = campaign.soldiers[1]!;
    const thirdSoldier = campaign.soldiers[2]!;
    const sidearm = assignSoldierWeapon(campaign, firstSoldier.id, "pistol");
    const rejectedPlasma = assignSoldierWeapon(sidearm, secondSoldier.id, "plasma");
    const stocked = {
      ...sidearm,
      armory: { weapons: { ...sidearm.armory.weapons, plasma: 1 } },
    };
    const plasma = assignSoldierWeapon(stocked, secondSoldier.id, "plasma");
    const recruit = recruitSoldier(plasma);

    expect(soldierWeaponId(sidearm, firstSoldier.id)).toBe("pistol");
    expect(deploymentWeaponIds(sidearm)).toEqual(["pistol", "rifle", "rifle", "rifle"]);
    expect(availableWeaponCount(sidearm, "pistol")).toBe(1);
    expect(rejectedPlasma).toBe(sidearm);
    expect(soldierWeaponId(plasma, secondSoldier.id)).toBe("plasma");
    expect(deploymentWeaponIds(plasma)).toEqual(["pistol", "plasma", "rifle", "rifle"]);
    expect(canAssignSoldierWeapon(plasma, thirdSoldier.id, "plasma")).toBe(false);
    expect(availableWeaponCount(plasma, "plasma")).toBe(0);
    expect(recruit.armory.weapons.rifle).toBe(7);
    expect(soldierWeaponId(recruit, "soldier-07")).toBe("rifle");
  });

  it("lets command choose the next deployment squad", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const ids = campaign.soldiers.map((soldier) => soldier.id);
    const firstFour = ids.slice(0, 4);

    expect(campaign.deploymentSoldierIds).toEqual(firstFour);
    expect(deploymentSoldiers(campaign).map((soldier) => soldier.id)).toEqual(firstFour);
    expect(canDeploySoldier(campaign, ids[4]!)).toBe(false);

    const openSlot = setSoldierDeployment(campaign, ids[1]!, false);
    expect(openSlot.deploymentSoldierIds).toEqual([ids[0], ids[2], ids[3]]);
    expect(canDeploySoldier(openSlot, ids[4]!)).toBe(true);

    const swapped = setSoldierDeployment(openSlot, ids[4]!, true);
    expect(swapped.deploymentSoldierIds).toEqual([ids[0], ids[2], ids[3], ids[4]]);
    expect(deploymentSoldiers(swapped).map((soldier) => soldier.id)).toEqual([ids[0], ids[2], ids[3], ids[4]]);
    expect(setSoldierDeployment(swapped, ids[5]!, true).deploymentSoldierIds).toEqual(swapped.deploymentSoldierIds);

    const operation = generateOperation(swapped);
    const afterLoss = recordMissionResult(
      swapped,
      "failure",
      operation,
      {
        deployedSoldierIds: swapped.deploymentSoldierIds,
        survivingSoldierIds: [ids[0]!, ids[2]!, ids[4]!],
        survivorHealth: {
          [ids[0]!]: { hp: 20, maxHp: 40 },
          [ids[2]!]: { hp: 40, maxHp: 40 },
          [ids[4]!]: { hp: 40, maxHp: 40 },
        },
      },
      "2026-06-15T00:00:00.000Z",
    );

    expect(afterLoss.deploymentSoldierIds).toEqual([ids[2], ids[4]]);
    expect(deploymentSoldiers(afterLoss).map((soldier) => soldier.id)).toEqual([ids[2], ids[4]]);
    expect(canDeploySoldier(afterLoss, ids[0]!)).toBe(false);
    expect(canDeploySoldier(afterLoss, ids[5]!)).toBe(true);
  });

  it("manufactures armory weapons with workshop time and resources", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const researched = completeResearch(stocked, "plasmaWeapons");
    const started = startManufacturing(researched, "plasma");
    const partial = advanceGeoscape(started, manufacturingDuration(researched, "plasma") - 1);
    const completed = advanceGeoscape(started, manufacturingDuration(researched, "plasma"));
    const busy = startManufacturing(researched, "rifle");
    const withWorkshop = completeFacilityConstruction(stocked, "workshop-2");
    const researchedWorkshop = completeResearch(withWorkshop, "plasmaWeapons");
    const workshopStarted = startManufacturing(researchedWorkshop, "plasma");

    expect(canStartManufacturing(campaign, "plasma")).toBe(false);
    expect(canStartManufacturing(researched, "plasma")).toBe(true);
    expect(started.activeManufacturing).toEqual({
      projectId: "plasma",
      startedAtHour: researched.clock.elapsedHours,
      completesAtHour: researched.clock.elapsedHours + manufacturingDuration(researched, "plasma"),
    });
    expect(started.resources).toEqual({
      credits: researched.resources.credits - manufacturingCost(researched, "plasma").credits,
      alloys: researched.resources.alloys - manufacturingCost(researched, "plasma").alloys,
      elerium: researched.resources.elerium - manufacturingCost(researched, "plasma").elerium,
      alienData: researched.resources.alienData - manufacturingCost(researched, "plasma").alienData,
    });
    expect(partial.armory.weapons.plasma).toBe(researched.armory.weapons.plasma);
    expect(partial.activeManufacturing?.projectId).toBe("plasma");
    expect(completed.armory.weapons.plasma).toBe(researched.armory.weapons.plasma + 1);
    expect(completed.activeManufacturing).toBeUndefined();
    expect(completed.projectReports[0]).toMatchObject({
      kind: "manufacturing",
      id: "plasma",
      title: "Plasma caster complete",
      completedAtHour: manufacturingDuration(researched, "plasma"),
    });
    expect(canStartManufacturing(busy, "pistol")).toBe(false);
    expect(startManufacturing(busy, "pistol")).toBe(busy);
    expect(manufacturingDuration(researchedWorkshop, "plasma")).toBeLessThan(manufacturingDuration(researched, "plasma"));
    expect(manufacturingCost(researchedWorkshop, "plasma").credits).toBeLessThan(manufacturingCost(researched, "plasma").credits);
    expect(workshopStarted.activeManufacturing?.completesAtHour).toBe(
      researchedWorkshop.clock.elapsedHours + manufacturingDuration(researchedWorkshop, "plasma"),
    );
  });

  it("advances geoscape time and detects UFO contacts for mission launch", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const searching = advanceGeoscape(campaign, 6);
    const detected = advanceGeoscape(searching, 12);
    const forecast = interceptionForecast(detected);
    const intercepted = interceptUfo(detected);
    const operation = generateOperation(intercepted);
    const afterMission = recordMissionResult(intercepted, "success", operation, "2026-06-15T00:00:00.000Z");

    expect(searching.clock).toEqual({
      day: 1,
      hour: 6,
      elapsedHours: 6,
      lastContactHour: 0,
      lastFundingHour: 0,
    });
    expect(searching.ufoContact).toBeUndefined();
    expect(detected.clock).toEqual({
      day: 1,
      hour: 18,
      elapsedHours: 18,
      lastContactHour: 18,
      lastFundingHour: 0,
    });
    expect(detected.ufoContact?.id).toMatch(/^UFO-01-/);
    expect(detected.ufoContact?.status).toBe("tracked");
    expect(detected.ufoContact?.expiresAtHour).toBe(18 + UFO_CONTACT_LIFETIME_HOURS);
    expect(canLaunchInterceptor(detected)).toBe(true);
    expect(forecast).toMatchObject({
      contactId: detected.ufoContact?.id,
      risk: "favorable",
      succeeds: true,
      canLaunch: true,
    });
    expect(forecast?.damage).toBeGreaterThan(0);
    expect(intercepted.ufoContact?.status).toBe("crashed");
    expect(intercepted.lastInterceptionReport).toMatchObject({
      contactId: detected.ufoContact?.id,
      result: "crashed",
      region: detected.ufoContact?.region,
      strength: detected.ufoContact?.strength,
    });
    expect(intercepted.lastInterceptionReport?.summary).toContain("forced down");
    expect(regionalPanicFor(intercepted, detected.ufoContact!.region)).toBe(
      regionalPanicFor(detected, detected.ufoContact!.region)! - 4,
    );
    expect(intercepted.ufoContact?.interceptedAtHour).toBe(18);
    expect(intercepted.ufoContact?.expiresAtHour).toBe(18 + CRASH_SITE_LIFETIME_HOURS);
    expect(intercepted.ufoContact?.interceptorDamage).toBeGreaterThan(0);
    expect(intercepted.interceptor.damage).toBe(intercepted.ufoContact?.interceptorDamage);
    expect(intercepted.interceptor.sorties).toBe(1);
    expect(intercepted.interceptor.repairedAtHour).toBeGreaterThan(intercepted.clock.elapsedHours);
    // The engaging craft is grounded for repairs; the standby interceptor keeps the fleet ready.
    expect(
      intercepted.fleet!.find((craft) => craft.id === "int-1")?.repairedAtHour,
    ).toBeGreaterThan(intercepted.clock.elapsedHours);
    expect(isInterceptorReady(intercepted)).toBe(true);
    expect(operation.region).toBe(intercepted.ufoContact?.region);
    expect(operation.missionSeed).toBe(intercepted.ufoContact?.missionSeed);
    expect(operation.durationHours).toBeGreaterThan(0);
    expect(operation.briefing).toContain(`${intercepted.ufoContact!.id} crash site`);
    expect(operation.briefing).toContain(`Estimated field time is ${operation.durationHours}h`);
    expect(afterMission.ufoContact).toBeUndefined();
    expect(afterMission.clock.elapsedHours).toBe(intercepted.clock.elapsedHours + operation.durationHours);
    expect(afterMission.clock.lastContactHour).toBe(afterMission.clock.elapsedHours);
  });

  it("penalizes ignored UFO contacts and radar detects the next contact sooner", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const detected = advanceGeoscape(campaign, 18);
    const expired = advanceGeoscape(detected, UFO_CONTACT_LIFETIME_HOURS);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const radar = completeFacilityConstruction(stocked, "radar-2");
    const radarDetected = advanceGeoscape(radar, 12);

    expect(detected.ufoContact).toBeDefined();
    expect(expired.ufoContact).toBeUndefined();
    expect(expired.strategic.threat - campaign.strategic.threat).toBe(10);
    expect(campaign.strategic.funding - expired.strategic.funding).toBe(25);
    expect(regionalPanicFor(expired, detected.ufoContact!.region)).toBe(
      regionalPanicFor(campaign, detected.ufoContact!.region)! + 22,
    );
    expect(highestRegionalPanic(expired).region).toBe(detected.ufoContact!.region);
    expect(expired.clock.lastContactHour).toBe(expired.clock.elapsedHours);
    expect(radarDetected.ufoContact).toBeDefined();
    expect(radarDetected.clock.elapsedHours).toBe(12);
  });

  it("can fail an interception against a strong UFO and applies escape pressure", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 2);
    const detected = advanceGeoscape(campaign, 18);
    const forecast = interceptionForecast(detected);
    const failed = interceptUfo(detected);
    const stocked = {
      ...detected,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const radar = completeFacilityConstruction(stocked, "radar-2");
    const radarForecast = interceptionForecast(radar);
    const recovered = interceptUfo(radar);

    expect(detected.ufoContact?.strength).toBe(3);
    expect(forecast).toMatchObject({
      risk: "dangerous",
      succeeds: false,
      canLaunch: true,
      strength: 3,
    });
    expect(forecast?.summary).toContain("UFO may escape");
    expect(failed.ufoContact).toBeUndefined();
    expect(failed.lastInterceptionReport).toMatchObject({
      contactId: detected.ufoContact?.id,
      result: "escaped",
      region: detected.ufoContact?.region,
      strength: 3,
      completedAtHour: detected.clock.elapsedHours,
    });
    expect(failed.lastInterceptionReport?.summary).toContain("escaped");
    expect(failed.interceptor.sorties).toBe(1);
    expect(failed.interceptor.damage).toBeGreaterThan(0);
    expect(failed.interceptor.repairedAtHour).toBeGreaterThan(failed.clock.elapsedHours);
    expect(failed.clock.lastContactHour).toBe(failed.clock.elapsedHours);
    expect(failed.strategic.threat - detected.strategic.threat).toBe(8);
    expect(detected.strategic.funding - failed.strategic.funding).toBe(20);
    expect(regionalPanicFor(failed, detected.ufoContact!.region)).toBe(
      regionalPanicFor(detected, detected.ufoContact!.region)! + 12,
    );
    expect(recovered.ufoContact?.status).toBe("crashed");
    expect(radarForecast).toMatchObject({
      risk: "favorable",
      succeeds: true,
      strength: 3,
    });
    expect(recovered.lastInterceptionReport?.result).toBe("crashed");
  });

  it("repairs interceptor damage over geoscape time while the standby interceptor covers launches", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const detected = advanceGeoscape(campaign, 18);
    const damaged = interceptUfo(detected);
    const repairHours = damaged.interceptor.repairedAtHour! - damaged.clock.elapsedHours;
    const contact = advanceGeoscape(damaged, CRASH_SITE_LIFETIME_HOURS);
    const repairingWithContact = advanceGeoscape(contact, 18);
    const repaired = advanceGeoscape(damaged, repairHours);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const withWorkshop = completeFacilityConstruction(stocked, "workshop-2");
    const workshopDetected = advanceGeoscape(withWorkshop, 18);
    const workshopDamaged = interceptUfo(workshopDetected);

    expect(repairHours).toBe(interceptorRepairHours(detected, damaged.interceptor.damage));
    expect(repairingWithContact.ufoContact?.status).toBe("tracked");
    // The damaged primary is still repairing, but the standby interceptor can still launch.
    expect(isInterceptorReady(repairingWithContact)).toBe(true);
    expect(canLaunchInterceptor(repairingWithContact)).toBe(true);
    const secondStrike = interceptUfo(repairingWithContact);
    expect(secondStrike).not.toBe(repairingWithContact);
    expect(secondStrike.fleet!.find((craft) => craft.id === "int-2")?.sorties).toBe(1);
    expect(secondStrike.fleet!.find((craft) => craft.id === "int-2")?.damage).toBeGreaterThan(0);
    expect(repaired.interceptor).toEqual({ damage: 0, sorties: 1 });
    expect(isInterceptorReady(repaired)).toBe(true);
    expect(workshopDamaged.interceptor.repairedAtHour! - workshopDamaged.clock.elapsedHours).toBeLessThan(repairHours);
  });

  it("issues monthly funding reports with income, upkeep, and threat pressure", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const firstReport = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);
    const highThreat = advanceGeoscape(
      { ...campaign, strategic: { ...campaign.strategic, threat: 80 } },
      FUNDING_REPORT_INTERVAL_HOURS,
    );
    const highPanic = advanceGeoscape(
      {
        ...campaign,
        regionalPanic: {
          ...campaign.regionalPanic,
          Europe: 90,
        },
      },
      FUNDING_REPORT_INTERVAL_HOURS,
    );

    expect(firstReport.clock.lastFundingHour).toBe(FUNDING_REPORT_INTERVAL_HOURS);
    expect(firstReport.lastFundingReport).toMatchObject({
      reportNumber: 1,
      completedAtHour: FUNDING_REPORT_INTERVAL_HOURS,
      income: 600,
      upkeep: 387,
      net: 213,
      funding: 600,
      threat: 25,
    });
    expect(firstReport.resources.credits).toBe(campaign.resources.credits + 213);
    expect(firstReport.strategic.score).toBe(campaign.strategic.score + 21);

    expect(highThreat.strategic.funding).toBe(campaign.strategic.funding - 60);
    expect(highThreat.lastFundingReport?.summary).toContain("High threat cut future funding by 60c");

    expect(highPanic.strategic.funding).toBe(campaign.strategic.funding - 80);
    expect(highPanic.lastFundingReport?.summary).toContain("regional panic cut 80c");
  });

  it.each<[string, number]>([
    ["rookie", 310],
    ["veteran", 387],
    ["commander", 464],
  ])("scales monthly upkeep by difficulty upkeepMult (%s)", (difficulty, expectedUpkeep) => {
    const campaign = createCampaign(
      { lat: 2, lon: 14.2, region: "Africa" },
      12345,
      difficulty as "rookie" | "veteran" | "commander",
    );
    const report = advanceGeoscape(campaign, FUNDING_REPORT_INTERVAL_HOURS);

    expect(report.lastFundingReport?.upkeep).toBe(expectedUpkeep);
  });

  it("applies upkeepMult so commander upkeep > veteran upkeep > rookie upkeep", () => {
    const base = { lat: 2, lon: 14.2, region: "Africa" } as const;
    const rookie = advanceGeoscape(createCampaign(base, 12345, "rookie"), FUNDING_REPORT_INTERVAL_HOURS);
    const veteran = advanceGeoscape(createCampaign(base, 12345, "veteran"), FUNDING_REPORT_INTERVAL_HOURS);
    const commander = advanceGeoscape(createCampaign(base, 12345, "commander"), FUNDING_REPORT_INTERVAL_HOURS);

    expect(commander.lastFundingReport?.upkeep).toBeGreaterThan(veteran.lastFundingReport!.upkeep);
    expect(veteran.lastFundingReport?.upkeep).toBeGreaterThan(rookie.lastFundingReport!.upkeep);
  });

  it("records mission reports and advances the next mission seed", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const firstOperation = generateOperation(campaign);
    const afterWin = recordMissionResult(campaign, "success", firstOperation, "2026-06-15T00:00:00.000Z");
    const secondOperation = generateOperation(afterWin);
    const afterLoss = recordMissionResult(afterWin, "failure", secondOperation, "2026-06-16T00:00:00.000Z");

    expect(afterWin.missionsAttempted).toBe(1);
    expect(afterWin.missionsCompleted).toBe(1);
    expect(afterWin.strategic.threat).toBeLessThan(campaign.strategic.threat);
    expect(afterWin.strategic.funding).toBeGreaterThan(campaign.strategic.funding);
    expect(afterWin.strategic.score).toBeGreaterThan(campaign.strategic.score);
    expect(regionalPanicFor(afterWin, firstOperation.region)).toBe(
      regionalPanicFor(campaign, firstOperation.region)! - 18,
    );
    expect(afterWin.resources).toEqual({
      credits: campaign.resources.credits + firstOperation.reward.credits,
      alloys: firstOperation.reward.alloys,
      elerium: firstOperation.reward.elerium,
      alienData: firstOperation.reward.alienData,
    });
    expect(afterWin.lastMission?.result).toBe("success");
    expect(afterWin.lastMission?.missionNumber).toBe(1);
    expect(afterWin.lastMission?.codename).toBe(firstOperation.codename);
    expect(afterWin.lastMission?.reward).toEqual(firstOperation.reward);
    expect(campaignMissionSeed(afterWin)).not.toBe(firstOperation.missionSeed);

    expect(afterLoss.missionsAttempted).toBe(2);
    expect(afterLoss.missionsCompleted).toBe(1);
    expect(afterLoss.strategic.threat).toBeGreaterThan(afterWin.strategic.threat);
    expect(afterLoss.strategic.funding).toBeLessThan(afterWin.strategic.funding);
    expect(regionalPanicFor(afterLoss, secondOperation.region)).toBe(
      regionalPanicFor(afterWin, secondOperation.region)! + 18,
    );
    expect(afterLoss.resources.credits).toBe(afterWin.resources.credits + 50);
    expect(afterLoss.resources.alloys).toBe(afterWin.resources.alloys);
    expect(afterLoss.lastMission?.result).toBe("failure");
    expect(afterLoss.lastMission?.missionNumber).toBe(2);
  });

  it("advances projects and repairs while squads are deployed", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const operation = { ...generateOperation(campaign), durationHours: 6 };
    const staged = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
      activeResearch: {
        projectId: "alloyArmor" as const,
        startedAtHour: 0,
        completesAtHour: 4,
      },
      activeManufacturing: {
        projectId: "pistol" as const,
        startedAtHour: 0,
        completesAtHour: 5,
      },
      activeConstruction: {
        facilityId: "power-2",
        startedAtHour: 0,
        completesAtHour: 6,
      },
      interceptor: {
        damage: 30,
        sorties: 1,
        repairedAtHour: 3,
      },
    };

    const afterMission = recordMissionResult(staged, "success", operation, "2026-06-15T00:00:00.000Z");

    expect(afterMission.clock.elapsedHours).toBe(6);
    expect(afterMission.clock.lastContactHour).toBe(6);
    expect(afterMission.activeResearch).toBeUndefined();
    expect(afterMission.activeManufacturing).toBeUndefined();
    expect(afterMission.activeConstruction).toBeUndefined();
    expect(hasResearch(afterMission, "alloyArmor")).toBe(true);
    expect(afterMission.armory.weapons.pistol).toBe(campaign.armory.weapons.pistol + 1);
    expect(hasBaseFacility(afterMission, "power-2")).toBe(true);
    expect(afterMission.interceptor).toEqual({ damage: 0, sorties: 1 });
    expect(afterMission.projectReports.map((report) => report.kind)).toEqual([
      "construction",
      "manufacturing",
      "research",
    ]);
    expect(afterMission.projectReports.every((report) => report.completedAtHour === 6)).toBe(true);
  });

  it("tracks roster deployments, casualties, and recruitment", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const firstOperation = generateOperation(campaign);
    const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
    const afterWin = recordMissionResult(
      campaign,
      "success",
      firstOperation,
      {
        deployedSoldierIds: deployed,
        survivingSoldierIds: deployed.slice(0, 3),
      },
      "2026-06-15T00:00:00.000Z",
    );

    expect(afterWin.lastMission?.deployedSoldierIds).toEqual(deployed);
    expect(afterWin.lastMission?.kiaSoldierIds).toEqual([deployed[3]]);
    expect(afterWin.lastMission?.summary).toContain("Promotions: Vega to squaddie");
    expect(afterWin.soldiers.find((soldier) => soldier.id === deployed[0])?.missions).toBe(1);
    expect(afterWin.soldiers.find((soldier) => soldier.id === deployed[0])?.survivedMissions).toBe(1);
    expect(afterWin.soldiers.find((soldier) => soldier.id === deployed[0])?.rank).toBe("squaddie");
    expect(soldierStatBonus(afterWin.soldiers.find((soldier) => soldier.id === deployed[0])!)).toEqual({
      timeUnits: 2,
      health: 2,
      reactions: 4,
      firingAccuracy: 4,
    });
    expect(afterWin.soldiers.find((soldier) => soldier.id === deployed[3])?.status).toBe("kia");
    expect(activeSoldiers(afterWin)).toHaveLength(5);
    expect(deploymentSoldiers(afterWin).map((soldier) => soldier.id)).toEqual([
      deployed[0],
      deployed[1],
      deployed[2],
    ]);

    expect(canRecruitSoldier(afterWin)).toBe(true);
    const recruited = recruitSoldier(afterWin);
    expect(recruited.resources.credits).toBe(afterWin.resources.credits - RECRUIT_COST);
    expect(recruited.soldiers).toHaveLength(afterWin.soldiers.length + 1);
    expect(recruited.soldiers.at(-1)?.status).toBe("active");
    expect(recruited.soldiers.at(-1)?.rank).toBe("rookie");
  });

  it("records aborted mission failures without killing surviving operatives", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const operation = generateOperation(campaign);
    const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
    const aborted = recordMissionResult(
      campaign,
      "failure",
      operation,
      {
        deployedSoldierIds: deployed,
        survivingSoldierIds: deployed.slice(0, 3),
        survivorHealth: {
          [deployed[0]!]: { hp: 20, maxHp: 40 },
          [deployed[1]!]: { hp: 40, maxHp: 40 },
          [deployed[2]!]: { hp: 40, maxHp: 40 },
        },
      },
      "2026-06-15T00:00:00.000Z",
    );

    expect(aborted.lastMission?.result).toBe("failure");
    expect(aborted.lastMission?.summary).toContain("Operation aborted before recovery");
    expect(aborted.lastMission?.kiaSoldierIds).toEqual([deployed[3]]);
    expect(aborted.lastMission?.woundedSoldierIds).toEqual([deployed[0]]);
    expect(aborted.missionsAttempted).toBe(1);
    expect(aborted.missionsCompleted).toBe(0);
    expect(aborted.soldiers.find((soldier) => soldier.id === deployed[0])?.status).toBe("wounded");
    expect(aborted.soldiers.find((soldier) => soldier.id === deployed[1])?.status).toBe("active");
    expect(aborted.soldiers.find((soldier) => soldier.id === deployed[0])?.survivedMissions).toBe(0);
    expect(aborted.soldiers.find((soldier) => soldier.id === deployed[0])?.rank).toBe("rookie");
    expect(aborted.soldiers.find((soldier) => soldier.id === deployed[3])?.status).toBe("kia");
    expect(aborted.strategic.threat).toBeGreaterThan(campaign.strategic.threat);
    expect(aborted.strategic.funding).toBeLessThan(campaign.strategic.funding);
  });

  it("marks damaged survivors as wounded and recovers them through geoscape time", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const operation = generateOperation(campaign);
    const deployed = deploymentSoldiers(campaign).map((soldier) => soldier.id);
    const afterWin = recordMissionResult(
      campaign,
      "success",
      operation,
      {
        deployedSoldierIds: deployed,
        survivingSoldierIds: deployed,
        survivorHealth: {
          [deployed[0]!]: { hp: 20, maxHp: 40 },
          [deployed[1]!]: { hp: 40, maxHp: 40 },
          [deployed[2]!]: { hp: 39, maxHp: 40 },
          [deployed[3]!]: { hp: 40, maxHp: 40 },
        },
      },
      "2026-06-15T00:00:00.000Z",
    );
    const wounded = afterWin.soldiers.find((soldier) => soldier.id === deployed[0])!;
    const grazed = afterWin.soldiers.find((soldier) => soldier.id === deployed[2])!;
    const almostRecovered = advanceGeoscape(afterWin, 35);
    const recovered = advanceGeoscape(afterWin, 36);

    expect(afterWin.lastMission?.woundedSoldierIds).toEqual([deployed[0], deployed[2]]);
    expect(afterWin.lastMission?.summary).toContain("2 survivors are in medical recovery");
    expect(wounded.status).toBe("wounded");
    expect(wounded.woundedUntilHour).toBe(afterWin.clock.elapsedHours + 36);
    expect(grazed.status).toBe("wounded");
    expect(grazed.woundedUntilHour).toBe(afterWin.clock.elapsedHours + 12);
    expect(activeSoldiers(afterWin).map((soldier) => soldier.id)).not.toContain(deployed[0]);
    expect(livingSoldiers(afterWin)).toHaveLength(6);
    expect(deploymentSoldiers(afterWin).map((soldier) => soldier.id)).toEqual([
      deployed[1],
      deployed[3],
    ]);
    expect(almostRecovered.soldiers.find((soldier) => soldier.id === deployed[0])?.status).toBe("wounded");
    expect(almostRecovered.soldiers.find((soldier) => soldier.id === deployed[2])?.status).toBe("active");
    expect(recovered.soldiers.find((soldier) => soldier.id === deployed[0])?.status).toBe("active");
    expect(deploymentSoldiers(recovered).map((soldier) => soldier.id)).toEqual([deployed[1], deployed[3]]);
  });

  it("cuts wound recovery time after building the med bay", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const medbay = completeFacilityConstruction(stocked, MEDBAY_FACILITY_ID);
    const operation = generateOperation(medbay);
    const deployed = deploymentSoldiers(medbay).map((soldier) => soldier.id);
    const afterWin = recordMissionResult(
      medbay,
      "success",
      operation,
      {
        deployedSoldierIds: deployed,
        survivingSoldierIds: deployed,
        survivorHealth: {
          [deployed[0]!]: { hp: 20, maxHp: 40 },
          [deployed[1]!]: { hp: 39, maxHp: 40 },
          [deployed[2]!]: { hp: 40, maxHp: 40 },
          [deployed[3]!]: { hp: 40, maxHp: 40 },
        },
      },
      "2026-06-15T00:00:00.000Z",
    );
    const wounded = afterWin.soldiers.find((soldier) => soldier.id === deployed[0])!;
    const grazed = afterWin.soldiers.find((soldier) => soldier.id === deployed[1])!;

    expect(hasBaseFacility(medbay, MEDBAY_FACILITY_ID)).toBe(true);
    expect(afterWin.lastMission?.woundedSoldierIds).toEqual([deployed[0], deployed[1]]);
    expect(wounded.woundedUntilHour).toBe(afterWin.clock.elapsedHours + 27);
    expect(grazed.woundedUntilHour).toBe(afterWin.clock.elapsedHours + 12);
  });

  it("can win or lose the campaign through strategic outcomes", () => {
    let winning = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    for (let i = 0; i < CAMPAIGN_VICTORY_OPERATIONS; i++) {
      winning = recordMissionResult(winning, "success", generateOperation(winning), `2026-06-${15 + i}T00:00:00.000Z`);
    }
    expect(winning.strategic.status).toBe("won");
    expect(winning.missionsCompleted).toBe(CAMPAIGN_VICTORY_OPERATIONS);
    expect(campaignObjectiveProgress(winning)).toMatchObject({
      completed: CAMPAIGN_VICTORY_OPERATIONS,
      remaining: 0,
      percent: 100,
      status: "won",
      title: "Containment achieved",
    });

    let losing = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    for (let i = 0; i < 4; i++) {
      losing = recordMissionResult(losing, "failure", generateOperation(losing), `2026-06-${15 + i}T00:00:00.000Z`);
    }
    expect(losing.strategic.status).toBe("lost");
    expect(losing.strategic.threat).toBeGreaterThanOrEqual(100);
    expect(campaignObjectiveProgress(losing)).toMatchObject({
      completed: 0,
      remaining: CAMPAIGN_VICTORY_OPERATIONS,
      status: "lost",
      title: "Containment failed",
    });
  });

  it("loses only when the roster is wiped and replacements are unaffordable", () => {
    const base = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const leanRoster = base.soldiers.slice(0, 4);
    const deployed = leanRoster.map((soldier) => soldier.id);
    const operation = generateOperation(base);

    const broke = recordMissionResult(
      { ...base, resources: { ...base.resources, credits: 0 }, soldiers: leanRoster },
      "failure",
      operation,
      { deployedSoldierIds: deployed, survivingSoldierIds: [] },
      "2026-06-15T00:00:00.000Z",
    );
    expect(activeSoldiers(broke)).toHaveLength(0);
    expect(broke.resources.credits).toBe(50);
    expect(canRecruitSoldier(broke)).toBe(false);
    expect(broke.strategic.status).toBe("lost");

    const recoverable = recordMissionResult(
      { ...base, resources: { ...base.resources, credits: 80 }, soldiers: leanRoster },
      "failure",
      operation,
      { deployedSoldierIds: deployed, survivingSoldierIds: [] },
      "2026-06-15T00:00:00.000Z",
    );
    expect(activeSoldiers(recoverable)).toHaveLength(0);
    expect(recoverable.resources.credits).toBe(130);
    expect(canRecruitSoldier(recoverable)).toBe(true);
    expect(recoverable.strategic.status).toBe("active");
  });

  it("spends recovered resources to start timed research projects", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const recovered = recordMissionResult(campaign, "success", generateOperation(campaign), "2026-06-15T00:00:00.000Z");
    const plasmaStarted = startResearch(recovered, "plasmaWeapons");
    const plasmaPartial = advanceGeoscape(plasmaStarted, researchDuration(plasmaStarted, "plasmaWeapons") - 1);
    const plasmaDone = advanceGeoscape(plasmaStarted, researchDuration(plasmaStarted, "plasmaWeapons"));
    const armored = completeResearch(recovered, "alloyArmor");

    expect(canStartResearch(campaign, "plasmaWeapons")).toBe(false);
    expect(canStartResearch(recovered, "plasmaWeapons")).toBe(true);
    expect(canCompleteResearch(recovered, "alloyArmor")).toBe(true);
    expect(plasmaStarted.activeResearch).toEqual({
      projectId: "plasmaWeapons",
      startedAtHour: recovered.clock.elapsedHours,
      completesAtHour: recovered.clock.elapsedHours + researchDuration(recovered, "plasmaWeapons"),
    });
    expect(canStartResearch(plasmaStarted, "alloyArmor")).toBe(false);
    expect(hasResearch(plasmaPartial, "plasmaWeapons")).toBe(false);
    expect(plasmaPartial.activeResearch?.projectId).toBe("plasmaWeapons");
    expect(plasmaPartial.armory.weapons.plasma).toBe(0);
    expect(hasResearch(plasmaDone, "plasmaWeapons")).toBe(true);
    expect(plasmaDone.activeResearch).toBeUndefined();
    expect(plasmaDone.armory.weapons.plasma).toBe(1);
    expect(plasmaDone.projectReports[0]).toMatchObject({
      kind: "research",
      id: "plasmaWeapons",
      title: "Plasma weapons complete",
      completedAtHour: plasmaStarted.activeResearch?.completesAtHour,
    });
    expect(hasResearch(armored, "alloyArmor")).toBe(true);
    expect(armored.projectReports[0]).toMatchObject({
      kind: "research",
      id: "alloyArmor",
      title: "Alloy armor complete",
      completedAtHour: recovered.clock.elapsedHours,
    });
    expect(plasmaStarted.resources).toEqual({
      credits: recovered.resources.credits - RESEARCH_COSTS.plasmaWeapons.credits,
      alloys: recovered.resources.alloys - RESEARCH_COSTS.plasmaWeapons.alloys,
      elerium: recovered.resources.elerium - RESEARCH_COSTS.plasmaWeapons.elerium,
      alienData: recovered.resources.alienData - RESEARCH_COSTS.plasmaWeapons.alienData,
    });
    expect(armored.resources).toEqual({
      credits: recovered.resources.credits - RESEARCH_COSTS.alloyArmor.credits,
      alloys: recovered.resources.alloys - RESEARCH_COSTS.alloyArmor.alloys,
      elerium: recovered.resources.elerium - RESEARCH_COSTS.alloyArmor.elerium,
      alienData: recovered.resources.alienData - RESEARCH_COSTS.alloyArmor.alienData,
    });
    expect(campaignSoldierStatBonus(armored, armored.soldiers[0]!)).toEqual({
      timeUnits: 0,
      health: 6,
      reactions: 2,
      firingAccuracy: 0,
    });
    expect(completeResearch(plasmaDone, "plasmaWeapons")).toBe(plasmaDone);
  });

  it("constructs base facilities with resource spending and power accounting", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const recovered = recordMissionResult(
      campaign,
      "success",
      generateOperation(campaign),
      "2026-06-15T00:00:00.000Z",
    );

    expect(constructedFacilities(campaign).map((facility) => facility.id)).toEqual([...STARTER_BASE_FACILITY_IDS]);
    expect(availableBaseFacilities(campaign).map((facility) => facility.id)).toEqual([
      "radar-2",
      "lab-2",
      MEDBAY_FACILITY_ID,
      "workshop-2",
      "power-2",
    ]);
    expect(canBuildFacility(campaign, "radar-2")).toBe(false);
    expect(canBuildFacility(recovered, "radar-2")).toBe(true);

    const started = buildFacility(recovered, "radar-2");
    const partial = advanceGeoscape(started, facilityConstructionDuration(recovered, "radar-2") - 1);
    const upgraded = advanceGeoscape(started, facilityConstructionDuration(recovered, "radar-2"));
    expect(hasBaseFacility(started, "radar-2")).toBe(false);
    expect(started.activeConstruction).toEqual({
      facilityId: "radar-2",
      startedAtHour: recovered.clock.elapsedHours,
      completesAtHour: recovered.clock.elapsedHours + facilityConstructionDuration(recovered, "radar-2"),
    });
    expect(started.resources.credits).toBe(recovered.resources.credits - 220);
    expect(started.resources.alloys).toBe(recovered.resources.alloys - 6);
    expect(started.resources.alienData).toBe(recovered.resources.alienData - 2);
    expect(canBuildFacility(started, "lab-2")).toBe(false);
    expect(availableBaseFacilities(started).map((facility) => facility.id)).toEqual([
      "lab-2",
      MEDBAY_FACILITY_ID,
      "workshop-2",
      "power-2",
    ]);
    expect(hasBaseFacility(partial, "radar-2")).toBe(false);
    expect(partial.activeConstruction?.facilityId).toBe("radar-2");
    expect(hasBaseFacility(upgraded, "radar-2")).toBe(true);
    expect(upgraded.activeConstruction).toBeUndefined();
    expect(upgraded.resources).toEqual(started.resources);
    expect(upgraded.projectReports[0]).toMatchObject({
      kind: "construction",
      id: "radar-2",
      title: "Tracking Uplink online",
      completedAtHour: started.activeConstruction?.completesAtHour,
    });
    expect(summarizeBaseFacilities(constructedFacilities(upgraded)).powerUsed).toBe(39);
    expect(canBuildFacility(upgraded, "radar-2")).toBe(false);
    expect(buildFacility(upgraded, "radar-2")).toBe(upgraded);
  });

  it("base upgrades affect operations, threat, and research costs", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const radar = completeFacilityConstruction(stocked, "radar-2");
    const fabricated = completeFacilityConstruction(radar, "workshop-2");
    const annex = completeFacilityConstruction(stocked, "lab-2");

    const baseOperation = generateOperation(campaign);
    const radarOperation = generateOperation(radar);
    const fabricatedOperation = generateOperation(fabricated);

    expect(radarOperation.enemyCount).toBe(Math.max(3, baseOperation.enemyCount - 1));
    expect(radarOperation.reward.alienData).toBe(2 + Math.floor(radarOperation.enemyCount / 3) + 1);
    expect(fabricatedOperation.reward.credits).toBe(radarOperation.reward.credits + 40);
    expect(fabricatedOperation.reward.alloys).toBe(radarOperation.reward.alloys + 4);

    const failedWithoutRadar = recordMissionResult(campaign, "failure", baseOperation, "2026-06-15T00:00:00.000Z");
    const failedWithRadar = recordMissionResult(radar, "failure", radarOperation, "2026-06-15T00:00:00.000Z");
    expect(failedWithoutRadar.strategic.threat - campaign.strategic.threat).toBe(24);
    expect(failedWithRadar.strategic.threat - radar.strategic.threat).toBe(18);

    expect(researchCost(campaign, "plasmaWeapons")).toEqual(RESEARCH_COSTS.plasmaWeapons);
    expect(researchCost(annex, "plasmaWeapons")).toEqual({
      credits: 160,
      alloys: 8,
      elerium: 2,
      alienData: 2,
    });
    expect(researchDuration(annex, "plasmaWeapons")).toBe(18);
  });

  it("generates deterministic operation plans from campaign progress", () => {
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    const first = generateOperation(campaign);
    const again = generateOperation(campaign);
    const after = recordMissionResult(campaign, "success", first, "2026-06-15T00:00:00.000Z");
    const second = generateOperation(after);

    expect(first).toEqual(again);
    expect(first.missionNumber).toBe(1);
    expect(first.region).toBe("Africa");
    expect(["farmland", "urban", "desert"]).toContain(first.themeId);
    expect(first.durationHours).toBeGreaterThanOrEqual(6);
    expect(first.enemyCount).toBeGreaterThanOrEqual(5);
    expect(first.reward.credits).toBeGreaterThan(0);
    expect(second.missionNumber).toBe(2);
    expect(second.missionSeed).not.toBe(first.missionSeed);
  });

  it("summarizes the starter base facilities for the base view", () => {
    const summary = summarizeBaseFacilities();

    expect(STARTER_BASE_GRID).toEqual({ width: 8, height: 5 });
    expect(summary.facilities).toBe(STARTER_BASE_FACILITIES.length);
    expect(summary.powerUsed).toBe(32);
    expect(summary.powerCapacity).toBe(55);
    expect(summary.staffAssigned).toBe(86);
    expect(summary.hangarSlots).toBe(4);
  });
});
