import type {
  CampaignResources,
  CampaignState,
  CaptiveRank,
  MissionContext,
  MissionType,
  OperationPlan,
  OperationTheme,
  UfoContact,
  UfoType,
} from "./types";
import {
  campaignMissionSeed,
  canLaunchFinalAssault,
  difficultyConfig,
  hasBaseFacility,
  ALIEN_BASE_THEME,
  ALIEN_HQ_CREW_SIZE,
  UFO_CREW_PROFILES,
} from "./storage";
import { CORE_RECOVER_THRESHOLD } from "./geoscape";

const THEMES: readonly OperationTheme[] = ["farmland", "urban", "desert", "arctic", "jungle", "forest"];
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
    case "alienBaseAssault":
      // The decapitating strike on the HQ yields the campaign's richest haul.
      return {
        credits: 500 + missionNumber * 30,
        alloys: 30 + enemyCount * 2,
        elerium: 20 + Math.floor(missionNumber / 2),
        alienData: 12 + enemyCount,
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

/**
 * Scales a mission reward's salvageable materials by the crash-site condition set at
 * shoot-down (see InterceptionOutcome.salvageQuality). A clean forced landing (q=1)
 * yields the full haul; a heavy-overkill wreck yields less. Alloys and elerium scale by
 * (0.4 + 0.6*q) and floor; a wreck below CORE_RECOVER_THRESHOLD has its elerium ("core")
 * damaged beyond recovery and zeroed. Credits and alien data are unaffected.
 */
function scaleSalvage(reward: CampaignResources, quality: number): CampaignResources {
  const q = Math.max(0, Math.min(1, quality));
  const mult = 0.4 + 0.6 * q;
  const coreLost = q < CORE_RECOVER_THRESHOLD;
  return {
    credits: reward.credits,
    alloys: Math.floor(reward.alloys * mult),
    elerium: coreLost ? 0 : Math.floor(reward.elerium * mult),
    alienData: reward.alienData,
  };
}

function durationFor(enemyCount: number, contactStrength: number): number {
  const enemyBurden = Math.floor(Math.max(0, enemyCount - 5) / 2);
  const contactBurden = Math.max(0, contactStrength - 1);
  return BASE_OPERATION_DURATION_HOURS + enemyBurden + contactBurden;
}

/**
 * Mission type this operation runs. An explicit override wins (used to launch the
 * final "alienBaseAssault"); otherwise it is the current contact's mission type,
 * defaulting to a UFO crash-site recovery.
 */
export function determineMissionType(campaign: CampaignState, override?: MissionType): MissionType {
  if (override) return override;
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
    case "alienBaseAssault":
      return "Breach the alien headquarters, eliminate its command crew, and end the invasion.";
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
  if (missionType === "alienBaseAssault") return campaign.alienHq?.location.region ?? campaign.base.region;
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
    case "alienBaseAssault":
      return (
        `The alien headquarters has been located in ${ctx.region}. ` +
        `Operation ${ctx.codename} is the decapitating strike that ends the war. ` +
        body +
        "The HQ is defended by an elite garrison led by a commander. Breach it and eliminate the command crew."
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

/**
 * Whether an operation has a reachable deploy site given the campaign's current
 * contact state. The final alien-base assault launches from the revealed HQ,
 * INDEPENDENT of any UFO contact, so it bypasses every contact guard — including
 * the "crash lost at sea" refusal that would otherwise silently swallow the
 * ASSAULT ALIEN HQ launch when a stale over-ocean contact is present. Every other
 * mission needs a crashed (over land) or landed contact to deploy against.
 */
export function canDeployToOperationSite(campaign: CampaignState, operation: OperationPlan): boolean {
  if (operation.missionType === "alienBaseAssault") return true;
  const contact = campaign.ufoContact;
  const status = contact?.status;
  if (status !== "crashed" && status !== "landed") return false;
  if (status === "crashed" && contact?.overOcean === true) return false;
  return true;
}

export function generateOperation(
  campaign: CampaignState,
  missionTypeOverride?: MissionType,
): OperationPlan {
  const missionType = determineMissionType(campaign, missionTypeOverride);
  if (missionType === "alienBaseAssault") return generateAssaultOperation(campaign);
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
  // A shot-down wreck's salvage is degraded by overkill (heavy missiles burn the hull
  // down); a clean forced landing keeps the full haul. Landed/ground contacts carry no
  // salvageQuality and default to a pristine 1.0.
  const salvageQuality = contact?.salvageQuality ?? 1;
  const reward = scaleSalvage(
    rewardForMission(missionNumber, enemyCount, missionType),
    salvageQuality,
  );
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

/**
 * Build the final alien-base assault at the revealed HQ. Unlike a UFO recovery it
 * has no contact: the target is `campaign.alienHq.location`, the map uses the
 * ALIEN_BASE_THEME, and the crew is a fixed elite garrison of ALIEN_HQ_CREW_SIZE
 * (guaranteed to field a commander + leader — see {@link alienBaseCrewRanks}).
 */
function generateAssaultOperation(campaign: CampaignState): OperationPlan {
  const missionNumber = campaign.missionsAttempted + 1;
  const missionSeed = campaignMissionSeed(campaign);
  const a = (missionSeed >>> 5) ^ missionNumber;
  const b = (missionSeed >>> 17) ^ (missionNumber * 31);
  const enemyCount = difficultyConfig(campaign).alienHqCrewSize;
  const region = missionRegion("alienBaseAssault", undefined, campaign);
  const codename = `${pick(CODE_A, a)} ${pick(CODE_B, b)}`;
  const reward = rewardForMission(missionNumber, enemyCount, "alienBaseAssault");
  const durationHours = durationFor(enemyCount, 4);
  const size = 38;
  return {
    missionNumber,
    missionSeed,
    codename,
    region,
    themeId: ALIEN_BASE_THEME,
    missionType: "alienBaseAssault",
    missionContext: undefined,
    enemyCount,
    durationHours,
    width: size,
    height: size,
    reward,
    briefing: briefingFor({
      missionType: "alienBaseAssault",
      contact: undefined,
      codename,
      region,
      enemyCount,
      themeId: ALIEN_BASE_THEME,
      durationHours,
      facilityIntel: [],
    }),
    objective: objectiveFor("alienBaseAssault"),
  };
}

/**
 * Create the final-assault operation IF it can be launched (HQ revealed and the
 * assault unlocked via commanderInterrogation or the fallback milestone). Returns
 * undefined otherwise. This is the entry point the UI calls to start the assault.
 */
export function launchFinalAssault(campaign: CampaignState): OperationPlan | undefined {
  if (!canLaunchFinalAssault(campaign)) return undefined;
  return generateOperation(campaign, "alienBaseAssault");
}

/** Deterministic PRNG (mulberry32) so crew composition is reproducible for a seed. */
function crewRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Crew rank composition for a crashed/landed UFO, driven by its UFO_CREW_PROFILE.
 * A crew always fields rank-and-file soldiers; profiles with `hasLeader` promote
 * one slot to a leader, and `commanderChance` (seeded) may add a commander. This
 * is the campaign layer's source of truth for which ranks a UFO fields, so
 * captures of leaders/commanders become possible in normal play.
 */
export function ufoCrewRanks(ufoType: UfoType, seed: number, crewSize: number): CaptiveRank[] {
  const size = Math.max(1, Math.floor(crewSize));
  const ranks: CaptiveRank[] = new Array<CaptiveRank>(size).fill("soldier");
  const profile = UFO_CREW_PROFILES[ufoType];
  const rng = crewRng(seed ^ 0x1b873593);
  let slot = 0;
  if (profile.commanderChance > 0 && rng() < profile.commanderChance && slot < size) {
    ranks[slot++] = "commander";
  }
  if (profile.hasLeader && slot < size) {
    ranks[slot++] = "leader";
    // A navigator adds mid-rank variety on larger crewed UFOs. Rank-and-file
    // profiles (scouts) stay all soldiers.
    if (size >= 5 && slot < size) {
      ranks[slot++] = "navigator";
    }
  }
  return ranks;
}

/**
 * Crew rank composition for the alien-base assault: `crewSize` aliens (defaults to
 * the commander-difficulty ALIEN_HQ_CREW_SIZE) that ALWAYS include exactly one
 * commander and at least one leader, the rest a mix of navigators and soldiers.
 * The size is difficulty-scaled (see DifficultyConfig.alienHqCrewSize), so callers
 * pass the operation's enemyCount to keep the spawned crew and the plan in lockstep.
 * Deterministic in the seed.
 */
export function alienBaseCrewRanks(seed: number, crewSize: number = ALIEN_HQ_CREW_SIZE): CaptiveRank[] {
  const size = Math.max(2, Math.floor(crewSize));
  const ranks: CaptiveRank[] = new Array<CaptiveRank>(size).fill("soldier");
  ranks[0] = "commander";
  ranks[1] = "leader";
  const rng = crewRng(seed ^ 0xcc9e2d51);
  // Sprinkle a couple of navigators through the rank-and-file for variety.
  for (let i = 2; i < size; i++) {
    if (rng() < 0.3) ranks[i] = "navigator";
  }
  return ranks;
}
