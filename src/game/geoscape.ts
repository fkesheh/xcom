import {
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  type Object3D,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Raycaster,
  RingGeometry,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { UI_TOKENS, UI_BASE, UI_COMPONENTS, UI_PRIMITIVES } from "./uiTheme";
import { formatCredits, formatHours, formatPercent, formatSignedCredits, formatSpeed, groupThousands } from "./uiFormat";

import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
  MissionType,
  UfoContact,
  UfoType,
} from "../campaign/types";
import {
  canLaunchInterceptor,
  contactSpeedDegPerHour,
  ENGAGEMENT_RANGE_KM,
  formatCampaignClock,
  GEOSCAPE_SCAN_HOURS,
  greatCircleDestination,
  type InterceptionAction,
  interceptionForecast,
  type InterceptionSpeedAdvantage,
  interceptionSpeedAdvantage,
  isInterceptorReady,
  STERN_ESCAPE_KM,
  ufoTypeInfo,
} from "../campaign/geoscape";
import { generateOperation } from "../campaign/operations";
import { activeSoldiers, campaignObjectiveProgress, canBuildNewBase, canLaunchFinalAssault, chooseInterceptor, craftSpeedDegPerHour, degPerHourToKmh, DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR, deploymentSoldiers, DIFFICULTY_CONFIGS, highestRegionalPanic, MAX_EXTRA_BASES, NEW_BASE_COST } from "../campaign/storage";
import {
  animateBeaconPulse,
  createEarthShaderMaterial,
  createGraticuleMaterial,
  createRimAtmosphere,
  makeCloudTexture,
  makeEarthTexture,
  makeGraticuleLatLine,
  makeGraticuleLonLine,
  populateBaseBeacon,
  populateCrashBeacon,
  populateExtraBaseBeacon,
  populateHqBeacon,
  populateUfoBeacon,
  type SurfaceBeacon,
} from "./globeVisuals";
import { WORLD_CITY_POINTS } from "./worldMapData";

/**
 * Granular campaign-event discriminator surfaced to NAV (main.ts) so it can route
 * each event to the base view as a facility beacon + toast. Mirrors the base
 * layer's BaseAlertKind (string-literal unions are structurally assignable, so NAV
 * maps this straight onto BaseAlert without a coupling import from baseView).
 */
export type GeoCampaignEventKind =
  | "ufoDetected"
  | "ufoShotDown"
  | "ufoLanded"
  | "interceptionReport"
  | "fundingReport"
  | "missionReport"
  | "campaignWon"
  | "campaignLost";

/** A notable campaign event detected while the geoscape is mounted (see detectEvent). */
export interface GeoCampaignEvent {
  kind: GeoCampaignEventKind;
  message: string;
}

interface GeoscapeOptions {
  campaign: CampaignState | null;
  /** difficulty is only supplied from the new-game screen; existing campaigns keep theirs. */
  onConfirmBase: (base: BaseLocation, difficulty?: DifficultyLevel) => void;
  onAdvanceTime: (hours: number) => void;
  onInterceptUfo: () => void;
  onResetCampaign: () => void;
  /** Fires for each Keep Chasing / Disengage choice during an active pursuit. */
  onInterceptionAction?: (action: InterceptionAction) => void;
  /** Presentation-only SFX cue for the interceptor launching on a fresh pursuit. */
  onInterceptorSfx?: (kind: "launch") => void;
  /**
   * Fired once the pursuit's real km gap closes to <=ENGAGEMENT_RANGE_KM (THE ZOOM).
   * NAV disposes the geoscape and mounts PlaneCombatView for the cinematic dogfight;
   * the pursuit act's job ends here — combat resolution lives in that view.
   */
  onZoomToDogfight?: (campaign: CampaignState) => void;
  /** Designate a new radar base on the globe (multi-base campaign). */
  onBuildNewBase?: (location: BaseLocation) => void;
  /** Launch the endgame final assault on the revealed alien HQ. */
  onLaunchAssault?: () => void;
  /**
   * Return from the geoscape (mounted as the Command Center room) back to the base
   * overview. Rendered as a "Back to Base" control only when a base exists (never on
   * the new-game difficulty screen).
   */
  onBackToBase?: () => void;
  /**
   * Launch the staged crash-site / landed-UFO recovery operation from the live
   * contact card. NAV replays the Skyranger deployment flight in place on the globe
   * (no screen hop), then enters the battlescape on arrival.
   */
  onLaunchMission?: () => void;
  /**
   * A non-blocking deployment flight reached its mission site (progress >= 1). NAV
   * (main.ts) persists `arrived: true` on that flight + saves so the DEPLOY chip
   * survives reload. Presentation (toast + pulsing DEPLOY chip) stays here in B.
   */
  onDeploymentArrived?: (flightId: string) => void;
  /**
   * The player clicked the "DEPLOY — begin assault" chip. NAV enters the
   * battlescape via startTactical — the ONLY path into battle, never automatic.
   */
  onBeginAssault?: (contactId: string) => void;
  /**
   * Fires once per notable campaign event detected while time flows (UFO detected /
   * shot down / landed, funding + interception + mission reports, campaign won/lost).
   * NAV queues these and surfaces them as base-facility beacons + toasts when the
   * player returns to base. The geoscape still shows its own transient toast.
   */
  onCampaignEvent?: (event: GeoCampaignEvent) => void;
}

export interface GeoscapeTimeAction {
  label: string;
  hours: number;
  disabled: boolean;
}

/** Which left-edge chip's modal is open. */
type GeoModalKind = "objective" | "contact" | "fleet" | "reports" | "council";

/** Status-dot tone for a floating left-edge chip. */
type GeoChipTone = "info" | "warn" | "danger" | "muted" | "done";

/** A descriptor for one reconciled chip in the left-edge rail. */
interface GeoChipDesc {
  key: string;
  icon: string;
  label: string;
  sub: string;
  tone: GeoChipTone;
  pulse?: boolean;
  /** Extra static class (e.g. "geo-chip-deploy"); folded into the stable className. */
  extraClass?: string;
  /** Fire the one-shot enter animation (only when this key first appears / re-enters). */
  enter?: boolean;
  onClick: () => void;
}

/** A cached, reusable chip node whose text/tone/handler are mutated in place. */
interface GeoChipHandle {
  chip: HTMLButtonElement;
  dot: HTMLSpanElement;
  icon: HTMLSpanElement;
  label: HTMLSpanElement;
  sub: HTMLSpanElement;
  className: string;
  onClick: () => void;
}

const STYLE_ID = "blacksite-geoscape-style";

/** localStorage key for the one-time first-run hints flag ("1" = already shown). */
const SEEN_HINTS_KEY = "xcom-seen-hints";

/** True when the first-run welcome tip has already been dismissed/suppressed.
 *  Defaults to "seen" if localStorage is unreachable so a sandbox never crashes
 *  the geoscape mount and the tip never recurs. */
function hintsSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_HINTS_KEY) === "1";
  } catch {
    return true;
  }
}
function markHintsSeen(): void {
  try {
    localStorage.setItem(SEEN_HINTS_KEY, "1");
  } catch {
    /* localStorage unavailable — treat as already seen. */
  }
}
const EARTH_RADIUS = 1.5;
const UP = new Vector3(0, 1, 0);

/** Sampling resolution of the base->UFO great-circle trajectory line. */
const TRAJECTORY_SEGMENTS = 24;
/**
 * Launch fly-out pacing. The duration derives from the REAL great-circle distance
 * base->UFO (radians) scaled by FLYOUT_MS_PER_RAD, clamped to [MIN,MAX] so a
 * near contact still reads as a proper fly-out (~6s) and a globe-spanning one
 * never drags (~14s). Slowed from the earlier 3200/4000-8000 pacing so the
 * cinematic interceptor no longer looks "way too fast" next to the clock-synced
 * transport transit — the two craft now read at a consistent, unhurried pace.
 */
const FLYOUT_MS_PER_RAD = 6500;
const FLYOUT_MIN_MS = 6000;
const FLYOUT_MAX_MS = 14000;
/**
 * Upper clamp on the SPEED-SCALED fly-out: when a UFO outruns the pursuer the
 * fly-out is stretched by 1/ratio (a fast target = a visibly slower closure), so
 * the ceiling is higher than the distance-only FLYOUT_MAX_MS to let that read.
 */
const FLYOUT_SPEED_MAX_MS = 18000;
/** Clamp band for the craft/UFO speed ratio used to pace the pursuit presentation. */
const PURSUIT_RATIO_MIN = 0.4;
const PURSUIT_RATIO_MAX = 2.5;
/** Clamp band for the drift-rate multiplier (1/ratio) so an outrun UFO pulls ahead. */
const PURSUIT_DRIFT_SCALE_MIN = 0.6;
const PURSUIT_DRIFT_SCALE_MAX = 2.4;
/** Arc fraction the launch flight covers; the remaining slice is range-driven closing. */
const INTERCEPTOR_FLIGHT_END = 0.82;
/** Per-frame ease factor pulling the displayed pursuit range (km) toward its target. */
const RANGE_EASE = 0.1;
/** Pursuit drift: the tracked UFO keeps flying during the fly-out (presentation-only,
 *  never written to campaign state) so the interceptor visibly curves after it. */
const PURSUIT_DRIFT_RAD_PER_SEC = 0.02;
const PURSUIT_MAX_DRIFT_RAD = 0.14;
/** Weight of the interceptor position blended into the orbit target while engaging
 *  (0 = globe-centered, 1 = fully chase the craft). Gentle so the globe stays read. */
const CHASE_TARGET_WEIGHT = 0.22;
/** Per-frame ease factor pulling the orbit target toward its chase goal. */
const CHASE_EASE = 0.05;
/** Sampling resolution of the base->site Skyranger trajectory line. */
const DEPLOYMENT_SEGMENTS = 32;

/** Max sampled points of the UFO flight trail (one per refresh while airborne). */
const UFO_TRAIL_MAX = 48;
/** Minimum degrees between two trail samples (avoids a dense blob when the UFO creeps). */
const UFO_TRAIL_MIN_DEG = 0.4;
/** Max sampled points of an in-flight craft's contrail (one per refresh while flying). */
const FLIGHT_TRAIL_MAX = 24;
/** Min degrees between two flight-trail samples (avoids a dense blob when creeping). */
const FLIGHT_TRAIL_MIN_DEG = 0.4;

/**
 * Id of the UFO contact whose "new detection" slide+glow entrance has already been
 * played. Module-scoped (NOT per-instance) because main.ts disposes and recreates the
 * GeoscapeView on every screen switch: a per-instance flag would reset to "unseen" on
 * each remount and replay the alert for a contact that has been tracked for hours. The
 * animation fires only on the transition to a contact id we have not announced yet.
 */
let announcedContactId: string | null = null;

/** Contrail particles per craft (ring buffer; no per-frame allocation). */
const CONTRAIL_MAX = 36;

interface SpeedOption {
  speed: number;
  icon: string;
  label: string;
}

/** Time-flow speed controls (replacing the legacy single Scan button). 0 = paused. */
const SPEED_OPTIONS: readonly SpeedOption[] = [
  { speed: 0, icon: "⏸", label: "Pause" },
  { speed: 1, icon: "▸", label: "1×" },
  { speed: 5, icon: "▸▸", label: "5×" },
  { speed: 30, icon: "⏭", label: "30×" },
];

/**
 * Per-speed tick cadence at MINUTE granularity so the clock visibly flows HH:MM.
 * Each tick advances a few game-minutes (hours expressed as a fraction of 60);
 * the campaign clock derives HH:MM from the fractional part of elapsedHours.
 * Tuned so 1x reads near real-time, 5x streams minutes, and 30x sweeps tens of
 * minutes per tick without spamming onAdvanceTime.
 */
const SPEED_TICKS: Record<number, { hours: number; ms: number }> = {
  1: { hours: 1 / 60, ms: 700 }, // ~1 game-min/tick  ≈ 0.024 game-h/s (near real-time)
  5: { hours: 5 / 60, ms: 400 }, // ~5 game-min/tick  ≈ 0.21 game-h/s (~12.5 game-min/s)
  30: { hours: 1.0, ms: 250 }, //  60 game-min/tick ≈ 4 game-h/s (a full day in ~6s)
};

/** Auto-pause toast kind; pairs an icon with the color so the alert is never color-alone. */
type EventKind = "info" | "won" | "lost" | "council";
interface EventInfo {
  kind: EventKind;
  text: string;
  /** Granular discriminator NAV maps onto a base-facility beacon (see GeoCampaignEvent).
   *  BaseAlertKind (base view, frozen for this track) has no dedicated council slot, so
   *  the council event reuses "fundingReport" for that external routing — the geoscape's
   *  own blocking modal (kind "council") is what actually surfaces the debrief. */
  alertKind: GeoCampaignEventKind;
}

/** Alert kinds that demand the player's attention and force-pause time flow. Routine
 *  radar noise (ufoDetected spawns, interceptionReport filings) stays a toast-only,
 *  non-pausing notice so 30x fast-forward doesn't get yanked back every few seconds. */
const FORCE_PAUSE_ALERT_KINDS: ReadonlySet<GeoCampaignEventKind> = new Set([
  "ufoShotDown",
  "ufoLanded",
  "fundingReport",
  "missionReport",
  "campaignWon",
  "campaignLost",
]);

function shouldForcePause(info: EventInfo): boolean {
  if (info.kind === "won" || info.kind === "lost" || info.kind === "council") return true;
  return FORCE_PAUSE_ALERT_KINDS.has(info.alertKind);
}

/** Notable campaign fields tracked across renders so auto-pause only fires on real events. */
interface EventSnapshot {
  contactId: string | null;
  contactStatus: string | null;
  region: string | null;
  fundingReport: number | null;
  interceptionReport: number | null;
  missionsCompleted: number;
  status: string;
  lastCouncilMonth: number;
}

// Bridge state for the current remount-based controller (src/game/main.ts rebuilds the
// view per action). Persisting the chosen speed + last event snapshot across those
// remounts keeps flowing time continuous and lets auto-pause fire on events even though
// the GeoscapeView instance is replaced. Once main.ts switches to update() (no remount),
// this becomes a harmless no-op cache.
let resumedTimeSpeed = 0;
let lastEventSnapshot: EventSnapshot | null = null;

