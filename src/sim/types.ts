/**
 * Core domain types for the tactical simulation.
 *
 * Design rules (keep these true across the whole sim):
 *  - The sim is PURE and engine-agnostic: nothing in src/sim imports three.js
 *    or touches the DOM. The renderer reads sim state and sends Commands back.
 *  - Game logic uses integers wherever feasible (TU, HP, accuracy are ints).
 *    Floats are confined to geometry (angles, distances) and the cone-of-fire
 *    deviation model; never let float drift decide integer game state without
 *    rounding through a defined rule.
 *  - All randomness flows through BattleState.rng (see rng.ts).
 *
 * v1 scope: single Z-level, tile-based obstacles (walls occupy whole cells).
 * Multi-level maps and edge-walls are deliberate follow-ups; keep the model
 * easy to extend (e.g. add `z` to Vec2 later) but do not implement them now.
 */

import type { Rng } from "./rng";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** A tile coordinate on the battle grid (integer x, y). */
export interface Vec2 {
  x: number;
  y: number;
}

/** 8-way facing / movement direction. 0 = North, going clockwise. */
export type Dir8 = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Unit grid offsets for each Dir8 (screen-agnostic; +y is "south"). */
export const DIR8_VECTORS: readonly Readonly<Vec2>[] = [
  { x: 0, y: -1 }, // 0 N
  { x: 1, y: -1 }, // 1 NE
  { x: 1, y: 0 }, // 2 E
  { x: 1, y: 1 }, // 3 SE
  { x: 0, y: 1 }, // 4 S
  { x: -1, y: 1 }, // 5 SW
  { x: -1, y: 0 }, // 6 W
  { x: -1, y: -1 }, // 7 NW
];

export const DIR8_NAMES: readonly string[] = [
  "N",
  "NE",
  "E",
  "SE",
  "S",
  "SW",
  "W",
  "NW",
];

// ---------------------------------------------------------------------------
// Terrain & grid
// ---------------------------------------------------------------------------

/** A kind of tile (data-driven palette entry). */
export interface TileType {
  /** Stable id, e.g. "floor", "wall", "rubble". */
  id: string;
  /** Human label (rebrandable). */
  label: string;
  /** Cannot be walked into when true. */
  blocksMove: boolean;
  /** Blocks line of sight and line of fire when true. */
  blocksSight: boolean;
  /** Base Time Units to enter this tile (integer). Ignored if blocksMove. */
  moveCost: number;
  /**
   * Cover this tile provides to an adjacent defender against fire coming from
   * the tile's side: 0 = none, 1 = half cover, 2 = full cover. Cover tiles are
   * typically blocksMove=true (can't enter) + blocksSight=false (shoot over).
   */
  cover: 0 | 1 | 2;
  /** Whether the tile can be destroyed (reserved for future destruction). */
  destructible: boolean;
  /**
   * Optional PRESENTATION category the renderer maps to a concrete visual
   * (mesh + colour), e.g. "grass", "wall_building", "window". This is
   * pure data: the SIM never reads `render` — movement / sight / fire only ever
   * look at blocksMove / blocksSight / moveCost / cover. It exists so src/game
   * can pick a look per tile without hard-coding tile ids, and so terrain
   * themes can share one visual across several tile ids. When omitted (e.g. the
   * legacy DEFAULT_PALETTE), the renderer falls back to its blocksMove/cover
   * heuristic. See src/sim/terrain.ts for the full category vocabulary.
   */
  render?: string;
}

/**
 * Free-form identifier for a terrain theme id or a tile render category
 * (e.g. "farmland", "grass"). A string alias kept for readable signatures.
 */
export type TerrainId = string;

/**
 * The battle map. Row-major palette-indexed cells: index = y * width + x.
 * Use the helpers in grid.ts (tileAt, blocksMove, ...) rather than touching
 * `cells` directly.
 */
export interface Grid {
  width: number;
  height: number;
  /** Palette index per cell, row-major. */
  cells: Uint16Array;
  /** Tile-type palette; cells index into this. */
  palette: TileType[];
}

// ---------------------------------------------------------------------------
// Units, stats, weapons, items
// ---------------------------------------------------------------------------

export type Faction = "player" | "enemy" | "civilian";

/** How much TU a unit holds back for reaction fire during its own turn. */
export type ReserveMode = "none" | "snap" | "aimed" | "auto";

/** Body stance. Kneeling improves accuracy and shrinks the unit's target profile. */
export type UnitStance = "stand" | "kneel";

export type UnitId = number;

