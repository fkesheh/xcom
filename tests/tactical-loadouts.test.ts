import { describe, it, expect } from "vitest";
import { createSkirmish } from "../src/sim/setup";
import { runEnemyTurn } from "../src/sim/ai";
import { ITEMS, WEAPONS } from "../src/sim/content";
import { makeGrid } from "../src/sim/grid";
import { Rng } from "../src/sim/rng";
import { findMode, resolveShot, reloadTuCost, tuCostForMode } from "../src/sim/combat";
import type {
  AiExecutor,
  BattleState,
  BlastHit,
  Dir8,
  Faction,
  GameEvent,
  ShotKind,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// createSkirmish: morale, template loadouts, item registry
// ---------------------------------------------------------------------------

describe("createSkirmish tactical loadouts", () => {
  it("gives every unit full morale and the item registry is populated", () => {
    const state = createSkirmish({ seed: 1234, players: 4, enemies: 6 });

    for (const u of state.units) {
      expect(u.morale).toBe(100);
      expect(Array.isArray(u.items)).toBe(true);
    }

    expect(state.items).toBeDefined();
    expect(state.items?.["grenade"]).toBeDefined();
    expect(state.items?.["medkit"]).toBeDefined();
  });

  it("deploys troopers with their template grenade + medkit and drones with nothing", () => {
    const state = createSkirmish({ seed: 1234, players: 4, enemies: 6 });

    const troopers = state.units.filter((u) => u.templateId === "trooper");
    expect(troopers.length).toBeGreaterThan(0);
    for (const t of troopers) {
      const ids = (t.items ?? []).map((i) => i.itemId);
      expect(ids).toContain("grenade");
      expect(ids).toContain("medkit");
      expect((t.items ?? []).length).toBeGreaterThanOrEqual(2);
    }

    const drones = state.units.filter((u) => u.templateId === "drone");
    expect(drones.length).toBeGreaterThan(0);
    for (const d of drones) {
      expect(d.items).toEqual([]);
    }

    // Sentinels carry a single grenade from their template.
    const sentinels = state.units.filter((u) => u.templateId === "sentinel");
    expect(sentinels.length).toBeGreaterThan(0);
    for (const s of sentinels) {
      expect((s.items ?? []).map((i) => i.itemId)).toEqual(["grenade"]);
    }
  });

  it.each<[string, number]>([
    ["grenade", 1],
    ["medkit", 3],
  ])("item instance %s carries %i uses", (itemId, uses) => {
    const state = createSkirmish({ seed: 1234 });
    const trooper = state.units.find((u) => u.templateId === "trooper");
    const inst = trooper?.items?.find((i) => i.itemId === itemId);
    expect(inst).toBeDefined();
    expect(inst!.uses).toBe(uses);
  });
});

// ---------------------------------------------------------------------------
// playerItems option
// ---------------------------------------------------------------------------

describe("playerItems option", () => {
  it("appends extra item instances on top of the template loadout", () => {
    const baseline = createSkirmish({ seed: 99, players: 2, enemies: 1 });
    const loaded = createSkirmish({
      seed: 99,
      players: 2,
      enemies: 1,
      playerItems: [["grenade", "grenade"], ["medkit"]],
    });

    const basePlayers = baseline.units.filter((u) => u.faction === "player");
    const loadedPlayers = loaded.units.filter((u) => u.faction === "player");

    // Player 0 gets +2 (two extra grenades); player 1 gets +1 (extra medkit).
    expect(loadedPlayers[0]!.items!.length).toBe(basePlayers[0]!.items!.length + 2);
    expect(loadedPlayers[1]!.items!.length).toBe(basePlayers[1]!.items!.length + 1);

    // Template grenade (1) + two extras (2) = three single-use grenades.
    const p0Grenades = loadedPlayers[0]!.items!.filter((i) => i.itemId === "grenade");
    expect(p0Grenades.length).toBe(3);
    expect(p0Grenades.every((g) => g.uses === 1)).toBe(true);

    // Template medkit (1) + one extra (1) = two 3-charge medkits.
    const p1Medkits = loadedPlayers[1]!.items!.filter((i) => i.itemId === "medkit");
    expect(p1Medkits.length).toBe(2);
    expect(p1Medkits.every((m) => m.uses === 3)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Enemy AI grenade throw
// ---------------------------------------------------------------------------

function makeUnit(
  id: UnitId,
  faction: Faction,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  return {
    id,
    name: `u${id}`,
    templateId: "trooper",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 30,
      reactions: 40,
      firingAccuracy: 80,
      strength: 30,
      bravery: 50,
    },
    tu: 60,
    hp: 30,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    morale: 100,
    items: [],
    ...overrides,
  };
}

function makeState(units: Unit[], seed = 555): BattleState {
  return {
    grid: makeGrid(24, 12),
    units,
    weapons: { rifle: WEAPONS.rifle! },
    items: { ...ITEMS },
    turn: 1,
    activeFaction: "enemy",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

const chebyshev = (a: Vec2, b: Vec2): number =>
  Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Minimal executor that mutates state like the reducer would, incl. grenade blasts. */
function makeExec(state: BattleState): AiExecutor {
  const unitById = (id: UnitId): Unit => {
    const u = state.units.find((x) => x.id === id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  };
  return {
    move(unitId, to): GameEvent[] {
      const u = unitById(unitId);
      const from = { ...u.pos };
      u.pos = { x: to.x, y: to.y };
      u.tu = Math.max(0, u.tu - 4);
      return [{ type: "moveStep", unitId, from, to: { ...u.pos }, facing: u.facing, tuLeft: u.tu }];
    },
    shoot(unitId, target, mode): GameEvent[] {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      const m = weapon && findMode(weapon, mode);
      if (!weapon || !m) return [];
      u.tu -= tuCostForMode(u, m);
      u.ammo = Math.max(0, u.ammo - m.shots);
      const res = resolveShot(state, u, target, mode);
      return [
        {
          type: "shot",
          shooterId: unitId,
          targetId: res.targetId,
          targetPos: { x: target.x, y: target.y },
          originPos: { x: u.pos.x, y: u.pos.y },
          mode,
          rounds: res.rounds,
          tuLeft: u.tu,
          reaction: false,
        },
      ];
    },
    reload(unitId): GameEvent[] {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      if (!weapon) return [];
      const cost = reloadTuCost(u, weapon);
      if (u.tu < cost || u.ammo >= weapon.magazineSize) return [];
      u.tu -= cost;
      u.ammo = weapon.magazineSize;
      return [{ type: "reloaded", unitId, ammo: u.ammo, tuLeft: u.tu }];
    },
    face(unitId, dir): GameEvent[] {
      const u = unitById(unitId);
      u.facing = dir;
      return [{ type: "faced", unitId, dir, tuLeft: u.tu }];
    },
    throwItem(unitId, target, itemId): GameEvent[] {
      const u = unitById(unitId);
      const def = state.items?.[itemId];
      if (!def || def.kind !== "grenade") return [];
      const inst = u.items?.find((it) => it.itemId === itemId && it.uses > 0);
      if (!inst) return [];
      const cost = Math.ceil((u.stats.timeUnits * def.tuPercent) / 100);
      if (u.tu < cost) return [];
      u.tu -= cost;
      inst.uses -= 1;
      const radius = def.blastRadius ?? 2;
      const center = { x: target.x, y: target.y };
      const hits: BlastHit[] = [];
      for (const o of state.units) {
        if (!o.alive) continue;
        if (chebyshev(o.pos, center) > radius) continue;
        const damage = def.damage ?? 0;
        o.hp = Math.max(0, o.hp - damage);
        const killed = o.hp <= 0;
        if (killed) o.alive = false;
        hits.push({ unitId: o.id, damage, killed });
      }
      return [
        { type: "itemThrown", unitId, itemId, from: { x: u.pos.x, y: u.pos.y }, to: center, tuLeft: u.tu },
        { type: "blastDetonated", itemId, center, radius, hits },
      ];
    },
  };
}

describe("enemy AI grenade throw", () => {
  it("lobs a grenade at a cluster of >=2 players in throw range", () => {
    // Open field. Enemy at (8,6) facing east holds one grenade; two players
    // cluster at (13,6) and (14,6), well inside the grenade's 8-tile range.
    const enemy = makeUnit(5, "enemy", { x: 8, y: 6 }, 2 /* E */, {
      items: [{ itemId: "grenade", uses: 1 }],
    });
    const p1 = makeUnit(1, "player", { x: 13, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30, bravery: 50 },
    });
    const p2 = makeUnit(2, "player", { x: 14, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30, bravery: 50 },
    });
    const state = makeState([enemy, p1, p2]);
    const events = runEnemyTurn(state, makeExec(state));

    const thrown = events.filter((e) => e.type === "itemThrown");
    const blasts = events.filter((e) => e.type === "blastDetonated");
    expect(thrown.length).toBeGreaterThanOrEqual(1);
    expect(blasts.length).toBeGreaterThanOrEqual(1);

    const blast = blasts[0]!;
    expect(blast.type).toBe("blastDetonated");
    if (blast.type === "blastDetonated") {
      expect(blast.hits.length).toBeGreaterThanOrEqual(2);
      expect(blast.hits.map((h) => h.unitId).sort((a, b) => a - b)).toEqual([1, 2]);
    }

    // Both clustered players took damage; the grenade instance is consumed.
    expect(p1.hp).toBeLessThan(500);
    expect(p2.hp).toBeLessThan(500);
    expect(enemy.items!.find((i) => i.itemId === "grenade")!.uses).toBe(0);
    expect(enemy.tu).toBeLessThan(60);
  });

  it("does not throw when no grenade is carried", () => {
    const enemy = makeUnit(5, "enemy", { x: 8, y: 6 }, 2, { items: [] });
    const p1 = makeUnit(1, "player", { x: 13, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30, bravery: 50 },
    });
    const p2 = makeUnit(2, "player", { x: 14, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30, bravery: 50 },
    });
    const state = makeState([enemy, p1, p2]);
    const events = runEnemyTurn(state, makeExec(state));

    // No grenade => no throw or blast events (the enemy may still shoot).
    expect(events.some((e) => e.type === "itemThrown" || e.type === "blastDetonated")).toBe(false);
  });
});
