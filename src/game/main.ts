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
  collectCaptures,
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
  PsiKind,
  ReserveMode,
  ShotKind,
  Unit,
  Vec2,
} from "../sim/index";
// PSI is the psionics tuning block (TU cost, range, MC hard cap). It is a value
// re-export from the sim's public types, not the index barrel, so import it
// directly — same path src/game/hud.ts already uses for MORALE/STANCE.
import { PSI, STANCE } from "../sim/types";
import type {
  BaseLocation,
  CampaignState,
  CampaignWeaponId,
  DifficultyLevel,
  OperationPlan,
  SoldierRank,
  SoldierStatGrowth,
} from "../campaign/types";
import {
  advanceGeoscape,
  startInterceptionEncounter,
  executeInterceptionAction,
  CORE_RECOVER_THRESHOLD,
  type InterceptionAction,
  type InterceptionOutcome,
} from "../campaign/geoscape";
import { alienBaseCrewRanks, canDeployToOperationSite, generateOperation, launchFinalAssault, ufoCrewRanks } from "../campaign/operations";
import {
  assignSoldierItem,
  assignSoldierWeapon,
  clearCampaign,
  buildFacility,
  buildNewBase,
  campaignSoldierStatBonus,
  createCampaign,
  deploymentItemIds,
  deploymentSoldiers,
  deploymentWeaponIds,
  launchDeploymentFlight,
  loadCampaign,
  purchaseWeapon,
  recordMissionResult,
  recruitSoldier,
  saveCampaign,
  setSoldierDeployment,
  startManufacturing,
  startResearch,
  unassignSoldierItem,
} from "../campaign/storage";

import { Sfx } from "./audio";
import { ratioToPercent } from "./uiFormat";
import type { ProjectileKind } from "./effects";
// The 3D view classes are imported as types only; their values are dynamically
// imported inside the screen-mount functions below so three.js stays out of the
// initial bundle and loads lazily on first mount. The Renderer and Hud types
// annotate the mount locals declared outside a try-block in startTactical
// (their values are still fetched via dynamic import()).
import type { BaseAlert, BaseView } from "./baseView";
import type { GeoCampaignEvent, GeoscapeView } from "./geoscape";
import type { PlaneCombatView } from "./planeCombatView";
import type { Renderer } from "./renderer";
import type {
  Hud,
  HudDebrief,
  HudDebriefCasualty,
  HudDebriefSurvivor,
  HudHover,
  HudPsiInfo,
  HudSoldierDetail,
} from "./hud";

/**
 * Per-mission stat growth = (cumulative growth after) − (cumulative growth before).
 * Returns undefined when either side is missing or the mission granted no growth.
 */
function thisMissionGrowth(
  before: SoldierStatGrowth | undefined,
  after: SoldierStatGrowth | undefined,
): SoldierStatGrowth | undefined {
  if (!before || !after) return undefined;
  const delta: SoldierStatGrowth = {
    timeUnits: after.timeUnits - before.timeUnits,
    health: after.health - before.health,
    reactions: after.reactions - before.reactions,
    firingAccuracy: after.firingAccuracy - before.firingAccuracy,
  };
  const grew =
    delta.timeUnits !== 0 ||
    delta.health !== 0 ||
    delta.reactions !== 0 ||
    delta.firingAccuracy !== 0;
  return grew ? delta : undefined;
}

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

/**
 * Lightweight full-viewport "Loading…" overlay shown while a 3D view's chunk
 * downloads. The 3D views (geoscape/base/tactical/plane-combat) are dynamically
 * imported, so three.js + the view module fetch on first mount; this covers the
 * gap between disposing the old screen and mounting the new one so the player
 * never stares at a blank #app. Returns a function that removes the overlay
 * once the view has mounted.
 */
function showScreenLoader(label: string): () => void {
  const el = document.createElement("div");
  el.className = "screen-loader";
  el.setAttribute("aria-busy", "true");
  el.setAttribute("role", "status");
  el.textContent = label;
  // Inline-styled and CSS-independent on purpose: this overlay must render before
  // any screen injects the uiTheme CSS (it covers the gap while a screen chunk
  // downloads or when one fails to load), so it can't rely on --ui-* custom
  // properties. Values are the Style Bible palette hardcoded (space #04070d, teal
  // accent #38e8d2, console border #1d3a4a).
  Object.assign(el.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    background: "#04070d",
    color: "#38e8d2",
    font: "600 13px/1 ui-monospace, SFMono-Regular, monospace",
    letterSpacing: "0.25em",
    textTransform: "uppercase",
    zIndex: "9999",
  });
  appRoot.appendChild(el);
  return () => {
    el.remove();
  };
}

/**
 * Recoverable full-viewport error overlay shown when a screen chunk fails to
 * import or its constructor throws (e.g. WebGL context acquisition fails).
 * Replaces the blank #app / locked loader with a message + recovery actions so
 * the player is never stuck. `onRetry` re-runs the failed mount; the geoscape
 * fallback is always offered as the safe return path.
 */
function showScreenError(label: string, onRetry: (() => void) | null): void {
  const el = document.createElement("div");
  el.className = "screen-error";
  el.setAttribute("role", "alert");
  const msg = document.createElement("div");
  msg.textContent = label;
  Object.assign(msg.style, { marginBottom: "20px" });
  el.appendChild(msg);
  const actions = document.createElement("div");
  Object.assign(actions.style, { display: "flex", gap: "12px", flexWrap: "wrap", justifyContent: "center" });
  if (onRetry) {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.textContent = "Retry";
    retry.addEventListener("click", () => { el.remove(); onRetry(); });
    actions.appendChild(retry);
  }
  const back = document.createElement("button");
  back.type = "button";
  back.textContent = "Return to geoscape";
  back.addEventListener("click", () => { el.remove(); void showGeoscape(); });
  actions.appendChild(back);
  el.appendChild(actions);
  // Inline-styled and CSS-independent on purpose (see showScreenLoader): this must
  // render even when a screen chunk fails to import, i.e. before any view injects
  // the uiTheme CSS, so it hardcodes the Style Bible palette (space #04070d, signal
  // red #ff4a3a, teal accent #38e8d2, console glass) rather than --ui-* vars.
  Object.assign(el.style, {
    position: "absolute",
    inset: "0",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    background: "#04070d",
    color: "#ff4a3a",
    font: "600 13px/1.6 ui-monospace, SFMono-Regular, monospace",
    letterSpacing: "0.15em",
    textTransform: "uppercase",
    zIndex: "9999",
    textAlign: "center",
    padding: "24px",
  });
  for (const btn of el.querySelectorAll("button")) {
    Object.assign(btn.style, {
      background: "rgba(10, 20, 32, 0.82)",
      border: "1px solid #38e8d2",
      color: "#dff4f0",
      font: "inherit",
      padding: "8px 16px",
      borderRadius: "6px",
      cursor: "pointer",
    });
  }
  appRoot.appendChild(el);
}

/**
 * Minimal non-blocking error toast for the global error backstop. Pinned to the
 * corner so it never covers gameplay; auto-dismisses after a few seconds and on
 * click. Keeps an uncaught error from white-screening the game silently.
 */
