/**
 * Deterministic end-to-end loop: campaign -> generated battle -> campaign.
 *
 * These tests prove the campaign layer (src/campaign) and the tactical sim
 * (src/sim) are wired together through the full public API:
 *   generateOperation -> createSkirmish -> applyCommand -> recordMissionResult
 * and that the newer tactical mechanics (grenades, medkits, interception
 * encounters, the equipment market, difficulty scaling) behave inside a REAL
 * generated battle and a REAL campaign state.
 *
 * Everything is deterministic: fixed seeds, a fixed-seed search where a
 * favorable spawn is needed, and the sim's own seeded Rng. No Math.random,
 * no real wall-clock dependencies. When a public API offers no deterministic
 * way to set up an exact scenario (wounding a specific player), the state is
 * shaped directly and the reason is called out in a comment.
 */
import { describe, it, expect } from "vitest";
import {
  createCampaign,
  recordMissionResult,
  purchaseWeapon,
  canPurchaseWeapon,
  campaignObjectiveProgress,
  MARKET_CONFIG,
  deploymentWeaponIds,
} from "../src/campaign/storage";
import {
  createUfoContact,
  interceptUfo,
  startInterceptionEncounter,
  executeInterceptionAction,
  canLaunchInterceptor,
} from "../src/campaign/geoscape";
import { generateOperation } from "../src/campaign/operations";
import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
  MissionResult,
  OperationPlan,
} from "../src/campaign/types";
import {
  createSkirmish,
  applyCommand,
  previewPlayerShot,
  unitById,
  livingUnits,
  canSee,
  findPath,
  tileTypeAt,
  TU_COST,
} from "../src/sim/index";
import type { BattleState, GameEvent, Unit, Vec2 } from "../src/sim/types";

// ---------------------------------------------------------------------------
// Shared constants & helpers
// ---------------------------------------------------------------------------

const BASE: BaseLocation = { lat: 39.0, lon: -77.0, region: "North America" };

