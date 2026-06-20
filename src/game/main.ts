/**
 * Controller: wires the deterministic sim to the three.js view.
 *
 * Flow: pointer/keyboard input -> {@link Command} -> applyCommand(state) ->
 * ordered {@link GameEvent}s -> awaitable view animations -> resync. All game
 * logic stays in the sim; this file only reads state, dispatches Commands, and
 * plays back events. Input is ignored while an animation sequence is in flight.
 *
 * Screen transitions are fully in-process (no URL-param reloads): geoscape,
 * base, and tactical each dispose the previous view's DOM + listeners + rAF
 * before mounting the next.
 */

import {
  applyCommand,
  canExtractObjective,
  canRecoverObjective,
  canSee,
  createSkirmish,
  dir8Towards,
  findPath,
  livingUnits,
  previewPlayerShot,
  tileTypeAt,
  unitAt,
  unitById,
  visibleEnemyIds,
  DIR8_NAMES,
  TU_COST,
} from "../sim/index";
import type {
  BattleState,
  Command,
  GameEvent,
  ReserveMode,
  ShotKind,
  Unit,
  Vec2,
} from "../sim/index";
import type {
  CampaignState,
  CampaignWeaponId,
  DifficultyLevel,
  OperationPlan,
} from "../campaign/types";
import {
  advanceGeoscape,
  startInterceptionEncounter,
  executeInterceptionAction,
  type InterceptionAction,
} from "../campaign/geoscape";
import { generateOperation } from "../campaign/operations";
import {
  assignSoldierWeapon,
  clearCampaign,
  buildFacility,
  campaignSoldierStatBonus,
  createCampaign,
  deploymentSoldiers,
  deploymentWeaponIds,
  loadCampaign,
  purchaseWeapon,
  recordMissionResult,
  recruitSoldier,
  saveCampaign,
  setSoldierDeployment,
  startManufacturing,
  startResearch,
} from "../campaign/storage";

import { Renderer } from "./renderer";
import { Sfx } from "./audio";
import type { ProjectileKind } from "./effects";
import { BaseView } from "./baseView";
import { GeoscapeView } from "./geoscape";
import { Hud, type HudDebrief, type HudHover, type HudSoldierDetail } from "./hud";

function urlSeed(): number | null {
  const raw = new URLSearchParams(window.location.search).get("seed");
  const parsed = raw === null ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : null;
}

function newCampaignSeed(): number {
  const fromUrl = urlSeed();
  if (fromUrl !== null) return fromUrl;
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return values[0] ?? Date.now();
}

const MODES: readonly ShotKind[] = ["snap", "aimed", "auto"];
const RESERVES: readonly ReserveMode[] = ["none", "snap", "aimed", "auto"];
const CLICK_SLOP_PX = 6;
const LOG_CAP = 60;

const app = document.getElementById("app");
if (!app) throw new Error("#app container missing");
const appRoot: HTMLElement = app;

let geoscape: GeoscapeView | null = null;
let baseView: BaseView | null = null;
/** Teardown for an active tactical view, invoked before mounting any other screen. */
let tacticalCleanup: (() => void) | null = null;

/**
 * In-memory source of truth for the live campaign. The geoscape's flowing-time
 * frame loop and every base callback advance from this rather than re-reading
 * localStorage — which returns the last *committed* state and so goes stale
 * while a debounced save is pending. At 30x (160ms ticks) the 400ms debounce
 * timer is cleared and re-armed on every tick and never fires, so each tick
 * re-advanced the same pre-flow snapshot and the clock froze; the same staleness
 * let a rapid recruit/assign/launch chain build a battle from pre-action state.
 */
let currentCampaign: CampaignState | null = null;

/** Chebyshev (8-way) distance between two tiles — mirrors the sim's adjacency rule. */
function chebyshev(a: Vec2, b: Vec2): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

function disposeTacticalIfExists(): void {
  if (tacticalCleanup) {
    tacticalCleanup();
    tacticalCleanup = null;
  }
}

/**
 * Trailing-debounce save. Rapid in-place actions (scan/intercept/recruit/...)
 * coalesce into one write so the screen stays responsive; screen transitions
 * flush immediately via {@link flushSave} so nothing is lost when a view unmounts.
 */
const SAVE_DEBOUNCE_MS = 400;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pendingSave: CampaignState | null = null;

function debouncedSave(campaign: CampaignState): void {
  pendingSave = campaign;
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const snapshot = pendingSave;
    pendingSave = null;
    if (snapshot) saveCampaign(snapshot);
  }, SAVE_DEBOUNCE_MS);
}

/** Flush any pending debounced save immediately (call before a screen transition). */
function flushSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const snapshot = pendingSave;
  pendingSave = null;
  if (snapshot) saveCampaign(snapshot);
}

