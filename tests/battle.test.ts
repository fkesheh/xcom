import { describe, it, expect } from "vitest";
import { Rng } from "../src/sim/rng";
import { makeGrid, setTile, WALL } from "../src/sim/grid";
import {
  applyCommand,
  canRecoverObjective,
  canExtractObjective,
  checkVictory,
  executeFace,
  executeMove,
  executeReload,
  executeRecoverObjective,
  executeShoot,
  livingUnits,
  previewPlayerShot,
  unitAt,
  unitById,
} from "../src/sim/battle";
import { createSkirmish } from "../src/sim/setup";
import { canSee, visibleEnemyIds } from "../src/sim/los";
import { TEMPLATES, WEAPONS } from "../src/sim/content";
import type {
  BattleState,
  Command,
  Dir8,
  Faction,
  GameEvent,
  Unit,
  UnitId,
  Vec2,
} from "../src/sim/types";

function unitFromTemplate(
  id: UnitId,
  templateId: string,
  pos: Vec2,
  facing: Dir8,
  overrides: Partial<Unit> = {},
): Unit {
  const tpl = TEMPLATES[templateId]!;
  return {
    id,
    name: `u${id}`,
    templateId: tpl.id,
    faction: tpl.faction,
    pos,
    facing,
    stats: { ...tpl.stats },
    tu: tpl.stats.timeUnits,
    hp: tpl.stats.health,
    weaponId: tpl.weaponId,
    ammo: WEAPONS[tpl.weaponId]?.magazineSize ?? 0,
    alive: true,
    reserve: "none",
    sightRange: tpl.sightRange,
    visionHalfAngleDeg: tpl.visionHalfAngleDeg,
    ...overrides,
  };
}

function openBattle(units: Unit[], seed = 1, activeFaction: Faction = "player"): BattleState {
  return {
    grid: makeGrid(24, 24),
    units,
    weapons: WEAPONS,
    turn: 1,
    activeFaction,
    rng: new Rng(seed),
    status: "playing",
    explored: new Set<number>(),
    log: [],
  };
}

describe("queries", () => {
  it("unitById / unitAt / livingUnits", () => {
    const a = unitFromTemplate(1, "trooper", { x: 2, y: 2 }, 0);
    const dead = unitFromTemplate(2, "drone", { x: 5, y: 5 }, 0, { alive: false });
    const state = openBattle([a, dead]);
    expect(unitById(state, 1)).toBe(a);
    expect(unitAt(state, { x: 2, y: 2 })).toBe(a);
    expect(unitAt(state, { x: 5, y: 5 })).toBeUndefined(); // dead doesn't occupy
    expect(livingUnits(state, "player")).toEqual([a]);
    expect(livingUnits(state, "enemy")).toEqual([]);
  });
});

describe("TU accounting", () => {
  it("deducts a single orthogonal step's move cost", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const far = unitFromTemplate(2, "drone", { x: 23, y: 23 }, 6); // out of sight: no reactions
    const state = openBattle([p, far]);

    const events = applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 5 } });
    const steps = events.filter((e) => e.type === "moveStep");
    expect(steps).toHaveLength(1);
    expect(p.pos).toEqual({ x: 6, y: 5 });
    // floor terrain costs 4 TU to enter; trooper starts at 60.
    expect(p.tu).toBe(56);
  });

  it("deducts a snap shot's TU and can hit a target", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4);
    const target = unitFromTemplate(2, "drone", { x: 5, y: 8 }, 0, { hp: 1000 });
    const state = openBattle([shooter, target], 12345);

    const events = applyCommand(state, {
      type: "shoot",
      unitId: 1,
      target: { x: 5, y: 8 },
      mode: "snap",
    });
    const shots = events.filter((e) => e.type === "shot");
    expect(shots).toHaveLength(1);
    // snap on rifle = 25% of 60 TU = 15.
    expect(shooter.tu).toBe(45);
  });

  it("charges the cyclic rotation cost for facing changes", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const state = openBattle([p]);
    const events = executeFace(state, 1, 2 /* E: two 45-degree steps */);
    expect(events[0]?.type).toBe("faced");
    expect(p.facing).toBe(2);
    expect(p.tu).toBe(58);
  });

  it("blocks an action the unit cannot afford", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0, { tu: 1 });
    const state = openBattle([p]);
    const events = executeFace(state, 1, 4 /* S: 4 steps, costs 4 > 1 TU */);
    expect(events).toEqual([{ type: "blocked", reason: "not enough TU" }]);
    expect(p.facing).toBe(0);
    expect(p.tu).toBe(1);
  });
});

