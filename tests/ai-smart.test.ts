import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile } from "../src/sim/grid";
import { findPath } from "../src/sim/pathfinding";
import { findMode, reloadTuCost, resolveShot, tuCostForMode, coverDefenseFor } from "../src/sim/combat";
import { runEnemyTurn } from "../src/sim/ai";
import { ITEMS } from "../src/sim/content";
import type {
  AiExecutor,
  BattleState,
  BlastHit,
  Dir8,
  Faction,
  GameEvent,
  Grid,
  ShotKind,
  TileType,
  Unit,
  UnitId,
  Vec2,
  Weapon,
} from "../src/sim/types";

// ---------------------------------------------------------------------------
// Helpers (mirror tests/ai.test.ts; add a sandbag tile + a grenade executor)
// ---------------------------------------------------------------------------

const cheb = (a: Vec2, b: Vec2): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A full-cover obstacle you can't enter but can shoot over (sandbags / hedge). */
const SANDBAG: TileType = {
  id: "sandbag",
  label: "Sandbags",
  blocksMove: true,
  blocksSight: false,
  moveCost: 0,
  cover: 2,
  destructible: true,
};

function sandbagGrid(width: number, height: number): Grid {
  // palette: [floor, wall, lowcover, sandbag]
  return makeGrid(width, height, [
    {
      id: "floor",
      label: "Floor",
      blocksMove: false,
      blocksSight: false,
      moveCost: 4,
      cover: 0,
      destructible: false,
    },
    {
      id: "wall",
      label: "Wall",
      blocksMove: true,
      blocksSight: true,
      moveCost: 0,
      cover: 2,
      destructible: true,
    },
    {
      id: "lowcover",
      label: "Low Cover",
      blocksMove: false,
      blocksSight: false,
      moveCost: 6,
      cover: 1,
      destructible: true,
    },
    SANDBAG,
  ]);
}

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
    templateId: "t",
    faction,
    pos,
    facing,
    stats: {
      timeUnits: 60,
      health: 30,
      reactions: 40,
      firingAccuracy: 80,
      strength: 30,
    },
    tu: 60,
    hp: 30,
    weaponId: "rifle",
    ammo: 24,
    alive: true,
    reserve: "none",
    sightRange: 20,
    visionHalfAngleDeg: 60,
    ...overrides,
  };
}

function makeWeapon(overrides: Partial<Weapon> = {}): Weapon {
  return {
    id: "rifle",
    name: "Rifle",
    damage: 20,
    range: 15,
    magazineSize: 24,
    reloadTuPercent: 20,
    modes: [
      { kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 },
      { kind: "aimed", tuPercent: 50, accuracy: 110, shots: 1 },
      { kind: "auto", tuPercent: 35, accuracy: 35, shots: 3 },
    ],
    ...overrides,
  };
}

/**
 * A weapon with no firing modes: the carrier can't shoot, which isolates the
 * move/no-move decision in tests that don't want shooting to spend the TU.
 */
function meleeWeapon(): Weapon {
  return { ...makeWeapon(), id: "melee", name: "Melee", modes: [] };
}

