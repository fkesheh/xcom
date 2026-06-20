/**
 * Scenario builder: turn a seed into a ready-to-play {@link BattleState}.
 *
 * Determinism: the single Rng created from the seed drives map generation
 * (themed block assembly + prefab placement + scatter), so `same seed => same
 * map + spawns`. Spawn consumption and unit construction are pure (no rng),
 * keeping the rng stream identical for the battle that follows.
 */

import type {
  BattleState,
  Dir8,
  ItemInstance,
  Unit,
  UnitStats,
  UnitTemplate,
  Vec2,
} from "./types";
import { MORALE } from "./types";
import { Rng } from "./rng";
import { dir8Towards } from "./los";
import { refillTU, revealFor } from "./battle";
import { tileTypeAt } from "./grid";
import { generateMap } from "./mapgen";
import { ENEMY_NAMES, ITEMS, PLAYER_NAMES, TEMPLATES, WEAPONS } from "./content";

export interface SkirmishOptions {
  seed: number;
  width?: number;
  height?: number;
  players?: number;
  enemies?: number;
  playerWeaponIds?: readonly string[];
  playerNames?: readonly string[];
  playerSoldierIds?: readonly string[];
  playerStatBonuses?: readonly Partial<UnitStats>[];
  /** Per-player-index item ids to ADD on top of the template's loadout. */
  playerItems?: string[][];
  /** Force a terrain theme ("farmland" | "urban" | "desert"); seeded when omitted. */
  themeId?: string;
  /** Hour of day (0..23) from the campaign clock; drives battlescape day/dusk/night lighting. */
  hourOfDay?: number;
}

/** Build a carried item instance: grenades are single-use, medkits hold 3 charges. */
function makeItemInstance(id: string): ItemInstance {
  return { itemId: id, uses: id === "medkit" ? 3 : 1 };
}

/** Map a template's item ids to starting carried instances. */
function itemInstancesFor(template: UnitTemplate): ItemInstance[] {
  return (template.items ?? []).map(makeItemInstance);
}

const DEFAULT_WIDTH = 30;
const DEFAULT_HEIGHT = 30;
const DEFAULT_PLAYERS = 4;
const DEFAULT_ENEMIES = 6;

/** Instantiate a live unit from a template at `pos` facing `facing`. */
function spawnUnit(
  id: number,
  template: UnitTemplate,
  name: string,
  pos: Vec2,
  facing: Dir8,
): Unit {
  const weapon = WEAPONS[template.weaponId];
  return {
    id,
    name,
    templateId: template.id,
    faction: template.faction,
    pos: { x: pos.x, y: pos.y },
    facing,
    stats: { ...template.stats },
    tu: template.stats.timeUnits,
    hp: template.stats.health,
    morale: MORALE.MAX,
    items: itemInstancesFor(template),
    weaponId: template.weaponId,
    ammo: weapon?.magazineSize ?? 0,
    alive: true,
    reserve: "none",
    stance: "stand",
    sightRange: template.sightRange,
    visionHalfAngleDeg: template.visionHalfAngleDeg,
  };
}

function requireTemplate(id: string): UnitTemplate {
  const tpl = TEMPLATES[id];
  if (!tpl) throw new Error(`unknown template "${id}"`);
  return tpl;
}

function applyStatBonus(unit: Unit, bonus: Partial<UnitStats> | undefined): void {
  if (!bonus) return;
  unit.stats = {
    timeUnits: Math.max(1, unit.stats.timeUnits + Math.floor(bonus.timeUnits ?? 0)),
    health: Math.max(1, unit.stats.health + Math.floor(bonus.health ?? 0)),
    reactions: Math.max(0, unit.stats.reactions + Math.floor(bonus.reactions ?? 0)),
    firingAccuracy: Math.max(0, unit.stats.firingAccuracy + Math.floor(bonus.firingAccuracy ?? 0)),
    strength: Math.max(0, unit.stats.strength + Math.floor(bonus.strength ?? 0)),
  };
  unit.tu = unit.stats.timeUnits;
  unit.hp = unit.stats.health;
}

function findPowerSource(grid: BattleState["grid"]): Vec2 | undefined {
  for (let y = 0; y < grid.height; y++) {
    for (let x = 0; x < grid.width; x++) {
      if (tileTypeAt(grid, x, y)?.id === "ufo_power") return { x, y };
    }
  }
  return undefined;
}

