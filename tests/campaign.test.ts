import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  STARTER_BASE_FACILITY_IDS,
  STARTER_BASE_FACILITIES,
  STARTER_BASE_GRID,
  summarizeBaseFacilities,
} from "../src/campaign/base";
import {
  advanceGeoscape,
  canLaunchInterceptor,
  CONTACT_PENALTY_SCALE,
  createUfoContact,
  CRASH_SITE_LIFETIME_HOURS,
  FUNDING_REPORT_INTERVAL_HOURS,
  interceptUfo,
  interceptionForecast,
  interceptorRepairHours,
  isInterceptorReady,
  UFO_CONTACT_LIFETIME_HOURS,
  UFO_TYPE_PROFILES,
} from "../src/campaign/geoscape";
import { generateOperation } from "../src/campaign/operations";
import {
  activeSoldiers,
  assignSoldierWeapon,
  availableBaseFacilities,
  availableWeaponCount,
  buildFacility,
  CAMPAIGN_STORAGE_KEY,
  CAMPAIGN_VICTORY_OPERATIONS,
  campaignInfiltration,
  campaignMissionSeed,
  canAssignSoldierWeapon,
  canBuildFacility,
  canDeploySoldier,
  canCompleteResearch,
  canRecruitSoldier,
  canStartResearch,
  canStartManufacturing,
  campaignObjectiveProgress,
  COUNCIL_REGIONS,
  clearCampaign,
  completeFacilityConstruction,
  completeResearch,
  constructedFacilities,
  createCampaign,
  defectedRegions,
  DIFFICULTY_CONFIGS,
  deploymentSoldiers,
  deploymentWeaponIds,
  difficultyConfig,
  campaignSoldierStatBonus,
  hasBaseFacility,
  hasResearch,
  highestRegionalPanic,
  livingSoldiers,
  loadCampaign,
  manufacturingCost,
  manufacturingDuration,
  MANUFACTURING_PROJECTS,
  MEDBAY_FACILITY_ID,
  RESEARCH_COSTS,
  RESEARCH_IDS,
  facilityConstructionDuration,
  researchDuration,
  researchCost,
  RECRUIT_COST,
  recruitSoldier,
  regionalInfiltrationFor,
  regionalPanicFor,
  recordMissionResult,
  saveCampaign,
  setSoldierDeployment,
  soldierStatBonus,
  soldierWeaponId,
  startManufacturing,
  startResearch,
  STARTING_INFILTRATION,
  STARTING_REGIONAL_PANIC,
  THREAT_LOSS_THRESHOLD,
  updateCampaignBase,
  ARC_FAILURE_RELIEF,
} from "../src/campaign/storage";
import { ITEMS, WEAPONS } from "../src/sim/content";
import type { CampaignState, Craft, MissionType, UfoContact } from "../src/campaign/types";

