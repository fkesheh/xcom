/**
 * Deterministic campaign auto-play harness — a BALANCE DIAGNOSTIC, not a unit test.
 *
 * Simulates full campaigns from createCampaign to win/lose for all three
 * difficulties, then aggregates the outcomes into a structured balance report.
 * This file is intentionally long: it carries a self-contained tactical
 * auto-player (adapted from tests/end-to-end-loop.test.ts), a strategic driver
 * (advance geoscape -> intercept -> assault -> record -> research -> buy ->
 * recruit), per-campaign metric collection, and aggregation/report rendering.
 *
 * Determinism: every campaign is seeded; the sim's seeded Rng + the campaign's
 * mulberry32 derivation make a (seed, difficulty) pair fully reproducible. No
 * Math.random, no wall-clock dependencies. The harness re-runs a fixed seed to
 * assert byte-for-byte identical metrics.
 *
 * This is a DIAGNOSTIC. It changes NO source files; it only reads the public
 * campaign + sim APIs and reports the numbers that will inform balance fixes.
 */
import { describe, it, expect } from "vitest";
import { appendFileSync } from "node:fs";
import {
  createCampaign,
  recordMissionResult,
  startResearch,
  canStartResearch,
  canPurchaseWeapon,
  purchaseWeapon,
  assignSoldierWeapon,
  availableWeaponCount,
  recruitSoldier,
  canRecruitSoldier,
  livingSoldiers,
  activeSoldiers,
  deploymentSoldiers,
  deploymentWeaponIds,
  soldierWeaponId,
  campaignSoldierStatBonus,
  highestRegionalPanic,
  defectedRegions,
  setSoldierDeployment,
  RESEARCH_PROJECTS,
  DEPLOYMENT_SIZE,
  CAMPAIGN_VICTORY_OPERATIONS,
  canLaunchFinalAssault,
  canStartManufacturing,
  startManufacturing,
} from "../src/campaign/storage";
import {
  advanceGeoscape,
  interceptUfo,
  canLaunchInterceptor,
  interceptionSpeedAdvantage,
} from "../src/campaign/geoscape";
import { alienBaseCrewRanks, generateOperation, launchFinalAssault } from "../src/campaign/operations";
import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
  MissionResult,
  OperationPlan,
  ResearchId,
} from "../src/campaign/types";
import {
  createSkirmish,
  applyCommand,
  previewPlayerShot,
  livingUnits,
  canSee,
  findPath,
  tileTypeAt,
  TU_COST,
} from "../src/sim/index";
import type { BattleState, ShotKind, Unit, Vec2 } from "../src/sim/types";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const BASE: BaseLocation = { lat: 39.0, lon: -77.0, region: "North America" };
const DIFFICULTIES: readonly DifficultyLevel[] = ["rookie", "veteran", "commander"];

/** Campaigns per difficulty. Overridable via BALANCE_SIM_N for fast validation. */
const CAMPAIGNS_PER_DIFFICULTY = Math.max(1, Math.floor(Number(process.env.BALANCE_SIM_N ?? 50)));

/** Geoscape tick (hours) per advance. The public default is 6h. */
const TICK_HOURS = 6;

/** Safety valve: a campaign that neither wins nor loses by this hour is stopped. */
const MAX_HOURS = 4000;
/** Safety valve: a campaign that exceeds this many advances is stopped. */
const MAX_ADVANCES = 4000;
/** Safety valve: a single battle that stalls longer than this is retreated from. */
const MAX_BATTLE_ROUNDS = 160;

// ---------------------------------------------------------------------------
// Tactical auto-player
// (Mirrors the proven greedy driver in tests/end-to-end-loop.test.ts: grenades
// first, auto-fire up close, hold at engagement range, medkit the wounded,
// reload when empty. Pure reads of state; every action goes through applyCommand.)
// ---------------------------------------------------------------------------

const GRENADE_BLAST_RADIUS = 2;
const GRENADE_THROW_RANGE = 8;
const FIRE_MODES: readonly ShotKind[] = ["auto", "snap", "aimed"];

function cheb(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}
function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}
function occupiedByOther(state: BattleState, selfId: number, x: number, y: number): boolean {
  for (const u of state.units) {
    if (u.alive && u.id !== selfId && u.pos.x === x && u.pos.y === y) return true;
  }
  return false;
}
function stepCost(state: BattleState, from: Vec2, to: Vec2): number {
  const tt = tileTypeAt(state.grid, to.x, to.y);
  const base = tt ? tt.moveCost : Infinity;
  const diagonal = from.x !== to.x && from.y !== to.y;
  return diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
}
function nearest(from: Vec2, units: Unit[]): Unit | undefined {
  let best: Unit | undefined;
  let bestD = Infinity;
  for (const u of units) {
    const d = dist(from, u.pos);
    if (d < bestD || (d === bestD && best && u.id < best.id)) {
      best = u;
      bestD = d;
    }
  }
  return best;
}