const CSS = UI_TOKENS + "\n" + UI_BASE + "\n" + UI_COMPONENTS + "\n" + UI_PRIMITIVES + "\n" + `
#geoscape {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: var(--ui-text);
  background:
    radial-gradient(circle at 48% 42%, rgba(10,44,61,.88), rgba(3,8,14,.96) 42%, #010308 100%);
  font: 400 var(--ui-text-base)/var(--ui-leading) var(--ui-font-ui);
  letter-spacing: .02em;
}
#geoscape canvas { width: 100%; height: 100%; cursor: grab; }
/* No grid over space — just an edge vignette so the starfield reads as depth. */
#geoscape::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background: radial-gradient(circle at 50% 50%, transparent 43%, rgba(0,0,0,.42) 100%);
}
#geoscape .geo-canvas {
  position: absolute;
  inset: 0;
}
/* Console-glass material (Style Bible Layer 1): the panel-glass fill, 1px
   #1d3a4a-family console border, 6px radius, and the shared subtle inner glow —
   consumed from tokens so every screen reads as one system. */
#geoscape .geo-panel {
  position: absolute;
  z-index: var(--ui-z-panel);
  width: min(340px, calc(100vw - 28px));
  padding: var(--ui-sp-4);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
#geoscape .geo-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 32%;
  height: 2px;
  border-radius: var(--ui-radius-sm) 0 0 0;
  background: linear-gradient(90deg, var(--ui-teal), transparent);
}
/* Left edge is no longer a tall glass column. It is a transparent positioning
   container holding a compact stat cluster and a rail of small floating chips
   (each opens a modal). The globe behind it stays substantially unobstructed. */
#geoscape .geo-left {
  position: absolute;
  z-index: var(--ui-z-panel);
  top: max(18px, env(safe-area-inset-top));
  left: max(18px, env(safe-area-inset-left));
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-3);
  /* Compact one-line chip rail: kept comfortably under 260px so the pills read as
     floating pills (not a column) and the globe stays maximally unobstructed. */
  width: min(240px, calc(100vw - 28px));
  max-height: calc(100vh - 36px - 84px);
  pointer-events: none;
}
#geoscape .geo-left > * { pointer-events: auto; }
/* Instructional intro copy — only on the new-game screen (empty for a campaign). */
#geoscape .geo-intro {
  padding: var(--ui-sp-4);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
#geoscape .geo-intro:empty { display: none; }
/* Compact top-left stat cluster (console glass, tight padding). In normal flow
   (NOT .geo-panel) so it stacks above the chip rail instead of overlaying it. */
#geoscape .geo-stats-cluster {
  padding: var(--ui-sp-3);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
}
/* Floating chip rail: one-line pills, each opening a modal. */
#geoscape .geo-chip-rail {
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-2);
}
#geoscape .geo-chip {
  display: flex;
  align-items: center;
  gap: var(--ui-sp-2);
  width: 100%;
  padding: var(--ui-sp-2) var(--ui-sp-3);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  text-align: left;
  cursor: pointer;
  transition: border-color var(--ui-fast) var(--ui-ease), background var(--ui-fast) var(--ui-ease), transform var(--ui-fast) var(--ui-ease);
}
#geoscape .geo-chip:hover { border-color: var(--ui-border-bright); background: var(--ui-panel-raised); transform: translateX(2px); }
#geoscape .geo-chip-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--ui-cyan);
  box-shadow: 0 0 6px currentColor;
  color: var(--ui-cyan);
}
#geoscape .geo-chip-icon {
  flex: 0 0 auto;
  color: var(--ui-muted);
  font: 700 var(--ui-text-sm)/1 var(--ui-font-mono);
}
#geoscape .geo-chip-text { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
#geoscape .geo-chip-label {
  color: var(--ui-text);
  font: 700 var(--ui-text-xs)/1.1 var(--ui-font-mono);
  letter-spacing: .1em;
  text-transform: uppercase;
}
#geoscape .geo-chip-sub {
  color: var(--ui-muted);
  font: 500 var(--ui-text-xs)/1.2 var(--ui-font-ui);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* Tone maps only the status dot + a matching border tint, never the whole pill. */
#geoscape .geo-chip--info .geo-chip-dot { background: var(--ui-cyan); color: var(--ui-cyan); }
#geoscape .geo-chip--warn .geo-chip-dot { background: var(--ui-amber); color: var(--ui-amber); }
#geoscape .geo-chip--warn { border-color: color-mix(in srgb, var(--ui-amber) 40%, var(--ui-border-console)); }
#geoscape .geo-chip--danger .geo-chip-dot { background: var(--ui-red); color: var(--ui-red); }
#geoscape .geo-chip--danger { border-color: color-mix(in srgb, var(--ui-red) 45%, var(--ui-border-console)); }
#geoscape .geo-chip--done .geo-chip-dot { background: var(--ui-green); color: var(--ui-green); }
#geoscape .geo-chip--muted .geo-chip-dot { background: var(--ui-muted); color: var(--ui-muted); box-shadow: none; }
/* Arrival DEPLOY chip: red-livery pill that pulses to draw the eye. */
#geoscape .geo-chip-deploy {
  border-color: var(--ui-red);
  background: var(--ui-panel-glass);
}
#geoscape .geo-chip-deploy .geo-chip-label { color: var(--ui-red); }
#geoscape .geo-chip--pulse { animation: geo-chip-pulse 1.6s var(--ui-ease) infinite; }
@keyframes geo-chip-pulse {
  0%, 100% { box-shadow: var(--ui-glow-inner), 0 0 0 rgba(248,68,68,0); }
  50% { box-shadow: var(--ui-glow-inner), 0 0 16px rgba(248,68,68,.6); }
}
/* 150ms slide+glow when a new UFO contact first appears (reducedMotion neutralized
   by the UI_BASE prefers-reduced-motion reset). Fires only on the absent->present
   contact-id transition, never every refresh. */
#geoscape .geo-chip--enter { animation: geo-chip-in 150ms var(--ui-ease); }
@keyframes geo-chip-in {
  from { opacity: 0; transform: translateX(-10px); }
  to { opacity: 1; transform: translateX(0); }
}
/* Console-glass modal opened by a chip (dim backdrop, Esc / click-out closes). */
#geoscape .geo-modal-backdrop {
  position: absolute;
  inset: 0;
  z-index: var(--ui-z-modal);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ui-sp-6);
  background: rgba(2, 6, 12, 0.62);
  -webkit-backdrop-filter: blur(3px);
  backdrop-filter: blur(3px);
  animation: geo-modal-fade var(--ui-fast) var(--ui-ease);
}
@keyframes geo-modal-fade { from { opacity: 0; } to { opacity: 1; } }
#geoscape .geo-modal {
  width: min(420px, calc(100vw - 40px));
  max-height: calc(100vh - 80px);
  display: flex;
  flex-direction: column;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel-solid);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
}
#geoscape .geo-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-sp-3);
  padding: var(--ui-sp-3) var(--ui-sp-4);
  border-bottom: 1px solid var(--ui-border-console);
}
#geoscape .geo-modal-title {
  margin: 0;
  color: var(--ui-text);
  font: 800 var(--ui-text-lg)/1 var(--ui-font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape .geo-modal-close {
  flex: 0 0 auto;
  min-width: 34px;
  min-height: 34px;
  padding: 0;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel);
  color: var(--ui-muted);
  font: 700 var(--ui-text-base)/1 var(--ui-font-mono);
  cursor: pointer;
}
#geoscape .geo-modal-close:hover { border-color: var(--ui-border-bright); color: var(--ui-text); }
#geoscape .geo-modal-body {
  padding: var(--ui-sp-4);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-3);
}
#geoscape .geo-right {
  right: max(18px, env(safe-area-inset-right));
  bottom: calc(max(18px, env(safe-area-inset-bottom)) + 64px);
}
#geoscape .eyebrow {
  color: var(--ui-cyan);
  font: 700 var(--ui-text-xs)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .2em;
  text-transform: uppercase;
}
/* Panel title on the locked type scale — sentence/title case, not an ALL-CAPS
   wall (the eyebrow above carries the uppercase label). */
#geoscape h1 {
  margin: 4px 0 2px;
  font-size: var(--ui-text-2xl);
  line-height: var(--ui-leading-tight);
  letter-spacing: .01em;
}
#geoscape h2 {
  margin: 6px 0 8px;
  font-size: var(--ui-text-xl);
  line-height: 1;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape p {
  margin: 0;
  color: var(--ui-muted);
  line-height: var(--ui-leading);
}
/* Compact stat strip: a single wrapping row of .ui-chip (clock/threat/funding/
   cores/panic) — replaces the old 3-col grid of same-weight boxes. */
#geoscape .geo-status {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-sp-2);
}
#geoscape .geo-site {
  margin: var(--ui-sp-3) 0;
  padding: var(--ui-sp-3);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-panel);
}
#geoscape .geo-site strong {
  display: block;
  margin-bottom: 7px;
  color: var(--ui-amber);
  font: 800 var(--ui-text-lg)/1 var(--ui-font-mono);
  text-transform: uppercase;
}
#geoscape .geo-coords {
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/var(--ui-leading) var(--ui-font-mono);
}
/* Live-contact card: red-bordered alert on the console-glass surface, rendered
   inside the Contact chip's modal. The absent->present entrance now animates the
   Contact chip itself (.geo-chip--enter), not this card. */
#geoscape .geo-contact {
  padding: var(--ui-sp-3);
  border: 1px solid var(--ui-red);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner);
}
#geoscape .geo-contact.idle {
  border-color: var(--ui-border-console);
}
#geoscape .geo-contact.lost {
  border-color: var(--ui-border-console);
}
#geoscape .geo-contact.lost strong { color: var(--ui-muted); }
#geoscape .geo-contact strong {
  display: block;
  color: var(--ui-red);
  font: 800 var(--ui-text-sm)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .04em;
}
#geoscape .geo-contact.idle strong {
  color: var(--ui-cyan);
}
#geoscape .geo-contact p {
  margin-top: 7px;
  color: var(--ui-text);
  font-size: var(--ui-text-base);
  line-height: var(--ui-leading);
}
/* Pre-launch briefing preview on a launchable contact: opposition strength, field
   time, and reward preview so the player never commits to a mission blind. */
#geoscape .geo-briefing {
  margin-top: var(--ui-sp-2);
  padding-top: var(--ui-sp-2);
  border-top: 1px solid var(--ui-border);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
#geoscape .geo-briefing-line {
  color: var(--ui-text);
  font-size: var(--ui-text-sm);
}
#geoscape .geo-briefing-detail {
  color: var(--ui-amber);
  font-size: var(--ui-text-sm);
}
#geoscape .geo-briefing-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
#geoscape .geo-briefing-chip {
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-panel-raised);
  color: var(--ui-muted);
  font-size: var(--ui-text-xs);
  white-space: nowrap;
}
/* Objective card is the visually primary element of the left column: a teal
   accent rail + brighter title, so hierarchy reads by luminance, not more color. */
#geoscape .geo-card-primary {
  position: relative;
  padding: var(--ui-sp-3);
  padding-left: calc(var(--ui-sp-3) + 3px);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: linear-gradient(180deg, rgba(56,225,214,.10), rgba(10,20,32,.5));
  box-shadow: var(--ui-glow-inner);
}
#geoscape .geo-card-primary::before {
  content: "";
  position: absolute;
  top: var(--ui-sp-2);
  bottom: var(--ui-sp-2);
  left: 0;
  width: 3px;
  border-radius: var(--ui-radius-pill);
  background: var(--ui-teal);
}
#geoscape .geo-card-primary strong {
  display: block;
  color: var(--ui-text-strong);
  font: 800 var(--ui-text-md)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .03em;
}
#geoscape .geo-card-primary p {
  margin-top: 6px;
  color: var(--ui-muted);
  font-size: var(--ui-text-sm);
  line-height: var(--ui-leading);
}
/* Quiet secondary rows: everything else in the column collapses to a thin,
   muted row separated by hairlines instead of another same-weight box. */
#geoscape .geo-row {
  padding: var(--ui-sp-2) 0;
  border-top: 1px solid var(--ui-border-console);
}
#geoscape .geo-row:first-child { border-top: none; }
#geoscape .geo-row strong {
  display: block;
  color: var(--ui-text);
  font: 700 var(--ui-text-sm)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .02em;
}
#geoscape .geo-row.alert strong { color: var(--ui-amber); }
#geoscape .geo-row p {
  margin-top: 3px;
  color: var(--ui-muted);
  font-size: var(--ui-text-xs);
  line-height: var(--ui-leading);
}
/* Group wrapper for the quiet rows so hairlines read as a list, not stray lines. */
#geoscape .geo-rows {
  padding: var(--ui-sp-1) var(--ui-sp-3);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel);
}
/* End-of-month council review modal: per-region funding-delta grid. */
#geoscape .geo-council-summary {
  display: flex;
  align-items: baseline;
  gap: var(--ui-sp-3);
  padding-bottom: var(--ui-sp-2);
  margin-bottom: var(--ui-sp-2);
  border-bottom: 1px solid var(--ui-border-console);
}
#geoscape .geo-council-grade {
  font: 700 var(--ui-text-lg)/1 var(--ui-font-mono);
  color: var(--ui-amber);
}
#geoscape .geo-council-narrative {
  color: var(--ui-muted);
  font-size: var(--ui-text-xs);
  line-height: var(--ui-leading);
  margin-bottom: var(--ui-sp-2);
}
#geoscape .geo-council-row {
  display: grid;
  grid-template-columns: 1.4fr 1fr 1fr 1fr;
  gap: var(--ui-sp-2);
  padding: var(--ui-sp-1) 0;
  border-top: 1px solid var(--ui-border-console);
  font-size: var(--ui-text-xs);
}
#geoscape .geo-council-row:first-child { border-top: none; }
#geoscape .geo-council-row.head {
  color: var(--ui-muted);
  text-transform: uppercase;
  letter-spacing: .04em;
  font-size: 10px;
}
#geoscape .geo-council-row.defected strong { color: var(--ui-red); }
#geoscape .geo-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
/* .geo-assault-cta — overrides .ui-cta's cyan gradient with a blood-red one for
   the endgame's single highest-priority action (launch the final assault). */
#geoscape .geo-assault-cta {
  background: linear-gradient(180deg, var(--ui-red), #b91c1c);
  border-color: var(--ui-red);
  animation: geo-assault-pulse 1.6s ease-in-out infinite;
}
@keyframes geo-assault-pulse {
  0%, 100% { box-shadow: var(--ui-shadow-glow); }
  50% { box-shadow: 0 0 0 4px rgba(251,113,133,.35), var(--ui-shadow-glow); }
}
#geoscape button {
  min-height: 42px;
  padding: 0 var(--ui-sp-3);
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-panel-raised);
  font: 800 var(--ui-text-sm)/1 var(--ui-font-mono);
  letter-spacing: .07em;
  text-transform: uppercase;
  transition: border-color var(--ui-fast) var(--ui-ease), filter var(--ui-fast) var(--ui-ease);
}
#geoscape button.primary {
  flex: 1;
  min-height: 46px;
  color: var(--ui-bg-deep);
  border: 1px solid var(--ui-border-bright);
  border-radius: var(--ui-radius);
  background: linear-gradient(180deg, var(--ui-cyan), #2bc5e0);
  box-shadow: var(--ui-shadow-glow);
  font-weight: 800;
}
#geoscape button:hover:not(:disabled) {
  border-color: var(--ui-border-bright);
  filter: brightness(1.12);
}
#geoscape button.primary:hover:not(:disabled) {
  filter: brightness(1.1);
  transform: translateY(-1px);
}
#geoscape button:disabled {
  opacity: .42;
}
#geoscape .geo-hint {
  position: absolute;
  left: 50%;
  bottom: calc(max(18px, env(safe-area-inset-bottom)) + 72px);
  z-index: var(--ui-z-panel);
  width: min(520px, calc(100vw - 36px));
  padding: var(--ui-sp-2) var(--ui-sp-3);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-pill);
  color: var(--ui-muted);
  background: var(--ui-panel);
  text-align: center;
  transform: translateX(-50%);
  font: 700 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono);
  letter-spacing: .08em;
  text-transform: uppercase;
}
#geoscape .geo-difficulty {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-top: 13px;
}
#geoscape .geo-difficulty-eye {
  color: var(--ui-cyan);
  font: 700 var(--ui-text-xs)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .2em;
  text-transform: uppercase;
}
#geoscape .geo-diff-option {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: var(--ui-sp-2) var(--ui-sp-3);
  text-align: left;
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel);
  font: 700 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono);
}
#geoscape .geo-diff-option .geo-diff-name {
  color: var(--ui-text-strong);
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#geoscape .geo-diff-option .geo-diff-name::before {
  content: "○  ";
  color: var(--ui-cyan);
}
#geoscape .geo-diff-option .geo-diff-desc {
  color: var(--ui-muted);
  font-size: var(--ui-text-xs);
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
}
#geoscape .geo-diff-option[aria-checked="true"] {
  border-color: var(--ui-border-strong);
  background: linear-gradient(180deg, rgba(17,94,117,.6), rgba(8,49,65,.7));
}
#geoscape .geo-diff-option[aria-checked="true"] .geo-diff-name::before {
  content: "●  ";
}
#geoscape .geo-mission-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  margin-bottom: 7px;
  padding: 4px var(--ui-sp-2);
  border-radius: var(--ui-radius-pill);
  border: 1px solid var(--ui-border);
  background: var(--ui-panel);
  color: var(--ui-text);
  font: 800 var(--ui-text-xs)/1 var(--ui-font-mono);
  letter-spacing: .12em;
  text-transform: uppercase;
}
#geoscape .geo-mission-badge.urgent {
  border-color: var(--ui-amber);
  background: var(--ui-panel);
  color: var(--ui-amber);
}
#geoscape .geo-mission-badge .geo-mission-icon { font-size: var(--ui-text-xs); }
#geoscape .geo-mission-badge.lost {
  border-color: var(--ui-border);
  background: var(--ui-panel);
  color: var(--ui-muted);
}
/* Speed matchup chip: teal advantage / steel matched / amber outrun. The tone is
   carried by the left border + label colour, always alongside the text label. */
#geoscape .geo-speed-chip {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-self: stretch;
  margin-top: 8px;
  padding: 6px var(--ui-sp-2);
  border: 1px solid var(--ui-border);
  border-left-width: 3px;
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel);
}
#geoscape .geo-speed-chip-label {
  font: 800 var(--ui-text-xs)/1 var(--ui-font-mono);
  letter-spacing: .1em;
  text-transform: uppercase;
}
#geoscape .geo-speed-chip-detail {
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/1.2 var(--ui-font-mono);
  letter-spacing: .02em;
}
#geoscape .geo-speed-chip.advantage {
  border-left-color: var(--ui-teal);
}
#geoscape .geo-speed-chip.advantage .geo-speed-chip-label { color: var(--ui-teal); }
#geoscape .geo-speed-chip.matched {
  border-left-color: var(--ui-muted);
}
#geoscape .geo-speed-chip.matched .geo-speed-chip-label { color: var(--ui-muted); }
#geoscape .geo-speed-chip.outrun {
  border-left-color: var(--ui-amber);
  background: rgba(251, 191, 36, .08);
}
#geoscape .geo-speed-chip.outrun .geo-speed-chip-label { color: var(--ui-amber); }
/* Intercept CTA when the UFO outruns the craft: amber warning tone, still enabled. */
#geoscape .ui-cta.geo-cta-warn {
  border-color: var(--ui-amber);
  box-shadow: inset 0 0 0 1px rgba(251, 191, 36, .5);
}
#geoscape .geo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: var(--ui-sp-2) var(--ui-sp-2) 4px;
  text-align: center;
}
#geoscape .geo-empty .geo-empty-icon {
  font-size: var(--ui-text-xl);
  line-height: 1;
  color: var(--ui-cyan);
  opacity: .75;
}
#geoscape .geo-notice {
  display: flex;
  align-items: center;
  gap: var(--ui-sp-3);
  margin-top: var(--ui-sp-3);
  padding: var(--ui-sp-3);
  border-radius: var(--ui-radius);
  border: 1px solid var(--ui-border);
  background: var(--ui-panel);
}
#geoscape .geo-notice.won {
  border-color: var(--ui-green);
  background: var(--ui-panel);
}
#geoscape .geo-notice.lost {
  border-color: var(--ui-red);
  background: var(--ui-panel);
}
#geoscape .geo-notice .geo-notice-icon { font-size: var(--ui-text-lg); line-height: 1; }
#geoscape .geo-notice.won .geo-notice-icon { color: var(--ui-green); }
#geoscape .geo-notice.lost .geo-notice-icon { color: var(--ui-red); }
#geoscape .geo-notice b {
  display: block;
  color: var(--ui-text);
  font: 800 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono);
  letter-spacing: .06em;
  text-transform: uppercase;
}
#geoscape .geo-notice p { margin-top: 3px; color: var(--ui-muted); font-size: var(--ui-text-base); }
#geoscape .geo-overlay {
  position: absolute;
  inset: 0;
  z-index: var(--ui-z-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--ui-sp-6);
  background: var(--ui-panel-solid);
  backdrop-filter: blur(4px);
}
#geoscape .geo-overlay-host {
  position: absolute;
  inset: 0;
  z-index: var(--ui-z-overlay);
  pointer-events: none;
}
#geoscape .geo-overlay-host .geo-overlay { pointer-events: auto; }
#geoscape .geo-help {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  z-index: var(--ui-z-sticky);
  min-width: 44px;
  min-height: 44px;
  padding: 0;
  border-radius: var(--ui-radius);
  border: 1px solid var(--ui-border-strong);
  color: var(--ui-cyan);
  background: var(--ui-panel);
  font: 800 var(--ui-text-lg)/1 var(--ui-font-mono);
  box-shadow: var(--ui-shadow);
}
#geoscape .geo-help:hover { border-color: var(--ui-border-bright); background: var(--ui-panel-raised); }
/* The HELP overlay lives permanently in the DOM (toggled via .show), so override
   the always-on display:flex of .geo-overlay and gate it on .show. */
#geoscape .geo-help-overlay { display: none; }
#geoscape .geo-help-overlay.show { display: flex; }
#geoscape .geo-help-card {
  width: min(560px, 100%);
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel-solid);
  box-shadow: var(--ui-shadow);
}
#geoscape .geo-help-card .eyebrow { color: var(--ui-cyan); font: 700 var(--ui-text-xs)/var(--ui-leading-tight) var(--ui-font-mono); letter-spacing: .18em; text-transform: uppercase; }
#geoscape .geo-help-card h2 { margin: 7px 0 8px; color: var(--ui-text); font-size: var(--ui-text-2xl); letter-spacing: .04em; text-transform: uppercase; }
#geoscape .geo-help-card p.lede { margin: 0; max-width: 480px; color: var(--ui-muted); font-size: var(--ui-text-base); }
#geoscape .geo-help-card ul { margin: var(--ui-sp-4) 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: var(--ui-sp-2); }
#geoscape .geo-help-card li { padding: var(--ui-sp-2) var(--ui-sp-3); border: 1px solid var(--ui-border); border-radius: var(--ui-radius); background: var(--ui-panel); color: var(--ui-muted); font: 600 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono); }
#geoscape .geo-help-card li b { color: var(--ui-cyan); font-weight: 800; }
#geoscape .geo-help-actions { display: flex; justify-content: flex-end; margin-top: var(--ui-sp-4); }
#geoscape .geo-help-actions button { min-width: 130px; min-height: 38px; }
#geoscape .geo-welcome {
  position: absolute;
  top: max(68px, calc(env(safe-area-inset-top) + 56px));
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--ui-z-sticky);
  display: none;
  width: min(440px, calc(100vw - 36px));
  padding: var(--ui-sp-3) var(--ui-sp-4);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel-raised);
  box-shadow: var(--ui-shadow);
}
#geoscape .geo-welcome.show { display: block; }
#geoscape .geo-welcome .eyebrow { color: var(--ui-cyan); font: 700 var(--ui-text-xs)/var(--ui-leading-tight) var(--ui-font-mono); letter-spacing: .18em; text-transform: uppercase; }
#geoscape .geo-welcome b { display: block; margin: 5px 0 7px; color: var(--ui-text); font: 800 var(--ui-text-sm)/var(--ui-leading-tight) var(--ui-font-mono); letter-spacing: .04em; }
#geoscape .geo-welcome ol { margin: 0; padding-left: 18px; color: var(--ui-muted); font: 600 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono); }
#geoscape .geo-welcome ol li { margin-bottom: 3px; }
#geoscape .geo-welcome-actions { display: flex; justify-content: flex-end; margin-top: var(--ui-sp-2); }
#geoscape .geo-welcome-actions button { min-height: 36px; min-width: 96px; padding: 0 var(--ui-sp-3); }
/* Time controls are the primary verb on the geoscape: a prominent centered
   bottom bar so flowing time is always the obvious next action. The four
   .geo-speed-btn (Pause / 1x / 5x / 30x) keep their data-speed + aria-pressed. */
#geoscape .geo-speed-bar {
  position: absolute;
  left: 50%;
  bottom: max(18px, env(safe-area-inset-bottom));
  z-index: var(--ui-z-sticky);
  transform: translateX(-50%);
  display: flex;
  gap: var(--ui-sp-2);
  padding: var(--ui-sp-2);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-panel-raised);
  backdrop-filter: blur(10px);
  box-shadow: var(--ui-shadow);
}
/* No campaign (new-game screen) -> no speed group -> hide the empty bar. */
#geoscape .geo-speed-bar:empty { display: none; }
#geoscape .geo-speed {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--ui-sp-2);
}
#geoscape .geo-speed-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  min-width: 78px;
  min-height: 46px;
  padding: var(--ui-sp-2) var(--ui-sp-3);
  color: var(--ui-text);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: var(--ui-panel);
  font: 800 var(--ui-text-sm)/1 var(--ui-font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape .geo-speed-btn .geo-speed-icon {
  font-size: var(--ui-text-lg);
  line-height: 1;
  color: var(--ui-cyan);
}
#geoscape .geo-speed-btn:hover:not(:disabled) {
  border-color: var(--ui-border-bright);
  background: var(--ui-panel-raised);
  filter: brightness(1.1);
}
#geoscape .geo-speed-btn[aria-pressed="true"] {
  border-color: var(--ui-border-bright);
  background: linear-gradient(180deg, var(--ui-cyan), #2bc5e0);
  color: var(--ui-bg-deep);
  box-shadow: var(--ui-shadow-glow);
}
#geoscape .geo-speed-btn[aria-pressed="true"] .geo-speed-icon { color: var(--ui-bg-deep); }
/* Pause reads as distinct from the flow speeds (amber, "frozen" mood). */
#geoscape .geo-speed-btn[data-speed="0"] .geo-speed-icon { color: var(--ui-amber); }
#geoscape .geo-speed-btn[data-speed="0"][aria-pressed="true"] {
  background: linear-gradient(180deg, var(--ui-amber), #b45309);
  border-color: var(--ui-amber);
  box-shadow: 0 0 0 1px var(--ui-amber), 0 8px 24px rgba(0, 0, 0, 0.6);
}
#geoscape .geo-speed-btn[data-speed="0"][aria-pressed="true"] .geo-speed-icon { color: var(--ui-bg-deep); }
/* FAST FORWARD-to-arrival nudge chip, docked beside the speed group during transit. */
#geoscape .geo-ff-chip {
  display: flex;
  align-items: center;
  gap: var(--ui-sp-2);
  padding: var(--ui-sp-2) var(--ui-sp-3);
  color: var(--ui-cyan);
  border: 1px solid color-mix(in srgb, var(--ui-cyan) 45%, var(--ui-border-console));
  border-radius: var(--ui-radius);
  background: color-mix(in srgb, var(--ui-cyan) 12%, var(--ui-panel));
  cursor: pointer;
  text-align: left;
}
#geoscape .geo-ff-chip:hover { border-color: var(--ui-cyan); background: color-mix(in srgb, var(--ui-cyan) 20%, var(--ui-panel)); }
#geoscape .geo-ff-icon { font-size: var(--ui-text-lg); line-height: 1; color: var(--ui-cyan); }
#geoscape .geo-ff-text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
#geoscape .geo-ff-label {
  font: 800 var(--ui-text-sm)/1 var(--ui-font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape .geo-ff-sub { font: 600 var(--ui-text-xs)/1.1 var(--ui-font-mono); color: var(--ui-muted); }
#geoscape .geo-ff-chip--pulse { animation: geo-ff-pulse 1.6s var(--ui-ease) infinite; }
@keyframes geo-ff-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--ui-cyan) 55%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in srgb, var(--ui-cyan) 0%, transparent); }
}
@media (prefers-reduced-motion: reduce) {
  #geoscape .geo-ff-chip--pulse { animation: none; }
}
#geoscape .geo-contact .geo-contact-status {
  margin-top: 7px;
  color: var(--ui-amber);
  font: 800 var(--ui-text-sm)/var(--ui-leading) var(--ui-font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape .geo-contact .geo-contact-meta {
  margin-top: 4px;
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/var(--ui-leading) var(--ui-font-mono);
}
/* Adopts the shared .ui-toast look (top-center, console glass, tone via left
   border) while keeping the geoscape's own persistent element + JS visibility
   toggle/timer, so events flash a toast without re-creating the node. */
#geoscape .geo-toast {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  z-index: var(--ui-z-toast);
  transform: translate(-50%, -12px);
  opacity: 0;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: var(--ui-sp-3);
  max-width: min(560px, 92vw);
  padding: var(--ui-sp-3) var(--ui-sp-5);
  border-radius: var(--ui-radius-sm);
  border: 1px solid var(--ui-border-console);
  border-left: 3px solid var(--ui-cyan);
  background: var(--ui-panel-glass);
  color: var(--ui-text);
  font: 700 var(--ui-text-base)/var(--ui-leading) var(--ui-font-ui);
  letter-spacing: .01em;
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  transition: opacity var(--ui-mid) var(--ui-ease), transform var(--ui-mid) var(--ui-ease);
}
#geoscape .geo-toast.visible {
  opacity: 1;
  transform: translate(-50%, 0);
}
#geoscape .geo-toast[data-kind="won"] {
  border-left-color: var(--ui-green);
}
#geoscape .geo-toast[data-kind="lost"] {
  border-left-color: var(--ui-red);
}
/* Callout pinned to the active UFO marker so the player sees where to act. */
#geoscape .geo-contact-label {
  position: absolute;
  transform: translate(-50%, -150%);
  z-index: var(--ui-z-sticky);
  padding: 3px var(--ui-sp-2);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-panel-solid);
  color: var(--ui-text);
  font: 800 var(--ui-text-xs)/var(--ui-leading-tight) var(--ui-font-mono);
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space: nowrap;
  pointer-events: none;
  box-shadow: var(--ui-shadow);
}
#geoscape .geo-threat-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px var(--ui-sp-2);
  border-radius: var(--ui-radius-pill);
  border: 1px solid var(--ui-red);
  background: var(--ui-panel);
  color: var(--ui-red);
  font: 800 var(--ui-text-xs)/1 var(--ui-font-mono);
  letter-spacing: .1em;
  text-transform: uppercase;
  opacity: 0;
  transition: opacity var(--ui-fast) var(--ui-ease);
}
#geoscape .geo-threat-tag.active { opacity: 1; animation: geo-threat-pulse .42s ease-out 2; }
@keyframes geo-threat-pulse {
  0% { box-shadow: 0 0 0 rgba(248,113,113,0); }
  50% { box-shadow: 0 0 14px rgba(248,113,113,.7); }
  100% { box-shadow: 0 0 0 rgba(248,113,113,0); }
}
/* On-globe PURSUIT HUD: a compact, non-blocking panel pinned bottom-centre so
   the chase over the globe stays fully visible behind it. */
#geoscape .geo-intercept {
  position: absolute;
  left: 50%;
  bottom: calc(96px + env(safe-area-inset-bottom));
  transform: translateX(-50%);
  width: min(560px, calc(100vw - 32px));
  padding: var(--ui-sp-3) var(--ui-sp-4);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel-solid);
  box-shadow: var(--ui-shadow);
  pointer-events: auto;
  animation: geo-intercept-in .18s var(--ui-ease) both;
}
@keyframes geo-intercept-in {
  from { opacity: 0; transform: translate(-50%, 8px); }
  to { opacity: 1; transform: translate(-50%, 0); }
}
#geoscape .geo-intercept-head {
  display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 4px;
}
#geoscape .geo-intercept-title {
  color: var(--ui-text); font: 800 var(--ui-text-sm)/1 var(--ui-font-mono);
  letter-spacing: .06em; text-transform: uppercase;
}
#geoscape .geo-intercept-range {
  color: var(--ui-cyan); font: 700 var(--ui-text-xs)/1 var(--ui-font-mono);
  letter-spacing: .1em; text-transform: uppercase; white-space: nowrap;
}
#geoscape .geo-intercept-sub {
  margin: 2px 0 0; color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/1.3 var(--ui-font-mono);
  letter-spacing: .04em;
}
#geoscape .geo-intercept-sub.warn { color: var(--ui-amber); }
#geoscape .geo-intercept-log {
  min-height: 1.35em; margin: 8px 0 0; color: var(--ui-muted);
  font: 500 var(--ui-text-xs)/1.4 var(--ui-font-mono);
}
#geoscape .geo-intercept-actions { display: flex; gap: 8px; margin-top: 10px; }
#geoscape .geo-intercept-actions button { flex: 1; }
#geoscape .geo-intercept-actions button:disabled { opacity: .4; cursor: default; }
@media (prefers-reduced-motion: reduce) {
  #geoscape .geo-intercept { animation: none; }
}
@media (max-width: 820px) {
  #geoscape .geo-panel { width: calc(100vw - 24px); padding: var(--ui-sp-3); }
  #geoscape .geo-left { left: 12px; width: min(240px, calc(100vw - 24px)); }
  /* Lift the right panel above the centered speed bar so the two never overlap. */
  #geoscape .geo-right { left: 12px; right: 12px; bottom: calc(12px + 78px); }
  #geoscape h1 { font-size: 30px; }
  #geoscape .geo-status { grid-template-columns: 1fr; }
  #geoscape .geo-hint { display: none; }
  #geoscape .geo-actions { flex-wrap: wrap; }
  #geoscape .geo-speed-bar { left: 12px; right: 12px; transform: none; width: auto; justify-content: center; }
  #geoscape .geo-speed-btn { min-height: 40px; min-width: 0; }
}
/* Keyboard focus indicators — :focus-visible only fires for keyboard users, so
   mouse-driven screenshots are unaffected. Covers speed buttons, the difficulty
   radio options, and every generic geoscape button. */
#geoscape button:focus-visible,
#geoscape .geo-help:focus-visible,
#geoscape .geo-diff-option:focus-visible,
#geoscape select:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 2px;
}
/* Respect prefers-reduced-motion: stop the threat pulse and collapse transitions.
   The 3D marker throb + pursuit contrails are additionally frozen from JS via
   Geoscape.reducedMotion. */
@media (prefers-reduced-motion: reduce) {
  #geoscape .geo-threat-tag.active { animation: none !important; }
  #geoscape *,
  #geoscape *::before,
  #geoscape *::after {
    animation-duration: .001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: .001ms !important;
    scroll-behavior: auto !important;
  }
}
`;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function latLonToVector(lat: number, lon: number, radius = EARTH_RADIUS): Vector3 {
  const latRad = (lat * Math.PI) / 180;
  const lonRad = (lon * Math.PI) / 180;
  const cosLat = Math.cos(latRad);
  // Match THREE.SphereGeometry's equirectangular UV orientation:
  // lon 0 sits on +X, lon +90 sits on -Z.
  return new Vector3(
    radius * cosLat * Math.cos(lonRad),
    radius * Math.sin(latRad),
    -radius * cosLat * Math.sin(lonRad),
  );
}