function showGeoscape(): void {
  flushSave();
  // Seed the in-memory campaign once from storage; every geoscape callback then
  // advances from `currentCampaign` instead of re-reading localStorage (which
  // returns stale state while a debounced save is pending).
  currentCampaign = loadCampaign();
  disposeTacticalIfExists();
  baseView?.dispose();
  baseView = null;
  geoscape?.dispose();
  geoscape = new GeoscapeView({
    campaign: currentCampaign,
    onConfirmBase: (base, difficulty) => {
      // "Review base" mid-campaign must NOT recreate the campaign (that would
      // wipe soldiers, research, facilities, resources, and the seed). Only the
      // new-game flow (no saved campaign) calls createCampaign; otherwise we
      // just return to the existing base.
      flushSave();
      const existing = loadCampaign();
      if (existing) {
        geoscape?.dispose();
        geoscape = null;
        showBase(existing);
        return;
      }
      const campaign = createCampaign(base, newCampaignSeed(), difficulty ?? "veteran");
      saveCampaign(campaign);
      geoscape?.dispose();
      geoscape = null;
      showBase(campaign);
    },
    onAdvanceTime: (hours) => {
      // The geoscape's own frame loop drives this; refresh in place instead of
      // re-mounting (a dispose+mount here would flicker the globe and stall flow).
      // Advance from the in-memory campaign so time accumulates across ticks;
      // reading localStorage here would re-read the pre-flow snapshot every tick
      // (the debounced save never fires while 30x/5x ticks keep re-arming it).
      if (!currentCampaign) return;
      currentCampaign = advanceGeoscape(currentCampaign, hours);
      debouncedSave(currentCampaign);
      geoscape?.update(currentCampaign);
    },
    onInterceptUfo: () => {
      if (!currentCampaign) return;
      currentCampaign = startInterceptionEncounter(currentCampaign);
      debouncedSave(currentCampaign);
      geoscape?.update(currentCampaign);
    },
    onInterceptionAction: (action: InterceptionAction) => {
      if (!currentCampaign) return;
      currentCampaign = executeInterceptionAction(currentCampaign, action);
      debouncedSave(currentCampaign);
      geoscape?.update(currentCampaign);
    },
    onResetCampaign: () => {
      // Flush before clearing so a pending debounced save can't resurrect it.
      flushSave();
      clearCampaign();
      currentCampaign = null;
      showGeoscape();
    },
  });
  geoscape.mount(appRoot);
}

