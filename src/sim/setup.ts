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
  EnemyRank,
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
import { blocksMove, inBounds, tileTypeAt } from "./grid";
import { generateMap } from "./mapgen";
import { CIVILIAN_NAMES, ENEMY_NAMES, ITEMS, PLAYER_NAMES, TEMPLATES, WEAPONS } from "./content";
// Side-effect import: registers the arctic/jungle/forest theme pack into the
// live THEMES/CHAR_TO_ID registries so a real mission's seeded theme pick spans
// all six zones. Runs once (ES module body); see terrain.themes.extra.ts.
import "./terrain.themes.extra";

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
  /** Force a terrain theme ("farmland" | "urban" | "desert" | "arctic" | "jungle" | "forest"); seeded when omitted. */
  themeId?: string;
  /** Hour of day (0..23) from the campaign clock; drives battlescape day/dusk/night lighting. */
  hourOfDay?: number;
  /**
   * Tactical objective kind. "recover" (default) builds the UFO power-source
   * objective; "rescue" (terror-site) places civilians to protect and a rescue
   * objective whose win trigger is eliminating the hostiles. Omitted keeps the
   * legacy recover-or-none behaviour unchanged.
   */
  objectiveKind?: "recover" | "rescue";
  /** "rescue" objectives: civilians to scatter through the strike zone. */
  civilianCount?: number;
  /**
   * Explicit hostile crew composition by rank (endgame rank channel). Each rank
   * maps to an enemy template that fields it (soldier→drone/stalker, navigator→
   * sentinel, leader→heavy, commander→commander) so campaign-driven crews —
   * captured for containment/interrogation — spawn with the right ranks. When
   * omitted the legacy drone/sentinel rotation is used unchanged. Length drives
   * the enemy count in place of `enemies` when present.
   */
  enemyRanks?: readonly EnemyRank[];
}

/**
 * Enemy template that fields a given crew rank. Soldiers alternate drone/stalker
 * for variety without consuming the map rng (index parity keeps the seed stream
 * identical to legacy spawns); the other ranks each have a single carrier.
 */
function templateIdForRank(rank: EnemyRank, index: number): string {
  switch (rank) {
    case "navigator":
      return "sentinel";
    case "leader":
      return "heavy";
    case "commander":
      return "commander";
    case "soldier":
    default:
      return index % 2 === 0 ? "drone" : "stalker";
  }
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
    stun: 0,
    unconscious: false,
    rank: template.rank,
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
 * Pick up to `count` walkable tiles scattered through the strike zone around the
 * map centre (the "city"), skipping any tile already in `occupied`. Drawn from
 * the shared rng so terror-site placement is deterministic for a given seed.
 * Mutates `occupied` with every chosen tile so callers can chain spawn passes.
 */
function findCityTiles(
  grid: BattleState["grid"],
  occupied: Set<number>,
  rng: Rng,
  count: number,
): Vec2[] {
  const cx = Math.floor(grid.width / 2);
  const cy = Math.floor(grid.height / 2);
  const radius = Math.max(6, Math.floor(Math.min(grid.width, grid.height) / 3));
  const candidates: Vec2[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      if (!inBounds(grid, x, y)) continue;
      if (blocksMove(grid, x, y)) continue;
      if (occupied.has(y * grid.width + x)) continue;
      candidates.push({ x, y });
    }
  }
  const shuffled = rng.shuffle(candidates);
  const out: Vec2[] = [];
  for (const tile of shuffled) {
    if (out.length >= count) break;
    const idx = tile.y * grid.width + tile.x;
    if (occupied.has(idx)) continue;
    occupied.add(idx);
    out.push(tile);
  }
  return out;
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
  // An explicit rank composition (endgame rank channel) drives the hostile count;
  // otherwise fall back to the requested/legacy enemy count.
  const enemyRanks = opts.enemyRanks;
  const requestedEnemies = enemyRanks?.length ?? opts.enemies ?? DEFAULT_ENEMIES;

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
    // Rank channel: map the requested rank to its carrier template when a crew
    // composition was supplied; otherwise keep the legacy drone/sentinel rotation.
    const tplId = enemyRanks
      ? templateIdForRank(enemyRanks[i]!, i)
      : enemyTemplateIds[i % enemyTemplateIds.length]!;
    const tpl = requireTemplate(tplId);
    const name = enemyNames.shift() ?? `Hostile-${nextId}`;
    units.push(spawnUnit(nextId, tpl, name, tile, dir8Towards(tile, enemyFocus)));
    nextId++;
  }

  // Terror-site (rescue): scatter unarmed civilians through the city centre to
  // protect. They are neutral — they never take a turn and never act — they only
  // exist to be rescued (scored at mission end) or hunted by the aliens.
  let civiliansSpawned = 0;
  if (opts.objectiveKind === "rescue") {
    const occupied = new Set<number>();
    for (const u of units) occupied.add(u.pos.y * grid.width + u.pos.x);
    const cityCenter: Vec2 = { x: Math.floor(width / 2), y: Math.floor(height / 2) };
    const cityTiles = findCityTiles(grid, occupied, rng, opts.civilianCount ?? 8);
    const civilianNames = [...CIVILIAN_NAMES];
    const civilianTpl = requireTemplate("civilian");
    for (const tile of cityTiles) {
      const name = civilianNames.shift() ?? `Civilian-${nextId}`;
      units.push(spawnUnit(nextId, civilianTpl, name, tile, dir8Towards(tile, cityCenter)));
      nextId++;
    }
    civiliansSpawned = cityTiles.length;
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
    objective:
      opts.objectiveKind === "rescue"
        ? {
            kind: "rescue",
            label: "Protect the civilians",
            target: { x: Math.floor(width / 2), y: Math.floor(height / 2) },
            recovered: false,
            extracted: false,
            extractionZone: [],
            civiliansTotal: civiliansSpawned,
          }
        : (() => {
            const target = findPowerSource(grid);
            return target
              ? {
                  kind: "recover" as const,
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
