import type {
  CampaignResources,
  CampaignState,
  MissionContext,
  MissionType,
  OperationPlan,
  OperationTheme,
  UfoContact,
} from "./types";
import { campaignMissionSeed, difficultyConfig, hasBaseFacility } from "./storage";

const THEMES: readonly OperationTheme[] = ["farmland", "urban", "desert"];
const CODE_A = ["Silent", "Ash", "Iron", "Night", "Glass", "Violet", "Black", "Cold"] as const;
const CODE_B = ["Dawn", "Needle", "Signal", "Anvil", "Comet", "Lantern", "Crown", "Orbit"] as const;
const BASE_OPERATION_DURATION_HOURS = 6;

function pick<T>(items: readonly T[], value: number): T {
  return items[value % items.length]!;
}

/** Enemy-count multiplier for the chosen difficulty (defaults to veteran = 1.0, preserving legacy plans). */
function enemyCountMultiplier(campaign: CampaignState): number {
  return difficultyConfig(campaign).enemyCountMult;
}

function scaleEnemyCount(count: number, campaign: CampaignState): number {
  const mult = enemyCountMultiplier(campaign);
  return mult === 1 ? count : Math.max(1, Math.round(count * mult));
}

function rewardForMission(
  missionNumber: number,
  enemyCount: number,
  missionType: MissionType,
): CampaignResources {
  switch (missionType) {
    case "landedUfo":
      // Intact craft yields far richer salvage — alloys and elerium.
      return {
        credits: 180 + missionNumber * 25,
        alloys: 14 + Math.floor(enemyCount * 1.8),
        elerium: 5 + missionNumber,
        alienData: 3 + Math.floor(enemyCount / 3),
      };
    case "terror":
      // Saving a city is rewarded through council funding (credits) over salvage.
      return {
        credits: 280 + missionNumber * 45,
        alloys: 4 + Math.floor(enemyCount * 0.6),
        elerium: 1 + Math.floor(missionNumber / 3),
        alienData: 2 + Math.floor(enemyCount / 4),
      };
    case "baseDefense":
      // Survival is its own reward; salvage from repelled attackers is thin.
      return {
        credits: 80 + missionNumber * 10,
        alloys: 4,
        elerium: 1,
        alienData: 1 + Math.floor(enemyCount / 4),
      };
    case "crashSite":
    default:
      return {
        credits: 150 + missionNumber * 25,
        alloys: 8 + Math.floor(enemyCount * 1.2),
        elerium: 2 + Math.floor(missionNumber / 2),
        alienData: 2 + Math.floor(enemyCount / 3),
      };
  }
}

function durationFor(enemyCount: number, contactStrength: number): number {
  const enemyBurden = Math.floor(Math.max(0, enemyCount - 5) / 2);
  const contactBurden = Math.max(0, contactStrength - 1);
  return BASE_OPERATION_DURATION_HOURS + enemyBurden + contactBurden;
}

/** Mission type this contact seeds when assaulted (defaults to a UFO crash-site recovery). */
export function determineMissionType(campaign: CampaignState): MissionType {
  return campaign.ufoContact?.missionType ?? "crashSite";
}

export function objectiveFor(missionType: MissionType): string {
  switch (missionType) {
    case "landedUfo":
      return "Assault the landed UFO, neutralize its crew, and secure the intact craft.";
    case "terror":
      return "Rescue civilians and neutralize the attackers.";
    case "baseDefense":
      return "Repel the base assault.";
    case "crashSite":
    default:
      return "Recover the UFO power source, extract it to the dropship, or neutralize all contacts.";
  }
}

/** The UFO contact that seeds this operation. Any crashed or landed contact qualifies:
 * terror and base-defense contacts also spawn already on the ground (status "landed"). */
function missionContact(campaign: CampaignState): UfoContact | undefined {
  const ufo = campaign.ufoContact;
  if (!ufo) return undefined;
  if (ufo.status === "crashed") return ufo;
  return ufo.status === "landed" ? ufo : undefined;
}

function missionRegion(
  missionType: MissionType,
  contact: UfoContact | undefined,
  campaign: CampaignState,
): string {
  if (missionType === "baseDefense") return campaign.base.region;
  return contact?.region ?? campaign.base.region;
}

function enemyCountForMission(
  crashSiteEnemyCount: number,
  missionType: MissionType,
  campaign: CampaignState,
): number {
  switch (missionType) {
    case "landedUfo":
      // Intact craft fields its full, unwounded crew. A shot-down wreck keeps only
      // ~60-70% of that crew alive (the rest died in the crash), so the landed assault
      // fields roughly 1.5x the crash-site survivor count.
      return crashSiteEnemyCount + Math.ceil(crashSiteEnemyCount / 2);
    case "terror":
      // City raids are heavily attended.
      return crashSiteEnemyCount + 3;
    case "baseDefense":
      // Assault force scales with the current strategic threat.
      return crashSiteEnemyCount + Math.max(1, Math.floor(campaign.strategic.threat / 20));
    case "crashSite":
    default:
      // Shot-down wreck: the impact killed or wounded much of the crew, leaving a
      // reduced, battered force (the baseline count already reflects those losses).
      return crashSiteEnemyCount;
  }
}