describe("ammo and reloads", () => {
  it("spends ammunition when shooting and reloads to a full magazine", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4, { ammo: 1 });
    const target = unitFromTemplate(2, "drone", { x: 5, y: 8 }, 0, { hp: 1000 });
    const state = openBattle([shooter, target], 12345);
    const weapon = WEAPONS[shooter.weaponId]!;
    const reloadCost = Math.ceil((shooter.stats.timeUnits * weapon.reloadTuPercent) / 100);

    const shot = applyCommand(state, { type: "shoot", unitId: 1, target: target.pos, mode: "snap" });
    expect(shot.some((event) => event.type === "shot")).toBe(true);
    expect(shooter.ammo).toBe(0);

    const blocked = applyCommand(state, { type: "shoot", unitId: 1, target: target.pos, mode: "snap" });
    expect(blocked).toEqual([{ type: "blocked", reason: "empty magazine" }]);

    const beforeReloadTu = shooter.tu;
    const reload = applyCommand(state, { type: "reload", unitId: 1 });
    expect(reload).toEqual([
      {
        type: "reloaded",
        unitId: 1,
        ammo: weapon.magazineSize,
        tuLeft: beforeReloadTu - reloadCost,
      },
    ]);
    expect(shooter.ammo).toBe(weapon.magazineSize);
    expect(shooter.tu).toBe(beforeReloadTu - reloadCost);
  });

  it("blocks reloads when the magazine is full or TU is insufficient", () => {
    const full = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4);
    const tired = unitFromTemplate(2, "trooper", { x: 6, y: 5 }, 4, { ammo: 0, tu: 1 });
    const state = openBattle([full, tired]);

    expect(executeReload(state, 1)).toEqual([{ type: "blocked", reason: "magazine full" }]);
    expect(executeReload(state, 2)).toEqual([{ type: "blocked", reason: "not enough TU" }]);
  });
});

describe("deliberate fire target validation", () => {
  it("blocks blind fire at an unseen hostile without spending TU or ammo", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const hidden = unitFromTemplate(2, "drone", { x: 6, y: 5 }, 6 /* W */, { ammo: 0 });
    const state = openBattle([shooter, hidden]);

    expect(canSee(state.grid, shooter, hidden.pos)).toBe(false);

    const events = executeShoot(state, shooter.id, hidden.pos, "snap");
    const preview = previewPlayerShot(state, shooter.id, hidden.pos, "snap");

    expect(events).toEqual([{ type: "blocked", reason: "no visible hostile" }]);
    expect(preview).toMatchObject({ possible: false, reason: "no visible hostile" });
    expect(shooter.tu).toBe(shooter.stats.timeUnits);
    expect(shooter.ammo).toBe(WEAPONS[shooter.weaponId]!.magazineSize);
    expect(hidden.hp).toBe(hidden.stats.health);
  });

  it("blocks deliberate friendly fire as an invalid target", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2 /* E */);
    const ally = unitFromTemplate(2, "trooper", { x: 6, y: 5 }, 6 /* W */);
    const state = openBattle([shooter, ally]);

    const events = applyCommand(state, { type: "shoot", unitId: shooter.id, target: ally.pos, mode: "snap" });
    const preview = previewPlayerShot(state, shooter.id, ally.pos, "snap");

    expect(events).toEqual([{ type: "blocked", reason: "friendly target" }]);
    expect(preview).toMatchObject({ possible: false, reason: "friendly target" });
    expect(shooter.tu).toBe(shooter.stats.timeUnits);
    expect(shooter.ammo).toBe(WEAPONS[shooter.weaponId]!.magazineSize);
    expect(ally.hp).toBe(ally.stats.health);
  });

  it("allows a shot at a hostile spotted by another squad member", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const spotter = unitFromTemplate(2, "trooper", { x: 4, y: 5 }, 2 /* E */);
    const spotted = unitFromTemplate(3, "drone", { x: 6, y: 5 }, 6 /* W */, { hp: 1000 });
    const state = openBattle([shooter, spotter, spotted], 12345);

    expect(canSee(state.grid, shooter, spotted.pos)).toBe(false);
    expect(canSee(state.grid, spotter, spotted.pos)).toBe(true);
    expect(visibleEnemyIds(state, "player").has(spotted.id)).toBe(true);

    const preview = previewPlayerShot(state, shooter.id, spotted.pos, "snap");
    const events = executeShoot(state, shooter.id, spotted.pos, "snap");

    expect(preview.possible).toBe(true);
    expect(events.some((event) => event.type === "shot")).toBe(true);
    expect(shooter.tu).toBe(45);
    expect(shooter.ammo).toBe(WEAPONS[shooter.weaponId]!.magazineSize - 1);
  });
});