/** Trainable/innate combat attributes (v1 subset of the classic stat block). */
export interface UnitStats {
  /** Max Time Units per turn. */
  timeUnits: number;
  /** Max health. */
  health: number;
  /** Reaction stat; drives reaction-fire initiative. */
  reactions: number;
  /** Firing accuracy, classic scale (≈ 0..120). Interpreted as a percentage. */
  firingAccuracy: number;
  /** Carry capacity / future encumbrance + throwing. */
  strength: number;
  /** Bravery (classic 0..120 scale); governs morale retention and panic resistance. */
  bravery?: number;
}

export type ShotKind = "snap" | "aimed" | "auto";

/** A firing mode of a weapon. */
export interface ShotMode {
  kind: ShotKind;
  /** TU cost as a percentage of the firer's MAX TU (classic model). */
  tuPercent: number;
  /** Weapon accuracy multiplier for this mode, as a percentage (e.g. 60). */
  accuracy: number;
  /** Rounds fired in one action (auto is typically 3). */
  shots: number;
}

/** A weapon definition (data-driven; names are rebrandable). */
export interface Weapon {
  id: string;
  name: string;
  /** Base damage per hit (before spread roll). */
  damage: number;
  /** Effective range in tiles; accuracy falls off beyond this. */
  range: number;
  /** Rounds loaded in one full magazine. */
  magazineSize: number;
  /** TU cost as a percentage of max TU to replace the magazine. */
  reloadTuPercent: number;
  modes: ShotMode[];
}

/** Kind of a consumable battlefield item. */
export type ItemKind = "grenade" | "medkit";

/** A consumable battlefield item definition (data-driven; names are rebrandable). */
export interface Item {
  id: string;
  name: string;
  kind: ItemKind;
  /** TU cost to use/throw, as a percentage of the user's MAX TU. */
  tuPercent: number;
  /** Grenade: blast radius in tiles (Chebyshev distance from impact). */
  blastRadius?: number;
  /** Grenade: damage at the blast center, before distance falloff. */
  damage?: number;
  /** Grenade: max throw range in tiles (clamped further by thrower strength). */
  throwRange?: number;
  /** Medkit: HP restored per use. */
  healAmount?: number;
}

/** A specific carried instance of an {@link Item}. */
export interface ItemInstance {
  itemId: string;
  /** Remaining uses (medkit charges; grenades are single-use). */
  uses: number;
  /** Grenade: primed and armed with a fuse. */
  primed?: boolean;
  /** Grenade: turns until detonation once primed (0 = impact-detonated on throw). */
  fuseTurns?: number;
}

/** How a panicking unit behaves for the turn. */
export type PanicBehavior = "freeze" | "flee" | "berserk";

/** One unit struck by an area-of-effect blast. */
export interface BlastHit {
  unitId: UnitId;
  damage: number;
  killed: boolean;
}

/** A template used to spawn units (data-driven content). */
export interface UnitTemplate {
  id: string;
  /** Display name or name-pool key (rebrandable). */
  name: string;
  faction: Faction;
  stats: UnitStats;
  weaponId: string;
  /** Starting consumable item ids this template spawns with (e.g. ["grenade"]). */
  items?: string[];
  /** Sight range in tiles (full daylight v1). */
  sightRange: number;
  /** Half-angle of the forward vision cone in degrees (45 => a 90° arc). */
  visionHalfAngleDeg: number;
}

/** A live unit on the battlefield. */
export interface Unit {
  id: UnitId;
  name: string;
  templateId: string;
  faction: Faction;
  pos: Vec2;
  facing: Dir8;
  stats: UnitStats;
  /** Current Time Units this turn. */
  tu: number;
  /** Current health. */
  hp: number;
  weaponId: string;
  /** Rounds currently loaded in the weapon's magazine. */
  ammo: number;
  /** Current morale (0..100); low morale can trigger panic. Populated by setup. */
  morale?: number;
  /** Carried consumable items (grenades, medkits). Populated by setup. */
  items?: ItemInstance[];
  alive: boolean;
  /** Optional persistent campaign roster id for player units. */
  campaignSoldierId?: string;
  /** TU the unit reserves for reaction fire during its own turn. */
  reserve: ReserveMode;
  /** Current body stance (kneel = better accuracy, smaller target). Defaults to stand. */
  stance?: UnitStance;
  sightRange: number;
  visionHalfAngleDeg: number;
}

// ---------------------------------------------------------------------------
// Battle state
// ---------------------------------------------------------------------------

export type BattleStatus = "playing" | "player_win" | "enemy_win";

export interface BattleObjective {
  kind: "recover" | "rescue";
  label: string;
  target: Vec2;
  recovered: boolean;
  extracted: boolean;
  extractionZone: Vec2[];
  recoveredBy?: UnitId;
  /** "rescue" objectives: civilians placed on the map to protect. */
  civiliansTotal?: number;
}