describe("campaign state", () => {
  it("creates a persistent campaign record from a base location", () => {
    const campaign = createCampaign({ lat: 12.3, lon: -45.6, region: "Atlantic sector" }, 12345);

    expect(campaign.version).toBe(1);
    expect(campaign.id).toBe("campaign-00003039");
    expect(campaign.seed).toBe(12345);
    expect(campaign.base.region).toBe("Atlantic sector");
    expect(campaign.strategic).toEqual({ status: "active", threat: 20, funding: 640, score: 0 });
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
    expect(campaign.resources).toEqual({ credits: 800, alloys: 0, elerium: 0, alienData: 0 });
    expect(campaign.armory.weapons).toEqual({ rifle: 6, pistol: 2, plasma: 0, cannon: 0 });
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
    // Month-0 contactInterval is stretched by the arc-stretch ramp: base 18h (no
    // radar-2) becomes round(18 * 1.6) = 29h. Seed 12345 rolls a "dangerous, escapes"
    // UFO at that new hour, so this scenario uses seed 98, which still rolls an
    // easily-interceptable scout, to keep testing the same detect->intercept->crash
    // ->mission flow.
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 98);
    const searching = advanceGeoscape(campaign, 6);
    const detected = advanceGeoscape(searching, 23);
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
      day: 2,
      hour: 5,
      elapsedHours: 29,
      lastContactHour: 29,
      lastFundingHour: 0,
    });
    expect(detected.ufoContact?.id).toMatch(/^UFO-01-/);
    expect(detected.ufoContact?.status).toBe("tracked");
    // Seed 98/hour 29 rolls a scout (30h lifetime) — ufoType now drives expiry, not the mission.
    expect(detected.ufoContact?.ufoType).toBe("scout");
    expect(detected.ufoContact?.expiresAtHour).toBe(29 + UFO_TYPE_PROFILES.scout.lifetimeHours);
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
    // Shooting down a UFO relieves regional panic, scaled by difficulty panicMult
    // (consistent with every other panic adjustment in the campaign layer).
    const interceptRelief = Math.round(4 * difficultyConfig(detected).panicMult);
    expect(regionalPanicFor(intercepted, detected.ufoContact!.region)).toBe(
      regionalPanicFor(detected, detected.ufoContact!.region)! - interceptRelief,
    );
    expect(intercepted.ufoContact?.interceptedAtHour).toBe(29);
    expect(intercepted.ufoContact?.expiresAtHour).toBe(29 + CRASH_SITE_LIFETIME_HOURS);
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
    // Month-0 contactInterval is stretched by the arc-stretch ramp: base 18h (no
    // radar-2) becomes round(18 * 1.6) = 29h, and base 12h (radar-2) becomes
    // round(12 * 1.6) = 19h. Seed 98 keeps rolling an easily-classified scout.
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 98);
    const detected = advanceGeoscape(campaign, 29);
    const expired = advanceGeoscape(detected, UFO_CONTACT_LIFETIME_HOURS);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const radar = completeFacilityConstruction(stocked, "radar-2");
    const radarDetected = advanceGeoscape(radar, 19);

    expect(detected.ufoContact).toBeDefined();
    expect(expired.ufoContact).toBeUndefined();
    // Veteran threatGainMult (0.55) and the arc-stretch CONTACT_PENALTY_SCALE (0.3)
    // both scale the ignored-contact threat gain: round(6 * 0.55 * 0.3) = 1.
    expect(expired.strategic.threat - campaign.strategic.threat).toBe(1);
    // Funding cut is eased the same way: round(15 * 0.3) = 5.
    expect(campaign.strategic.funding - expired.strategic.funding).toBe(5);
    // Baseline ignore panic (18 local) is scaled by CONTACT_PENALTY_SCALE (0.3) THEN
    // veteran panicMult (0.75): round(round(18 * 0.3) * 0.75) = 4.
    expect(regionalPanicFor(expired, detected.ufoContact!.region)).toBe(
      regionalPanicFor(campaign, detected.ufoContact!.region)! + 4,
    );
    expect(highestRegionalPanic(expired).region).toBe(detected.ufoContact!.region);
    expect(expired.clock.lastContactHour).toBe(expired.clock.elapsedHours);
    expect(radarDetected.ufoContact).toBeDefined();
    expect(radarDetected.clock.elapsedHours).toBe(19);
  });

  it("can fail an interception against a strong UFO and applies escape pressure", () => {
    // Month-0 contactInterval is stretched to round(18 * 1.6) = 29h (see the
    // arc-stretch ramp in contactInterval). Seed 68 rolls a terror ship (strength 5,
    // speed 1.0) at that hour: it OUTRUNS the starting Raptor (0.9), so it escapes
    // the pursuit regardless of engagement score. radar-2 tips the score but not the
    // speed gate — only a faster craft (a Phantom, 1.6) can force this hull down.
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 68);
    const detected = advanceGeoscape(campaign, 29);
    const forecast = interceptionForecast(detected);
    const failed = interceptUfo(detected);
    const stocked = {
      ...detected,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    // radar-2 alone still cannot catch a faster UFO — the speed gate stands.
    const radar = completeFacilityConstruction(stocked, "radar-2");
    const radarForecast = interceptionForecast(radar);
    // A Phantom in the hangar (fastest ready craft) removes the speed gate; with
    // radar-2's score edge the terror ship is finally forced down.
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
    const withPhantom: CampaignState = { ...radar, fleet: [...radar.fleet!, phantom] };
    const phantomForecast = interceptionForecast(withPhantom);
    const recovered = interceptUfo(withPhantom);

    expect(detected.ufoContact?.strength).toBe(5);
    expect(forecast).toMatchObject({
      risk: "dangerous",
      succeeds: false,
      canLaunch: true,
      strength: 5,
    });
    expect(forecast?.summary).toContain("outruns");
    expect(failed.ufoContact).toBeUndefined();
    expect(failed.lastInterceptionReport).toMatchObject({
      contactId: detected.ufoContact?.id,
      result: "escaped",
      region: detected.ufoContact?.region,
      strength: 5,
      completedAtHour: detected.clock.elapsedHours,
    });
    expect(failed.lastInterceptionReport?.summary).toContain("escaped");
    expect(failed.interceptor.sorties).toBe(1);
    // The terror ship outran the Raptor before weapons range: it costs strategic
    // pressure and fuel, but a clean stern chase does not create repair damage.
    expect(failed.interceptor.damage).toBe(0);
    expect(failed.interceptor.repairedAtHour).toBeUndefined();
    expect(failed.clock.lastContactHour).toBe(failed.clock.elapsedHours);
    // Escaped-interception threat gain is scaled by veteran threatGainMult AND the
    // arc-stretch CONTACT_PENALTY_SCALE (0.3): round(6 * 0.55 * 0.3) = 1.
    expect(failed.strategic.threat - detected.strategic.threat).toBe(1);
    // Funding cut is eased the same way: round(15 * 0.3) = 5.
    expect(detected.strategic.funding - failed.strategic.funding).toBe(5);
    // Escape panic (8 local) is scaled by CONTACT_PENALTY_SCALE (0.3) THEN veteran
    // panicMult (0.75): round(round(8 * 0.3) * 0.75) = 2.
    expect(regionalPanicFor(failed, detected.ufoContact!.region)).toBe(
      regionalPanicFor(detected, detected.ufoContact!.region)! + 2,
    );
    // radar-2 alone: still outrun, still a dangerous forecast that escapes.
    expect(radarForecast?.succeeds).toBe(false);
    expect(radarForecast?.risk).toBe("dangerous");
    // Phantom + radar-2: the speed gate is gone and the score edge forces it down.
    expect(phantomForecast).toMatchObject({
      risk: "favorable",
      succeeds: true,
      strength: 5,
    });
    expect(recovered.ufoContact?.status).toBe("crashed");
    expect(recovered.lastInterceptionReport?.result).toBe("crashed");
  });

  it("repairs interceptor damage over geoscape time while the standby interceptor covers launches", () => {
    // Month-0 contactInterval is stretched to round(18 * 1.6) = 29h (see the
    // arc-stretch ramp in contactInterval). Seed 33 rolls a scout at that hour; the
    // auto-resolve shoots it down. While int-1 is grounded a fresh tracked
    // crash-site contact appears, so the standby interceptor (int-2) covers the
    // launch. (CRASH_SITE_LIFETIME_HOURS now equals int-1's 48h repair window, so advancing
    // by it would repair the primary exactly when the crash site expires; staging a fresh
    // tracked contact isolates the standby-launch behaviour from that timing collision.)
    const campaign = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 33);
    const detected = advanceGeoscape(campaign, 29);
    const damaged = interceptUfo(detected);
    const repairHours = damaged.interceptor.repairedAtHour! - damaged.clock.elapsedHours;
    // Stage a fresh tracked crash-site contact for the standby to engage while int-1 repairs.
    const repairingWithContact: CampaignState = {
      ...damaged,
      ufoContact: createUfoContact(damaged, damaged.clock.elapsedHours),
    };
    const repaired = advanceGeoscape(damaged, repairHours);
    const stocked = {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
    const withWorkshop = completeFacilityConstruction(stocked, "workshop-2");
    const workshopDetected = advanceGeoscape(withWorkshop, 29);
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
      income: 640,
      upkeep: 385,
      net: 255,
      funding: 640,
      threat: 20,
    });
    expect(firstReport.resources.credits).toBe(campaign.resources.credits + 255);
    expect(firstReport.strategic.score).toBe(campaign.strategic.score + 25);

    // Veteran fundingPressureMult (0.85) AND the arc-stretch CONTACT_PENALTY_SCALE
    // (0.3, easing this recurring no-decay monthly cut for the longer 8-op arc)
    // both scale the pressure: round(45 * 0.85 * 0.3) = 11, round(80 * 0.85 * 0.3) = 20.
    const threatCut = Math.round(45 * DIFFICULTY_CONFIGS.veteran.fundingPressureMult * CONTACT_PENALTY_SCALE.veteran);
    const panicCut = Math.round(80 * DIFFICULTY_CONFIGS.veteran.fundingPressureMult * CONTACT_PENALTY_SCALE.veteran);
    expect(highThreat.strategic.funding).toBe(campaign.strategic.funding - threatCut);
    expect(highThreat.lastFundingReport?.summary).toContain(`High threat cut future funding by ${threatCut}c`);

    expect(highPanic.strategic.funding).toBe(campaign.strategic.funding - panicCut);
    expect(highPanic.lastFundingReport?.summary).toContain(`regional panic cut ${panicCut}c`);
  });

  it.each<[string, number]>([
    ["rookie", 308],
    ["veteran", 385],
    // commander upkeepMult retuned 1.2 -> 1.15 (round13 §3f rebalance): round(385*1.15)=443.
    ["commander", 443],
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
    // Success panic relief (-18 base) is scaled by veteran panicMult 0.75: round(-18 * 0.75) = -13.
    expect(regionalPanicFor(afterWin, firstOperation.region)).toBe(
      regionalPanicFor(campaign, firstOperation.region)! - 13,
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
    // Failure panic (+18 base) is scaled DOWN by the arc-stretch ARC_FAILURE_RELIEF
    // (0.3, easing failure penalties for the longer 8-op arc) THEN veteran panicMult
    // (0.75): round(round(18 * 0.3) * 0.75) = 4.
    expect(regionalPanicFor(afterLoss, secondOperation.region)).toBe(
      regionalPanicFor(afterWin, secondOperation.region)! +
        Math.round(Math.round(18 * ARC_FAILURE_RELIEF.veteran) * DIFFICULTY_CONFIGS.veteran.panicMult),
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
    // The ops-fallback HQ reveal (and canLaunchFinalAssault) also require the first
    // council report to have fired (lastCouncilMonth >= 1) — stage that directly so
    // this test can focus on the ops-milestone behavior without advancing 30 days.
    winning = { ...winning, lastCouncilMonth: 1 };
    for (let i = 0; i < CAMPAIGN_VICTORY_OPERATIONS; i++) {
      winning = recordMissionResult(winning, "success", generateOperation(winning), `2026-06-${15 + i}T00:00:00.000Z`);
    }
    // Reaching the operations milestone no longer wins: it reveals the alien HQ
    // and unlocks the final assault (the fallback path). Victory requires winning
    // that assault.
    expect(winning.strategic.status).toBe("active");
    expect(winning.missionsCompleted).toBe(CAMPAIGN_VICTORY_OPERATIONS);
    expect(winning.alienHq?.revealed).toBe(true);
    const finalAssault = generateOperation(winning, "alienBaseAssault");
    winning = recordMissionResult(winning, "success", finalAssault, "2026-06-25T00:00:00.000Z");
    expect(winning.strategic.status).toBe("won");
    expect(campaignObjectiveProgress(winning)).toMatchObject({
      completed: CAMPAIGN_VICTORY_OPERATIONS,
      remaining: 0,
      percent: 100,
      status: "won",
      title: "Containment achieved",
    });

    let losing = createCampaign({ lat: 2, lon: 14.2, region: "Africa" }, 12345);
    // The raised doom-clock ceiling (THREAT_LOSS_THRESHOLD) plus the veteran
    // threatGainMult (0.55) AND the arc-stretch ARC_FAILURE_RELIEF (0.3, easing
    // failure penalties for the longer 8-op arc) mean five failures no longer
    // collapse a fresh campaign. Stage a campaign already deep in the doom clock so
    // the accumulated failure penalties (round(16 * 0.55 * 0.3) = 3 each) tip it
    // over the threshold exactly on the fifth defeat.
    const perFailureThreatGain = Math.round(16 * DIFFICULTY_CONFIGS.veteran.threatGainMult * ARC_FAILURE_RELIEF.veteran);
    losing = {
      ...losing,
      strategic: { ...losing.strategic, threat: THREAT_LOSS_THRESHOLD - perFailureThreatGain * 5 },
    };
    for (let i = 0; i < 5; i++) {
      losing = recordMissionResult(losing, "failure", generateOperation(losing), `2026-06-${15 + i}T00:00:00.000Z`);
    }
    expect(losing.strategic.status).toBe("lost");
    expect(losing.strategic.threat).toBeGreaterThanOrEqual(THREAT_LOSS_THRESHOLD);
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
      "hangar-4",
      "command-1",
      "power-1",
      "radar-2",
      "lab-2",
      MEDBAY_FACILITY_ID,
      "workshop-2",
      "power-2",
      "containment",
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
      "hangar-4",
      "command-1",
      "power-1",
      "lab-2",
      MEDBAY_FACILITY_ID,
      "workshop-2",
      "power-2",
      "containment",
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
    // Failure threat gain is scaled by veteran threatGainMult (0.55) AND the
    // arc-stretch ARC_FAILURE_RELIEF (0.3): round(16 * 0.55 * 0.3) = 3 without
    // radar, round(12 * 0.55 * 0.3) = 2 with radar.
    const veteranThreatGain = DIFFICULTY_CONFIGS.veteran.threatGainMult * ARC_FAILURE_RELIEF.veteran;
    expect(failedWithoutRadar.strategic.threat - campaign.strategic.threat).toBe(Math.round(16 * veteranThreatGain));
    expect(failedWithRadar.strategic.threat - radar.strategic.threat).toBe(Math.round(12 * veteranThreatGain));

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
    expect(["farmland", "urban", "desert", "arctic", "jungle", "forest"]).toContain(first.themeId);
    expect(first.durationHours).toBeGreaterThanOrEqual(6);
    // Veteran enemyCountMult (0.7) scales the baseline crew down from the legacy ~6 to 4.
    expect(first.enemyCount).toBeGreaterThanOrEqual(4);
    expect(first.reward.credits).toBeGreaterThan(0);
    expect(second.missionNumber).toBe(2);
    expect(second.missionSeed).not.toBe(first.missionSeed);
  });

  it("summarizes the starter base facilities for the base view", () => {
    const summary = summarizeBaseFacilities();

    expect(STARTER_BASE_GRID).toEqual({ width: 6, height: 6 });
    expect(summary.facilities).toBe(STARTER_BASE_FACILITIES.length);
    expect(summary.powerUsed).toBe(32);
    expect(summary.powerCapacity).toBe(55);
    expect(summary.staffAssigned).toBe(85);
    expect(summary.hangarSlots).toBe(3);
  });

  it("spawns a base-defense contact at the base location and only under very high threat", () => {
    const baseLocation = { lat: 48.8, lon: 2.3, region: "Europe" };
    const campaign = createCampaign(baseLocation, 12345);

    // A base-defense assault spawns already on the ground, on the player's own base.
    const defense = createUfoContact(campaign, 18, "baseDefense");
    expect(defense.missionType).toBe("baseDefense");
    expect(defense.status).toBe("landed");
    expect(defense.region).toBe("Europe");
    expect(defense.lat).toBe(48.8);
    expect(defense.lon).toBe(2.3);

    // generateOperation turns that contact into a base-defense mission pinned to the base.
    const operation = generateOperation({ ...campaign, ufoContact: defense });
    expect(operation.missionType).toBe("baseDefense");
    expect(operation.region).toBe("Europe");
    expect(operation.objective).toBe("Repel the base assault.");
    expect(operation.briefing).toContain("our base in Europe");
    // The assault force scales with strategic threat.
    const lowThreatOp = generateOperation({
      ...campaign,
      ufoContact: defense,
      strategic: { ...campaign.strategic, threat: 30 },
    });
    const highThreatOp = generateOperation({
      ...campaign,
      ufoContact: defense,
      strategic: { ...campaign.strategic, threat: 95 },
    });
    expect(highThreatOp.enemyCount).toBeGreaterThan(lowThreatOp.enemyCount);

    // Held at low threat/panic, a campaign never rolls a baseDefense spawn (high-threat only).
    for (let seed = 1; seed <= 25; seed++) {
      let low = createCampaign(baseLocation, seed);
      for (let step = 0; step < 10; step++) {
        low = advanceGeoscape(low, 36);
        expect(low.ufoContact?.missionType).not.toBe("baseDefense");
        low = {
          ...low,
          strategic: {
            ...low.strategic,
            status: "active" as const,
            threat: 25,
            funding: 600,
            score: 0,
          },
          regionalPanic: { ...STARTING_REGIONAL_PANIC },
        };
      }
    }
  });
});