describe("turn ownership", () => {
  it("rejects player commands during the enemy turn", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([p, e], 1, "enemy");
    const events = applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 5 } });
    expect(events).toEqual([{ type: "blocked", reason: "not your turn" }]);
    expect(p.pos).toEqual({ x: 5, y: 5 });
    expect(p.tu).toBe(60);
  });

  it("rejects commands targeting a non-player or dead unit", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 8, y: 5 }, 6);
    const state = openBattle([p, e]);
    expect(applyCommand(state, { type: "face", unitId: 2, dir: 0 })).toEqual([
      { type: "blocked", reason: "invalid unit" },
    ]);
  });
});

describe("victory", () => {
  it("checkVictory fires once when a side is wiped out", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 8, y: 5 }, 6, { alive: false });
    const state = openBattle([p, e]);
    const first = checkVictory(state);
    expect(first).toEqual({ type: "gameOver", status: "player_win" });
    expect(state.status).toBe("player_win");
    // Already decided => no second event.
    expect(checkVictory(state)).toBeNull();
  });

  it("a lethal player shot emits died + gameOver and ends the game", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4);
    const target = unitFromTemplate(2, "drone", { x: 5, y: 6 }, 0, { hp: 1 });
    const state = openBattle([shooter, target], 4242);

    const allEvents: GameEvent[] = [];
    let guard = 0;
    while (state.status === "playing" && guard < 100) {
      shooter.tu = shooter.stats.timeUnits; // refill so we can keep firing
      allEvents.push(...executeShoot(state, 1, { x: 5, y: 6 }, "aimed"));
      guard++;
    }
    expect(state.status).toBe("player_win");
    expect(allEvents.some((e) => e.type === "died" && e.unitId === 2)).toBe(true);
    expect(allEvents.some((e) => e.type === "gameOver" && e.status === "player_win")).toBe(true);
    expect(livingUnits(state, "enemy")).toEqual([]);

    // Post-victory commands are rejected.
    expect(applyCommand(state, { type: "endTurn" })).toEqual([
      { type: "blocked", reason: "game over" },
    ]);
  });

  it("recovers the UFO objective from an adjacent tile, then wins after extraction", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([p, e]);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 7, y: 5 },
      recovered: false,
      extracted: false,
      extractionZone: [{ x: 3, y: 5 }],
    };

    const recovered = applyCommand(state, { type: "move", unitId: 1, to: { x: 6, y: 5 } });

    expect(state.objective.recovered).toBe(true);
    expect(state.objective.extracted).toBe(false);
    expect(state.objective.recoveredBy).toBe(1);
    expect(state.status).toBe("playing");
    expect(livingUnits(state, "enemy")).toEqual([e]);
    expect(recovered.some((event) => event.type === "objectiveRecovered" && event.unitId === 1)).toBe(true);
    expect(recovered.some((event) => event.type === "gameOver")).toBe(false);
    expect(canExtractObjective(state, p)).toBe(false);

    const extracted = applyCommand(state, { type: "move", unitId: 1, to: { x: 3, y: 5 } });
    expect(state.objective.extracted).toBe(true);
    expect(state.status).toBe("player_win");
    expect(extracted.some((event) => event.type === "objectiveExtracted" && event.unitId === 1)).toBe(true);
    expect(extracted.at(-1)).toEqual({ type: "gameOver", status: "player_win" });
  });

  it("extracts as soon as the core carrier enters the dropship zone mid-path", () => {
    const carrier = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([carrier, e]);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 12, y: 12 },
      recovered: true,
      extracted: false,
      recoveredBy: 1,
      extractionZone: [{ x: 7, y: 5 }],
    };

    const events = applyCommand(state, { type: "move", unitId: 1, to: { x: 10, y: 5 } });

    expect(carrier.pos).toEqual({ x: 7, y: 5 });
    expect(state.objective.extracted).toBe(true);
    expect(state.status).toBe("player_win");
    expect(events.some((event) => event.type === "objectiveExtracted" && event.unitId === 1)).toBe(true);
    expect(events.at(-1)).toEqual({ type: "gameOver", status: "player_win" });
  });

  it("does not extract when a non-carrier enters the dropship zone", () => {
    const carrier = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const scout = unitFromTemplate(2, "trooper", { x: 6, y: 4 }, 4);
    const e = unitFromTemplate(3, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([carrier, scout, e]);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 12, y: 12 },
      recovered: true,
      extracted: false,
      recoveredBy: 1,
      extractionZone: [{ x: 6, y: 5 }],
    };

    const events = applyCommand(state, { type: "move", unitId: 2, to: { x: 6, y: 5 } });

    expect(scout.pos).toEqual({ x: 6, y: 5 });
    expect(canExtractObjective(state, scout)).toBe(false);
    expect(state.objective.extracted).toBe(false);
    expect(state.status).toBe("playing");
    expect(events.some((event) => event.type === "objectiveExtracted")).toBe(false);
  });

  it("can explicitly recover the UFO objective when already adjacent", () => {
    const p = unitFromTemplate(1, "trooper", { x: 6, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([p, e]);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 7, y: 5 },
      recovered: false,
      extracted: false,
      extractionZone: [{ x: 3, y: 5 }],
    };

    const events = applyCommand(state, { type: "recoverObjective", unitId: 1 });

    expect(canRecoverObjective(state, p)).toBe(false);
    expect(state.objective.recovered).toBe(true);
    expect(state.objective.extracted).toBe(false);
    expect(state.objective.recoveredBy).toBe(1);
    expect(p.pos).toEqual({ x: 6, y: 5 });
    expect(p.tu).toBe(p.stats.timeUnits);
    expect(state.status).toBe("playing");
    expect(events).toEqual([
      {
        type: "objectiveRecovered",
        unitId: 1,
        label: "Recover UFO power source",
        target: { x: 7, y: 5 },
      },
    ]);
  });

  it("blocks explicit objective recovery while out of reach", () => {
    const p = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 20, y: 20 }, 6);
    const state = openBattle([p, e]);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 7, y: 5 },
      recovered: false,
      extracted: false,
      extractionZone: [{ x: 3, y: 5 }],
    };

    expect(executeRecoverObjective(state, 1)).toEqual([{ type: "blocked", reason: "objective out of reach" }]);
    expect(state.objective.recovered).toBe(false);
    expect(state.status).toBe("playing");
  });

  it("drops the carried UFO core when the carrier is killed", () => {
    const carrier = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 2, { hp: 1 });
    const shooter = unitFromTemplate(2, "drone", { x: 5, y: 6 }, 0, {
      stats: { ...TEMPLATES.drone!.stats, firingAccuracy: 100 },
    });
    const backup = unitFromTemplate(3, "trooper", { x: 3, y: 5 }, 2);
    const state = openBattle([carrier, shooter, backup], 4242);
    state.objective = {
      kind: "recover",
      label: "Recover UFO power source",
      target: { x: 7, y: 5 },
      recovered: true,
      extracted: false,
      recoveredBy: 1,
      extractionZone: [{ x: 3, y: 5 }],
    };

    const events = executeShoot(state, 2, carrier.pos, "snap");

    expect(carrier.alive).toBe(false);
    expect(state.objective.recovered).toBe(false);
    expect(state.objective.recoveredBy).toBeUndefined();
    expect(state.objective.target).toEqual({ x: 5, y: 5 });
    expect(state.status).toBe("playing");
    expect(events.some((event) => event.type === "objectiveDropped" && event.unitId === 1)).toBe(true);
  });
});