export interface BattleState {
  grid: Grid;
  units: Unit[];
  weapons: Record<string, Weapon>;
  /** Consumable item definitions available in this battle (keyed by id). */
  items?: Record<string, Item>;
  /** 1-based round counter (increments when control returns to the player). */
  turn: number;
  activeFaction: Faction;
  rng: Rng;
  status: BattleStatus;
  /** Terrain theme the map was generated from (e.g. "farmland"). Optional. */
  themeId?: TerrainId;
  /**
   * Wall-clock hour (0..23) the battle began, from the campaign clock. The
   * renderer derives day/dusk/night lighting and the sim may narrow night
   * vision. Pure data; the sim does not change behavior unless a rule reads it.
   */
  hourOfDay?: number;
  /** Optional tactical objective for missions that can be won without wiping every hostile. */
  objective?: BattleObjective;
  /** Tiles ever seen by the player faction (fog-of-war "explored" memory). */
  explored: Set<number>;
  /** Human-readable combat log (most recent last). */
  log: string[];
}

// ---------------------------------------------------------------------------
// Commands (renderer -> sim) and Events (sim -> renderer)
// ---------------------------------------------------------------------------

/**
 * Player-issued commands. The sim is authoritative: for "move" the renderer
 * sends only a destination; the sim computes the path, walks it tile by tile,
 * spends TU, and resolves any reaction fire mid-move.
 */
export type Command =
  | { type: "move"; unitId: UnitId; to: Vec2 }
  | { type: "face"; unitId: UnitId; dir: Dir8 }
  | { type: "shoot"; unitId: UnitId; target: Vec2; mode: ShotKind }
  | { type: "reload"; unitId: UnitId }
  | { type: "recoverObjective"; unitId: UnitId }
  | { type: "setReserve"; unitId: UnitId; reserve: ReserveMode }
  | { type: "setStance"; unitId: UnitId; stance: UnitStance }
  | { type: "throwItem"; unitId: UnitId; target: Vec2; itemId: string }
  | { type: "useItem"; unitId: UnitId; targetId: UnitId; itemId: string }
  | { type: "primeItem"; unitId: UnitId; itemId: string; fuseTurns: number }
  | { type: "endTurn" };

/**
 * Events describe what happened, in order, so the renderer can animate.
 * Enemy-turn AI events are returned from the "endTurn" command so the renderer
 * can play them back as a sequence.
 */
export type GameEvent =
  | { type: "moveStep"; unitId: UnitId; from: Vec2; to: Vec2; facing: Dir8; tuLeft: number }
  | { type: "faced"; unitId: UnitId; dir: Dir8; tuLeft: number }
  | {
      type: "shot";
      shooterId: UnitId;
      targetId: UnitId | null;
      targetPos: Vec2;
      /** Tile the shot is actually fired from: shooter's tile, or a lean tile. */
      originPos: Vec2;
      mode: ShotKind;
      /** Per-round results for the action (auto fires multiple). */
      rounds: ShotRound[];
      tuLeft: number;
      /** True when this shot was a reaction interrupt rather than a deliberate action. */
      reaction: boolean;
    }
  | { type: "died"; unitId: UnitId }
  | { type: "reloaded"; unitId: UnitId; ammo: number; tuLeft: number }
  | { type: "objectiveRecovered"; unitId: UnitId; label: string; target: Vec2 }
  | { type: "objectiveExtracted"; unitId: UnitId; label: string; target: Vec2 }
  | { type: "objectiveDropped"; unitId: UnitId; label: string; target: Vec2 }
  | { type: "turnStarted"; faction: Faction; turn: number }
  | { type: "turnEnded"; faction: Faction }
  | { type: "gameOver"; status: BattleStatus }
  | { type: "itemThrown"; unitId: UnitId; itemId: string; from: Vec2; to: Vec2; tuLeft: number }
  | { type: "blastDetonated"; itemId: string; center: Vec2; radius: number; hits: BlastHit[] }
  | { type: "itemUsed"; unitId: UnitId; targetId: UnitId; itemId: string; healed: number; tuLeft: number }
  | { type: "panicked"; unitId: UnitId; behavior: PanicBehavior }
  | { type: "moraleChanged"; unitId: UnitId; morale: number }
  | { type: "stanceChanged"; unitId: UnitId; stance: UnitStance; tuLeft: number }
  | { type: "blocked"; reason: string };

/**
 * Action executor handed to the enemy AI by the reducer. The AI decides what
 * to do using read-only helpers, then calls these to actually perform actions
 * (which spend TU, resolve reaction fire, push events). This keeps ai.ts from
 * importing battle.ts, avoiding an import cycle.
 */
export interface AiExecutor {
  move(unitId: UnitId, to: Vec2): GameEvent[];
  shoot(unitId: UnitId, target: Vec2, mode: ShotKind): GameEvent[];
  reload(unitId: UnitId): GameEvent[];
  face(unitId: UnitId, dir: Dir8): GameEvent[];
  /** Optional: throwing a grenade. The real reducer implements this; AI calls it when it elects to throw. */
  throwItem?(unitId: UnitId, target: Vec2, itemId: string): GameEvent[];
}