describe("manufacturing catalog", () => {
  const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;

  /** A resource-flush campaign so every project is affordable once its research clears. */
  function stocked(seed = 12345): CampaignState {
    const campaign = createCampaign(BASE, seed);
    return {
      ...campaign,
      resources: { credits: 1500, alloys: 50, elerium: 10, alienData: 20 },
    };
  }

  it("exposes the original three weapon projects plus three gear projects and the Phantom craft", () => {
    const ids = MANUFACTURING_PROJECTS.map((project) => project.id);
    expect(ids).toHaveLength(7);
    expect(new Set(ids)).toEqual(
      new Set(["pistol", "rifle", "plasma", "grenade", "medkit", "cannon", "phantom"]),
    );
    // The original three projects still produce their weapon into armory.weapons.
    for (const id of ["pistol", "rifle", "plasma"] as const) {
      const project = MANUFACTURING_PROJECTS.find((entry) => entry.id === id)!;
      expect(project.product).toEqual({ kind: "weapon", weaponId: id, quantity: 1 });
    }
  });

  it("fabricates an item batch (grenades) and single items (medkit) into armory.items", () => {
    const before = stocked();
    const grenadeStarted = startManufacturing(before, "grenade");
    const grenadeDone = advanceGeoscape(grenadeStarted, manufacturingDuration(before, "grenade"));
    const medkitStarted = startManufacturing(grenadeDone, "medkit");
    const medkitDone = advanceGeoscape(medkitStarted, manufacturingDuration(grenadeDone, "medkit"));

    // Frag grenade project fabricates a batch of 2; medkit adds one.
    expect(grenadeDone.armory.items?.grenade).toBe((before.armory.items?.grenade ?? 0) + 2);
    expect(medkitDone.armory.items?.medkit).toBe((before.armory.items?.medkit ?? 0) + 1);
    // Completing clears the active slot and logs a manufacturing report.
    expect(grenadeDone.activeManufacturing).toBeUndefined();
    expect(grenadeDone.projectReports[0]).toMatchObject({ kind: "manufacturing", id: "grenade" });
  });

  it("fabricates the heavy plasma cannon into armory.weapons once heavy plasma research clears", () => {
    const base = stocked();
    // Locked until the heavy plasma cannon research line completes.
    expect(canStartManufacturing(base, "cannon")).toBe(false);
    const plasmaReady = completeResearch(base, "plasmaWeapons");
    expect(canStartManufacturing(plasmaReady, "cannon")).toBe(false);
    const heavyReady = completeResearch(plasmaReady, "heavyPlasma");
    expect(canStartManufacturing(heavyReady, "cannon")).toBe(true);

    const started = startManufacturing(heavyReady, "cannon");
    const completed = advanceGeoscape(started, manufacturingDuration(heavyReady, "cannon"));
    expect(completed.armory.weapons.cannon).toBe(heavyReady.armory.weapons.cannon + 1);
    expect(completed.projectReports[0]).toMatchObject({ kind: "manufacturing", id: "cannon" });
  });

  it("manufactures every catalogue project into gear that resolves to a real battle definition", () => {
    // Gear that doesn't resolve to a Weapon or Item definition is invisible in
    // the loadout UI and has no battle effect, so the catalogue must only
    // advertise gear that works end-to-end. Flush resources and complete every
    // research line so even the cannon's heavy-plasma chain is startable.
    let ready: CampaignState = {
      ...createCampaign(BASE, 12345),
      resources: { credits: 10000, alloys: 500, elerium: 100, alienData: 100 },
    };
    for (const id of RESEARCH_IDS) {
      ready = completeResearch(ready, id);
    }
    // Classic starter has 3 hangars for 3 craft — free a berth before fabricating
    // the Phantom interceptor (craft products need a free hangar slot).
    ready = completeFacilityConstruction(ready, "hangar-4");
    for (const project of MANUFACTURING_PROJECTS) {
      expect(canStartManufacturing(ready, project.id), `${project.id} must be startable`).toBe(true);
      const completed = advanceGeoscape(
        startManufacturing(ready, project.id),
        manufacturingDuration(ready, project.id),
      );
      const { product } = project;
      if (product.kind === "weapon") {
        expect(completed.armory.weapons[product.weaponId]).toBe(
          ready.armory.weapons[product.weaponId] + product.quantity,
        );
        expect(
          WEAPONS[product.weaponId],
          `${product.weaponId} must resolve to a real Weapon definition`,
        ).toBeDefined();
      } else if (product.kind === "craft") {
        // A craft product joins the hangar fleet rather than the armory.
        const added = completed.fleet!.find((craft) => craft.name === product.craft.name);
        expect(added, `${product.craft.name} must join the fleet`).toBeDefined();
        expect(completed.fleet!.length).toBe(ready.fleet!.length + 1);
      } else {
        expect(completed.armory.items?.[product.itemId] ?? 0).toBe(
          (ready.armory.items?.[product.itemId] ?? 0) + product.quantity,
        );
        expect(
          ITEMS[product.itemId],
          `${product.itemId} must resolve to a real Item definition`,
        ).toBeDefined();
      }
    }
  });

  it("keeps the workshop committed to a single manufacturing order at a time", () => {
    const before = stocked();
    const started = startManufacturing(before, "grenade");
    expect(canStartManufacturing(started, "medkit")).toBe(false);
    // While busy, starting a second order is a no-op.
    expect(startManufacturing(started, "medkit")).toBe(started);
  });
});