describe("shot origin (corner peek)", () => {
  it("a direct shot originates from the shooter's own tile", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 4 /* S */);
    const target = unitFromTemplate(2, "drone", { x: 5, y: 8 }, 0, { hp: 1000 });
    const state = openBattle([shooter, target], 12345);

    const events = executeShoot(state, 1, { x: 5, y: 8 }, "snap");
    const shot = events.find((e) => e.type === "shot");
    expect(shot?.type).toBe("shot");
    if (shot?.type === "shot") {
      expect(shot.originPos).toEqual({ x: 5, y: 5 });
    }
  });

  it("a peek shot originates from the lean tile beside hugged cover", () => {
    const shooter = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const target = unitFromTemplate(2, "drone", { x: 5, y: 3 }, 4, { hp: 1000 });
    const state = openBattle([shooter, target], 12345);
    // Wall hugged directly between shooter and target: the direct line is
    // blocked, so the shot leans to the closest open side (NE -> (6,4)).
    setTile(state.grid, 5, 4, WALL);

    const events = executeShoot(state, 1, { x: 5, y: 3 }, "snap");
    const shot = events.find((e) => e.type === "shot");
    expect(shot?.type).toBe("shot");
    if (shot?.type === "shot") {
      expect(shot.originPos).toEqual({ x: 6, y: 4 });
    }
  });
});