function showErrorToast(message: string): void {
  const el = document.createElement("div");
  el.className = "error-toast";
  el.setAttribute("role", "alert");
  el.textContent = message;
  // Inline-styled and CSS-independent on purpose: the global error backstop must
  // surface even if the failure happened before/while a screen injected uiTheme
  // CSS. Style Bible console-glass panel with a signal-red (#ff4a3a) danger edge.
  Object.assign(el.style, {
    position: "fixed",
    bottom: "16px",
    left: "16px",
    zIndex: "10000",
    background: "rgba(10, 20, 32, 0.82)",
    color: "#dff4f0",
    border: "1px solid #1d3a4a",
    borderLeft: "3px solid #ff4a3a",
    font: "500 12px/1.5 ui-monospace, SFMono-Regular, monospace",
    padding: "10px 14px",
    borderRadius: "6px",
    maxWidth: "min(420px, 80vw)",
    cursor: "pointer",
  });
  const dismiss = () => el.remove();
  el.addEventListener("click", dismiss, { once: true });
  document.body.appendChild(el);
  window.setTimeout(dismiss, 8000);
}

// Global error backstop: any uncaught throw or unhandled promise rejection that
// escapes a screen mount (or surfaces later from a view) is logged and surfaced
// as a non-blocking toast so the game never silently white-screens. The mount
// functions below have their own targeted try/catch for the known failure modes
// (failed dynamic import, WebGL context acquisition); this catches everything
// else.
window.addEventListener("error", (event: ErrorEvent) => {
  console.error("[xcom] Uncaught error:", event.error ?? event.message);
  showErrorToast(`Error: ${event.message || "unknown"}`);
});
window.addEventListener("unhandledrejection", (event: PromiseRejectionEvent) => {
  const reason = event.reason;
  console.error("[xcom] Unhandled promise rejection:", reason);
  showErrorToast(`Error: ${reason instanceof Error ? reason.message : String(reason)}`);
});

let geoscape: GeoscapeView | null = null;
let baseView: BaseView | null = null;
/** Teardown for an active tactical view, invoked before mounting any other screen. */
let tacticalCleanup: (() => void) | null = null;
/** Active interception dogfight screen; mounted in place of the geoscape during an encounter. */
let planeCombat: PlaneCombatView | null = null;

/**
 * Shared audio controller. A single Sfx backs the screen ambience beds and the
 * tactical SFX so the AudioContext and mute state are shared across screens.
 * The context is created lazily and starts suspended until the first gesture.
 */
const sfx = new Sfx();
// Browsers block audio until a user gesture; unlock on the first pointerdown so
// the geoscape/base ambience beds (mounted before any gesture) can start.
window.addEventListener("pointerdown", () => { void sfx.resume(); }, { once: true });

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

/**
 * Campaign events detected while the geoscape (Command Center room) is mounted are
 * queued here and flushed to the base view as facility beacons + toasts the moment
 * the player returns to base (see showBase). The geoscape shows its own transient
 * toast for the on-globe case; this queue is what carries an event fired on the
 * globe back to the base's facility beacons. Deduped by nothing — every distinct
 * detected event surfaces once.
 */
const pendingAlerts: BaseAlert[] = [];

/** Human-readable species label for a captured alien's sim template id, used in
 *  the debrief + containment readouts (falls back to the raw id if unknown). */
const CAPTIVE_SPECIES_LABELS: Record<string, string> = {
  drone: "Drone",
  stalker: "Stalker",
  sentinel: "Sentinel",
  heavy: "Heavy",
  commander: "Commander",
};
function captiveSpeciesLabel(templateId: string): string {
  return CAPTIVE_SPECIES_LABELS[templateId] ?? templateId;
}

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

// Flush any pending debounced save when the page is torn down (tab close,
// navigate away, or mobile background-discard within the 400ms debounce
// window). pagehide fires reliably on both desktop tab-close and mobile
// bfcache-discard; visibilitychange:hidden adds coverage for mobile tab-switch.
// flushSave is synchronous and idempotent (no-op when nothing is pending), so
// registering both is safe. Registered once at module load.
window.addEventListener("pagehide", () => flushSave(), { capture: true });
window.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});

/**
 * Shared GeoscapeView callback set. Every closure advances from the in-memory
 * `currentCampaign` (not localStorage, which goes stale while a debounced save is
 * pending), and routes screen transitions through the in-process helpers below.
 * Extracted so both the normal geoscape mount and the deployment-flight mount
 * (mission launch) build identical views.
 */