describe("soldier bios", () => {
  const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;

  /** A single sentence: one leading capital, exactly one terminal period, no
   *  internal periods (so the background reads as one beat, not a paragraph). */
  function isSingleSentence(text: string): boolean {
    return (
      text.length > 0 &&
      text[0] === text[0]!.toUpperCase() &&
      text.endsWith(".") &&
      !text.slice(0, -1).includes(".")
    );
  }

  it("rolls a single-sentence background for every starting operative", () => {
    const campaign = createCampaign(BASE, 12345);

    expect(campaign.soldiers.length).toBeGreaterThan(0);
    for (const soldier of campaign.soldiers) {
      expect(typeof soldier.bio).toBe("string");
      expect(isSingleSentence(soldier.bio!)).toBe(true);
    }
  });

  it("generates a bio on recruit", () => {
    const campaign = createCampaign(BASE, 12345);
    const recruit = recruitSoldier(campaign);
    const recruited = recruit.soldiers.at(-1)!;

    expect(recruited.bio).toBeDefined();
    expect(isSingleSentence(recruited.bio!)).toBe(true);
  });

  it("is deterministic in the campaign seed and soldier id", () => {
    const a = createCampaign(BASE, 12345);
    const b = createCampaign(BASE, 12345);
    const other = createCampaign(BASE, 99999);

    // Same seed => identical bios across the whole roster.
    expect(a.soldiers.map((s) => s.bio)).toEqual(b.soldiers.map((s) => s.bio));
    // A different seed rolls a different background for the same operative id.
    expect(a.soldiers[0]!.bio).not.toBe(other.soldiers[0]!.bio);
    // The recruited operative keeps the same bio when re-rolled under the same seed.
    expect(recruitSoldier(a).soldiers.at(-1)!.bio).toBe(
      recruitSoldier(b).soldiers.at(-1)!.bio,
    );
  });

  it("varies the background across the roster", () => {
    const campaign = createCampaign(BASE, 12345);
    const bios = new Set(campaign.soldiers.map((s) => s.bio));

    expect(bios.size).toBeGreaterThan(1);
  });
});