describe("enemy turn handover", () => {
  it("endTurn runs the AI and returns control with a new round", () => {
    const state = createSkirmish({ seed: 2024 });
    const events = applyCommand(state, { type: "endTurn" });

    expect(events[0]).toEqual({ type: "turnEnded", faction: "player" });
    expect(events.some((e) => e.type === "turnStarted" && e.faction === "enemy")).toBe(true);

    if (state.status === "playing") {
      expect(state.turn).toBe(2);
      expect(state.activeFaction).toBe("player");
      const last = events[events.length - 1];
      expect(last).toEqual({ type: "turnStarted", faction: "player", turn: 2 });
      // Player TU refilled for the new round.
      for (const u of livingUnits(state, "player")) {
        expect(u.tu).toBe(u.stats.timeUnits);
      }
    }
  });
});

describe("determinism", () => {
  it("same seed + identical command script => identical state and events", () => {
    function run(): { state: BattleState; events: ReturnType<typeof applyCommand> } {
      const state = createSkirmish({ seed: 987654, players: 3, enemies: 2 });
      const p1 = unitById(state, 1)!;
      const p2 = unitById(state, 2)!;
      const commands: Command[] = [
        { type: "move", unitId: 1, to: { x: p1.pos.x + 1, y: p1.pos.y } },
        { type: "face", unitId: 2, dir: 2 },
        { type: "shoot", unitId: 1, target: { x: p2.pos.x, y: p2.pos.y + 2 }, mode: "snap" },
        { type: "endTurn" },
      ];
      const events = commands.flatMap((c) => applyCommand(state, c));
      return { state, events };
    }

    const a = run();
    const b = run();

    expect(a.events).toEqual(b.events);
    expect(a.state.units).toEqual(b.state.units);
    expect(a.state.turn).toBe(b.state.turn);
    expect(a.state.status).toBe(b.state.status);
    expect(a.state.rng.state).toBe(b.state.rng.state);
  });
});

