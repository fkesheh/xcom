import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  type Material,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
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

import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
  MissionType,
  UfoContact,
} from "../campaign/types";
import {
  canLaunchInterceptor,
  formatCampaignClock,
  GEOSCAPE_SCAN_HOURS,
  type InterceptionAction,
  interceptionForecast,
  isInterceptorReady,
} from "../campaign/geoscape";
import { campaignObjectiveProgress, canBuildNewBase, DIFFICULTY_CONFIGS, highestRegionalPanic, MAX_EXTRA_BASES, NEW_BASE_COST, transportCraft } from "../campaign/storage";
import {
  WORLD_CITY_POINTS,
  WORLD_LAND_RINGS,
  type LatLon,
} from "./worldMapData";

interface GeoscapeOptions {
  campaign: CampaignState | null;
  /** difficulty is only supplied from the new-game screen; existing campaigns keep theirs. */
  onConfirmBase: (base: BaseLocation, difficulty?: DifficultyLevel) => void;
  onAdvanceTime: (hours: number) => void;
  onInterceptUfo: () => void;
  onResetCampaign: () => void;
  /** Fires for each Close / Attack / Disengage choice during an active interception encounter. */
  onInterceptionAction?: (action: InterceptionAction) => void;
  /** Designate a new radar base on the globe (multi-base campaign). */
  onBuildNewBase?: (location: BaseLocation) => void;
}

export interface GeoscapeTimeAction {
  label: string;
  hours: number;
  disabled: boolean;
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
const MAP_WIDTH = 2048;
const MAP_HEIGHT = 1024;

/** Engagement range at which an interception encounter begins (mirrors the campaign layer). */
const ENCOUNTER_START_RANGE = 3;
/** Sampling resolution of the base->UFO great-circle trajectory line. */
const TRAJECTORY_SEGMENTS = 24;
/** Duration of the interceptor's base->UFO launch flight, in milliseconds. */
const INTERCEPTOR_FLIGHT_MS = 1300;
/** Arc fraction the launch flight covers; the remaining slice is range-driven closing. */
const INTERCEPTOR_FLIGHT_END = 0.75;
/** Skyranger transport flight (base -> mission site) on mission launch, in milliseconds. */
const DEPLOYMENT_FLIGHT_MS = 2800;
/** Sampling resolution of the base->site Skyranger trajectory line. */
const DEPLOYMENT_SEGMENTS = 32;
/** Particles per interception impact burst (precomputed; no per-frame allocation). */
const BURST_PARTICLES = 14;

/** Max sampled points of the UFO flight trail (one per refresh while airborne). */
const UFO_TRAIL_MAX = 48;
/** Minimum degrees between two trail samples (avoids a dense blob when the UFO creeps). */
const UFO_TRAIL_MIN_DEG = 0.4;
/** Max sampled points of an in-flight craft's contrail (one per refresh while flying). */
const FLIGHT_TRAIL_MAX = 24;
/** Min degrees between two flight-trail samples (avoids a dense blob when creeping). */
const FLIGHT_TRAIL_MIN_DEG = 0.4;

/** Interception combat-FX durations, in milliseconds. */
const FX_TRACER_MS = 200;
const FX_MUZZLE_MS = 130;
const FX_BURST_MS = 430;
const FX_SHAKE_MS = 240;
/** Camera shake magnitude (world units) at hit onset; decays over FX_SHAKE_MS. */
const FX_SHAKE_MAGNITUDE = 0.03;

/** Contrail particles per craft (ring buffer; no per-frame allocation). */
const CONTRAIL_MAX = 36;
/** Particles in the dogfight explosion burst (larger than the standard impact burst). */
const EXPLOSION_PARTICLES = 26;
/** Multi-round tracer pulses fired per interceptor volley (reads as a cannon burst). */
const VOLLEY_ROUNDS = 3;
/** Stagger between successive tracer rounds within one volley, in milliseconds. */
const VOLLEY_ROUND_MS = 65;
/** Ms the interceptor "taking fire" threat badge + screen flash stays lit. */
const THREAT_FLASH_MS = 420;

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
  1: { hours: 1 / 60, ms: 700 }, // ~1 game-minute per tick
  5: { hours: 5 / 60, ms: 500 }, // ~5 game-minutes per tick
  30: { hours: 20 / 60, ms: 400 }, // ~20 game-minutes per tick
};

/** Auto-pause toast kind; pairs an icon with the color so the alert is never color-alone. */
type EventKind = "info" | "won" | "lost";
interface EventInfo {
  kind: EventKind;
  text: string;
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
}

// Bridge state for the current remount-based controller (src/game/main.ts rebuilds the
// view per action). Persisting the chosen speed + last event snapshot across those
// remounts keeps flowing time continuous and lets auto-pause fire on events even though
// the GeoscapeView instance is replaced. Once main.ts switches to update() (no remount),
// this becomes a harmless no-op cache.
let resumedTimeSpeed = 0;
let lastEventSnapshot: EventSnapshot | null = null;