describe("infiltration and defection", () => {
  const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;

  /** A minimal tracked contact in a council region that will expire at `expiresAtHour`. */
  function stagedContact(region: string, missionType: MissionType, expiresAtHour: number): UfoContact {
    return {
      id: `UFO-STAGED-${region}-${missionType}`,
      status: "tracked",
      missionType,
      lat: 0,
      lon: 0,
      region,
      detectedAtHour: 0,
      expiresAtHour,
      missionSeed: 1,
      strength: 1,
    };
  }

  it("starts every council region at zero infiltration", () => {
    const campaign = createCampaign(BASE, 12345);

    expect(campaign.infiltration).toEqual(STARTING_INFILTRATION);
    for (const region of COUNCIL_REGIONS) {
      expect(campaign.infiltration![region]).toBe(0);
    }
    expect(defectedRegions(campaign)).toEqual([]);
    expect(campaignInfiltration(campaign)).toEqual(STARTING_INFILTRATION);
  });

  it("raises regional infiltration when a UFO contact expires un-intercepted", () => {
    const campaign = createCampaign(BASE, 12345);
    const staged = { ...campaign, ufoContact: stagedContact("Europe", "crashSite", 6) };

    const expired = advanceGeoscape(staged, 6);

    expect(expired.ufoContact).toBeUndefined();
    // crashSite baseline gain (10) is scaled by the arc-stretch CONTACT_PENALTY_SCALE
    // (0.3, easing this no-decay penalty for the longer 8-op arc) THEN veteran
    // panicMult (0.75): round(round(10 * 0.3) * 0.75) = 2.
    expect(regionalInfiltrationFor(expired, "Europe")).toBe(2);
    // The ignored contact raises infiltration, not the fresh campaign.
    expect(regionalInfiltrationFor(campaign, "Europe")).toBe(0);
    expect(defectedRegions(expired)).toEqual([]);
  });

  it("scales infiltration by mission type (terror/landed worse than crashSite)", () => {
    const run = (missionType: MissionType) =>
      advanceGeoscape(
        { ...createCampaign(BASE, 12345), ufoContact: stagedContact("Europe", missionType, 6) },
        6,
      );

    const crash = run("crashSite");
    const landed = run("landedUfo");
    const terror = run("terror");

    // Infiltration gains are scaled by CONTACT_PENALTY_SCALE (0.3) THEN veteran
    // panicMult (0.75): round(round(10*0.3)*0.75)=2, round(round(20*0.3)*0.75)=5,
    // round(round(30*0.3)*0.75)=7.
    expect(regionalInfiltrationFor(crash, "Europe")).toBe(2);
    expect(regionalInfiltrationFor(landed, "Europe")).toBe(5);
    expect(regionalInfiltrationFor(terror, "Europe")).toBe(7);
    expect(regionalInfiltrationFor(terror, "Europe")!).toBeGreaterThan(
      regionalInfiltrationFor(crash, "Europe")!,
    );
  });

  it("accumulates infiltration across successive ignored contacts in the same region", () => {
    let state: CampaignState = {
      ...createCampaign(BASE, 12345),
      ufoContact: stagedContact("Europe", "crashSite", 6),
    };
    state = advanceGeoscape(state, 6);
    // Each crash-site contact adds round(round(10 * 0.3) * 0.75) = 2 infiltration at veteran.
    expect(regionalInfiltrationFor(state, "Europe")).toBe(2);

    // A second ignored crash-site contact deepens the same region's meter.
    state = {
      ...state,
      ufoContact: stagedContact("Europe", "crashSite", state.clock.elapsedHours + 6),
    };
    state = advanceGeoscape(state, 6);
    expect(regionalInfiltrationFor(state, "Europe")).toBe(4);
  });

  it("defects a nation when infiltration reaches 100, cutting funding permanently", () => {
    const base = createCampaign(BASE, 12345);
    // Veteran share: round(600 / 8) = 75 council credits withdrawn on defection.
    const share = Math.round(base.strategic.funding / COUNCIL_REGIONS.length);

    // A terror contact's infiltration gain is now eased by the arc-stretch
    // CONTACT_PENALTY_SCALE (0.3) before veteran panicMult (0.75):
    // round(round(30 * 0.3) * 0.75) = 7. Europe sits one terror contact away from
    // maxing out.
    const terrorGain = Math.round(Math.round(30 * CONTACT_PENALTY_SCALE.veteran) * DIFFICULTY_CONFIGS.veteran.panicMult);
    const nearDefection = {
      ...base,
      infiltration: { ...STARTING_INFILTRATION, Europe: 100 - terrorGain },
      ufoContact: stagedContact("Europe", "terror", 6),
    };
    // Same scenario, but Europe stays just short of 100 (no crossing).
    const noDefect = {
      ...base,
      infiltration: { ...STARTING_INFILTRATION, Europe: 100 - terrorGain - 1 },
      ufoContact: stagedContact("Europe", "terror", 6),
    };

    const afterDefect = advanceGeoscape(nearDefection, 6);
    const afterNoDefect = advanceGeoscape(noDefect, 6);

    expect(regionalInfiltrationFor(afterDefect, "Europe")).toBe(100);
    expect(defectedRegions(afterDefect)).toContain("Europe");
    expect(defectedRegions(afterNoDefect)).toEqual([]);
    // The defected scenario's funding is exactly one share lower than the control;
    // the shared baseline ignore penalty cancels out in the difference.
    expect(afterNoDefect.strategic.funding - afterDefect.strategic.funding).toBe(share);

    const pact = afterDefect.projectReports.find((report) => report.title === "Europe defects");
    expect(pact).toBeDefined();
    expect(pact?.summary).toContain("signed a pact with the aliens");
    expect(pact?.summary).toContain(`${share}c`);

    // Defection is exactly-once: another ignored contact in a maxed-out region does
    // not withdraw funding again and does not log a second pact.
    const second = advanceGeoscape(
      { ...afterDefect, ufoContact: stagedContact("Europe", "terror", afterDefect.clock.elapsedHours + 6) },
      6,
    );
    expect(regionalInfiltrationFor(second, "Europe")).toBe(100);
    expect(second.projectReports.filter((report) => report.title === "Europe defects")).toHaveLength(1);
  });

  it("reflects defections in the monthly funding report (reduced income)", () => {
    const base = createCampaign(BASE, 12345);
    const share = Math.round(base.strategic.funding / COUNCIL_REGIONS.length);
    // Europe has already defected: its share is withdrawn and the meter is pinned at 100.
    const defected = {
      ...base,
      strategic: { ...base.strategic, funding: base.strategic.funding - share },
      infiltration: { ...STARTING_INFILTRATION, Europe: 100 },
      // Suppress UFO spawns so no contacts interfere with the monthly report.
      clock: { ...base.clock, lastContactHour: Number.MAX_SAFE_INTEGER },
    };

    const after = advanceGeoscape(defected, FUNDING_REPORT_INTERVAL_HOURS);

    expect(after.lastFundingReport?.income).toBe(base.strategic.funding - share);
    expect(after.lastFundingReport?.summary).toContain("1 nation defected");
    expect(defectedRegions(after)).toContain("Europe");
  });
});

