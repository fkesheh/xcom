/**
 * Variety slice: new weapons (cannon, sniper) and enemy templates (heavy,
 * stalker, commander) are registered with the agreed stats, spawn through the
 * real scenario builder, and the generic utility AI fires both new weapons
 * without any special-casing. Every scenario is deterministic.
 */

import { describe, it, expect } from "vitest";
import type {
  AiExecutor,
  BattleState,
  Dir8,
  GameEvent,
  ShotKind,
  Unit,
  UnitId,
  UnitTemplate,
  Vec2,
  Weapon,
} from "../src/sim/types";
import { Rng } from "../src/sim/rng";
import { makeGrid } from "../src/sim/grid";
import { findPath } from "../src/sim/pathfinding";
import { findMode, reloadTuCost, resolveShot, tuCostForMode } from "../src/sim/combat";
import { runEnemyTurn } from "../src/sim/ai";
import { createSkirmish } from "../src/sim/setup";
import { ITEMS, TEMPLATES, WEAPONS } from "../src/sim/content";

/** Look up a weapon, narrowing away the Record's `| undefined`. */
function weapon(id: string): Weapon {
  const w = WEAPONS[id];
  if (!w) throw new Error(`missing weapon ${id}`);
  return w;
}

/** Look up a template, narrowing away the Record's `| undefined`. */
function template(id: string): UnitTemplate {
  const t = TEMPLATES[id];
  if (!t) throw new Error(`missing template ${id}`);
  return t;
}

/** Look up a firing mode, narrowing away `undefined`. */
function mode(weaponDef: Weapon, kind: ShotKind) {
  const m = findMode(weaponDef, kind);
  if (!m) throw new Error(`weapon ${weaponDef.id} has no ${kind} mode`);
  return m;
}

/**
 * Instantiate a live unit from a template exactly the way setup.spawnUnit does:
 * full TU/HP, a loaded magazine, and the template's carried items. Proves each
 * new template produces a valid, armed, AI-drivable unit.
 */
function unitFromTemplate(
  id: UnitId,
  tpl: UnitTemplate,
  pos: Vec2,
  facing: Dir8,
  name: string = tpl.name,
): Unit {
  const w = WEAPONS[tpl.weaponId];
  return {
    id,
    name,
    templateId: tpl.id,
    faction: tpl.faction,
    pos: { x: pos.x, y: pos.y },
    facing,
    stats: { ...tpl.stats },
    tu: tpl.stats.timeUnits,
    hp: tpl.stats.health,
    morale: 100,
    items: (tpl.items ?? []).map((itemId) => ({
      itemId,
      uses: itemId === "medkit" ? 3 : 1,
    })),
    weaponId: tpl.weaponId,
    ammo: w?.magazineSize ?? 0,
    alive: true,
    reserve: "none",
    stance: "stand",
    sightRange: tpl.sightRange,
    visionHalfAngleDeg: tpl.visionHalfAngleDeg,
  };
}