function makeState(
  units: Unit[],
  opts: { weapon?: Weapon; seed?: number; grid?: Grid; items?: boolean } = {},
): BattleState {
  const weapon = opts.weapon ?? makeWeapon();
  return {
    grid: opts.grid ?? makeGrid(30, 12),
    units,
    weapons: { melee: meleeWeapon(), [weapon.id]: weapon },
    items: opts.items ? { ...ITEMS } : undefined,
    turn: 1,
    activeFaction: "enemy",
    rng: new Rng(opts.seed ?? 555),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

/** A minimal executor that mutates state the way the real reducer would. */
function makeExec(state: BattleState): AiExecutor {
  const unitById = (id: UnitId): Unit => {
    const u = state.units.find((x) => x.id === id);
    if (!u) throw new Error(`no unit ${id}`);
    return u;
  };
  return {
    move(unitId, to): GameEvent[] {
      const u = unitById(unitId);
      const blocked = (x: number, y: number) =>
        state.units.some((o) => o.alive && o.id !== unitId && o.pos.x === x && o.pos.y === y);
      const result = findPath(state.grid, u.pos, to, { maxCost: u.tu, isBlocked: blocked });
      if (!result || result.path.length === 0) return [];
      const from = { ...u.pos };
      u.pos = { x: to.x, y: to.y };
      u.tu -= result.cost;
      return [
        {
          type: "moveStep",
          unitId,
          from,
          to: { x: to.x, y: to.y },
          facing: u.facing,
          tuLeft: u.tu,
        },
      ];
    },
    shoot(unitId, target, mode): GameEvent[] {
      const u = unitById(unitId);
      const weapon = state.weapons[u.weaponId];
      if (!weapon) return [];
      const m = findMode(weapon, mode);
      if (!m) return [];
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
        if (cheb(o.pos, center) > radius) continue;
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

// ===========================================================================
// No suicide rush: an alien does NOT walk into an overwatch kill-lane.
// ===========================================================================

describe("smart alien AI -- survival", () => {
  it("does NOT advance into a lane covered by lethal reaction fire (holds instead)", () => {
    // Player at (15,5) faces W with a one-shot-killing overwatch covering the
    // lane. The alien (no firing modes, so it can only move) starts at (8,5).
    // Every tile it could step into is inside the player's cone and would
    // one-shot it, so it must refuse to move rather than suicide-rush.
    const grid = makeGrid(24, 12);
    const enemy = makeUnit(5, "enemy", { x: 8, y: 5 }, 2 /* E */, {
      weaponId: "melee",
      ammo: 24,
    });
    const player = makeUnit(1, "player", { x: 15, y: 5 }, 6 /* W */, {
      hp: 1000,
      stats: {
        timeUnits: 60,
        health: 1000,
        reactions: 90,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const playerWeapon: Weapon = {
      id: "rifle",
      name: "Sniper",
      damage: 100,
      range: 18,
      magazineSize: 24,
      reloadTuPercent: 20,
      modes: [{ kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 }],
    };
    const state = makeState([enemy, player], { weapon: playerWeapon, grid });
    const start = { ...enemy.pos };

    const events = runEnemyTurn(state, makeExec(state));

    expect(events.filter((e) => e.type === "moveStep")).toHaveLength(0);
    expect(enemy.pos).toEqual(start); // did not advance into the kill-lane
    expect(enemy.alive).toBe(true);
  });

  it("contrast: DOES advance toward a player that cannot overwatch it", () => {
    // Same geometry, but the player has negligible reactions and can't afford a
    // snap, so the lane is NOT lethal. The alien presses forward normally --
    // proving the previous test held because the lane was lethal, not because
    // the alien was stuck.
    const grid = makeGrid(24, 12);
    const enemy = makeUnit(5, "enemy", { x: 8, y: 5 }, 2 /* E */, {
      weaponId: "melee",
      ammo: 24,
    });
    const player = makeUnit(1, "player", { x: 15, y: 5 }, 6 /* W */, {
      hp: 1000,
      tu: 0, // can't afford a snap, and low reactions below
      stats: {
        timeUnits: 60,
        health: 1000,
        reactions: 5,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const playerWeapon: Weapon = {
      id: "rifle",
      name: "Sniper",
      damage: 100,
      range: 18,
      magazineSize: 24,
      reloadTuPercent: 20,
      modes: [{ kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 }],
    };
    const state = makeState([enemy, player], { weapon: playerWeapon, grid });

    runEnemyTurn(state, makeExec(state));

    expect(enemy.pos.x).toBeGreaterThan(8); // advanced east, toward the player
  });

  it("a critically-wounded, exposed alien retreats instead of pressing the attack", () => {
    // Alien at 6/30 HP in the open, player ahead with LOW reactions (no
    // overwatch). With no threat of reaction fire, the only reason to move is
    // survival -- and a wounded alien opens the range / breaks line of sight.
    const grid = makeGrid(24, 12);
    const enemy = makeUnit(5, "enemy", { x: 12, y: 5 }, 2 /* E */, {
      weaponId: "melee",
      ammo: 24,
      hp: 6,
      stats: { timeUnits: 60, health: 30, reactions: 40, firingAccuracy: 80, strength: 30 },
    });
    const player = makeUnit(1, "player", { x: 18, y: 5 }, 6 /* W */, {
      hp: 1000,
      stats: {
        timeUnits: 60,
        health: 1000,
        reactions: 5,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const state = makeState([enemy, player], { weapon: makeWeapon(), grid });
    const startDist = cheb(enemy.pos, player.pos);

    runEnemyTurn(state, makeExec(state));

    // Retreated: opened the distance to the threat (moved west, away).
    expect(enemy.pos.x).toBeLessThan(12);
    expect(cheb(enemy.pos, player.pos)).toBeGreaterThan(startDist);
  });

  it("a retreating alien ends on a cover tile when one is reachable", () => {
    // Wounded alien at (10,6), threat due north at (10,2). A sandbag wall at
    // (10,7) grants full directional cover to the tile (10,8) just behind it
    // (the wall sits between (10,8) and the shooter). The alien should fall back
    // onto that covered tile rather than an exposed one.
    const grid = sandbagGrid(20, 14);
    setTile(grid, 10, 7, 3 /* sandbag */);
    const enemy = makeUnit(5, "enemy", { x: 10, y: 6 }, 0 /* N */, {
      weaponId: "melee",
      ammo: 24,
      hp: 6,
      stats: { timeUnits: 60, health: 30, reactions: 40, firingAccuracy: 80, strength: 30 },
    });
    const player = makeUnit(1, "player", { x: 10, y: 2 }, 4 /* S */, {
      hp: 1000,
      stats: {
        timeUnits: 60,
        health: 1000,
        reactions: 5,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const state = makeState([enemy, player], { weapon: makeWeapon(), grid });

    runEnemyTurn(state, makeExec(state));

    expect(coverDefenseFor(grid, enemy.pos, player.pos)).toBe(2); // ended in cover
    expect(enemy.pos.y).toBeGreaterThan(6); // fell back south, away from the threat
  });

  it("a retreating alien reaches a covered tile that is only survivable behind cover under overwatch", () => {
    // Wounded alien under a REAL overwatch (high-reactions player who can always
    // interrupt it). The only survivable retreat is (9,5): the full-cover
    // sandbag at (8,5) sits between it and the shooter, so resolveShot would
    // apply full-cover defense and the shot is survivable there. In the open the
    // same shot is lethal, so reactionDangerAt must honor the mover's cover to
    // keep (9,5) in the search; with cover ignored it is wrongly pruned as a
    // one-shot kill tile and the alien is denied its only safe retreat.
    const grid = sandbagGrid(20, 12);
    setTile(grid, 8, 5, 3 /* sandbag: full cover between (9,5) and the shooter */);
    const enemy = makeUnit(5, "enemy", { x: 9, y: 4 }, 6 /* W */, {
      weaponId: "melee",
      ammo: 24,
      hp: 7,
      stats: { timeUnits: 60, health: 28, reactions: 40, firingAccuracy: 80, strength: 30 },
    });
    const player = makeUnit(1, "player", { x: 2, y: 5 }, 2 /* E */, {
      hp: 1000,
      ammo: 24,
      tu: 60,
      stats: {
        timeUnits: 60,
        health: 1000,
        reactions: 90,
        firingAccuracy: 100,
        strength: 30,
      },
    });
    const playerWeapon: Weapon = {
      id: "rifle",
      name: "Sniper",
      damage: 30,
      range: 15,
      magazineSize: 24,
      reloadTuPercent: 20,
      modes: [{ kind: "snap", tuPercent: 25, accuracy: 60, shots: 1 }],
    };
    const state = makeState([enemy, player], { weapon: playerWeapon, grid });

    runEnemyTurn(state, makeExec(state));

    // Ended on the covered tile (full directional cover from the overwatcher).
    expect(enemy.pos).toEqual({ x: 9, y: 5 });
    expect(coverDefenseFor(grid, enemy.pos, player.pos)).toBe(2);
  });
});

// ===========================================================================
// Grenade discipline: never suicide your own grenade.
// ===========================================================================

describe("smart alien AI -- grenades", () => {
  it("lobs a grenade at a cluster of >=2 players when the thrower ends safe", () => {
    // Open field. Enemy at (8,6) faces east and holds a grenade; two players
    // cluster at (13,6)/(14,6). The blast (radius 2) around them never reaches
    // the thrower 5 tiles away, so the throw is safe and should happen.
    const enemy = makeUnit(5, "enemy", { x: 8, y: 6 }, 2 /* E */, {
      items: [{ itemId: "grenade", uses: 1 }],
    });
    const p1 = makeUnit(1, "player", { x: 13, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30 },
    });
    const p2 = makeUnit(2, "player", { x: 14, y: 6 }, 6, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 40, firingAccuracy: 80, strength: 30 },
    });
    const state = makeState([enemy, p1, p2], { items: true });
    const events = runEnemyTurn(state, makeExec(state));

    expect(events.some((e) => e.type === "itemThrown")).toBe(true);
    expect(events.some((e) => e.type === "blastDetonated")).toBe(true);
    expect(p1.hp).toBeLessThan(500);
    expect(p2.hp).toBeLessThan(500);
  });

  it("does NOT throw when the only blast catching >=2 players would catch the thrower", () => {
    // Two players flank the thrower at (10,5) -- one tile north and one tile
    // south. Every centre that catches both also sits within the blast radius
    // of the thrower itself, so a throw would suicide. The alien holds it.
    const enemy = makeUnit(5, "enemy", { x: 10, y: 5 }, 0 /* N */, {
      items: [{ itemId: "grenade", uses: 1 }],
      visionHalfAngleDeg: 180, // sees both flanking players
    });
    const p1 = makeUnit(1, "player", { x: 10, y: 4 }, 4 /* S */, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 5, firingAccuracy: 80, strength: 30 },
    });
    const p2 = makeUnit(2, "player", { x: 10, y: 6 }, 0 /* N */, {
      hp: 500,
      stats: { timeUnits: 60, health: 500, reactions: 5, firingAccuracy: 80, strength: 30 },
    });
    const state = makeState([enemy, p1, p2], { items: true });
    const events = runEnemyTurn(state, makeExec(state));

    expect(events.some((e) => e.type === "itemThrown" || e.type === "blastDetonated")).toBe(false);
    expect(enemy.items!.find((i) => i.itemId === "grenade")!.uses).toBe(1); // grenade kept
    expect(enemy.alive).toBe(true); // did not suicide
  });
});

// ===========================================================================
// Determinism: identical state + executor => identical event stream.
// ===========================================================================

describe("smart alien AI -- determinism", () => {
  it("identical states produce identical event streams", () => {
    const build = (): BattleState => {
      const grid = sandbagGrid(20, 14);
      setTile(grid, 6, 5, 3);
      setTile(grid, 12, 7, 3);
      const e1 = makeUnit(5, "enemy", { x: 4, y: 6 }, 2, {
        items: [{ itemId: "grenade", uses: 1 }],
        hp: 14,
      });
      const e2 = makeUnit(6, "enemy", { x: 9, y: 9 }, 0, { hp: 5 });
      const p1 = makeUnit(1, "player", { x: 15, y: 6 }, 6, {
        hp: 400,
        stats: { timeUnits: 60, health: 400, reactions: 40, firingAccuracy: 80, strength: 30 },
      });
      const p2 = makeUnit(2, "player", { x: 14, y: 8 }, 0, {
        hp: 400,
        stats: { timeUnits: 60, health: 400, reactions: 40, firingAccuracy: 80, strength: 30 },
        items: [{ itemId: "grenade", uses: 1 }],
      });
      return makeState([e1, e2, p1, p2], { items: true, grid, seed: 31337 });
    };
    const a = build();
    const ea = runEnemyTurn(a, makeExec(a));
    const b = build();
    const eb = runEnemyTurn(b, makeExec(b));
    expect(ea).toEqual(eb);
  });
});