function vectorToLatLon(v: Vector3): { lat: number; lon: number } {
  const n = v.clone().normalize();
  return {
    lat: Math.asin(n.y) * (180 / Math.PI),
    lon: Math.atan2(-n.z, n.x) * (180 / Math.PI),
  };
}

export function uvToLatLon(uv: Vector2): { lat: number; lon: number } {
  return {
    lat: uv.y * 180 - 90,
    lon: uv.x * 360 - 180,
  };
}

function fmtCoord(value: number, pos: string, neg: string): string {
  const dir = value >= 0 ? pos : neg;
  return `${Math.abs(value).toFixed(1)}°${dir}`;
}

export function geoscapeTimeAction(campaign: CampaignState | null): GeoscapeTimeAction {
  const scan = formatHours(GEOSCAPE_SCAN_HOURS);
  if (!campaign) return { label: `Scan ${scan}`, hours: GEOSCAPE_SCAN_HOURS, disabled: true };
  const disabled = campaign.strategic.status !== "active";
  const contact = campaign.ufoContact;
  if (!contact) return { label: `Scan ${scan}`, hours: GEOSCAPE_SCAN_HOURS, disabled };
  if (contact.status === "crashed") {
    return { label: `Hold ${scan}`, hours: GEOSCAPE_SCAN_HOURS, disabled };
  }
  return {
    label: isInterceptorReady(campaign) ? `Track ${scan}` : `Wait ${scan}`,
    hours: GEOSCAPE_SCAN_HOURS,
    disabled,
  };
}

export function canSelectBaseSite(campaign: CampaignState | null): boolean {
  return campaign === null;
}

/** Spherical linear interpolation between two unit vectors (true great-circle path). */
function slerpUnit(a: Vector3, b: Vector3, t: number, out: Vector3): void {
  const dot = Math.max(-1, Math.min(1, a.dot(b)));
  const angle = Math.acos(dot);
  const sinAngle = Math.sin(angle);
  if (sinAngle < 1e-5) {
    out.copy(a);
    return;
  }
  const w0 = Math.sin((1 - t) * angle) / sinAngle;
  const w1 = Math.sin(t * angle) / sinAngle;
  out.set(a.x * w0 + b.x * w1, a.y * w0 + b.y * w1, a.z * w0 + b.z * w1);
}

/** Smooth acceleration/deceleration curve for the launch fly-out (0..1 -> 0..1). */
function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** Snapshot of the notable event fields; the clock is intentionally excluded. */
function snapshotEvent(campaign: CampaignState | null): EventSnapshot {
  const contact = campaign?.ufoContact;
  return {
    contactId: contact?.id ?? null,
    contactStatus: contact?.status ?? null,
    region: contact?.region ?? null,
    fundingReport: campaign?.lastFundingReport?.reportNumber ?? null,
    interceptionReport: campaign?.lastInterceptionReport?.completedAtHour ?? null,
    missionsCompleted: campaign?.missionsCompleted ?? 0,
    status: campaign?.strategic.status ?? "active",
    lastCouncilMonth: campaign?.lastCouncilMonth ?? 0,
  };
}

/**
 * Returns a short toast notice when a notable event happened between the previous
 * snapshot and the incoming campaign, otherwise null. Drives the classic X-COM
 * "time flows until something happens" auto-pause. Pure data-in/data-out: works
 * both for in-place update() and across the current remount-based controller.
 */
function detectEvent(prev: EventSnapshot, campaign: CampaignState | null): EventInfo | null {
  const next = snapshotEvent(campaign);
  if (prev.status !== next.status) {
    if (next.status === "won") return { kind: "won", text: "Containment achieved", alertKind: "campaignWon" };
    if (next.status === "lost") return { kind: "lost", text: "Containment failed", alertKind: "campaignLost" };
  }
  if (next.lastCouncilMonth > prev.lastCouncilMonth) {
    return { kind: "council", text: "Council review complete", alertKind: "fundingReport" };
  }
  if (prev.contactId === null && next.contactId !== null) {
    return { kind: "info", text: `UFO detected — ${next.region ?? "unknown sector"}`, alertKind: "ufoDetected" };
  }
  if (prev.contactId !== null && next.contactId !== null && prev.contactStatus !== next.contactStatus) {
    if (next.contactStatus === "crashed") return { kind: "info", text: "UFO shot down", alertKind: "ufoShotDown" };
    if (next.contactStatus === "landed") return { kind: "info", text: "UFO landed — launch assault", alertKind: "ufoLanded" };
  }
  if (prev.fundingReport !== next.fundingReport && next.fundingReport !== null) {
    return { kind: "info", text: "Council funding report", alertKind: "fundingReport" };
  }
  if (prev.interceptionReport !== next.interceptionReport && next.interceptionReport !== null) {
    return { kind: "info", text: "Interception report filed", alertKind: "interceptionReport" };
  }
  if (prev.missionsCompleted !== next.missionsCompleted) {
    return { kind: "info", text: "Mission report filed", alertKind: "missionReport" };
  }
  return null;
}

/** Difficulty levels in selector order (matches difficulty ramp). */
export const DIFFICULTY_LEVELS: readonly DifficultyLevel[] = ["rookie", "veteran", "commander"];

/** One-line tagline for each difficulty option in the new-game selector. */
export const DIFFICULTY_DESCRIPTIONS: Record<DifficultyLevel, string> = {
  rookie: "Forgiving economy and lighter alien pressure. Recommended for new commanders.",
  veteran: "The intended X-COM balance: steady threat and a fair council.",
  commander: "Lean funding, heavier assault waves. For seasoned commanders only.",
};

export interface MissionTypeInfo {
  /** Short glyph paired with the label so mission type is never color-alone. */
  icon: string;
  label: string;
  /** Terror and base-defense contacts read as higher priority. */
  urgent: boolean;
  /** Marker color on the globe (always paired with the icon + label in the card). */
  color: number;
}

/**
 * Per-mission-type presentation. The globe marker uses `color`, but every place
 * the contact appears in the DOM also shows `icon` + `label`, so the type is
 * distinguishable without relying on color (a11y). Urgent types drive a faster,
 * larger marker pulse in the render loop.
 */
export function missionTypeInfo(missionType: MissionType | undefined): MissionTypeInfo {
  switch (missionType) {
    case "landedUfo":
      return { icon: "⌂", label: "Landed UFO", urgent: false, color: 0xc084fc };
    case "terror":
      return { icon: "⚠", label: "Terror site", urgent: true, color: 0xf97316 };
    case "baseDefense":
      return { icon: "★", label: "Base defense", urgent: true, color: 0xef4444 };
    case "crashSite":
    default:
      return { icon: "✈", label: "Crash site", urgent: false, color: 0xfb7185 };
  }
}

export function regionFor(lat: number, lon: number): string {
  if (lat < -60) return "Antarctic perimeter";
  if (lat > 24 && lon > -170 && lon < -50) return "North America";
  if (lat > 7 && lat <= 24 && lon > -125 && lon < -55) return "Central America";
  if (lat < 12 && lat > -58 && lon > -82 && lon < -35) return "South America";
  if (lat > 36 && lon > -12 && lon < 45) return "Europe";
  if (lat <= 36 && lat > -36 && lon > -20 && lon < 52) return "Africa";
  if (lat > 12 && lon >= 45 && lon < 78) return "Middle East";
  if (lat > 5 && lon >= 68 && lon < 95) return "South Asia";
  if (lat > 10 && lon >= 95 && lon < 150) return "East Asia";
  if (lat < 8 && lat > -48 && lon >= 110 && lon < 180) return "Oceania";
  if (lat > 48 && lon >= 45 && lon < 180) return "Siberia";
  if (lon > -35 && lon < 20) return "Atlantic sector";
  if (lon > 100 || lon < -120) return "Pacific sector";
  return "Open ocean sector";
}

function makeBase(lat: number, lon: number): BaseLocation {
  return {
    lat: Math.round(lat * 10) / 10,
    lon: Math.round(lon * 10) / 10,
    region: regionFor(lat, lon),
  };
}

function disposeMaterial(material: Material): void {
  const maps = [
    "map",
    "normalMap",
    "roughnessMap",
    "metalnessMap",
    "aoMap",
    "emissiveMap",
    "alphaMap",
    "bumpMap",
  ];
  const withMaps = material as Material & Record<string, Texture | null | undefined>;
  for (const key of maps) withMaps[key]?.dispose();
  // ShaderMaterials keep their textures in `uniforms` (e.g. the earth's `uMap`
  // 2048×1024 CanvasTexture), not in the standard map slots above, so free any
  // texture-valued uniform here or it leaks on every view teardown.
  if (material instanceof ShaderMaterial) {
    for (const uniform of Object.values(material.uniforms)) {
      const value = uniform?.value as Texture | undefined;
      if (value && (value as { isTexture?: boolean }).isTexture) value.dispose();
    }
  }
  material.dispose();
}

function disposeObject(obj: Group | Scene): void {
  obj.traverse((child) => {
    if (child instanceof Mesh || child instanceof Points || child instanceof Line) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) for (const one of material) disposeMaterial(one);
      else disposeMaterial(material);
    }
  });
}

export class GeoscapeView {
  private readonly root: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly selectedRegion: HTMLElement;
  private readonly selectedCoords: HTMLElement;
  private readonly confirmButton: HTMLButtonElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  private readonly controls: OrbitControls;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private readonly earthGroup = new Group();
  private readonly earthMesh: Mesh;
  private readonly baseMarker = new Group();
  private readonly ufoMarker = new Group();
  /** Blood-red endgame beacon marking the revealed alien HQ; hidden until then. */
  private readonly hqMarker = new Group();
  private readonly interceptorMarker = new Group();
  private readonly trajectoryLine: Line;
  /** Faint great-circle trail of the UFO's recent positions while it flies. */
  private readonly ufoTrailLine: Line;
  /** Cyan marker pool for extra radar bases (up to MAX_EXTRA_BASES), synced in refreshMarkers. */
  private readonly extraBaseMarkers = new Group();
  /** True while the player is designating a new base site on the globe. */
  private buildMode = false;
  /** Hint line below the globe; text refreshed by refreshHint(). */
  private hintEl: HTMLDivElement | null = null;
  private selectedBase: BaseLocation | null;
  private selectedDifficulty: DifficultyLevel = "veteran";
  private raf = 0;
  private down: { x: number; y: number } | null = null;
  private disposed = false;

  /** Live campaign state; swapped in place by update() (mount never mutates it). */
  private campaign: CampaignState | null;
  /** Mission type the UFO marker was last built for (rebuilt only on change). */
  private ufoMissionType: MissionType | undefined;
  /** UFO variety the marker was last built for (rebuilt only on change). */
  private ufoType: UfoType | undefined;
  /** Whether the UFO marker was last built as a crashed (amber cross) beacon. */
  private ufoCrashed: boolean | undefined;
  /** Contact id the current trail belongs to; reset whenever the UFO changes. */
  private ufoTrailContactId: string | null = null;
  /** Recent airborne UFO positions (lat/lon, oldest first); capped at UFO_TRAIL_MAX. */
  private ufoTrail: { lat: number; lon: number }[] = [];
  /** Time-flow speed (0 = paused). Persisted across remounts via resumedTimeSpeed. */
  private timeSpeed = resumedTimeSpeed;
  private timeAccumulatorMs = 0;
  private lastFlowMs = 0;
  /** Active speed buttons; aria-pressed refreshed whenever timeSpeed changes. */
  private speedButtons: HTMLButtonElement[] = [];
  /** The Pause/1x/5x/30x speed group, built ONCE and reused across every tick.
   *  refresh() runs on every time-flow tick (<=700ms); rebuilding these buttons each
   *  tick detached them from under an in-flight click (a click landing between tick N's
   *  replaceChildren and the pointerup was dropped), which froze the speed control
   *  during a deployment transit. Cached in place, the nodes survive every refresh. */
  private speedGroup: HTMLDivElement | null = null;
  /** "FAST FORWARD to arrival" nudge chip, docked beside the speed group during transit.
   *  Built once, then shown/hidden by refreshFastForward — it never sets speed on its own
   *  (the player must click), matching the classic X-COM "you choose to compress" pattern. */
  private fastForwardChip: HTMLButtonElement | null = null;
  /** Cached base->UFO great-circle route for the current engagement target. */
  private interceptorRoute: { baseN: Vector3; ufoN: Vector3; contactId: string } | null = null;
  /** Directional sun light; orbited each frame by updateTerminator for the day/night cycle. */
  private readonly sunLight = new DirectionalLight(0xffffff, 2.6);
  /** Timestamp (ms) the current interception launch flight began; drives the base->UFO fly-out. */
  private interceptorFlightStartMs = 0;
  /** Fly-out duration (ms) for the current engagement, derived from base->UFO distance. */
  private interceptorFlightDurationMs = FLYOUT_MIN_MS;
  /** Original UFO direction captured at engagement start (drift pivots off this). */
  private readonly ufoN0 = new Vector3();
  /** Axis the UFO's presentation drift rotates about (perp to ufoN0, along its heading). */
  private readonly pursuitAxis = new Vector3(1, 0, 0);
  /** Eased pursuit range (real km) that drives the interceptor's closing arc (smooth, not snapped). */
  private displayRange = ENGAGEMENT_RANGE_KM;
  /** Real km gap captured at the start of the current pursuit; normalizes the closing arc. */
  private pursuitStartRangeKm = ENGAGEMENT_RANGE_KM;
  /** Eased OrbitControls target so the camera gently tracks the interceptor while engaging. */
  private readonly chaseTarget = new Vector3();

  // --- Pursuit HUD (rangeKm + keepChasing/disengage; no combat exchange on the globe) ---
  private interceptOverlayEl: HTMLDivElement | null = null;
  private interceptButtons: HTMLButtonElement[] = [];
  private interceptRangeLabel: HTMLSpanElement | null = null;
  private interceptSubLine: HTMLDivElement | null = null;
  private interceptLogLine: HTMLDivElement | null = null;
  /** Last-refresh engagement state; a false->true transition kicks off the launch flight. */
  private wasEngaging = false;
  /** contactId THE ZOOM has already fired for; guards a double-fire of onZoomToDogfight. */
  private zoomedContactId: string | null = null;
  private toastTimer: number | undefined;