function buildGeoscapeCallbacks(campaign: CampaignState | null) {
  return {
    campaign,
    onConfirmBase: (base: BaseLocation, difficulty?: DifficultyLevel) => {
      // "Review base" mid-campaign must NOT recreate the campaign (that would
      // wipe soldiers, research, facilities, resources, and the seed). Only the
      // new-game flow (no saved campaign) calls createCampaign; otherwise we
      // just return to the existing base.
      flushSave();
      const existing = loadCampaign();
      if (existing) {
        geoscape?.dispose();
        geoscape = null;
        void showBase(existing);
        return;
      }
      const created = createCampaign(base, newCampaignSeed(), difficulty ?? "veteran");
      saveCampaign(created);
      geoscape?.dispose();
      geoscape = null;
      void showBase(created);
    },
    onAdvanceTime: (hours: number) => {
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
      // The interception now plays as THEATER on the geoscape itself: the interceptor
      // flies the great-circle out to the UFO, the dogfight beats animate over the
      // globe, and the encounter resolves in place. startInterceptionEncounter no-ops
      // (leaves `interception` unset) unless the contact is a tracked crashSite with a
      // ready interceptor; either way we refresh the geoscape rather than switching
      // screens (no more instant snap to a separate dogfight view).
      geoscape?.update(currentCampaign);
    },
    onInterceptionAction: (action: InterceptionAction) => {
      // Applied only AFTER the geoscape's combat beat has played (precompute ->
      // animate -> reveal). executeInterceptionAction is pure + deterministic, so
      // this reproduces exactly the outcome the beat previewed.
      if (!currentCampaign) return;
      currentCampaign = executeInterceptionAction(currentCampaign, action);
      debouncedSave(currentCampaign);
      geoscape?.update(currentCampaign);
    },
    onZoomToDogfight: (nextCampaign: CampaignState) => {
      // THE ZOOM: the pursuit layer fires this the instant interceptionRangeKm
      // crosses <=ENGAGEMENT_RANGE_KM. Persist immediately (a screen swap is about
      // to tear the geoscape down) and hand off to the cinematic dogfight screen.
      currentCampaign = nextCampaign;
      debouncedSave(currentCampaign);
      void mountPlaneCombat(currentCampaign);
    },
    onInterceptorSfx: (kind: "launch" | "cannon" | "bolt" | "explosion") => {
      sfx.interception(kind);
    },
    onLaunchAssault: () => {
      // Final decapitating strike on the revealed alien HQ. Build the assault
      // operation (guarded by canLaunchFinalAssault inside launchFinalAssault) and
      // hand straight to the tactical controller — there is no UFO contact/flight
      // for the HQ; startTactical bypasses the contact requirement for the assault.
      const current = currentCampaign ?? campaign;
      if (!current || current.strategic.status !== "active") return;
      // The final assault uses the same squad as a ground deployment. If a Skyranger
      // is mid-transit (or on station) delivering that squad to a contact, launching
      // the HQ assault would fight two places at once and recordMissionResult would
      // silently drop the in-transit flight. Gate it at the model level.
      if ((current.activeFlights ?? []).some((f) => f.purpose === "deployment")) return;
      const plan = launchFinalAssault(current);
      if (!plan) return;
      flushSave();
      currentCampaign = current;
      void startTactical(current, plan);
    },
    onBuildNewBase: (location: BaseLocation) => {
      if (!currentCampaign) return;
      currentCampaign = buildNewBase(currentCampaign, location);
      debouncedSave(currentCampaign);
      geoscape?.update(currentCampaign);
    },
    onResetCampaign: () => {
      // Flush before clearing so a pending debounced save can't resurrect it.
      flushSave();
      clearCampaign();
      currentCampaign = null;
      // Drop any alerts queued on the dead campaign's globe so they don't beacon /
      // toast into the next campaign's first base mount.
      pendingAlerts.length = 0;
      void showGeoscape();
    },
    onBackToBase: () => {
      // The geoscape is mounted as the Command Center room; "Back to Base" reverses
      // the dive to the base overview. showBase disposes this geoscape.
      if (currentCampaign) void showBase(currentCampaign);
    },
    onLaunchMission: () => {
      // NON-BLOCKING launch: instead of freezing the globe while the Skyranger flies,
      // append a tracked deployment flight and keep time live. The transport now
      // renders from activeFlights (B's geoscape marker); on arrival the geoscape
      // fires onDeploymentArrived and offers a DEPLOY chip — entering battle stays a
      // player click (onBeginAssault), never automatic. Read the live in-memory state
      // so deployment/weapons/operation match the current squad.
      const current = currentCampaign ?? campaign;
      if (!current || current.strategic.status !== "active") return;
      const contact = current.ufoContact;
      const contactStatus = contact?.status;
      if (!contact || (contactStatus !== "crashed" && contactStatus !== "landed")) return;
      // Only one deployment flight at a time — the transport (and the squad aboard) is
      // a single shared asset. Without this a player could launch a second squad to a
      // different contact while the first is still airborne (the per-contact guard in
      // launchDeploymentFlight only dedupes the SAME contact).
      if ((current.activeFlights ?? []).some((f) => f.purpose === "deployment")) return;
      // Guard the deployment here too (the geoscape CTA already hides itself for an
      // empty squad): without a deployable operative there is nothing to fly, and the
      // arrival DEPLOY click would enter a battle with no squad. Bail before launch.
      if (deploymentSoldiers(current).length === 0) return;
      currentCampaign = launchDeploymentFlight(current, contact.id);
      flushSave();
      geoscape?.update(currentCampaign);
    },
    onDeploymentArrived: (flightId: string) => {
      // The deployment run reached its site. Persist arrived:true on that flight so
      // the DEPLOY chip survives save/load; the chip + arrival toast are B's job.
      if (!currentCampaign) return;
      const flights = currentCampaign.activeFlights ?? [];
      const idx = flights.findIndex((flight) => flight.id === flightId);
      if (idx === -1 || flights[idx]!.arrived === true) return;
      const updated = [...flights];
      updated[idx] = { ...updated[idx]!, arrived: true };
      currentCampaign = { ...currentCampaign, activeFlights: updated };
      flushSave();
    },
    onBeginAssault: (contactId: string) => {
      // The ONLY path into the ground battle from a deployment. Fired by the player's
      // DEPLOY chip click on arrival — never automatically. Enter the battlescape via
      // the unchanged startTactical path (generateOperation derives the op from the
      // live contact). The in-flight deployment flight is cleared once the mission
      // resolves via recordMissionResult clearing the contact.
      const current = currentCampaign ?? campaign;
      if (!current || current.strategic.status !== "active") return;
      const contact = current.ufoContact;
      if (!contact || contact.id !== contactId) return;
      if (deploymentSoldiers(current).length === 0) return;
      flushSave();
      currentCampaign = current;
      void startTactical(current);
    },
    onCampaignEvent: (event: GeoCampaignEvent) => {
      // Map the geoscape's granular event onto a base alert (structurally identical
      // string-literal unions). If a base view is somehow already mounted (headless
      // advance path), beacon it immediately; otherwise queue for the next showBase.
      const alert: BaseAlert = { kind: event.kind, message: event.message };
      if (baseView) baseView.pushAlert(alert);
      else pendingAlerts.push(alert);
    },
  };
}

/** Dispose any prior geoscape, build + mount a fresh one bound to `campaign`.
 *  Returns null if the chunk import or constructor threw (a recoverable error
 *  overlay is shown in that case; callers should bail). */
async function mountGeoscape(campaign: CampaignState | null): Promise<GeoscapeView | null> {
  const hideLoader = showScreenLoader("Loading…");
  geoscape?.dispose();
  try {
    // three.js + the geoscape module load lazily here, on first screen mount.
    const { GeoscapeView: GeoscapeCtor } = await import("./geoscape");
    geoscape = new GeoscapeCtor(buildGeoscapeCallbacks(campaign));
    geoscape.mount(appRoot);
    return geoscape;
  } catch (err) {
    // Dispose a half-constructed geoscape (constructor OK but mount threw) so
    // it doesn't leak DOM/listeners; null the slot so a retry mounts fresh.
    geoscape?.dispose();
    geoscape = null;
    console.error("[xcom] Failed to mount geoscape:", err);
    showScreenError("Failed to load the geoscape.", () => { void mountGeoscape(campaign); });
    return null;
  } finally {
    hideLoader();
  }
}

/**
 * One-time "sortie report" alert for a terminal interception outcome. Pushed
 * through the same BaseAlert channel as onCampaignEvent so it beacons the next
 * time the base is mounted; the aircraft card also picks up
 * `lastInterceptionReport.summary` (campaign layer) for the persistent readout.
 * A dedicated push is required here (rather than relying on the geoscape's own
 * before/after snapshot diffing) because returning from the dogfight remounts a
 * FRESH GeoscapeView whose snapshot already reflects the resolved campaign — the
 * diff would see no change and stay silent.
 */
function queueInterceptionOutcomeAlert(outcome: InterceptionOutcome): void {
  const pct = Math.round(outcome.salvageQuality * 100);
  let message: string;
  switch (outcome.kind) {
    case "crashed":
      message =
        outcome.salvageQuality < CORE_RECOVER_THRESHOLD
          ? `UFO shot down — crash site salvage ${pct}%, elerium core lost in the wreck.`
          : `UFO shot down — crash site salvage ${pct}%, core intact for recovery.`;
      break;
    case "vaporized":
      message = "UFO vaporized by overkill fire — no crash site, only scattered debris recovered.";
      break;
    case "escaped":
      message = "UFO outran the intercept — contact lost.";
      break;
    case "brokeOff":
      message = "Interceptor broke off the engagement, damaged — returning to base for repairs.";
      break;
    default:
      // Exhaustiveness guard: keeps `message` definitely-assigned even while
      // InterceptionOutcomeKind is still mid-rollout upstream (see contract v1).
      message = "Interception report filed.";
  }
  const alert: BaseAlert = { kind: "interceptionReport", message };
  if (baseView) baseView.pushAlert(alert);
  else pendingAlerts.push(alert);
}

/**
 * Dispose the geoscape and mount the dedicated interception dogfight screen for an
 * active encounter. The view's onAction advances the encounter in place and
 * re-renders; onResolve fires once the encounter reaches a terminal outcome
 * (crashed/vaporized/escaped/brokeOff), tearing the screen down and returning to
 * the globe. Crashed contacts remain a deployable crash site; vaporized/escaped
 * contacts are already cleared by the campaign-layer resolver by the time the
 * outcome reaches us.
 */
