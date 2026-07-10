import {
  ACESFilmicToneMapping,
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
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  Quaternion,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  WebGLRenderer,
} from "three";
import type { CampaignState, InterceptionEncounter } from "../campaign/types";
import {
  type InterceptionAction,
  type InterceptionOutcome,
  ufoTypeInfo,
  ENGAGEMENT_RANGE_KM,
  POINT_BLANK_KM,
  CLOSE_STEP_KM,
  EVADE_STEP_KM,
} from "../campaign/geoscape";
import { type AirWeapon, airWeapon } from "../campaign/airWeapons";
import { UI_TOKENS, UI_BASE, UI_COMPONENTS, UI_PRIMITIVES } from "./uiTheme";
import { ratioToPercent } from "./uiFormat";

/**
 * Sealed, self-contained 3D dogfight screen (NOT the geoscape) — THE ZOOM. Mounted
 * once pursuit closes to <= ENGAGEMENT_RANGE_KM. Mirrors the classic X-COM
 * interception interface (interceptor + UFO on a dark space stage, HP bars, a
 * scrolling combat log) but replaces the old abstract Long/Medium/Short/Point-blank
 * band + single "Attack" button with the real weapon model: one fire button PER
 * carried weapon (missiles + cannon), each gated by its own km range and ammo pool,
 * a live km range readout, lock-on tension for heavy ordnance, and a hit/miss reveal
 * (UFO evasion) rather than a guaranteed exchange. Craft shapes are copied from
 * geoscape's buildInterceptorMarker/buildUfoMarker (no import) and rescaled for the
 * stage. Pure presentation: all combat math lives in campaign/geoscape.ts.
 */

/** Interception combat-FX durations, in milliseconds. */
const FX_MUZZLE_MS = 150;
const FX_BURST_MS = 460;
const FX_EXPLOSION_MS = 720;
const FX_VAPORIZE_MS = 900;
const FX_SHAKE_MS = 260;
/** Camera shake magnitude (world units) at hit onset; decays over FX_SHAKE_MS. */
const FX_SHAKE_MAGNITUDE = 0.035;
/** Multiplier on shake magnitude for the killing blow. */
const FX_SHAKE_KILL_MULT = 2.4;
/** Ms the kill explosion plays before onResolve returns the player to the geoscape. */
const RESOLVE_DELAY_MS = 950;
/** Ms the "Disengaged"/"Broke off" overlay shows before onResolve (no kill FX to wait for). */
const RESOLVE_DISENGAGE_DELAY_MS = 550;
/** Ms an evasion MISS reveal holds before the beam/dodge FX clears. */
const FX_MISS_MS = 520;
/** Fade time for a beam shown with no travel tween (reducedMotion — see fireShot). */
const FX_BEAM_STATIC_MS = 260;
/** Duration of a close / evasive-break banking beat. */
const FX_MANEUVER_MS = 720;

/** Missile/cannon travel time by weapon class (ms) — heavy telegraphs, cannon is instant. */
const TRAVEL_MS: Record<AirWeapon["cls"], number> = { heavy: 900, light: 560, cannon: 160 };

/** Pooled particle counts (ring/velocity buffers sized to these at build time). */
const BURST_PARTICLES = 22;
const EXPLOSION_PARTICLES = 34;
/** Deterministic starfield point count for the deep-space backdrop. */
const STAR_COUNT = 640;

/** Stage separation between the two craft at max engagement range (world units). */
const SEPARATION_FAR = 3.4;
/** Stage separation between the two craft at point-blank range. */
const SEPARATION_CLOSE = 1.15;
/** Radius of the slow dramatic camera orbit around the engagement midpoint. */
const CAMERA_ORBIT_RADIUS = 3.0;
/** Height of the orbiting camera above the engagement midpoint. */
const CAMERA_ORBIT_HEIGHT = 1.1;
/** Radians per second the camera orbits (slow, for drama). Frozen under reducedMotion. */
const CAMERA_ORBIT_RATE = 0.12;
/** Camera field of view (deg). Wider frames both craft large at close orbit. */
const CAMERA_FOV = 58;

const STYLE_ID = "plane-combat-style";

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/** Separation between the two craft derived from the current engagement range (km). */
function separationForKm(rangeKm: number): number {
  const span = Math.max(1, ENGAGEMENT_RANGE_KM - POINT_BLANK_KM);
  const t = 1 - clamp01((rangeKm - POINT_BLANK_KM) / span);
  return SEPARATION_FAR + (SEPARATION_CLOSE - SEPARATION_FAR) * t;
}

/** Display glyph + label per weapon class. */
function weaponBadge(cls: AirWeapon["cls"]): { icon: string; label: string } {
  switch (cls) {
    case "heavy":
      return { icon: "✦", label: "Heavy missile" };
    case "light":
      return { icon: "◇", label: "Light missile" };
    case "cannon":
      return { icon: "≡", label: "Cannon" };
  }
}

/**
 * Screen-specific rules. Prepended with the shared Track 2 layers (tokens + base
 * affordances + component/primitive classes) so this screen reads as one system
 * with the HUD / base / geoscape. Every color/size traces to a `--ui-*` token; the
 * panels use the console-glass primitive surface and the action buttons use the
 * shared `.ui-btn` / `.ui-btn--danger` tiers.
 */