function missionContextFor(
  missionType: MissionType,
  missionSeed: number,
  campaign: CampaignState,
): MissionContext | undefined {
  switch (missionType) {
    case "terror":
      // Deterministic civilian count in the 6..10 range.
      return { civilianCount: 6 + (missionSeed % 5) };
    case "baseDefense":
      return { defenderFacility: campaign.base.region };
    case "crashSite":
    case "landedUfo":
    default:
      return undefined;
  }
}

interface BriefingContext {
  missionType: MissionType;
  contact: UfoContact | undefined;
  codename: string;
  region: string;
  enemyCount: number;
  themeId: OperationTheme;
  durationHours: number;
  facilityIntel: string[];
  civilianCount?: number;
}

function facilityIntelClause(facilityIntel: string[]): string {
  return facilityIntel.length > 0 ? `${facilityIntel.join("; ")}. ` : "";
}

function briefingFor(ctx: BriefingContext): string {
  const body =
    `Expect ${ctx.enemyCount} contacts in ${ctx.themeId} terrain. ` +
    `Estimated field time is ${ctx.durationHours}h. ` +
    facilityIntelClause(ctx.facilityIntel);

  switch (ctx.missionType) {
    case "landedUfo":
      return (
        (ctx.contact
          ? `${ctx.contact.id} is on the ground and intact in ${ctx.contact.region}. `
          : `A UFO has landed intact in ${ctx.region}. `) +
        `Assault teams are ready for Operation ${ctx.codename}. ` +
        body +
        "The intact craft fields its full, unwounded crew. Assault the landed craft and secure its cargo."
      );
    case "terror":
      return (
        `A city in ${ctx.region} is under attack and civilians are in the crossfire ` +
        `(${ctx.civilianCount ?? 0} confirmed in the zone). ` +
        `Operation ${ctx.codename} is tasked with the rescue. ` +
        body +
        "Rescue the civilians and neutralize the attackers."
      );
    case "baseDefense":
      return (
        `Alien assault force inbound on our base in ${ctx.region}. ` +
        `All personnel to defensive positions for Operation ${ctx.codename}. ` +
        body +
        "Hold the line and repel the base assault."
      );
    case "crashSite":
    default:
      return (
        (ctx.contact
          ? `${ctx.contact.id} crash site is confirmed in ${ctx.contact.region}. Recovery teams are ready for Operation ${ctx.codename}. `
          : `UFO recovery team is ready for Operation ${ctx.codename} in ${ctx.region}. `) +
        `Expect ${ctx.enemyCount} contacts in ${ctx.themeId} terrain. ` +
        `Estimated field time is ${ctx.durationHours}h. ` +
        facilityIntelClause(ctx.facilityIntel) +
        "Wreckage survey: the impact killed or wounded much of the crew, leaving a reduced, battered force. " +
        "Recover the power source, extract it to the dropship, or clear the site."
      );
  }
}

export function generateOperation(campaign: CampaignState): OperationPlan {
  const missionType = determineMissionType(campaign);
  const missionNumber = campaign.missionsAttempted + 1;
  const contact = missionContact(campaign);
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
  const crashSiteEnemyCount = Math.max(3, baseEnemyCount - (trackingUplink ? 1 : 0));
  const enemyCount = scaleEnemyCount(
    enemyCountForMission(crashSiteEnemyCount, missionType, campaign),
    campaign,
  );
  const size = Math.min(38, 30 + Math.floor(missionNumber / 3) * 2);
  const codename = `${pick(CODE_A, a)} ${pick(CODE_B, b)}`;
  const reward = rewardForMission(missionNumber, enemyCount, missionType);
  const durationHours = durationFor(enemyCount, contact?.strength ?? 1);
  if (trackingUplink) reward.alienData += 1;
  if (fabricationBay) {
    reward.credits += 40;
    reward.alloys += 4;
  }
  const region = missionRegion(missionType, contact, campaign);
  const missionContext = missionContextFor(missionType, missionSeed, campaign);
  const facilityIntel = [
    trackingUplink ? "Tracking uplink predicts a lighter contact pattern" : "",
    fabricationBay ? "fabrication bay crews are ready to strip extra salvage" : "",
  ].filter(Boolean);

  return {
    missionNumber,
    missionSeed,
    codename,
    region,
    themeId,
    missionType,
    missionContext,
    enemyCount,
    durationHours,
    width: size,
    height: size,
    reward,
    briefing: briefingFor({
      missionType,
      contact,
      codename,
      region,
      enemyCount,
      themeId,
      durationHours,
      facilityIntel,
      civilianCount: missionContext?.civilianCount,
    }),
    objective: objectiveFor(missionType),
  };
}
