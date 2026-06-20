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
import { campaignObjectiveProgress, DIFFICULTY_CONFIGS, highestRegionalPanic } from "../campaign/storage";
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
}

export interface GeoscapeTimeAction {
  label: string;
  hours: number;
  disabled: boolean;
}

const STYLE_ID = "blacksite-geoscape-style";
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

/** Interception combat-FX durations, in milliseconds. */
const FX_TRACER_MS = 200;
const FX_MUZZLE_MS = 130;
const FX_BURST_MS = 430;
const FX_SHAKE_MS = 240;
/** Camera shake magnitude (world units) at hit onset; decays over FX_SHAKE_MS. */
const FX_SHAKE_MAGNITUDE = 0.03;

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

/** Per-speed tick cadence: how many game hours advance, and how often, so time visibly flows. */
const SPEED_TICKS: Record<number, { hours: number; ms: number }> = {
  1: { hours: 1, ms: 700 },
  5: { hours: 3, ms: 400 },
  30: { hours: 6, ms: 160 },
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
#geoscape .geo-encounter {
  display: flex;
  flex-direction: column;
  width: min(520px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  padding: 18px;
  border: 1px solid rgba(251,113,133,.5);
  border-radius: 12px;
  background: linear-gradient(145deg, rgba(20,12,16,.96), rgba(4,8,12,.97));
  box-shadow: 0 30px 90px rgba(0,0,0,.55);
}
#geoscape .geo-encounter .eyebrow { color: #fb7185; }
#geoscape .geo-encounter h2 { color: #ffe4e6; }
#geoscape .geo-encounter-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 10px 0 4px;
  color: #fda4af;
  font: 700 10px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
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
#geoscape .geo-encounter-log {
  flex: 1;
  min-height: 80px;
  max-height: 168px;
  margin: 10px 0;
  padding: 8px 10px;
  overflow-y: auto;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 7px;
  background: rgba(0,0,0,.3);
  color: #a8c0d0;
  font: 600 10px/1.5 ui-monospace, monospace;
}
#geoscape .geo-encounter-log p { margin: 0 0 4px; color: #a8c0d0; }
#geoscape .geo-encounter-actions { display: flex; gap: 8px; }
#geoscape .geo-encounter-actions button { flex: 1; }
#geoscape .geo-overlay-host {
  position: absolute;
  inset: 0;
  z-index: 8;
  pointer-events: none;
}
#geoscape .geo-overlay-host .geo-overlay { pointer-events: auto; }
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
@media (max-width: 820px) {
  #geoscape .geo-panel { width: calc(100vw - 24px); padding: 13px; }
  #geoscape .geo-left { left: 12px; right: 12px; }
  #geoscape .geo-right { left: 12px; right: 12px; bottom: 12px; }
  #geoscape h1 { font-size: 30px; }
  #geoscape .geo-status { grid-template-columns: 1fr; }
  #geoscape .geo-hint { display: none; }
  #geoscape .geo-encounter { max-height: calc(100vh - 24px); }
  #geoscape .geo-encounter-log { max-height: 120px; }
  #geoscape .geo-actions { flex-wrap: wrap; }
  #geoscape .geo-speed-btn { min-height: 36px; }
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
  private selectedBase: BaseLocation | null;
  private selectedDifficulty: DifficultyLevel = "veteran";
  private encounterLog: HTMLElement | null = null;
  private raf = 0;
  private down: { x: number; y: number } | null = null;
  private disposed = false;

  /** Live campaign state; swapped in place by update() (mount never mutates it). */
  private campaign: CampaignState | null;
  /** Mission type the UFO marker was last built for (rebuilt only on change). */
  private ufoMissionType: MissionType | undefined;
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
  private readonly cameraBase = new Vector3();
  private damageLayer: HTMLDivElement | null = null;

  // --- Skyranger deployment flight (staged on mission launch) ---
  private deploying = false;
  private deploymentFlight: {
    baseN: Vector3;
    siteN: Vector3;
    region: string;
    startMs: number;
    arrived: boolean;
    onArrived: () => void;
  } | null = null;
  private readonly skyrangerMarker = new Group();
  private deploymentLine!: Line;
  private deploymentFill: HTMLDivElement | null = null;

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
    this.resize();
    // Surface the most recent engagement log line (the panel is rebuilt per action).
    if (this.encounterLog) this.encounterLog.scrollTop = this.encounterLog.scrollHeight;
    this.frame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.toastTimer !== undefined) window.clearTimeout(this.toastTimer);
    window.removeEventListener("resize", this.resize);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.root.remove();
    // Drop any in-flight deployment callback/state so a torn-down view can't fire it.
    this.deploymentFlight = null;
    this.deploying = false;
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
      new SphereGeometry(EARTH_RADIUS + 0.08, 64, 32),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.105,
        side: BackSide,
        blending: AdditiveBlending,
      }),
    );
    this.earthGroup.add(atmosphere);

    this.earthGroup.add(this.makeSignalNodes());
    for (let lat = -60; lat <= 60; lat += 30) this.earthGroup.add(makeLatLine(lat));
    for (let lon = -150; lon <= 180; lon += 30) this.earthGroup.add(makeLonLine(lon));
    this.buildBaseMarker();
    this.earthGroup.add(this.baseMarker);
    if (this.selectedBase) this.placeMarker(this.selectedBase);
    else this.baseMarker.visible = false;
    this.buildUfoMarker(this.opts.campaign?.ufoContact?.missionType);
    this.earthGroup.add(this.ufoMarker);
    if (this.opts.campaign?.ufoContact) this.placeUfoMarker(this.opts.campaign.ufoContact);
    else this.ufoMarker.visible = false;
    this.buildInterceptorMarker();
    this.interceptorMarker.visible = false;
    this.trajectoryLine.visible = false;
    this.earthGroup.add(this.trajectoryLine, this.interceptorMarker);

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

  /** City points: read as relay beacons on the day side and warm city lights on the dark night side. */
  private makeSignalNodes(): Points {
    const positions: number[] = [];
    for (const [lat, lon] of WORLD_CITY_POINTS) {
      const p = latLonToVector(lat, lon, EARTH_RADIUS + 0.034);
      positions.push(p.x, p.y, p.z);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new Points(
      geometry,
      new PointsMaterial({
        color: 0xfcd34d,
        size: 0.014,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
      }),
    );
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
    hint.textContent = this.opts.campaign
      ? "Time controls scan the globe / intercept UFOs / launch recovery from base"
      : "Drag to rotate / wheel to zoom / click Earth to designate base";
    this.root.appendChild(hint);
    const overlaySlot = el("div", "geo-overlay-host");
    this.root.appendChild(overlaySlot);
    const toast = el("div", "geo-toast");
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    this.root.appendChild(toast);
    return { region, coords, confirm, statsGrid, noticeSlot, cardsSlot, actionsSlot, overlaySlot, toast };
  }

  /**
   * Re-render every dynamic panel, marker, and the time-control state in place.
   * Called from the constructor (first render) and from update(). Never disposes
   * or rebuilds the three.js scene — only moves markers and refreshes DOM text.
   */
  private refresh(): void {
    // Detect HP deltas before refreshInterceptor updates wasEngaging, so a
    // resolving encounter still reads the previous engaging state.
    this.detectEncounterDamage();
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
    if (this.encounterLog) this.encounterLog.scrollTop = this.encounterLog.scrollHeight;
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

  /** Force pause whenever the overlay is up or the campaign is no longer active. */
  private refreshForcedPause(): void {
    if (this.deploying && this.timeSpeed !== 0) this.setTimeSpeed(0);
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
      !this.deploying;
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
      this.stat("Clock", formatCampaignClock(c.clock)),
      this.stat("Threat", `${c.strategic.threat}%`),
      this.stat("Funding", `${c.strategic.funding}`),
      this.stat("Cores", `${objective.completed}/${objective.required}`),
      this.stat("Panic", `${panic.region} ${panic.panic}%`),
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
      btn.setAttribute("aria-pressed", String(this.timeSpeed === option.speed));
      btn.addEventListener("click", () => this.setTimeSpeed(option.speed));
      speedGroup.append(btn);
      this.speedButtons.push(btn);
    }
    this.actionsSlot.append(speedGroup);
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
    const encounter = this.buildInterceptionOverlay();
    const deploy = this.deploying ? this.buildDeploymentOverlay() : null;
    this.overlaySlot.replaceChildren(
      ...(encounter ? [encounter] : []),
      ...(deploy ? [deploy] : []),
    );
  }

  /** Reposition the base + UFO markers; rebuild the UFO marker when its mission type changes. */
  private refreshMarkers(): void {
    const c = this.campaign;
    if (c?.base) this.placeMarker(c.base);
    else this.baseMarker.visible = false;
    const contact = c?.ufoContact;
    if (contact) {
      this.refreshUfoMarkerType(contact.missionType);
      this.placeUfoMarker(contact);
    } else {
      this.ufoMarker.visible = false;
    }
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

  /** Show/hide the interceptor craft + trajectory and cache the route when a target changes. */
  private refreshInterceptor(): void {
    const c = this.campaign;
    const engaging = this.isEngaging();
    // A fresh engagement kicks off the launch flight (reset its clock); the frame
    // loop then flies the craft from base toward the UFO before range closing begins.
    if (engaging && !this.wasEngaging) this.interceptorFlightStartMs = performance.now();
    this.wasEngaging = engaging;
    if (!engaging || !c?.ufoContact || !c.base) {
      this.interceptorMarker.visible = false;
      this.trajectoryLine.visible = false;
      this.interceptorRoute = null;
      return;
    }
    const contact = c.ufoContact;
    if (!this.interceptorRoute || this.interceptorRoute.contactId !== contact.id) {
      const baseN = latLonToVector(c.base.lat, c.base.lon, 1).normalize();
      const ufoN = latLonToVector(contact.lat, contact.lon, 1).normalize();
      this.interceptorRoute = { baseN, ufoN, contactId: contact.id };
      this.fillTrajectory(baseN, ufoN);
    }
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
    const hour = this.campaign ? this.campaign.clock.hour : 12;
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
    this.interceptorMarker.scale.setScalar(1 + Math.sin(now * 0.012) * 0.18);
  }

  /** Crisp DOM layer above the canvas for floating "-N" damage numbers. */
  private buildDamageLayer(): void {
    const layer = el("div", "geo-damage-layer");
    this.canvasWrap.appendChild(layer);
    this.damageLayer = layer;
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
  }

  /** Particle burst (additive Points) with deterministic precomputed spark directions. */
  private makeBurst(color: number, velocities: Float32Array): Points {
    const positions = new Float32Array(BURST_PARTICLES * 3);
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    for (let i = 0; i < BURST_PARTICLES; i++) {
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
        size: 0.03,
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
    // killing volley on the UFO using its last known HP as the finishing damage.
    if (this.wasEngaging && this.prevUfoHp !== null && this.prevUfoHp > 0) {
      this.triggerInterceptorVolley(this.prevUfoHp);
    }
    this.prevUfoHp = null;
    this.prevInterceptorHp = null;
  }

  /** Interceptor deals damage to the UFO: muzzle flash + tracer + UFO impact burst. */
  private triggerInterceptorVolley(dmg: number): void {
    const now = performance.now();
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

    this.muzzleFlash.position.copy(from);
    (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1;
    this.muzzleFlash.scale.setScalar(1);
    this.muzzleFlash.visible = true;
    this.fxMuzzleStartMs = now;
    this.fxMuzzleActive = true;

    this.fireBurst(this.ufoBurst, to, now);
    this.fxUfoBurstActive = true;
    this.spawnDamageNumber(this.ufoMarker, Math.round(dmg), "ufo");
    this.kickCamera();
  }

  /** UFO return fire hits the interceptor: impact burst at the interceptor marker. */
  private triggerInterceptorHit(dmg: number): void {
    this.fireBurst(this.interceptorBurst, this.interceptorMarker.position, performance.now());
    this.fxInterceptorBurstActive = true;
    this.spawnDamageNumber(this.interceptorMarker, Math.round(dmg), "interceptor");
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

  /** Arm a decaying camera shake (applied around the controls base each frame). */
  private kickCamera(): void {
    this.shakeStartMs = performance.now();
    this.shakeActive = true;
  }

  /** Flowing time: advance game hours on a timer scaled by the chosen speed. */
  private advanceFlowingTime(now: number): void {
    const speed = this.timeSpeed;
    if (
      speed <= 0 ||
      this.deploying ||
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
    this.fxUfoBurstActive = this.advanceBurst(this.ufoBurst, this.ufoBurstVel, this.fxUfoBurstActive, now);
    this.fxInterceptorBurstActive = this.advanceBurst(
      this.interceptorBurst,
      this.interceptorBurstVel,
      this.fxInterceptorBurstActive,
      now,
    );
  }

  private advanceBurst(burst: Points, vel: Float32Array, active: boolean, now: number): boolean {
    if (!active) return false;
    const t = (now - this.fxBurstStartMs) / FX_BURST_MS;
    if (t >= 1) {
      burst.visible = false;
      return false;
    }
    const attr = burst.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    const spread = 0.05 * t;
    for (let i = 0; i < BURST_PARTICLES; i++) {
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
    this.scratchA
      .set(Math.sin(now * 0.13), Math.sin(now * 0.091), Math.cos(now * 0.117))
      .normalize();
    this.camera.position.addScaledVector(this.scratchA, FX_SHAKE_MAGNITUDE * decay);
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
   * the mission site along a great-circle arc over DEPLOYMENT_FLIGHT_MS, show a
   * "Deploying squad" overlay + trajectory line, then invoke onArrived (which the
   * controller routes into the battlescape). Pauses time flow for the duration.
   */
  playDeploymentFlight(campaign: CampaignState, onArrived: () => void): void {
    if (this.disposed) return;
    const contact = campaign.ufoContact;
    if (!contact) {
      onArrived();
      return;
    }
    const baseN = latLonToVector(campaign.base.lat, campaign.base.lon, 1).normalize();
    const siteN = latLonToVector(contact.lat, contact.lon, 1).normalize();
    this.fillDeploymentTrajectory(baseN, siteN);
    this.deploymentLine.visible = true;
    this.skyrangerMarker.visible = true;
    this.deploying = true;
    this.setTimeSpeed(0);
    this.deploymentFlight = {
      baseN,
      siteN,
      region: contact.region,
      startMs: performance.now(),
      arrived: false,
      onArrived,
    };
    this.refreshOverlay();
  }

  /** Advance the Skyranger along its arc; on arrival, hand off to onArrived once. */
  private updateDeployment(now: number): void {
    const dep = this.deploymentFlight;
    if (!dep || !this.deploying) return;
    const t = Math.min(1, (now - dep.startMs) / DEPLOYMENT_FLIGHT_MS);
    slerpUnit(dep.baseN, dep.siteN, t, this.scratchA); // unit surface direction
    this.skyrangerMarker.position.copy(this.scratchA).multiplyScalar(EARTH_RADIUS + 0.16);
    this.orientMarker(this.skyrangerMarker, this.scratchA, dep.siteN);
    this.skyrangerMarker.scale.setScalar(1 + Math.sin(now * 0.01) * 0.12);
    if (this.deploymentFill) this.deploymentFill.style.width = `${Math.round(t * 100)}%`;
    if (t >= 1 && !dep.arrived) {
      dep.arrived = true;
      this.deploying = false;
      this.deploymentFlight = null;
      dep.onArrived(); // -> startTactical -> disposes this view mid-frame
    }
  }

  private buildDeploymentOverlay(): HTMLElement {
    const overlay = el("div", "geo-overlay geo-deploy");
    const panel = el("div", "geo-deploy-panel");
    const eye = el("div", "eyebrow");
    eye.textContent = "✈ Skyranger en route";
    const heading = el("h2");
    heading.textContent = "Deploying squad";
    const copy = el("p");
    copy.textContent = `Inbound to ${this.deploymentFlight?.region ?? "mission site"}. Stand by for landing.`;
    const bar = el("div", "geo-bar");
    const track = el("div", "geo-bar-track");
    const fill = el("div", "geo-bar-fill interceptor");
    fill.style.width = "0%";
    track.append(fill);
    bar.append(track);
    panel.append(eye, heading, copy, bar);
    overlay.append(panel);
    this.deploymentFill = fill;
    return overlay;
  }

  /** Concise contact card: id, status instruction, region, time-left. Drops the prose. */
  private contactCard(): HTMLElement {
    const contact = this.campaign?.ufoContact;
    const card = el("section", `geo-contact ${contact ? "" : "idle"}`.trim());
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
    // missionTypeInfo still drives the marker icon/color/urgent styling.
    const badgeInfo: MissionTypeInfo = { ...info, label: this.contactBadgeLabel(contact) };
    card.append(this.missionBadge(badgeInfo), title, status, meta);
    return card;
  }

  /**
   * Instructional status label. A tracked (airborne) UFO is NEVER "Crash site" —
   * it reads as airborne with an intercept prompt. Only a crashed contact reads
   * as a crash site (launch assault).
   */
  private contactStatusLabel(contact: UfoContact): string {
    switch (contact.status) {
      case "engaging":
        return "Engaging — stand by";
      case "crashed":
        return "Crash site — launch assault";
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
   * (tracked/engaging) UFO reads "Airborne UFO", and "Crash site" appears only
   * once the contact is actually down.
   */
  private contactBadgeLabel(contact: UfoContact): string {
    switch (contact.status) {
      case "crashed":
        return "Crash site";
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

  /** Modal interception overlay; rendered only while an encounter is in progress. */
  private buildInterceptionOverlay(): HTMLElement | null {
    const encounter = this.campaign?.interception;
    if (!encounter) return null;
    const overlay = el("div", "geo-overlay");
    const panel = el("div", "geo-encounter");
    const eye = el("div", "eyebrow");
    eye.textContent = "Interception encounter";
    const heading = el("h2");
    heading.textContent = `${encounter.contactId} engagement`;
    const meta = el("div", "geo-encounter-meta");
    const range = el("span");
    range.textContent = `Range ${encounter.range}`;
    const rounds = el("span");
    rounds.textContent = `Round ${encounter.roundsElapsed + 1}`;
    meta.append(range, rounds);
    const log = el("div", "geo-encounter-log");
    for (const line of encounter.log) {
      const entry = el("p");
      entry.textContent = line;
      log.append(entry);
    }
    this.encounterLog = log;
    const actions = el("div", "geo-encounter-actions");
    actions.append(
      this.encounterButton("Close", "close"),
      this.encounterButton("Attack", "attack", true),
      this.encounterButton("Disengage", "disengage"),
    );
    panel.append(
      eye,
      heading,
      meta,
      this.hpBar("UFO", encounter.ufoHp, encounter.ufoHpMax, "ufo"),
      this.hpBar("Interceptor", encounter.interceptorHp, encounter.interceptorHpMax, "interceptor"),
      log,
      actions,
    );
    overlay.append(panel);
    return overlay;
  }

  private encounterButton(label: string, action: InterceptionAction, primary = false): HTMLButtonElement {
    const button = el("button", primary ? "primary" : undefined);
    button.textContent = label;
    button.addEventListener("click", () => this.opts.onInterceptionAction?.(action));
    return button;
  }

  private hpBar(label: string, hp: number, hpMax: number, variant: "ufo" | "interceptor"): HTMLElement {
    const wrap = el("div", "geo-bar");
    const labelRow = el("div", "geo-bar-label");
    const name = el("span");
    name.textContent = label;
    const value = el("span");
    value.textContent = `${Math.max(0, Math.floor(hp))}/${hpMax}`;
    labelRow.append(name, value);
    const track = el("div", "geo-bar-track");
    const fill = el("div", `geo-bar-fill ${variant}`);
    const pct = hpMax > 0 ? Math.max(0, Math.min(100, (hp / hpMax) * 100)) : 0;
    fill.style.width = `${pct}%`;
    track.append(fill);
    wrap.append(labelRow, track);
    return wrap;
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

  private stat(label: string, value: string): HTMLElement {
    const node = el("div", "geo-stat");
    const span = el("span");
    span.textContent = label;
    const b = el("b");
    b.textContent = value;
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
    this.baseMarker.scale.setScalar(1 + Math.sin(now * 0.004) * 0.08);
    const contact = this.campaign?.ufoContact;
    const urgent = contact ? missionTypeInfo(contact.missionType).urgent : false;
    // Urgent contacts (terror / base defense) pulse faster and harder so they
    // read as higher priority against the steady crash-site markers.
    this.ufoMarker.scale.setScalar(1 + Math.sin(now * (urgent ? 0.012 : 0.006)) * (urgent ? 0.2 : 0.14));
    this.animateInterceptor(now);
    this.advanceFlowingTime(now);
    // onAdvanceTime may synchronously dispose+remount this view (current controller);
    // bail before touching the disposed renderer/controls in that case.
    if (this.disposed) return;
    this.updateCombatFx(now);
    this.updateDeployment(now);
    // Deployment arrival hands control back to main.ts (startTactical), which
    // disposes this view mid-frame; bail before rendering a torn-down scene.
    if (this.disposed) return;
    this.updateTerminator();
    this.controls.update();
    // Camera shake: offset around the controls-derived base, then restore so the
    // next controls.update() is unaffected (no drift into OrbitControls state).
    this.cameraBase.copy(this.camera.position);
    this.applyCameraShake(now);
    this.renderer.render(this.scene, this.camera);
    this.camera.position.copy(this.cameraBase);
  };
}