/**
 * Build a fresh skirmish: generate a themed map, deploy the player squad at the
 * dropship and the hostiles around the UFO / scattered across the field (all on
 * mutually reachable tiles), fill TU, and seed the player's fog memory.
 */
export function createSkirmish(opts: SkirmishOptions): BattleState {
  const width = opts.width ?? DEFAULT_WIDTH;
  const height = opts.height ?? DEFAULT_HEIGHT;
  const requestedPlayers = opts.players ?? DEFAULT_PLAYERS;
  const requestedEnemies = opts.enemies ?? DEFAULT_ENEMIES;

  const rng = new Rng(opts.seed);
  const map = generateMap(rng, {
    seed: opts.seed,
    width,
    height,
    themeId: opts.themeId,
  });
  const { grid, playerSpawns, enemySpawns, themeId } = map;

  const log: string[] = [];

  // Clamp counts to available, non-overlapping spawn tiles rather than stacking.
  const playerCount = Math.min(requestedPlayers, playerSpawns.length);
  const enemyCount = Math.min(requestedEnemies, enemySpawns.length);
  if (playerCount < requestedPlayers) {
    log.push(`Only ${playerCount}/${requestedPlayers} deploy tiles available.`);
  }
  if (enemyCount < requestedEnemies) {
    log.push(`Only ${enemyCount}/${requestedEnemies} hostile spawns available.`);
  }

  // Face the squad toward the enemy mass; face hostiles back toward the squad.
  const playerFocus: Vec2 = enemySpawns[0] ?? { x: Math.floor(width / 2), y: 0 };
  const enemyFocus: Vec2 = playerSpawns[0] ?? {
    x: Math.floor(width / 2),
    y: height - 1,
  };

  const playerNames = [...PLAYER_NAMES];
  const enemyNames = [...ENEMY_NAMES];
  const enemyTemplateIds = ["drone", "sentinel"];

  const units: Unit[] = [];
  let nextId = 1;

  const trooper = requireTemplate("trooper");
  for (let i = 0; i < playerCount; i++) {
    const tile = playerSpawns[i]!;
    const name = opts.playerNames?.[i] ?? playerNames.shift() ?? `Operative-${nextId}`;
    const unit = spawnUnit(nextId, trooper, name, tile, dir8Towards(tile, playerFocus));
    const weaponId = opts.playerWeaponIds?.[i];
    if (weaponId && WEAPONS[weaponId]) {
      unit.weaponId = weaponId;
      unit.ammo = WEAPONS[weaponId].magazineSize;
    }
    const soldierId = opts.playerSoldierIds?.[i];
    if (soldierId) unit.campaignSoldierId = soldierId;
    applyStatBonus(unit, opts.playerStatBonuses?.[i]);
    const extra = opts.playerItems?.[i];
    if (extra && extra.length > 0) {
      unit.items = [...(unit.items ?? []), ...extra.map(makeItemInstance)];
    }
    units.push(unit);
    nextId++;
  }

  for (let i = 0; i < enemyCount; i++) {
    const tile = enemySpawns[i]!;
    const tplId = enemyTemplateIds[i % enemyTemplateIds.length]!;
    const tpl = requireTemplate(tplId);
    const name = enemyNames.shift() ?? `Hostile-${nextId}`;
    units.push(spawnUnit(nextId, tpl, name, tile, dir8Towards(tile, enemyFocus)));
    nextId++;
  }

  const state: BattleState = {
    grid,
    units,
    weapons: WEAPONS,
    items: { ...ITEMS },
    turn: 1,
    activeFaction: "player",
    rng,
    status: "playing",
    themeId,
    hourOfDay: opts.hourOfDay,
    objective: (() => {
      const target = findPowerSource(grid);
      return target
        ? {
            kind: "recover",
            label: "Recover UFO power source",
            target,
            recovered: false,
            extracted: false,
            extractionZone: playerSpawns.map((tile) => ({ x: tile.x, y: tile.y })),
          }
        : undefined;
    })(),
    explored: new Set<number>(),
    log,
  };

  refillTU(state, "player");
  refillTU(state, "enemy");
  for (const u of units) {
    if (u.faction === "player") revealFor(state, u);
  }

  return state;
}