/** Best safe grenade impact tile, or undefined when no throw is worth making. */
function bestGrenadeTile(state: BattleState, thrower: Unit, visibleEnemies: Unit[]): Vec2 | undefined {
  if (!thrower.items?.some((i) => i.itemId === "grenade" && i.uses > 0)) return undefined;
  const allEnemies = livingUnits(state, "enemy");
  const allPlayers = livingUnits(state, "player");
  let best: { tile: Vec2; value: number } | undefined;
  for (const e of visibleEnemies) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const tile: Vec2 = { x: e.pos.x + dx, y: e.pos.y + dy };
        if (cheb(thrower.pos, tile) > GRENADE_THROW_RANGE) continue;
        let caught = 0;
        let hpValue = 0;
        for (const o of allEnemies) {
          if (cheb(o.pos, tile) <= GRENADE_BLAST_RADIUS) {
            caught++;
            hpValue += o.hp;
          }
        }
        if (caught < 2 && hpValue < 40) continue;
        let safe = true;
        for (const p of allPlayers) {
          if (cheb(p.pos, tile) <= GRENADE_BLAST_RADIUS) {
            safe = false;
            break;
          }
        }
        if (!safe) continue;
        if (
          !best ||
          hpValue > best.value ||
          (hpValue === best.value &&
            (tile.y < best.tile.y || (tile.y === best.tile.y && tile.x < best.tile.x)))
        ) {
          best = { tile: { x: tile.x, y: tile.y }, value: hpValue };
        }
      }
    }
  }
  return best?.tile;
}

/** Walk toward destTarget along the cheapest path, never closer than minCheb. */
function advanceCapped(state: BattleState, unit: Unit, destTarget: Vec2, minCheb: number): boolean {
  const result = findPath(state.grid, unit.pos, destTarget, {
    isBlocked: (x, y) => occupiedByOther(state, unit.id, x, y),
  });
  if (!result || result.path.length === 0) return false;
  let cost = 0;
  let prev: Vec2 = unit.pos;
  let best: Vec2 | undefined;
  for (const step of result.path) {
    cost += stepCost(state, prev, step);
    if (cost > unit.tu) break;
    prev = step;
    if (cheb(step, destTarget) < minCheb) break;
    const isTargetTile = step.x === destTarget.x && step.y === destTarget.y;
    if (!isTargetTile && !occupiedByOther(state, unit.id, step.x, step.y)) best = { ...step };
  }
  if (!best) return false;
  const tuBefore = unit.tu;
  applyCommand(state, { type: "move", unitId: unit.id, to: best });
  return unit.tu !== tuBefore;
}

function takePlayerTurn(state: BattleState): void {
  for (let guard = 0; guard < 60; guard++) {
    const players = livingUnits(state, "player").filter((u) => u.tu > 0);
    const enemies = livingUnits(state, "enemy");
    if (players.length === 0 || enemies.length === 0) break;

    let acted = false;
    for (const pu of players) {
      if (pu.tu <= 0 || state.status !== "playing") continue;

      // Medkit a critically-wounded adjacent ally before fighting on.
      if (pu.items?.some((i) => i.itemId === "medkit" && i.uses > 0)) {
        let patient: Unit | undefined;
        for (const ally of livingUnits(state, "player")) {
          if (ally.id === pu.id || !ally.alive) continue;
          if (cheb(pu.pos, ally.pos) > 1) continue;
          if (ally.hp < ally.stats.health * 0.6) {
            patient = ally;
            break;
          }
        }
        if (patient) {
          const used = applyCommand(state, {
            type: "useItem",
            unitId: pu.id,
            targetId: patient.id,
            itemId: "medkit",
          });
          if (used.some((e) => e.type === "itemUsed")) acted = true;
        }
      }

      const targets = enemies
        .filter((e) => e.alive && canSee(state.grid, pu, e.pos))
        .sort((a, b) => a.hp - b.hp || dist(pu.pos, a.pos) - dist(pu.pos, b.pos) || a.id - b.id);

      const grenadeTile = bestGrenadeTile(state, pu, targets);
      if (grenadeTile) {
        const thrown = applyCommand(state, {
          type: "throwItem",
          unitId: pu.id,
          target: grenadeTile,
          itemId: "grenade",
        });
        if (thrown.some((e) => e.type === "itemThrown")) {
          acted = true;
          continue;
        }
      }

      let bestShot: { target: Unit; mode: ShotKind; eh: number } | undefined;
      for (const t of targets) {
        const inRange = cheb(pu.pos, t.pos) <= 9;
        for (const mode of FIRE_MODES) {
          const pv = previewPlayerShot(state, pu.id, t.pos, mode);
          if (!pv.possible) continue;
          if (!inRange && pv.hitChance < 0.4) continue;
          if (!bestShot || pv.expectedHits > bestShot.eh) {
            bestShot = { target: t, mode, eh: pv.expectedHits };
          }
        }
        if (bestShot) break;
      }
      if (bestShot) {
        applyCommand(state, {
          type: "shoot",
          unitId: pu.id,
          target: bestShot.target.pos,
          mode: bestShot.mode,
        });
        acted = true;
        continue;
      }

      if (targets.length > 0 && pu.ammo === 0) {
        const reloaded = applyCommand(state, { type: "reload", unitId: pu.id });
        if (reloaded.some((e) => e.type === "reloaded")) acted = true;
      }

      const dest = nearest(pu.pos, enemies);
      if (dest) {
        const cap = targets.length > 0 ? 7 : 0;
        if (cheb(pu.pos, dest.pos) > cap) {
          if (advanceCapped(state, pu, dest.pos, cap)) acted = true;
        }
      }
    }
    if (!acted) break;
  }
}