const PLANE_CSS = `
#plane-combat {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: var(--ui-text);
  background:
    radial-gradient(circle at 50% 38%, #0a1220 0, #070d16 46%, #04070d 100%);
  font-family: var(--ui-font-ui);
  font-size: var(--ui-text-sm);
  line-height: var(--ui-leading);
  letter-spacing: .02em;
}
#plane-combat canvas { width: 100%; height: 100%; display: block; }
#plane-combat .pc-canvas { position: absolute; inset: 0; }
#plane-combat::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    radial-gradient(circle at 71% 56%, transparent 0 13.8%, rgba(103,232,249,.11) 14%, transparent 14.3% 27.8%, rgba(103,232,249,.075) 28%, transparent 28.3% 41.8%, rgba(103,232,249,.045) 42%, transparent 42.3%),
    linear-gradient(90deg, rgba(56,232,210,.04) 1px, transparent 1px),
    linear-gradient(rgba(56,232,210,.03) 1px, transparent 1px),
    radial-gradient(circle at 50% 50%, transparent 55%, rgba(0,0,0,.55) 100%);
  background-size: auto, 44px 44px, 44px 44px, auto;
  mix-blend-mode: screen;
}
#plane-combat .pc-alarm {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;
  opacity: 0;
  box-shadow: inset 0 0 0 3px rgba(255,74,58,.55), inset 0 0 90px rgba(255,74,58,.28);
  transition: opacity .3s;
}
#plane-combat .pc-alarm.active { opacity: 1; }
#plane-combat .pc-alarm.active.pc-anim-pulse { animation: pc-alarm-pulse 1.1s ease-in-out infinite; }
@keyframes pc-alarm-pulse {
  0%, 100% { opacity: .45; }
  50% { opacity: 1; }
}
#plane-combat .pc-panel {
  position: absolute;
  z-index: 4;
  display: flex;
  flex-direction: column;
  width: min(460px, calc(100vw - 28px));
  padding: var(--ui-sp-4);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
#plane-combat .pc-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 38%;
  height: 2px;
  background: linear-gradient(90deg, var(--ui-red), transparent);
}
#plane-combat .pc-left {
  top: max(18px, env(safe-area-inset-top));
  left: max(18px, env(safe-area-inset-left));
}
#plane-combat .pc-bottom {
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
}
#plane-combat .eyebrow {
  color: var(--ui-red);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 800;
  letter-spacing: .18em;
  text-transform: uppercase;
}
#plane-combat h2 {
  margin: 6px 0 10px;
  font-size: var(--ui-text-xl);
  line-height: var(--ui-leading-tight);
  letter-spacing: .04em;
  color: #ffe4e6;
}
#plane-combat .pc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0 0 4px;
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#plane-combat .pc-meta b { color: var(--ui-text); font-weight: 800; }
#plane-combat .pc-range {
  margin: 10px 0 4px;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#plane-combat .pc-range-num { font-size: var(--ui-text-xl); color: var(--ui-cyan); font-weight: 800; letter-spacing: .02em; }
#plane-combat .pc-range-num span { font-size: var(--ui-text-xs); color: var(--ui-muted); margin-left: 2px; }
#plane-combat .pc-range-rate { font-size: var(--ui-text-xs); }
#plane-combat .pc-range-rate.opening { color: var(--ui-red); }
#plane-combat .pc-range-track {
  position: relative;
  height: 10px;
  margin-top: 6px;
  border: 1px solid rgba(56,232,210,.22);
  border-radius: 5px;
  background: rgba(56,232,210,.07);
  overflow: visible;
}
#plane-combat .pc-range-fill {
  height: 100%;
  border-radius: 5px;
  background: linear-gradient(90deg, #22d3ee, var(--ui-cyan));
  box-shadow: 0 0 10px rgba(103,232,249,.5);
  transition: width .2s;
}
#plane-combat .pc-range-tick {
  position: absolute;
  top: -3px;
  width: 2px;
  height: 16px;
  background: var(--ui-dim);
  opacity: .6;
}
#plane-combat .pc-range-tick.in-range { background: var(--ui-amber); opacity: 1; }
#plane-combat .pc-bar { margin: 8px 0; }
#plane-combat .pc-bar-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 700;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#plane-combat .pc-bar-label b { color: var(--ui-text); font-weight: 800; font-variant-numeric: tabular-nums; }
#plane-combat .pc-bar-track {
  height: 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-pill);
  background: rgba(255,255,255,.06);
  overflow: hidden;
}
#plane-combat .pc-bar-fill {
  height: 100%;
  border-radius: var(--ui-radius-pill);
  transition: width .25s;
}
#plane-combat .pc-bar-fill.ufo { background: linear-gradient(90deg, var(--ui-red), #f43f5e); }
#plane-combat .pc-bar-fill.interceptor { background: linear-gradient(90deg, var(--ui-cyan), #22d3ee); }
#plane-combat .pc-weapons { display: flex; flex-direction: column; gap: 6px; margin: 10px 0 4px; }
#plane-combat .pc-weapon {
  position: relative;
  display: flex;
  align-items: center;
  gap: var(--ui-sp-2);
  padding: 6px 8px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: rgba(4,7,13,.35);
}
#plane-combat .pc-weapon.locking { border-color: var(--ui-amber); }
#plane-combat .pc-weapon.locking.pc-anim-pulse { animation: pc-lock-pulse 1s ease-in-out infinite; }
@keyframes pc-lock-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(251,191,36,0); }
  50% { box-shadow: 0 0 8px 1px rgba(251,191,36,.55); }
}
#plane-combat .pc-weapon-icon { font-size: var(--ui-text-lg); color: var(--ui-cyan); width: 20px; text-align: center; }
#plane-combat .pc-weapon-info { flex: 1; min-width: 0; }
#plane-combat .pc-weapon-name {
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  font-weight: 800;
  color: var(--ui-text);
  letter-spacing: .02em;
}
#plane-combat .pc-weapon-meta {
  display: flex;
  gap: 8px;
  margin-top: 2px;
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  letter-spacing: .06em;
  text-transform: uppercase;
}
#plane-combat .pc-weapon-meta .danger { color: var(--ui-red); }
#plane-combat .pc-weapon-fire {
  min-width: 92px;
  padding: 6px 10px;
  font-size: var(--ui-text-xs);
}
#plane-combat .pc-log {
  flex: 1;
  min-height: 60px;
  max-height: 130px;
  margin: 10px 0;
  padding: 8px 10px;
  overflow-y: auto;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: rgba(4,7,13,.5);
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  line-height: 1.45;
}
#plane-combat .pc-log p { margin: 0 0 4px; }
#plane-combat .pc-log p.miss { color: var(--ui-red); font-weight: 700; }
#plane-combat .pc-log p.defensive { color: var(--ui-green); font-weight: 700; }
#plane-combat .pc-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--ui-sp-2);
}
#plane-combat .pc-actions button { min-width: 0; }
#plane-combat .pc-actions .pc-disengage { grid-column: 1 / -1; }
#plane-combat .pc-evade.armed {
  border-color: var(--ui-green);
  color: #bbf7d0;
  background: rgba(20,83,45,.34);
  box-shadow: 0 0 14px rgba(74,222,128,.16);
}
#plane-combat .pc-titlebar {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  padding: 8px 16px;
  border: 1px solid rgba(251,113,133,.4);
  border-radius: var(--ui-radius-pill);
  background: var(--ui-panel-glass);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: #ffe4e6;
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 800;
  letter-spacing: .18em;
  text-transform: uppercase;
  white-space: nowrap;
}
#plane-combat .pc-miss-flag {
  position: absolute;
  top: 44%;
  right: max(24px, env(safe-area-inset-right));
  z-index: 5;
  padding: 6px 14px;
  border: 1px solid var(--ui-red);
  border-radius: var(--ui-radius-sm);
  background: rgba(20,4,6,.7);
  color: var(--ui-red);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-lg);
  font-weight: 800;
  letter-spacing: .12em;
  text-transform: uppercase;
  opacity: 0;
  transition: opacity .18s;
  pointer-events: none;
}
#plane-combat .pc-miss-flag.active { opacity: 1; }
#plane-combat .pc-resolve {
  position: absolute;
  inset: 0;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  opacity: 0;
  transition: opacity .2s;
  background: radial-gradient(circle at 50% 50%, rgba(255,74,58,.16), transparent 60%);
}
#plane-combat .pc-resolve.active { opacity: 1; }
#plane-combat .pc-resolve .pc-resolve-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  padding: 14px 30px;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius);
  background: var(--ui-panel-glass);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
}
#plane-combat .pc-resolve b {
  color: #ffe4e6;
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-2xl);
  font-weight: 800;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#plane-combat .pc-resolve span {
  color: var(--ui-muted);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  letter-spacing: .06em;
  text-transform: uppercase;
}
#plane-combat .pc-help {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  right: max(18px, env(safe-area-inset-right));
  z-index: 5;
  min-width: 38px;
  min-height: 38px;
  padding: 0;
  border-radius: var(--ui-radius-sm);
  border: 1px solid var(--ui-border-strong);
  color: var(--ui-cyan);
  background: var(--ui-panel-glass);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-lg);
  font-weight: 800;
  cursor: pointer;
  box-shadow: var(--ui-shadow-sm);
  transition: border-color var(--ui-fast) var(--ui-ease), background var(--ui-fast) var(--ui-ease);
}
#plane-combat .pc-help:hover { border-color: var(--ui-border-bright); background: var(--ui-panel-raised); }
#plane-combat .pc-help:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 2px;
}
#plane-combat .pc-help-overlay {
  position: absolute;
  inset: 0;
  z-index: 8;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 20px;
  background: rgba(2,4,10,.66);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
}
#plane-combat .pc-help-overlay.show { display: flex; }
#plane-combat .pc-help-card {
  width: min(540px, 100%);
  padding: clamp(20px, 4vw, 32px);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel-glass);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
}
#plane-combat .pc-help-card p.lede {
  margin: 0 0 4px;
  max-width: 480px;
  color: var(--ui-muted);
  font-family: var(--ui-font-ui);
  font-size: var(--ui-text-sm);
  line-height: 1.5;
}
#plane-combat .pc-help-card ul {
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
#plane-combat .pc-help-card li {
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  background: rgba(4,7,13,.35);
  color: var(--ui-text);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  line-height: 1.4;
}
#plane-combat .pc-help-card li b { color: var(--ui-cyan); font-weight: 800; }
#plane-combat .pc-help-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
#plane-combat .pc-help-actions button { min-width: 130px; }
@media (max-width: 560px) {
  #plane-combat .pc-panel { width: calc(100vw - 24px); }
  #plane-combat .pc-log { max-height: 100px; }
  #plane-combat .pc-titlebar { font-size: var(--ui-text-xs); padding: 7px 12px; }
}
`;

const CSS = `${UI_TOKENS}\n${UI_BASE}\n${UI_COMPONENTS}\n${UI_PRIMITIVES}\n${PLANE_CSS}`;

export interface PlaneCombatOptions {
  campaign: CampaignState;
  onAction: (action: InterceptionAction) => void;
  onResolve: (outcome: InterceptionOutcome) => void;
  /**
   * Dogfight sound cue for a combat event: missile/cannon on the interceptor's own fire,
   * bolt on UFO return fire, explosion on a kill/vaporize. Optional so the view (and its
   * tests) can run silently; main wires it to `sfx.interception`.
   */
  onSfx?: (kind: "cannon" | "missile" | "bolt" | "explosion") => void;
}