describe("destination occupancy", () => {
  it("does not reject an unseen hostile destination until contact is made", () => {
    const scout = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const hidden = unitFromTemplate(2, "drone", { x: 6, y: 5 }, 6 /* W */, { ammo: 0 });
    const state = openBattle([scout, hidden]);

    expect(canSee(state.grid, scout, hidden.pos)).toBe(false);

    const events = applyCommand(state, { type: "move", unitId: 1, to: hidden.pos });

    expect(events).toEqual([{ type: "blocked", reason: "hostile contact" }]);
    expect(scout.pos).toEqual({ x: 5, y: 5 });
    expect(scout.facing).toBe(2);
    expect(canSee(state.grid, scout, hidden.pos)).toBe(true);
    expect(unitAt(state, hidden.pos)).toBe(hidden);
  });

  it("advances toward an unseen hostile and stops before entering its tile", () => {
    const scout = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const hidden = unitFromTemplate(2, "drone", { x: 7, y: 5 }, 6 /* W */, { ammo: 0 });
    const state = openBattle([scout, hidden]);

    expect(canSee(state.grid, scout, hidden.pos)).toBe(false);

    const events = applyCommand(state, { type: "move", unitId: 1, to: hidden.pos });

    expect(events.filter((event) => event.type === "moveStep")).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "blocked", reason: "hostile contact" });
    expect(scout.pos).toEqual({ x: 6, y: 5 });
    expect(scout.facing).toBe(2);
    expect(canSee(state.grid, scout, hidden.pos)).toBe(true);
    expect(unitAt(state, hidden.pos)).toBe(hidden);
  });

  it("treats enemies seen by any squad member as known movement blockers", () => {
    const mover = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0 /* N */);
    const spotter = unitFromTemplate(2, "trooper", { x: 4, y: 5 }, 2 /* E */);
    const spotted = unitFromTemplate(3, "drone", { x: 6, y: 5 }, 6 /* W */, { ammo: 0 });
    const state = openBattle([mover, spotter, spotted]);

    expect(canSee(state.grid, mover, spotted.pos)).toBe(false);
    expect(canSee(state.grid, spotter, spotted.pos)).toBe(true);
    expect(visibleEnemyIds(state, "player").has(spotted.id)).toBe(true);

    const events = applyCommand(state, { type: "move", unitId: mover.id, to: spotted.pos });

    expect(events).toEqual([{ type: "blocked", reason: "occupied" }]);
    expect(mover.pos).toEqual({ x: 5, y: 5 });
    expect(mover.facing).toBe(0);
    expect(unitAt(state, spotted.pos)).toBe(spotted);
  });

  it("refuses to move onto a tile held by a friendly unit (no stacking)", () => {
    const u = unitFromTemplate(1, "trooper", { x: 0, y: 0 }, 2);
    const v = unitFromTemplate(2, "trooper", { x: 2, y: 0 }, 2);
    const state = openBattle([u, v]);

    const events = executeMove(state, 1, { x: 2, y: 0 });
    expect(events).toEqual([{ type: "blocked", reason: "occupied" }]);
    // Nobody moved; the tile still holds exactly its original occupant.
    expect(u.pos).toEqual({ x: 0, y: 0 });
    expect(u.tu).toBe(u.stats.timeUnits);
    expect(unitAt(state, { x: 2, y: 0 })).toBe(v);
  });

  it("refuses to move onto a tile held by an enemy unit", () => {
    const u = unitFromTemplate(1, "trooper", { x: 0, y: 0 }, 2);
    const e = unitFromTemplate(2, "drone", { x: 2, y: 0 }, 6);
    const state = openBattle([u, e]);

    const events = executeMove(state, 1, { x: 2, y: 0 });
    expect(events).toEqual([{ type: "blocked", reason: "occupied" }]);
    expect(u.pos).toEqual({ x: 0, y: 0 });
    expect(unitAt(state, { x: 2, y: 0 })).toBe(e);
  });
});

describe("reaction-fire reserve", () => {
  it("withholds reserved TU during a move so the unit can still react", () => {
    const p = unitFromTemplate(1, "trooper", { x: 1, y: 5 }, 2 /* E */, {
      reserve: "snap",
    });
    const state = openBattle([p]); // no enemies => no reactions / victory check
    const weapon = WEAPONS[p.weaponId]!;
    const snap = weapon.modes.find((m) => m.kind === "snap")!;
    const snapCost = Math.ceil((p.stats.timeUnits * snap.tuPercent) / 100);

    applyCommand(state, { type: "move", unitId: 1, to: { x: 20, y: 5 } });

    expect(p.pos.x).toBeGreaterThan(1); // it did advance
    expect(p.tu).toBeGreaterThanOrEqual(snapCost); // kept enough to snap-fire
    expect(p.tu).toBeLessThan(snapCost + 4); // and stopped as soon as it had to
  });

  it("spends freely when the reserve is 'none'", () => {
    const p = unitFromTemplate(1, "trooper", { x: 1, y: 5 }, 2, { reserve: "none" });
    const state = openBattle([p]);
    applyCommand(state, { type: "move", unitId: 1, to: { x: 20, y: 5 } });
    // Walks until it can no longer afford another 4-TU floor step.
    expect(p.tu).toBeLessThan(4);
  });
});

describe("reaction fire during movement", () => {
  it("does not trigger reactions from turning in place", () => {
    const mover = unitFromTemplate(1, "trooper", { x: 5, y: 5 }, 0);
    const watcher = unitFromTemplate(2, "drone", { x: 5, y: 7 }, 0, {
      stats: { ...TEMPLATES.drone!.stats, reactions: 200 },
    });
    const state = openBattle([mover, watcher]);
    const events = executeFace(state, 1, 4);
    expect(events.every((e) => e.type !== "shot")).toBe(true);
  });
});
