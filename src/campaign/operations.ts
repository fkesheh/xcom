import type { CampaignResources, CampaignState, OperationPlan, OperationTheme } from "./types";
import { campaignMissionSeed, hasBaseFacility } from "./storage";

const THEMES: readonly OperationTheme[] = ["farmland", "urban", "desert"];
const CODE_A = ["Silent", "Ash", "Iron", "Night", "Glass", "Violet", "Black", "Cold"] as const;
const CODE_B = ["Dawn", "Needle", "Signal", "Anvil", "Comet", "Lantern", "Crown", "Orbit"] as const;
const BASE_OPERATION_DURATION_HOURS = 6;

function pick<T>(items: readonly T[], value: number): T {
  return items[value % items.length]!;
}

function rewardFor(missionNumber: number, enemyCount: number): CampaignResources {
  return {
    credits: 150 + missionNumber * 25,
    alloys: 8 + Math.floor(enemyCount * 1.2),
    elerium: 2 + Math.floor(missionNumber / 2),
    alienData: 2 + Math.floor(enemyCount / 3),
  };
}

function durationFor(enemyCount: number, contactStrength: number): number {
  const enemyBurden = Math.floor(Math.max(0, enemyCount - 5) / 2);
  const contactBurden = Math.max(0, contactStrength - 1);
  return BASE_OPERATION_DURATION_HOURS + enemyBurden + contactBurden;
}

export function generateOperation(campaign: CampaignState): OperationPlan {
  const missionNumber = campaign.missionsAttempted + 1;
  const contact = campaign.ufoContact?.status === "crashed" ? campaign.ufoContact : undefined;
  const missionSeed = contact?.missionSeed ?? campaignMissionSeed(campaign);
  const a = (missionSeed >>> 5) ^ missionNumber;
  const b = (missionSeed >>> 17) ^ (missionNumber * 31);
  const themeId = pick(THEMES, a);
  const trackingUplink = hasBaseFacility(campaign, "radar-2");
  const fabricationBay = hasBaseFacility(campaign, "workshop-2");
  const baseEnemyCount = Math.min(
    9,
    5 + Math.floor(missionNumber / 2) + (b % 2) + (contact ? contact.strength - 1 : 0),
  );
  const enemyCount = Math.max(3, baseEnemyCount - (trackingUplink ? 1 : 0));
  const size = Math.min(38, 30 + Math.floor(missionNumber / 3) * 2);
  const codename = `${pick(CODE_A, a)} ${pick(CODE_B, b)}`;
  const reward = rewardFor(missionNumber, enemyCount);
  const durationHours = durationFor(enemyCount, contact?.strength ?? 1);
  if (trackingUplink) reward.alienData += 1;
  if (fabricationBay) {
    reward.credits += 40;
    reward.alloys += 4;
  }
  const facilityIntel = [
    trackingUplink ? "Tracking uplink predicts a lighter contact pattern" : "",
    fabricationBay ? "fabrication bay crews are ready to strip extra salvage" : "",
  ].filter(Boolean);

  return {
    missionNumber,
    missionSeed,
    codename,
    region: contact?.region ?? campaign.base.region,
    themeId,
    enemyCount,
    durationHours,
    width: size,
    height: size,
    reward,
    briefing:
      (contact
        ? `${contact.id} crash site is confirmed in ${contact.region}. Recovery teams are ready for Operation ${codename}. `
        : `UFO recovery team is ready for Operation ${codename} in ${campaign.base.region}. `) +
      `Expect ${enemyCount} contacts in ${themeId} terrain. ` +
      `Estimated field time is ${durationHours}h. ` +
      `${facilityIntel.length > 0 ? `${facilityIntel.join("; ")}. ` : ""}` +
      "Recover the power source, extract it to the dropship, or clear the site.",
    objective: "Recover the UFO power source, extract it to the dropship, or neutralize all contacts.",
  };
}