async function mountPlaneCombat(campaign: CampaignState): Promise<void> {
  geoscape?.dispose();
  geoscape = null;
  planeCombat?.dispose();
  const hideLoader = showScreenLoader("Loading…");
  try {
    const { PlaneCombatView: PlaneCombatCtor } = await import("./planeCombatView");
    planeCombat = new PlaneCombatCtor({
      campaign,
      onAction: (action: InterceptionAction) => {
        if (!currentCampaign) return;
        currentCampaign = executeInterceptionAction(currentCampaign, action);
        debouncedSave(currentCampaign);
        planeCombat?.update(currentCampaign);
      },
      onResolve: (outcome: InterceptionOutcome) => {
        planeCombat?.dispose();
        planeCombat = null;
        // Screen transition: persist the terminal campaign immediately rather than
        // leaving it on the debounce timer.
        flushSave();
        queueInterceptionOutcomeAlert(outcome);
        void showGeoscape();
      },
      onSfx: (kind: "cannon" | "missile" | "bolt" | "explosion") => {
        sfx.interception(kind);
      },
    });
    planeCombat.mount(appRoot);
  } catch (err) {
    // Dispose a half-constructed dogfight screen so it doesn't leak, then offer
    // recovery: retry the encounter, or abandon it and return to the globe.
    planeCombat?.dispose();
    planeCombat = null;
    console.error("[xcom] Failed to mount interception screen:", err);
    showScreenError("Failed to load the interception screen.", () => { void mountPlaneCombat(campaign); });
  } finally {
    hideLoader();
  }
}

async function showGeoscape(): Promise<void> {
  flushSave();
  // Seed the in-memory campaign once from storage; every geoscape callback then
  // advances from `currentCampaign` instead of re-reading localStorage (which
  // returns stale state while a debounced save is pending).
  currentCampaign = loadCampaign();
  disposeTacticalIfExists();
  baseView?.dispose();
  baseView = null;
  planeCombat?.dispose();
  planeCombat = null;
  // A saved encounter already past THE ZOOM (phase "engagement") resumes straight
  // into the cinematic dogfight instead of re-mounting the globe underneath it —
  // e.g. a reload mid-engagement, or returning here from the base while an
  // engagement is still open. onZoomToDogfight only fires the live transition;
  // this covers every other path back to "the geoscape".
  if (currentCampaign?.interception?.phase === "engagement") {
    await mountPlaneCombat(currentCampaign);
    return;
  }
  const view = await mountGeoscape(currentCampaign);
  if (view) sfx.startAmbience("geoscape");
}