/** Open-grid battle state with the supplied units + weapon registry. */
function makeState(
  units: Unit[],
  weapons: Record<string, Weapon>,
  seed = 555,
): BattleState {
  return {
    grid: makeGrid(30, 12),
    units,
    weapons,
    items: { ...ITEMS },
    turn: 1,
    activeFaction: "enemy",
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

/** Minimal executor that mutates state like the real reducer. */
function makeExec(state: BattleState): AiExecutor {
  const unitById = (id: UnitId): Unit => {
    const u = state.units.find((x) => x.id === id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  };
  return {
    move(unitId: UnitId, to: Vec2): GameEvent[] {
      const u = unitById(unitId);
      const blocked = (x: number, y: number) =>
        state.units.some(
          (o) => o.alive && o.id !== unitId && o.pos.x === x && o.pos.y === y,
        );
      const result = findPath(state.grid, u.pos, to, { maxCost: u.tu, isBlocked: blocked });
      if (!result || result.path.length === 0) return [];
      const from = { ...u.pos };
      u.pos = { x: to.x, y: to.y };
      u.tu -= result.cost;
      return [
        { type: "moveStep", unitId, from, to: { x: to.x, y: to.y }, facing: u.facing, tuLeft: u.tu },
      ];
    },
    shoot(unitId: UnitId, target: Vec2, kind: ShotKind): GameEvent[] {
      const u = unitById(unitId);
      const w = state.weapons[u.weaponId];
      if (!w) return [];
      const m = findMode(w, kind);
      if (!m) return [];
      u.tu -= tuCostForMode(u, m);
      u.ammo = Math.max(0, u.ammo - m.shots);
      const res = resolveShot(state, u, target, kind);
      return [
        {
          type: "shot",
          shooterId: unitId,
          targetId: res.targetId,
          targetPos: { x: target.x, y: target.y },
          originPos: { x: u.pos.x, y: u.pos.y },
          mode: kind,
          rounds: res.rounds,
          tuLeft: u.tu,
          reaction: false,
        },
      ];
    },
    reload(unitId: UnitId): GameEvent[] {
      const u = unitById(unitId);
      const w = state.weapons[u.weaponId];
      if (!w) return [];
      const cost = reloadTuCost(u, w);
      if (u.tu < cost || u.ammo >= w.magazineSize) return [];
      u.tu -= cost;
      u.ammo = w.magazineSize;
      return [{ type: "reloaded", unitId, ammo: u.ammo, tuLeft: u.tu }];
    },
    face(unitId: UnitId, dir: Dir8): GameEvent[] {
      const u = unitById(unitId);
      u.facing = dir;
      return [{ type: "faced", unitId, dir, tuLeft: u.tu }];
    },
  };
}

describe("new weapons", () => {
  it("cannon is a short-range, low-accuracy, high-TU heavy hitter", () => {
    const cannon = weapon("cannon");
    expect(cannon.damage).toBe(45);
    expect(cannon.range).toBeLessThanOrEqual(8); // short range
    expect(cannon.magazineSize).toBeGreaterThanOrEqual(1);

    const snap = mode(cannon, "snap");
    expect(snap.accuracy).toBeLessThan(55); // low accuracy
    expect(snap.tuPercent).toBeGreaterThan(40); // high TU cost

    // Distinct from the existing plasma: more damage, much shorter range.
    const plasma = weapon("plasma");
    expect(cannon.damage).toBeGreaterThan(plasma.damage);
    expect(cannon.range).toBeLessThan(plasma.range);
  });

  it("sniper is a long-range, very-high-accuracy, very-high-TU precision tool", () => {
    const sniper = weapon("sniper");
    expect(sniper.damage).toBeGreaterThanOrEqual(40);
    expect(sniper.range).toBeGreaterThanOrEqual(18); // long range

    const aimed = mode(sniper, "aimed");
    expect(aimed.accuracy).toBeGreaterThan(120); // very high accuracy multiplier
    expect(aimed.tuPercent).toBeGreaterThan(70); // very high TU cost

    // Distinct from plasma: longer range and a far sharper aimed mode.
    const plasma = weapon("plasma");
    expect(sniper.range).toBeGreaterThan(plasma.range);
    const plasmaAimed = mode(plasma, "aimed");
    expect(aimed.accuracy).toBeGreaterThan(plasmaAimed.accuracy);
  });
});

describe("new enemy templates", () => {
  it("heavy is a high-HP, slow tank carrying the cannon", () => {
    const heavy = template("heavy");
    expect(heavy.faction).toBe("enemy");
    expect(heavy.stats.health).toBe(80);
    expect(heavy.stats.timeUnits).toBeLessThan(50); // slow
    expect(heavy.weaponId).toBe("cannon");
    expect(WEAPONS[heavy.weaponId]).toBeDefined();
  });

  it("stalker is a fast, fragile glass cannon with high reactions and the sniper", () => {
    const stalker = template("stalker");
    expect(stalker.faction).toBe("enemy");
    expect(stalker.stats.health).toBe(20); // lowest enemy HP
    expect(stalker.stats.timeUnits).toBeGreaterThan(65); // fast
    expect(stalker.stats.reactions).toBeGreaterThan(60); // sharp reactions
    expect(stalker.weaponId).toBe("sniper");
    expect(WEAPONS[stalker.weaponId]).toBeDefined();
  });

  it("commander is a steady, high-bravery priority target with a grenade", () => {
    const commander = template("commander");
    expect(commander.faction).toBe("enemy");
    expect(commander.stats.health).toBe(50);
    expect(commander.stats.reactions).toBeGreaterThan(70);
    expect(commander.stats.bravery).toBeGreaterThanOrEqual(90); // top of roster
    expect(commander.weaponId).toBe("plasma");
    expect(commander.items).toContain("grenade");
    expect(WEAPONS[commander.weaponId]).toBeDefined();
  });

  it("every new template has a distinct stat profile and a resolvable weapon", () => {
    const ids = ["heavy", "stalker", "commander"];
    const profiles = new Set<string>();
    for (const id of ids) {
      const tpl = template(id);
      expect(WEAPONS[tpl.weaponId], `${id}'s weapon must resolve`).toBeDefined();
      const key = `${tpl.stats.health}hp/${tpl.stats.timeUnits}tu/${tpl.weaponId}`;
      expect(profiles.has(key), `duplicate profile ${key}`).toBe(false);
      profiles.add(key);
    }
  });
});

describe("createSkirmish spawns the new content", () => {
  it("registers the new weapons in the battle weapon registry", () => {
    const state = createSkirmish({ seed: 7 });
    expect(state.weapons.cannon).toBe(WEAPONS.cannon);
    expect(state.weapons.sniper).toBe(WEAPONS.sniper);
  });

  it("deploys players carrying the cannon and sniper with full magazines", () => {
    const state = createSkirmish({
      seed: 42,
      players: 2,
      enemies: 0,
      playerWeaponIds: ["cannon", "sniper"],
    });
    const players = state.units.filter((u) => u.faction === "player");
    expect(players).toHaveLength(2);
    expect(players[0]!.weaponId).toBe("cannon");
    expect(players[0]!.ammo).toBe(WEAPONS.cannon!.magazineSize);
    expect(players[1]!.weaponId).toBe("sniper");
    expect(players[1]!.ammo).toBe(WEAPONS.sniper!.magazineSize);
  });

  it("can arm every new template from the battle weapon registry", () => {
    const state = createSkirmish({ seed: 99 });
    for (const id of ["heavy", "stalker", "commander"]) {
      const tpl = template(id);
      expect(state.weapons[tpl.weaponId], `${id}'s weapon must be in the registry`).toBeDefined();
    }
  });
});

describe("AI fires the new weapons (generic scoring, no special-casing)", () => {
  it("a heavy fires the cannon at a visible player in range", () => {
    const heavy = unitFromTemplate(2, template("heavy"), { x: 10, y: 5 }, 6 /* W */);
    const player = unitFromTemplate(1, template("trooper"), { x: 5, y: 5 }, 2);
    player.hp = 1000; // soak the hit so the engagement continues
    const state = makeState([heavy, player], {
      rifle: weapon("rifle"),
      cannon: weapon("cannon"),
    });

    const events = runEnemyTurn(state, makeExec(state));
    const shots = events.filter((e) => e.type === "shot");

    expect(shots.length).toBeGreaterThanOrEqual(1);
    const first = shots[0]!;
    expect(first.type).toBe("shot");
    expect(first.shooterId).toBe(2);
    // The cannon's magazine was tapped and TU was spent.
    expect(heavy.ammo).toBeLessThan(WEAPONS.cannon!.magazineSize);
    expect(heavy.tu).toBeLessThan(template("heavy").stats.timeUnits);
  });

  it("a stalker fires the sniper at long range", () => {
    const stalker = unitFromTemplate(2, template("stalker"), { x: 20, y: 5 }, 6 /* W */);
    const player = unitFromTemplate(1, template("trooper"), { x: 5, y: 5 }, 2);
    player.hp = 1000;
    const state = makeState([stalker, player], {
      rifle: weapon("rifle"),
      sniper: weapon("sniper"),
    });

    const events = runEnemyTurn(state, makeExec(state));
    const shots = events.filter((e) => e.type === "shot");

    expect(shots.length).toBeGreaterThanOrEqual(1);
    expect(stalker.ammo).toBeLessThan(WEAPONS.sniper!.magazineSize);
    expect(stalker.tu).toBeLessThan(template("stalker").stats.timeUnits);
  });

  it("is deterministic: identical seeds produce identical event streams", () => {
    const build = (): BattleState => {
      const heavy = unitFromTemplate(2, template("heavy"), { x: 10, y: 5 }, 6);
      const player = unitFromTemplate(1, template("trooper"), { x: 5, y: 5 }, 2);
      player.hp = 1000;
      return makeState([heavy, player], { rifle: weapon("rifle"), cannon: weapon("cannon") }, 31337);
    };
    const a = build();
    const ea = runEnemyTurn(a, makeExec(a));
    const b = build();
    const eb = runEnemyTurn(b, makeExec(b));
    expect(ea).toEqual(eb);
  });
});