/** Chebyshev (chessboard) distance between two tiles. */
function cheb(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Euclidean distance (for the auto-player's nearest-target sort). */
function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Seed a campaign with a crashed crash-site UFO contact (the launchable state). */
function campaignWithCrashedContact(seed: number, difficulty: DifficultyLevel = "veteran"): CampaignState {
  const campaign = createCampaign(BASE, seed, difficulty);
  // createUfoContact is the public contact factory; attaching it to the campaign
  // is the intended public setup path (see geoscape.advanceGeoscape which does
  // the same assignment internally).
  campaign.ufoContact = createUfoContact(campaign, 0, "crashSite");
  const intercepted = interceptUfo(campaign);
  expect(intercepted.ufoContact?.status).toBe("crashed");
  return intercepted;
}

// ---------------------------------------------------------------------------
// Auto-player (mirrors tests/integration.test.ts): a greedy, fully
// deterministic driver that shoots what it can see and otherwise closes in,
// driving the battle to a decisive status through the public applyCommand API.
// ---------------------------------------------------------------------------

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

function furthestAffordable(
  state: BattleState,
  unit: Unit,
  path: Vec2[],
  enemyPos: Vec2,
): Vec2 | undefined {
  let cost = 0;
  let prev = unit.pos;
  let best: Vec2 | undefined;
  for (const step of path) {
    cost += stepCost(state, prev, step);
    if (cost > unit.tu) break;
    prev = step;
    const isEnemyTile = step.x === enemyPos.x && step.y === enemyPos.y;
    if (!isEnemyTile && !occupiedByOther(state, unit.id, step.x, step.y)) best = { ...step };
  }
  return best;
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

function takePlayerTurn(state: BattleState): void {
  for (let guard = 0; guard < 60; guard++) {
    const players = livingUnits(state, "player").filter((u) => u.tu > 0);
    const enemies = livingUnits(state, "enemy");
    if (players.length === 0 || enemies.length === 0) break;

    let acted = false;
    for (const pu of players) {
      if (pu.tu <= 0 || state.status !== "playing") continue;

      const targets = enemies
        .filter((e) => e.alive && canSee(state.grid, pu, e.pos))
        .sort((a, b) => dist(pu.pos, a.pos) - dist(pu.pos, b.pos) || a.id - b.id);

      let didShoot = false;
      for (const t of targets) {
        if (previewPlayerShot(state, pu.id, t.pos, "snap").possible) {
          applyCommand(state, { type: "shoot", unitId: pu.id, target: t.pos, mode: "snap" });
          didShoot = true;
          acted = true;
          break;
        }
      }
      if (didShoot) continue;

      const target = nearest(pu.pos, enemies);
      if (!target) continue;
      const result = findPath(state.grid, pu.pos, target.pos, {
        isBlocked: (x, y) => occupiedByOther(state, pu.id, x, y),
      });
      if (!result || result.path.length === 0) continue;
      const dest = furthestAffordable(state, pu, result.path, target.pos);
      if (!dest) continue;
      const tuBefore = pu.tu;
      applyCommand(state, { type: "move", unitId: pu.id, to: dest });
      if (pu.tu !== tuBefore) acted = true;
    }
    if (!acted) break;
  }
}

/** Auto-play a skirmish to a decisive status, returning the final BattleState. */
function autoPlayToCompletion(state: BattleState, maxRounds = 120): BattleState {
  let rounds = 0;
  while (state.status === "playing" && rounds < maxRounds) {
    takePlayerTurn(state);
    if (state.status !== "playing") break;
    applyCommand(state, { type: "endTurn" });
    rounds++;
  }
  return state;
}

// ===========================================================================
// 1. FULL LOOP: campaign -> battle -> campaign
// ===========================================================================

describe("end-to-end loop", () => {
  // Both seeds deterministically: (a) crash via interceptUfo, and (b) auto-play
  // to a player_win on the operation their contact generates. Parametrizing over
  // two seeds (distinct enemyCount + theme profiles) proves the wiring is not
  // seed-specific.
  it.each<[number]>([
    [1],
    [150],
  ])("seed %i: generateOperation -> createSkirmish -> applyCommand -> recordMissionResult", (seed) => {
    const campaign = campaignWithCrashedContact(seed, "veteran");
    const operation: OperationPlan = generateOperation(campaign);

    // Sanity: the operation carries everything createSkirmish needs.
    expect(operation.missionType).toBe("crashSite");
    expect(operation.enemyCount).toBeGreaterThan(0);
    expect(operation.width).toBeGreaterThanOrEqual(20);
    expect(operation.height).toBeGreaterThanOrEqual(20);
    expect(Number.isInteger(operation.missionSeed)).toBe(true);

    const deployed = campaign.deploymentSoldierIds.slice(0, 4);
    const state = createSkirmish({
      seed: operation.missionSeed,
      width: operation.width,
      height: operation.height,
      players: 4,
      enemies: operation.enemyCount,
      themeId: operation.themeId,
      playerWeaponIds: deploymentWeaponIds(campaign),
      playerSoldierIds: deployed,
      playerNames: ["Vega", "Rook", "Mason", "Pike"],
    });

    const finalState = autoPlayToCompletion(state);
    expect(finalState.status).toBe("player_win");

    // Map battle survivors back to campaign soldier ids via campaignSoldierId.
    const survivors = livingUnits(finalState, "player")
      .map((u) => u.campaignSoldierId)
      .filter((id): id is string => typeof id === "string");
    const result: MissionResult = finalState.status === "player_win" ? "success" : "failure";

    const survivorHealth: Record<string, { hp: number; maxHp: number }> = {};
    for (const u of livingUnits(finalState, "player")) {
      if (typeof u.campaignSoldierId === "string") {
        survivorHealth[u.campaignSoldierId] = { hp: u.hp, maxHp: u.stats.health };
      }
    }

    const resourcesBefore = campaign.resources;
    const completedBefore = campaign.missionsCompleted;
    const attemptedBefore = campaign.missionsAttempted;
    const objectiveBefore = campaignObjectiveProgress(campaign).completed;

    const after = recordMissionResult(campaign, result, operation, {
      deployedSoldierIds: deployed,
      survivingSoldierIds: survivors,
      survivorHealth,
    });

    // The mission counters advanced and the report was recorded.
    expect(after.missionsAttempted).toBe(attemptedBefore + 1);
    expect(after.missionsCompleted).toBe(completedBefore + 1);
    expect(after.lastMission).toBeDefined();
    expect(after.lastMission?.result).toBe("success");
    expect(after.lastMission?.missionNumber).toBe(operation.missionNumber);
    expect(after.lastMission?.missionSeed).toBe(operation.missionSeed);

    // A success credits the operation's reward exactly (no other resource
    // mutation happens inside recordMissionResult for a crash-site mission).
    expect(after.resources.credits).toBe(resourcesBefore.credits + operation.reward.credits);
    expect(after.resources.alloys).toBe(resourcesBefore.alloys + operation.reward.alloys);
    expect(after.resources.elerium).toBe(resourcesBefore.elerium + operation.reward.elerium);
    expect(after.resources.alienData).toBe(resourcesBefore.alienData + operation.reward.alienData);

    // The recovered core advances the containment objective and clears the contact.
    expect(campaignObjectiveProgress(after).completed).toBe(objectiveBefore + 1);
    expect(after.ufoContact).toBeUndefined();
  });
});

// ===========================================================================
// 2. GRENADE in a real generated battle
// ===========================================================================

/**
 * Walk `unit` along the path toward `cover` and stop on the first tile that is
 * inside the grenade's throw range but OUTSIDE its blast radius (chebyshev in
 * [3, THROW_RANGE]). Keeps the thrower out of its own blast. Single turn only:
 * no endTurn => no enemy AI => fully deterministic.
 */
function moveWithinThrowRangeOutsideBlast(state: BattleState, unit: Unit, cover: Vec2): void {
  const THROW_RANGE = 8;
  for (let guard = 0; guard < 300; guard++) {
    if (unit.tu <= 0 || state.status !== "playing") break;
    const d = cheb(unit.pos, cover);
    if (d <= THROW_RANGE) break; // already in throw range

    const result = findPath(state.grid, unit.pos, cover, {
      isBlocked: (x, y) => occupiedByOther(state, unit.id, x, y),
    });
    if (!result || result.path.length === 0) break;

    // Pick the furthest affordable step that lands the unit in throw range but
    // outside the blast (cheb in [3, THROW_RANGE]); prefer the closest such tile
    // to the cover for a short throw.
    let cost = 0;
    let prev = unit.pos;
    let chosen: Vec2 | undefined;
    for (const step of result.path) {
      cost += stepCost(state, prev, step);
      if (cost > unit.tu) break;
      prev = step;
      if (occupiedByOther(state, unit.id, step.x, step.y)) continue;
      const sd = cheb(step, cover);
      if (sd >= 3 && sd <= THROW_RANGE) chosen = { ...step };
      if (sd < 3) break; // don't walk into our own blast
    }
    if (!chosen) break;
    const tuBefore = unit.tu;
    applyCommand(state, { type: "move", unitId: unit.id, to: chosen });
    if (unit.tu === tuBefore) break; // no progress
  }
}

describe("grenade in a real battle", () => {
  it("a throwItem command blasts >=2 clustered enemies on a generated map", () => {
    // Boost thrower (player index 0) TU + HP so it can traverse to the UFO
    // cluster in a single turn and survive any reaction fire en route. Other
    // players get an HP cushion. The throw still resolves through the real
    // public applyCommand path on a real generated map.
    const state = createSkirmish({
      seed: 8,
      width: 30,
      height: 30,
      players: 4,
      enemies: 6,
      playerStatBonuses: [
        { timeUnits: 1000, health: 1000 },
        { health: 200 },
        { health: 200 },
        { health: 200 },
      ],
    });

    const enemies = livingUnits(state, "enemy");
    const thrower = state.units.find((u) => u.faction === "player")!;
    // Troopers carry a grenade by default from the template loadout.
    expect(thrower.items?.some((i) => i.itemId === "grenade" && i.uses > 0)).toBe(true);

    // Find a cover tile (an enemy position) with the most enemies within the
    // grenade's blast radius (2). The UFO defenders cluster here by construction.
    let cover: Vec2 | undefined;
    let bestCount = 0;
    for (const e of enemies) {
      const cnt = enemies.filter((o) => cheb(o.pos, e.pos) <= 2).length;
      if (cnt > bestCount) {
        bestCount = cnt;
        cover = { ...e.pos };
      }
    }
    expect(cover).toBeDefined();
    expect(bestCount).toBeGreaterThanOrEqual(2);

    moveWithinThrowRangeOutsideBlast(state, thrower, cover!);
    // The thrower now stands within throw range and outside the blast radius.
    const throwerDist = cheb(thrower.pos, cover!);
    expect(throwerDist).toBeGreaterThanOrEqual(3);
    expect(throwerDist).toBeLessThanOrEqual(8);

    const hpBefore = new Map<number, number>(enemies.map((e) => [e.id, e.hp]));
    const events: GameEvent[] = applyCommand(state, {
      type: "throwItem",
      unitId: thrower.id,
      target: cover!,
      itemId: "grenade",
    });

    const thrown = events.find((e) => e.type === "itemThrown");
    const blast = events.find((e) => e.type === "blastDetonated");
    expect(thrown).toBeDefined();
    expect(blast).toBeDefined();

    // At least two enemies were struck by the blast...
    if (blast?.type === "blastDetonated") {
      expect(blast.hits.length).toBeGreaterThanOrEqual(2);
      const enemyHits = blast.hits.filter((h) =>
        state.units.some((u) => u.id === h.unitId && u.faction === "enemy"),
      );
      expect(enemyHits.length).toBeGreaterThanOrEqual(2);
    }

    // ...and at least two enemies actually took damage or died.
    let damaged = 0;
    for (const e of enemies) {
      const before = hpBefore.get(e.id) ?? e.hp;
      if (e.hp < before || !e.alive) damaged++;
    }
    expect(damaged).toBeGreaterThanOrEqual(2);

    // Single-use grenade is consumed.
    expect(thrower.items?.some((i) => i.itemId === "grenade" && i.uses > 0)).toBe(false);
  });
});

// ===========================================================================
// 3. MEDKIT in a real generated battle
// ===========================================================================

describe("medkit in a real battle", () => {
  it("a useItem command heals a wounded ally (capped at maxHp) on a generated map", () => {
    const state = createSkirmish({ seed: 8, width: 30, height: 30, players: 4, enemies: 6 });

    // The two closest player units deploy adjacent at the dropship (chebyshev 1).
    const players = livingUnits(state, "player");
    let medic: Unit | undefined;
    let target: Unit | undefined;
    let bestD = Infinity;
    for (let i = 0; i < players.length; i++) {
      for (let j = i + 1; j < players.length; j++) {
        const d = cheb(players[i]!.pos, players[j]!.pos);
        if (d < bestD) {
          bestD = d;
          medic = players[i];
          target = players[j];
        }
      }
    }
    expect(medic).toBeDefined();
    expect(target).toBeDefined();
    expect(bestD).toBe(1); // adjacent: required for a medkit application
    expect(medic!.items?.some((i) => i.itemId === "medkit" && i.uses > 0)).toBe(true);

    // There is no deterministic PUBLIC path to wound a specific player unit
    // (enemy fire is probabilistic, and a friendly grenade's damage roll could
    // be lethal). Per the "fixed setup" allowance, wound the target directly.
    const maxHp = target!.stats.health;
    target!.hp = Math.max(1, Math.floor(maxHp / 4));
    const hpBefore = target!.hp;

    const events = applyCommand(state, {
      type: "useItem",
      unitId: medic!.id,
      targetId: target!.id,
      itemId: "medkit",
    });

    const used = events.find((e) => e.type === "itemUsed");
    expect(used).toBeDefined();
    if (used?.type === "itemUsed") {
      expect(used.healed).toBeGreaterThan(0);
      expect(used.targetId).toBe(target!.id);
    }
    expect(target!.hp).toBeGreaterThan(hpBefore);
    expect(target!.hp).toBeLessThanOrEqual(maxHp);
  });
});

// ===========================================================================
// 4. INTERCEPTION encounter -> mission seed
// ===========================================================================

describe("interactive interception -> crash site", () => {
  it("attack resolves to a crashed launchable contact; disengage returns cleanly", () => {
    const campaign = createCampaign(BASE, 1, "veteran");
    campaign.ufoContact = createUfoContact(campaign, 0, "crashSite");

    const engaging = startInterceptionEncounter(campaign);
    expect(engaging.ufoContact?.status).toBe("engaging");
    expect(engaging.interception).toBeDefined();

    // A disengage returns the encounter to a non-terminal, tracked state with no
    // throw, leaving the contact launchable again.
    const disengaged = executeInterceptionAction(engaging, "disengage");
    expect(disengaged.ufoContact?.status).toBe("tracked");
    expect(disengaged.interception).toBeUndefined();
    expect(canLaunchInterceptor(disengaged)).toBe(true);

    // Re-engage and attack until the UFO is forced down. Seed 1 deterministically
    // resolves to a crash via repeated attack.
    let resolved = startInterceptionEncounter(disengaged);
    let guard = 0;
    while (resolved.ufoContact?.status === "engaging" && guard < 60) {
      resolved = executeInterceptionAction(resolved, "attack");
      guard++;
    }
    expect(resolved.ufoContact?.status).toBe("crashed");

    // The crashed contact seeds a valid crash-site operation.
    const operation = generateOperation(resolved);
    expect(operation.missionType).toBe("crashSite");
    expect(operation.enemyCount).toBeGreaterThan(0);
    expect(operation.width).toBeGreaterThanOrEqual(20);
    expect(operation.height).toBeGreaterThanOrEqual(20);
    expect(Number.isInteger(operation.missionSeed)).toBe(true);
  });
});

// ===========================================================================
// 5. MARKET -> ARMORY
// ===========================================================================

describe("market -> armory purchase", () => {
  it("purchaseWeapon spends credits, stocks the armory, and is blocked when broke", () => {
    const campaign = createCampaign(BASE, 1, "veteran");
    const creditsBefore = campaign.resources.credits;
    const riflesBefore = campaign.armory.weapons.rifle;
    const price = MARKET_CONFIG.rifle.price;

    // Veteran starts with 650 credits; a rifle costs 400, so one purchase fits.
    expect(creditsBefore).toBeGreaterThanOrEqual(price);

    const after = purchaseWeapon(campaign, "rifle");
    expect(after.resources.credits).toBe(creditsBefore - price);
    expect(after.armory.weapons.rifle).toBe(riflesBefore + 1);

    // The remaining credits (250) are below the rifle price (400): a second
    // purchase is now blocked by the public guard and is a no-op.
    expect(canPurchaseWeapon(after, "rifle").ok).toBe(false);
    const blocked = purchaseWeapon(after, "rifle");
    expect(blocked.resources.credits).toBe(after.resources.credits);
    expect(blocked.armory.weapons.rifle).toBe(after.armory.weapons.rifle);
  });
});

// ===========================================================================
// 6. DIFFICULTY scales the loop
// ===========================================================================

describe("difficulty scales enemy count", () => {
  // The SAME seed produces the SAME UFO contact (strength + missionSeed are
  // derived from campaign.seed, not difficulty), so any enemyCount difference
  // between rookie and commander is purely the difficulty multiplier.
  it.each<[number]>([
    [1],
    [150],
  ])("seed %i: commander fields more enemies than rookie for the same contact", (seed) => {
    const rookie = campaignWithCrashedContact(seed, "rookie");
    const commander = campaignWithCrashedContact(seed, "commander");

    const opRookie = generateOperation(rookie);
    const opCommander = generateOperation(commander);

    // Same contact => same theme/seed pipeline; only the count should diverge.
    expect(opRookie.missionSeed).toBe(opCommander.missionSeed);
    expect(opCommander.enemyCount).toBeGreaterThan(opRookie.enemyCount);
  });
});