/** Auto-play a skirmish to a decisive status (or a stall, treated as a retreat). */
function autoPlayToCompletion(state: BattleState, maxRounds = MAX_BATTLE_ROUNDS): BattleState {
  let rounds = 0;
  while (state.status === "playing" && rounds < maxRounds) {
    takePlayerTurn(state);
    if (state.status !== "playing") break;
    applyCommand(state, { type: "endTurn" });
    rounds++;
  }
  return state;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

type LossReason = "threat" | "funding" | "panic" | "squad" | "stalled" | "none";

interface CampaignMetrics {
  seed: number;
  difficulty: DifficultyLevel;
  result: "won" | "lost";
  lossReason: LossReason;
  durationHours: number;
  missionsPlayed: number;
  missionsWon: number;
  terrorMissions: number;
  kia: number;
  wounded: number;
  endCredits: number;
  endAlloys: number;
  endElerium: number;
  endAlienData: number;
  endThreat: number;
  endFunding: number;
  endScore: number;
  ufosEncountered: number;
  ufosIntercepted: number;
  ufosEscaped: number;
  ufosLostAtSea: number;
  researchCompleted: number;
  maxRegionalPanic: number;
  defectedRegions: number;
  advances: number;
}

/** Classify the loss reason from the terminal campaign state, mirroring the
 * strategic layer's short-circuit order (threat -> funding -> squad -> panic). */
function classifyLoss(campaign: CampaignState): LossReason {
  if (campaign.strategic.threat >= 100) return "threat";
  if (campaign.strategic.funding <= 0) return "funding";
  const canField = livingSoldiers(campaign).length > 0 || canRecruitSoldier(campaign);
  if (!canField) return "squad";
  if (highestRegionalPanic(campaign).panic >= 100) return "panic";
  return "stalled";
}

// ---------------------------------------------------------------------------
// Strategic economy step: recruit to top up, start research, buy gear.
// Runs after every geoscape advance so completed research / fresh funding are
// spent promptly. All purchases go through the public guarded APIs.
// ---------------------------------------------------------------------------

/** Greedy research order: DPS (plasma) -> survivability (armor) -> medkit line
 * -> heavy weapons -> advanced lines. The first affordable, available project wins. */
const RESEARCH_PRIORITY: readonly ResearchId[] = [
  "plasmaWeapons",
  "alloyArmor",
  "alienBiotech",
  // Air war: unlock the Phantom advanced interceptor early so the fleet can run
  // down terror ships and battleships instead of being outrun by them.
  "alienPropulsion",
  "heavyPlasma",
  "advancedMetallurgy",
  "improvedMedikit",
  "poweredArmor",
  "eleriumPowerSource",
  "mindShield",
];

function economyStep(campaign: CampaignState): CampaignState {
  if (campaign.strategic.status !== "active") return campaign;
  let next = campaign;

  // 1. Recruit to keep a full deployment on the bench. recruiting pairs with
  //    setSoldierDeployment so a fresh operative actually deploys.
  let recruitGuard = 0;
  while (
    deploymentSoldiers(next).length < DEPLOYMENT_SIZE &&
    canRecruitSoldier(next) &&
    recruitGuard < DEPLOYMENT_SIZE
  ) {
    const rosterLen = next.soldiers.length;
    next = recruitSoldier(next);
    const recruit = next.soldiers[rosterLen];
    if (recruit) next = setSoldierDeployment(next, recruit.id, true);
    recruitGuard++;
  }

  // 2. Start the highest-priority affordable research when the lab is idle.
  if (!next.activeResearch) {
    for (const id of RESEARCH_PRIORITY) {
      if (canStartResearch(next, id)) {
        next = startResearch(next, id);
        break;
      }
    }
  }

  // 2b. Build the Phantom advanced interceptor once alienPropulsion clears. The
  //     guard already checks research, an idle workshop, a free hangar berth, and
  //     affordability, so this self-limits to a single Phantom (the hangar's one
  //     spare slot) and skips once the fleet is full.
  if (canStartManufacturing(next, "phantom")) {
    next = startManufacturing(next, "phantom");
  }

  // 3. Buy gear. Plasma (when research unlocks it) is the squad's main DPS
  //    upgrade; otherwise top up rifle stock so a reinforced roster is armed.
  const roster = activeSoldiers(next).length;
  const wantRifles = roster + 2;
  if (next.armory.weapons.plasma < DEPLOYMENT_SIZE && canPurchaseWeapon(next, "plasma").ok) {
    next = purchaseWeapon(next, "plasma");
  } else if (next.armory.weapons.rifle < wantRifles && canPurchaseWeapon(next, "rifle").ok) {
    next = purchaseWeapon(next, "rifle");
  }

  // 4. Equip plasma. purchaseWeapon only adds to armory stock — it does NOT
  //    assign the weapon to a soldier (the UI does that via onAssignWeapon).
  //    Without this, every soldier stays on the hard-coded "rifle" loadout,
  //    the plasma purchase is pure credit drain, and the win curve this
  //    diagnostic produces is rifle-only. Assign available plasma to deployed
  //    soldiers still on rifles so the upgrade reaches createSkirmish through
  //    deploymentWeaponIds. Iterating deploymentSoldiers in their stable order
  //    keeps the assignment deterministic for the byte-for-byte seed check.
  for (const soldier of deploymentSoldiers(next)) {
    if (availableWeaponCount(next, "plasma") <= 0) break;
    if (soldierWeaponId(next, soldier.id) === "rifle") {
      next = assignSoldierWeapon(next, soldier.id, "plasma");
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Ground assault: generateOperation -> createSkirmish -> auto-play -> record.
// ---------------------------------------------------------------------------

interface AssaultOutcome {
  campaign: CampaignState;
  result: MissionResult;
  kia: number;
  wounded: number;
  civiliansRescued: number;
  civilianCasualties: number;
  civiliansTotal: number;
}

function assaultContact(
  campaign: CampaignState,
  operation: OperationPlan = generateOperation(campaign),
): AssaultOutcome | undefined {
  const deployedSoldiers = deploymentSoldiers(campaign);
  if (deployedSoldiers.length === 0) return undefined;

  const deployedIds = deployedSoldiers.map((s) => s.id);
  const weaponIds = deploymentWeaponIds(campaign);
  const statBonuses = deployedSoldiers.map((s) => campaignSoldierStatBonus(campaign, s));
  const isTerror = operation.missionType === "terror";
  const isAssault = operation.missionType === "alienBaseAssault";
  const civiliansTotal = operation.missionContext?.civilianCount ?? 0;

  // Mirror main.ts's startTactical exactly for the final assault: the elite HQ
  // garrison (commander + leader) via alienBaseCrewRanks, NO recover objective
  // (pure elimination — no extra win path), the alien-base theme, and deep-night
  // lighting. Anything else here simulates a softer boss than the real game.
  const enemyRanks = isAssault ? alienBaseCrewRanks(operation.missionSeed, operation.enemyCount) : undefined;
  const objectiveKind = isTerror
    ? ("rescue" as const)
    : operation.missionType === "crashSite" || operation.missionType === "landedUfo"
      ? ("recover" as const)
      : undefined;

  const state = createSkirmish({
    seed: operation.missionSeed,
    width: operation.width,
    height: operation.height,
    players: deployedIds.length,
    enemies: operation.enemyCount,
    ...(enemyRanks ? { enemyRanks } : {}),
    themeId: operation.themeId,
    playerWeaponIds: weaponIds,
    playerSoldierIds: deployedIds,
    playerStatBonuses: statBonuses,
    ...(objectiveKind ? { objectiveKind } : {}),
    civilianCount: civiliansTotal,
    hourOfDay: isAssault ? 0 : campaign.clock.hour,
  });

  autoPlayToCompletion(state);

  // A stall (status still "playing") is treated as a retreat: the squad
  // withdraws with whoever survived, the mission counts as a failure.
  const result: MissionResult = state.status === "player_win" ? "success" : "failure";

  const survivors = livingUnits(state, "player")
    .map((u) => u.campaignSoldierId)
    .filter((id): id is string => typeof id === "string");
  const survivorHealth: Record<string, { hp: number; maxHp: number }> = {};
  for (const u of livingUnits(state, "player")) {
    if (typeof u.campaignSoldierId === "string") {
      survivorHealth[u.campaignSoldierId] = { hp: u.hp, maxHp: u.stats.health };
    }
  }
  const civiliansAlive = livingUnits(state, "civilian").length;
  const civiliansRescued = isTerror ? civiliansAlive : 0;
  const civilianCasualties = isTerror ? Math.max(0, civiliansTotal - civiliansAlive) : 0;

  // The roster outcome feeds wound recovery + terror rescue scoring.
  const after = recordMissionResult(campaign, result, operation, {
    deployedSoldierIds: deployedIds,
    survivingSoldierIds: survivors,
    survivorHealth,
    civilianCount: isTerror ? civiliansTotal : undefined,
    civiliansRescued: isTerror ? civiliansRescued : undefined,
    civilianCasualties: isTerror ? civilianCasualties : undefined,
  });

  const kia = deployedIds.length - survivors.length;
  // Wounded = deployed survivors now in "wounded" status (tracked via woundRecovery).
  const survivorSet = new Set(survivors);
  let wounded = 0;
  for (const s of after.soldiers) {
    if (survivorSet.has(s.id) && s.status === "wounded") wounded++;
  }

  return {
    campaign: after,
    result,
    kia,
    wounded,
    civiliansRescued,
    civilianCasualties,
    civiliansTotal,
  };
}

// ---------------------------------------------------------------------------
// Campaign driver
// ---------------------------------------------------------------------------

interface DriverCounters {
  encountered: Set<string>;
  intercepted: number;
  escaped: number;
  lostAtSea: number;
  resolved: Set<string>;
  missionsPlayed: number;
  missionsWon: number;
  terrorMissions: number;
  kia: number;
  wounded: number;
  advances: number;
}

function freshCounters(): DriverCounters {
  return {
    encountered: new Set(),
    intercepted: 0,
    escaped: 0,
    lostAtSea: 0,
    resolved: new Set(),
    missionsPlayed: 0,
    missionsWon: 0,
    terrorMissions: 0,
    kia: 0,
    wounded: 0,
    advances: 0,
  };
}

/** Run one campaign to a terminal status and collect its metrics. */
function runCampaign(seed: number, difficulty: DifficultyLevel): CampaignMetrics {
  let campaign = createCampaign(BASE, seed, difficulty);
  const counters = freshCounters();

  // Spend the starting bankroll before the clock starts rolling.
  campaign = economyStep(campaign);

  let stalled = false;
  while (campaign.strategic.status === "active" && !stalled) {
    if (campaign.clock.elapsedHours >= MAX_HOURS || counters.advances >= MAX_ADVANCES) {
      stalled = true;
      break;
    }

    // Endgame: once the HQ is revealed and the final assault is unlocked (via
    // interrogation research OR the CAMPAIGN_VICTORY_OPERATIONS fallback milestone),
    // launch the alien-base assault and treat it like any other mission. Winning it
    // is now the only path to "won"; a loss leaves the campaign active for a retry.
    if (canLaunchFinalAssault(campaign)) {
      const assaultOp = launchFinalAssault(campaign);
      if (assaultOp && deploymentSoldiers(campaign).length > 0) {
        const outcome = assaultContact(campaign, assaultOp);
        if (outcome) {
          campaign = outcome.campaign;
          counters.missionsPlayed++;
          counters.kia += outcome.kia;
          counters.wounded += outcome.wounded;
          if (outcome.result === "success") counters.missionsWon++;
          campaign = economyStep(campaign);
          continue;
        }
      }
    }

    const prevContactId = campaign.ufoContact?.id;
    campaign = advanceGeoscape(campaign, TICK_HOURS);
    counters.advances++;
    campaign = economyStep(campaign);

    // Detect a contact that slipped away this tick (expired without resolution).
    const contact = campaign.ufoContact;
    if (prevContactId && (!contact || contact.id !== prevContactId)) {
      if (!counters.resolved.has(prevContactId)) {
        counters.escaped++;
        counters.resolved.add(prevContactId);
      }
    }

    if (!contact) continue;
    if (!counters.encountered.has(contact.id)) counters.encountered.add(contact.id);

    // Tracked crash-site UFO: scramble an interceptor if one is ready AND our
    // fastest craft can actually catch it. A UFO that outruns the fleet (terror
    // ship / battleship vs a Raptor) escapes the pursuit and only wastes the
    // sortie, so skip it and keep building toward a Phantom instead.
    if (contact.status === "tracked") {
      if (canLaunchInterceptor(campaign) && interceptionSpeedAdvantage(campaign, contact) !== "outrun") {
        campaign = interceptUfo(campaign);
        const after = campaign.ufoContact;
        if (!after || after.id !== contact.id) {
          // Escape clears the contact entirely.
          counters.escaped++;
          counters.resolved.add(contact.id);
          continue;
        }
        if (after.status === "crashed") {
          counters.intercepted++;
          counters.resolved.add(contact.id);
          if (after.overOcean) {
            counters.lostAtSea++;
            continue; // wreck lost at sea; expires next tick
          }
          // Fall through to the ground assault below.
        } else {
          continue;
        }
      } else {
        // No ready interceptor yet; keep advancing so a craft can repair and
        // engage before the contact expires.
        continue;
      }
    }

    // An assaultable contact: crashed (over land) or already on the ground
    // (landed UFO, terror, base defense).
    if (campaign.ufoContact?.status === "crashed" || campaign.ufoContact?.status === "landed") {
      const outcome = assaultContact(campaign);
      if (!outcome) continue;
      campaign = outcome.campaign;
      counters.missionsPlayed++;
      counters.kia += outcome.kia;
      counters.wounded += outcome.wounded;
      if (outcome.result === "success") counters.missionsWon++;
      const missionType = campaign.lastMission?.missionType;
      if (missionType === "terror") counters.terrorMissions++;
      counters.resolved.add(contact.id);
    }
  }

  const result: "won" | "lost" = campaign.strategic.status === "won" ? "won" : "lost";
  const lossReason: LossReason = result === "won" ? "none" : stalled ? "stalled" : classifyLoss(campaign);

  return {
    seed,
    difficulty,
    result,
    lossReason,
    durationHours: campaign.clock.elapsedHours,
    missionsPlayed: counters.missionsPlayed,
    missionsWon: counters.missionsWon,
    terrorMissions: counters.terrorMissions,
    kia: counters.kia,
    wounded: counters.wounded,
    endCredits: campaign.resources.credits,
    endAlloys: campaign.resources.alloys,
    endElerium: campaign.resources.elerium,
    endAlienData: campaign.resources.alienData,
    endThreat: campaign.strategic.threat,
    endFunding: campaign.strategic.funding,
    endScore: campaign.strategic.score,
    ufosEncountered: counters.encountered.size,
    ufosIntercepted: counters.intercepted,
    ufosEscaped: counters.escaped,
    ufosLostAtSea: counters.lostAtSea,
    researchCompleted: campaign.completedResearch.length,
    maxRegionalPanic: highestRegionalPanic(campaign).panic,
    defectedRegions: defectedRegions(campaign).length,
    advances: counters.advances,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

interface SeriesStats {
  mean: number;
  median: number;
  min: number;
  max: number;
}

function mean(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}
function summarize(nums: number[]): SeriesStats {
  if (nums.length === 0) return { mean: 0, median: 0, min: 0, max: 0 };
  return {
    mean: mean(nums),
    median: median(nums),
    min: Math.min(...nums),
    max: Math.max(...nums),
  };
}

interface DifficultyReport {
  difficulty: DifficultyLevel;
  campaigns: number;
  wins: number;
  losses: number;
  winRate: number;
  lossReasons: Record<LossReason, number>;
  durationHours: SeriesStats;
  missionsPlayed: SeriesStats;
  missionsWon: SeriesStats;
  terrorMissions: SeriesStats;
  kia: SeriesStats;
  wounded: SeriesStats;
  endCredits: SeriesStats;
  endAlloys: SeriesStats;
  endElerium: SeriesStats;
  endAlienData: SeriesStats;
  endThreat: SeriesStats;
  endFunding: SeriesStats;
  endScore: SeriesStats;
  ufosEncountered: SeriesStats;
  ufosIntercepted: SeriesStats;
  ufosEscaped: SeriesStats;
  interceptionRate: number;
  researchCompleted: SeriesStats;
  maxRegionalPanic: SeriesStats;
  defectedRegions: SeriesStats;
}

function buildReport(difficulty: DifficultyLevel, metrics: CampaignMetrics[]): DifficultyReport {
  const wins = metrics.filter((m) => m.result === "won").length;
  const losses = metrics.length - wins;
  const lossReasons: Record<LossReason, number> = {
    threat: 0,
    funding: 0,
    panic: 0,
    squad: 0,
    stalled: 0,
    none: 0,
  };
  for (const m of metrics) lossReasons[m.lossReason]++;
  const encountered = metrics.map((m) => m.ufosEncountered);
  const intercepted = metrics.map((m) => m.ufosIntercepted);
  const totalEnc = encountered.reduce((a, b) => a + b, 0);
  const totalInt = intercepted.reduce((a, b) => a + b, 0);
  return {
    difficulty,
    campaigns: metrics.length,
    wins,
    losses,
    winRate: metrics.length ? (wins / metrics.length) * 100 : 0,
    lossReasons,
    durationHours: summarize(metrics.map((m) => m.durationHours)),
    missionsPlayed: summarize(metrics.map((m) => m.missionsPlayed)),
    missionsWon: summarize(metrics.map((m) => m.missionsWon)),
    terrorMissions: summarize(metrics.map((m) => m.terrorMissions)),
    kia: summarize(metrics.map((m) => m.kia)),
    wounded: summarize(metrics.map((m) => m.wounded)),
    endCredits: summarize(metrics.map((m) => m.endCredits)),
    endAlloys: summarize(metrics.map((m) => m.endAlloys)),
    endElerium: summarize(metrics.map((m) => m.endElerium)),
    endAlienData: summarize(metrics.map((m) => m.endAlienData)),
    endThreat: summarize(metrics.map((m) => m.endThreat)),
    endFunding: summarize(metrics.map((m) => m.endFunding)),
    endScore: summarize(metrics.map((m) => m.endScore)),
    ufosEncountered: summarize(encountered),
    ufosIntercepted: summarize(intercepted),
    ufosEscaped: summarize(metrics.map((m) => m.ufosEscaped)),
    interceptionRate: totalEnc ? (totalInt / totalEnc) * 100 : 0,
    researchCompleted: summarize(metrics.map((m) => m.researchCompleted)),
    maxRegionalPanic: summarize(metrics.map((m) => m.maxRegionalPanic)),
    defectedRegions: summarize(metrics.map((m) => m.defectedRegions)),
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function pct(n: number): string {
  return `${n.toFixed(1)}%`;
}
function num(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
function stat(s: SeriesStats, integer = false): string {
  const f = (v: number) => (integer ? num(v) : v.toFixed(1));
  return `mean ${f(s.mean)} | median ${f(s.median)} | [${f(s.min)} .. ${f(s.max)}]`;
}

function renderReport(reports: DifficultyReport[], allMetrics: CampaignMetrics[]): string {
  const lines: string[] = [];
  const push = (s = ""): void => {
    lines.push(s);
  };

  push("=".repeat(78));
  push("X-COM BALANCE SIMULATION — AGGREGATED REPORT");
  push(`${allMetrics.length} campaigns total (${CAMPAIGNS_PER_DIFFICULTY} per difficulty)`);
  push("=".repeat(78));

  for (const r of reports) {
    push("");
    push(`--- ${r.difficulty.toUpperCase()} (${r.campaigns} campaigns) --------------------`);
    push(`  OUTCOME:`);
    push(`    win rate        : ${pct(r.winRate)}  (${r.wins}W / ${r.losses}L)`);
    push(`    loss reasons    : threat=${r.lossReasons.threat}  funding=${r.lossReasons.funding}  panic=${r.lossReasons.panic}  squad=${r.lossReasons.squad}  stalled=${r.lossReasons.stalled}`);
    push(`    duration (hours): ${stat(r.durationHours)}`);
    push(`    duration (days) : mean ${(r.durationHours.mean / 24).toFixed(1)} | median ${(r.durationHours.median / 24).toFixed(1)}`);
    push(`  MISSIONS & TROOPS:`);
    push(`    missions played : ${stat(r.missionsPlayed)}`);
    push(`    missions won    : ${stat(r.missionsWon)}  (of ${CAMPAIGN_VICTORY_OPERATIONS} to win)`);
    push(`    terror missions: ${stat(r.terrorMissions)}`);
    push(`    KIA / campaign  : ${stat(r.kia)}`);
    push(`    wounded/campaign: ${stat(r.wounded)}`);
    push(`  AIR WAR:`);
    push(`    UFOs encountered: ${stat(r.ufosEncountered)}`);
    push(`    UFOs intercepted: ${stat(r.ufosIntercepted)}`);
    push(`    UFOs escaped    : ${stat(r.ufosEscaped)}`);
    push(`    interception %  : ${pct(r.interceptionRate)}  (aggregate)`);
    push(`  ECONOMY @ END:`);
    push(`    credits         : ${stat(r.endCredits)}`);
    push(`    alloys          : ${stat(r.endAlloys)}`);
    push(`    elerium         : ${stat(r.endElerium)}`);
    push(`    alien data      : ${stat(r.endAlienData)}`);
    push(`  STRATEGIC @ END:`);
    push(`    threat          : ${stat(r.endThreat)}`);
    push(`    funding         : ${stat(r.endFunding)}`);
    push(`    score           : ${stat(r.endScore, true)}`);
    push(`    research done   : ${stat(r.researchCompleted)}  (of ${RESEARCH_PROJECTS.length})`);
    push(`    max reg. panic  : ${stat(r.maxRegionalPanic)}`);
    push(`    defected regions: ${stat(r.defectedRegions, true)}`);
  }

  push("");
  push("=".repeat(78));
  push("WIN-RATE COMPARISON");
  push("=".repeat(78));
  for (const r of reports) {
    push(`  ${r.difficulty.padEnd(9)}: ${pct(r.winRate).padStart(7)}  | avg ${num(r.durationHours.mean / 24)}d | ${num(r.missionsPlayed.mean)} missions | ${num(r.kia.mean)} KIA | ${pct(r.interceptionRate)} intercept`);
  }

  push("");
  push("=".repeat(78));
  push("CONFIG");
  push(`  campaigns/difficulty = ${CAMPAIGNS_PER_DIFFICULTY}  | tick = ${TICK_HOURS}h  | max hours = ${MAX_HOURS}  | max battle rounds = ${MAX_BATTLE_ROUNDS}`);
  push("=".repeat(78));
  return lines.join("\n");
}

// ===========================================================================
// The simulation. One test: run all campaigns, render the report, and assert
// only HARNESS invariants (determinism, termination, counts) — never balance
// outcomes, which this diagnostic exists to MEASURE, not gate.
// ===========================================================================

describe("balance simulation", () => {
  const REPORT_TIMEOUT = Math.min(3_600_000, 120_000 + CAMPAIGNS_PER_DIFFICULTY * 4000);

  it(
    "runs 50 campaigns per difficulty and aggregates balance metrics",
    () => {
      const allMetrics: CampaignMetrics[] = [];
      const reports: DifficultyReport[] = [];

      for (const difficulty of DIFFICULTIES) {
        const metrics: CampaignMetrics[] = [];
        for (let i = 0; i < CAMPAIGNS_PER_DIFFICULTY; i++) {
          // Distinct seed per (difficulty, run); offsets avoid collisions across
          // difficulties so the same UFO-type rolls don't recur verbatim.
          const seed = (i + 1) * 7919 + (difficulty === "rookie" ? 0 : difficulty === "veteran" ? 100003 : 200003);
          metrics.push(runCampaign(seed, difficulty));
        }
        allMetrics.push(...metrics);
        reports.push(buildReport(difficulty, metrics));
      }

      const report = renderReport(reports, allMetrics);
      // eslint-disable-next-line no-console
      console.log(`\n${report}`);

      // ---- Harness invariants (NOT balance assertions) ----

      // Every configured campaign ran.
      expect(allMetrics).toHaveLength(DIFFICULTIES.length * CAMPAIGNS_PER_DIFFICULTY);

      // Every campaign reached a terminal status (the loop never got stuck).
      for (const m of allMetrics) {
        expect(m.result === "won" || m.result === "lost").toBe(true);
        expect(m.durationHours).toBeGreaterThan(0);
        expect(m.advances).toBeGreaterThan(0);
        expect(m.ufosIntercepted).toBeGreaterThanOrEqual(0);
        expect(m.kia).toBeGreaterThanOrEqual(0);
      }

      // Determinism: re-running the same (seed, difficulty) reproduces the exact
      // same metrics. Proves the harness is reproducible to the byte.
      for (const difficulty of DIFFICULTIES) {
        const seed = 7919 + (difficulty === "rookie" ? 0 : difficulty === "veteran" ? 100003 : 200003);
        const a = runCampaign(seed, difficulty);
        const b = runCampaign(seed, difficulty);
        expect(a).toEqual(b);
      }
    },
    REPORT_TIMEOUT,
  );
});