const CSS = `
#geoscape {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: #dff7ff;
  background:
    radial-gradient(circle at 48% 42%, rgba(10,44,61,.88), rgba(3,8,14,.96) 42%, #010308 100%);
  font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .02em;
}
#geoscape canvas { width: 100%; height: 100%; cursor: crosshair; }
#geoscape::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(103,232,249,.045) 1px, transparent 1px),
    linear-gradient(rgba(103,232,249,.035) 1px, transparent 1px),
    radial-gradient(circle at 50% 50%, transparent 43%, rgba(0,0,0,.42) 100%);
  background-size: 42px 42px, 42px 42px, auto;
  mix-blend-mode: screen;
}
#geoscape .geo-canvas {
  position: absolute;
  inset: 0;
}
#geoscape .geo-panel {
  position: absolute;
  z-index: 4;
  width: min(360px, calc(100vw - 28px));
  padding: 16px;
  border: 1px solid rgba(103,232,249,.28);
  border-radius: 10px;
  background:
    linear-gradient(145deg, rgba(12,30,43,.92), rgba(3,9,15,.94) 62%),
    rgba(3,9,15,.94);
  box-shadow: 0 24px 80px rgba(0,0,0,.38), inset 0 1px rgba(255,255,255,.035);
  backdrop-filter: blur(10px);
}
#geoscape .geo-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 36%;
  height: 2px;
  background: linear-gradient(90deg, #67e8f9, transparent);
}
#geoscape .geo-left {
  top: max(18px, env(safe-area-inset-top));
  left: max(18px, env(safe-area-inset-left));
}
#geoscape .geo-right {
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
}
#geoscape .eyebrow {
  color: #67e8f9;
  font: 800 9px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .2em;
  text-transform: uppercase;
}
#geoscape h1 {
  margin: 7px 0 10px;
  font-size: clamp(30px, 5vw, 56px);
  line-height: .88;
  letter-spacing: .035em;
  text-transform: uppercase;
}
#geoscape h2 {
  margin: 7px 0 8px;
  font-size: 20px;
  line-height: 1;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#geoscape p {
  margin: 0;
  color: #95adbf;
}
#geoscape .geo-status {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 7px;
  margin-top: 15px;
}
#geoscape .geo-stat {
  padding: 9px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 7px;
  background: rgba(0,0,0,.16);
}
#geoscape .geo-stat span {
  display: block;
  color: #7190a4;
  font: 750 8px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#geoscape .geo-stat b {
  display: block;
  margin-top: 5px;
  color: #e8fbff;
  font: 800 11px/1 ui-monospace, monospace;
}
#geoscape .geo-site {
  margin: 13px 0;
  padding: 13px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.5);
}
#geoscape .geo-site strong {
  display: block;
  margin-bottom: 7px;
  color: #fbbf24;
  font: 850 17px/1 ui-monospace, monospace;
  text-transform: uppercase;
}
#geoscape .geo-coords {
  color: #a9c8d7;
  font: 650 10px/1.5 ui-monospace, monospace;
}
#geoscape .geo-contact {
  margin-top: 13px;
  padding: 13px;
  border: 1px solid rgba(251,113,133,.34);
  border-radius: 8px;
  background: rgba(45,11,18,.28);
}
#geoscape .geo-contact.idle {
  border-color: rgba(103,232,249,.16);
  background: rgba(2,12,20,.42);
}
#geoscape .geo-contact.lost {
  border-color: rgba(100,116,139,.5);
  background: rgba(15,23,42,.4);
}
#geoscape .geo-contact.lost strong { color: #94a3b8; }
#geoscape .geo-contact strong {
  display: block;
  color: #fb7185;
  font: 850 13px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#geoscape .geo-contact.idle strong {
  color: #67e8f9;
}
#geoscape .geo-contact p {
  margin-top: 7px;
  font-size: 10px;
}
#geoscape .geo-actions {
  display: flex;
  gap: 8px;
}
#geoscape button {
  min-height: 42px;
  padding: 0 13px;
  cursor: pointer;
  color: #ecfeff;
  border: 1px solid rgba(132,165,188,.32);
  border-radius: 7px;
  background: linear-gradient(180deg, rgba(34,51,65,.95), rgba(11,24,34,.96));
  font: 800 10px/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .07em;
  text-transform: uppercase;
}
#geoscape button.primary {
  flex: 1;
  border-color: rgba(103,232,249,.78);
  background: linear-gradient(180deg, rgba(17,94,117,.98), rgba(8,49,65,.98));
}
#geoscape button:hover:not(:disabled) {
  border-color: rgba(103,232,249,.9);
  background: linear-gradient(180deg, rgba(38,76,92,.98), rgba(11,39,52,.98));
}
#geoscape button:disabled {
  cursor: default;
  opacity: .4;
}
#geoscape .geo-hint {
  position: absolute;
  left: 50%;
  bottom: max(22px, env(safe-area-inset-bottom));
  z-index: 3;
  width: min(520px, calc(100vw - 36px));
  padding: 10px 14px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 999px;
  color: #94aebe;
  background: rgba(0,0,0,.3);
  text-align: center;
  transform: translateX(-50%);
  font: 700 10px/1.3 ui-monospace, monospace;
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
  color: #67e8f9;
  font: 800 9px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .2em;
  text-transform: uppercase;
}
#geoscape .geo-diff-option {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 9px 11px;
  cursor: pointer;
  text-align: left;
  color: #cfe6f2;
  border: 1px solid rgba(132,165,188,.24);
  border-radius: 7px;
  background: rgba(0,0,0,.18);
  font: 700 11px/1.3 ui-monospace, monospace;
}
#geoscape .geo-diff-option .geo-diff-name {
  color: #e8fbff;
  font-weight: 800;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#geoscape .geo-diff-option .geo-diff-name::before {
  content: "○  ";
  color: #67e8f9;
}
#geoscape .geo-diff-option .geo-diff-desc {
  color: #8aa6b6;
  font-size: 10px;
  font-weight: 600;
  text-transform: none;
  letter-spacing: 0;
}
#geoscape .geo-diff-option[aria-checked="true"] {
  border-color: rgba(103,232,249,.85);
  background: linear-gradient(180deg, rgba(17,94,117,.95), rgba(8,49,65,.95));
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
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid rgba(255,255,255,.14);
  background: rgba(0,0,0,.32);
  color: #f1f5f9;
  font: 800 9px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#geoscape .geo-mission-badge.urgent {
  border-color: rgba(249,115,22,.7);
  background: rgba(67,20,7,.5);
  color: #fed7aa;
}
#geoscape .geo-mission-badge .geo-mission-icon { font-size: 12px; }
#geoscape .geo-mission-badge.lost {
  border-color: rgba(100,116,139,.6);
  background: rgba(15,23,42,.55);
  color: #cbd5e1;
}
#geoscape .geo-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 10px 6px 4px;
  text-align: center;
}
#geoscape .geo-empty .geo-empty-icon {
  font-size: 20px;
  line-height: 1;
  color: #67e8f9;
  opacity: .75;
}
#geoscape .geo-notice {
  display: flex;
  align-items: center;
  gap: 11px;
  margin-top: 13px;
  padding: 11px 13px;
  border-radius: 8px;
  border: 1px solid rgba(103,232,249,.3);
  background: rgba(2,12,20,.55);
}
#geoscape .geo-notice.won {
  border-color: rgba(134,239,172,.6);
  background: rgba(8,30,16,.45);
}
#geoscape .geo-notice.lost {
  border-color: rgba(248,113,113,.6);
  background: rgba(45,11,18,.4);
}
#geoscape .geo-notice .geo-notice-icon { font-size: 18px; line-height: 1; }
#geoscape .geo-notice.won .geo-notice-icon { color: #86efac; }
#geoscape .geo-notice.lost .geo-notice-icon { color: #fda4af; }
#geoscape .geo-notice b {
  display: block;
  color: #e8fbff;
  font: 800 11px/1.3 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#geoscape .geo-notice p { margin-top: 3px; font-size: 10px; }
#geoscape .geo-overlay {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(2,8,14,.62);
  backdrop-filter: blur(4px);
}
#geoscape .geo-bar { margin: 8px 0; }
#geoscape .geo-bar-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: #cbd5e1;
  font: 700 9px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#geoscape .geo-bar-track {
  height: 10px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 999px;
  background: rgba(255,255,255,.08);
  overflow: hidden;
}
#geoscape .geo-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width .2s;
}
#geoscape .geo-bar-fill.ufo { background: linear-gradient(90deg, #fb7185, #f43f5e); }
#geoscape .geo-bar-fill.interceptor { background: linear-gradient(90deg, #67e8f9, #22d3ee); }
#geoscape .geo-overlay-host {
  position: absolute;
  inset: 0;
  z-index: 8;
  pointer-events: none;
}
#geoscape .geo-overlay-host .geo-overlay { pointer-events: auto; }
#geoscape .geo-help {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  z-index: 6;
  min-width: 42px;
  min-height: 42px;
  padding: 0;
  border-radius: 8px;
  border: 1px solid rgba(103,232,249,.5);
  color: #67e8f9;
  background: rgba(2,12,20,.82);
  font: 800 16px/1 ui-monospace, monospace;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0,0,0,.4);
}
#geoscape .geo-help:hover { border-color: rgba(103,232,249,.95); background: rgba(14,52,67,.95); }
/* The HELP overlay lives permanently in the DOM (toggled via .show), so override
   the always-on display:flex of .geo-overlay and gate it on .show. */
#geoscape .geo-help-overlay { display: none; }
#geoscape .geo-help-overlay.show { display: flex; }
#geoscape .geo-help-card {
  width: min(560px, 100%);
  padding: clamp(22px, 4vw, 36px);
  border: 1px solid rgba(103,232,249,.32);
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%);
  box-shadow: 0 30px 100px rgba(0,0,0,.55);
}
#geoscape .geo-help-card .eyebrow { color: #67e8f9; font: 700 9px/1.2 ui-monospace, monospace; letter-spacing: .18em; text-transform: uppercase; }
#geoscape .geo-help-card h2 { margin: 7px 0 8px; color: #e8fbff; font-size: 24px; letter-spacing: .04em; text-transform: uppercase; }
#geoscape .geo-help-card p.lede { margin: 0; max-width: 480px; color: #a9c8d7; font-size: 12px; }
#geoscape .geo-help-card ul { margin: 16px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
#geoscape .geo-help-card li { padding: 9px 12px; border: 1px solid rgba(255,255,255,.07); border-radius: 8px; background: rgba(0,0,0,.18); color: #cfe2ee; font: 600 11px/1.4 ui-monospace, monospace; }
#geoscape .geo-help-card li b { color: #67e8f9; font-weight: 800; }
#geoscape .geo-help-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
#geoscape .geo-help-actions button { min-width: 130px; min-height: 38px; }
#geoscape .geo-welcome {
  position: absolute;
  top: max(68px, calc(env(safe-area-inset-top) + 56px));
  left: 50%;
  transform: translateX(-50%);
  z-index: 6;
  display: none;
  width: min(440px, calc(100vw - 36px));
  padding: 13px 15px;
  border: 1px solid rgba(103,232,249,.5);
  border-radius: 12px;
  background: linear-gradient(145deg, rgba(12,30,43,.96), rgba(3,9,15,.97));
  box-shadow: 0 24px 70px rgba(0,0,0,.55);
}
#geoscape .geo-welcome.show { display: block; }
#geoscape .geo-welcome .eyebrow { color: #67e8f9; font: 700 9px/1.2 ui-monospace, monospace; letter-spacing: .18em; text-transform: uppercase; }
#geoscape .geo-welcome b { display: block; margin: 5px 0 7px; color: #e8fbff; font: 800 13px/1.2 ui-monospace, monospace; letter-spacing: .04em; }
#geoscape .geo-welcome ol { margin: 0; padding-left: 18px; color: #cfe2ee; font: 600 11px/1.5 ui-monospace, monospace; }
#geoscape .geo-welcome ol li { margin-bottom: 3px; }
#geoscape .geo-welcome-actions { display: flex; justify-content: flex-end; margin-top: 10px; }
#geoscape .geo-welcome-actions button { min-height: 32px; min-width: 96px; padding: 0 12px; }
#geoscape .geo-speed {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 6px;
  flex: 1;
}
#geoscape .geo-speed-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  min-height: 40px;
  padding: 4px 6px;
  font-size: 9px;
}
#geoscape .geo-speed-btn .geo-speed-icon {
  font-size: 12px;
  line-height: 1;
  color: #67e8f9;
}
#geoscape .geo-speed-btn[aria-pressed="true"] {
  border-color: rgba(103,232,249,.9);
  background: linear-gradient(180deg, rgba(17,94,117,.98), rgba(8,49,65,.98));
}
#geoscape .geo-speed-btn[aria-pressed="true"] .geo-speed-icon { color: #ecfeff; }
#geoscape .geo-contact .geo-contact-status {
  margin-top: 7px;
  color: #fbbf24;
  font: 800 10px/1.3 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#geoscape .geo-contact .geo-contact-meta {
  margin-top: 4px;
  color: #8aa6b6;
  font: 600 10px/1.4 ui-monospace, monospace;
}
#geoscape .geo-toast {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  z-index: 9;
  transform: translate(-50%, -16px);
  opacity: 0;
  pointer-events: none;
  padding: 10px 16px;
  border-radius: 999px;
  border: 1px solid rgba(103,232,249,.5);
  background: rgba(2,12,20,.85);
  color: #e8fbff;
  font: 800 11px/1.3 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
  box-shadow: 0 16px 50px rgba(0,0,0,.45);
  transition: opacity .2s ease, transform .2s ease;
}
#geoscape .geo-toast.visible {
  opacity: 1;
  transform: translate(-50%, 0);
}
#geoscape .geo-toast[data-kind="won"] {
  border-color: rgba(134,239,172,.7);
  color: #bbf7d0;
}
#geoscape .geo-toast[data-kind="lost"] {
  border-color: rgba(248,113,113,.7);
  color: #fecaca;
}
#geoscape .geo-damage-layer {
  position: absolute;
  inset: 0;
  z-index: 7;
  pointer-events: none;
}
#geoscape .geo-dmg {
  position: absolute;
  transform: translate(-50%, -50%);
  color: #fff;
  font: 800 14px/1 ui-monospace, monospace;
  letter-spacing: .03em;
  text-shadow: 0 1px 3px rgba(0,0,0,.9), 0 0 8px rgba(0,0,0,.6);
  animation: geo-dmg-float .9s ease-out forwards;
  white-space: nowrap;
}
#geoscape .geo-dmg.ufo { color: #fdba74; }
#geoscape .geo-dmg.interceptor { color: #fda4af; }
@keyframes geo-dmg-float {
  0% { opacity: 0; transform: translate(-50%, -30%) scale(.7); }
  15% { opacity: 1; transform: translate(-50%, -55%) scale(1.05); }
  100% { opacity: 0; transform: translate(-50%, -140%) scale(1); }
}
#geoscape .geo-deploy {
  align-items: center;
  justify-content: center;
}
#geoscape .geo-deploy-panel {
  width: min(420px, calc(100vw - 48px));
  padding: 18px;
  border: 1px solid rgba(103,232,249,.5);
  border-radius: 12px;
  background: linear-gradient(145deg, rgba(12,30,43,.96), rgba(3,9,15,.97));
  box-shadow: 0 30px 90px rgba(0,0,0,.55);
  text-align: center;
}
#geoscape .geo-deploy-panel .eyebrow { color: #67e8f9; }
#geoscape .geo-deploy-panel h2 { color: #e8fbff; margin-bottom: 6px; }
#geoscape .geo-deploy-panel p { color: #a9c8d7; font-size: 11px; }
#geoscape .geo-deploy-panel .geo-bar { margin: 12px 0 0; text-align: left; }
#geoscape .geo-deploy-actions { display: flex; gap: 8px; margin-top: 14px; }
#geoscape .geo-deploy-actions button { flex: 1; }
#geoscape .geo-threat-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
  padding: 4px 9px;
  border-radius: 999px;
  border: 1px solid rgba(248,113,113,.7);
  background: rgba(60,12,18,.55);
  color: #fecaca;
  font: 800 10px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  opacity: 0;
  transition: opacity .12s ease;
}
#geoscape .geo-threat-tag.active { opacity: 1; animation: geo-threat-pulse .42s ease-out 2; }
@keyframes geo-threat-pulse {
  0% { box-shadow: 0 0 0 rgba(248,113,113,0); }
  50% { box-shadow: 0 0 14px rgba(248,113,113,.7); }
  100% { box-shadow: 0 0 0 rgba(248,113,113,0); }
}
#geoscape .geo-threat-flash {
  position: absolute;
  inset: 0;
  z-index: 6;
  pointer-events: none;
  opacity: 0;
  background: radial-gradient(circle at 50% 60%, rgba(248,68,68,.34), rgba(120,8,16,.18) 55%, transparent 80%);
  mix-blend-mode: screen;
  transition: opacity .12s ease;
}
#geoscape .geo-threat-flash.active { opacity: 1; transition: opacity .05s ease; }
@media (max-width: 820px) {
  #geoscape .geo-panel { width: calc(100vw - 24px); padding: 13px; }
  #geoscape .geo-left { left: 12px; right: 12px; }
  #geoscape .geo-right { left: 12px; right: 12px; bottom: 12px; }
  #geoscape h1 { font-size: 30px; }
  #geoscape .geo-status { grid-template-columns: 1fr; }
  #geoscape .geo-hint { display: none; }
  #geoscape .geo-actions { flex-wrap: wrap; }
  #geoscape .geo-speed-btn { min-height: 36px; }
}
/* Keyboard focus indicators — :focus-visible only fires for keyboard users, so
   mouse-driven screenshots are unaffected. Covers speed buttons, the difficulty
   radio options, and every generic geoscape button. */
#geoscape button:focus-visible,
#geoscape .geo-help:focus-visible,
#geoscape .geo-diff-option:focus-visible,
#geoscape select:focus-visible {
  outline: 2px solid #67e8f9;
  outline-offset: 2px;
}
/* Respect prefers-reduced-motion: stop the floating damage numbers and the
   threat pulse, and collapse transitions. The 3D marker throb + camera shake
   are additionally frozen from JS via Geoscape.reducedMotion. */
@media (prefers-reduced-motion: reduce) {
  #geoscape .geo-dmg { animation: none !important; }
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

function fmtNet(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

export function geoscapeTimeAction(campaign: CampaignState | null): GeoscapeTimeAction {
  if (!campaign) return { label: `Scan ${GEOSCAPE_SCAN_HOURS}h`, hours: GEOSCAPE_SCAN_HOURS, disabled: true };
  const disabled = campaign.strategic.status !== "active";
  const contact = campaign.ufoContact;
  if (!contact) return { label: `Scan ${GEOSCAPE_SCAN_HOURS}h`, hours: GEOSCAPE_SCAN_HOURS, disabled };
  if (contact.status === "crashed") {
    return { label: `Hold ${GEOSCAPE_SCAN_HOURS}h`, hours: GEOSCAPE_SCAN_HOURS, disabled };
  }
  return {
    label: isInterceptorReady(campaign) ? `Track ${GEOSCAPE_SCAN_HOURS}h` : `Wait ${GEOSCAPE_SCAN_HOURS}h`,
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
    if (next.status === "won") return { kind: "won", text: "Containment achieved" };
    if (next.status === "lost") return { kind: "lost", text: "Containment failed" };
  }
  if (prev.contactId === null && next.contactId !== null) {
    return { kind: "info", text: `UFO detected — ${next.region ?? "unknown sector"}` };
  }
  if (prev.contactId !== null && next.contactId !== null && prev.contactStatus !== next.contactStatus) {
    if (next.contactStatus === "crashed") return { kind: "info", text: "UFO shot down" };
    if (next.contactStatus === "landed") return { kind: "info", text: "UFO landed — launch assault" };
  }
  if (prev.fundingReport !== next.fundingReport && next.fundingReport !== null) {
    return { kind: "info", text: "Council funding report" };
  }
  if (prev.interceptionReport !== next.interceptionReport && next.interceptionReport !== null) {
    return { kind: "info", text: "Interception report filed" };
  }
  if (prev.missionsCompleted !== next.missionsCompleted) {
    return { kind: "info", text: "Mission report filed" };
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

function hash01(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

function mapXY(lat: number, lon: number, width = MAP_WIDTH, height = MAP_HEIGHT): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

function drawLatLonPath(
  ctx: CanvasRenderingContext2D,
  polygon: readonly LatLon[],
  width = MAP_WIDTH,
  height = MAP_HEIGHT,
): void {
  polygon.forEach(([lat, lon], index) => {
    const [x, y] = mapXY(lat, lon, width, height);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

function makeLandNoiseCanvas(): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  for (let y = 0; y < canvas.height; y += 2) {
    const lat = 90 - (y / canvas.height) * 180;
    for (let x = 0; x < canvas.width; x += 2) {
      const lon = (x / canvas.width) * 360 - 180;
      const n = hash01(x, y);
      const band = 0.5 + Math.sin((lat * 0.11 + lon * 0.035) * Math.PI) * 0.18;
      const g = Math.round(58 + n * 54 + band * 24);
      ctx.fillStyle = `rgba(${Math.round(22 + n * 26)}, ${g}, ${Math.round(47 + n * 35)}, .42)`;
      ctx.fillRect(x, y, 2, 2);
    }
  }
  return canvas;
}

function makeEarthTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = MAP_WIDTH;
  canvas.height = MAP_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const ocean = ctx.createLinearGradient(0, 0, MAP_WIDTH, MAP_HEIGHT);
  ocean.addColorStop(0, "#08223b");
  ocean.addColorStop(0.45, "#0a3a62");
  ocean.addColorStop(1, "#031320");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, MAP_WIDTH, MAP_HEIGHT);

  for (let y = 0; y < MAP_HEIGHT; y += 3) {
    const lat = 90 - (y / MAP_HEIGHT) * 180;
    const polar = Math.max(0, (Math.abs(lat) - 58) / 32);
    const shade = Math.round(18 + polar * 38);
    ctx.fillStyle = `rgba(${shade}, ${shade + 24}, ${shade + 42}, ${0.08 + polar * 0.12})`;
    ctx.fillRect(0, y, MAP_WIDTH, 3);
  }

  ctx.lineWidth = 1;
  for (let lat = -60; lat <= 60; lat += 15) {
    const [, y] = mapXY(lat, 0);
    ctx.strokeStyle = lat === 0 ? "rgba(103,232,249,.28)" : "rgba(103,232,249,.12)";
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(MAP_WIDTH, y);
    ctx.stroke();
  }
  for (let lon = -180; lon <= 180; lon += 15) {
    const [x] = mapXY(0, lon);
    ctx.strokeStyle = lon === 0 ? "rgba(103,232,249,.2)" : "rgba(103,232,249,.1)";
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, MAP_HEIGHT);
    ctx.stroke();
  }

  const landNoise = makeLandNoiseCanvas();
  for (const polygon of WORLD_LAND_RINGS) {
    ctx.save();
    ctx.beginPath();
    drawLatLonPath(ctx, polygon);
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(103,232,249,.26)";
    ctx.lineWidth = 8;
    ctx.stroke();
    ctx.fillStyle = "#175f3f";
    ctx.fill();
    ctx.strokeStyle = "rgba(142,246,164,.68)";
    ctx.lineWidth = 2.5;
    ctx.stroke();
    ctx.clip();
    ctx.globalAlpha = 0.36;
    ctx.drawImage(landNoise, 0, 0, MAP_WIDTH, MAP_HEIGHT);
    ctx.restore();
  }

  ctx.fillStyle = "rgba(210,255,221,.78)";
  for (const [lat, lon] of WORLD_CITY_POINTS) {
    const [x, y] = mapXY(lat, lon);
    ctx.beginPath();
    ctx.arc(x, y, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makeGridLine(points: Vector3[], color: number, opacity: number): Line {
  const geometry = new BufferGeometry().setFromPoints(points);
  const material = new LineBasicMaterial({ color, transparent: true, opacity });
  return new Line(geometry, material);
}

function makeLatLine(lat: number): LineLoop {
  const points: Vector3[] = [];
  for (let lon = -180; lon <= 180; lon += 6) points.push(latLonToVector(lat, lon, EARTH_RADIUS + 0.018));
  const geometry = new BufferGeometry().setFromPoints(points);
  const material = new LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.18 });
  return new LineLoop(geometry, material);
}

function makeLonLine(lon: number): Line {
  const points: Vector3[] = [];
  for (let lat = -84; lat <= 84; lat += 4) points.push(latLonToVector(lat, lon, EARTH_RADIUS + 0.02));
  return makeGridLine(points, 0x67e8f9, 0.16);
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
  /** Cached base->UFO great-circle route for the current engagement target. */
  private interceptorRoute: { baseN: Vector3; ufoN: Vector3; contactId: string } | null = null;
  /** Directional sun light; orbited each frame by updateTerminator for the day/night cycle. */
  private readonly sunLight = new DirectionalLight(0xffffff, 2.6);
  /** Timestamp (ms) the current interception launch flight began; drives the base->UFO fly-out. */
  private interceptorFlightStartMs = 0;
  /** Last-refresh engagement state; a false->true transition kicks off the launch flight. */
  private wasEngaging = false;
  private toastTimer: number | undefined;

  // Dynamic DOM containers populated by refresh() (static shell lives in buildHud()).
  private readonly statsGrid: HTMLDivElement;
  private readonly noticeSlot: HTMLDivElement;
  private readonly cardsSlot: HTMLDivElement;
  private readonly actionsSlot: HTMLDivElement;
  private readonly overlaySlot: HTMLDivElement;
  private readonly toast: HTMLDivElement;
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
    }
  };

  // Reusable scratch objects for the interceptor animation (no per-frame allocation).
  private readonly scratchA = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly scratchC = new Vector3();
  private readonly scratchBasis = new Matrix4();
  /** Scratch for projecting a marker to screen space for damage numbers (per hit, not per frame). */
  private readonly scratchProject = new Vector3();

  // --- Interception combat FX (allocated once in buildCombatFx, reused per hit) ---
  private tracerLineFx!: Line;
  private muzzleFlash!: Mesh;
  private ufoBurst!: Points;
  private interceptorBurst!: Points;
  private readonly ufoBurstVel = new Float32Array(BURST_PARTICLES * 3);
  private readonly interceptorBurstVel = new Float32Array(BURST_PARTICLES * 3);
  private prevUfoHp: number | null = null;
  private prevInterceptorHp: number | null = null;
  private fxTracerStartMs = 0;
  private fxMuzzleStartMs = 0;
  /** Shared burst clock: the UFO + interceptor bursts fire together in one exchange. */
  private fxBurstStartMs = 0;
  private fxTracerActive = false;
  private fxMuzzleActive = false;
  private fxUfoBurstActive = false;
  private fxInterceptorBurstActive = false;
  private shakeStartMs = 0;
  private shakeActive = false;
  private shakeMagnitude = FX_SHAKE_MAGNITUDE;
  private readonly cameraBase = new Vector3();
  private damageLayer: HTMLDivElement | null = null;

  // --- Globe visual upgrades (city lights / atmosphere rim / clouds) ---
  /** City light points; per-vertex color is rewritten each frame from the sun direction. */
  private cityLights!: Points;
  /** Local-space unit position of each city point (precomputed; never mutated). */
  private readonly cityLocal: Vector3[] = [];
  /** Scratch for the city-light day/night dot product (world space). */
  private readonly scratchCity = new Vector3();
  /** Fresnel rim atmosphere material; uSunDir uniform updated each frame. */
  private rimAtmosphereMat: ShaderMaterial | null = null;
  /** Slowly rotating translucent cloud shell. */
  private cloudMesh: Mesh | null = null;

  // --- Thruster contrails behind the interceptor + UFO during an engagement ---
  private interceptorContrail!: Points;
  private ufoContrail!: Points;
  private readonly interceptorContrailRing = new Float32Array(CONTRAIL_MAX * 3);
  private readonly ufoContrailRing = new Float32Array(CONTRAIL_MAX * 3);
  private readonly interceptorContrailState = { head: 0, count: 0 };
  private readonly ufoContrailState = { head: 0, count: 0 };

  // --- Amplified dogfight FX (bigger explosions, multi-round volleys) ---
  private explosionBurst!: Points;
  private readonly explosionBurstVel = new Float32Array(EXPLOSION_PARTICLES * 3);
  private fxExplosionActive = false;
  private volleyRounds = 0;
  private volleyNextMs = 0;
  private volleyDamageShown = false;

  // --- Dogfight HUD "taking fire" threat flash ---
  private threatFlash: HTMLDivElement | null = null;
  private threatFlashTimer: number | undefined;

  // --- Skyranger deployment flight (staged on mission launch) ---
  /** Inbound: the transport is animating from base to the mission site. */
  private deploying = false;
  /** Arrived: a Deploy/Wait choice overlay is open (time frozen until the pick). */
  private deployArrived = false;
  /** Wait chosen: the transport loiters at the site, time flows, deploy on demand. */
  private loitering = false;
  /** Time-flow speed before the deployment pause; restored on Wait to resume flow. */
  private preDeploySpeed = 0;
  private deploymentFlight: {
    baseN: Vector3;
    siteN: Vector3;
    region: string;
    craftName: string;
    startMs: number;
    onDeployed: () => void;
  } | null = null;
  private readonly skyrangerMarker = new Group();
  private deploymentLine!: Line;

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
    this.buildCombatFx();
    this.buildDeploymentFx();
    this.buildDamageLayer();
    const panels = this.buildHud();
    this.selectedRegion = panels.region;
    this.selectedCoords = panels.coords;
    this.confirmButton = panels.confirm;
    this.statsGrid = panels.statsGrid;
    this.noticeSlot = panels.noticeSlot;
    this.cardsSlot = panels.cardsSlot;
    this.actionsSlot = panels.actionsSlot;
    this.overlaySlot = panels.overlaySlot;
    this.toast = panels.toast;
    this.ufoMissionType = opts.campaign?.ufoContact?.missionType;
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
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeydown);
    this.resize();
    this.frame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    if (this.threatFlashTimer !== undefined) window.clearTimeout(this.threatFlashTimer);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeydown);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.root.remove();
    // Drop any in-flight deployment callback/state so a torn-down view can't fire it.
    this.deploymentFlight = null;
    this.deploying = false;
    this.deployArrived = false;
    this.loitering = false;
    this.damageLayer = null;
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

    const ocean = new Mesh(
      new SphereGeometry(EARTH_RADIUS, 64, 36),
      new MeshStandardMaterial({
        map: earthTexture,
        color: 0xffffff,
        emissive: 0x031c2d,
        emissiveIntensity: 0.32,
        roughness: 0.7,
        metalness: 0.03,
      }),
    );
    this.earthGroup.add(ocean);

    const atmosphere = new Mesh(
      new SphereGeometry(EARTH_RADIUS + 0.1, 64, 32),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.13,
        side: BackSide,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.earthGroup.add(atmosphere);
    // Fresnel rim glow on the day-side limb, layered over the base atmosphere.
    this.earthGroup.add(this.buildRimAtmosphere());

    // Faint translucent cloud shell, slowly rotating in the frame loop. Lit by
    // the sun so wisps read on the day side and go dark at night (rather than an
    // additive wash that would flatten the night-side city lights).
    const cloudTexture = this.makeCloudTexture();
    const cloudMesh = new Mesh(
      new SphereGeometry(EARTH_RADIUS + 0.05, 48, 24),
      new MeshStandardMaterial({
        map: cloudTexture,
        transparent: true,
        opacity: 0.5,
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
    for (let lat = -60; lat <= 60; lat += 30) this.earthGroup.add(makeLatLine(lat));
    for (let lon = -150; lon <= 180; lon += 30) this.earthGroup.add(makeLonLine(lon));
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
    this.buildUfoMarker(this.opts.campaign?.ufoContact?.missionType);
    this.earthGroup.add(this.ufoMarker);
    if (this.opts.campaign?.ufoContact) this.placeUfoMarker(this.opts.campaign.ufoContact);
    else this.ufoMarker.visible = false;
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
   * Cyan interceptor craft built as a recognizable plane silhouette — fuselage
   * with a tapered nose, two swept main wings, a vertical tail fin, and a dark
   * canopy — distinct from the amber base cone and the UFO's mission-colored
   * marker. The marker's +Y is forward (oriented toward the UFO in
   * animateInterceptor), so the nose points along the travel tangent. Color is
   * always paired with the "INTERCEPTOR" label in the encounter overlay, so the
   * craft is identifiable without color alone.
   */
  private buildInterceptorMarker(): void {
    const body = new MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: new Color(0x06b6d4),
      emissiveIntensity: 1.4,
      roughness: 0.3,
      metalness: 0.45,
    });
    // Fuselage along +Y (forward axis), tapering toward the tail.
    const fuselage = new Mesh(new CylinderGeometry(0.011, 0.019, 0.15, 8), body);
    // Nose cone pointing forward.
    const nose = new Mesh(new ConeGeometry(0.011, 0.04, 8), body);
    nose.position.y = 0.095;
    // Swept main wings extending in ±X, swept back via Z rotation.
    const wingGeo = new BoxGeometry(0.062, 0.034, 0.006);
    const wingR = new Mesh(wingGeo, body);
    wingR.position.set(0.04, -0.012, 0);
    wingR.rotation.z = -0.4;
    const wingL = new Mesh(wingGeo, body);
    wingL.position.set(-0.04, -0.012, 0);
    wingL.rotation.z = 0.4;
    // Vertical tail fin at the rear, extending +Z (away from the globe surface).
    const tail = new Mesh(new BoxGeometry(0.006, 0.03, 0.02), body);
    tail.position.set(0, -0.055, 0.011);
    // Cockpit canopy — a dark glowing sliver near the nose.
    const canopy = new Mesh(
      new SphereGeometry(0.008, 8, 6),
      new MeshStandardMaterial({
        color: 0x0e7490,
        emissive: new Color(0x0891b2),
        emissiveIntensity: 0.9,
        roughness: 0.2,
        metalness: 0.6,
      }),
    );
    canopy.position.set(0, 0.045, 0.004);
    canopy.scale.set(1, 1.5, 0.75);
    const ring = new Mesh(
      new RingGeometry(0.07, 0.1, 20),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.5,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.interceptorMarker.add(fuselage, nose, wingR, wingL, tail, canopy, ring);
  }

  private makeStars(): Points {
    const positions: number[] = [];
    for (let i = 0; i < 520; i++) {
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
        color: 0xbfefff,
        size: 0.018,
        transparent: true,
        opacity: 0.82,
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
        size: 0.022,
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
    for (let i = 0; i < this.cityLocal.length; i++) {
      this.scratchCity.copy(this.cityLocal[i]!);
      this.earthGroup.localToWorld(this.scratchCity); // earthGroup has no scale → stays unit length
      this.scratchCity.normalize();
      const dot = this.scratchCity.dot(this.scratchA); // >0 day, <0 night
      const night = dot < 0 ? -dot : 0;
      const glow = 0.08 + night * 1.0;
      arr[i * 3] = 0.98 * glow;
      arr[i * 3 + 1] = 0.82 * glow;
      arr[i * 3 + 2] = 0.3 * glow;
    }
    colAttr.needsUpdate = true;
  }

  /** Fresnel rim atmosphere: brightest on the day-side limb, faint on the night limb. */
  private buildRimAtmosphere(): Mesh {
    const material = new ShaderMaterial({
      transparent: true,
      blending: AdditiveBlending,
      side: BackSide,
      depthWrite: false,
      uniforms: {
        uSunDir: { value: new Vector3(1, 0, 0) },
        uColor: { value: new Color(0x67e8f9) },
        uPower: { value: 3.0 },
      },
      vertexShader: `
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vNormalW = normalize(mat3(modelMatrix) * normal);
          vViewDir = normalize(cameraPosition - wp.xyz);
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        varying vec3 vNormalW;
        varying vec3 vViewDir;
        uniform vec3 uSunDir;
        uniform vec3 uColor;
        uniform float uPower;
        void main() {
          float rim = pow(1.0 - abs(dot(vViewDir, vNormalW)), uPower);
          float day = max(0.0, dot(normalize(vNormalW), normalize(uSunDir)));
          float a = rim * (0.16 + 0.7 * day);
          gl_FragColor = vec4(uColor, a);
        }
      `,
    });
    this.rimAtmosphereMat = material;
    return new Mesh(new SphereGeometry(EARTH_RADIUS + 0.17, 64, 32), material);
  }

  /** Sync the rim atmosphere's sun direction uniform with the live sun position. */
  private updateAtmosphere(): void {
    if (!this.rimAtmosphereMat) return;
    const sunUniform = this.rimAtmosphereMat.uniforms.uSunDir;
    if (!sunUniform) return;
    (sunUniform.value as Vector3).copy(this.sunLight.position).normalize();
  }

  /** Faint translucent cloud shell built from soft procedural wisps (deterministic). */
  private makeCloudTexture(): CanvasTexture {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 512;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas unavailable");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Deterministic soft white wisps scattered across the equirectangular map.
    for (let i = 0; i < 240; i++) {
      const cx = hash01(i, 7.3) * canvas.width;
      const cy = (0.2 + hash01(i, 13.1) * 0.6) * canvas.height;
      const r = 10 + hash01(i, 21.7) * 46;
      const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      const a = 0.05 + hash01(i, 31.9) * 0.12;
      grad.addColorStop(0, `rgba(255,255,255,${a})`);
      grad.addColorStop(1, "rgba(255,255,255,0)");
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }

  private buildBaseMarker(): void {
    const pulse = new Mesh(
      new SphereGeometry(0.055, 16, 10),
      new MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.92,
        blending: AdditiveBlending,
      }),
    );
    const cone = new Mesh(
      new ConeGeometry(0.055, 0.18, 18),
      new MeshStandardMaterial({
        color: 0xfbbf24,
        emissive: new Color(0xf59e0b),
        emissiveIntensity: 1.8,
        roughness: 0.35,
        metalness: 0.3,
      }),
    );
    cone.position.y = 0.1;
    const ring = new Mesh(
      new SphereGeometry(0.095, 18, 8, 0, Math.PI * 2, 0, Math.PI * 0.42),
      new MeshBasicMaterial({
        color: 0xfbbf24,
        transparent: true,
        opacity: 0.28,
        wireframe: true,
        side: DoubleSide,
      }),
    );
    this.baseMarker.add(pulse, cone, ring);
  }

  /** A slimmed-down cyan marker for an extra radar base (distinct from the gold primary). */
  private buildExtraBaseMarker(): Group {
    const group = new Group();
    const pulse = new Mesh(
      new SphereGeometry(0.04, 14, 8),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.9,
        blending: AdditiveBlending,
      }),
    );
    const cone = new Mesh(
      new ConeGeometry(0.04, 0.13, 14),
      new MeshStandardMaterial({
        color: 0x67e8f9,
        emissive: new Color(0x22d3ee),
        emissiveIntensity: 1.8,
        roughness: 0.35,
        metalness: 0.3,
      }),
    );
    cone.position.y = 0.07;
    const ring = new Mesh(
      new SphereGeometry(0.07, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.42),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.26,
        wireframe: true,
        side: DoubleSide,
      }),
    );
    group.add(pulse, cone, ring);
    return group;
  }

  private buildUfoMarker(missionType: MissionType | undefined): void {
    const info = missionTypeInfo(missionType);
    const core = new Mesh(
      new SphereGeometry(0.045, 16, 10),
      new MeshBasicMaterial({
        color: info.color,
        transparent: true,
        opacity: 0.95,
        blending: AdditiveBlending,
      }),
    );
    const ring = new Mesh(
      new RingGeometry(0.075, 0.12, 28),
      new MeshBasicMaterial({
        color: info.color,
        transparent: true,
        opacity: 0.55,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    const beam = new Mesh(
      new ConeGeometry(0.05, 0.16, 18),
      new MeshBasicMaterial({
        color: info.color,
        transparent: true,
        opacity: 0.46,
        blending: AdditiveBlending,
      }),
    );
    beam.position.y = 0.08;
    // Urgent mission types (terror / base defense) get a second outer halo so the
    // marker reads as higher-priority on the globe; the render loop also pulses
    // these faster. Color is always paired with the icon + label in the contact
    // card, so the mission type is never conveyed by color alone.
    if (info.urgent) {
      const halo = new Mesh(
        new RingGeometry(0.14, 0.18, 28),
        new MeshBasicMaterial({
          color: info.color,
          transparent: true,
          opacity: 0.4,
          side: DoubleSide,
          blending: AdditiveBlending,
        }),
      );
      halo.rotation.x = -Math.PI / 2;
      this.ufoMarker.add(core, ring, halo, beam);
    } else {
      this.ufoMarker.add(core, ring, beam);
    }
  }

  private buildHud(): {
    region: HTMLElement;
    coords: HTMLElement;
    confirm: HTMLButtonElement;
    statsGrid: HTMLDivElement;
    noticeSlot: HTMLDivElement;
    cardsSlot: HTMLDivElement;
    actionsSlot: HTMLDivElement;
    overlaySlot: HTMLDivElement;
    toast: HTMLDivElement;
  } {
    const left = el("section", "geo-panel geo-left");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Blacksite global command";
    const title = el("h1");
    title.textContent = "Earth Command";
    const copy = el("p");
    copy.textContent = this.opts.campaign
      ? "A clandestine base is established. Advance time to detect UFO contacts, then return to base to launch."
      : "Select a first base site on the globe. This will become the permanent command center for the campaign.";
    const statsGrid = el("div", "geo-status");
    const noticeSlot = el("div");
    const cardsSlot = el("div");
    left.append(eyebrow, title, copy, statsGrid, noticeSlot, cardsSlot);
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
    const confirm = el("button", "primary");
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

    return { region, coords, confirm, statsGrid, noticeSlot, cardsSlot, actionsSlot, overlaySlot, toast };
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
    this.refreshCards();
    this.refreshActions();
    this.refreshOverlay();
    this.refreshMarkers();
    this.refreshInterceptor();
    this.refreshSpeedState();
    this.refreshHint();
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

  /** True while an interactive interception encounter overlay is open. */
  private isEngaging(): boolean {
    const c = this.campaign;
    return !!c?.interception && c?.ufoContact?.status === "engaging";
  }

  /** Pause + toast when a notable event appears versus the previously rendered snapshot. */
  private notifyCampaignEvent(): void {
    const snapshot = snapshotEvent(this.campaign);
    if (lastEventSnapshot !== null) {
      const info = detectEvent(lastEventSnapshot, this.campaign);
      if (info) {
        this.setTimeSpeed(0);
        this.showToast(info);
      }
    }
    lastEventSnapshot = snapshot;
  }

  /** Force pause whenever an overlay is up or the campaign is no longer active. */
  private refreshForcedPause(): void {
    if ((this.deploying || this.deployArrived) && this.timeSpeed !== 0) this.setTimeSpeed(0);
    else if (this.isEngaging() && this.timeSpeed !== 0) this.setTimeSpeed(0);
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
  }

  private refreshSpeedState(): void {
    const interactive =
      !!this.campaign &&
      this.campaign.strategic.status === "active" &&
      !this.isEngaging() &&
      !this.deploying &&
      !this.deployArrived;
    for (const btn of this.speedButtons) {
      const speed = Number(btn.dataset.speed);
      btn.setAttribute("aria-pressed", String(this.timeSpeed === speed));
      btn.disabled = !interactive;
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
    this.statsGrid.append(
      this.stat("Clock", formatCampaignClock(c.clock), "in-world date and time of day"),
      this.stat("Threat", `${c.strategic.threat}%`, "global X-COM threat — drives council panic"),
      this.stat("Funding", `${c.strategic.funding}`, "monthly council funding index"),
      this.stat("Cores", `${objective.completed}/${objective.required}`, "recovered UFO cores — campaign objective"),
      this.stat("Panic", `${panic.region} ${panic.panic}%`, "highest regional panic — a region at 100% defects"),
    );
  }

  private refreshNotice(): void {
    const notice = this.buildNotice();
    this.noticeSlot.replaceChildren(...(notice ? [notice] : []));
  }

  private refreshCards(): void {
    this.cardsSlot.replaceChildren();
    if (!this.campaign) return;
    this.cardsSlot.append(
      this.objectiveCard(),
      this.contactCard(),
      this.aircraftCard(),
      this.projectCard(),
      this.councilCard(),
      this.fundingCard(),
    );
  }

  /**
   * Rebuild the right-panel action row: reset, the Pause/1x/5x/30x speed controls
   * (replacing the legacy single Scan button), an Intercept affordance while a UFO
   * is tracked, and the persistent confirm button when no live contact blocks it.
   */
  private refreshActions(): void {
    this.actionsSlot.replaceChildren();
    this.speedButtons = [];
    const c = this.campaign;
    const reset = el("button");
    reset.textContent = c ? "New campaign" : "Reset";
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    this.actionsSlot.append(reset);
    if (!c) {
      this.actionsSlot.append(this.confirmButton);
      return;
    }
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
    this.actionsSlot.append(speedGroup);
    const can = canBuildNewBase(c);
    const build = el("button");
    build.textContent = this.buildMode ? "Cancel build" : `Build base (${NEW_BASE_COST.credits}c)`;
    build.disabled = !this.buildMode && !can.ok;
    build.title = this.buildMode ? "Exit base-placement mode" : can.ok ? "Designate a new radar base on the globe" : (can.reason ?? "Cannot build a new base right now");
    build.setAttribute("aria-pressed", String(this.buildMode));
    build.addEventListener("click", () => {
      this.buildMode = !this.buildMode;
      this.refresh();
    });
    this.actionsSlot.append(build);
    if (this.loitering) {
      // A Skyranger is on station: deploy on demand instead of offering a fresh
      // launch/intercept (the squad is already inbound to this site).
      const deploy = el("button", "primary");
      deploy.textContent = "Deploy squad";
      deploy.addEventListener("click", () => this.deploySquad());
      this.actionsSlot.append(deploy);
      return;
    }
    if (c.ufoContact?.status === "tracked") {
      const intercept = el("button", "primary");
      const forecast = interceptionForecast(c);
      intercept.textContent = isInterceptorReady(c)
        ? forecast?.risk === "dangerous"
          ? "Risk intercept"
          : "Intercept"
        : "Repairing";
      intercept.disabled = !canLaunchInterceptor(c);
      intercept.addEventListener("click", () => this.opts.onInterceptUfo());
      this.actionsSlot.append(intercept);
    }
    if (!c.ufoContact || c.ufoContact.status === "crashed") {
      this.actionsSlot.append(this.confirmButton);
    }
  }

  private refreshOverlay(): void {
    const overlay = this.deploying
      ? this.buildDeploymentOverlay()
      : this.deployArrived
        ? this.buildDeployChoiceOverlay()
        : null;
    this.overlaySlot.replaceChildren(...(overlay ? [overlay] : []));
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
      this.refreshUfoMarkerType(contact.missionType);
      this.placeUfoMarker(contact);
      this.refreshUfoTrail(contact);
    } else {
      this.ufoMarker.visible = false;
      this.clearUfoTrail();
    }
    this.refreshFlightMarkers();
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
   * slate transport for the Skyranger. Distinct from the engagement-only
   * interceptorMarker / skyrangerMarker (these fly during normal time-flow).
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

  private refreshUfoMarkerType(missionType: MissionType | undefined): void {
    if (this.ufoMissionType === missionType) return;
    this.ufoMissionType = missionType;
    for (const child of [...this.ufoMarker.children]) {
      this.ufoMarker.remove(child);
      if (child instanceof Mesh || child instanceof Line) {
        child.geometry.dispose();
        const material = child.material;
        if (Array.isArray(material)) for (const one of material) one.dispose();
        else material.dispose();
      }
    }
    this.buildUfoMarker(missionType);
  }

  /**
   * Show/hide the interceptor craft + trajectory and recompute the route every
   * refresh. The UFO flies while tracked/engaging, so its lat/lon (and thus the
   * engagement tangent + base->UFO arc) move tick by tick — re-reading the
   * contact each refresh is what makes the interceptor visibly chase it. A fresh
   * engagement still kicks off the launch flight via interceptorFlightStartMs.
   */
  private refreshInterceptor(): void {
    const c = this.campaign;
    const engaging = this.isEngaging();
    // A fresh engagement kicks off the launch flight (reset its clock); the frame
    // loop then flies the craft from base toward the UFO before range closing begins.
    if (engaging && !this.wasEngaging) {
      this.interceptorFlightStartMs = performance.now();
      this.resetContrails();
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
    this.interceptorRoute = { baseN, ufoN, contactId: contact.id };
    this.fillTrajectory(baseN, ufoN);
    this.interceptorMarker.visible = true;
    this.trajectoryLine.visible = true;
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

  /**
   * Advance the directional sun around the globe's polar axis from the campaign
   * clock, so one hemisphere is lit (day) and the opposite is dark (night). The
   * terminator sweeps as the clock advances. Phase is offset so campaign noon
   * (hour 12) lights the camera-facing side; the pre-campaign base screen sits
   * at full day for readability.
   */
  private updateTerminator(): void {
    // Fractional hours so the sun/terminator creeps minute-by-minute as time
    // flows (SPEED_TICKS advance fractional hours); integer `hour` would snap
    // the day/night line to whole-hour steps.
    const hour = this.campaign ? this.campaign.clock.elapsedHours % 24 : 12;
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
    // Launch flight (base -> engagement range) over ~1.3s, then hand off to the
    // range-driven closing slice so the player sees the craft fly out to the UFO.
    const flightT = Math.min(1, Math.max(0, (now - this.interceptorFlightStartMs) / INTERCEPTOR_FLIGHT_MS));
    const rangeArc =
      INTERCEPTOR_FLIGHT_END + (1 - encounter.range / ENCOUNTER_START_RANGE) * (1 - INTERCEPTOR_FLIGHT_END);
    const progress = flightT < 1 ? flightT * INTERCEPTOR_FLIGHT_END : Math.min(1, rangeArc);
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

  /** Crisp DOM layer above the canvas for floating "-N" damage numbers. */
  private buildDamageLayer(): void {
    const layer = el("div", "geo-damage-layer");
    this.canvasWrap.appendChild(layer);
    this.damageLayer = layer;
    // Persistent full-canvas red pulse, lit by flashThreat() when the interceptor is hit.
    const flash = el("div", "geo-threat-flash");
    this.canvasWrap.appendChild(flash);
    this.threatFlash = flash;
  }

  /**
   * Allocate the reusable interception combat-FX objects once and parent them to
   * earthGroup (so they share the globe's frame as the markers). All start hidden;
   * per-hit triggers reposition + reactivate them. Disposed via disposeObject(scene).
   */
  private buildCombatFx(): void {
    // Tracer beam: interceptor -> UFO (two-point additive line, faded per shot).
    const tracerGeo = new BufferGeometry();
    tracerGeo.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    this.tracerLineFx = new Line(
      tracerGeo,
      new LineBasicMaterial({ color: 0xfff7cc, transparent: true, opacity: 0, blending: AdditiveBlending }),
    );
    this.tracerLineFx.frustumCulled = false;
    this.tracerLineFx.visible = false;
    this.earthGroup.add(this.tracerLineFx);

    // Muzzle flash at the interceptor nose.
    this.muzzleFlash = new Mesh(
      new SphereGeometry(0.022, 10, 8),
      new MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0, blending: AdditiveBlending }),
    );
    this.muzzleFlash.visible = false;
    this.earthGroup.add(this.muzzleFlash);

    this.ufoBurst = this.makeBurst(0xfb923c, this.ufoBurstVel);
    this.interceptorBurst = this.makeBurst(0xfb7185, this.interceptorBurstVel);
    this.earthGroup.add(this.ufoBurst, this.interceptorBurst);

    // Larger explosion/debris burst for amplified dogfight impacts + the kill.
    this.explosionBurst = this.makeBurstN(0xfdba74, this.explosionBurstVel, EXPLOSION_PARTICLES, 0.05);
    this.earthGroup.add(this.explosionBurst);

    // Thruster contrails (ring-buffered Points) streaming behind each craft.
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

  /** Particle burst (additive Points) with deterministic precomputed spark directions. */
  private makeBurst(color: number, velocities: Float32Array): Points {
    return this.makeBurstN(color, velocities, BURST_PARTICLES, 0.03);
  }

  /** Sized variant of makeBurst for the larger dogfight explosion/debris burst. */
  private makeBurstN(color: number, velocities: Float32Array, count: number, size: number): Points {
    const positions = new Float32Array(count * 3);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    for (let i = 0; i < count; i++) {
      const ax = Math.sin(i * 52.13) * 43758.5453;
      const ay = Math.sin(i * 91.7) * 24634.6345;
      const az = Math.sin(i * 17.39) * 13579.1234;
      const dx = (ax - Math.floor(ax)) * 2 - 1;
      const dy = (ay - Math.floor(ay)) * 2 - 1;
      const dz = (az - Math.floor(az)) * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      velocities[i * 3] = dx / len;
      velocities[i * 3 + 1] = dy / len;
      velocities[i * 3 + 2] = dz / len;
    }
    const points = new Points(
      geo,
      new PointsMaterial({
        color,
        size,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        sizeAttenuation: true,
      }),
    );
    points.frustumCulled = false;
    points.visible = false;
    return points;
  }

  /**
   * Diff the encounter HP versus the previous render and fire combat FX for any
   * damage dealt. An "attack" round decreases both ufoHp (interceptor volley) and
   * interceptorHp (UFO return fire) in the same update, so both sides can light up
   * together. The terminal round resolves the encounter (clears `interception`),
   * so a just-resolved transition plays the finishing volley from prevUfoHp.
   */
  private detectEncounterDamage(): void {
    const enc = this.campaign?.interception;
    const engaging = this.isEngaging();
    if (engaging && enc) {
      if (this.prevUfoHp !== null && this.prevInterceptorHp !== null) {
        const ufoDmg = this.prevUfoHp - enc.ufoHp;
        const intDmg = this.prevInterceptorHp - enc.interceptorHp;
        if (ufoDmg > 0) this.triggerInterceptorVolley(ufoDmg);
        if (intDmg > 0) this.triggerInterceptorHit(intDmg);
      }
      this.prevUfoHp = enc.ufoHp;
      this.prevInterceptorHp = enc.interceptorHp;
      return;
    }
    // Encounter just resolved this update (was engaging, now cleared): play the
    // killing volley on the UFO using its last known HP as the finishing damage,
    // plus an amplified kill explosion + heavy shake for the cinematic finish.
    if (this.wasEngaging && this.prevUfoHp !== null && this.prevUfoHp > 0) {
      this.triggerInterceptorVolley(this.prevUfoHp);
      this.fireExplosion(this.ufoMarker.position, performance.now());
      this.kickCameraHard();
    }
    this.prevUfoHp = null;
    this.prevInterceptorHp = null;
  }

  /**
   * Interceptor deals damage to the UFO: a multi-round cannon volley (tracer +
   * bigger muzzle flash per round), an impact burst, and an amplified explosion/
   * debris burst at the UFO. The damage number floats once per volley; subsequent
   * rounds (scheduled in updateCombatFx) replay the tracer/muzzle/burst visuals.
   */
  private triggerInterceptorVolley(dmg: number): void {
    const now = performance.now();
    this.volleyDamageShown = false;
    this.volleyRounds = VOLLEY_ROUNDS - 1; // remaining rounds after this one
    this.volleyNextMs = now + VOLLEY_ROUND_MS;
    this.fireVolleyRound(dmg, now);
  }

  /** Fire one tracer round: interceptor muzzle → UFO impact + explosion burst. */
  private fireVolleyRound(dmg: number, now: number): void {
    const from = this.interceptorMarker.position;
    const to = this.ufoMarker.position;
    const attr = this.tracerLineFx.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    arr[0] = from.x; arr[1] = from.y; arr[2] = from.z;
    arr[3] = to.x; arr[4] = to.y; arr[5] = to.z;
    attr.needsUpdate = true;
    (this.tracerLineFx.material as LineBasicMaterial).opacity = 0.95;
    this.tracerLineFx.visible = true;
    this.fxTracerStartMs = now;
    this.fxTracerActive = true;

    // Bigger muzzle flash for the dogfight cannon.
    this.muzzleFlash.position.copy(from);
    (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1;
    this.muzzleFlash.scale.setScalar(1.9);
    this.muzzleFlash.visible = true;
    this.fxMuzzleStartMs = now;
    this.fxMuzzleActive = true;

    this.fireBurst(this.ufoBurst, to, now);
    this.fxUfoBurstActive = true;
    this.fireExplosion(to, now);
    if (!this.volleyDamageShown && dmg > 0) {
      this.spawnDamageNumber(this.ufoMarker, Math.round(dmg), "ufo");
      this.volleyDamageShown = true;
    }
    this.kickCamera();
  }

  /** Amplified explosion/debris burst at `pos` (larger particle count + wider spread). */
  private fireExplosion(pos: Vector3, now: number): void {
    this.fireBurst(this.explosionBurst, pos, now);
    this.fxExplosionActive = true;
  }

  /** UFO return fire hits the interceptor: impact burst + threat flash + shake. */
  private triggerInterceptorHit(dmg: number): void {
    this.fireBurst(this.interceptorBurst, this.interceptorMarker.position, performance.now());
    this.fxInterceptorBurstActive = true;
    this.spawnDamageNumber(this.interceptorMarker, Math.round(dmg), "interceptor");
    this.flashThreat();
    this.kickCamera();
  }

  /** Reset a burst to `pos` and arm it; particles radiate from local origin over FX_BURST_MS. */
  private fireBurst(burst: Points, pos: Vector3, now: number): void {
    const attr = burst.geometry.getAttribute("position") as Float32BufferAttribute;
    (attr.array as Float32Array).fill(0);
    attr.needsUpdate = true;
    burst.position.copy(pos);
    (burst.material as PointsMaterial).opacity = 1;
    burst.scale.setScalar(1);
    burst.visible = true;
    this.fxBurstStartMs = now;
  }

  /** Arm a decaying camera shake at standard magnitude (applied each frame). */
  private kickCamera(): void {
    this.shakeMagnitude = FX_SHAKE_MAGNITUDE;
    this.shakeStartMs = performance.now();
    this.shakeActive = true;
  }

  /** Heavier shake for kills / large explosions. */
  private kickCameraHard(): void {
    this.shakeMagnitude = FX_SHAKE_MAGNITUDE * 2.4;
    this.shakeStartMs = performance.now();
    this.shakeActive = true;
  }

  /** Pulse the "taking fire" threat overlay when the interceptor is hit. */
  private flashThreat(): void {
    if (!this.threatFlash) return;
    this.threatFlash.classList.add("active");
    if (this.threatFlashTimer !== undefined) window.clearTimeout(this.threatFlashTimer);
    this.threatFlashTimer = window.setTimeout(() => {
      this.threatFlash?.classList.remove("active");
    }, THREAT_FLASH_MS);
  }

  /** Flowing time: advance game hours on a timer scaled by the chosen speed. */
  private advanceFlowingTime(now: number): void {
    const speed = this.timeSpeed;
    if (
      speed <= 0 ||
      this.deploying ||
      this.deployArrived ||
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

  /** Advance every active combat effect one frame; deactivate each when it expires. */
  private updateCombatFx(now: number): void {
    if (this.fxTracerActive) {
      const t = (now - this.fxTracerStartMs) / FX_TRACER_MS;
      if (t >= 1) {
        this.fxTracerActive = false;
        this.tracerLineFx.visible = false;
      } else {
        (this.tracerLineFx.material as LineBasicMaterial).opacity = 0.95 * (1 - t);
      }
    }
    if (this.fxMuzzleActive) {
      const t = (now - this.fxMuzzleStartMs) / FX_MUZZLE_MS;
      if (t >= 1) {
        this.fxMuzzleActive = false;
        this.muzzleFlash.visible = false;
      } else {
        (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1 - t;
        this.muzzleFlash.scale.setScalar(1 + t * 1.8);
      }
    }
    // Both bursts share fxBurstStartMs (an exchange fires them together).
    this.fxUfoBurstActive = this.advanceBurst(this.ufoBurst, this.ufoBurstVel, BURST_PARTICLES, this.fxUfoBurstActive, now);
    this.fxInterceptorBurstActive = this.advanceBurst(
      this.interceptorBurst,
      this.interceptorBurstVel,
      BURST_PARTICLES,
      this.fxInterceptorBurstActive,
      now,
    );
    this.fxExplosionActive = this.advanceBurst(
      this.explosionBurst,
      this.explosionBurstVel,
      EXPLOSION_PARTICLES,
      this.fxExplosionActive,
      now,
    );
    // Multi-round volley: fire the next cannon round on the stagger schedule.
    if (this.volleyRounds > 0 && now >= this.volleyNextMs) {
      this.volleyRounds--;
      this.volleyNextMs = now + VOLLEY_ROUND_MS;
      if (this.isEngaging()) this.fireVolleyRound(0, now);
      else this.volleyRounds = 0;
    }
  }

  private advanceBurst(
    burst: Points,
    vel: Float32Array,
    count: number,
    active: boolean,
    now: number,
  ): boolean {
    if (!active) return false;
    const t = (now - this.fxBurstStartMs) / FX_BURST_MS;
    if (t >= 1) {
      burst.visible = false;
      return false;
    }
    const attr = burst.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    const spread = 0.05 * t;
    for (let i = 0; i < count; i++) {
      const vx = vel[i * 3] ?? 0;
      const vy = vel[i * 3 + 1] ?? 0;
      const vz = vel[i * 3 + 2] ?? 0;
      arr[i * 3] = vx * spread;
      arr[i * 3 + 1] = vy * spread;
      arr[i * 3 + 2] = vz * spread;
    }
    attr.needsUpdate = true;
    (burst.material as PointsMaterial).opacity = 1 - t;
    burst.scale.setScalar(1 + t * 0.6);
    return true;
  }

  /**
   * Offset the camera by a decaying tremor for the render only; the caller restores
   * the base position afterward so OrbitControls' internal state never drifts.
   */
  private applyCameraShake(now: number): void {
    if (!this.shakeActive) return;
    const t = (now - this.shakeStartMs) / FX_SHAKE_MS;
    if (t >= 1) {
      this.shakeActive = false;
      return;
    }
    const decay = 1 - t;
    // Deterministic sin-based jitter reads as a hit bump without per-frame randomness.
    // Skipped entirely under prefers-reduced-motion (screen shake is a classic trigger).
    if (this.reducedMotion) return;
    this.scratchA
      .set(Math.sin(now * 0.13), Math.sin(now * 0.091), Math.cos(now * 0.117))
      .normalize();
    this.camera.position.addScaledVector(this.scratchA, this.shakeMagnitude * decay);
  }

  /**
   * Stream thruster contrails behind the interceptor + UFO while an engagement is
   * live. Each frame one particle is emitted at each craft's world position
   * (converted into earthGroup-local space); per-vertex color fades the ring
   * bright (head) → dark (tail) so it reads as a glowing exhaust trail. Ring
   * buffers are pooled — no per-frame allocation. Trails are hidden outside combat.
   */
  private updateContrails(now: number): void {
    if (!this.isEngaging()) {
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
   * Project a marker's world position to screen space and float a "-N" damage chip
   * that removes itself after the CSS animation. Color is paired with the "UFO"/
   * "Interceptor" label context so the target is never conveyed by color alone.
   */
  private spawnDamageNumber(marker: Group, amount: number, kind: "ufo" | "interceptor"): void {
    if (!this.damageLayer || amount <= 0) return;
    marker.getWorldPosition(this.scratchProject);
    this.scratchProject.project(this.camera);
    const rect = this.canvasWrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = (this.scratchProject.x * 0.5 + 0.5) * rect.width;
    const y = (-this.scratchProject.y * 0.5 + 0.5) * rect.height;
    const node = el("div", `geo-dmg ${kind}`);
    node.textContent = `-${amount}`;
    node.style.left = `${x}px`;
    node.style.top = `${y}px`;
    this.damageLayer.appendChild(node);
    window.setTimeout(() => {
      node.remove();
    }, 950);
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

  /** Allocate the Skyranger transport marker + its base->site trajectory line once. */
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
    this.buildSkyrangerMarker();
    this.skyrangerMarker.visible = false;
    this.earthGroup.add(this.skyrangerMarker);
  }

  /**
   * Heavy-lift transport silhouette: a bulkier slate-green airframe with a green
   * cargo stripe accent, distinct from the cyan interceptor and amber base cone.
   * +Y is the nose (aligned by orientMarker along the travel tangent). The green
   * livery is paired with the "Skyranger / Deploying squad" text in the overlay.
   */
  private buildSkyrangerMarker(): void {
    const body = new MeshStandardMaterial({
      color: 0xe2e8f0,
      emissive: new Color(0x94a3b8),
      emissiveIntensity: 0.8,
      roughness: 0.4,
      metalness: 0.5,
    });
    const fuselage = new Mesh(new CylinderGeometry(0.014, 0.02, 0.2, 8), body);
    const nose = new Mesh(new ConeGeometry(0.014, 0.05, 8), body);
    nose.position.y = 0.125;
    const wingGeo = new BoxGeometry(0.1, 0.04, 0.007);
    const wingR = new Mesh(wingGeo, body);
    wingR.position.set(0.055, -0.02, 0);
    wingR.rotation.z = -0.35;
    const wingL = new Mesh(wingGeo, body);
    wingL.position.set(-0.055, -0.02, 0);
    wingL.rotation.z = 0.35;
    const tail = new Mesh(new BoxGeometry(0.05, 0.006, 0.006), body);
    tail.position.set(0, -0.09, 0);
    const fin = new Mesh(new BoxGeometry(0.006, 0.035, 0.02), body);
    fin.position.set(0, -0.075, 0.013);
    const stripe = new Mesh(
      new BoxGeometry(0.004, 0.16, 0.016),
      new MeshStandardMaterial({
        color: 0x4ade80,
        emissive: new Color(0x22c55e),
        emissiveIntensity: 1.2,
        roughness: 0.3,
        metalness: 0.3,
      }),
    );
    stripe.position.set(0, 0.01, 0.006);
    const ring = new Mesh(
      new RingGeometry(0.07, 0.095, 20),
      new MeshBasicMaterial({
        color: 0xbbf7d0,
        transparent: true,
        opacity: 0.45,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    this.skyrangerMarker.add(fuselage, nose, wingR, wingL, tail, fin, stripe, ring);
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
   * Stage the Skyranger deployment flight: fly a transport marker from the base to
   * the mission site along a great-circle arc over DEPLOYMENT_FLIGHT_MS with a
   * "Skyranger en route" overlay + trajectory line. On arrival the view shows a
   * Deploy/Wait choice: Deploy invokes `onDeployed` (-> battlescape); Wait drops
   * into a loiter so the player can deploy later (e.g. at dawn). Pauses time flow
   * for the inbound flight + the choice.
   */
  playDeploymentFlight(campaign: CampaignState, onDeployed: () => void): void {
    if (this.disposed) return;
    const contact = campaign.ufoContact;
    if (!contact) {
      onDeployed();
      return;
    }
    const baseN = latLonToVector(campaign.base.lat, campaign.base.lon, 1).normalize();
    const siteN = latLonToVector(contact.lat, contact.lon, 1).normalize();
    this.fillDeploymentTrajectory(baseN, siteN);
    this.deploymentLine.visible = true;
    this.skyrangerMarker.visible = true;
    this.deployArrived = false;
    this.loitering = false;
    this.preDeploySpeed = this.timeSpeed;
    this.deploying = true;
    this.setTimeSpeed(0);
    this.deploymentFlight = {
      baseN,
      siteN,
      region: contact.region,
      craftName: transportCraft(campaign)?.name ?? "Skyranger",
      startMs: performance.now(),
      onDeployed,
    };
    this.refreshOverlay();
  }

  /**
   * Advance the Skyranger along its arc. On arrival, surface a Deploy/Wait choice
   * (Deploy -> onDeployed -> battlescape; Wait -> loiter at the site with time
   * flowing). While loitering the transport holds at the site and a "Deploy squad"
   * button is offered from the actions panel; if the contact expires meanwhile the
   * loiter is abandoned back to normal time flow.
   */
  private updateDeployment(now: number): void {
    const dep = this.deploymentFlight;
    if (dep && this.deploying) {
      const t = Math.min(1, (now - dep.startMs) / DEPLOYMENT_FLIGHT_MS);
      slerpUnit(dep.baseN, dep.siteN, t, this.scratchA); // unit surface direction
      this.skyrangerMarker.position.copy(this.scratchA).multiplyScalar(EARTH_RADIUS + 0.16);
      this.orientMarker(this.skyrangerMarker, this.scratchA, dep.siteN);
      this.skyrangerMarker.scale.setScalar(1 + (this.reducedMotion ? 0 : Math.sin(now * 0.01) * 0.12));
      if (t >= 1) {
        this.deploying = false;
        this.showDeployChoice();
      }
      return;
    }
    if (dep && this.loitering) {
      // The site vanished while loitering (contact expired): abandon the loiter.
      if (!this.campaign?.ufoContact) {
        this.cancelLoiter();
        return;
      }
      // Hold at the site with a gentle hover; time flows so fuel burns / dawn breaks.
      this.skyrangerMarker.position.copy(dep.siteN).multiplyScalar(EARTH_RADIUS + 0.16);
      this.skyrangerMarker.scale.setScalar(1 + (this.reducedMotion ? 0 : Math.sin(now * 0.008) * 0.1));
    }
  }

  private buildDeploymentOverlay(): HTMLElement {
    const overlay = el("div", "geo-overlay geo-deploy");
    const panel = el("div", "geo-deploy-panel");
    const eye = el("div", "eyebrow");
    eye.textContent = `✈ ${this.deploymentFlight?.craftName ?? "Skyranger"} en route`;
    const heading = el("h2");
    heading.textContent = "Deploying squad";
    const copy = el("p");
    copy.textContent = `Inbound to ${this.deploymentFlight?.region ?? "mission site"}. Stand by for landing.`;
    panel.append(eye, heading, copy);
    overlay.append(panel);
    return overlay;
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
      `${fmtCoord(contact.lat, "N", "S")} / ${fmtCoord(contact.lon, "E", "W")} · ${remaining}h left`;
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
    card.append(badge, title, status, meta);
    return card;
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
      name.textContent = `${config.label} — threat ${config.startingThreat}%, foes ×${config.enemyCountMult}`;
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

  /**
   * Deploy/Wait choice shown when the Skyranger reaches the mission site. Deploy
   * hands off to `onDeployed` (-> battlescape at the current time-of-day); Wait
   * dismisses the choice and drops into a loiter so the player can deploy later
   * (e.g. at dawn) while time flows and fuel burns.
   */
  private buildDeployChoiceOverlay(): HTMLElement {
    const overlay = el("div", "geo-overlay geo-deploy");
    const panel = el("div", "geo-deploy-panel");
    const eye = el("div", "eyebrow");
    eye.textContent = `✈ ${this.deploymentFlight?.craftName ?? "Skyranger"} on station`;
    const heading = el("h2");
    heading.textContent = "Deploy squad?";
    const copy = el("p");
    copy.textContent = `Arrived at ${this.deploymentFlight?.region ?? "mission site"}. Deploy now or wait for daylight.`;
    const actions = el("div", "geo-deploy-actions");
    const wait = el("button");
    wait.textContent = "Wait";
    wait.addEventListener("click", () => this.waitAtSite());
    const deploy = el("button", "primary");
    deploy.textContent = "Deploy";
    deploy.addEventListener("click", () => this.deploySquad());
    actions.append(wait, deploy);
    panel.append(eye, heading, copy, actions);
    overlay.append(panel);
    return overlay;
  }

  /** Surface the Deploy/Wait choice on arrival; freeze time while the player decides. */
  private showDeployChoice(): void {
    this.deployArrived = true;
    this.setTimeSpeed(0);
    this.refreshOverlay();
  }

  /** Wait: dismiss the choice, loiter at the site, and resume time flow. */
  private waitAtSite(): void {
    this.deployArrived = false;
    this.loitering = true;
    this.setTimeSpeed(this.preDeploySpeed > 0 ? this.preDeploySpeed : 1);
    this.refreshOverlay();
  }

  /** Deploy now (from the choice or the loiter button): invoke onDeployed -> battlescape. */
  private deploySquad(): void {
    const dep = this.deploymentFlight;
    this.deployArrived = false;
    this.loitering = false;
    this.deploying = false;
    this.deploymentFlight = null;
    if (dep) dep.onDeployed(); // -> startTactical -> disposes this view mid-frame
  }

  /** Abandon a loiter when the contact vanishes: hide the transport, resume normal flow. */
  private cancelLoiter(): void {
    this.loitering = false;
    this.deployArrived = false;
    this.deploying = false;
    this.deploymentFlight = null;
    this.skyrangerMarker.visible = false;
    this.deploymentLine.visible = false;
    this.refresh();
  }

  private objectiveCard(): HTMLElement {
    const campaign = this.campaign!;
    const objective = campaignObjectiveProgress(campaign);
    const card = el("section", objective.status === "active" ? "geo-contact idle" : "geo-contact");
    const title = el("strong");
    title.textContent = `${objective.title} / ${objective.completed}/${objective.required}`;
    const copy = el("p");
    copy.textContent =
      `${objective.summary} Campaign progress ${objective.percent}%. ` +
      (objective.status === "active"
        ? "Intercept UFOs, recover crash sites, and keep council support alive."
        : "No further recovery operations are authorized.");
    card.append(title, copy);
    return card;
  }

  private aircraftCard(): HTMLElement {
    const campaign = this.campaign!;
    const card = el("section", "geo-contact idle");
    const title = el("strong");
    const copy = el("p");
    const repairedAt = campaign.interceptor.repairedAtHour;
    if (repairedAt && repairedAt > campaign.clock.elapsedHours) {
      title.textContent = `Interceptor repair / ${campaign.interceptor.damage}% damage`;
      copy.textContent =
        `${Math.max(0, repairedAt - campaign.clock.elapsedHours)}h until airborne. ` +
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
    const card = el("section", panic.panic >= 75 ? "geo-contact" : "geo-contact idle");
    const title = el("strong");
    const copy = el("p");
    title.textContent = `Council panic / ${panic.region} ${panic.panic}%`;
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
    const card = el("section", "geo-contact idle");
    const title = el("strong");
    const copy = el("p");
    if (report) {
      title.textContent = `Funding report ${report.reportNumber} / ${fmtNet(report.net)}c`;
      copy.textContent =
        `${report.summary} Current funding ${report.funding}c, threat ${report.threat}%, ` +
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
    const card = el("section", report ? "geo-contact" : "geo-contact idle");
    const title = el("strong");
    const copy = el("p");
    if (report) {
      title.textContent = `Project complete / ${report.title}`;
      copy.textContent = `${report.summary} Completed at campaign hour ${report.completedAtHour}.`;
    } else {
      title.textContent = "Project reports pending";
      copy.textContent = "Completed research, manufacturing, and construction reports will appear here.";
    }
    card.append(title, copy);
    return card;
  }

  private stat(label: string, value: string, hint?: string): HTMLElement {
    const node = el("div", "geo-stat");
    const span = el("span");
    span.textContent = label;
    const b = el("b");
    b.textContent = value;
    if (hint) node.title = `${label}: ${value} — ${hint}`;
    node.append(span, b);
    return node;
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

  private onPointerDown = (event: PointerEvent): void => {
    this.down = { x: event.clientX, y: event.clientY };
  };

  private onPointerUp = (event: PointerEvent): void => {
    if (!this.down) return;
    const dx = event.clientX - this.down.x;
    const dy = event.clientY - this.down.y;
    this.down = null;
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
      1 + (this.reducedMotion ? 0 : Math.sin(now * (urgent ? 0.012 : 0.006)) * (urgent ? 0.2 : 0.14)),
    );
    this.animateInterceptor(now);
    this.advanceFlowingTime(now);
    // onAdvanceTime may synchronously dispose+remount this view (current controller);
    // bail before touching the disposed renderer/controls in that case.
    if (this.disposed) return;
    this.updateDeployment(now);
    // Deployment arrival surfaces a Deploy/Wait choice (no dispose); Deploy later
    // invokes onDeployed -> startTactical from a click, which disposes this view.
    if (this.disposed) return;
    this.updateTerminator();
    this.updateCityLights();
    this.updateAtmosphere();
    if (this.cloudMesh) this.cloudMesh.rotation.y += 0.00018;
    this.controls.update();
    // Camera shake: offset around the controls-derived base, then restore so the
    // next controls.update() is unaffected (no drift into OrbitControls state).
    this.cameraBase.copy(this.camera.position);
    this.applyCameraShake(now);
    this.renderer.render(this.scene, this.camera);
    this.camera.position.copy(this.cameraBase);
  };
}