/** Outcome of a single round of fire (auto fires several per action). */
export interface ShotRound {
  hit: boolean;
  /** Damage dealt to the target on a hit (0 on a miss). */
  damage: number;
  /** Signed deviation of the shot from the true bearing, in radians (for tracer FX). */
  deviationRad: number;
}

/** A hit-chance preview for the UI (no RNG advanced; honest odds). */
export interface ShotPreview {
  /** Whether a shot is possible at all (LOS clear, in arc-agnostic range, TU available). */
  possible: boolean;
  /** Per-round hit probability in [0, 1]. */
  hitChance: number;
  /** Expected number of hits across the mode's rounds. */
  expectedHits: number;
  /** TU the action would cost. */
  tuCost: number;
  /** Rounds the action would spend. */
  ammoCost: number;
  /** Reason when not possible (e.g. "no line of fire", "not enough TU"). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Tuning constants (combat feel). Centralized so balance is one edit away.
// ---------------------------------------------------------------------------

export const COMBAT = {
  /**
   * Cone-of-fire model: a shot deviates by a random angle uniform in
   * [-spread, +spread], where spread = lerp(SPREAD_AT_0, SPREAD_AT_100, acc).
   * The target tile subtends a half-angle α at the shooter; the shot hits when
   * |deviation| <= α. Hence hitChance = clamp(α / spread, 0, 1): closer/larger
   * targets are easier, exactly like the classic engine.
   */
  SPREAD_AT_0_RAD: 0.5, // ~28.6° at 0% effective accuracy
  SPREAD_AT_100_RAD: 0.006, // ~0.34° at 100% effective accuracy
  /** Target tile half-width in tile units (for the subtended angle). */
  TARGET_HALF_WIDTH: 0.5,
  /** Hit chance is never below this when a shot is possible. */
  MIN_HIT_CHANCE: 0.05,
  /** Hit chance is capped here so nothing is a literal certainty. */
  MAX_HIT_CHANCE: 0.99,
  /** Accuracy multiplier once the target is beyond a weapon's effective range (per tile over). */
  RANGE_FALLOFF_PER_TILE: 0.02,
  /** Damage roll is uniform in [base * MIN, base * MAX], rounded to int. */
  DAMAGE_MIN_MULT: 0.5,
  DAMAGE_MAX_MULT: 1.5,
  /** Extra TU-percent floor: a unit needs at least this much of max TU to reaction-fire. */
} as const;

/** Fixed TU costs (not percentage-based). */
export const TU_COST = {
  /** Cost to pivot 45° (one Dir8 step). */
  TURN_STEP: 1,
  /** Multiplier applied to a tile's base moveCost for diagonal entry (+50%). */
  DIAGONAL_MULT: 1.5,
} as const;

/**
 * Morale & panic tuning. Morale is 0..100. Stressors subtract; each unit
 * recovers a bravery-scaled amount at the start of its own turn. Below
 * PANIC_THRESHOLD a unit must pass a bravery roll or panic (freeze/flee/berserk).
 */
export const MORALE = {
  MAX: 100,
  PANIC_THRESHOLD: 35,
  SELF_WOUNDED_LOSS: 12,
  ALLY_WOUNDED_LOSS: 6,
  ALLY_DEATH_LOSS: 25,
  /** Per-turn recovery, scaled by bravery (higher bravery => more recovery). */
  RECOVERY_PER_TURN: 6,
  /** Bravery used when a stat omits it (classic rookie baseline). */
  DEFAULT_BRAVERY: 50,
} as const;

/** Stance tuning. Kneeling trades a little mobility for accuracy and a smaller profile. */
export const STANCE = {
  /** TU cost to toggle stance (stand <-> kneel). */
  TOGGLE_TU: 4,
  /** Firing-accuracy bonus while kneeling (added to effective accuracy, classic 0..120 scale). */
  KNEEL_ACCURACY_BONUS: 20,
  /** Hit-chance reduction against a kneeling target (presents a smaller profile). */
  KNEEL_TARGET_DEFENSE: 0.2,
  /** Movement TU multiplier while kneeling (kneeling moves are a bit costlier). */
  KNEEL_MOVE_MULT: 1.25,
} as const;

/**
 * Cover tuning. Cover is DIRECTIONAL: only cover tiles sitting between the
 * defender and the shooter protect the defender. See combat.coverDefenseFor().
 */
export const COVER = {
  /** Hit-chance reduction against a defender in HALF cover (tile.cover === 1). */
  HALF_DEFENSE: 0.3,
  /** Hit-chance reduction against a defender in FULL cover (tile.cover === 2). */
  FULL_DEFENSE: 0.55,
} as const;