describe("infiltration save/load normalization", () => {
  const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;

  /** The node test environment has no localStorage; install a minimal shim. */
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

  it("persists and reloads per-region infiltration", () => {
    const campaign = createCampaign(BASE, 12345);
    saveCampaign({
      ...campaign,
      infiltration: { ...STARTING_INFILTRATION, Europe: 42, Africa: 7 },
    });
    const loaded = loadCampaign();

    expect(loaded).not.toBeNull();
    expect(loaded!.infiltration).toBeDefined();
    expect(loaded!.infiltration!.Europe).toBe(42);
    expect(loaded!.infiltration!.Africa).toBe(7);
    // Regions not mentioned in the meter default to zero.
    expect(loaded!.infiltration!.Oceania).toBe(0);
  });

  it("clamps out-of-range infiltration on load and flags the maxed region as defected", () => {
    expect(CAMPAIGN_STORAGE_KEY).toBeTruthy();
    const campaign = createCampaign(BASE, 12345);
    saveCampaign({
      ...campaign,
      infiltration: { ...STARTING_INFILTRATION, Europe: 150, Africa: -5 },
    });
    const loaded = loadCampaign();

    expect(loaded!.infiltration!.Europe).toBe(100);
    expect(loaded!.infiltration!.Africa).toBe(0);
    expect(loaded!.infiltration!.Oceania).toBe(0);
    expect(defectedRegions(loaded!)).toContain("Europe");
    expect(defectedRegions(loaded!)).not.toContain("Africa");
  });

  it("backfills zero infiltration for legacy saves that predate the meter", () => {
    const campaign = createCampaign(BASE, 12345);
    const { infiltration: _infiltration, ...legacy } = campaign;
    expect(_infiltration).toBeDefined();
    saveCampaign(legacy);

    const loaded = loadCampaign();
    expect(loaded!.infiltration).toBeDefined();
    for (const region of COUNCIL_REGIONS) {
      expect(loaded!.infiltration![region]).toBe(0);
    }
    expect(defectedRegions(loaded!)).toEqual([]);
  });
});