function showBase(campaign: CampaignState): void {
  flushSave();
  // Mirror the live campaign in memory; rapid base actions (recruit → assign →
  // launch) chain off this so each sees the previous action's result without
  // waiting on the deferred save.
  currentCampaign = campaign;
  const operation = generateOperation(campaign);
  disposeTacticalIfExists();
  geoscape?.dispose();
  geoscape = null;
  baseView?.dispose();
  baseView = new BaseView({
    campaign,
    operation,
    onLaunchMission: () => {
      // In-place updates keep the closed-over `campaign`/`operation` stale; read
      // the live in-memory state so deployment, weapons, and the generated
      // operation match the current squad before handing off to the tactical
      // controller.
      const current = currentCampaign ?? campaign;
      if (current.strategic.status === "active") startTactical(current);
    },
    onStartResearch: (id) => {
      const updated = startResearch(currentCampaign ?? campaign, id);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onBuildFacility: (id) => {
      const updated = buildFacility(currentCampaign ?? campaign, id);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onRecruitSoldier: () => {
      const current = currentCampaign ?? campaign;
      if (current.strategic.status !== "active") return;
      const updated = recruitSoldier(current);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onAssignWeapon: (soldierId, weaponId) => {
      const updated = assignSoldierWeapon(currentCampaign ?? campaign, soldierId, weaponId);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onToggleDeployment: (soldierId, deployed) => {
      const updated = setSoldierDeployment(currentCampaign ?? campaign, soldierId, deployed);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onStartManufacturing: (id) => {
      const updated = startManufacturing(currentCampaign ?? campaign, id);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onPurchaseWeapon: (weaponId: CampaignWeaponId) => {
      const updated = purchaseWeapon(currentCampaign ?? campaign, weaponId);
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onOpenGeoscape: () => showGeoscape(),
    onResetCampaign: () => {
      // Flush before clearing so a pending debounced save can't resurrect it.
      flushSave();
      clearCampaign();
      currentCampaign = null;
      showGeoscape();
    },
  });
  baseView.mount(appRoot);
}

function startTactical(campaign: CampaignState, operation: OperationPlan = generateOperation(campaign)): void {
  flushSave();
  const deployment = deploymentSoldiers(campaign);
  const contactStatus = campaign.ufoContact?.status;
  // Launch for both "crashed" (classic shoot-down) and "landed" (terror, landed
  // UFO, base defense) contacts — generateOperation already branches on
  // missionType to produce the right enemies, theme, and context.
  if (
    campaign.strategic.status !== "active" ||
    deployment.length === 0 ||
    (contactStatus !== "crashed" && contactStatus !== "landed")
  ) {
    return;
  }
  disposeTacticalIfExists();
  geoscape?.dispose();
  geoscape = null;
  baseView?.dispose();
  baseView = null;
  const SEED = operation.missionSeed;
  let state: BattleState = createSkirmish({
    seed: SEED,
    width: operation.width,
    height: operation.height,
    players: deployment.length,
    enemies: operation.enemyCount,
    themeId: operation.themeId,
    hourOfDay: campaign.clock.hour,
    playerWeaponIds: deploymentWeaponIds(campaign),
    playerNames: deployment.map((soldier) => soldier.name),
    playerSoldierIds: deployment.map((soldier) => soldier.id),
    playerStatBonuses: deployment.map((soldier) => campaignSoldierStatBonus(campaign, soldier)),
  });

  const renderer = new Renderer();
  renderer.mount(appRoot);

  const sfx = new Sfx();

  let selectedId: number | null = null;
  let currentMode: ShotKind = "snap";
  let currentHover: HudHover | null = null;
  let busy = false;
  let lastFootstepMs = 0; // throttles move() so fast paths don't machine-gun

  /** id of the unit whose directional cover indicators are shown (dedupe; null = cleared). */
  let coverFocusId: number | null = null;

  /** Active item-targeting mode (throw a grenade / heal an ally), or null. */
  let itemTargeting: { kind: "throw" | "heal"; itemId: string } | null = null;

  /** Guards against double-dispose and stops the rAF loop on teardown. */
  let tacticalActive = true;
  let frameId = 0;
  /** AbortController whose signal is attached to every tactical listener. */
  const tacticalAbort = new AbortController();
  const tacticalSignal = tacticalAbort.signal;

  const hud = new Hud({
    onEndTurn: () => void dispatch({ type: "endTurn" }),
    onSelectMode: (kind) => setMode(kind),
    onSetReserve: (mode) => setReserve(mode),
    onReload: () => reloadSelected(),
    onSelectUnit: (id) => select(id),
    onToggleMute: () => toggleAudio(),
    onOpenGeoscape: () => abortMissionToGeoscape(),
    onReturnToBase: () => returnToBase(),
    onThrowItem: (itemId) => beginTargeting("throw", itemId),
    onUseItem: (itemId) => beginTargeting("heal", itemId),
    onPrimeItem: (itemId) => primeSelected(itemId),
    onSetStance: (stance) => {
      const sel = selectedUnit();
      if (sel && !busy) void dispatch({ type: "setStance", unitId: sel.id, stance });
    },
    onOpenSoldierDetail: () => refreshHud(),
    onNewCampaign: () => startNewCampaign(),
  });
  hud.mount(appRoot);

  // ---------------------------------------------------------------------------
  // Tactical teardown (cancels rAF, aborts all listeners, disposes GPU + HUD)
  // ---------------------------------------------------------------------------

  function disposeTactical(): void {
    if (!tacticalActive) return;
    tacticalActive = false;
    cancelAnimationFrame(frameId);
    tacticalAbort.abort();
    hud.dispose();
    renderer.dispose();
  }

  tacticalCleanup = disposeTactical;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function selectedUnit(): Unit | null {
    if (selectedId === null) return null;
    const u = unitById(state, selectedId);
    return u && u.alive && u.faction === "player" ? u : null;
  }

  function pushLog(msg: string): void {
    state.log.push(msg);
    if (state.log.length > LOG_CAP) state.log.splice(0, state.log.length - LOG_CAP);
  }

  function soldierDetailFor(unit: Unit | null): HudSoldierDetail | undefined {
    if (!unit?.campaignSoldierId) return undefined;
    const c = completedCampaign ?? campaign;
    const soldier = c.soldiers.find((s) => s.id === unit.campaignSoldierId);
    if (!soldier) return undefined;
    return {
      rank: soldier.rank,
      missions: soldier.missions,
      survived: soldier.survivedMissions,
    };
  }

  function refreshHud(): void {
    const status = completedCampaign?.strategic.status;
    hud.update(state, selectedUnit(), currentHover, {
      seed: SEED,
      missionName: `OPERATION ${operation.codename}`,
      objective: operation.objective,
      briefing: operation.briefing,
      debrief: currentDebrief(),
      muted: sfx.isMuted(),
      busy,
      campaignStatus: status === "won" || status === "lost" ? status : undefined,
      soldierDetail: soldierDetailFor(selectedUnit()),
    });
  }

  function currentDebrief(): HudDebrief | undefined {
    if (!completedCampaign?.lastMission) return undefined;
    const report = completedCampaign.lastMission;
    const casualties = report.kiaSoldierIds.map(
      (id) => completedCampaign?.soldiers.find((soldier) => soldier.id === id)?.name ?? id,
    );
    return {
      result: report.result,
      operation: report.codename,
      summary: report.summary,
      reward: report.reward,
      casualties,
      strategicStatus: completedCampaign.strategic.status,
      threat: completedCampaign.strategic.threat,
      funding: completedCampaign.strategic.funding,
      score: completedCampaign.strategic.score,
    };
  }

  /**
   * Refresh the directional cover indicators for a player unit. Deduped by unit
   * id so pointermove hover doesn't rebuild the small marker group every frame;
   * pass force=true after a dispatch resync, since the selected unit may have
   * moved to a tile with different adjacent cover even though its id is unchanged.
   */
  function refreshCoverFor(unit: Unit | null, force = false): void {
    const id = unit && unit.faction === "player" ? unit.id : null;
    if (!force && id === coverFocusId) return;
    coverFocusId = id;
    renderer.showCoverIndicators(unit);
  }

  function select(id: number | null): void {
    selectedId = id;
    renderer.setSelected(id);
    refreshCoverFor(selectedUnit());
    if (id !== null) {
      sfx.select();
      const u = unitById(state, id);
      if (u) renderer.focusOn(u.pos);
    }
    currentHover = null;
    renderer.clearPreview();
    refreshHud();
  }

  function setMode(kind: ShotKind): void {
    currentMode = kind;
    hud.setMode(kind);
    refreshHud();
  }

  function setReserve(mode: ReserveMode): void {
    const sel = selectedUnit();
    if (!sel || busy) return;
    void dispatch({ type: "setReserve", unitId: sel.id, reserve: mode });
  }

  function reloadSelected(): void {
    const sel = selectedUnit();
    if (!sel || busy) return;
    void dispatch({ type: "reload", unitId: sel.id });
  }

  // -------------------------------------------------------------------------
  // Item targeting mode
  // -------------------------------------------------------------------------

  function beginTargeting(kind: "throw" | "heal", itemId: string): void {
    if (busy || state.status !== "playing") return;
    itemTargeting = { kind, itemId };
    const def = state.items?.[itemId];
    const label = def?.name ?? itemId;
    hud.notify(
      kind === "throw" ? `CLICK A TILE TO THROW ${label.toUpperCase()}` : `CLICK AN ADJACENT ALLY TO USE ${label.toUpperCase()}`,
      "info",
    );
    renderer.clearPreview();
    currentHover = null;
    refreshHud();
  }

  function clearTargeting(): void {
    if (!itemTargeting) return;
    itemTargeting = null;
    renderer.clearPreview();
    currentHover = null;
    refreshHud();
  }

  /** Immediately prime the selected unit's grenade (1-turn fuse). */
  function primeSelected(itemId: string): void {
    if (busy || state.status !== "playing") return;
    const sel = selectedUnit();
    if (!sel) return;
    void dispatch({ type: "primeItem", unitId: sel.id, itemId, fuseTurns: 1 });
  }

  /** Resolve an item-targeting click into the appropriate Command. */
  function handleTargetingClick(clientX: number, clientY: number): void {
    const sel = selectedUnit();
    if (!sel) {
      clearTargeting();
      return;
    }
    if (!itemTargeting) return;

    if (itemTargeting.kind === "throw") {
      const tile = renderer.raycastTile(clientX, clientY);
      if (tile) {
        void dispatch({ type: "throwItem", unitId: sel.id, target: tile, itemId: itemTargeting.itemId });
        clearTargeting();
      }
      return;
    }

    // heal: click an adjacent ally
    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    if (hoveredUnitId !== null) {
      const target = unitById(state, hoveredUnitId);
      if (target && target.alive && target.faction === "player" && chebyshev(sel.pos, target.pos) <= 1) {
        void dispatch({ type: "useItem", unitId: sel.id, targetId: target.id, itemId: itemTargeting.itemId });
        clearTargeting();
      } else {
        hud.notify("TARGET MUST BE AN ADJACENT ALLY", "danger");
      }
    }
  }

  /** Hover hint while in targeting mode. */
  function handleTargetingHover(clientX: number, clientY: number): void {
    const sel = selectedUnit();
    if (!sel || !itemTargeting) return;
    const def = state.items?.[itemTargeting.itemId];
    const name = def?.name ?? itemTargeting.itemId;

    if (itemTargeting.kind === "throw") {
      const tile = renderer.raycastTile(clientX, clientY);
      renderer.setHoverTile(tile);
      if (tile) {
        renderer.showPathPreview([]);
        const maxRange = def?.throwRange ?? 6;
        const inRange = chebyshev(sel.pos, tile) <= maxRange;
        currentHover = {
          kind: inRange ? "move" : "blocked",
          label: `Throw ${name}`,
          detail: inRange
            ? `Click to throw (blast ${def?.blastRadius ?? 1}). ${sel.tu} TU left.`
            : `Out of throw range (max ${maxRange}).`,
          reachable: inRange,
        };
      } else {
        renderer.showPathPreview([]);
        currentHover = null;
      }
      refreshHud();
      return;
    }

    // heal: highlight whether the hovered unit is a valid adjacent ally
    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    const target = hoveredUnitId !== null ? unitById(state, hoveredUnitId) : undefined;
    const valid = !!target && target.alive && target.faction === "player" && chebyshev(sel.pos, target.pos) <= 1;
    renderer.setHoverTile(null);
    renderer.showPathPreview([]);
    currentHover = valid
      ? {
          kind: "target",
          label: target!.name,
          detail: `Click to heal with ${name} (+${def?.healAmount ?? 0} HP). ${sel.tu} TU left.`,
        }
      : {
          kind: "blocked",
          label: `Use ${name}`,
          detail: "Click an adjacent ally to heal.",
        };
    refreshHud();
  }

  /** TU to enter `to` from the adjacent `from` (mirrors the sim's movement rule). */
  function stepCost(from: Vec2, to: Vec2): number {
    const diagonal = from.x !== to.x && from.y !== to.y;
    const tile = tileTypeAt(state.grid, to.x, to.y);
    const base = tile && !tile.blocksMove ? tile.moveCost : Infinity;
    return diagonal ? Math.floor(base * TU_COST.DIAGONAL_MULT) : base;
  }

  interface MovePreview {
    path: Vec2[];
    cost: number;
    reachable: boolean;
  }

  function reservedTu(unit: Unit): number {
    if (unit.reserve === "none") return 0;
    const weapon = state.weapons[unit.weaponId];
    const mode = weapon?.modes.find((candidate) => candidate.kind === unit.reserve);
    return mode ? Math.ceil((unit.stats.timeUnits * mode.tuPercent) / 100) : 0;
  }

  function objectiveClicked(tile: Vec2): boolean {
    return !!state.objective &&
      !state.objective.recovered &&
      tile.x === state.objective.target.x &&
      tile.y === state.objective.target.y;
  }

  function extractionClicked(tile: Vec2): boolean {
    return !!state.objective &&
      state.objective.recovered &&
      !state.objective.extracted &&
      state.objective.extractionZone.some((zone) => zone.x === tile.x && zone.y === tile.y);
  }

  function isObjectiveCarrier(unit: Unit): boolean {
    return !!state.objective &&
      state.objective.recovered &&
      !state.objective.extracted &&
      state.objective.recoveredBy === unit.id;
  }

  function visibleEnemySet(): Set<number> {
    return visibleEnemyIds(state, "player");
  }

  function knownOccupantAt(tile: Vec2, visibleEnemies = visibleEnemySet()): Unit | undefined {
    const occupant = unitAt(state, tile);
    if (!occupant) return undefined;
    if (occupant.faction === "player") return occupant;
    return visibleEnemies.has(occupant.id) ? occupant : undefined;
  }

  function knownPathBlocker(unit: Unit, visibleEnemies = visibleEnemySet()): (x: number, y: number) => boolean {
    return (x: number, y: number): boolean =>
      state.units.some(
        (other) =>
          other.alive &&
          other.id !== unit.id &&
          other.pos.x === x &&
          other.pos.y === y &&
          (other.faction === "player" || visibleEnemies.has(other.id)),
      );
  }

  function objectiveApproachTile(unit: Unit): Vec2 | null {
    const objective = state.objective;
    if (!objective || objective.recovered) return null;
    const candidates: Array<{ tile: Vec2; cost: number; pathLength: number }> = [];
    const visibleEnemies = visibleEnemySet();
    const isBlocked = knownPathBlocker(unit, visibleEnemies);

    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const tile = { x: objective.target.x + dx, y: objective.target.y + dy };
        const terrain = tileTypeAt(state.grid, tile.x, tile.y);
        if (!terrain || terrain.blocksMove || knownOccupantAt(tile, visibleEnemies)) continue;
        const result = findPath(state.grid, unit.pos, tile, { isBlocked });
        if (!result || result.path.length === 0) continue;
        candidates.push({ tile, cost: result.cost, pathLength: result.path.length });
      }
    }

    candidates.sort((a, b) => a.cost - b.cost || a.pathLength - b.pathLength || a.tile.y - b.tile.y || a.tile.x - b.tile.x);
    return candidates[0]?.tile ?? null;
  }

  /** The affordable prefix of the cheapest path from `unit` to `tile`, or null. */
  function previewPath(unit: Unit, tile: Vec2): MovePreview | null {
    const isBlocked = knownPathBlocker(unit);
    const result = findPath(state.grid, unit.pos, tile, { isBlocked });
    if (!result || result.path.length === 0) return null;

    const affordable: Vec2[] = [];
    let prev: Vec2 = unit.pos;
    let spent = 0;
    const budget = Math.max(0, unit.tu - reservedTu(unit));
    for (const step of result.path) {
      const cost = stepCost(prev, step);
      if (!Number.isFinite(cost) || spent + cost > budget) break;
      spent += cost;
      affordable.push(step);
      prev = step;
    }
    if (affordable.length === 0) return null;
    return {
      path: affordable,
      cost: spent,
      reachable: affordable.length === result.path.length,
    };
  }

  function toggleAudio(): boolean {
    const muted = sfx.toggleMute();
    pushLog(muted ? "Audio muted" : "Audio enabled");
    refreshHud();
    return muted;
  }

  // -------------------------------------------------------------------------
  // In-process screen transitions (no URL reloads)
  // -------------------------------------------------------------------------

  /** Abort the current mission (records a failure) and return to the geoscape. */
  function abortMissionToGeoscape(): void {
    if (state.status === "playing") completeMission("failure");
    disposeTactical();
    showGeoscape();
  }

  /** Leave the tactical view after mission completion and return to base. */
  function returnToBase(): void {
    const updated = completedCampaign ?? currentCampaign ?? loadCampaign();
    disposeTactical();
    if (updated) showBase(updated);
    else showGeoscape();
  }

  /** Clear the campaign and present the new-game geoscape. */
  function startNewCampaign(): void {
    disposeTactical();
    // Flush before clearing so a pending debounced save can't resurrect it.
    flushSave();
    clearCampaign();
    showGeoscape();
  }

  /** Is `pos` currently inside any living player's vision? (players are static on the enemy turn) */
  function visibleToPlayers(pos: Vec2): boolean {
    return livingUnits(state, "player").some((p) => canSee(state.grid, p, pos));
  }

  // ---------------------------------------------------------------------------
  // Event playback
  // ---------------------------------------------------------------------------

  function logEvent(ev: GameEvent): void {
    switch (ev.type) {
      case "shot": {
        const name = unitById(state, ev.shooterId)?.name ?? "Unit";
        const hits = ev.rounds.filter((r) => r.hit).length;
        const dmg = ev.rounds.reduce((s, r) => s + r.damage, 0);
        const tag = ev.reaction ? " (reaction)" : "";
        const dmgStr = dmg > 0 ? ` for ${dmg}` : "";
        pushLog(`${name}${tag} fires ${ev.mode}: ${hits}/${ev.rounds.length} hit${dmgStr}`);
        break;
      }
      case "died": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} is down`);
        break;
      }
      case "objectiveRecovered": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} recovered ${ev.label}. Return it to the dropship.`);
        hud.notify("UFO CORE RECOVERED - EXTRACT", "success");
        break;
      }
      case "objectiveExtracted": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} extracted ${ev.label}.`);
        hud.notify("UFO CORE EXTRACTED", "success");
        break;
      }
      case "objectiveDropped": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} dropped ${ev.label}. Recover it again.`);
        hud.notify("CORE DROPPED", "danger");
        break;
      }
      case "faced": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        const dir = DIR8_NAMES[ev.dir] ?? String(ev.dir);
        pushLog(`${name} faces ${dir}`);
        break;
      }
      case "stanceChanged": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} ${ev.stance === "kneel" ? "kneels" : "stands up"}`);
        break;
      }
      case "reloaded": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} reloads (${ev.ammo} rounds ready)`);
        break;
      }
      case "itemThrown": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        const def = state.items?.[ev.itemId];
        pushLog(`${name} throws ${def?.name ?? ev.itemId}`);
        break;
      }
      case "blastDetonated": {
        const kills = ev.hits.filter((h) => h.killed).length;
        const dmg = ev.hits.reduce((s, h) => s + h.damage, 0);
        const killStr = kills > 0 ? ` (${kills} down)` : "";
        pushLog(`Detonation: ${ev.hits.length} hit${ev.hits.length === 1 ? "" : "s"} for ${dmg}${killStr}`);
        break;
      }
      case "itemUsed": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        const target = unitById(state, ev.targetId)?.name ?? "ally";
        const def = state.items?.[ev.itemId];
        pushLog(`${name} uses ${def?.name ?? ev.itemId} on ${target} (+${ev.healed} HP)`);
        break;
      }
      case "panicked": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        pushLog(`${name} panics (${ev.behavior})`);
        break;
      }
      case "moraleChanged":
        // Faint — only the morale bar in the HUD reflects this; no log spam.
        break;
      case "turnStarted":
        pushLog(
          ev.faction === "player" ? `Round ${ev.turn}: your move` : "Enemy activity",
        );
        hud.notify(
          ev.faction === "player" ? `ROUND ${ev.turn} - YOUR COMMAND` : "ENEMY ACTIVITY",
          ev.faction === "player" ? "success" : "danger",
        );
        break;
      case "gameOver":
        completeMission(ev.status === "player_win" ? "success" : "failure");
        pushLog(ev.status === "player_win" ? "Victory!" : "Squad lost.");
        hud.notify(
          ev.status === "player_win" ? "CRASH SITE SECURED" : "STRIKE TEAM LOST",
          ev.status === "player_win" ? "success" : "danger",
        );
        break;
      case "blocked":
        pushLog(`Order rejected: ${ev.reason}`);
        hud.notify(ev.reason.toUpperCase(), "danger");
        break;
      default:
        break;
    }
  }

  let completedCampaign: CampaignState | null = null;

  function completeMission(result: "success" | "failure"): void {
    if (completedCampaign) return;
    const latest = currentCampaign ?? campaign;
    const deployed = state.units
      .filter((unit) => unit.faction === "player" && unit.campaignSoldierId)
      .map((unit) => unit.campaignSoldierId!);
    const survivors = state.units
      .filter((unit) => unit.faction === "player" && unit.alive && unit.campaignSoldierId)
      .map((unit) => unit.campaignSoldierId!);
    const survivorHealth = Object.fromEntries(
      state.units
        .filter((unit) => unit.faction === "player" && unit.alive && unit.campaignSoldierId)
        .map((unit) => [
          unit.campaignSoldierId!,
          {
            hp: unit.hp,
            maxHp: unit.stats.health,
          },
        ]),
    );
    completedCampaign = recordMissionResult(
      latest,
      result,
      operation,
      { deployedSoldierIds: deployed, survivingSoldierIds: survivors, survivorHealth },
    );
    currentCampaign = completedCampaign;
    saveCampaign(completedCampaign);
  }

  async function animate(events: GameEvent[]): Promise<void> {
    for (const ev of events) {
      logEvent(ev);
      switch (ev.type) {
        case "moveStep": {
          const actor = unitById(state, ev.unitId);
          const playerControlled = actor?.faction === "player";
          const shown = playerControlled || visibleToPlayers(ev.to) || visibleToPlayers(ev.from);
          if (shown) {
            if (!playerControlled) renderer.focusOn(ev.to);
            // Throttle footsteps: moves arrive every ~150ms, off-screen ones stay silent.
            const now = performance.now();
            if (now - lastFootstepMs > 120) {
              sfx.move();
              lastFootstepMs = now;
            }
            await renderer.playMoveStep(ev);
          }
          break;
        }
        case "shot": {
          const shooter = unitById(state, ev.shooterId);
          if (shooter && shooter.faction === "enemy") renderer.focusOn(ev.targetPos);
          const kind: ProjectileKind =
            shooter?.weaponId === "plasma" ? "plasma" : shooter?.weaponId === "pistol" ? "pistol" : "rifle";
          sfx.shoot(kind);
          await renderer.playShot(ev, kind);
          // One impact per outcome keeps auto-fire from becoming a wall of clicks.
          if (ev.rounds.some((r) => r.hit)) sfx.impact(true);
          if (ev.rounds.some((r) => !r.hit)) sfx.impact(false);
          // Keep the log visibly current during long enemy turns.
          refreshHud();
          break;
        }
        case "died":
          sfx.death();
          await renderer.playDeath(ev);
          break;
        case "faced":
          // No travel to animate — post-dispatch syncFromState reflects the new
          // facing instantly. A subtle blip just acknowledges the pivot.
          sfx.select();
          break;
        case "itemThrown":
          await renderer.playThrowArc(ev.from, ev.to);
          break;
        case "blastDetonated":
          sfx.explosion();
          await renderer.playBlast(ev.center, ev.radius);
          refreshHud();
          break;
        case "itemUsed":
          sfx.heal();
          refreshHud();
          break;
        case "panicked":
          sfx.panic();
          hud.notify("OPERATIVE PANICKING", "danger");
          break;
        case "turnStarted":
          sfx.turn(ev.faction);
          break;
        default:
          break;
      }
    }
  }

  async function dispatch(cmd: Command): Promise<void> {
    if (busy || state.status !== "playing") return;
    busy = true;
    currentHover = null;
    renderer.clearPreview();
    refreshHud();

    const events = applyCommand(state, cmd);
    await animate(events);

    // Drop a stale selection (unit died or it is no longer the player's).
    const sel = selectedId !== null ? unitById(state, selectedId) : undefined;
    if (!sel || !sel.alive || sel.faction !== "player") {
      selectedId = null;
      renderer.setSelected(null);
    }

    renderer.syncFromState(state);
    if (selectedId !== null) renderer.setSelected(selectedId);
    // Re-show cover for the (possibly moved) selection; force since the unit's
    // tile may have changed even though its id has not.
    refreshCoverFor(selectedUnit(), true);

    // Auto-select a fresh unit at the start of the player's turn if none is held.
    if (selectedId === null && state.status === "playing" && state.activeFaction === "player") {
      const next = livingUnits(state, "player")[0];
      if (next) select(next.id);
    }

    busy = false;
    refreshHud();
  }

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------

  const canvas = renderer.domElementForInput();
  let down: { x: number; y: number } | null = null;
  let dragging = false;

  canvas.addEventListener("pointerdown", (e: PointerEvent) => {
    // Any gesture unlocks the (lazily created) AudioContext; idempotent + silent
    // until then, so calling it on every pointerdown is safe.
    void sfx.resume();
    if (e.button !== 0) return;
    down = { x: e.clientX, y: e.clientY };
    dragging = false;
  }, { signal: tacticalSignal });

  canvas.addEventListener("pointermove", (e: PointerEvent) => {
    if (down) {
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      if (dx * dx + dy * dy > CLICK_SLOP_PX * CLICK_SLOP_PX) dragging = true;
    }
    if (busy || dragging || state.status !== "playing") return;
    onHover(e.clientX, e.clientY);
  }, { signal: tacticalSignal });

  canvas.addEventListener("pointerup", (e: PointerEvent) => {
    if (e.button !== 0) {
      down = null;
      return;
    }
    const wasClick = down !== null && !dragging;
    down = null;
    if (!wasClick) return;
    // Cmd (Mac) or Ctrl (Win/Linux) reinterprets the click as a "face here".
    onClick(e.clientX, e.clientY, e.metaKey || e.ctrlKey);
  }, { signal: tacticalSignal });

  // Right-click cancels item-targeting mode (and suppresses the browser menu).
  canvas.addEventListener("contextmenu", (e: MouseEvent) => {
    if (itemTargeting) {
      e.preventDefault();
      clearTargeting();
    }
  }, { signal: tacticalSignal });

  function onHover(clientX: number, clientY: number): void {
    // Item-targeting mode has its own hover UX (throw range / heal eligibility).
    if (itemTargeting) {
      handleTargetingHover(clientX, clientY);
      return;
    }

    const sel = selectedUnit();
    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    const hoveredUnit = hoveredUnitId !== null ? unitById(state, hoveredUnitId) : undefined;
    // Cover indicators follow the selection, but while the cursor is over a
    // friendly figure they preview that operative's cover instead. Deduped by
    // unit id, so this is cheap across pointermove events.
    refreshCoverFor(
      hoveredUnit && hoveredUnit.alive && hoveredUnit.faction === "player"
        ? hoveredUnit
        : sel,
    );

    if (sel && hoveredUnitId !== null) {
      const target = unitById(state, hoveredUnitId);
      if (target && target.faction === "enemy" && target.alive) {
        renderer.showAimLine(sel.pos, target.pos);
        renderer.setHoverTile(null);
        const previews: HudHover["previews"] = {};
        for (const kind of MODES) previews[kind] = previewPlayerShot(state, sel.id, target.pos, kind);
        const activePreview = previews[currentMode];
        currentHover = {
          kind: "target",
          label: target.name,
          detail: activePreview?.possible
            ? `${Math.round(activePreview.hitChance * 100)}% hit chance with ${currentMode} fire`
            : activePreview?.reason ?? "No firing solution",
          previews,
        };
        refreshHud();
        return;
      }
    }

    const tile = renderer.raycastTile(clientX, clientY);
    const visibleEnemies = visibleEnemySet();
    const knownOccupant = tile ? knownOccupantAt(tile, visibleEnemies) : undefined;
    if (sel && tile && !knownOccupant) {
      const objectiveTarget = objectiveClicked(tile);
      const extractionTarget = extractionClicked(tile) && isObjectiveCarrier(sel);
      const extractsNow = extractionTarget && canExtractObjective(state, sel);
      const recoverNow = objectiveTarget && canRecoverObjective(state, sel);
      const moveTarget = objectiveTarget ? objectiveApproachTile(sel) : tile;
      const move = moveTarget ? previewPath(sel, moveTarget) : null;
      renderer.showPathPreview(move?.path ?? []);
      const terrain = tileTypeAt(state.grid, tile.x, tile.y);
      currentHover = move
        ? {
            kind: "move",
            label: objectiveTarget
              ? "Recover power source"
              : extractionTarget
                ? "Extract UFO core"
                : move.reachable
                  ? terrain?.label ?? "Destination"
                  : "Advance to movement limit",
            detail: objectiveTarget
                ? recoverNow
                  ? "Click to secure the UFO core."
                  : "Move adjacent to secure the UFO core."
            : extractionTarget
              ? extractsNow
                ? "The core carrier is at the dropship extraction zone."
                : move.reachable
                  ? "Move the core carrier onto the dropship extraction zone."
                  : "Advance the core carrier toward the dropship extraction zone."
            : terrain?.label,
            moveCost: move.cost,
            tuAfter: sel.tu - move.cost,
            reachable: move.reachable,
          }
        : recoverNow
          ? {
              kind: "move",
              label: "Recover power source",
              detail: "Click to secure the UFO core.",
              moveCost: 0,
              tuAfter: sel.tu,
              reachable: true,
            }
        : {
            kind: "blocked",
            label: objectiveTarget ? "Power source unreachable" : terrain?.blocksMove ? terrain.label : "No viable route",
            detail: objectiveTarget
              ? "No adjacent recovery position is reachable from here."
              : "This position cannot be reached with the current order.",
          };
    } else {
      renderer.showPathPreview([]);
      currentHover = null;
    }
    renderer.setHoverTile(tile);
    refreshHud();
  }

  function onClick(clientX: number, clientY: number, faceModifier: boolean): void {
    if (busy || state.status !== "playing") return;

    // Item-targeting mode intercepts all clicks before anything else.
    if (itemTargeting) {
      handleTargetingClick(clientX, clientY);
      return;
    }

    // Modifier-click pivots the selected soldier toward the clicked tile instead
    // of moving or shooting. executeFace spends rotation TU and never triggers
    // reactions. This branch always returns early, so a modifier-click can never
    // fall through to the select/move/shoot logic below.
    if (faceModifier) {
      const sel = selectedUnit();
      const tile = renderer.raycastTile(clientX, clientY);
      if (sel && tile && (tile.x !== sel.pos.x || tile.y !== sel.pos.y)) {
        void dispatch({ type: "face", unitId: sel.id, dir: dir8Towards(sel.pos, tile) });
      }
      return;
    }

    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    if (hoveredUnitId !== null) {
      const u = unitById(state, hoveredUnitId);
      if (u && u.alive && u.faction === "player") {
        select(u.id);
        return;
      }
      if (u && u.alive && u.faction === "enemy") {
        const sel = selectedUnit();
        if (sel) void dispatch({ type: "shoot", unitId: sel.id, target: u.pos, mode: currentMode });
        return;
      }
    }

    const tile = renderer.raycastTile(clientX, clientY);
    if (!tile) return;
    const visibleEnemies = visibleEnemySet();
    const occupant = knownOccupantAt(tile, visibleEnemies);
    if (occupant && occupant.alive && occupant.faction === "player") {
      select(occupant.id);
      return;
    }
    if (occupant && occupant.alive && occupant.faction === "enemy") {
      const sel = selectedUnit();
      if (sel) void dispatch({ type: "shoot", unitId: sel.id, target: occupant.pos, mode: currentMode });
      return;
    }
    const sel = selectedUnit();
    if (sel && !occupant) {
      if (objectiveClicked(tile)) {
        if (canRecoverObjective(state, sel)) void dispatch({ type: "recoverObjective", unitId: sel.id });
        else {
          const approach = objectiveApproachTile(sel);
          if (approach) void dispatch({ type: "move", unitId: sel.id, to: approach });
        }
        return;
      }
      void dispatch({ type: "move", unitId: sel.id, to: tile });
    }
  }

  function cyclePlayer(readyOnly = false): void {
    const living = livingUnits(state, "player").sort((a, b) => a.id - b.id);
    const units =
      readyOnly && living.some((unit) => unit.tu > 0)
        ? living.filter((unit) => unit.tu > 0)
        : living;
    if (units.length === 0) return;
    const idx = units.findIndex((u) => u.id === selectedId);
    const next = units[(idx + 1) % units.length] ?? units[0];
    if (next) select(next.id);
  }

  function cycleReserve(): void {
    const sel = selectedUnit();
    if (!sel) return;
    const idx = RESERVES.indexOf(sel.reserve);
    const next = RESERVES[(idx + 1) % RESERVES.length] ?? "none";
    setReserve(next);
  }

  window.addEventListener("keydown", (e: KeyboardEvent) => {
    switch (e.key) {
      case "Tab":
        e.preventDefault();
        cyclePlayer();
        break;
      case " ":
        e.preventDefault();
        cyclePlayer(true);
        break;
      case "1":
        setMode("snap");
        break;
      case "2":
        setMode("aimed");
        break;
      case "3":
        setMode("auto");
        break;
      case "r":
      case "R":
        cycleReserve();
        break;
      case "l":
      case "L":
        reloadSelected();
        break;
      case "Enter":
        void dispatch({ type: "endTurn" });
        break;
      case "Escape":
        // Cancel item-targeting mode first, then close the briefing, then deselect.
        if (itemTargeting) clearTargeting();
        else if (hud.isBriefingOpen()) hud.toggleBriefing(false);
        else select(null);
        break;
      case "h":
      case "H":
        hud.toggleBriefing();
        break;
      case "m":
      case "M": {
        toggleAudio();
        break;
      }
      case "k":
      case "K": {
        // Toggle the selected operative's stance (stand <-> kneel) via the same
        // dispatch path as the HUD button.
        const sel = selectedUnit();
        if (sel && !busy) {
          const next = (sel.stance ?? "stand") === "stand" ? "kneel" : "stand";
          void dispatch({ type: "setStance", unitId: sel.id, stance: next });
        }
        break;
      }
      default:
        break;
    }
  }, { signal: tacticalSignal });

  window.addEventListener("resize", () => renderer.resize(), { signal: tacticalSignal });

  // ---------------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------------

  renderer.syncFromState(state);
  hud.setMode(currentMode);
  pushLog(`${operation.codename} deployed. Locate the crash site.`);
  pushLog("Click to move. Hover a hostile for firing odds.");
  const first = livingUnits(state, "player")[0];
  if (first) select(first.id);
  refreshHud();

  // --- Camera movement: WASD / arrow keys pan, Q/E rotate (smooth, held keys) ---
  const heldKeys = new Set<string>();
  const CAMERA_KEYS = new Set([
    "w", "a", "s", "d", "q", "e",
    "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
  ]);
  function cameraKey(e: KeyboardEvent): string {
    return e.key.length === 1 ? e.key.toLowerCase() : e.key;
  }
  window.addEventListener("keydown", (e: KeyboardEvent) => {
    const k = cameraKey(e);
    if (!CAMERA_KEYS.has(k)) return;
    heldKeys.add(k);
    if (k.startsWith("Arrow")) e.preventDefault(); // don't scroll the page
  }, { signal: tacticalSignal });
  window.addEventListener("keyup", (e: KeyboardEvent) => heldKeys.delete(cameraKey(e)), { signal: tacticalSignal });
  window.addEventListener("blur", () => heldKeys.clear(), { signal: tacticalSignal });

  function applyCameraKeys(dt: number): void {
    let px = 0;
    let pf = 0;
    let rot = 0;
    if (heldKeys.has("d") || heldKeys.has("ArrowRight")) px += 1;
    if (heldKeys.has("a") || heldKeys.has("ArrowLeft")) px -= 1;
    if (heldKeys.has("w") || heldKeys.has("ArrowUp")) pf += 1;
    if (heldKeys.has("s") || heldKeys.has("ArrowDown")) pf -= 1;
    if (heldKeys.has("q")) rot += 1;
    if (heldKeys.has("e")) rot -= 1;
    if (px !== 0 || pf !== 0) {
      const speed = renderer.cameraDistance * 0.9 * dt; // pan faster when zoomed out
      renderer.panBy(px * speed, pf * speed);
    }
    if (rot !== 0) renderer.orbitYaw(rot * 1.2 * dt);
  }

  let lastFrameMs = performance.now();
  function frame(): void {
    if (!tacticalActive) return;
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    applyCameraKeys(dt);
    renderer.render();
    frameId = requestAnimationFrame(frame);
  }
  frameId = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot: show the saved campaign's base, or the new-game geoscape.
// ---------------------------------------------------------------------------

const existingCampaign = loadCampaign();
if (existingCampaign) showBase(existingCampaign);
else showGeoscape();