  // Dynamic DOM containers populated by refresh() (static shell lives in buildHud()).
  private readonly statsGrid: HTMLDivElement;
  private readonly noticeSlot: HTMLDivElement;
  /** New-game instructional copy; empty for a live campaign. */
  private readonly introSlot: HTMLDivElement;
  /** Floating left-edge chip rail (Objective/Contact/Fleet/Reports + DEPLOY). */
  private readonly chipRail: HTMLDivElement;
  private readonly actionsSlot: HTMLDivElement;
  private readonly overlaySlot: HTMLDivElement;
  private readonly toast: HTMLDivElement;
  /** Prominent centered bottom bar holding the time-flow speed controls. */
  private readonly speedBar: HTMLDivElement;
  /** Concise HELP overlay (controls + mechanics reference). */
  private helpOverlay: HTMLDivElement | null = null;
  /** One-time first-run welcome banner; shown only until dismissed. */
  private welcomeBanner: HTMLDivElement | null = null;
  /** Captured once at construction: true when the OS/browser asks for reduced
   *  motion. Freezes the non-essential 3D loops (marker throb, camera shake) so
   *  those users get a steady globe. Essential feedback (tracers, explosions,
   *  the time-combat tick) still plays. */
  private readonly reducedMotion: boolean =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.helpOverlay?.classList.contains("show")) {
      this.toggleHelp(false);
      return;
    }
    if (e.key === "Escape" && this.openModalKind) {
      this.closeGeoModal();
    }
  };

  // Reusable scratch objects for the interceptor animation (no per-frame allocation).
  private readonly scratchA = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly scratchC = new Vector3();
  private readonly scratchBasis = new Matrix4();
  /** Scratch for projecting a marker to screen space for damage numbers (per hit, not per frame). */
  private readonly scratchProject = new Vector3();

  /** Screen-space callout pinned to the active UFO marker ("where to act"). */
  private contactLabel: HTMLDivElement | null = null;
  /** Cached label text so the DOM is only rewritten when the contact changes. */
  private contactLabelText = "";

  // --- Globe visual upgrades (city lights / atmosphere rim / clouds) ---
  /** City light points; per-vertex color is rewritten each frame from the sun direction. */
  private cityLights!: Points;
  /** Local-space unit position of each city point (precomputed; never mutated). */
  private readonly cityLocal: Vector3[] = [];
  /** Scratch for the city-light day/night dot product (world space). */
  private readonly scratchCity = new Vector3();
  /** Earth day/night shader sun-direction uniform (updated each frame). */
  private earthSunUniform: { value: Vector3 } | null = null;
  /** Fresnel rim atmosphere sun-direction uniform (updated each frame). */
  private rimSunUniform: { value: Vector3 } | null = null;
  /** Graticule day-side-fade sun-direction uniform (updated each frame). */
  private gratSunUniform: { value: Vector3 } | null = null;
  /** Live clock readout node — rewritten each frame for smooth HH:MM flow. */
  private clockStatValue: HTMLElement | null = null;
  // The contact card's one-shot slide+glow entrance is gated by the module-scoped
  // `announcedContactId` (declared above the class), which survives view remounts so a
  // stale contact never re-triggers the "new detection" alert on a screen round-trip.
  /** Expanding pulse rings on surface beacons (animated in the frame loop). */
  private readonly beaconPulseRings: Mesh[] = [];
  /** Slowly rotating translucent cloud shell. */
  private cloudMesh: Mesh | null = null;

  // --- Thruster contrails behind the interceptor + UFO during an engagement ---
  private interceptorContrail!: Points;
  private ufoContrail!: Points;
  private readonly interceptorContrailRing = new Float32Array(CONTRAIL_MAX * 3);
  private readonly ufoContrailRing = new Float32Array(CONTRAIL_MAX * 3);
  private readonly interceptorContrailState = { head: 0, count: 0 };
  private readonly ufoContrailState = { head: 0, count: 0 };

  // --- Non-blocking Skyranger deployment ---
  /**
   * Deployment flights now live in campaign.activeFlights (purpose "deployment")
   * and render through the pooled flight markers while time stays live — no
   * blocking overlay, no time-lock. This line draws the planned base->site
   * great-circle route for the active deployment flight.
   */
  private deploymentLine!: Line;
  /** Flight ids we have already fired onDeploymentArrived for (guards a double-fire before the arrived flag persists). */
  private readonly deployArrivedFired = new Set<string>();

  // --- Left-edge chip rail (reconciled in place; nodes are reused across ticks) ---
  // refresh() runs on every time-flow tick (every <=700ms). Rebuilding the chip
  // <button>s each tick restarted the DEPLOY chip's pulse animation (so it never
  // visibly pulsed) and swallowed clicks whose mousedown landed on a node that a
  // tick then replaced. So chips are cached by key and mutated in place; only text,
  // tone class, and the click callback change — the node identity is stable.
  private readonly chipCache = new Map<string, GeoChipHandle>();
  // Persistent primary CTA reused across contact-modal rebuilds so a click whose
  // mousedown/mouseup straddle a refresh tick is not dropped (the node survives).
  private launchCta: HTMLButtonElement | null = null;

  // --- Left-edge chip modal (one open at a time; Esc / click-out closes) ---
  private modalBackdrop: HTMLDivElement | null = null;
  private modalTitleEl: HTMLElement | null = null;
  private modalBodySlot: HTMLDivElement | null = null;
  private openModalKind: GeoModalKind | null = null;

  // --- Active-flight markers (interceptors/transports flying across the globe) ---
  /** Pooled marker + trail per active flight, keyed by flight id (built/disposed on lifecycle). */
  private readonly flightMarkers = new Map<
    string,
    { marker: Group; trail: Line; points: { lat: number; lon: number }[] }
  >();

  constructor(private readonly opts: GeoscapeOptions) {
    injectStyle();
    this.campaign = opts.campaign;
    this.wasEngaging = this.isEngaging();
    this.selectedBase = opts.campaign?.base ?? null;
    this.root = el("div");
    this.root.id = "geoscape";
    this.canvasWrap = el("div", "geo-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.camera.position.set(0, 0.28, 4.35);
    this.camera.lookAt(0, 0, 0);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.enablePan = false;
    this.controls.minDistance = 3.05;
    this.controls.maxDistance = 5.4;
    // Stationary globe: no automatic spin so the player can read positions at a
    // glance. User drag/orbit via OrbitControls is unaffected.
    this.controls.autoRotate = false;

    // Trajectory line is allocated once; its positions are rewritten per engagement.
    this.trajectoryLine = this.makeTrajectoryLine();
    // UFO flight trail allocated once; positions + per-vertex fade are rewritten per refresh.
    this.ufoTrailLine = this.makeUfoTrailLine();
    this.earthMesh = this.buildScene();
    this.buildChaseFx();
    this.buildDeploymentFx();
    this.buildContactLabel();
    const panels = this.buildHud();
    this.selectedRegion = panels.region;
    this.selectedCoords = panels.coords;
    this.confirmButton = panels.confirm;
    this.statsGrid = panels.statsGrid;
    this.noticeSlot = panels.noticeSlot;
    this.introSlot = panels.introSlot;
    this.chipRail = panels.chipRail;
    this.actionsSlot = panels.actionsSlot;
    this.overlaySlot = panels.overlaySlot;
    this.toast = panels.toast;
    this.speedBar = panels.speedBar;
    this.ufoMissionType = opts.campaign?.ufoContact?.missionType;
    this.ufoType = opts.campaign?.ufoContact?.ufoType;
    this.ufoCrashed = opts.campaign?.ufoContact?.status === "crashed";
    this.updateSelectionHud();
    // First render populates every panel/marker and seeds the event snapshot
    // (without firing an auto-pause toast for the already-known campaign).
    this.refresh();
    // One-time first-run welcome tip (only the very first campaign, never twice).
    this.maybeShowWelcome();
  }

  /**
   * In-place refresh: swap the campaign, reposition markers, refresh every panel
   * and the time-control state — without disposing/rebuilding the scene or the
   * renderer. Safe to call from within the view's own frame loop. Auto-pauses and
   * surfaces a toast when a notable event (new contact, status change, funding
   * report, mission/campaign outcome) is detected versus the previously rendered
   * snapshot.
   */
  update(campaign: CampaignState | null): void {
    if (this.disposed) return;
    this.campaign = campaign;
    if (this.selectedBase === null && campaign?.base) {
      this.selectedBase = campaign.base;
      this.placeMarker(this.selectedBase);
      this.updateSelectionHud();
    }
    this.refresh();
  }

  mount(container: HTMLElement): void {
    container.replaceChildren(this.root);
    this.canvasWrap.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.addEventListener("pointermove", this.onPointerMove);
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeydown);
    this.resize();
    this.applyCanvasCursor();
    this.frame();
    this.installMarkerProbe();
  }

  /**
   * Read-only test hook (mirrors baseView's `__baseEnterRoom`): projects every visible
   * flight/UFO marker to screen pixels so an automated smoothness probe can confirm
   * markers glide per-frame instead of teleporting per clock-tick. Never mutates state.
   */
  private installMarkerProbe(): void {
    const probeVec = new Vector3();
    const project = (obj: Object3D): { x: number; y: number } => {
      const rect = this.renderer.domElement.getBoundingClientRect();
      obj.getWorldPosition(probeVec).project(this.camera);
      return { x: (probeVec.x * 0.5 + 0.5) * rect.width, y: (-probeVec.y * 0.5 + 0.5) * rect.height };
    };
    (window as unknown as { __geoMarkers?: () => unknown }).__geoMarkers = () => {
      const flights: Array<{ id: string; x: number; y: number }> = [];
      for (const [id, entry] of this.flightMarkers) {
        if (entry.marker.visible) flights.push({ id, ...project(entry.marker) });
      }
      return {
        displayHours: this.displayHours(),
        elapsedHours: this.campaign?.clock.elapsedHours ?? 0,
        timeSpeed: this.timeSpeed,
        engaging: this.isEngaging(),
        flightDurationMs: this.interceptorFlightDurationMs,
        flights,
        ufo: this.ufoMarker.visible ? project(this.ufoMarker) : null,
      };
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeydown);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.renderer.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.closeGeoModal();
    this.root.remove();
    this.deployArrivedFired.clear();
    delete (window as unknown as { __geoMarkers?: () => unknown }).__geoMarkers;
  }

  private buildScene(): Mesh {
    // Dim ambient so the night hemisphere reads dark; the day/night terminator
    // comes from sunLight, whose position is advanced each frame by updateTerminator.
    this.scene.add(new AmbientLight(0x6ecde8, 0.18));
    this.sunLight.position.set(4, 1.8, 5);
    this.scene.add(this.sunLight);

    const stars = this.makeStars();
    this.scene.add(stars);

    this.earthGroup.rotation.y = -0.45;
    this.scene.add(this.earthGroup);

    const earthTexture = makeEarthTexture();
    earthTexture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());

    const earthShader = createEarthShaderMaterial(earthTexture);
    this.earthSunUniform = earthShader.uniforms.uSunDir;
    const ocean = new Mesh(new SphereGeometry(EARTH_RADIUS, 64, 36), earthShader.material);
    this.earthGroup.add(ocean);

    // Single tight fresnel rim only — no secondary haze sphere (it muddied the
    // silhouette). See createRimAtmosphere.
    const rim = createRimAtmosphere(EARTH_RADIUS);
    this.rimSunUniform = rim.uniforms.uSunDir;
    this.earthGroup.add(rim.mesh);

    const cloudTexture = makeCloudTexture();
    const cloudMesh = new Mesh(
      new SphereGeometry(EARTH_RADIUS + 0.05, 48, 24),
      new MeshStandardMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.32,
        depthWrite: false,
        roughness: 1,
        metalness: 0,
      }),
    );
    cloudMesh.castShadow = false;
    cloudMesh.receiveShadow = false;
    this.cloudMesh = cloudMesh;
    this.earthGroup.add(this.cloudMesh);

    this.cityLights = this.makeSignalNodes();
    this.earthGroup.add(this.cityLights);
    // Whisper-faint graticule that fades out on the night side (one shared
    // day-side-fade material for every line; disposed once via disposeObject).
    const graticule = createGraticuleMaterial();
    this.gratSunUniform = graticule.uniforms.uSunDir;
    for (let lat = -60; lat <= 60; lat += 30) {
      this.earthGroup.add(makeGraticuleLatLine(lat, EARTH_RADIUS, graticule.material));
    }
    for (let lon = -150; lon <= 180; lon += 30) {
      this.earthGroup.add(makeGraticuleLonLine(lon, EARTH_RADIUS, graticule.material));
    }
    this.buildBaseMarker();
    this.earthGroup.add(this.baseMarker);
    if (this.selectedBase) this.placeMarker(this.selectedBase);
    else this.baseMarker.visible = false;
    for (let i = 0; i < MAX_EXTRA_BASES; i++) {
      const marker = this.buildExtraBaseMarker();
      marker.visible = false;
      this.extraBaseMarkers.add(marker);
    }
    this.earthGroup.add(this.extraBaseMarkers);
    this.buildUfoMarker(
      this.opts.campaign?.ufoContact?.missionType,
      this.opts.campaign?.ufoContact?.ufoType,
      this.opts.campaign?.ufoContact?.status === "crashed",
    );
    this.earthGroup.add(this.ufoMarker);
    if (this.opts.campaign?.ufoContact) this.placeUfoMarker(this.opts.campaign.ufoContact);
    else this.ufoMarker.visible = false;
    this.buildHqMarker();
    this.earthGroup.add(this.hqMarker);
    if (this.opts.campaign?.alienHq?.revealed) this.placeHqMarker(this.opts.campaign.alienHq.location);
    else this.hqMarker.visible = false;
    this.buildInterceptorMarker();
    this.interceptorMarker.visible = false;
    this.trajectoryLine.visible = false;
    this.ufoTrailLine.visible = false;
    this.earthGroup.add(this.trajectoryLine, this.interceptorMarker, this.ufoTrailLine);

    return ocean;
  }

  /** Pre-allocated base->UFO trajectory line; positions rewritten by fillTrajectory(). */
  private makeTrajectoryLine(): Line {
    const positions = new Float32Array((TRAJECTORY_SEGMENTS + 1) * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new Line(
      geometry,
      new LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.55 }),
    );
  }

  /**
   * Pre-allocated UFO flight trail: a polyline of recent airborne positions.
   * Per-vertex colors fade the tail into darkness so it reads as a contrail
   * rather than a debug line; additive blending lets dark vertices fade out
   * without a separate alpha channel. Both position + color buffers are
   * rewritten, and the draw range trimmed, on every refresh.
   */
  private makeUfoTrailLine(): Line {
    const positions = new Float32Array(UFO_TRAIL_MAX * 3);
    const colors = new Float32Array(UFO_TRAIL_MAX * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 0);
    const line = new Line(
      geometry,
      new LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.7,
        blending: AdditiveBlending,
      }),
    );
    line.frustumCulled = false;
    return line;
  }

  /**
   * Small teal interceptor dart: a slim elongated body (nose + tail cone joined
   * base-to-base) with two short swept fins, plus a subtle selection ring. The
   * marker's +Y is forward (oriented toward the UFO in animateInterceptor), so
   * the dart's nose points along the travel tangent. Teal is always paired with
   * the "INTERCEPTOR" label in the encounter overlay, so the craft is
   * identifiable without color alone.
   */
  private buildInterceptorMarker(): void {
    const body = new MeshStandardMaterial({
      color: 0x38e8d2,
      emissive: new Color(0x38e8d2),
      emissiveIntensity: 1.6,
      roughness: 0.3,
      metalness: 0.4,
    });
    // Long tapered nose pointing forward (+Y).
    const nose = new Mesh(new ConeGeometry(0.016, 0.11, 10), body);
    nose.position.y = 0.03;
    // Short tail cone flared back so the two cones read as a dart lozenge.
    const tail = new Mesh(new ConeGeometry(0.016, 0.05, 10), body);
    tail.position.y = -0.05;
    tail.rotation.x = Math.PI;
    // Two short swept fins in ±X.
    const finGeo = new BoxGeometry(0.05, 0.02, 0.004);
    const finR = new Mesh(finGeo, body);
    finR.position.set(0.026, -0.028, 0);
    finR.rotation.z = -0.5;
    const finL = new Mesh(finGeo, body);
    finL.position.set(-0.026, -0.028, 0);
    finL.rotation.z = 0.5;
    const ring = new Mesh(
      new RingGeometry(0.05, 0.064, 24),
      new MeshBasicMaterial({
        color: 0x38e8d2,
        transparent: true,
        opacity: 0.4,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.interceptorMarker.add(nose, tail, finR, finL, ring);
  }

  /** Very sparse, dim, deterministic starfield behind the globe (no grid). */
  private makeStars(): Points {
    const positions: number[] = [];
    for (let i = 0; i < 150; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 24634.6345;
      const c = Math.sin(i * 37.719) * 13579.1234;
      const x = ((a - Math.floor(a)) * 2 - 1) * 18;
      const y = ((b - Math.floor(b)) * 2 - 1) * 10;
      const z = -7 - (c - Math.floor(c)) * 10;
      positions.push(x, y, z);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new Points(
      geometry,
      new PointsMaterial({
        color: 0x9fb8cc,
        size: 0.013,
        transparent: true,
        opacity: 0.5,
        sizeAttenuation: true,
      }),
    );
  }

  /**
   * City points: emissive beacons that glow warm on the NIGHT side and dim on the
   * day side. Per-vertex colors (rewritten each frame by updateCityLights from the
   * sun direction) drive the intensity; additive blending + depthWrite off lets
   * them read as glowing city lights against the dark hemisphere. Each city's
   * local unit position is cached in cityLocal for the per-frame dot product.
   */
  private makeSignalNodes(): Points {
    const positions: number[] = [];
    const colors: number[] = [];
    for (const [lat, lon] of WORLD_CITY_POINTS) {
      const p = latLonToVector(lat, lon, EARTH_RADIUS + 0.034);
      positions.push(p.x, p.y, p.z);
      this.cityLocal.push(latLonToVector(lat, lon, 1).normalize());
      colors.push(0, 0, 0);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    return new Points(
      geometry,
      new PointsMaterial({
        color: 0xffffff,
        size: 0.016,
        transparent: true,
        opacity: 0.95,
        sizeAttenuation: true,
        vertexColors: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
  }

  /**
   * Recompute each city light's color from its dot product with the sun direction
   * (world space): bright warm amber on the dark (night) side, near-dark on the
   * day side. No per-frame allocation — reuses scratchCity + the cached positions.
   */
  private updateCityLights(): void {
    if (!this.cityLights || this.cityLocal.length === 0) return;
    const colAttr = this.cityLights.geometry.getAttribute("color") as Float32BufferAttribute;
    const arr = colAttr.array as Float32Array;
    // Sun direction in world space (sunLight is parented to the scene, not earthGroup).
    this.scratchA.copy(this.sunLight.position).normalize();
    const twilight = 0.15;
    for (let i = 0; i < this.cityLocal.length; i++) {
      this.scratchCity.copy(this.cityLocal[i]!);
      this.earthGroup.localToWorld(this.scratchCity);
      this.scratchCity.normalize();
      const dot = this.scratchCity.dot(this.scratchA);
      const t = Math.max(0, Math.min(1, (dot - -twilight) / (twilight - -twilight)));
      const night = t * t * (3 - 2 * t);
      const glow = 0.02 + night * 0.98;
      arr[i * 3] = 0.98 * glow;
      arr[i * 3 + 1] = 0.82 * glow;
      arr[i * 3 + 2] = 0.3 * glow;
    }
    colAttr.needsUpdate = true;
  }

  private trackBeacon(beacon: SurfaceBeacon): void {
    this.beaconPulseRings.push(beacon.pulseRing);
  }

  /** Sync atmosphere + earth shader sun direction with the live sun position. */
  private updateAtmosphere(): void {
    const sun = this.scratchA.copy(this.sunLight.position).normalize();
    if (this.earthSunUniform) this.earthSunUniform.value.copy(sun);
    if (this.rimSunUniform) this.rimSunUniform.value.copy(sun);
    if (this.gratSunUniform) this.gratSunUniform.value.copy(sun);
  }

  private buildBaseMarker(): void {
    this.trackBeacon(populateBaseBeacon(this.baseMarker, EARTH_RADIUS));
  }

  /** A slimmed-down cyan marker for an extra radar base (distinct from the gold primary). */
  private buildExtraBaseMarker(): Group {
    const group = new Group();
    this.trackBeacon(populateExtraBaseBeacon(group, EARTH_RADIUS));
    return group;
  }

  /** Violet/magenta endgame beacon for the revealed alien HQ. */
  private buildHqMarker(): void {
    this.trackBeacon(populateHqBeacon(this.hqMarker, EARTH_RADIUS));
  }

  private buildUfoMarker(
    missionType: MissionType | undefined,
    ufoType: UfoType | undefined,
    crashed: boolean,
  ): void {
    if (crashed) {
      // A downed contact reads as an amber crash cross regardless of type.
      this.trackBeacon(populateCrashBeacon(this.ufoMarker, EARTH_RADIUS));
      return;
    }
    const info = missionTypeInfo(missionType);
    const ufoColor = ufoTypeInfo(ufoType).color;
    this.trackBeacon(populateUfoBeacon(this.ufoMarker, EARTH_RADIUS, info.color, ufoColor, info.urgent));
  }

  private buildHud(): {
    region: HTMLElement;
    coords: HTMLElement;
    confirm: HTMLButtonElement;
    statsGrid: HTMLDivElement;
    noticeSlot: HTMLDivElement;
    introSlot: HTMLDivElement;
    chipRail: HTMLDivElement;
    actionsSlot: HTMLDivElement;
    overlaySlot: HTMLDivElement;
    toast: HTMLDivElement;
    speedBar: HTMLDivElement;
  } {
    // Left edge is no longer a tall glass column: a compact stat cluster plus a
    // rail of small floating chips (each opens a modal). The globe stays clear.
    const left = el("section", "geo-left");
    // Instructional copy — only on the new-game screen; a live campaign shows none.
    const introSlot = el("div", "geo-intro");
    const statsCluster = el("div", "geo-stats-cluster");
    const statsGrid = el("div", "geo-status");
    statsCluster.append(statsGrid);
    const noticeSlot = el("div");
    const chipRail = el("div", "geo-chip-rail");
    left.append(introSlot, statsCluster, noticeSlot, chipRail);
    this.root.appendChild(left);

    const right = el("section", "geo-panel geo-right");
    const siteEye = el("div", "eyebrow");
    siteEye.textContent = this.opts.campaign ? "Command site" : "Initial base placement";
    const heading = el("h2");
    heading.textContent = this.opts.campaign ? "Review base" : "Choose site";
    const site = el("div", "geo-site");
    const region = el("strong");
    const coords = el("div", "geo-coords");
    site.append(region, coords);
    const actionsSlot = el("div", "geo-actions");
    // The confirm button is a persistent node; refreshActions re-parents it as needed
    // (its click handler reads live selection state, so the node must survive refreshes).
    const confirm = el("button", "primary ui-cta");
    confirm.addEventListener("click", () => {
      if (!this.selectedBase) return;
      const difficulty = this.opts.campaign?.strategic.difficulty ?? this.selectedDifficulty;
      this.opts.onConfirmBase(this.selectedBase, difficulty);
    });
    right.append(siteEye, heading, site);
    if (!this.opts.campaign) right.append(this.buildDifficultySelector());
    right.append(actionsSlot);
    this.root.appendChild(right);

    const hint = el("div", "geo-hint");
    this.hintEl = hint;
    this.root.appendChild(hint);
    const overlaySlot = el("div", "geo-overlay-host");
    this.root.appendChild(overlaySlot);
    const toast = el("div", "geo-toast");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    this.root.appendChild(toast);

    // Prominent centered bottom bar for the time-flow speed controls (the primary
    // verb on this screen). The .geo-speed group is re-parented here in refreshActions.
    const speedBar = el("div", "geo-speed-bar");
    this.root.appendChild(speedBar);

    const help = el("button", "geo-help");
    help.type = "button";
    help.textContent = "?";
    help.title = "Geoscape controls — click for help";
    help.setAttribute("aria-label", "Open geoscape help");
    help.addEventListener("click", () => this.toggleHelp(true));
    this.root.appendChild(help);
    this.helpOverlay = this.buildHelpOverlay();
    this.root.appendChild(this.helpOverlay);
    this.welcomeBanner = this.buildWelcomeBanner();
    this.root.appendChild(this.welcomeBanner);

    return { region, coords, confirm, statsGrid, noticeSlot, introSlot, chipRail, actionsSlot, overlaySlot, toast, speedBar };
  }

  /**
   * Re-render every dynamic panel, marker, and the time-control state in place.
   * Called from the constructor (first render) and from update(). Never disposes
   * or rebuilds the three.js scene — only moves markers and refreshes DOM text.
   */
  private refresh(): void {
    this.notifyCampaignEvent();
    this.refreshForcedPause();
    this.refreshStats();
    this.refreshNotice();
    this.refreshIntro();
    this.refreshDeploymentArrival();
    this.refreshChips();
    this.refreshActions();
    this.refreshOverlay();
    this.refreshZoomTransition();
    this.refreshMarkers();
    this.refreshInterceptor();
    this.refreshSpeedState();
    this.refreshFastForward();
    this.refreshHint();
    this.refreshOpenModal();
    this.applyCanvasCursor();
  }

  /** Set the hint line below the globe from the current interaction mode. */
  private refreshHint(): void {
    if (!this.hintEl) return;
    this.hintEl.textContent = this.buildMode
      ? "Click a site on the globe to build a new radar base (2000c, 48h)."
      : this.campaign
        ? "Time controls scan the globe / intercept UFOs / launch recovery from base"
        : "Drag to rotate / wheel to zoom / click Earth to designate base";
  }

  /** True while an interactive interception encounter (pursuit or engagement) is live. */
  private isEngaging(): boolean {
    const c = this.campaign;
    return !!c?.interception && c?.ufoContact?.status === "engaging";
  }

  /** True while the encounter is still the globe pursuit act (before THE ZOOM). */
  private isPursuing(): boolean {
    const c = this.campaign;
    return !!c?.interception && c.ufoContact?.status === "engaging" && c.interception.phase !== "engagement";
  }

  /**
   * Fire onZoomToDogfight exactly once per encounter, the frame its real km gap
   * crosses into the engagement phase. NAV (main.ts) disposes this view and mounts
   * PlaneCombatView in response — the pursuit act's job ends here.
   */
  private refreshZoomTransition(): void {
    const c = this.campaign;
    const enc = c?.interception;
    if (!c || !enc || c.ufoContact?.status !== "engaging") {
      this.zoomedContactId = null;
      return;
    }
    if (enc.phase === "engagement" && this.zoomedContactId !== enc.contactId) {
      this.zoomedContactId = enc.contactId;
      this.opts.onZoomToDogfight?.(c);
    }
  }

  /** Pause + toast when a notable event appears versus the previously rendered snapshot. */
  private notifyCampaignEvent(): void {
    // No campaign in context (new-game / difficulty screen): reset the module-scoped
    // snapshot so a freshly-created campaign is never diffed against a prior, now-dead
    // campaign's state. Without this the constructor's first refresh diffs the old
    // snapshot (missionsCompleted > 0) against a 0 baseline and fires a bogus "Mission
    // report filed" event on game start — which NAV would then beacon into the new base.
    if (!this.campaign) {
      lastEventSnapshot = null;
      return;
    }
    const snapshot = snapshotEvent(this.campaign);
    if (lastEventSnapshot !== null) {
      const info = detectEvent(lastEventSnapshot, this.campaign);
      if (info) {
        // Auto-pause diet: only demand-attention events (won/lost, ufoLanded, council
        // review, funding/mission reports) yank time back to 0x. Routine UFO spawns and
        // interception-report filings still toast but let fast-forward keep running.
        if (shouldForcePause(info)) this.setTimeSpeed(0);
        this.showToast(info);
        if (info.kind === "council") this.openCouncilModal();
        // Surface the event to NAV so it can beacon the matching base facility +
        // toast when the player is back at base (the geoscape's own toast fired
        // above for the on-globe case).
        this.opts.onCampaignEvent?.({ kind: info.alertKind, message: info.text });
      }
    }
    lastEventSnapshot = snapshot;
  }

  /** Force pause whenever an overlay is up or the campaign is no longer active. */
  private refreshForcedPause(): void {
    // Deployment no longer freezes time — the Skyranger flies while the globe stays
    // live. Only an active interception encounter or a finished campaign pauses.
    if (this.isEngaging() && this.timeSpeed !== 0) this.setTimeSpeed(0);
    else if (this.campaign && this.campaign.strategic.status !== "active" && this.timeSpeed !== 0) {
      this.setTimeSpeed(0);
    }
  }

  private setTimeSpeed(speed: number): void {
    this.timeSpeed = speed;
    // Persist across the current remount-based controller so flow stays continuous.
    resumedTimeSpeed = speed;
    this.timeAccumulatorMs = 0;
    this.lastFlowMs = 0;
    this.refreshSpeedState();
    // Reconcile the FAST FORWARD nudge immediately: engaging 30x must hide it this
    // frame (not wait for the next flow tick's refresh), and dropping below 30x mid-
    // transit must bring it back — otherwise a throttled/low-tick session leaves a
    // stale chip (or misses re-showing it) between refreshes.
    this.refreshFastForward();
  }

  private refreshSpeedState(): void {
    const interactive =
      !!this.campaign &&
      this.campaign.strategic.status === "active" &&
      !this.isEngaging();
    for (const btn of this.speedButtons) {
      const speed = Number(btn.dataset.speed);
      btn.setAttribute("aria-pressed", String(this.timeSpeed === speed));
      btn.disabled = !interactive;
    }
  }

  /**
   * Time-compression nudge (classic X-COM pattern): while the Skyranger is still
   * IN TRANSIT (not yet on station) and nothing else demands attention — no live
   * interception, campaign still active — dock a small "FAST FORWARD to arrival"
   * chip beside the speed controls that jumps to 30x on click. It never changes
   * speed on its own; the player opts in. Auto-pause on arrival (refreshDeploymentArrival)
   * then halts the compression. The pulse is suppressed under reducedMotion.
   */
  private refreshFastForward(): void {
    const c = this.campaign;
    const inTransit = !!c && (c.activeFlights ?? []).some(
      (f) => f.purpose === "deployment" && f.arrived !== true && f.progress < 1,
    );
    // Attention demands that should NOT be steamrolled by a compression nudge: a live
    // interception, a finished campaign, or already running at max compression.
    const show =
      inTransit &&
      c.strategic.status === "active" &&
      !this.isEngaging() &&
      this.timeSpeed !== 30;
    if (!show) {
      this.fastForwardChip?.remove();
      return;
    }
    if (!this.fastForwardChip) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "geo-ff-chip";
      chip.innerHTML =
        '<span class="geo-ff-icon" aria-hidden="true">⏭</span>' +
        '<span class="geo-ff-text"><span class="geo-ff-label">Fast forward</span>' +
        '<span class="geo-ff-sub">to Skyranger arrival · 30×</span></span>';
      chip.title = "Compress time to 30× until the transport reaches its site (auto-pauses on arrival)";
      chip.addEventListener("click", () => this.setTimeSpeed(30));
      this.fastForwardChip = chip;
    }
    // Pulse to draw the eye — neutralized for reduced-motion users.
    this.fastForwardChip.classList.toggle("geo-ff-chip--pulse", !this.reducedMotion);
    if (this.fastForwardChip.parentElement !== this.speedBar) {
      this.speedBar.appendChild(this.fastForwardChip);
    }
  }

  private showToast(info: EventInfo): void {
    const icon = info.kind === "won" ? "★" : info.kind === "lost" ? "✕" : "▸";
    this.toast.dataset.kind = info.kind;
    this.toast.textContent = `${icon}  ${info.text}`;
    this.toast.classList.add("visible");
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove("visible");
    }, 3600);
  }

  /** Toggle the concise geoscape HELP overlay (controls + mechanics reference). */
  toggleHelp(force?: boolean): void {
    if (!this.helpOverlay) return;
    const show = force ?? !this.helpOverlay.classList.contains("show");
    this.helpOverlay.classList.toggle("show", show);
  }

  private buildHelpOverlay(): HTMLDivElement {
    const overlay = el("div", "geo-overlay geo-help-overlay");
    const card = el("div", "geo-help-card");
    const eye = el("div", "eyebrow");
    eye.textContent = "Global controls";
    const title = el("h2");
    title.textContent = "Earth Command";
    const lede = el("p", "lede");
    lede.textContent =
      "The geoscape. Time flows here — detect UFO contacts, intercept them, and launch assault missions from your base.";
    const list = el("ul");
    const tips: Array<[string, string]> = [
      ["Time", "flows at Pause / 1× / 5× / 30× — advance it to detect UFOs and trigger events."],
      ["Globe", "drag to rotate, wheel to zoom (click Earth to place your base in a new game)."],
      ["Airborne UFO", "Intercept to scramble your fighter and shoot it down."],
      ["Crash / terror sites", "become assault missions — return to Base to launch your squad."],
      ["Threat & Panic", "rise as aliens act — lose enough regions and the council defunds X-COM."],
    ];
    for (const [head, copy] of tips) {
      const li = el("li");
      const b = el("b");
      b.textContent = `${head} `;
      li.append(b, document.createTextNode(copy));
      list.appendChild(li);
    }
    const actions = el("div", "geo-help-actions");
    const close = el("button");
    close.type = "button";
    close.textContent = "Got it [ESC]";
    close.addEventListener("click", () => this.toggleHelp(false));
    actions.appendChild(close);
    card.append(eye, title, lede, list, actions);
    overlay.append(card);
    overlay.addEventListener("click", (e: MouseEvent) => {
      if (e.target === overlay) this.toggleHelp(false);
    });
    return overlay;
  }

  /**
   * First-run welcome tip. Shown once, only when there is no saved campaign
   * (the new-game geoscape) and the seen-hints flag is unset. The flag is set the
   * moment it shows, so the tip never recurs on subsequent loads.
   */
  private maybeShowWelcome(): void {
    if (!this.welcomeBanner || this.opts.campaign !== null) return;
    if (hintsSeen()) return;
    markHintsSeen();
    this.welcomeBanner.classList.add("show");
  }

  private dismissWelcome(): void {
    if (!this.welcomeBanner) return;
    this.welcomeBanner.classList.remove("show");
    markHintsSeen();
  }

  private buildWelcomeBanner(): HTMLDivElement {
    const banner = el("div", "geo-welcome");
    const eye = el("div", "eyebrow");
    eye.textContent = "Welcome, Commander";
    const heading = el("b");
    heading.textContent = "New to X-COM? Here's the loop:";
    const steps = el("ol");
    const items = [
      "Pick a base site — click anywhere on land to place your headquarters.",
      "Advance time (1× / 5× / 30×) to scan for UFO contacts and events.",
      "Intercept airborne UFOs, then return to base to launch a recovery assault.",
    ];
    for (const text of items) {
      const li = el("li");
      li.textContent = text;
      steps.appendChild(li);
    }
    const actions = el("div", "geo-welcome-actions");
    const dismiss = el("button");
    dismiss.type = "button";
    dismiss.textContent = "Got it";
    dismiss.addEventListener("click", () => this.dismissWelcome());
    actions.appendChild(dismiss);
    banner.append(eye, heading, steps, actions);
    return banner;
  }

  private refreshStats(): void {
    this.statsGrid.replaceChildren();
    const c = this.campaign;
    if (!c) {
      this.statsGrid.append(
        this.stat("Threat", "Unknown"),
        this.stat("Funding", "Pending"),
        this.stat("Readiness", "Base required"),
      );
      return;
    }
    const panic = highestRegionalPanic(c);
    const objective = campaignObjectiveProgress(c);
    // Tones are state-derived (Style Bible rule: one accent per semantic class, and
    // only when the state warrants it) so a calm campaign doesn't glow amber. Matches
    // the base view's threat thresholds (danger >=70, warn >=40, neutral otherwise).
    const threat = c.strategic.threat;
    const threatTone = threat >= 70 ? "danger" : threat >= 40 ? "warn" : "info";
    const panicTone = panic.panic >= 75 ? "danger" : panic.panic >= 40 ? "warn" : "info";
    this.statsGrid.append(
      (() => {
        const clockStat = this.stat("Clock", formatCampaignClock(c.clock), "in-world date and time of day", "info");
        this.clockStatValue = clockStat.querySelector(".ui-chip__value");
        return clockStat;
      })(),
      this.stat("Threat", formatPercent(threat), "global X-COM threat — drives council panic", threatTone),
      this.stat("Funding", groupThousands(c.strategic.funding), "monthly council funding index", "accent"),
      this.stat("Cores", `${objective.completed}/${objective.required}`, "recovered UFO cores — campaign objective", "info"),
      this.stat(
        "Panic",
        `${panic.region} ${formatPercent(panic.panic)}`,
        "highest regional panic — a region at 100% defects",
        panicTone,
      ),
    );
  }

  private refreshNotice(): void {
    const notice = this.buildNotice();
    this.noticeSlot.replaceChildren(...(notice ? [notice] : []));
  }

  /** New-game instructional copy in the left column; empty for a live campaign. */
  private refreshIntro(): void {
    if (this.campaign) {
      this.introSlot.replaceChildren();
      return;
    }
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Blacksite global command";
    const title = el("h1");
    title.textContent = "Earth Command";
    const copy = el("p");
    copy.textContent =
      "Select a first base site on the globe. This becomes the permanent command center for the campaign.";
    this.introSlot.replaceChildren(eyebrow, title, copy);
  }

  /**
   * Rebuild the floating left-edge chip rail. A live campaign shows one-line pills
   * — Objective / Contact / Fleet / Reports — each opening a console-glass modal
   * with the detail that used to fill the tall column. The DEPLOY chip is prepended
   * when a Skyranger has reached its site (see refreshDeploymentArrival).
   */
  private refreshChips(): void {
    const c = this.campaign;
    if (!c) {
      announcedContactId = null;
      this.syncChipRail([]);
      return;
    }

    const descs: GeoChipDesc[] = [];

    // DEPLOY chip: a deployment flight on station (arrived flag or progress >= 1).
    // The critical softlock guard (campaign/geoscape.ts) keeps a deployment flight
    // only while its deployContactId still matches a live contact, so an arrived
    // flight's contact is present here — but we still label by (and fire on) the
    // FLIGHT's own destination contact id, never a live-contact fallback, so a
    // version-skewed / mid-reload frame can never begin an assault against a UFO the
    // Skyranger never flew to.
    const arrivedDeploy = (c.activeFlights ?? []).find(
      (f) => f.purpose === "deployment" && (f.arrived === true || f.progress >= 1),
    );
    if (arrivedDeploy && arrivedDeploy.deployContactId) {
      const targetId = arrivedDeploy.deployContactId;
      const flightContact = c.ufoContact?.id === targetId ? c.ufoContact : undefined;
      const region = flightContact?.region ?? "mission site";
      descs.push({
        key: "deploy",
        icon: "✈",
        label: "Deploy — begin assault",
        sub: `Skyranger on station · ${region}`,
        tone: "danger",
        pulse: true,
        extraClass: "geo-chip-deploy",
        onClick: () => this.opts.onBeginAssault?.(targetId),
      });
    }

    // Objective chip.
    const objective = campaignObjectiveProgress(c);
    descs.push({
      key: "objective",
      icon: "◎",
      label: "Objective",
      sub: `${objective.completed}/${objective.required} cores · ${formatPercent(objective.percent)}`,
      tone: objective.status === "active" ? "info" : "done",
      onClick: () => this.openGeoModal("objective"),
    });

    // Contact chip — pulses once when a new UFO id first appears.
    const contact = c.ufoContact;
    const contactId = contact?.id ?? null;
    const lostAtSea = !!contact && contact.status === "crashed" && !!contact.overOcean;
    const contactTone: GeoChipTone = !contact
      ? "muted"
      : contact.status === "crashed" || contact.status === "landed"
        ? lostAtSea
          ? "muted"
          : "warn"
        : "danger";
    const contactEnter = !!contactId && contactId !== announcedContactId;
    announcedContactId = contactId;
    descs.push({
      key: "contact",
      icon: contact ? "⚠" : "◌",
      label: "Contact",
      sub: contact ? this.contactStatusLabel(contact) : "No UFO — radar sweeping",
      tone: contactTone,
      enter: contactEnter,
      onClick: () => this.openGeoModal("contact"),
    });

    // Fleet chip — interceptor readiness.
    const repairedAt = c.interceptor.repairedAtHour;
    const repairing = repairedAt !== undefined && repairedAt > c.clock.elapsedHours;
    descs.push({
      key: "fleet",
      icon: "✦",
      label: "Fleet",
      sub: repairing
        ? `Interceptor repair · ${formatHours(repairedAt - c.clock.elapsedHours)}`
        : "Interceptor ready",
      tone: repairing ? "warn" : "info",
      onClick: () => this.openGeoModal("fleet"),
    });

    // Reports chip — council + funding + project digest.
    const panic = highestRegionalPanic(c);
    const fundingReport = c.lastFundingReport;
    descs.push({
      key: "reports",
      icon: "▤",
      label: "Reports",
      sub: fundingReport ? `Funding #${fundingReport.reportNumber} filed` : "Awaiting first council transfer",
      tone: panic.panic >= 75 ? "warn" : "info",
      onClick: () => this.openGeoModal("reports"),
    });

    this.syncChipRail(descs);
  }

  /**
   * Reconcile the chip rail against `descs` WITHOUT recreating nodes: reuse each
   * cached chip by key (mutating only text / tone class / handler), create missing
   * ones, drop stale ones, and reorder to match. Reusing nodes keeps the DEPLOY
   * chip's pulse animation running (a stable className string never restarts it) and
   * lets a click survive a mid-gesture refresh tick.
   */
  private syncChipRail(descs: GeoChipDesc[]): void {
    const seen = new Set<string>();
    descs.forEach((desc, i) => {
      seen.add(desc.key);
      let handle = this.chipCache.get(desc.key);
      if (!handle) {
        handle = this.createChipHandle();
        this.chipCache.set(desc.key, handle);
      }
      this.applyChipDesc(handle, desc);
      const atPos = this.chipRail.children[i];
      if (atPos !== handle.chip) this.chipRail.insertBefore(handle.chip, atPos ?? null);
    });
    for (const [key, handle] of this.chipCache) {
      if (!seen.has(key)) {
        handle.chip.remove();
        this.chipCache.delete(key);
      }
    }
  }

  /** Build a fresh reusable chip node with one stable click listener. */
  private createChipHandle(): GeoChipHandle {
    const chip = el("button", "geo-chip");
    chip.type = "button";
    const dot = el("span", "geo-chip-dot");
    const icon = el("span", "geo-chip-icon");
    const text = el("span", "geo-chip-text");
    const label = el("span", "geo-chip-label");
    const sub = el("span", "geo-chip-sub");
    text.append(label, sub);
    chip.append(dot, icon, text);
    const handle: GeoChipHandle = { chip, dot, icon, label, sub, className: "", onClick: () => {} };
    // One listener for the node's whole lifetime — indirects through handle.onClick,
    // which each refresh points at a fresh closure over live state.
    chip.addEventListener("click", () => handle.onClick());
    return handle;
  }

  /** Mutate a cached chip's text / tone / handler in place; never recreate the node. */
  private applyChipDesc(handle: GeoChipHandle, desc: GeoChipDesc): void {
    if (handle.icon.textContent !== desc.icon) handle.icon.textContent = desc.icon;
    if (handle.label.textContent !== desc.label) handle.label.textContent = desc.label;
    if (handle.sub.textContent !== desc.sub) handle.sub.textContent = desc.sub;
    handle.chip.title = `${desc.label}: ${desc.sub}`;
    handle.onClick = desc.onClick;
    // Stable className string (deterministic order) so an unchanged tone/pulse never
    // reassigns className identically-but-restarts nothing; the pulse animation lives
    // on geo-chip--pulse and survives because the class list does not change.
    const base = `geo-chip geo-chip--${desc.tone}${desc.pulse ? " geo-chip--pulse" : ""}${
      desc.extraClass ? ` ${desc.extraClass}` : ""
    }`;
    if (handle.className !== base) {
      handle.className = base;
      handle.chip.className = base;
    }
    // One-shot enter animation: retrigger by removing + reflowing + re-adding.
    if (desc.enter) {
      handle.chip.classList.remove("geo-chip--enter");
      void handle.chip.offsetWidth;
      handle.chip.classList.add("geo-chip--enter");
    }
  }

  /**
   * Detect a non-blocking deployment flight reaching its site (progress >= 1) and
   * fire onDeploymentArrived + a toast exactly once. The DEPLOY chip is rendered by
   * refreshChips from the same arrived condition, so it appears on the same frame.
   */
  private refreshDeploymentArrival(): void {
    const flights = this.campaign?.activeFlights ?? [];
    for (const flight of flights) {
      if (flight.purpose !== "deployment") continue;
      if (flight.progress < 1) continue;
      if (flight.arrived === true || this.deployArrivedFired.has(flight.id)) continue;
      this.deployArrivedFired.add(flight.id);
      // Label by the flight's own destination contact, not whatever contact is live
      // now (they can differ if the original expired and a new one spawned).
      const live = this.campaign?.ufoContact;
      const region =
        live && live.id === flight.deployContactId ? live.region : "the mission site";
      this.showToast({
        kind: "info",
        text: `Skyranger on station over ${region} — deploy to begin the assault.`,
        alertKind: "ufoLanded",
      });
      // Classic X-COM auto-pause: the transport reaching its site is a demand-attention
      // event, so freeze time (undoing any FAST FORWARD the player engaged) and let them
      // decide when to click DEPLOY. Fires once per flight (deployArrivedFired guard above).
      if (this.timeSpeed !== 0) this.setTimeSpeed(0);
      this.opts.onDeploymentArrived?.(flight.id);
    }
  }

  /** Open a console-glass modal for the given chip (dim backdrop, Esc / click-out close). */
  private openGeoModal(kind: GeoModalKind): void {
    if (!this.campaign) return;
    this.closeGeoModal();
    const backdrop = el("div", "geo-modal-backdrop");
    const modal = el("div", "geo-modal");
    const head = el("div", "geo-modal-head");
    const title = el("h2", "geo-modal-title");
    const close = el("button", "geo-modal-close");
    close.type = "button";
    close.textContent = "✕";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => this.closeGeoModal());
    head.append(title, close);
    const body = el("div", "geo-modal-body");
    modal.append(head, body);
    backdrop.append(modal);
    backdrop.addEventListener("click", (e: MouseEvent) => {
      if (e.target === backdrop) this.closeGeoModal();
    });
    this.root.appendChild(backdrop);
    this.modalBackdrop = backdrop;
    this.modalTitleEl = title;
    this.modalBodySlot = body;
    this.openModalKind = kind;
    this.refreshOpenModal();
  }

  /** Opens the blocking end-of-month council debrief modal (see notifyCampaignEvent /
   *  detectEvent). Fired once per council-report crossing; the report stays viewable
   *  afterward via the "reports" chip's council card, which does not re-block. */
  private openCouncilModal(): void {
    this.openGeoModal("council");
  }

  private closeGeoModal(): void {
    this.modalBackdrop?.remove();
    this.modalBackdrop = null;
    this.modalTitleEl = null;
    this.modalBodySlot = null;
    this.openModalKind = null;
  }

  /** Rebuild the open modal's live content each refresh so it never goes stale. */
  private refreshOpenModal(): void {
    const kind = this.openModalKind;
    if (!kind || !this.modalBodySlot || !this.modalTitleEl) return;
    if (!this.campaign) {
      this.closeGeoModal();
      return;
    }
    const titles: Record<GeoModalKind, string> = {
      objective: "Campaign objective",
      contact: "UFO contact",
      fleet: "Fleet status",
      reports: "Council reports",
      council: "Council review",
    };
    this.modalTitleEl.textContent = titles[kind];
    this.modalBodySlot.replaceChildren(...this.buildModalBody(kind));
  }

  /** Full detail for a chip's modal — the content that used to fill the column. */
  private buildModalBody(kind: GeoModalKind): HTMLElement[] {
    switch (kind) {
      case "objective":
        return [this.objectiveCard()];
      case "contact":
        return [this.contactCard()];
      case "fleet":
        return [this.aircraftCard()];
      case "reports": {
        const rows = el("div", "geo-rows");
        rows.append(this.councilCard(), this.fundingCard(), this.projectCard());
        return [rows];
      }
      case "council":
        return [this.councilReportModalBody()];
    }
  }

  /** Blocking end-of-month council debrief: per-region funding-delta table, the
   *  monthly rating/grade, and a one-line narrative. Rendered from the newest
   *  entry in campaign.councilReports (fired by advanceGeoscape at each 30-day
   *  boundary — see openCouncilModal / detectEvent). */
  private councilReportModalBody(): HTMLElement {
    const wrap = el("div", "geo-rows");
    const report = this.campaign?.councilReports?.[0];
    if (!report) {
      const empty = el("section", "geo-row");
      const title = el("strong");
      title.textContent = "No council review yet";
      const copy = el("p");
      copy.textContent = "The council issues its first monthly review after 30 campaign days.";
      empty.append(title, copy);
      wrap.append(empty);
      return wrap;
    }
    const summary = el("div", "geo-council-summary");
    const grade = el("span", "geo-council-grade");
    grade.textContent = report.grade;
    const summaryText = el("span");
    summaryText.textContent =
      `Month ${report.month} · rating ${report.rating} · net ${formatSignedCredits(report.net)} ` +
      `(income ${formatCredits(report.income)}, upkeep ${formatCredits(report.upkeep)})`;
    summary.append(grade, summaryText);
    const narrative = el("p", "geo-council-narrative");
    narrative.textContent = report.narrative;
    const head = el("div", "geo-council-row head");
    head.append(
      Object.assign(el("span"), { textContent: "Region" }),
      Object.assign(el("span"), { textContent: "Panic" }),
      Object.assign(el("span"), { textContent: "Infiltration" }),
      Object.assign(el("span"), { textContent: "Funding Δ" }),
    );
    const rows = [head];
    for (const region of report.regions) {
      const row = el("div", region.defected ? "geo-council-row defected" : "geo-council-row");
      const name = el("strong");
      name.textContent = region.defected ? `${region.region} (defected)` : region.region;
      row.append(
        name,
        Object.assign(el("span"), { textContent: formatPercent(region.panic) }),
        Object.assign(el("span"), { textContent: formatPercent(region.infiltration) }),
        Object.assign(el("span"), { textContent: formatSignedCredits(region.fundingDelta) }),
      );
      rows.push(row);
    }
    const total = el("div", "geo-council-row");
    const totalLabel = el("strong");
    totalLabel.textContent = "Total";
    total.append(
      totalLabel,
      Object.assign(el("span"), { textContent: "" }),
      Object.assign(el("span"), { textContent: "" }),
      Object.assign(el("span"), { textContent: formatSignedCredits(report.totalFundingDelta) }),
    );
    rows.push(total);
    wrap.append(summary, narrative, ...rows);
    return wrap;
  }

  /**
   * Rebuild the right-panel action row: reset, the Pause/1x/5x/30x speed controls
   * (replacing the legacy single Scan button), an Intercept affordance while a UFO
   * is tracked, and the persistent confirm button when no live contact blocks it.
   */
  private refreshActions(): void {
    this.actionsSlot.replaceChildren();
    const c = this.campaign;
    const reset = el("button", "ui-btn");
    reset.textContent = c ? "New campaign" : "Reset";
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    this.actionsSlot.append(reset);
    if (!c) {
      this.actionsSlot.append(this.confirmButton);
      return;
    }
    // The geoscape is the Command Center room: a "Back to Base" control returns to
    // the base overview. Present only for an existing campaign (never on the
    // new-game difficulty screen, handled by the !c early return above).
    if (this.opts.onBackToBase) {
      const back = el("button", "ui-btn geo-back-to-base");
      back.type = "button";
      back.textContent = "Back to Base";
      back.title = "Return to the base overview";
      back.addEventListener("click", () => this.opts.onBackToBase?.());
      this.actionsSlot.append(back);
    }
    // The speed group is built ONCE and reused across every tick (see field doc):
    // rebuilding it each refresh detached the buttons mid-click and froze time control
    // during a deployment transit. aria-pressed is synced separately by refreshSpeedState.
    if (!this.speedGroup) {
      const speedGroup = el("div", "geo-speed");
      speedGroup.setAttribute("role", "group");
      speedGroup.setAttribute("aria-label", "Time speed");
      for (const option of SPEED_OPTIONS) {
        const btn = el("button", "geo-speed-btn");
        btn.type = "button";
        btn.dataset.speed = String(option.speed);
        const icon = el("span", "geo-speed-icon");
        icon.textContent = option.icon;
        const label = el("span");
        label.textContent = option.label;
        btn.append(icon, label);
        const hint = option.speed === 0
          ? "time frozen — no events advance"
          : option.speed === 1
            ? "near real-time pace"
            : "faster flow — events still auto-pause";
        btn.title = `${option.label} — ${hint}`;
        btn.setAttribute("aria-pressed", String(this.timeSpeed === option.speed));
        btn.addEventListener("click", () => this.setTimeSpeed(option.speed));
        speedGroup.append(btn);
        this.speedButtons.push(btn);
      }
      this.speedGroup = speedGroup;
      this.speedBar.replaceChildren(speedGroup);
    }
    const can = canBuildNewBase(c);
    const build = el("button", this.buildMode ? "ui-btn ui-btn--danger" : "ui-btn");
    build.textContent = this.buildMode ? "Cancel build" : `Build base (${formatCredits(NEW_BASE_COST.credits)})`;
    build.disabled = !this.buildMode && !can.ok;
    build.title = this.buildMode ? "Exit base-placement mode" : can.ok ? "Designate a new radar base on the globe" : (can.reason ?? "Cannot build a new base right now");
    build.setAttribute("aria-pressed", String(this.buildMode));
    build.addEventListener("click", () => {
      this.buildMode = !this.buildMode;
      this.refresh();
    });
    this.actionsSlot.append(build);
    // The endgame's one urgent action: once the alien HQ is revealed and the
    // assault is unlocked, this takes priority over every other action — placed
    // first so it is unmissable the moment it becomes available.
    // The HQ assault shares the squad with a ground deployment: suppress it while a
    // Skyranger is airborne/on-station so the player can't launch both (main.ts gates
    // this at the model level too, but a hidden button beats a no-op one).
    const deployInFlight = (c.activeFlights ?? []).some((f) => f.purpose === "deployment");
    if (canLaunchFinalAssault(c) && !deployInFlight) {
      const assault = el("button", "primary ui-cta geo-assault-cta");
      assault.textContent = "ASSAULT ALIEN HQ";
      assault.title = "Launch the final decapitating strike on the alien homeworld base — victory ends the war.";
      assault.addEventListener("click", () => this.opts.onLaunchAssault?.());
      this.actionsSlot.prepend(assault);
    }
    if (c.ufoContact?.status === "tracked") {
      const intercept = el("button", "primary ui-cta");
      const forecast = interceptionForecast(c);
      // An out-run UFO cannot be forced down at any score (see the campaign layer's
      // hard gate). The intercept stays ENABLED — a commander may still scramble to
      // harass it — but the button and title carry the warning.
      const outrun = interceptionSpeedAdvantage(c, c.ufoContact) === "outrun";
      intercept.textContent = isInterceptorReady(c)
        ? outrun
          ? "Intercept (outrun)"
          : forecast?.risk === "dangerous"
            ? "Risk intercept"
            : "Intercept"
        : "Repairing";
      if (outrun) intercept.classList.add("geo-cta-warn");
      intercept.disabled = !canLaunchInterceptor(c);
      const ufoInfo = ufoTypeInfo(c.ufoContact?.ufoType);
      intercept.title = outrun
        ? `${ufoInfo.label} outruns your fastest craft — it cannot be forced down and will open the range every pass. Closing only burns fuel. Field a faster interceptor to catch it.`
        : `Engage ${ufoInfo.label} — threat ${ufoInfo.threat}`;
      intercept.addEventListener("click", () => this.opts.onInterceptUfo());
      this.actionsSlot.append(intercept);
    }
    if (!c.ufoContact || c.ufoContact.status === "crashed") {
      this.actionsSlot.append(this.confirmButton);
    }
  }

  private refreshOverlay(): void {
    if (this.isPursuing()) {
      // Mount the pursuit HUD once per pursuit and just resync its numbers on every
      // later refresh — no beat/reveal delay: keepChasing/disengage apply immediately.
      if (this.interceptOverlayEl) {
        this.syncInterceptionOverlay();
        return;
      }
      this.overlaySlot.replaceChildren(this.buildInterceptionOverlay());
      return;
    }
    this.interceptOverlayEl = null;
    this.interceptButtons = [];
    this.overlaySlot.replaceChildren();
  }

  /** Reposition the base + UFO markers; rebuild the UFO marker when its mission type changes. */
  private refreshMarkers(): void {
    const c = this.campaign;
    if (c?.base) this.placeMarker(c.base);
    else this.baseMarker.visible = false;
    const extras = c?.bases ?? [];
    const pool = this.extraBaseMarkers.children;
    for (let i = 0; i < pool.length; i++) {
      const marker = pool[i]!;
      const loc = extras[i];
      if (loc) {
        const normal = latLonToVector(loc.lat, loc.lon, 1).normalize();
        marker.visible = true;
        marker.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.08);
        marker.quaternion.setFromUnitVectors(UP, normal);
      } else {
        marker.visible = false;
      }
    }
    const contact = c?.ufoContact;
    if (contact) {
      this.refreshUfoMarkerType(contact.missionType, contact.ufoType, contact.status === "crashed");
      this.placeUfoMarker(contact);
      this.refreshUfoTrail(contact);
    } else {
      this.ufoMarker.visible = false;
      this.clearUfoTrail();
    }
    if (c?.alienHq?.revealed) this.placeHqMarker(c.alienHq.location);
    else this.hqMarker.visible = false;
    this.refreshFlightMarkers();
    this.refreshDeploymentRoute();
  }

  /**
   * Sample the UFO's flight into the trail while it is airborne (tracked or
   * engaging). The contact now moves as time flows, so this is what makes the
   * UFO visibly fly across the globe. A new contact id resets the trail; a
   * crashed/landed contact freezes it (the path it took to come down stays up).
   */
  private refreshUfoTrail(contact: UfoContact): void {
    if (this.ufoTrailContactId !== contact.id) {
      this.ufoTrailContactId = contact.id;
      this.ufoTrail = [{ lat: contact.lat, lon: contact.lon }];
    } else if (contact.status === "tracked" || contact.status === "engaging") {
      const last = this.ufoTrail[this.ufoTrail.length - 1];
      if (!last || Math.hypot(contact.lat - last.lat, contact.lon - last.lon) >= UFO_TRAIL_MIN_DEG) {
        this.ufoTrail.push({ lat: contact.lat, lon: contact.lon });
        if (this.ufoTrail.length > UFO_TRAIL_MAX) this.ufoTrail.shift();
      }
    }
    this.refillUfoTrailLine();
  }

  private clearUfoTrail(): void {
    this.ufoTrailContactId = null;
    this.ufoTrail = [];
    this.ufoTrailLine.geometry.setDrawRange(0, 0);
    this.ufoTrailLine.visible = false;
  }

  /** Rewrite the trail line buffers from the sampled positions with a tail→head fade. */
  private refillUfoTrailLine(): void {
    const count = this.ufoTrail.length;
    const geo = this.ufoTrailLine.geometry;
    const posAttr = geo.getAttribute("position") as Float32BufferAttribute;
    const colAttr = geo.getAttribute("color") as Float32BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const p = this.ufoTrail[i]!;
      this.scratchA.copy(latLonToVector(p.lat, p.lon, EARTH_RADIUS + 0.03));
      pos[i * 3] = this.scratchA.x;
      pos[i * 3 + 1] = this.scratchA.y;
      pos[i * 3 + 2] = this.scratchA.z;
      // Amber (1.0, 0.55, 0.25) scaled so the oldest point is dark and the newest glows.
      const fade = count > 1 ? i / (count - 1) : 1;
      const intensity = 0.12 + 0.88 * fade;
      col[i * 3] = intensity;
      col[i * 3 + 1] = intensity * 0.55;
      col[i * 3 + 2] = intensity * 0.25;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.setDrawRange(0, count);
    this.ufoTrailLine.visible = count >= 2;
  }

  /**
   * Small craft silhouette for an active flight: cyan dart for interceptors,
   * slate transport for the Skyranger (deployment runs render through this pool).
   * Distinct from the engagement-only interceptorMarker used during interception.
   */
  private buildFlightMarker(kind: "interceptor" | "transport"): Group {
    const group = new Group();
    const body =
      kind === "interceptor"
        ? new MeshStandardMaterial({
            color: 0x22d3ee,
            emissive: new Color(0x06b6d4),
            emissiveIntensity: 1.2,
            roughness: 0.3,
            metalness: 0.45,
          })
        : new MeshStandardMaterial({
            color: 0xe2e8f0,
            emissive: new Color(0x94a3b8),
            emissiveIntensity: 0.7,
            roughness: 0.4,
            metalness: 0.5,
          });
    const fuselage = new Mesh(new CylinderGeometry(0.009, 0.015, 0.12, 8), body);
    const nose = new Mesh(new ConeGeometry(0.009, 0.032, 8), body);
    nose.position.y = 0.076;
    const wingGeo = new BoxGeometry(0.05, 0.026, 0.005);
    const wingR = new Mesh(wingGeo, body);
    wingR.position.set(0.032, -0.01, 0);
    wingR.rotation.z = -0.4;
    const wingL = new Mesh(wingGeo, body);
    wingL.position.set(-0.032, -0.01, 0);
    wingL.rotation.z = 0.4;
    const tail = new Mesh(new BoxGeometry(0.005, 0.024, 0.016), body);
    tail.position.set(0, -0.044, 0.009);
    const ringColor = kind === "interceptor" ? 0x67e8f9 : 0xbbf7d0;
    const ring = new Mesh(
      new RingGeometry(0.055, 0.078, 18),
      new MeshBasicMaterial({
        color: ringColor,
        transparent: true,
        opacity: 0.45,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    group.add(fuselage, nose, wingR, wingL, tail, ring);
    return group;
  }

  /** Pre-allocated contrail line for one active flight; buffers rewritten per refresh. */
  private makeFlightTrailLine(): Line {
    const positions = new Float32Array(FLIGHT_TRAIL_MAX * 3);
    const colors = new Float32Array(FLIGHT_TRAIL_MAX * 3);
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geometry.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geometry.setDrawRange(0, 0);
    const line = new Line(
      geometry,
      new LineBasicMaterial({
        color: 0xffffff,
        vertexColors: true,
        transparent: true,
        opacity: 0.6,
        blending: AdditiveBlending,
      }),
    );
    line.frustumCulled = false;
    return line;
  }

  /**
   * Position + orient every active-flight marker from campaign.activeFlights,
   * interpolating each flight's great-circle path by its `progress` so markers
   * visibly fly across the globe as time flows. Markers + trails are pooled by
   * flight id and built/disposed only on lifecycle changes (never per frame).
   */
  private refreshFlightMarkers(): void {
    const c = this.campaign;
    const flights = c?.activeFlights ?? [];
    const live = new Set<string>();
    for (const flight of flights) {
      live.add(flight.id);
      let entry = this.flightMarkers.get(flight.id);
      if (!entry) {
        const marker = this.buildFlightMarker(flight.kind);
        const trail = this.makeFlightTrailLine();
        marker.visible = false;
        trail.visible = false;
        this.earthGroup.add(marker, trail);
        entry = { marker, trail, points: [] };
        this.flightMarkers.set(flight.id, entry);
      }
      const fromN = latLonToVector(flight.fromLat, flight.fromLon, 1).normalize();
      const toN = latLonToVector(flight.toLat, flight.toLon, 1).normalize();
      const progress = Math.max(0, Math.min(1, flight.progress));
      slerpUnit(fromN, toN, progress, this.scratchA); // unit direction at the craft
      const cur = vectorToLatLon(this.scratchA); // {lat,lon} (clones internally)
      this.scratchB.copy(this.scratchA); // posUnit (surface normal at the craft)
      this.scratchA.multiplyScalar(EARTH_RADIUS + 0.14); // offset position
      entry.marker.position.copy(this.scratchA);
      this.orientMarker(entry.marker, this.scratchB, toN);
      entry.marker.visible = true;
      // Sample the contrail while in transit; freeze at the endpoints.
      if (progress > 0 && progress < 1) {
        const last = entry.points[entry.points.length - 1];
        if (!last || Math.hypot(cur.lat - last.lat, cur.lon - last.lon) >= FLIGHT_TRAIL_MIN_DEG) {
          entry.points.push({ lat: cur.lat, lon: cur.lon });
          if (entry.points.length > FLIGHT_TRAIL_MAX) entry.points.shift();
        }
      }
      this.refillFlightTrail(entry.trail, entry.points, flight.kind);
    }
    // Drop markers + trails for flights no longer active.
    for (const [id, entry] of this.flightMarkers) {
      if (live.has(id)) continue;
      this.earthGroup.remove(entry.marker, entry.trail);
      disposeObject(entry.marker);
      entry.trail.geometry.dispose();
      (entry.trail.material as LineBasicMaterial).dispose();
      this.flightMarkers.delete(id);
    }
  }

  /**
   * FRAME-SMOOTH FLIGHTS. refresh() only repositions markers on a SPEED_TICKS clock
   * tick (up to 700ms apart, ~20 game-minutes at 30×). At real craft speeds one tick
   * is an 8-18° teleport, so between ticks each marker sat frozen then jumped — the
   * "jumping places" the player saw. This runs EVERY frame and advances each marker
   * along its own great-circle by the sub-tick fraction of game-hours already elapsed
   * (displayHours − the tick's whole-hour base), the SAME fractional-time trick that
   * smooths the clock/terminator. It is presentation-only: campaign state is never
   * written; the next tick's refresh() snaps the marker to the authoritative position
   * (which this exactly predicted, so the motion is continuous). Guarded by
   * isTimeFlowing(), so a paused globe or an active interception stays put.
   */
  private smoothMarkers(): void {
    const c = this.campaign;
    if (!c || !this.isTimeFlowing()) return;
    const extraHours = this.displayHours() - c.clock.elapsedHours;
    if (extraHours <= 0) return;
    // Transports in transit + interceptor patrols: nudge each along its route arc.
    for (const flight of c.activeFlights ?? []) {
      const entry = this.flightMarkers.get(flight.id);
      if (!entry || !entry.marker.visible) continue;
      // An arrived/loitering deployment (progress clamped to 1) holds station.
      if (flight.progress >= 1) continue;
      const fromN = latLonToVector(flight.fromLat, flight.fromLon, 1).normalize();
      const toN = latLonToVector(flight.toLat, flight.toLon, 1).normalize();
      const arcDeg = fromN.angleTo(toN) * (180 / Math.PI);
      if (arcDeg < 1e-6) continue;
      const disp = Math.min(1, flight.progress + (flight.speedDegPerHour * extraHours) / arcDeg);
      slerpUnit(fromN, toN, disp, this.scratchA); // unit direction at the craft
      this.scratchB.copy(this.scratchA); // posUnit (surface normal)
      this.scratchA.multiplyScalar(EARTH_RADIUS + 0.14);
      entry.marker.position.copy(this.scratchA);
      this.orientMarker(entry.marker, this.scratchB, toN);
    }
    // The tracked UFO flies too — drift its marker along heading × profile speed. Only
    // a tracked (airborne) contact with a heading moves; crashed/landed hold position,
    // and the interactive-engagement pursuit drift (applyPursuitDrift) owns it otherwise.
    const contact = c.ufoContact;
    if (
      contact &&
      contact.status === "tracked" &&
      contact.heading !== undefined &&
      this.ufoMarker.visible
    ) {
      const dest = greatCircleDestination(
        contact.lat,
        contact.lon,
        contact.heading,
        contactSpeedDegPerHour(contact) * extraHours,
      );
      const normal = latLonToVector(dest.lat, dest.lon, 1).normalize();
      this.ufoMarker.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.13);
      this.ufoMarker.quaternion.setFromUnitVectors(UP, normal);
    }
  }

  /** Rewrite a flight trail's buffers with a tail→head fade (cyan interceptor / green transport). */
  private refillFlightTrail(
    trail: Line,
    points: { lat: number; lon: number }[],
    kind: "interceptor" | "transport",
  ): void {
    const count = points.length;
    const geo = trail.geometry;
    const posAttr = geo.getAttribute("position") as Float32BufferAttribute;
    const colAttr = geo.getAttribute("color") as Float32BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    for (let i = 0; i < count; i++) {
      const p = points[i]!;
      this.scratchA.copy(latLonToVector(p.lat, p.lon, EARTH_RADIUS + 0.03));
      pos[i * 3] = this.scratchA.x;
      pos[i * 3 + 1] = this.scratchA.y;
      pos[i * 3 + 2] = this.scratchA.z;
      const fade = count > 1 ? i / (count - 1) : 1;
      const intensity = 0.12 + 0.88 * fade;
      if (kind === "interceptor") {
        col[i * 3] = intensity * 0.4;
        col[i * 3 + 1] = intensity * 0.92;
        col[i * 3 + 2] = intensity;
      } else {
        col[i * 3] = intensity * 0.73;
        col[i * 3 + 1] = intensity;
        col[i * 3 + 2] = intensity * 0.6;
      }
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    geo.setDrawRange(0, count);
    trail.visible = count >= 2;
  }

  private refreshUfoMarkerType(
    missionType: MissionType | undefined,
    ufoType: UfoType | undefined,
    crashed: boolean,
  ): void {
    if (
      this.ufoMissionType === missionType &&
      this.ufoType === ufoType &&
      this.ufoCrashed === crashed
    ) {
      return;
    }
    this.ufoMissionType = missionType;
    this.ufoType = ufoType;
    this.ufoCrashed = crashed;
    for (const child of [...this.ufoMarker.children]) {
      this.ufoMarker.remove(child);
      if (child instanceof Mesh || child instanceof Line) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) for (const one of material) one.dispose();
        else material.dispose();
      }
    }
    // Drop now-detached pulse rings (their geometry/material were just disposed)
    // so the animated set doesn't accumulate stale entries across rebuilds.
    for (let i = this.beaconPulseRings.length - 1; i >= 0; i--) {
      if (this.beaconPulseRings[i]!.parent === null) this.beaconPulseRings.splice(i, 1);
    }
    this.buildUfoMarker(missionType, ufoType, crashed);
  }

  /**
   * Show/hide the interceptor craft + trajectory and recompute the route every
   * refresh. The UFO flies while tracked/engaging, so its lat/lon (and thus the
   * engagement tangent + base->UFO arc) move tick by tick — re-reading the
   * contact each refresh is what makes the interceptor visibly chase it. A fresh
   * engagement still kicks off the launch flight via interceptorFlightStartMs.
   */
  /**
   * The engaging craft's cruise speed and the contact's own speed (deg/hour). The
   * craft is the engaging interceptor (chooseInterceptor); the UFO speed comes from
   * contactSpeedDegPerHour — the SAME function the campaign layer's classification
   * uses — so the printed "Yours X vs UFO Y" numbers can never disagree with the
   * advantage/outrun label derived from them. Falls back to the starting-interceptor
   * cruise when no craft is available so a preview always has real numbers.
   */
  private engagementSpeeds(contact: UfoContact): { craft: number; ufo: number } {
    const c = this.campaign;
    const craft = c ? chooseInterceptor(c) : undefined;
    const craftSpeed = craft ? craftSpeedDegPerHour(craft) : DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR;
    return { craft: craftSpeed, ufo: contactSpeedDegPerHour(contact) };
  }

  /**
   * craft/UFO speed ratio driving the pursuit presentation pace, clamped to a sane
   * band. >1 = the pursuer is faster (advantage, quick closure); <1 = the UFO
   * outruns it (slow closure, range opens). 1 when there is no contact.
   */
  private engagementSpeedRatio(): number {
    const contact = this.campaign?.ufoContact;
    if (!contact) return 1;
    const { craft, ufo } = this.engagementSpeeds(contact);
    const ratio = craft / ufo;
    if (!Number.isFinite(ratio) || ratio <= 0) return 1;
    return Math.max(PURSUIT_RATIO_MIN, Math.min(PURSUIT_RATIO_MAX, ratio));
  }

  /** True when the current contact outruns the engaging craft (mirrors the campaign layer). */
  private engagementOutrun(): boolean {
    const c = this.campaign;
    const contact = c?.ufoContact;
    if (!c || !contact) return false;
    return interceptionSpeedAdvantage(c, contact) === "outrun";
  }

  private refreshInterceptor(): void {
    const c = this.campaign;
    const engaging = this.isEngaging();
    // A fresh engagement kicks off the launch flight (reset its clock); the frame
    // loop then flies the craft from base toward the UFO before range closing begins.
    const fresh = engaging && !this.wasEngaging;
    if (fresh) {
      this.interceptorFlightStartMs = performance.now();
      this.resetContrails();
      this.zoomedContactId = null;
      this.pursuitStartRangeKm = Math.max(1, c?.interception?.rangeKm ?? ENGAGEMENT_RANGE_KM);
      this.displayRange = this.pursuitStartRangeKm;
      this.opts.onInterceptorSfx?.("launch");
    }
    this.wasEngaging = engaging;
    if (!engaging || !c?.ufoContact || !c.base) {
      this.interceptorMarker.visible = false;
      this.trajectoryLine.visible = false;
      this.interceptorRoute = null;
      return;
    }
    const contact = c.ufoContact;
    const baseN = latLonToVector(c.base.lat, c.base.lon, 1).normalize();
    const ufoN = latLonToVector(contact.lat, contact.lon, 1).normalize();
    // Preserve the drifted route target across in-engagement refreshes so the UFO's
    // presentation pursuit motion isn't snapped back by a mid-flight re-render.
    if (this.interceptorRoute && this.interceptorRoute.contactId === contact.id && !fresh) {
      this.interceptorRoute.baseN.copy(baseN);
    } else {
      this.interceptorRoute = { baseN, ufoN: ufoN.clone(), contactId: contact.id };
    }
    if (fresh) {
      // Derive the fly-out duration from the true great-circle distance, and seed the
      // presentation-drift pivot: rotate ufoN0 about pursuitAxis to sweep it along
      // the contact's heading so the interceptor curves after a moving target.
      const angle = baseN.angleTo(ufoN);
      // Pace the fly-out by the REAL speed ratio: divide the distance-derived time by
      // craft/UFO speed so a faster pursuer closes visibly quicker and a UFO that
      // outruns it (ratio < 1) stretches the closure. The higher outrun ceiling
      // (FLYOUT_SPEED_MAX_MS) lets that slow-closure read past the distance-only max.
      const ratio = this.engagementSpeedRatio();
      // Not-outrun engagements keep the distance-only ceiling; an outrun UFO
      // (ratio < 1) is allowed the higher ceiling so its slow closure fully reads.
      const ceiling = ratio < 1 ? FLYOUT_SPEED_MAX_MS : FLYOUT_MAX_MS;
      this.interceptorFlightDurationMs = Math.min(
        ceiling,
        Math.max(FLYOUT_MIN_MS, (angle * FLYOUT_MS_PER_RAD) / ratio),
      );
      this.ufoN0.copy(ufoN);
      this.computePursuitAxis(contact, ufoN);
    }
    this.fillTrajectory(this.interceptorRoute.baseN, this.interceptorRoute.ufoN);
    this.interceptorMarker.visible = true;
    this.trajectoryLine.visible = true;
  }

  /**
   * Axis about which the UFO's presentation drift rotates: perpendicular to ufoN
   * and aligned with the contact's compass heading (north/east tangent basis), so
   * the drifted point sweeps the direction the UFO is actually flying.
   */
  private computePursuitAxis(contact: UfoContact, ufoN: Vector3): void {
    const headingRad = ((contact.heading ?? 0) * Math.PI) / 180;
    // Local east/north tangents at the UFO's position.
    const north = this.scratchA.set(0, 1, 0).addScaledVector(ufoN, -ufoN.y).normalize();
    const east = this.scratchB.copy(north).cross(ufoN).normalize();
    // Travel tangent = sin(heading)*east + cos(heading)*north (compass bearing).
    const tangent = this.scratchC
      .copy(east)
      .multiplyScalar(Math.sin(headingRad))
      .addScaledVector(north, Math.cos(headingRad));
    if (tangent.lengthSq() < 1e-8) tangent.set(1, 0, 0);
    // Rotating ufoN about (ufoN × tangent) moves it along the tangent (heading).
    this.pursuitAxis.copy(ufoN).cross(tangent).normalize();
    if (this.pursuitAxis.lengthSq() < 1e-8) this.pursuitAxis.set(1, 0, 0);
  }

  private fillTrajectory(baseN: Vector3, ufoN: Vector3): void {
    const attr = this.trajectoryLine.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i <= TRAJECTORY_SEGMENTS; i++) {
      const t = i / TRAJECTORY_SEGMENTS;
      slerpUnit(baseN, ufoN, t, this.scratchA);
      this.scratchA.multiplyScalar(EARTH_RADIUS + 0.02);
      arr[i * 3] = this.scratchA.x;
      arr[i * 3 + 1] = this.scratchA.y;
      arr[i * 3 + 2] = this.scratchA.z;
    }
    attr.needsUpdate = true;
  }

  /** True when game time is advancing on the render-side tick cadence. */
  private isTimeFlowing(): boolean {
    const speed = this.timeSpeed;
    if (
      speed <= 0 ||
      !this.campaign ||
      this.campaign.strategic.status !== "active" ||
      this.isEngaging()
    ) {
      return false;
    }
    return SPEED_TICKS[speed] !== undefined;
  }

  /**
   * Fractional campaign hours for render-side animation: discrete clock ticks plus
   * the in-progress fraction of the current SPEED_TICKS interval.
   */
  private displayHours(): number {
    const c = this.campaign;
    if (!c) return 12;
    const base = c.clock.elapsedHours;
    if (!this.isTimeFlowing()) return base;
    const tick = SPEED_TICKS[this.timeSpeed]!;
    const frac = Math.min(1, Math.max(0, this.timeAccumulatorMs / tick.ms));
    return base + frac * tick.hours;
  }

  /** Smooth HH:MM clock readout (updated each frame while time flows). */
  private updateClockReadout(): void {
    if (!this.clockStatValue || !this.campaign) return;
    const hourOfDay = this.displayHours() % 24;
    const hour = Math.floor(hourOfDay);
    const minutes = Math.floor((hourOfDay - hour) * 60);
    this.clockStatValue.textContent = `Day ${this.campaign.clock.day} ${String(hour).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
  }

  /**
   * Advance the directional sun around the globe's polar axis from the campaign
   * clock, so one hemisphere is lit (day) and the opposite is dark (night). The
   * terminator sweeps as the clock advances. Phase is offset so campaign noon
   * (hour 12) lights the camera-facing side; the pre-campaign base screen sits
   * at full day for readability.
   */
  private updateTerminator(): void {
    const hour = this.displayHours() % 24;
    const azimuth = ((hour - 12) / 24) * Math.PI * 2 + Math.PI / 2;
    const radius = 6;
    this.sunLight.position.set(
      Math.cos(azimuth) * radius,
      radius * 0.32,
      Math.sin(azimuth) * radius,
    );
  }

  /** Drive the interceptor along base->UFO: launch flight, then range-driven closing; pulse + orient it. */
  private animateInterceptor(now: number): void {
    const route = this.interceptorRoute;
    const encounter = this.campaign?.interception;
    if (!this.interceptorMarker.visible || !route || !encounter) return;
    // Launch flight (base -> engagement range) over a distance-derived duration
    // (4-8s), eased so the player watches the craft fly the whole great-circle out
    // to the UFO; then hand off to the (smoothly eased) range-driven closing slice.
    const dur = this.interceptorFlightDurationMs || FLYOUT_MIN_MS;
    const flightT = Math.min(1, Math.max(0, (now - this.interceptorFlightStartMs) / dur));
    const closedFraction = Math.max(0, Math.min(1, 1 - this.displayRange / this.pursuitStartRangeKm));
    const rangeArc = INTERCEPTOR_FLIGHT_END + closedFraction * (1 - INTERCEPTOR_FLIGHT_END);
    const progress = flightT < 1 ? easeInOutCubic(flightT) * INTERCEPTOR_FLIGHT_END : Math.min(1, rangeArc);
    slerpUnit(route.baseN, route.ufoN, progress, this.scratchA); // unit direction at the craft
    this.scratchA.normalize().multiplyScalar(EARTH_RADIUS + 0.14);
    this.interceptorMarker.position.copy(this.scratchA);
    // Orient the dart's tip (+Y) along the travel tangent toward the UFO.
    const posN = this.scratchB.copy(this.scratchA).normalize(); // surface normal at the craft
    const tangent = this.scratchC
      .copy(route.ufoN)
      .addScaledVector(posN, -posN.dot(route.ufoN)); // great-circle tangent toward UFO
    if (tangent.lengthSq() > 1e-8) tangent.normalize();
    this.scratchBasis.makeBasis(
      this.scratchA.copy(tangent).cross(posN), // x = tangent × normal
      tangent, // y = forward (cone tip direction)
      posN, // z = up
    );
    this.interceptorMarker.quaternion.setFromRotationMatrix(this.scratchBasis);
    this.interceptorMarker.scale.setScalar(1 + (this.reducedMotion ? 0 : Math.sin(now * 0.012) * 0.18));
  }

  /**
   * Presentation pursuit: the tracked UFO keeps flying while the interceptor closes,
   * so the chase reads as a curve, not a teleport. The drift is purely visual — it
   * rotates the ROUTE target (and repositions the UFO marker) about the heading axis
   * and is NEVER written back to campaign state. Stops once the interceptor has
   * arrived or THE ZOOM has fired; skipped on reducedMotion.
   */
  private applyPursuitDrift(now: number): void {
    if (this.reducedMotion) return;
    const route = this.interceptorRoute;
    if (!route || !this.isPursuing()) return;
    const dur = this.interceptorFlightDurationMs || FLYOUT_MIN_MS;
    const flightT = (now - this.interceptorFlightStartMs) / dur;
    if (flightT >= 1) return; // stop drifting once the interceptor has closed
    const elapsedSec = (now - this.interceptorFlightStartMs) / 1000;
    // Scale the UFO's own drift by 1/ratio: a faster target (ratio < 1) pulls further
    // ahead during the fly-out, a slower one barely moves. Keeps the chase honest to
    // the real speed matchup rather than a fixed globe rate.
    const driftScale = Math.max(
      PURSUIT_DRIFT_SCALE_MIN,
      Math.min(PURSUIT_DRIFT_SCALE_MAX, 1 / this.engagementSpeedRatio()),
    );
    const driftAngle = Math.min(
      PURSUIT_MAX_DRIFT_RAD * driftScale,
      elapsedSec * PURSUIT_DRIFT_RAD_PER_SEC * driftScale,
    );
    this.scratchA.copy(this.ufoN0).applyAxisAngle(this.pursuitAxis, driftAngle).normalize();
    route.ufoN.copy(this.scratchA);
    // Reposition + reorient the UFO marker at the drifted point (marker radius).
    this.ufoMarker.position.copy(this.scratchA).multiplyScalar(EARTH_RADIUS + 0.13);
    this.ufoMarker.quaternion.setFromUnitVectors(UP, this.scratchA);
    this.fillTrajectory(route.baseN, route.ufoN); // the pursuit line curves with the target
  }

  /**
   * Gently ease the OrbitControls target from the globe centre toward the
   * interceptor while engaging, so the camera tracks the fly-out; ease it back to
   * the centre otherwise. Subtle (CHASE_TARGET_WEIGHT) so the globe stays readable;
   * static under reducedMotion.
   */
  private updateChaseCamera(): void {
    if (this.reducedMotion) return;
    if (this.isEngaging() && this.interceptorMarker.visible) {
      this.interceptorMarker.getWorldPosition(this.scratchA);
      this.chaseTarget.copy(this.scratchA).multiplyScalar(CHASE_TARGET_WEIGHT);
    } else {
      this.chaseTarget.set(0, 0, 0);
    }
    this.controls.target.lerp(this.chaseTarget, CHASE_EASE);
  }

  /** Ease the displayed range (km) toward the encounter's real gap so marker motion
   *  is smooth rather than snapped, every frame the pursuit is live. */
  private easePursuitRange(): void {
    const enc = this.campaign?.interception;
    if (!enc) return;
    this.displayRange += (enc.rangeKm - this.displayRange) * RANGE_EASE;
  }

  /**
   * Build the on-globe PURSUIT HUD panel (bottom-centre, non-blocking so the chase
   * over the globe stays fully visible). Real km range + closing speed, plus the
   * two pursuit verbs — keepChasing / disengage. No attack here: weapons only fire
   * once THE ZOOM hands the encounter to the cinematic dogfight (planeCombatView).
   */
  private buildInterceptionOverlay(): HTMLElement {
    const contact = this.campaign?.ufoContact;
    const panel = el("div", "geo-intercept");
    const head = el("div", "geo-intercept-head");
    const title = el("div", "geo-intercept-title");
    title.textContent = `Pursuit — ${ufoTypeInfo(contact?.ufoType).label}`;
    const range = el("span", "geo-intercept-range");
    this.interceptRangeLabel = range;
    head.append(title, range);

    const sub = el("div", "geo-intercept-sub");
    this.interceptSubLine = sub;

    const log = el("div", "geo-intercept-log");
    this.interceptLogLine = log;

    const actions = el("div", "geo-intercept-actions");
    const keepChasing = el("button", "ui-btn ui-btn--danger");
    keepChasing.type = "button";
    keepChasing.textContent = "Keep Chasing";
    keepChasing.title = `Press the pursuit — closes the gap toward the ${groupThousands(ENGAGEMENT_RANGE_KM)}km engagement range (or lets it open if the UFO outruns you).`;
    const disengage = el("button", "ui-btn");
    disengage.type = "button";
    disengage.textContent = "Disengage";
    disengage.title = "Break off the chase and send the interceptor home, leaving the UFO tracked.";
    keepChasing.addEventListener("click", () => this.onPursuitAction("keepChasing"));
    disengage.addEventListener("click", () => this.onPursuitAction("disengage"));
    actions.append(keepChasing, disengage);
    this.interceptButtons = [keepChasing, disengage];

    panel.append(head, sub, log, actions);
    this.interceptOverlayEl = panel;
    this.syncInterceptionOverlay();
    return panel;
  }

  /** Push the current (already-applied) encounter numbers into the pursuit HUD DOM. */
  private syncInterceptionOverlay(): void {
    const enc = this.campaign?.interception;
    if (!enc || !this.interceptOverlayEl) return;
    if (this.interceptRangeLabel) {
      this.interceptRangeLabel.textContent = `${groupThousands(Math.max(0, Math.round(enc.rangeKm)))} km`;
    }
    if (this.interceptSubLine) {
      const outrunning = enc.closingSpeedKmH <= 0;
      this.interceptSubLine.textContent = outrunning
        ? `${ufoTypeInfo(this.campaign?.ufoContact?.ufoType).label} is outrunning you — range opening. Contact lost past ${groupThousands(STERN_ESCAPE_KM)} km.`
        : `Closing at ${groupThousands(Math.round(enc.closingSpeedKmH))} km/h — THE ZOOM triggers at ${groupThousands(ENGAGEMENT_RANGE_KM)} km.`;
      this.interceptSubLine.classList.toggle("warn", outrunning);
    }
    if (this.interceptLogLine) this.interceptLogLine.textContent = enc.log[enc.log.length - 1] ?? "";
    this.setInterceptButtonsDisabled(false);
  }

  private setInterceptButtonsDisabled(disabled: boolean): void {
    for (const btn of this.interceptButtons) btn.disabled = disabled;
  }

  /**
   * A pursuit verb (keepChasing / disengage): applied immediately — no beat/reveal
   * delay, since the thrill (lock-on tension, missile travel, hit/miss reveals)
   * lives in the cinematic dogfight past THE ZOOM, not on the globe. Buttons are
   * disabled until the next refresh re-syncs so a rapid double-click can't double-fire.
   */
  private onPursuitAction(action: InterceptionAction): void {
    if (!this.isPursuing()) return;
    this.setInterceptButtonsDisabled(true);
    this.opts.onInterceptionAction?.(action); // main applies + calls update() -> refresh()
  }

  /** Screen-space callout layer above the canvas, pinned to the active UFO marker. */
  private buildContactLabel(): void {
    const label = el("div", "geo-contact-label");
    label.style.display = "none";
    this.canvasWrap.appendChild(label);
    this.contactLabel = label;
  }

  /**
   * Allocate the reusable pursuit-chase FX (thruster contrails) once and parent
   * them to earthGroup (so they share the globe's frame as the markers). Disposed
   * via disposeObject(scene).
   */
  private buildChaseFx(): void {
    this.interceptorContrail = this.makeContrail(0x67e8f9);
    this.ufoContrail = this.makeContrail(0xfb7185);
    this.earthGroup.add(this.interceptorContrail, this.ufoContrail);
  }

  /**
   * Additive thruster contrail: a ring buffer of recent craft positions (local
   * space) with per-vertex color faded bright (head) → dark (tail) so it reads as
   * a glowing exhaust trail. No per-frame allocation — position + color buffers
   * are rewritten in place by updateContrail each frame.
   */
  private makeContrail(color: number): Points {
    const positions = new Float32Array(CONTRAIL_MAX * 3);
    const colors = new Float32Array(CONTRAIL_MAX * 3);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    geo.setAttribute("color", new Float32BufferAttribute(colors, 3));
    geo.setDrawRange(0, 0);
    const points = new Points(
      geo,
      new PointsMaterial({
        color,
        size: 0.028,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
        vertexColors: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    points.frustumCulled = false;
    points.visible = false;
    return points;
  }

  /** Flowing time: advance game hours on a timer scaled by the chosen speed. */
  private advanceFlowingTime(now: number): void {
    const speed = this.timeSpeed;
    if (
      speed <= 0 ||
      !this.campaign ||
      this.campaign.strategic.status !== "active" ||
      this.isEngaging()
    ) {
      this.lastFlowMs = 0;
      this.timeAccumulatorMs = 0;
      return;
    }
    const tick = SPEED_TICKS[speed];
    if (!tick) return;
    if (this.lastFlowMs === 0) this.lastFlowMs = now;
    this.timeAccumulatorMs += now - this.lastFlowMs;
    this.lastFlowMs = now;
    if (this.timeAccumulatorMs >= tick.ms) {
      this.timeAccumulatorMs %= tick.ms;
      this.opts.onAdvanceTime(tick.hours);
    }
  }

  /**
   * Stream thruster contrails behind the interceptor + UFO while the pursuit is
   * live. Each frame one particle is emitted at each craft's world position
   * (converted into earthGroup-local space); per-vertex color fades the ring
   * bright (head) → dark (tail) so it reads as a glowing exhaust trail. Ring
   * buffers are pooled — no per-frame allocation. Reduced-motion-gated decoration:
   * hidden outright for prefers-reduced-motion, and outside the chase.
   */
  private updateContrails(): void {
    if (this.reducedMotion || !this.isEngaging()) {
      this.interceptorContrail.visible = false;
      this.ufoContrail.visible = false;
      return;
    }
    if (this.interceptorMarker.visible) {
      this.interceptorMarker.getWorldPosition(this.scratchA);
      this.emitContrail(this.interceptorContrail, this.interceptorContrailRing, this.interceptorContrailState, this.scratchA, 0.4, 0.92, 1.0);
    }
    if (this.ufoMarker.visible) {
      this.ufoMarker.getWorldPosition(this.scratchA);
      this.emitContrail(this.ufoContrail, this.ufoContrailRing, this.ufoContrailState, this.scratchA, 1.0, 0.45, 0.52);
    }
  }

  private emitContrail(
    contrail: Points,
    ring: Float32Array,
    state: { head: number; count: number },
    worldPos: Vector3,
    r: number,
    g: number,
    b: number,
  ): void {
    this.scratchB.copy(worldPos);
    this.earthGroup.worldToLocal(this.scratchB); // earthGroup-local position of the craft
    ring[state.head * 3] = this.scratchB.x;
    ring[state.head * 3 + 1] = this.scratchB.y;
    ring[state.head * 3 + 2] = this.scratchB.z;
    state.head = (state.head + 1) % CONTRAIL_MAX;
    if (state.count < CONTRAIL_MAX) state.count++;
    const posAttr = contrail.geometry.getAttribute("position") as Float32BufferAttribute;
    const colAttr = contrail.geometry.getAttribute("color") as Float32BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    for (let i = 0; i < state.count; i++) {
      // Walk the ring oldest → newest so fade tracks age correctly.
      const slot = (state.head - state.count + i + CONTRAIL_MAX) % CONTRAIL_MAX;
      pos[i * 3] = ring[slot * 3] ?? 0;
      pos[i * 3 + 1] = ring[slot * 3 + 1] ?? 0;
      pos[i * 3 + 2] = ring[slot * 3 + 2] ?? 0;
      const fade = state.count > 1 ? i / (state.count - 1) : 1; // 0 oldest .. 1 newest
      const intensity = fade * fade * 0.95;
      col[i * 3] = r * intensity;
      col[i * 3 + 1] = g * intensity;
      col[i * 3 + 2] = b * intensity;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    contrail.geometry.setDrawRange(0, state.count);
    contrail.visible = state.count >= 2;
  }

  /** Clear the contrail ring buffers (on engagement start so stale trails don't linger). */
  private resetContrails(): void {
    this.interceptorContrailState.head = 0;
    this.interceptorContrailState.count = 0;
    this.ufoContrailState.head = 0;
    this.ufoContrailState.count = 0;
    this.interceptorContrail.geometry.setDrawRange(0, 0);
    this.ufoContrail.geometry.setDrawRange(0, 0);
    this.interceptorContrail.visible = false;
    this.ufoContrail.visible = false;
  }

  /**
   * Pin the contact callout to the active UFO marker so the player sees where to
   * act. Projects the marker to screen space each frame; the label text is cached
   * so the DOM text node is only rewritten when the contact actually changes.
   */
  private updateContactLabel(contact: UfoContact | null | undefined): void {
    const label = this.contactLabel;
    if (!label) return;
    const active =
      !!contact &&
      this.ufoMarker.visible &&
      (contact.status === "tracked" || contact.status === "crashed" || contact.status === "landed");
    if (!active) {
      if (label.style.display !== "none") label.style.display = "none";
      return;
    }
    this.ufoMarker.getWorldPosition(this.scratchProject);
    this.scratchProject.project(this.camera);
    const rect = this.canvasWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Marker behind the camera (projected z escapes NDC) -> hide.
    if (this.scratchProject.z > 1) {
      if (label.style.display !== "none") label.style.display = "none";
      return;
    }
    const text = `${missionTypeInfo(contact?.missionType).icon} ${ufoTypeInfo(contact?.ufoType).label}`;
    if (text !== this.contactLabelText) {
      this.contactLabelText = text;
      label.textContent = text;
    }
    label.style.left = `${(this.scratchProject.x * 0.5 + 0.5) * rect.width}px`;
    label.style.top = `${(-this.scratchProject.y * 0.5 + 0.5) * rect.height}px`;
    if (label.style.display === "none") label.style.display = "";
  }

  /**
   * Orient a craft marker so its +Y (nose) points along the great-circle tangent
   * from its current surface position toward `towardUnit`, with +Z as the surface
   * normal. Shares the interceptor's orientation math; reused by the Skyranger.
   */
  private orientMarker(marker: Group, posUnit: Vector3, towardUnit: Vector3): void {
    const posN = this.scratchB.copy(posUnit);
    const tangent = this.scratchC.copy(towardUnit).addScaledVector(posN, -posN.dot(towardUnit));
    if (tangent.lengthSq() > 1e-8) tangent.normalize();
    this.scratchBasis.makeBasis(this.scratchA.copy(tangent).cross(posN), tangent, posN);
    marker.quaternion.setFromRotationMatrix(this.scratchBasis);
  }

  /** Allocate the planned base->site route line for the active deployment flight once. */
  private buildDeploymentFx(): void {
    const positions = new Float32Array((DEPLOYMENT_SEGMENTS + 1) * 3);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    this.deploymentLine = new Line(
      geo,
      new LineBasicMaterial({ color: 0xbbf7d0, transparent: true, opacity: 0.5 }),
    );
    this.deploymentLine.visible = false;
    this.earthGroup.add(this.deploymentLine);
  }

  private fillDeploymentTrajectory(baseN: Vector3, siteN: Vector3): void {
    const attr = this.deploymentLine.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    for (let i = 0; i <= DEPLOYMENT_SEGMENTS; i++) {
      const t = i / DEPLOYMENT_SEGMENTS;
      slerpUnit(baseN, siteN, t, this.scratchA);
      this.scratchA.multiplyScalar(EARTH_RADIUS + 0.02);
      arr[i * 3] = this.scratchA.x;
      arr[i * 3 + 1] = this.scratchA.y;
      arr[i * 3 + 2] = this.scratchA.z;
    }
    attr.needsUpdate = true;
  }

  /**
   * Draw the planned base->site route line for an active non-blocking deployment
   * flight (the Skyranger itself flies via the pooled flight markers). Hidden when
   * no deployment is in transit. Called from refreshMarkers each state refresh.
   */
  private refreshDeploymentRoute(): void {
    const flight = (this.campaign?.activeFlights ?? []).find((f) => f.purpose === "deployment");
    if (!flight) {
      this.deploymentLine.visible = false;
      return;
    }
    const baseN = latLonToVector(flight.fromLat, flight.fromLon, 1).normalize();
    const siteN = latLonToVector(flight.toLat, flight.toLon, 1).normalize();
    this.fillDeploymentTrajectory(baseN, siteN);
    this.deploymentLine.visible = true;
  }

  /**
   * Per-frame throb on a deployment flight's pooled marker: an on-station Skyranger
   * (arrived) hovers with a gentle pulse so it reads as awaiting the DEPLOY order.
   * reducedMotion holds it steady. In-transit markers keep their default scale.
   */
  private animateDeploymentMarkers(now: number): void {
    const flights = this.campaign?.activeFlights ?? [];
    for (const flight of flights) {
      if (flight.purpose !== "deployment") continue;
      const entry = this.flightMarkers.get(flight.id);
      if (!entry) continue;
      const arrived = flight.arrived === true || flight.progress >= 1;
      const pulse = arrived && !this.reducedMotion ? 1 + Math.sin(now * 0.008) * 0.14 : 1;
      entry.marker.scale.setScalar(pulse);
    }
  }

  /**
   * Build the persistent "Launch Operation" CTA once. Its click listener lives for
   * the node's whole lifetime and no-ops while disabled, so the node can be reused
   * across every contact-modal rebuild without stacking listeners or dropping clicks.
   */
  private createLaunchCta(): HTMLButtonElement {
    const launch = el("button", "primary ui-cta geo-launch-cta");
    launch.type = "button";
    launch.addEventListener("click", () => {
      if (launch.disabled) return;
      this.opts.onLaunchMission?.();
    });
    return launch;
  }

  /** Concise contact card: id, status instruction, region, time-left. Drops the prose. */
  private contactCard(): HTMLElement {
    const contact = this.campaign?.ufoContact;
    // A UFO downed over the ocean is unrecoverable: it gets a distinct "lost at
    // sea" state (slate card + waves badge) vs the land "Crash site — launch
    // assault". Color is always paired with the "≈ Lost at sea" icon+label.
    const lostAtSea = !!contact && contact.status === "crashed" && !!contact.overOcean;
    const stateClass = !contact ? "idle" : lostAtSea ? "lost" : "";
    const card = el("section", `geo-contact ${stateClass}`.trim());
    if (!contact) {
      const empty = el("div", "geo-empty");
      const icon = el("div", "geo-empty-icon");
      icon.textContent = "◌";
      const title = el("strong");
      title.textContent = "No UFO contact";
      const copy = el("p");
      copy.textContent = "Radar sweeping. Advance time to detect a UFO.";
      empty.append(icon, title, copy);
      card.append(empty);
      return card;
    }
    const info = missionTypeInfo(contact.missionType);
    const remaining = Math.max(0, contact.expiresAtHour - (this.campaign?.clock.elapsedHours ?? 0));
    const title = el("strong");
    title.textContent = `${contact.id} · ${contact.region}`;
    const status = el("p", "geo-contact-status");
    status.textContent = this.contactStatusLabel(contact);
    const meta = el("p", "geo-contact-meta");
    meta.textContent =
      `${fmtCoord(contact.lat, "N", "S")} / ${fmtCoord(contact.lon, "E", "W")} · ${formatHours(remaining)} left`;
    // The badge TEXT is status-derived so an airborne (tracked/engaging) UFO
    // reads "Airborne UFO", never "Crash site" — matching the status line.
    // missionTypeInfo still drives the marker icon/color/urgent styling; a
    // lost-at-sea crash overrides the badge so the card never invites an
    // assault that the campaign layer will refuse.
    const badgeInfo: MissionTypeInfo = lostAtSea
      ? { icon: "≈", label: this.contactBadgeLabel(contact), urgent: false, color: 0x64748b }
      : { ...info, label: this.contactBadgeLabel(contact) };
    const badge = this.missionBadge(badgeInfo);
    if (lostAtSea) badge.classList.add("lost");
    // UFO-variety badge (scout/harvester/terror/battleship), distinct from the
    // mission badge above. The type color tints the border, but the icon + label
    // text always carry the meaning, so the type is never conveyed by color alone.
    const ufoInfo = ufoTypeInfo(contact.ufoType);
    const ufoBadge = el("div", "geo-mission-badge");
    ufoBadge.style.borderColor = new Color(ufoInfo.color).getStyle();
    const ufoIcon = el("span", "geo-mission-icon");
    ufoIcon.textContent = ufoInfo.icon;
    const ufoLabel = el("span");
    ufoLabel.textContent = `${ufoInfo.label} · ${ufoInfo.threat} threat`;
    ufoBadge.append(ufoIcon, ufoLabel);
    card.append(badge, ufoBadge, title, status, meta);
    // Speed matchup chip: for an airborne (tracked) contact, show how the fastest
    // ready craft compares to the UFO. Colour is always paired with a text label
    // (never conveyed by colour alone) and the raw speeds via uiFormat.
    const speedChip = this.speedMatchupChip(contact);
    if (speedChip) card.append(speedChip);
    // Mission launch lives on this card now (moved off the base view): a downed-on-
    // land crash site or a landed UFO is directly launchable. A lost-at-sea crash is
    // unrecoverable, so it never offers the CTA (matches the campaign layer's gate).
    // A won/lost campaign never launches (a lingering grounded contact must not offer
    // an enabled CTA that silently no-ops downstream).
    const c = this.campaign;
    const active = c?.strategic.status === "active";
    const launchable =
      active &&
      ((contact.status === "crashed" && !contact.overOcean) || contact.status === "landed");
    // A Skyranger already inbound / on station owns the launch flow (its DEPLOY chip
    // drives the assault). Re-showing "Launch Operation" here would append a second
    // deployment flight to activeFlights, so suppress it while one is in transit.
    const flightInProgress = (c?.activeFlights ?? []).some((f) => f.purpose === "deployment");
    if (launchable && this.opts.onLaunchMission && !flightInProgress) {
      const squad = c ? deploymentSoldiers(c).length : 0;
      const roster = c ? activeSoldiers(c).length : 0;
      // Pre-launch briefing preview: codename, opposition strength, field-time
      // estimate, mission-specific detail, and reward preview — so the player commits
      // to the operation informed, not blind (this info lived on the deleted base card).
      const briefing = this.contactBriefing();
      if (briefing) card.append(briefing);
      // Reuse ONE persistent CTA node across every modal rebuild (the contact modal
      // body is replaceChildren'd each refresh tick). A fresh <button> each tick drops
      // a click whose mousedown/mouseup straddle a tick; a stable node keeps it.
      const launch = this.launchCta ?? (this.launchCta = this.createLaunchCta());
      if (squad === 0) {
        // No deployable squad: mirror the old base launch button's explanatory
        // disabled states instead of arming a CTA that would fly the Skyranger and
        // then silently no-op in startTactical (e.g. whole squad wounded).
        launch.disabled = true;
        launch.textContent = roster === 0 ? "No operatives" : "Assign a squad";
        launch.title =
          roster === 0
            ? "Recruit operatives at the base before launching an operation."
            : "Assign operatives to the deployment at the base before launching.";
      } else {
        launch.disabled = false;
        launch.textContent = "Launch Operation";
        launch.title = "Deploy the Skyranger and enter the battlescape on arrival.";
      }
      card.append(launch);
    }
    return card;
  }

  /**
   * Pre-launch briefing preview for a launchable contact. generateOperation is
   * deterministic in the contact's mission seed, so this previews exactly the
   * operation startTactical will run: codename, opposition strength, field-time
   * estimate, terror-site civilian count, and the resource reward preview.
   */
  private contactBriefing(): HTMLElement | null {
    const c = this.campaign;
    if (!c) return null;
    const op = generateOperation(c);
    const wrap = el("div", "geo-briefing");
    const eyebrow = el("div", "geo-briefing-eyebrow ui-eyebrow");
    eyebrow.textContent = `Operation ${op.codename}`;
    const line = el("div", "geo-briefing-line");
    line.textContent = `${op.enemyCount} hostiles · ${formatHours(op.durationHours)} est. field time`;
    wrap.append(eyebrow, line);
    const civilians = op.missionContext?.civilianCount;
    if (op.missionType === "terror" && civilians) {
      const detail = el("div", "geo-briefing-detail");
      detail.textContent = `${civilians} civilians in the zone — rescue them`;
      wrap.append(detail);
    }
    const reward = op.reward;
    const chips = el("div", "geo-briefing-chips");
    for (const text of [
      formatSignedCredits(reward.credits),
      `+${reward.alloys}a`,
      `+${reward.elerium}e`,
      `+${reward.alienData} data`,
    ]) {
      const chip = el("span", "geo-briefing-chip");
      chip.textContent = text;
      chips.append(chip);
    }
    wrap.append(chips);
    return wrap;
  }

  /**
   * The teal "SPEED ADVANTAGE" / steel "MATCHED" / amber "OUTRUN — cannot close"
   * chip for a tracked contact, with the engaging craft's cruise vs the UFO's own
   * speed. Null for a downed/landed contact (no chase to preview).
   */
  private speedMatchupChip(contact: UfoContact): HTMLElement | null {
    const c = this.campaign;
    if (!c || contact.status !== "tracked") return null;
    const advantage: InterceptionSpeedAdvantage = interceptionSpeedAdvantage(c, contact);
    const { craft, ufo } = this.engagementSpeeds(contact);
    const chip = el("div", `geo-speed-chip ${advantage}`);
    const label = el("span", "geo-speed-chip-label");
    label.textContent =
      advantage === "advantage"
        ? "SPEED ADVANTAGE"
        : advantage === "matched"
          ? "MATCHED"
          : "OUTRUN — CANNOT CLOSE";
    const detail = el("span", "geo-speed-chip-detail");
    detail.textContent = `Yours ${formatSpeed(degPerHourToKmh(craft))} vs UFO ${formatSpeed(degPerHourToKmh(ufo))}`;
    chip.append(label, detail);
    return chip;
  }

  /**
   * Instructional status label. A tracked (airborne) UFO is NEVER "Crash site" —
   * it reads as airborne with an intercept prompt. Only a crashed contact reads
   * as a crash site (launch assault), unless it came down over the ocean, in
   * which case it is lost and unrecoverable.
   */
  private contactStatusLabel(contact: UfoContact): string {
    switch (contact.status) {
      case "engaging":
        return "Engaging — stand by";
      case "crashed":
        return contact.overOcean ? "Lost at sea — unrecoverable" : "Crash site — launch assault";
      case "landed":
        if (contact.missionType === "terror") return "Terror site — launch assault";
        if (contact.missionType === "baseDefense") return "Base assault — launch defense";
        return "Landed — launch assault";
      case "tracked":
      default:
        return "Airborne — intercept to engage";
    }
  }

  /**
   * Status-aware badge label for the contact card. Mirrors contactStatusLabel so
   * the badge and the status line never contradict each other: an airborne
   * (tracked/engaging) UFO reads "Airborne UFO", "Crash site" appears only once
   * the contact is actually down on land, and an ocean crash reads "Lost at sea".
   */
  private contactBadgeLabel(contact: UfoContact): string {
    switch (contact.status) {
      case "crashed":
        return contact.overOcean ? "Lost at sea" : "Crash site";
      case "landed":
        if (contact.missionType === "terror") return "Terror site";
        if (contact.missionType === "baseDefense") return "Base defense";
        return "Landed UFO";
      case "tracked":
      case "engaging":
      default:
        return "Airborne UFO";
    }
  }

  private missionBadge(info: MissionTypeInfo): HTMLElement {
    const badge = el("div", `geo-mission-badge ${info.urgent ? "urgent" : ""}`.trim());
    const icon = el("span", "geo-mission-icon");
    icon.textContent = info.icon;
    const label = el("span");
    label.textContent = info.label;
    badge.append(icon, label);
    return badge;
  }

  private buildDifficultySelector(): HTMLElement {
    const wrap = el("div", "geo-difficulty");
    wrap.setAttribute("role", "radiogroup");
    wrap.setAttribute("aria-label", "Campaign difficulty");
    const eye = el("div", "geo-difficulty-eye");
    eye.textContent = "Select difficulty";
    wrap.append(eye);
    for (const level of DIFFICULTY_LEVELS) {
      const config = DIFFICULTY_CONFIGS[level];
      const option = el("button", "geo-diff-option");
      option.type = "button";
      option.setAttribute("role", "radio");
      option.setAttribute("aria-checked", String(level === this.selectedDifficulty));
      const name = el("span", "geo-diff-name");
      name.textContent = `${config.label} — threat ${formatPercent(config.startingThreat)}, foes ×${config.enemyCountMult}`;
      const desc = el("span", "geo-diff-desc");
      desc.textContent = DIFFICULTY_DESCRIPTIONS[level];
      option.append(name, desc);
      option.addEventListener("click", () => {
        if (this.selectedDifficulty === level) return;
        this.selectedDifficulty = level;
        wrap.querySelectorAll(".geo-diff-option").forEach((node) => {
          node.setAttribute("aria-checked", String(node === option));
        });
      });
      wrap.append(option);
    }
    return wrap;
  }

  /** Terminal-status notice; returns null when the campaign is still active. */
  private buildNotice(): HTMLElement | null {
    const status = this.campaign?.strategic.status;
    if (status !== "won" && status !== "lost") return null;
    const notice = el("div", `geo-notice ${status}`);
    const icon = el("span", "geo-notice-icon");
    icon.textContent = status === "won" ? "★" : "✕";
    const body = el("div");
    const heading = el("b");
    heading.textContent = status === "won" ? "Containment achieved" : "Containment failed";
    const copy = el("p");
    copy.textContent = status === "won"
      ? "The invasion cell is broken. Council stands down the project."
      : "Command has collapsed. The council is withdrawing funding from the project.";
    body.append(heading, copy);
    notice.append(icon, body);
    return notice;
  }

  private objectiveCard(): HTMLElement {
    const campaign = this.campaign!;
    const objective = campaignObjectiveProgress(campaign);
    const card = el("section", "geo-card-primary");
    const title = el("strong");
    title.textContent = `${objective.title} · ${objective.completed}/${objective.required}`;
    const copy = el("p");
    copy.textContent =
      `${objective.summary} Campaign progress ${formatPercent(objective.percent)}. ` +
      (objective.status === "active"
        ? "Intercept UFOs, recover crash sites, and keep council support alive."
        : "No further recovery operations are authorized.");
    card.append(title, copy);
    return card;
  }

  private aircraftCard(): HTMLElement {
    const campaign = this.campaign!;
    const repairedAt = campaign.interceptor.repairedAtHour;
    const repairing = repairedAt !== undefined && repairedAt > campaign.clock.elapsedHours;
    const card = el("section", repairing ? "geo-row alert" : "geo-row");
    const title = el("strong");
    const copy = el("p");
    if (repairedAt !== undefined && repairedAt > campaign.clock.elapsedHours) {
      title.textContent = `Interceptor repair · ${formatPercent(campaign.interceptor.damage)} damage`;
      copy.textContent =
        `${formatHours(repairedAt - campaign.clock.elapsedHours)} until airborne. ` +
        `${campaign.interceptor.sorties} sorties flown.`;
    } else {
      title.textContent = "Interceptor ready";
      copy.textContent = `${campaign.interceptor.sorties} sorties flown. Craft is cleared for launch.`;
    }
    if (campaign.lastInterceptionReport) {
      copy.textContent += ` Last sortie: ${campaign.lastInterceptionReport.summary}`;
    }
    card.append(title, copy);
    return card;
  }

  private councilCard(): HTMLElement {
    const campaign = this.campaign!;
    const panic = highestRegionalPanic(campaign);
    const card = el("section", panic.panic >= 75 ? "geo-row alert" : "geo-row");
    const title = el("strong");
    const copy = el("p");
    title.textContent = `Council panic · ${panic.region} ${formatPercent(panic.panic)}`;
    copy.textContent =
      panic.panic >= 90
        ? "A council region is near collapse. Secure nearby crash sites or funding will crater."
        : panic.panic >= 75
          ? "Regional confidence is unstable. Ignored UFOs will accelerate funding pressure."
          : "Council regions are containing panic. Successful recovery operations lower local pressure.";
    card.append(title, copy);
    return card;
  }

  private fundingCard(): HTMLElement {
    const report = this.campaign?.lastFundingReport;
    const card = el("section", "geo-row");
    const title = el("strong");
    const copy = el("p");
    if (report) {
      title.textContent = `Funding report ${report.reportNumber} · ${formatSignedCredits(report.net)}`;
      copy.textContent =
        `${report.summary} Current funding ${formatCredits(report.funding)}, threat ${formatPercent(report.threat)}, ` +
        `score ${report.score}.`;
    } else {
      title.textContent = "Funding report pending";
      copy.textContent = "The council issues its first transfer after 30 campaign days.";
    }
    card.append(title, copy);
    return card;
  }

  private projectCard(): HTMLElement {
    const report = this.campaign?.projectReports[0];
    const card = el("section", report ? "geo-row alert" : "geo-row");
    const title = el("strong");
    const copy = el("p");
    if (report) {
      title.textContent = `Project complete · ${report.title}`;
      copy.textContent = `${report.summary} Completed at campaign hour ${report.completedAtHour}.`;
    } else {
      title.textContent = "Project reports pending";
      copy.textContent = "Completed research, manufacturing, and construction reports will appear here.";
    }
    card.append(title, copy);
    return card;
  }

  private stat(
    label: string,
    value: string,
    hint?: string,
    tone?: "info" | "accent" | "warn" | "danger",
  ): HTMLElement {
    const chip = el("div", tone ? `ui-chip ui-chip--${tone}` : "ui-chip");
    const labelEl = el("span", "ui-chip__label");
    labelEl.textContent = label;
    const valueEl = el("span", "ui-chip__value");
    valueEl.textContent = value;
    if (hint) chip.title = `${label}: ${value} — ${hint}`;
    chip.append(labelEl, valueEl);
    return chip;
  }

  private updateSelectionHud(): void {
    if (!this.selectedBase) {
      this.selectedRegion.textContent = "No base selected";
      this.selectedCoords.textContent = "Click a location on Earth to place your first command base.";
      this.confirmButton.textContent = "Select base site";
      this.confirmButton.disabled = true;
      return;
    }
    this.selectedRegion.textContent = this.selectedBase.region;
    this.selectedCoords.textContent =
      `${fmtCoord(this.selectedBase.lat, "N", "S")}  /  ${fmtCoord(this.selectedBase.lon, "E", "W")}`;
    this.confirmButton.textContent = this.opts.campaign ? "Review base" : "Confirm base site";
    this.confirmButton.disabled = false;
  }

  private placeMarker(base: BaseLocation): void {
    const normal = latLonToVector(base.lat, base.lon, 1).normalize();
    this.baseMarker.visible = true;
    this.baseMarker.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.08);
    this.baseMarker.quaternion.setFromUnitVectors(UP, normal);
  }

  private placeUfoMarker(contact: UfoContact): void {
    const normal = latLonToVector(contact.lat, contact.lon, 1).normalize();
    this.ufoMarker.visible = true;
    this.ufoMarker.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.13);
    this.ufoMarker.quaternion.setFromUnitVectors(UP, normal);
  }

  private placeHqMarker(location: BaseLocation): void {
    const normal = latLonToVector(location.lat, location.lon, 1).normalize();
    this.hqMarker.visible = true;
    this.hqMarker.position.copy(normal).multiplyScalar(EARTH_RADIUS + 0.15);
    this.hqMarker.quaternion.setFromUnitVectors(UP, normal);
  }

  private resize = (): void => {
    const rect = this.canvasWrap.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private updatePointer(event: PointerEvent): void {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  }

  /** Globe cursor by mode: crosshair while placing a base, grab otherwise. */
  private cursorForMode(): string {
    return this.buildMode || canSelectBaseSite(this.opts.campaign) ? "crosshair" : "grab";
  }

  private applyCanvasCursor(): void {
    if (this.disposed) return;
    this.renderer.domElement.style.cursor = this.cursorForMode();
  }

  /** Hover affordance: pointer when the pointer is over a clickable marker
   *  (UFO / base), otherwise the mode cursor. Skipped mid-drag. */
  private onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.down) return;
    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const targets: Object3D[] = [];
    if (this.ufoMarker.visible) targets.push(this.ufoMarker);
    if (this.baseMarker.visible) targets.push(this.baseMarker);
    for (const child of this.extraBaseMarkers.children) {
      if (child.visible) targets.push(child);
    }
    const hit = targets.length ? this.raycaster.intersectObjects(targets, true)[0] : undefined;
    this.renderer.domElement.style.cursor = hit ? "pointer" : this.cursorForMode();
  };

  private onPointerDown = (event: PointerEvent): void => {
    this.down = { x: event.clientX, y: event.clientY };
    this.renderer.domElement.style.cursor = "grabbing";
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.down) return;
    const dx = event.clientX - this.down.x;
    const dy = event.clientY - this.down.y;
    this.down = null;
    this.applyCanvasCursor();
    if (dx * dx + dy * dy > 36) return;
    if (this.buildMode && this.opts.campaign) {
      this.updatePointer(event);
      this.raycaster.setFromCamera(this.pointer, this.camera);
      const hit = this.raycaster.intersectObject(this.earthMesh, false)[0];
      if (hit) {
        const ll = hit.uv ? uvToLatLon(hit.uv) : vectorToLatLon(this.earthGroup.worldToLocal(hit.point.clone()));
        this.opts.onBuildNewBase?.(makeBase(ll.lat, ll.lon));
      }
      this.buildMode = false;
      this.refresh();
      return;
    }
    if (!canSelectBaseSite(this.opts.campaign)) return;

    this.updatePointer(event);
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObject(this.earthMesh, false)[0];
    if (!hit) return;
    const ll = hit.uv ? uvToLatLon(hit.uv) : vectorToLatLon(this.earthGroup.worldToLocal(hit.point.clone()));
    this.selectedBase = makeBase(ll.lat, ll.lon);
    this.placeMarker(this.selectedBase);
    this.controls.autoRotate = false;
    this.updateSelectionHud();
  };

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    this.baseMarker.scale.setScalar(1 + (this.reducedMotion ? 0 : Math.sin(now * 0.004) * 0.08));
    const contact = this.campaign?.ufoContact;
    const urgent = contact ? missionTypeInfo(contact.missionType).urgent : false;
    // Urgent contacts (terror / base defense) pulse faster and harder so they
    // read as higher priority against the steady crash-site markers.
    this.ufoMarker.scale.setScalar(
      1 + (this.reducedMotion ? 0 : Math.sin(now * (urgent ? 0.012 : 0.006)) * (urgent ? 0.2 : 0.18)),
    );
    // The HQ beacon pulses harder and faster than any other marker — it is the
    // endgame's single most important object on the globe once revealed.
    if (this.hqMarker.visible) {
      this.hqMarker.scale.setScalar(1 + (this.reducedMotion ? 0 : Math.sin(now * 0.014) * 0.26));
    }
    this.updateContactLabel(contact);
    // Pursuit theater: drift the pursued UFO, fly the interceptor out, ease the
    // displayed km range, and stream the chase contrails.
    this.applyPursuitDrift(now);
    this.animateInterceptor(now);
    this.easePursuitRange();
    this.updateContrails();
    this.advanceFlowingTime(now);
    // onAdvanceTime may synchronously dispose+remount this view (current controller);
    // bail before touching the disposed renderer/controls in that case.
    if (this.disposed) return;
    this.smoothMarkers();
    this.animateDeploymentMarkers(now);
    this.updateTerminator();
    this.updateCityLights();
    this.updateAtmosphere();
    this.updateClockReadout();
    for (const ring of this.beaconPulseRings) {
      if (ring.parent) animateBeaconPulse(ring, now, this.reducedMotion);
    }
    if (this.cloudMesh) this.cloudMesh.rotation.y += 0.00018;
    this.updateChaseCamera();
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