export class PlaneCombatView {
  private readonly root: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(CAMERA_FOV, 1, 0.1, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  private readonly stage = new Group();
  private readonly interceptorMarker = new Group();
  private readonly ufoMarker = new Group();
  /** Bias the camera focus left so both craft compose clear of the HUD panel. */
  private readonly midpoint = new Vector3(-0.32, 0.08, 0);
  private readonly interceptorAnchor = new Vector3();
  private readonly ufoAnchor = new Vector3();
  private raf = 0;
  private disposed = false;
  private campaign: CampaignState;
  /** Whether an encounter was active on the previous render (drives resolve detection). */
  private wasEngaging: boolean;
  /** Schedules onResolve once the outcome FX has played. */
  private resolveTimer: number | undefined;
  /** Captured once at construction: true when the OS/browser asks for reduced motion.
   *  Freezes camera orbit/shake/pulses/beam-travel; essential HP/log/outcome state
   *  still updates instantly. */
  private readonly reducedMotion: boolean =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  // --- HUD nodes (rebuilt per refresh except the log, which scrolls) ---
  private readonly contactHeading: HTMLHeadingElement;
  private readonly roundsValue: HTMLElement;
  private readonly rangeNum: HTMLElement;
  private readonly rangeRate: HTMLElement;
  private readonly rangeFill: HTMLDivElement;
  private readonly rangeTrack: HTMLDivElement;
  private readonly interceptorFill: HTMLDivElement;
  private readonly interceptorValue: HTMLElement;
  private readonly ufoFill: HTMLDivElement;
  private readonly ufoValue: HTMLElement;
  private readonly weaponsBox: HTMLDivElement;
  private readonly logBox: HTMLDivElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly evadeBtn: HTMLButtonElement;
  private readonly disengageBtn: HTMLButtonElement;
  private readonly alarmEl: HTMLDivElement;
  private readonly missFlagEl: HTMLDivElement;
  private missFlagTimer: number | undefined;
  private readonly resolveOverlay: HTMLDivElement;
  /** Label + detail inside the resolve overlay; updated per outcome. */
  private readonly resolveText: HTMLElement;
  private readonly resolveDetail: HTMLElement;
  /** Concise dogfight HELP overlay (controls + outcomes reference). */
  private helpOverlay: HTMLDivElement | null = null;
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.helpOverlay?.classList.contains("show")) {
      this.toggleHelp(false);
    }
  };

  // --- Pooled combat FX (allocated once, reused per hit; no per-frame alloc) ---
  private tracerBeamCore!: Mesh;
  private tracerBeamGlow!: Mesh;
  private muzzleFlash!: Mesh;
  private ufoBurst!: Points;
  private interceptorBurst!: Points;
  private explosionBurst!: Points;
  private readonly ufoBurstVel = new Float32Array(BURST_PARTICLES * 3);
  private readonly interceptorBurstVel = new Float32Array(BURST_PARTICLES * 3);
  private readonly explosionBurstVel = new Float32Array(EXPLOSION_PARTICLES * 3);
  private readonly ufoBurstPos = new Float32Array(BURST_PARTICLES * 3);
  private readonly interceptorBurstPos = new Float32Array(BURST_PARTICLES * 3);
  private readonly explosionBurstPos = new Float32Array(EXPLOSION_PARTICLES * 3);
  private prevUfoHp: number | null;
  private prevInterceptorHp: number | null;
  private prevAmmo: Record<string, number> | null;
  private prevRangeKm: number | null;
  private readonly engineTrails: Mesh[] = [];
  private speedLines!: LineSegments;

  // Traveling-beam state: armed on fire, cleared once travel completes.
  private beamActive = false;
  private beamStartMs = 0;
  private beamTravelMs = TRAVEL_MS.cannon;
  private beamHit = false;
  private beamFrom: "interceptor" | "ufo" = "interceptor";
  private beamResolved = false;

  private fxMuzzleStartMs = 0;
  private fxMuzzleActive = false;
  // UFO-hit and interceptor-return-fire bursts are tracked independently (not a
  // shared single-slot flag) — the UFO burst is deferred until missile/cannon
  // travel completes while a return-fire burst starts immediately, so the two
  // can legitimately overlap in time (e.g. a fast cannon round).
  private ufoBurstActive = false;
  private ufoBurstStartMs = 0;
  private interceptorBurstActive = false;
  private interceptorBurstStartMs = 0;
  private fxExplosionActive = false;
  private fxExplosionStartMs = 0;
  private fxExplosionKind: "explosion" | "vaporize" = "explosion";
  private shakeStartMs = 0;
  private shakeActive = false;
  private shakeMagnitude = FX_SHAKE_MAGNITUDE;
  /** UFO evasive-jink offset (world units); decays back to zero. Frozen (0) under reducedMotion. */
  private jinkStartMs = 0;
  private jinkActive = false;
  private maneuverStartMs = 0;
  private maneuverKind: "close" | "evade" | null = null;

  // Reusable scratch (no per-frame allocation).
  private readonly scratchA = new Vector3();
  private readonly scratchQuat = new Quaternion();
  private readonly unitY = new Vector3(0, 1, 0);
  private readonly cameraBase = new Vector3();
  // Traveling-beam endpoints (cached on fire) + per-frame scratch for center/dir/end —
  // the fix for the previously-dead beam transform: every frame the cylinders are
  // repositioned from these (position+quaternion+scale), not just faded in place.
  private readonly fxTracerFrom = new Vector3();
  private readonly fxTracerTo = new Vector3();
  private readonly beamEnd = new Vector3();
  private readonly beamCenter = new Vector3();
  private readonly beamDir = new Vector3();
  private startTimeMs = 0;

  constructor(private readonly opts: PlaneCombatOptions) {
    injectStyle();
    this.campaign = opts.campaign;
    const enc = opts.campaign.interception ?? null;
    this.wasEngaging = enc !== null;
    this.prevUfoHp = enc?.ufoHp ?? null;
    this.prevInterceptorHp = enc?.interceptorHp ?? null;
    this.prevAmmo = enc ? { ...enc.ammo } : null;
    this.prevRangeKm = enc?.rangeKm ?? null;

    this.root = el("div");
    this.root.id = "plane-combat";
    this.canvasWrap = el("div", "pc-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;

    this.buildScene();
    this.buildCombatFx();
    const panels = this.buildHud();
    this.contactHeading = panels.heading;
    this.roundsValue = panels.rounds;
    this.rangeNum = panels.rangeNum;
    this.rangeRate = panels.rangeRate;
    this.rangeFill = panels.rangeFill;
    this.rangeTrack = panels.rangeTrack;
    this.interceptorFill = panels.interceptorFill;
    this.interceptorValue = panels.interceptorValue;
    this.ufoFill = panels.ufoFill;
    this.ufoValue = panels.ufoValue;
    this.weaponsBox = panels.weaponsBox;
    this.logBox = panels.log;
    this.closeBtn = panels.closeBtn;
    this.evadeBtn = panels.evadeBtn;
    this.disengageBtn = panels.disengageBtn;
    this.alarmEl = panels.alarm;
    this.missFlagEl = panels.missFlag;
    this.resolveOverlay = panels.resolve;
    this.resolveText = panels.resolveText;
    this.resolveDetail = panels.resolveDetail;
    this.refresh();
  }

  mount(container: HTMLElement): void {
    container.replaceChildren(this.root);
    this.canvasWrap.appendChild(this.renderer.domElement);
    window.addEventListener("resize", this.resize);
    window.addEventListener("keydown", this.onKeydown);
    this.resize();
    this.startTimeMs = performance.now();
    this.logBox.scrollTop = this.logBox.scrollHeight;
    this.frame();
  }

  /** Swap the live campaign state and re-render; detects fires/damage/lock/resolve. */
  update(campaign: CampaignState): void {
    if (this.disposed) return;
    this.campaign = campaign;
    this.detectEncounterEvents();
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.resolveTimer !== undefined) window.clearTimeout(this.resolveTimer);
    if (this.missFlagTimer !== undefined) window.clearTimeout(this.missFlagTimer);
    window.removeEventListener("resize", this.resize);
    window.removeEventListener("keydown", this.onKeydown);
    disposeObject(this.scene);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.root.remove();
  }

  // --------------------------------------------------------------------------
  // Scene construction
  // --------------------------------------------------------------------------

  private buildScene(): void {
    this.camera.position.set(0, CAMERA_ORBIT_HEIGHT, CAMERA_ORBIT_RADIUS);
    this.camera.lookAt(this.midpoint);

    this.scene.add(new AmbientLight(0x68839c, 1.0));
    const key = new DirectionalLight(0xcfe6ff, 1.75);
    key.position.set(2.4, 3.2, 2.6);
    this.scene.add(key);
    const rim = new DirectionalLight(0xfb7185, 1.25);
    rim.position.set(-3, -1, -2);
    this.scene.add(rim);
    const fill = new DirectionalLight(0x67e8f9, 0.42);
    fill.position.set(-2, 1.4, 1);
    this.scene.add(fill);

    this.scene.add(this.stage);
    this.stage.add(this.interceptorMarker, this.ufoMarker);
    this.buildInterceptor();
    this.buildUfo();
    this.speedLines = this.makeSpeedLines();
    this.scene.add(this.makeStarfield(), this.speedLines);
  }

  /** Interceptor: dark armored fuselage, swept wings, hot engine and readable cyan trim. */
  private buildInterceptor(): void {
    const hull = new MeshStandardMaterial({
      color: 0x244b69,
      emissive: new Color(0x102c3e),
      emissiveIntensity: 0.42,
      roughness: 0.44,
      metalness: 0.38,
    });
    const armor = new MeshStandardMaterial({
      color: 0x547e99,
      roughness: 0.34,
      metalness: 0.45,
    });
    const cyan = new MeshBasicMaterial({ color: 0x67e8f9, toneMapped: false });
    const fuselage = new Mesh(new CylinderGeometry(0.14, 0.23, 1.62, 12), hull);
    const nose = new Mesh(new ConeGeometry(0.14, 0.5, 12), armor);
    nose.position.y = 1.05;
    const wingGeo = new BoxGeometry(0.78, 0.42, 0.065);
    const wingR = new Mesh(wingGeo, hull);
    wingR.position.set(0.52, -0.12, 0);
    wingR.rotation.z = -0.5;
    const wingL = new Mesh(wingGeo, hull);
    wingL.position.set(-0.52, -0.12, 0);
    wingL.rotation.z = 0.5;
    const tail = new Mesh(new BoxGeometry(0.08, 0.38, 0.28), armor);
    tail.position.set(0, -0.58, 0.15);
    const spine = new Mesh(new BoxGeometry(0.12, 0.72, 0.1), armor);
    spine.position.set(0, 0.08, 0.12);
    const canopy = new Mesh(
      new SphereGeometry(0.11, 14, 10),
      new MeshStandardMaterial({
        color: 0x071b2b,
        emissive: new Color(0x0891b2),
        emissiveIntensity: 0.55,
        roughness: 0.16,
        metalness: 0.78,
      }),
    );
    canopy.position.set(0, 0.46, 0.08);
    canopy.scale.set(1, 1.65, 0.72);

    const engine = new Mesh(new CylinderGeometry(0.115, 0.15, 0.2, 12), armor);
    engine.position.y = -0.88;
    const engineCore = new Mesh(new SphereGeometry(0.1, 12, 8), cyan);
    engineCore.position.y = -0.99;
    engineCore.scale.y = 0.45;
    const trail = new Mesh(
      new ConeGeometry(0.13, 0.62, 14, 1, true),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.46,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    trail.position.y = -1.25;
    trail.rotation.z = Math.PI;
    this.engineTrails.push(trail);

    const trimGeo = new BoxGeometry(0.34, 0.035, 0.075);
    const trimL = new Mesh(trimGeo, cyan);
    trimL.position.set(-0.44, -0.12, 0.055);
    trimL.rotation.z = 0.5;
    const trimR = new Mesh(trimGeo, cyan);
    trimR.position.set(0.44, -0.12, 0.055);
    trimR.rotation.z = -0.5;
    const reticle = new Mesh(
      new RingGeometry(0.83, 0.86, 36),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.13,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    reticle.rotation.x = -Math.PI / 2;
    reticle.position.y = -0.2;
    this.interceptorMarker.add(
      fuselage, nose, wingR, wingL, tail, spine, canopy,
      engine, engineCore, trail, trimL, trimR, reticle,
    );
    this.interceptorMarker.scale.setScalar(0.68);
    // Built with forward axis +Y; face the UFO (which sits toward +X from the
    // interceptor's left-stage anchor) by rotating -90deg around Z (+Y -> +X).
    this.interceptorMarker.rotation.z = -Math.PI / 2;
  }

  /** UFO: weighty alien alloy saucer with a hot dome and segmented running lights. */
  private buildUfo(): void {
    const color = 0xfb7185;
    const saucer = new Mesh(
      new SphereGeometry(0.7, 28, 14),
      new MeshStandardMaterial({
        color: 0x381620,
        emissive: new Color(0x7f1d2b),
        emissiveIntensity: 0.28,
        roughness: 0.3,
        metalness: 0.52,
      }),
    );
    saucer.scale.y = 0.2;
    const lower = new Mesh(
      new CylinderGeometry(0.5, 0.7, 0.18, 28),
      new MeshStandardMaterial({ color: 0x160d17, roughness: 0.42, metalness: 0.6 }),
    );
    lower.position.y = -0.12;
    const dome = new Mesh(
      new SphereGeometry(0.24, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.55),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.82,
        blending: AdditiveBlending,
        toneMapped: false,
      }),
    );
    dome.position.y = 0.06;
    const rim = new Mesh(
      new TorusGeometry(0.69, 0.035, 8, 48),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.72,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
    rim.rotation.x = Math.PI / 2;
    const emitter = new Mesh(
      new CylinderGeometry(0.14, 0.22, 0.16, 18),
      new MeshBasicMaterial({ color: 0xff8aa2, toneMapped: false }),
    );
    emitter.position.y = -0.28;
    this.ufoMarker.add(saucer, lower, dome, rim, emitter);
    const nodeGeo = new SphereGeometry(0.045, 10, 8);
    const nodeMat = new MeshBasicMaterial({ color: 0xff9aae, toneMapped: false });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const node = new Mesh(nodeGeo, nodeMat);
      node.position.set(Math.cos(a) * 0.59, 0, Math.sin(a) * 0.59);
      this.ufoMarker.add(node);
    }
    this.ufoMarker.scale.setScalar(0.74);
  }

  /** Deep-space starfield: deterministic hash-scattered Points (no RNG). */
  private makeStarfield(): Points {
    const positions = new Float32Array(STAR_COUNT * 3);
    for (let i = 0; i < STAR_COUNT; i++) {
      const a = Math.sin(i * 12.9898) * 43758.5453;
      const b = Math.sin(i * 78.233) * 24634.6345;
      const c = Math.sin(i * 37.719) * 13579.1234;
      const x = ((a - Math.floor(a)) * 2 - 1) * 26;
      const y = ((b - Math.floor(b)) * 2 - 1) * 16;
      const z = -8 - (c - Math.floor(c)) * 14;
      positions[i * 3] = x;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = z;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new Points(
      geo,
      new PointsMaterial({
        color: 0xcfe8ff,
        size: 0.07,
        transparent: true,
        opacity: 0.85,
        sizeAttenuation: true,
      }),
    );
  }

  /** Fine deterministic velocity streaks: enough motion parallax to sell a chase. */
  private makeSpeedLines(): LineSegments {
    const count = 110;
    const positions = new Float32Array(count * 6);
    for (let i = 0; i < count; i++) {
      const a = Math.sin(i * 29.41) * 43758.5453;
      const b = Math.sin(i * 67.17) * 24634.6345;
      const c = Math.sin(i * 11.73) * 13579.1234;
      const x = ((a - Math.floor(a)) * 2 - 1) * 12;
      const y = ((b - Math.floor(b)) * 2 - 1) * 7;
      const z = -2 - (c - Math.floor(c)) * 18;
      const length = 0.18 + ((a * 7.1) - Math.floor(a * 7.1)) * 0.52;
      const at = i * 6;
      positions[at] = x;
      positions[at + 1] = y;
      positions[at + 2] = z;
      positions[at + 3] = x - length;
      positions[at + 4] = y;
      positions[at + 5] = z;
    }
    const geo = new BufferGeometry();
    geo.setAttribute("position", new Float32BufferAttribute(positions, 3));
    return new LineSegments(
      geo,
      new LineBasicMaterial({
        color: 0x8ed8ff,
        transparent: true,
        opacity: 0.17,
        blending: AdditiveBlending,
        depthWrite: false,
        toneMapped: false,
      }),
    );
  }

  // --------------------------------------------------------------------------
  // Combat FX (pooled)
  // --------------------------------------------------------------------------

  private buildCombatFx(): void {
    // Traveling shot: a glowing additive cylinder that grows from the shooter toward
    // the target over the weapon's travel time — reads as a missile/burst actually
    // crossing the gap rather than an instant tracer. Built once and pooled; only
    // its transform/opacity update per frame (see updateBeam).
    // Unit height (y spans -0.5..0.5) so scale.y maps directly to beam length.
    this.tracerBeamCore = new Mesh(
      new CylinderGeometry(0.022, 0.022, 1, 8, 1, true),
      new MeshBasicMaterial({
        color: 0xfff7cc,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    this.tracerBeamCore.frustumCulled = false;
    this.tracerBeamCore.visible = false;
    this.stage.add(this.tracerBeamCore);

    // Softer, wider outer shell wrapped around the core for a bloom-like glow.
    this.tracerBeamGlow = new Mesh(
      new CylinderGeometry(0.075, 0.075, 1, 12, 1, true),
      new MeshBasicMaterial({
        color: 0xffb347,
        transparent: true,
        opacity: 0,
        blending: AdditiveBlending,
        side: DoubleSide,
        depthWrite: false,
      }),
    );
    this.tracerBeamGlow.frustumCulled = false;
    this.tracerBeamGlow.visible = false;
    this.stage.add(this.tracerBeamGlow);

    this.muzzleFlash = new Mesh(
      new SphereGeometry(0.3, 14, 12),
      new MeshBasicMaterial({ color: 0xfff1b0, transparent: true, opacity: 0, blending: AdditiveBlending }),
    );
    this.muzzleFlash.visible = false;
    this.stage.add(this.muzzleFlash);

    this.ufoBurst = this.makeBurst(0xfb923c, this.ufoBurstVel, BURST_PARTICLES, 0.16);
    this.interceptorBurst = this.makeBurst(0xfb7185, this.interceptorBurstVel, BURST_PARTICLES, 0.16);
    this.explosionBurst = this.makeBurst(0xfdba74, this.explosionBurstVel, EXPLOSION_PARTICLES, 0.26);
    this.stage.add(this.ufoBurst, this.interceptorBurst, this.explosionBurst);
  }

  /** Additive Points burst with deterministic precomputed spark directions. */
  private makeBurst(color: number, velocities: Float32Array, count: number, size: number): Points {
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
   * Diff the encounter against the previous render and fire combat FX for whatever
   * happened this update: a weapon discharged (ammo pool dropped — trigger the
   * traveling shot, then reveal HIT or MISS once it lands), UFO return fire landed
   * (interceptor HP dropped — impact + alarm), or the encounter resolved (read the
   * terminal outcome from the campaign and play the matching FX + overlay, then
   * call onResolve once it has played).
   */
  private detectEncounterEvents(): void {
    const enc = this.campaign.interception ?? null;
    if (enc) {
      if (this.prevAmmo && this.prevUfoHp !== null && this.prevInterceptorHp !== null) {
        const firedId = firedWeaponId(this.prevAmmo, enc.ammo);
        const ufoDmg = this.prevUfoHp - enc.ufoHp;
        const intDmg = this.prevInterceptorHp - enc.interceptorHp;
        if (firedId) {
          const weapon = airWeapon(firedId);
          this.fireShot(weapon, ufoDmg > 0);
        }
        if (intDmg > 0) this.fireInterceptorHit();
      }
      if (this.prevRangeKm !== null && Math.abs(enc.rangeKm - this.prevRangeKm) > 0.1) {
        this.maneuverKind = enc.rangeKm < this.prevRangeKm ? "close" : "evade";
        this.maneuverStartMs = performance.now();
      }
      this.prevUfoHp = enc.ufoHp;
      this.prevInterceptorHp = enc.interceptorHp;
      this.prevAmmo = { ...enc.ammo };
      this.prevRangeKm = enc.rangeKm;
      this.wasEngaging = true;
      return;
    }
    // Encounter just resolved this update: branch the FX + resolve overlay on the
    // report's outcome (authoritative — see campaign/geoscape.ts InterceptionReport).
    if (this.wasEngaging) {
      const report = this.campaign.lastInterceptionReport;
      const outcome: InterceptionOutcome =
        report?.outcome !== undefined
          ? { kind: report.outcome, salvageQuality: report.salvageQuality ?? 0 }
          : { kind: "escaped", salvageQuality: 0 };
      this.playOutcome(outcome);
    }
    this.prevUfoHp = null;
    this.prevInterceptorHp = null;
    this.prevAmmo = null;
    this.prevRangeKm = null;
    this.wasEngaging = false;
  }

  private playOutcome(outcome: InterceptionOutcome): void {
    switch (outcome.kind) {
      case "crashed":
        this.opts.onSfx?.("explosion");
        this.fireExplosion(this.ufoAnchor, performance.now(), "explosion");
        this.kickCamera(FX_SHAKE_KILL_MULT);
        this.showResolve("Target destroyed", `Crash-site salvage ${ratioToPercent(outcome.salvageQuality)}`);
        this.scheduleResolve(RESOLVE_DELAY_MS, outcome);
        break;
      case "vaporized":
        this.opts.onSfx?.("explosion");
        this.fireExplosion(this.ufoAnchor, performance.now(), "vaporize");
        this.kickCamera(FX_SHAKE_KILL_MULT * 1.3);
        this.showResolve("Vaporized", "Overkill — no wreckage recovered");
        this.scheduleResolve(RESOLVE_DELAY_MS, outcome);
        break;
      case "brokeOff":
        this.showResolve("Broke off", "Interceptor damaged — returning to base");
        this.scheduleResolve(RESOLVE_DISENGAGE_DELAY_MS, outcome);
        break;
      case "escaped":
      default:
        this.showResolve("UFO escaped", "Contact lost");
        this.scheduleResolve(RESOLVE_DISENGAGE_DELAY_MS, outcome);
        break;
    }
  }

  /** Arm the traveling shot FX for a fired weapon; hit/miss revealed once it lands. */
  private fireShot(weapon: AirWeapon | undefined, hit: boolean): void {
    // Weapon-fire cue: the metallic cannon bark vs the heavier missile whoosh.
    this.opts.onSfx?.(weapon?.cls === "cannon" ? "cannon" : "missile");
    const now = performance.now();
    this.fxTracerFrom.copy(this.interceptorAnchor);
    this.fxTracerTo.copy(this.ufoAnchor);
    this.beamFrom = "interceptor";
    this.beamHit = hit;
    this.beamResolved = false;
    // Gate the traveling-growth animation under reducedMotion (Style Bible §2 /
    // mandatory fix): reduced-motion users get the shot rendered fully extended
    // and simply fading, not an animated crossing.
    this.beamTravelMs = this.reducedMotion ? 0 : (weapon ? TRAVEL_MS[weapon.cls] : TRAVEL_MS.cannon);
    this.beamStartMs = now;
    this.beamActive = true;
    (this.tracerBeamCore.material as MeshBasicMaterial).opacity = 1;
    (this.tracerBeamGlow.material as MeshBasicMaterial).opacity = 0.6;
    this.tracerBeamCore.visible = true;
    this.tracerBeamGlow.visible = true;

    this.scratchA.copy(this.fxTracerTo).sub(this.fxTracerFrom).normalize().multiplyScalar(0.9).add(this.fxTracerFrom);
    this.muzzleFlash.position.copy(this.scratchA);
    (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1;
    this.muzzleFlash.scale.setScalar(1);
    this.muzzleFlash.visible = true;
    this.fxMuzzleStartMs = now;
    this.fxMuzzleActive = true;
  }

  /** Called once the traveling shot reaches its target: hit flash or a dramatic miss. */
  private resolveShotArrival(): void {
    const now = performance.now();
    if (this.beamHit) {
      this.fireBurst(this.ufoBurst, this.ufoBurstPos, this.ufoAnchor, now);
      this.ufoBurstActive = true;
      this.ufoBurstStartMs = now;
      this.kickCamera(1);
    } else {
      this.showMiss();
      this.jinkStartMs = now;
      this.jinkActive = true;
    }
  }

  private showMiss(): void {
    this.missFlagEl.textContent = "EVADED";
    this.missFlagEl.classList.add("active");
    if (this.missFlagTimer !== undefined) window.clearTimeout(this.missFlagTimer);
    this.missFlagTimer = window.setTimeout(() => {
      this.missFlagEl.classList.remove("active");
    }, FX_MISS_MS);
  }

  /** UFO return fire: impact burst at the interceptor + shake + hull-drop alarm. */
  private fireInterceptorHit(): void {
    // UFO return-fire zap landing on the interceptor.
    this.opts.onSfx?.("bolt");
    const now = performance.now();
    this.fireBurst(this.interceptorBurst, this.interceptorBurstPos, this.interceptorAnchor, now);
    this.interceptorBurstActive = true;
    this.interceptorBurstStartMs = now;
    this.kickCamera(1);
  }

  /** Amplified explosion/debris burst at `pos`; vaporize kind runs longer + brighter. */
  private fireExplosion(pos: Vector3, now: number, kind: "explosion" | "vaporize"): void {
    this.fireBurst(this.explosionBurst, this.explosionBurstPos, pos, now);
    (this.explosionBurst.material as PointsMaterial).color.set(kind === "vaporize" ? 0xffffff : 0xfdba74);
    this.fxExplosionKind = kind;
    this.fxExplosionStartMs = now;
    this.fxExplosionActive = true;
  }

  /** Reset a burst to `pos` and arm it; particles radiate from origin over its lifetime. */
  private fireBurst(burst: Points, positions: Float32Array, pos: Vector3, now: number): void {
    positions.fill(0);
    const attr = burst.geometry.getAttribute("position") as Float32BufferAttribute;
    (attr.array as Float32Array).set(positions);
    attr.needsUpdate = true;
    burst.position.copy(pos);
    (burst.material as PointsMaterial).opacity = 1;
    burst.scale.setScalar(1);
    burst.visible = true;
  }

  /** Arm a decaying camera shake (frozen under reducedMotion); `mult` scales magnitude. */
  private kickCamera(mult: number): void {
    if (this.reducedMotion) return;
    this.shakeMagnitude = FX_SHAKE_MAGNITUDE * mult;
    this.shakeStartMs = performance.now();
    this.shakeActive = true;
  }

  private showResolve(label: string, detail: string): void {
    this.resolveText.textContent = label;
    this.resolveDetail.textContent = detail;
    this.resolveOverlay.classList.add("active");
    this.setActionsEnabled(false);
  }

  /** Schedule onResolve after the resolve FX has played; replaces any prior timer. */
  private scheduleResolve(delayMs: number, outcome: InterceptionOutcome): void {
    if (this.resolveTimer !== undefined) window.clearTimeout(this.resolveTimer);
    this.resolveTimer = window.setTimeout(() => {
      this.opts.onResolve(outcome);
    }, delayMs);
  }

  /** Per-frame FX evolution: advance the traveling beam, fade flashes/bursts, shake. */
  private updateCombatFx(now: number): void {
    this.updateBeam(now);
    if (this.fxMuzzleActive) {
      const t = (now - this.fxMuzzleStartMs) / FX_MUZZLE_MS;
      if (t >= 1) {
        this.fxMuzzleActive = false;
        this.muzzleFlash.visible = false;
      } else {
        (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1 - t;
        this.muzzleFlash.scale.setScalar(1 + t * 2.2);
      }
    }
    if (this.ufoBurstActive) {
      this.advanceBurst(this.ufoBurst, this.ufoBurstVel, this.ufoBurstPos, BURST_PARTICLES, this.ufoBurstStartMs, now, FX_BURST_MS);
      if ((now - this.ufoBurstStartMs) / FX_BURST_MS >= 1) {
        this.ufoBurstActive = false;
        this.ufoBurst.visible = false;
      }
    }
    if (this.interceptorBurstActive) {
      this.advanceBurst(this.interceptorBurst, this.interceptorBurstVel, this.interceptorBurstPos, BURST_PARTICLES, this.interceptorBurstStartMs, now, FX_BURST_MS);
      if ((now - this.interceptorBurstStartMs) / FX_BURST_MS >= 1) {
        this.interceptorBurstActive = false;
        this.interceptorBurst.visible = false;
      }
    }
    if (this.fxExplosionActive) {
      const dur = this.fxExplosionKind === "vaporize" ? FX_VAPORIZE_MS : FX_EXPLOSION_MS;
      this.advanceBurst(this.explosionBurst, this.explosionBurstVel, this.explosionBurstPos, EXPLOSION_PARTICLES, this.fxExplosionStartMs, now, dur);
      if ((now - this.fxExplosionStartMs) / dur >= 1) {
        this.fxExplosionActive = false;
        this.explosionBurst.visible = false;
      }
    }
  }

  /**
   * Position + orient + scale the traveling-shot cylinders every frame from the
   * cached endpoints (fxTracerFrom -> fxTracerTo), growing the travel point toward
   * the target over beamTravelMs (0 under reducedMotion — the shot then appears
   * fully extended and simply fades, no animated crossing). This replaces the prior
   * dead transform: the beam previously only faded opacity in place at the origin.
   */
  private updateBeam(now: number): void {
    if (!this.beamActive) return;
    const t = this.beamTravelMs > 0 ? clamp01((now - this.beamStartMs) / this.beamTravelMs) : 1;
    this.beamEnd.copy(this.fxTracerFrom).lerp(this.fxTracerTo, t);
    this.beamCenter.copy(this.fxTracerFrom).add(this.beamEnd).multiplyScalar(0.5);
    this.beamDir.copy(this.beamEnd).sub(this.fxTracerFrom);
    const length = this.beamDir.length();
    if (length > 1e-4) {
      this.beamDir.normalize();
      this.scratchQuat.setFromUnitVectors(this.unitY, this.beamDir);
      this.tracerBeamCore.quaternion.copy(this.scratchQuat);
      this.tracerBeamGlow.quaternion.copy(this.scratchQuat);
    }
    this.tracerBeamCore.position.copy(this.beamCenter);
    this.tracerBeamGlow.position.copy(this.beamCenter);
    this.tracerBeamCore.scale.set(1, Math.max(length, 1e-3), 1);
    this.tracerBeamGlow.scale.set(1, Math.max(length, 1e-3), 1);

    if (t >= 1) {
      if (!this.beamResolved) {
        this.beamResolved = true;
        this.resolveShotArrival();
      }
      const fadeMs = this.beamTravelMs > 0 ? FX_MUZZLE_MS : FX_BEAM_STATIC_MS;
      const fadeT = clamp01((now - (this.beamStartMs + this.beamTravelMs)) / fadeMs);
      if (fadeT >= 1) {
        this.beamActive = false;
        this.tracerBeamCore.visible = false;
        this.tracerBeamGlow.visible = false;
      } else {
        (this.tracerBeamCore.material as MeshBasicMaterial).opacity = 0.95 * (1 - fadeT);
        (this.tracerBeamGlow.material as MeshBasicMaterial).opacity = 0.6 * (1 - fadeT);
      }
    }
  }

  /** Radiate particles outward along precomputed velocities; fade + grow over lifetime. */
  private advanceBurst(
    burst: Points,
    velocities: Float32Array,
    positions: Float32Array,
    count: number,
    startMs: number,
    now: number,
    durationMs: number,
  ): void {
    const t = Math.min(1, (now - startMs) / durationMs);
    const spread = 0.25 + t * 1.5;
    for (let i = 0; i < count; i++) {
      positions[i * 3] = velocities[i * 3]! * spread;
      positions[i * 3 + 1] = velocities[i * 3 + 1]! * spread;
      positions[i * 3 + 2] = velocities[i * 3 + 2]! * spread;
    }
    const attr = burst.geometry.getAttribute("position") as Float32BufferAttribute;
    (attr.array as Float32Array).set(positions);
    attr.needsUpdate = true;
    (burst.material as PointsMaterial).opacity = 1 - t;
    burst.scale.setScalar(0.6 + t * 1.6);
  }

  // --------------------------------------------------------------------------
  // HUD
  // --------------------------------------------------------------------------

  private buildHud(): {
    heading: HTMLHeadingElement;
    rounds: HTMLElement;
    rangeNum: HTMLElement;
    rangeRate: HTMLElement;
    rangeFill: HTMLDivElement;
    rangeTrack: HTMLDivElement;
    interceptorFill: HTMLDivElement;
    interceptorValue: HTMLElement;
    ufoFill: HTMLDivElement;
    ufoValue: HTMLElement;
    weaponsBox: HTMLDivElement;
    log: HTMLDivElement;
    closeBtn: HTMLButtonElement;
    evadeBtn: HTMLButtonElement;
    disengageBtn: HTMLButtonElement;
    alarm: HTMLDivElement;
    missFlag: HTMLDivElement;
    resolve: HTMLDivElement;
    resolveText: HTMLElement;
    resolveDetail: HTMLElement;
  } {
    const alarm = el("div", "pc-alarm");
    this.root.append(alarm);

    const left = el("section", "pc-panel pc-left");
    const eye = el("div", "eyebrow");
    eye.textContent = "▲ Interceptor engagement";
    const heading = el("h2");
    const meta = el("div", "pc-meta");
    const rounds = el("span");
    rounds.innerHTML = `ROUND <b>—</b>`;
    const threat = el("span");
    const ufoInfo = ufoTypeInfo(this.campaign.ufoContact?.ufoType);
    threat.innerHTML = `HOSTILE <b>${ufoInfo.label.toUpperCase()}</b>`;
    meta.append(rounds, threat);

    const rangeTitle = el("div", "pc-range");
    const rangeLabel = el("span");
    rangeLabel.textContent = "Range";
    const rangeNum = el("span", "pc-range-num");
    const rangeRate = el("span", "pc-range-rate");
    rangeTitle.append(rangeLabel, rangeNum, rangeRate);
    const rangeTrack = el("div", "pc-range-track");
    const rangeFill = el("div", "pc-range-fill");
    rangeTrack.append(rangeFill);

    left.append(eye, heading, meta, rangeTitle, rangeTrack);
    const interceptorBar = this.hpBar("Interceptor", "interceptor");
    const ufoBar = this.hpBar("UFO", "ufo");
    left.append(interceptorBar.wrap, ufoBar.wrap);

    const weaponsBox = el("div", "pc-weapons");
    left.append(weaponsBox);

    const log = el("div", "pc-log");
    left.append(log);

    const actions = el("div", "pc-actions");
    const closeBtn = el("button", "ui-btn ui-cta");
    closeBtn.type = "button";
    closeBtn.textContent = `Afterburner (−${CLOSE_STEP_KM}km)`;
    const evadeBtn = el("button", "ui-btn pc-evade");
    evadeBtn.type = "button";
    evadeBtn.textContent = `Evasive break (+${EVADE_STEP_KM}km)`;
    const disengageBtn = el("button", "ui-btn ui-btn--danger pc-disengage");
    disengageBtn.type = "button";
    disengageBtn.textContent = "Disengage";
    actions.append(closeBtn, evadeBtn, disengageBtn);
    left.append(actions);
    this.root.append(left);

    const titlebar = el("div", "pc-titlebar");
    titlebar.textContent = "● Live dogfight";
    this.root.append(titlebar);

    const missFlag = el("div", "pc-miss-flag");
    this.root.append(missFlag);

    const resolve = el("div", "pc-resolve");
    const resolveCard = el("div", "pc-resolve-card");
    const resolveText = el("b");
    resolveText.textContent = "Target destroyed";
    const resolveDetail = el("span");
    resolveCard.append(resolveText, resolveDetail);
    resolve.append(resolveCard);
    this.root.append(resolve);

    const help = el("button", "pc-help");
    help.type = "button";
    help.textContent = "?";
    help.title = "Dogfight controls — click for help";
    help.setAttribute("aria-label", "Open dogfight help");
    help.addEventListener("click", () => this.toggleHelp(true));
    this.root.append(help);
    this.helpOverlay = this.buildHelpOverlay();
    this.root.append(this.helpOverlay);

    const interceptorFill = interceptorBar.fill;
    const interceptorValue = interceptorBar.value;
    const ufoFill = ufoBar.fill;
    const ufoValue = ufoBar.value;

    closeBtn.addEventListener("click", () => this.opts.onAction("close"));
    evadeBtn.addEventListener("click", () => this.opts.onAction("evade"));
    disengageBtn.addEventListener("click", () => this.opts.onAction("disengage"));

    return {
      heading,
      rounds,
      rangeNum,
      rangeRate,
      rangeFill,
      rangeTrack,
      interceptorFill,
      interceptorValue,
      ufoFill,
      ufoValue,
      weaponsBox,
      log,
      closeBtn,
      evadeBtn,
      disengageBtn,
      alarm,
      missFlag,
      resolve,
      resolveText,
      resolveDetail,
    };
  }

  /** Toggle the dogfight HELP overlay (controls + outcomes reference). */
  toggleHelp(force?: boolean): void {
    if (!this.helpOverlay) return;
    const show = force ?? !this.helpOverlay.classList.contains("show");
    this.helpOverlay.classList.toggle("show", show);
  }

  private buildHelpOverlay(): HTMLDivElement {
    const overlay = el("div", "pc-help-overlay");
    const card = el("div", "pc-help-card");
    const eye = el("div", "eyebrow");
    eye.textContent = "Dogfight controls";
    const title = el("h2");
    title.textContent = "Interception";
    const lede = el("p", "lede");
    lede.textContent =
      "Your interceptor duels a hostile UFO at real range. Close the gap, fire the right weapon for the moment, and bring it down before it brings you down.";
    const list = el("ul");
    const tips: Array<[string, string]> = [
      ["Heavy missile", "longest reach, devastating damage, slow lock — but can vaporize a small hull (no salvage)."],
      ["Light missile", "shorter reach, moderate damage — preserves the wreck for a clean recovery."],
      ["Cannon", "point-blank, sustained bursts — inside the UFO's own return-fire envelope."],
      ["Close", "cuts the range so shorter-legged weapons come into play."],
      ["Evasive break", "opens the range and primes countermeasures for two beats, cutting incoming damage."],
      ["Evasion", "every shot can be dodged — the UFO jinks harder at long range and with an agile hull."],
      ["Disengage", "breaks off the chase; the interceptor returns to base, UFO stays tracked."],
    ];
    for (const [head, copy] of tips) {
      const li = el("li");
      const b = el("b");
      b.textContent = `${head} — `;
      li.append(b, document.createTextNode(copy));
      list.appendChild(li);
    }
    const actions = el("div", "pc-help-actions");
    const close = el("button", "ui-btn");
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

  private hpBar(label: string, variant: "ufo" | "interceptor"): {
    wrap: HTMLDivElement;
    fill: HTMLDivElement;
    value: HTMLElement;
  } {
    const wrap = el("div", "pc-bar");
    const labelRow = el("div", "pc-bar-label");
    const name = el("span");
    name.textContent = label;
    const value = el("b");
    labelRow.append(name, value);
    const track = el("div", "pc-bar-track");
    const fill = el("div", `pc-bar-fill ${variant}`);
    track.append(fill);
    wrap.append(labelRow, track);
    return { wrap, fill, value };
  }

  private setActionsEnabled(enabled: boolean): void {
    this.closeBtn.disabled = !enabled;
    this.evadeBtn.disabled = !enabled;
    this.disengageBtn.disabled = !enabled;
    for (const btn of this.weaponsBox.querySelectorAll("button")) {
      (btn as HTMLButtonElement).disabled = !enabled;
    }
  }

  /** Re-render every HUD field + reposition the craft from the live encounter. */
  private refresh(): void {
    const enc = this.campaign.interception ?? null;
    if (enc) {
      const ufoInfo = ufoTypeInfo(this.campaign.ufoContact?.ufoType);
      this.contactHeading.textContent = `${ufoInfo.label} · ${enc.contactId}`;
      this.roundsValue.innerHTML = `ROUND <b>${enc.roundsElapsed + 1}</b>`;
      this.refreshRange(enc);
      this.updateHp(this.interceptorFill, this.interceptorValue, enc.interceptorHp, enc.interceptorHpMax);
      this.updateHp(this.ufoFill, this.ufoValue, enc.ufoHp, enc.ufoHpMax);
      this.refreshWeapons(enc);
      this.refreshLog(enc);
      this.refreshAlarm(enc);
      this.setActionsEnabled(true);
      this.closeBtn.disabled = enc.phase === "pursuit";
      const defensive = (enc.evasionBeatsLeft ?? 0) > 0;
      this.evadeBtn.disabled = enc.phase === "pursuit" || enc.rangeKm >= ENGAGEMENT_RANGE_KM;
      this.evadeBtn.classList.toggle("armed", defensive);
      this.evadeBtn.textContent = defensive
        ? `Countermeasures · ${enc.evasionBeatsLeft} beat${enc.evasionBeatsLeft === 1 ? "" : "s"}`
        : `Evasive break (+${EVADE_STEP_KM}km)`;
      this.resolveOverlay.classList.remove("active");
    } else {
      // Resolved: leave the last log + dim the actions (resolve overlay shown by detect path).
      this.setActionsEnabled(false);
    }
    this.placeCraft(enc);
  }

  private refreshRange(enc: InterceptionEncounter): void {
    this.rangeNum.innerHTML = `${Math.round(enc.rangeKm)}<span>km</span>`;
    if (enc.closingSpeedKmH > 0) {
      this.rangeRate.textContent = `closing ${Math.round(enc.closingSpeedKmH)} km/h`;
      this.rangeRate.classList.remove("opening");
    } else {
      this.rangeRate.textContent = "UFO outrunning — gap opening";
      this.rangeRate.classList.add("opening");
    }
    const span = Math.max(1, ENGAGEMENT_RANGE_KM - POINT_BLANK_KM);
    const filled = clamp01((ENGAGEMENT_RANGE_KM - enc.rangeKm) / span);
    this.rangeFill.style.width = `${filled * 100}%`;
    this.refreshRangeTicks(enc);
  }

  /** Rebuild the weapon-range tick marks on the gauge (rare — only on weapon-set change). */
  private refreshRangeTicks(enc: InterceptionEncounter): void {
    const existing = this.rangeTrack.querySelectorAll(".pc-range-tick");
    const ids = Object.keys(enc.ammo);
    if (existing.length === ids.length) {
      // Cheap path: just refresh in-range state, positions don't move.
      let i = 0;
      for (const id of ids) {
        const weapon = airWeapon(id);
        const tick = existing[i] as HTMLDivElement | undefined;
        if (tick && weapon) tick.classList.toggle("in-range", enc.rangeKm <= weapon.rangeKm);
        i++;
      }
      return;
    }
    for (const node of Array.from(existing)) node.remove();
    const span = Math.max(1, ENGAGEMENT_RANGE_KM - POINT_BLANK_KM);
    for (const id of ids) {
      const weapon = airWeapon(id);
      if (!weapon) continue;
      const tick = el("div", "pc-range-tick");
      const pos = clamp01((ENGAGEMENT_RANGE_KM - weapon.rangeKm) / span);
      tick.style.left = `${pos * 100}%`;
      tick.classList.toggle("in-range", enc.rangeKm <= weapon.rangeKm);
      this.rangeTrack.append(tick);
    }
  }

  /** Rebuild the weapon action rows from the encounter's live ammo/lock state. */
  private refreshWeapons(enc: InterceptionEncounter): void {
    this.weaponsBox.replaceChildren();
    for (const id of Object.keys(enc.ammo)) {
      const weapon = airWeapon(id);
      if (!weapon) continue;
      const shots = enc.ammo[id] ?? 0;
      const inRange = enc.rangeKm <= weapon.rangeKm;
      const locking = enc.lockingWeaponId === id && enc.lockBeatsLeft > 0;
      const canFire = inRange && shots > 0 && enc.phase === "engagement";

      const row = el("div", "pc-weapon");
      row.classList.toggle("locking", locking);
      if (locking && !this.reducedMotion) row.classList.add("pc-anim-pulse");
      const badge = weaponBadge(weapon.cls);
      const icon = el("div", "pc-weapon-icon");
      icon.textContent = badge.icon;
      const info = el("div", "pc-weapon-info");
      const name = el("div", "pc-weapon-name");
      name.textContent = weapon.name;
      const meta = el("div", "pc-weapon-meta");
      const rangeSpan = el("span");
      rangeSpan.textContent = `${weapon.rangeKm}km`;
      const ammoSpan = el("span");
      ammoSpan.textContent = `${shots} left`;
      meta.append(rangeSpan, ammoSpan);
      if (weapon.cls === "cannon") {
        const dangerSpan = el("span", "danger");
        dangerSpan.textContent = "return-fire range";
        meta.append(dangerSpan);
      }
      info.append(name, meta);

      const fireBtn = el("button", "ui-btn ui-btn--danger pc-weapon-fire");
      fireBtn.type = "button";
      if (locking) {
        fireBtn.textContent = `Lock ${enc.lockBeatsLeft}…`;
      } else if (!inRange) {
        fireBtn.textContent = "Out of range";
      } else if (shots <= 0) {
        fireBtn.textContent = "Dry";
      } else {
        fireBtn.textContent = "Fire";
      }
      fireBtn.disabled = !canFire;
      fireBtn.addEventListener("click", () => this.opts.onAction(`fire:${id}`));

      row.append(icon, info, fireBtn);
      this.weaponsBox.append(row);
    }
  }

  /** Pulses (static ring under reducedMotion) a red screen-edge alarm as hull drops. */
  private refreshAlarm(enc: InterceptionEncounter): void {
    const frac = enc.interceptorHpMax > 0 ? enc.interceptorHp / enc.interceptorHpMax : 1;
    const critical = frac <= 0.35;
    this.alarmEl.classList.toggle("active", critical);
    this.alarmEl.classList.toggle("pc-anim-pulse", critical && !this.reducedMotion);
  }

  private updateHp(fill: HTMLDivElement, value: HTMLElement, hp: number, hpMax: number): void {
    const pct = hpMax > 0 ? Math.max(0, Math.min(100, (hp / hpMax) * 100)) : 0;
    fill.style.width = `${pct}%`;
    value.textContent = `${Math.max(0, Math.floor(hp))}/${hpMax}`;
  }

  private refreshLog(enc: InterceptionEncounter): void {
    // Rebuild the log only when its contents changed (avoids resetting scrollTop mid-fade).
    const lines = enc.log;
    const same = this.logBox.childElementCount === lines.length &&
      Array.from(this.logBox.children).every((node, i) => (node as HTMLElement).textContent === lines[i]);
    if (same) return;
    this.logBox.replaceChildren();
    for (const line of lines) {
      const entry = el("p");
      if (/defensive break|countermeasures/i.test(line)) entry.classList.add("defensive");
      else if (/evad|miss|jink/i.test(line)) entry.classList.add("miss");
      entry.textContent = line;
      this.logBox.append(entry);
    }
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  /** Position the two craft from the engagement range (closer km = closer together). */
  private placeCraft(enc: InterceptionEncounter | null): void {
    const rangeKm = enc?.rangeKm ?? ENGAGEMENT_RANGE_KM;
    const sep = separationForKm(rangeKm);
    // Interceptor left-front, UFO right-back: 3/4 chase framing.
    this.interceptorAnchor.set(-sep / 2 + 0.68, -0.38, 0.62);
    this.ufoAnchor.set(sep / 2 + 0.18, 0.42, -0.45);
    this.interceptorMarker.position.copy(this.interceptorAnchor);
    this.ufoMarker.position.copy(this.ufoAnchor);
  }

  // --------------------------------------------------------------------------
  // Render loop
  // --------------------------------------------------------------------------

  private resize = (): void => {
    if (this.disposed) return;
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();

    if (this.reducedMotion) {
      // Frozen dramatic angle: no orbit, no shake (decorative motion gated).
      this.camera.position.copy(
        this.cameraBase.set(this.midpoint.x, CAMERA_ORBIT_HEIGHT, CAMERA_ORBIT_RADIUS),
      );
    } else {
      // Slow dramatic orbit around the engagement midpoint.
      const angle = (now - this.startTimeMs) * 0.001 * CAMERA_ORBIT_RATE;
      this.cameraBase.set(
        this.midpoint.x + Math.sin(angle) * CAMERA_ORBIT_RADIUS,
        CAMERA_ORBIT_HEIGHT,
        Math.cos(angle) * CAMERA_ORBIT_RADIUS,
      );
      // Decaying screen shake on top of the orbit base. Lateral (X/Y) only — the
      // prior Z-axis term read as a backward-recoil jolt toward/away from camera
      // and has been removed entirely.
      if (this.shakeActive) {
        const t = (now - this.shakeStartMs) / FX_SHAKE_MS;
        if (t >= 1) {
          this.shakeActive = false;
          this.camera.position.copy(this.cameraBase);
        } else {
          const decay = 1 - t;
          const mag = this.shakeMagnitude * decay;
          this.scratchA.set(
            (Math.sin(now * 0.073) + Math.sin(now * 0.019)) * 0.5 * mag,
            (Math.cos(now * 0.061) + Math.sin(now * 0.027)) * 0.5 * mag,
            0,
          );
          this.camera.position.copy(this.cameraBase).add(this.scratchA);
        }
      } else {
        this.camera.position.copy(this.cameraBase);
      }
    }
    this.camera.lookAt(this.midpoint);

    // Always rebuild transient craft transforms from the authoritative anchors;
    // maneuver/jink offsets below never accumulate across frames.
    this.interceptorMarker.position.x = this.interceptorAnchor.x;
    this.interceptorMarker.position.z = this.interceptorAnchor.z;
    this.ufoMarker.position.x = this.ufoAnchor.x;
    this.ufoMarker.position.z = this.ufoAnchor.z;
    this.interceptorMarker.rotation.y = 0;

    if (this.reducedMotion) {
      this.interceptorMarker.position.y = this.interceptorAnchor.y;
      this.ufoMarker.position.y = this.ufoAnchor.y;
    } else {
      // Gentle craft bob + saucer spin for life (pure decoration — gated above).
      const bob = Math.sin(now * 0.0021) * 0.05;
      this.interceptorMarker.position.y = this.interceptorAnchor.y + bob;
      this.ufoMarker.position.y = this.ufoAnchor.y - Math.sin(now * 0.0017) * 0.06;
      this.ufoMarker.rotation.y = now * 0.0006;
    }

    if (!this.reducedMotion) {
      const exhaustPulse = 0.86 + Math.sin(now * 0.018) * 0.14;
      for (const trail of this.engineTrails) {
        trail.scale.set(1, exhaustPulse, 1);
        (trail.material as MeshBasicMaterial).opacity = 0.38 + exhaustPulse * 0.12;
      }
      this.speedLines.rotation.y = -(now - this.startTimeMs) * 0.000035;
      (this.speedLines.material as LineBasicMaterial).opacity = 0.13 + Math.sin(now * 0.0017) * 0.035;
    }

    // Player-commanded maneuver beat: afterburner surges toward the target;
    // evasive break banks out of plane. State has already advanced, this is the
    // readable visual hand-off from the old range to the new one.
    if (this.maneuverKind) {
      const t = clamp01((now - this.maneuverStartMs) / FX_MANEUVER_MS);
      if (t >= 1 || this.reducedMotion) {
        this.maneuverKind = null;
      } else {
        const swing = Math.sin(t * Math.PI);
        if (this.maneuverKind === "close") {
          this.interceptorMarker.position.x += swing * 0.48;
          this.interceptorMarker.rotation.y = -swing * 0.42;
        } else {
          this.interceptorMarker.position.x -= swing * 0.24;
          this.interceptorMarker.position.z += swing * 0.5;
          this.interceptorMarker.rotation.y = swing * 0.72;
        }
      }
    }

    // Evasive jink: a quick lateral dodge on a revealed MISS. Essential-state FX
    // (a miss must read as dodged), so it plays even under reducedMotion but as a
    // single instantaneous snap-back rather than an animated slide.
    if (this.jinkActive) {
      const t = clamp01((now - this.jinkStartMs) / FX_MISS_MS);
      if (t >= 1) {
        this.jinkActive = false;
        this.ufoMarker.position.x = this.ufoAnchor.x;
      } else if (this.reducedMotion) {
        this.ufoMarker.position.x = this.ufoAnchor.x;
      } else {
        const swing = Math.sin(t * Math.PI) * 0.4;
        this.ufoMarker.position.x = this.ufoAnchor.x + swing;
      }
    }

    this.updateCombatFx(now);
    this.renderer.render(this.scene, this.camera);
  };
}

// --------------------------------------------------------------------------
// Module-private helpers (self-contained; geoscape's are not exported).
// --------------------------------------------------------------------------

/** The single weapon id whose ammo pool decreased between two encounter snapshots. */
function firedWeaponId(prev: Record<string, number>, next: Record<string, number>): string | null {
  for (const id of Object.keys(prev)) {
    const before = prev[id] ?? 0;
    const after = next[id] ?? before;
    if (after < before) return id;
  }
  return null;
}

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

function disposeMaterial(material: unknown): void {
  const mat = material as { dispose?: () => void };
  mat.dispose?.();
}

function disposeObject(obj: Scene | Group): void {
  obj.traverse((child) => {
    if (child instanceof Mesh || child instanceof Points || child instanceof Line) {
      child.geometry.dispose();
      const material = child.material;
      if (Array.isArray(material)) for (const one of material) disposeMaterial(one);
      else disposeMaterial(material);
    }
  });
}