async function showBase(campaign: CampaignState): Promise<void> {
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
  planeCombat?.dispose();
  planeCombat = null;
  const hideLoader = showScreenLoader("Loading…");
  try {
  const { BaseView: BaseViewCtor } = await import("./baseView");
  baseView = new BaseViewCtor({
    campaign,
    operation,
    onEnterCommandCenter: () => {
      // The Command Center room IS the geoscape. Clicking the command facility (or
      // the __baseEnterRoom test hook) mounts the globe in place of a DOM room;
      // showGeoscape disposes this base view. Mission launch + intercept + objective
      // progress all live on the geoscape now (contract D).
      void showGeoscape();
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
    onAssignItem: (soldierId, itemId) => {
      const base = currentCampaign ?? campaign;
      const updated = assignSoldierItem(base, soldierId, itemId);
      if (updated === base) return;
      currentCampaign = updated;
      debouncedSave(updated);
      baseView?.update(updated);
    },
    onUnassignItem: (soldierId, itemId) => {
      const base = currentCampaign ?? campaign;
      const updated = unassignSoldierItem(base, soldierId, itemId);
      if (updated === base) return;
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
    onResetCampaign: () => {
      // Flush before clearing so a pending debounced save can't resurrect it.
      flushSave();
      clearCampaign();
      currentCampaign = null;
      // Drop any alerts queued on the dead campaign's globe so they don't beacon /
      // toast into the next campaign's first base mount.
      pendingAlerts.length = 0;
      void showGeoscape();
    },
  });
  baseView.mount(appRoot);
  // Surface any events that fired on the globe (queued while no base view was
  // mounted) as facility beacons + toasts now that the base is up.
  if (pendingAlerts.length > 0) {
    for (const alert of pendingAlerts) baseView.pushAlert(alert);
    pendingAlerts.length = 0;
  }
  } catch (err) {
    // Dispose a half-constructed base view (constructor OK but mount threw) so
    // it doesn't leak, then surface a recoverable overlay. Without this catch a
    // failed import/construct leaves hideLoader unreached via the catch path —
    // the finally still clears the loader, and this offers retry/recovery.
    baseView?.dispose();
    baseView = null;
    console.error("[xcom] Failed to mount base screen:", err);
    showScreenError("Failed to load the base screen.", () => { void showBase(campaign); });
    return;
  } finally {
    hideLoader();
  }
  sfx.startAmbience("base");
}

/** Aggregate (sum) of a campaign's per-region panic — the debrief's panic-delta basis. */
function aggregatePanic(campaign: CampaignState): number {
  return Object.values(campaign.regionalPanic).reduce((sum, value) => sum + value, 0);
}

async function startTactical(campaign: CampaignState, operation: OperationPlan = generateOperation(campaign)): Promise<void> {
  flushSave();
  const deployment = deploymentSoldiers(campaign);
  // The final alien-base assault has NO UFO contact — its site is the revealed HQ
  // location, so it bypasses the contact guards (see canDeployToOperationSite).
  const isAssaultOp = operation.missionType === "alienBaseAssault";
  // Bail unless the campaign is active, a squad is deployed, and the operation has
  // a reachable deploy site. canDeployToOperationSite centralizes the contact rules
  // (crashed-over-land / landed for regular ops; unconditional for the assault) so
  // a stale over-ocean contact can never silently swallow the assault launch.
  if (
    campaign.strategic.status !== "active" ||
    deployment.length === 0 ||
    !canDeployToOperationSite(campaign, operation)
  ) {
    return;
  }
  disposeTacticalIfExists();
  geoscape?.dispose();
  geoscape = null;
  baseView?.dispose();
  baseView = null;
  planeCombat?.dispose();
  planeCombat = null;
  const SEED = operation.missionSeed;
  // Map the campaign mission type onto the sim's objective + civilian spawn so
  // each mission type is actually playable: a terror site builds a rescue
  // objective with civilians to protect, a crashed/landed UFO builds the classic
  // "recover the power source" objective, and a base defense has no objective.
  const missionType = operation.missionType;
  const isAssault = isAssaultOp;
  const missionObjective =
    missionType === "terror"
      ? {
          objectiveKind: "rescue" as const,
          civilianCount: operation.missionContext?.civilianCount ?? 8,
        }
      : missionType === "crashSite" || missionType === "landedUfo"
        ? { objectiveKind: "recover" as const }
        : {};
  // Rank channel: the alien-base assault fields its fixed elite garrison (always a
  // commander + leader); a UFO-crew mission fields the composition its ufoType
  // rolls. Passing enemyRanks makes those ranks land on the spawned hostiles so
  // captures carry the ranks that gate interrogation research. Deterministic in
  // the mission seed; omitted (legacy spawn) when no ufoType is known.
  const enemyRanks = isAssault
    ? alienBaseCrewRanks(SEED, operation.enemyCount)
    : campaign.ufoContact?.ufoType
      ? ufoCrewRanks(campaign.ufoContact.ufoType, SEED, operation.enemyCount)
      : undefined;
  // "alienBase" is a registered (special) sim theme aliasing the urban layout, so
  // it resolves deterministically for every createSkirmish caller. The assault
  // additionally forces deep-night lighting so the HQ reads distinctly dark/alien
  // via the existing time-of-day tint hook.
  const themeId = operation.themeId;
  const hourOfDay = isAssault ? 0 : campaign.clock.hour;
  let state: BattleState = createSkirmish({
    seed: SEED,
    width: operation.width,
    height: operation.height,
    players: deployment.length,
    enemies: operation.enemyCount,
    ...(enemyRanks ? { enemyRanks } : {}),
    themeId,
    hourOfDay,
    playerWeaponIds: deploymentWeaponIds(campaign),
    playerItems: deploymentItemIds(campaign),
    playerNames: deployment.map((soldier) => soldier.name),
    playerSoldierIds: deployment.map((soldier) => soldier.id),
    playerStatBonuses: deployment.map((soldier) => campaignSoldierStatBonus(campaign, soldier)),
    ...missionObjective,
  });

  // Tactical-scoped state. Declared before the mount try-block so it stays in
  // scope for the entire loop below regardless of whether the dynamic import or
  // view construction succeeds (the try only guards the failure-prone chunk
  // import + renderer/HUD construction + mount).
  let selectedId: number | null = null;
  let currentMode: ShotKind = "snap";
  let currentHover: HudHover | null = null;
  let busy = false;
  let lastFootstepMs = 0; // throttles move() so fast paths don't machine-gun

  /** id of the unit whose directional cover indicators are shown (dedupe; null = cleared). */
  let coverFocusId: number | null = null;

  /** Active item-targeting mode (throw a grenade / heal an ally / stun an enemy), or null. */
  let itemTargeting: { kind: "throw" | "heal" | "stun"; itemId: string } | null = null;

  /** Active psi-targeting mode (panic / mind control), or null. The next enemy
   *  click resolves into a `psiAttack` command; right-click / ESC cancels. */
  let psiTargeting: { kind: PsiKind } | null = null;

  /** Guards against double-dispose and stops the rAF loop on teardown. */
  let tacticalActive = true;
  let frameId = 0;
  /** AbortController whose signal is attached to every tactical listener. */
  const tacticalAbort = new AbortController();
  const tacticalSignal = tacticalAbort.signal;

  // Declared outside the try so the catch can dispose a half-constructed view
  // and the rest of the function can use them. The catch returns on failure, so
  // both are assigned before first use below. `!` asserts definite assignment to
  // the compiler; `?.` in the catch still guards the runtime case where the
  // import/constructor threw before assignment.
  let renderer!: Renderer;
  let hud!: Hud;

  const hideLoader = showScreenLoader("Deploying…");
  try {
  // three.js, the tactical renderer, and the HUD load lazily here on first
  // battlescape mount. Fetch both chunks in parallel while the loader shows.
  const [{ Renderer: RendererCtor }, { Hud: HudCtor }] = await Promise.all([
    import("./renderer"),
    import("./hud"),
  ]);
  renderer = new RendererCtor();
  renderer.mount(appRoot);

  // Switch the shared ambience bed to the tactical wind/rumble. The same `sfx`
  // instance backs all tactical SFX below, so mute carries over from the globe.
  sfx.startAmbience("tactical");

  hud = new HudCtor({
    onEndTurn: () => void dispatch({ type: "endTurn" }),
    onSelectMode: (kind) => setMode(kind),
    onSetReserve: (mode) => setReserve(mode),
    onReload: () => reloadSelected(),
    onSelectUnit: (id) => select(id),
    onToggleMute: () => toggleAudio(),
    onOpenGeoscape: () => abortMissionToGeoscape(),
    onReturnToBase: () => returnToBase(),
    onThrowItem: (itemId) => beginTargeting("throw", itemId),
    onUseItem: (itemId) => {
      // The motion scanner is a self-use device: activate it on the spot instead
      // of entering ally-targeting (which is the medkit flow).
      const def = state.items?.[itemId];
      if (def?.kind === "scanner") activateScanner(itemId);
      // The stun rod strikes an adjacent HOSTILE (capture tool), not an ally.
      else if (def?.kind === "stunRod") beginTargeting("stun", itemId);
      else beginTargeting("heal", itemId);
    },
    onPrimeItem: (itemId) => primeSelected(itemId),
    onRetrieveItem: (itemId) => retrieveSelected(itemId),
    onStowItem: (itemId) => stowSelected(itemId),
    onPsiAttack: (kind) => beginPsiTargeting(kind),
    onSetStance: (stance) => {
      const sel = selectedUnit();
      if (sel && !busy) void dispatch({ type: "setStance", unitId: sel.id, stance });
    },
    onOpenSoldierDetail: () => refreshHud(),
    onNewCampaign: () => startNewCampaign(),
  });
  hud.mount(appRoot);
  } catch (err) {
    // Dispose any half-constructed view (renderer up but HUD failed, or vice
    // versa) so GPU resources / listeners do not leak. `?.` guards the runtime
    // case where the import/constructor threw before assignment (the `!` type
    // assertion only satisfies the compiler); the inner try/catch guards a
    // dispose() that itself throws on a partially-built instance. Then surface a
    // recoverable overlay (retry the same battle or return to the geoscape)
    // instead of stranding the player on a blank/locked "Deploying…" screen.
    try { hud?.dispose(); } catch { /* half-constructed — ignore */ }
    try { renderer?.dispose(); } catch { /* half-constructed — ignore */ }
    console.error("[xcom] Failed to mount tactical screen:", err);
    showScreenError("Failed to deploy the strike team.", () => { void startTactical(campaign, operation); });
    return;
  } finally {
    hideLoader();
  }

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
      psi: psiInfoFor(selectedUnit()),
    });
  }

  function currentDebrief(): HudDebrief | undefined {
    if (!completedCampaign?.lastMission) return undefined;
    const report = completedCampaign.lastMission;
    const soldiers = completedCampaign.soldiers;
    const byId = new Map(soldiers.map((soldier) => [soldier.id, soldier]));
    const before = missionBefore?.soldiers ?? new Map();
    const elapsed = completedCampaign.clock.elapsedHours;

    const kia: HudDebriefCasualty[] = report.kiaSoldierIds.map((id) => {
      const soldier = byId.get(id);
      return {
        id,
        name: soldier?.name ?? id,
        rank: soldier?.rank ?? "rookie",
        ...(soldier?.bio ? { bio: soldier.bio } : {}),
      };
    });

    const survivorIds = report.deployedSoldierIds.filter(
      (id) => !report.kiaSoldierIds.includes(id),
    );
    const survivors: HudDebriefSurvivor[] = survivorIds.map((id) => {
      const soldier = byId.get(id);
      const previous = before.get(id);
      const wounded = report.woundedSoldierIds.includes(id);
      const woundRecoveryHours =
        wounded && soldier?.woundedUntilHour !== undefined
          ? Math.max(0, soldier.woundedUntilHour - elapsed)
          : undefined;
      const growthDelta = thisMissionGrowth(previous?.statGrowth, soldier?.statGrowth);
      return {
        id,
        name: soldier?.name ?? id,
        rank: soldier?.rank ?? "rookie",
        ...(previous && soldier && previous.rank !== soldier.rank
          ? { previousRank: previous.rank }
          : {}),
        ...(wounded
          ? { wounded: true, ...(woundRecoveryHours !== undefined ? { woundRecoveryHours } : {}) }
          : {}),
        ...(growthDelta ? { statGrowth: growthDelta } : {}),
      };
    });

    const casualties = kia.map((entry) => entry.name);
    const missionScore = missionBefore
      ? completedCampaign.strategic.score - missionBefore.score
      : undefined;

    // Strategic deltas derived by diffing the pre-mission snapshot (threat/funding/
    // panic captured in completeMission) against the recorded post-mission state.
    // Panic uses the aggregate (sum) across regions, so a successful mission's local
    // panic drop reads as a negative (good-direction) delta.
    const threatDelta = missionBefore
      ? completedCampaign.strategic.threat - missionBefore.threat
      : undefined;
    const fundingDelta = missionBefore
      ? completedCampaign.strategic.funding - missionBefore.funding
      : undefined;
    const panicDelta = missionBefore
      ? aggregatePanic(completedCampaign) - missionBefore.panic
      : undefined;

    // Objective progress: the operation's primary objective (done on a win) plus,
    // for terror ops, an explicit civilian-rescue line derived from the report tally.
    const objectives: { label: string; done: boolean }[] = [
      { label: operation.objective, done: report.result === "success" },
    ];
    if (
      report.missionType === "terror" &&
      report.civilianCount !== undefined &&
      report.civilianCount > 0
    ) {
      const rescued = report.civiliansRescued ?? 0;
      objectives.push({
        label: `Rescue civilians (${rescued}/${report.civilianCount})`,
        done: rescued >= report.civilianCount,
      });
    }

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
      kia,
      survivors,
      ...(missionScore !== undefined ? { missionScore } : {}),
      ...(threatDelta !== undefined ? { threatDelta } : {}),
      ...(fundingDelta !== undefined ? { fundingDelta } : {}),
      ...(panicDelta !== undefined ? { panicDelta } : {}),
      ...(objectives.length > 0 ? { objectives } : {}),
      ...(report.civiliansRescued !== undefined ? { civiliansRescued: report.civiliansRescued } : {}),
      ...(report.civilianCasualties !== undefined
        ? { civilianCasualties: report.civilianCasualties }
        : {}),
      ...(missionCaptures ? { captures: missionCaptures } : {}),
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

  function beginTargeting(kind: "throw" | "heal" | "stun", itemId: string): void {
    if (busy || state.status !== "playing") return;
    itemTargeting = { kind, itemId };
    const def = state.items?.[itemId];
    const label = def?.name ?? itemId;
    hud.notify(
      kind === "throw"
        ? `CLICK A TILE TO THROW ${label.toUpperCase()}`
        : kind === "stun"
          ? `CLICK AN ADJACENT ENEMY TO STUN WITH ${label.toUpperCase()}`
          : `CLICK AN ADJACENT ALLY TO USE ${label.toUpperCase()}`,
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

  /** Move a stowed backpack item into hand for BACKPACK.RETRIEVE_TU_PERCENT. */
  async function retrieveSelected(itemId: string): Promise<void> {
    if (busy || state.status !== "playing") return;
    const sel = selectedUnit();
    if (!sel) return;
    const beforeTu = sel.tu;
    const name = sel.name;
    const itemName = state.items?.[itemId]?.name ?? itemId;
    await dispatch({ type: "retrieveItem", unitId: sel.id, itemId });
    // Success emits no GameEvent (types frozen); confirm via TU spend + location.
    const after = unitById(state, sel.id);
    const inst = after?.items?.find((it) => it.itemId === itemId);
    if (after && inst && inst.location !== "backpack" && after.tu < beforeTu) {
      const spent = beforeTu - after.tu;
      pushLog(`${name} retrieves ${itemName} (−${spent} TU)`);
      hud.notify(`RETRIEVED ${itemName.toUpperCase()}`, "info");
    }
  }

  /** Move a hand item back into the backpack for BACKPACK.STOW_TU_PERCENT. */
  async function stowSelected(itemId: string): Promise<void> {
    if (busy || state.status !== "playing") return;
    const sel = selectedUnit();
    if (!sel) return;
    const beforeTu = sel.tu;
    const name = sel.name;
    const itemName = state.items?.[itemId]?.name ?? itemId;
    await dispatch({ type: "stowItem", unitId: sel.id, itemId });
    const after = unitById(state, sel.id);
    const inst = after?.items?.find((it) => it.itemId === itemId);
    if (after && inst && inst.location === "backpack" && after.tu < beforeTu) {
      const spent = beforeTu - after.tu;
      pushLog(`${name} stows ${itemName} (−${spent} TU)`);
      hud.notify(`STOWED ${itemName.toUpperCase()}`, "info");
    }
  }

  /** Immediately activate a motion scanner on the selected unit (self-use device). */
  function activateScanner(itemId: string): void {
    if (busy || state.status !== "playing") return;
    const sel = selectedUnit();
    if (!sel) return;
    void dispatch({ type: "useItem", unitId: sel.id, targetId: sel.id, itemId });
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

    // stun: strike an adjacent (in-reach) hostile with the stun rod.
    if (itemTargeting.kind === "stun") {
      const def = state.items?.[itemTargeting.itemId];
      const reach = def?.reach ?? 1;
      const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
      if (hoveredUnitId !== null) {
        const target = unitById(state, hoveredUnitId);
        if (
          target &&
          target.alive &&
          !target.unconscious &&
          target.faction === "enemy" &&
          chebyshev(sel.pos, target.pos) <= reach
        ) {
          void dispatch({ type: "useItem", unitId: sel.id, targetId: target.id, itemId: itemTargeting.itemId });
          clearTargeting();
        } else {
          hud.notify("TARGET MUST BE AN ADJACENT ENEMY", "danger");
        }
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
        const effect =
          def?.kind === "smoke"
            ? `smoke cloud ${def.blastRadius ?? 2}`
            : def?.kind === "proxMine"
              ? `mine (blast ${def.blastRadius ?? 2})`
              : `blast ${def?.blastRadius ?? 1}`;
        currentHover = {
          kind: inRange ? "move" : "blocked",
          label: `Throw ${name}`,
          detail: inRange
            ? `Click to throw (${effect}). ${sel.tu} TU left.`
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

    // stun: highlight whether the hovered unit is a valid in-reach hostile
    if (itemTargeting.kind === "stun") {
      const reach = def?.reach ?? 1;
      const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
      const target = hoveredUnitId !== null ? unitById(state, hoveredUnitId) : undefined;
      const valid =
        !!target &&
        target.alive &&
        !target.unconscious &&
        target.faction === "enemy" &&
        chebyshev(sel.pos, target.pos) <= reach;
      renderer.setHoverTile(null);
      renderer.showPathPreview([]);
      currentHover = valid
        ? {
            kind: "target",
            label: target!.name,
            detail: `Click to strike with ${name} (+${def?.stunPower ?? 0} stun, ${target!.stun}/${target!.hp}). ${sel.tu} TU left.`,
          }
        : {
            kind: "blocked",
            label: `Stun ${name}`,
            detail: "Click an adjacent enemy to build stun.",
          };
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

  // -------------------------------------------------------------------------
  // Psi-targeting mode
  // -------------------------------------------------------------------------

  function beginPsiTargeting(kind: PsiKind): void {
    if (busy || state.status !== "playing") return;
    const sel = selectedUnit();
    if (!sel || (sel.stats.psiSkill ?? 0) <= 0) return;
    if (sel.controlledByFaction !== undefined) {
      hud.notify("CONTROLLED UNITS CANNOT CAST PSI", "danger");
      return;
    }
    if (kind === "mindControl" && (state.mcUsedThisBattle ?? 0) >= PSI.MC_MAX_PER_BATTLE) {
      hud.notify("MIND CONTROL HARD CAP REACHED", "danger");
      return;
    }
    psiTargeting = { kind };
    hud.setPsiTargeting(kind);
    hud.notify(
      kind === "mindControl" ? "CLICK A VISIBLE ENEMY TO SEIZE CONTROL" : "CLICK A VISIBLE ENEMY TO PSI-PANIC",
      "info",
    );
    renderer.clearPreview();
    currentHover = null;
    refreshHud();
  }

  function clearPsiTargeting(): void {
    if (!psiTargeting) return;
    psiTargeting = null;
    hud.setPsiTargeting(null);
    renderer.clearPreview();
    currentHover = null;
    refreshHud();
  }

  /** Resolve a psi-targeting click: a visible enemy fires the psi command. */
  function handlePsiClick(clientX: number, clientY: number): void {
    const sel = selectedUnit();
    if (!sel) {
      clearPsiTargeting();
      return;
    }
    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    if (hoveredUnitId === null) return;
    const target = unitById(state, hoveredUnitId);
    if (target && target.alive && target.faction === "enemy") {
      const kind = psiTargeting?.kind;
      if (!kind) return;
      clearPsiTargeting();
      void dispatch({ type: "psiAttack", unitId: sel.id, targetId: target.id, kind });
    } else {
      hud.notify("TARGET MUST BE A VISIBLE ENEMY", "danger");
    }
  }

  /** Hover hint while in psi-targeting mode. */
  function handlePsiHover(clientX: number, clientY: number): void {
    const sel = selectedUnit();
    if (!sel || !psiTargeting) return;
    const hoveredUnitId = renderer.raycastUnit(clientX, clientY);
    const target = hoveredUnitId !== null ? unitById(state, hoveredUnitId) : undefined;
    const valid = !!target && target.alive && target.faction === "enemy";
    renderer.setHoverTile(null);
    renderer.showPathPreview([]);
    if (valid && target) {
      renderer.showAimLine(sel.pos, target.pos);
      const verb = psiTargeting.kind === "mindControl" ? "seize control of" : "psi-panic";
      currentHover = {
        kind: "target",
        label: target.name,
        detail: `Click to ${verb} ${target.name}. ${sel.tu} TU left.`,
      };
    } else {
      currentHover = {
        kind: "blocked",
        label: psiTargeting.kind === "mindControl" ? "Mind Control" : "Panic",
        detail: "Click a visible enemy.",
      };
    }
    refreshHud();
  }

  /** TU cost of a psi action (mirrors executePsiAttack: PSI.TU_PERCENT of max TU). */
  function psiTuCost(unit: Unit): number {
    return Math.ceil((unit.stats.timeUnits * PSI.TU_PERCENT) / 100);
  }

  /** HUD psi-availability for the selected operative (costs + MC hard cap). */
  function psiInfoFor(unit: Unit | null): HudPsiInfo | undefined {
    if (!unit || (unit.stats.psiSkill ?? 0) <= 0) return undefined;
    const cost = psiTuCost(unit);
    const playerTurn = state.activeFaction === "player" && state.status === "playing" && !busy;
    const mcSpent = (state.mcUsedThisBattle ?? 0) >= PSI.MC_MAX_PER_BATTLE;
    const controlled = unit.controlledByFaction !== undefined;
    return {
      panicTuCost: cost,
      panicAvailable: playerTurn && !controlled && unit.tu >= cost,
      mcTuCost: cost,
      mcAvailable: playerTurn && !controlled && !mcSpent && unit.tu >= cost,
      mcSpent,
    };
  }

  /**
   * TU to enter `to` from the adjacent `from` (mirrors the sim's movement
   * rule, including the kneel-move surcharge — see executeMove in battle.ts —
   * so a kneeling unit's previewed TU cost matches what the command actually
   * spends).
   */
  function stepCost(from: Vec2, to: Vec2, stanceMult = 1): number {
    const diagonal = from.x !== to.x && from.y !== to.y;
    const tile = tileTypeAt(state.grid, to.x, to.y);
    const base = tile && !tile.blocksMove ? tile.moveCost : Infinity;
    const diagonalMult = diagonal ? TU_COST.DIAGONAL_MULT : 1;
    return Math.floor(base * diagonalMult * stanceMult);
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
    const stanceMult = unit.stance === "kneel" ? STANCE.KNEEL_MOVE_MULT : 1;
    for (const step of result.path) {
      const cost = stepCost(prev, step, stanceMult);
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
    void showGeoscape();
  }

  /** Leave the tactical view after mission completion and return to base. */
  function returnToBase(): void {
    const updated = completedCampaign ?? currentCampaign ?? loadCampaign();
    disposeTactical();
    if (updated) void showBase(updated);
    else void showGeoscape();
  }

  /** Clear the campaign and present the new-game geoscape. */
  function startNewCampaign(): void {
    disposeTactical();
    // Flush before clearing so a pending debounced save can't resurrect it.
    flushSave();
    clearCampaign();
    // Drop any alerts queued on the dead campaign's globe (see onResetCampaign).
    pendingAlerts.length = 0;
    void showGeoscape();
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
      case "scanActivated": {
        const name = unitById(state, ev.unitId)?.name ?? "Unit";
        const def = state.items?.[ev.itemId];
        pushLog(`${name} sweeps with ${def?.name ?? ev.itemId} (radius ${ev.radius})`);
        break;
      }
      case "minePlaced": {
        pushLog(`Proximity mine armed at (${ev.pos.x}, ${ev.pos.y})`);
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
  /**
   * Snapshot of each deployed operative's rank + stat growth, plus the strategic
   * score, taken the instant a mission resolves. Lets the debrief derive per-mission
   * promotions, stat growth, and the mission-score delta by diffing against the
   * post-`recordMissionResult` campaign state.
   */
  let missionBefore: {
    score: number;
    threat: number;
    funding: number;
    /** Aggregate (sum) of all regional panic pre-mission, for the debrief panic delta. */
    panic: number;
    soldiers: Map<string, { rank: SoldierRank; statGrowth?: SoldierStatGrowth }>;
  } | null = null;

  /** Live-capture tally for the debrief: aliens secured into containment this
   *  mission (by rank/species) vs lost, with the intake's containment context so
   *  the readout can tell "no facility" from "facility full". Read from the intake
   *  report recordMissionResult exposes; null when none taken. */
  let missionCaptures: {
    secured: { rank: string; species: string }[];
    lostCount: number;
    hadContainment: boolean;
    held: number;
    capacity: number;
  } | null = null;

  function completeMission(result: "success" | "failure"): void {
    if (completedCampaign) return;
    const latest = currentCampaign ?? campaign;
    missionBefore = {
      score: latest.strategic.score,
      threat: latest.strategic.threat,
      funding: latest.strategic.funding,
      panic: aggregatePanic(latest),
      soldiers: new Map(
        latest.soldiers.map((soldier) => [
          soldier.id,
          {
            rank: soldier.rank,
            ...(soldier.statGrowth ? { statGrowth: soldier.statGrowth } : {}),
          },
        ]),
      ),
    };
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
    // Terror missions: tally the civilian outcome from the live battle state so
    // the campaign records who was saved and who was lost. Living civilians at
    // mission end count as rescued; the rest are casualties. Non-terror missions
    // leave these undefined (no civilians on the map).
    const isTerror = operation.missionType === "terror";
    const civilians = isTerror
      ? state.units.filter((unit) => unit.faction === "civilian")
      : [];
    const civiliansRescued = civilians.filter((unit) => unit.alive).length;
    // Capture bridge: on a player victory every hostile still unconscious on the
    // field is taken alive. The debrief/recordMissionResult turns these into
    // stored captives IF a base has containment (capacity-capped; excess lost).
    const captures = result === "success" ? collectCaptures(state) : [];
    completedCampaign = recordMissionResult(
      latest,
      result,
      operation,
      {
        deployedSoldierIds: deployed,
        survivingSoldierIds: survivors,
        survivorHealth,
        ...(captures.length > 0 ? { captures } : {}),
        ...(isTerror
          ? {
              civilianCount: civilians.length,
              civiliansRescued,
              civilianCasualties: Math.max(0, civilians.length - civiliansRescued),
            }
          : {}),
      },
    );
    // Debrief capture tally: read the intake outcome recorded by
    // recordMissionResult (computed BEFORE any interrogation research consumed a
    // just-secured captive) rather than diffing the roster — so a captive secured
    // this mission and immediately spent on research still counts as secured.
    const intake = completedCampaign.lastCaptiveIntake;
    if (intake && (intake.secured.length > 0 || intake.lost > 0)) {
      missionCaptures = {
        secured: intake.secured.map((c) => ({
          rank: c.rank as string,
          species: captiveSpeciesLabel(c.templateId),
        })),
        lostCount: intake.lost,
        hadContainment: intake.hadContainment,
        held: intake.held,
        capacity: intake.capacity,
      };
    } else {
      missionCaptures = null;
    }
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
        case "psiUsed": {
          // Panic that lands uses the panic sting; any resisted psi gets a soft
          // blip. A successful mind-control psi is silent here — its cue rides on
          // the mindControlled event that immediately follows.
          if (ev.kind === "panic" && ev.success) sfx.panic();
          else if (!ev.success) sfx.select();
          if (!ev.success) hud.notify("PSI ATTACK RESISTED", "danger");
          refreshHud();
          break;
        }
        case "stunStrike": {
          // Non-lethal takedown: electric FX + zap SFX + a floating stun number.
          const target = unitById(state, ev.targetId);
          if (target) renderer.focusOn(target.pos);
          sfx.stun(ev.knockedOut === true);
          await renderer.playStunStrike(ev);
          if (ev.knockedOut) hud.notify("HOSTILE KNOCKED OUT — CAPTURED ON VICTORY", "success");
          refreshHud();
          break;
        }
        case "woke": {
          // A stunned hostile shook it off and is back in the fight.
          sfx.woke();
          hud.notify("STUNNED HOSTILE REVIVED", "danger");
          refreshHud();
          break;
        }
        case "knockedOut": {
          // Damage (gunfire/blast/reaction) drove a stunned unit's hp down to its
          // stun pool — it falls unconscious. A hostile is captured on victory; a
          // downed soldier is out of the fight. The pose lands on the post-loop sync.
          const target = unitById(state, ev.unitId);
          if (target) renderer.focusOn(target.pos);
          sfx.stun(true);
          hud.notify(
            target?.faction === "enemy"
              ? "HOSTILE KNOCKED OUT — CAPTURED ON VICTORY"
              : "SOLDIER KNOCKED OUT",
            target?.faction === "enemy" ? "success" : "danger",
          );
          refreshHud();
          break;
        }
        case "mindControlled": {
          // Who seized whom decides tone: player grabs an enemy => success chime;
          // alien commander grabs one of ours => danger sting + toast.
          if (ev.faction === "player") {
            sfx.heal();
            hud.notify("ENEMY MIND-CONTROLLED", "success");
          } else {
            sfx.panic();
            hud.notify("OPERATIVE MIND-CONTROLLED", "danger");
          }
          refreshHud();
          break;
        }
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

    try {
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
    } catch (err) {
      // The sim reducer should be the source of truth and not throw, but a
      // reducer/animation fault must not become an unrecoverable input lock —
      // release `busy` so the player can keep playing (turn preserved).
      console.error("dispatch failed", err);
      hud.notify("Action failed — turn preserved", "danger");
    } finally {
      busy = false;
      refreshHud();
    }
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

  // Right-click cancels item- or psi-targeting mode (and suppresses the browser menu).
  canvas.addEventListener("contextmenu", (e: MouseEvent) => {
    if (itemTargeting || psiTargeting) {
      e.preventDefault();
      if (itemTargeting) clearTargeting();
      if (psiTargeting) clearPsiTargeting();
    }
  }, { signal: tacticalSignal });

  function onHover(clientX: number, clientY: number): void {
    // Psi-targeting mode has its own hover UX (target a visible enemy).
    if (psiTargeting) {
      handlePsiHover(clientX, clientY);
      return;
    }
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
      // An unconscious (captured) hostile is neutralized — never a shoot target.
      if (target && target.faction === "enemy" && target.alive && !target.unconscious) {
        renderer.showAimLine(sel.pos, target.pos);
        renderer.setHoverTile(null);
        const previews: HudHover["previews"] = {};
        for (const kind of MODES) previews[kind] = previewPlayerShot(state, sel.id, target.pos, kind);
        const activePreview = previews[currentMode];
        currentHover = {
          kind: "target",
          label: target.name,
          detail: activePreview?.possible
            ? `${ratioToPercent(activePreview.hitChance)} hit chance with ${currentMode} fire`
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
            label: (() => {
              const base = objectiveTarget
                ? "Recover power source"
                : extractionTarget
                  ? "Extract UFO core"
                  : move.reachable
                    ? terrain?.label ?? "Destination"
                    : "Advance to movement limit";
              return sel.stance === "kneel" ? `${base} · kneeling ×${STANCE.KNEEL_MOVE_MULT}` : base;
            })(),
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
            : sel.stance === "kneel"
              ? `${terrain?.label ?? "Destination"} — kneeling moves cost ×${STANCE.KNEEL_MOVE_MULT} TU`
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

    // Psi-targeting mode intercepts all clicks before anything else.
    if (psiTargeting) {
      handlePsiClick(clientX, clientY);
      return;
    }

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
      if (u && u.alive && u.faction === "enemy" && !u.unconscious) {
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
    if (occupant && occupant.alive && occupant.faction === "enemy" && !occupant.unconscious) {
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
        // Cancel psi-targeting, then item-targeting, then close the briefing,
        // then deselect — innermost armed mode clears first.
        if (psiTargeting) clearPsiTargeting();
        else if (itemTargeting) clearTargeting();
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
  // Re-arm requestAnimationFrame BEFORE renderer.render() so a single render
  // throw (context loss, transient bad uniform/effect) only costs one frame
  // instead of permanently terminating the loop — matches geoscape/planeCombat.
  // Swallow render errors after the first to avoid console spam during a
  // persistent fault (e.g. until the context-lost handler re-mounts).
  let renderErrorLogged = false;
  function frame(): void {
    if (!tacticalActive) return;
    frameId = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastFrameMs) / 1000);
    lastFrameMs = now;
    applyCameraKeys(dt);
    try {
      renderer.render();
    } catch (err) {
      if (!renderErrorLogged) {
        renderErrorLogged = true;
        console.error("tactical render failed", err);
      }
    }
  }
  frameId = requestAnimationFrame(frame);
}

// ---------------------------------------------------------------------------
// Boot: show the saved campaign's base, or the new-game geoscape.
// ---------------------------------------------------------------------------

const existingCampaign = loadCampaign();
if (existingCampaign) void showBase(existingCampaign);
else void showGeoscape();
