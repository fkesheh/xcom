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
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Points,
  PointsMaterial,
  RingGeometry,
  Scene,
  SphereGeometry,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from "three";
import type { CampaignState, InterceptionEncounter } from "../campaign/types";
import { type InterceptionAction, ufoTypeInfo } from "../campaign/geoscape";

/**
 * Sealed, self-contained 3D dogfight screen (NOT the geoscape). Mirrors the
 * classic X-COM interception interface: large interceptor + UFO models on a dark
 * space stage, a Long/Medium/Short/Point-blank range indicator, HP bars, a
 * scrolling combat log, Close/Attack/Disengage actions, and pooled additive
 * combat FX (muzzle flash, tracer beam, impact/explosion bursts, screen shake)
 * fired on detected HP deltas. The craft shapes are copied from geoscape's
 * buildInterceptorMarker/buildUfoMarker (no import) and rescaled for the stage.
 */

/** Maximum engagement range (matches campaign/geoscape ENCOUNTER_START_RANGE). */
const ENCOUNTER_START_RANGE = 3;

/** Interception combat-FX durations, in milliseconds. */
const FX_TRACER_MS = 200;
const FX_MUZZLE_MS = 150;
const FX_BURST_MS = 460;
const FX_EXPLOSION_MS = 720;
const FX_SHAKE_MS = 260;
/** Camera shake magnitude (world units) at hit onset; decays over FX_SHAKE_MS. */
const FX_SHAKE_MAGNITUDE = 0.06;
/** Multiplier on shake magnitude for the killing blow. */
const FX_SHAKE_KILL_MULT = 2.4;
/** Ms the kill explosion plays before onResolve returns the player to the geoscape. */
const RESOLVE_DELAY_MS = 950;
/** Ms the "Disengaged" overlay shows before onResolve (no kill FX to wait for). */
const RESOLVE_DISENGAGE_DELAY_MS = 500;

/** Pooled particle counts (ring/velocity buffers sized to these at build time). */
const BURST_PARTICLES = 22;
const EXPLOSION_PARTICLES = 34;
/** Deterministic starfield point count for the deep-space backdrop. */
const STAR_COUNT = 640;

/** Stage separation between the two craft at Long range (world units). */
const SEPARATION_LONG = 3.4;
/** Stage separation between the two craft at Point-blank range. */
const SEPARATION_CLOSE = 1.15;
/** Radius of the slow dramatic camera orbit around the engagement midpoint. */
const CAMERA_ORBIT_RADIUS = 5.6;
/** Height of the orbiting camera above the engagement midpoint. */
const CAMERA_ORBIT_HEIGHT = 1.7;
/** Radians per second the camera orbits (slow, for drama). */
const CAMERA_ORBIT_RATE = 0.18;

const STYLE_ID = "plane-combat-style";

/** Classic X-COM engagement range bands; range decreases as the player closes. */
interface RangeInfo {
  index: number;
  label: string;
}
const RANGE_BANDS = ["Point-blank", "Short", "Medium", "Long"] as const;

function rangeInfo(range: number): RangeInfo {
  const clamped = Math.max(0, Math.min(ENCOUNTER_START_RANGE, Math.round(range)));
  return { index: clamped, label: RANGE_BANDS[clamped]! };
}

/** Separation between the two craft derived from the current engagement range. */
function separationFor(range: number): number {
  const t = 1 - Math.max(0, Math.min(ENCOUNTER_START_RANGE, range)) / ENCOUNTER_START_RANGE;
  return SEPARATION_LONG + (SEPARATION_CLOSE - SEPARATION_LONG) * t;
}

const CSS = `
#plane-combat {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: #dff7ff;
  background:
    radial-gradient(circle at 50% 38%, rgba(20,12,40,.55), rgba(3,6,14,.96) 46%, #010206 100%);
  font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
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
    linear-gradient(90deg, rgba(103,232,249,.04) 1px, transparent 1px),
    linear-gradient(rgba(103,232,249,.03) 1px, transparent 1px),
    radial-gradient(circle at 50% 50%, transparent 55%, rgba(0,0,0,.55) 100%);
  background-size: 44px 44px, 44px 44px, auto;
  mix-blend-mode: screen;
}
#plane-combat .pc-panel {
  position: absolute;
  z-index: 4;
  display: flex;
  flex-direction: column;
  width: min(440px, calc(100vw - 28px));
  padding: 16px;
  border: 1px solid rgba(103,232,249,.32);
  border-radius: 12px;
  background:
    linear-gradient(145deg, rgba(10,24,36,.94), rgba(3,8,14,.96) 64%),
    rgba(3,8,14,.94);
  box-shadow: 0 28px 90px rgba(0,0,0,.5), inset 0 1px rgba(255,255,255,.04);
  backdrop-filter: blur(10px);
}
#plane-combat .pc-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 38%;
  height: 2px;
  background: linear-gradient(90deg, #fb7185, transparent);
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
  color: #fb7185;
  font: 800 9px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .22em;
  text-transform: uppercase;
}
#plane-combat h2 {
  margin: 6px 0 10px;
  font-size: 19px;
  line-height: 1;
  letter-spacing: .05em;
  text-transform: uppercase;
  color: #ffe4e6;
}
#plane-combat .pc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 14px;
  margin: 0 0 4px;
  color: #94a3b8;
  font: 700 10px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#plane-combat .pc-meta b { color: #e8fbff; font-weight: 800; }
#plane-combat .pc-range {
  margin: 10px 0 4px;
  color: #94a3b8;
  font: 700 9px/1 ui-monospace, monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
}
#plane-combat .pc-range-bar {
  display: flex;
  gap: 4px;
  margin-top: 5px;
}
#plane-combat .pc-range-seg {
  flex: 1;
  height: 8px;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 3px;
  background: rgba(103,232,249,.07);
}
#plane-combat .pc-range-seg.active {
  border-color: #67e8f9;
  background: linear-gradient(90deg, #67e8f9, #22d3ee);
  box-shadow: 0 0 10px rgba(103,232,249,.6);
}
#plane-combat .pc-range-labels {
  display: flex;
  gap: 4px;
  margin-top: 3px;
  color: #64748b;
  font: 700 7px/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#plane-combat .pc-range-labels span { flex: 1; text-align: center; }
#plane-combat .pc-range-labels span.active { color: #67e8f9; }
#plane-combat .pc-bar { margin: 8px 0; }
#plane-combat .pc-bar-label {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
  color: #cbd5e1;
  font: 700 9px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#plane-combat .pc-bar-label b { color: #e8fbff; font-weight: 800; }
#plane-combat .pc-bar-track {
  height: 14px;
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 999px;
  background: rgba(255,255,255,.07);
  overflow: hidden;
}
#plane-combat .pc-bar-fill {
  height: 100%;
  border-radius: 999px;
  transition: width .25s;
}
#plane-combat .pc-bar-fill.ufo { background: linear-gradient(90deg, #fb7185, #f43f5e); }
#plane-combat .pc-bar-fill.interceptor { background: linear-gradient(90deg, #67e8f9, #22d3ee); }
#plane-combat .pc-log {
  flex: 1;
  min-height: 72px;
  max-height: 156px;
  margin: 10px 0;
  padding: 8px 10px;
  overflow-y: auto;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 7px;
  background: rgba(0,0,0,.34);
  color: #a8c0d0;
  font: 11px/1.45 ui-monospace, "SF Mono", Menlo, monospace;
}
#plane-combat .pc-log p { margin: 0 0 4px; }
#plane-combat .pc-actions { display: flex; gap: 8px; }
#plane-combat .pc-actions button { flex: 1; }
#plane-combat button {
  padding: 10px 12px;
  border: 1px solid rgba(103,232,249,.32);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(20,40,54,.9), rgba(6,16,24,.92));
  color: #cfeeff;
  font: 800 11px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  cursor: pointer;
  transition: border-color .15s, box-shadow .15s, transform .05s;
}
#plane-combat button:hover { border-color: #67e8f9; box-shadow: 0 0 14px rgba(103,232,249,.35); }
#plane-combat button:active { transform: translateY(1px); }
#plane-combat button:disabled { opacity: .4; cursor: default; box-shadow: none; }
#plane-combat button.primary {
  border-color: rgba(251,113,133,.6);
  background: linear-gradient(180deg, rgba(60,16,26,.92), rgba(30,8,14,.95));
  color: #ffe4e6;
}
#plane-combat button.primary:hover { border-color: #fb7185; box-shadow: 0 0 14px rgba(251,113,133,.4); }
#plane-combat .pc-titlebar {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  transform: translateX(-50%);
  z-index: 4;
  padding: 8px 16px;
  border: 1px solid rgba(251,113,133,.4);
  border-radius: 999px;
  background: rgba(6,10,16,.72);
  backdrop-filter: blur(8px);
  color: #ffe4e6;
  font: 800 10px/1 ui-monospace, monospace;
  letter-spacing: .2em;
  text-transform: uppercase;
  white-space: nowrap;
}
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
  background: radial-gradient(circle at 50% 50%, rgba(251,113,133,.16), transparent 60%);
}
#plane-combat .pc-resolve.active { opacity: 1; }
#plane-combat .pc-resolve b {
  padding: 14px 30px;
  border: 1px solid rgba(251,113,133,.6);
  border-radius: 10px;
  background: rgba(6,10,16,.86);
  color: #ffe4e6;
  font: 800 22px/1 ui-monospace, monospace;
  letter-spacing: .14em;
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
  border-radius: 8px;
  border: 1px solid rgba(103,232,249,.5);
  color: #67e8f9;
  background: rgba(2,12,20,.82);
  font: 800 15px/1 ui-monospace, monospace;
  cursor: pointer;
  box-shadow: 0 10px 30px rgba(0,0,0,.4);
}
#plane-combat .pc-help:hover { border-color: rgba(103,232,249,.95); background: rgba(14,52,67,.95); }
#plane-combat .pc-help:focus-visible {
  outline: 2px solid #67e8f9;
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
  backdrop-filter: blur(4px);
}
#plane-combat .pc-help-overlay.show { display: flex; }
#plane-combat .pc-help-card {
  width: min(520px, 100%);
  padding: clamp(20px, 4vw, 32px);
  border: 1px solid rgba(103,232,249,.32);
  border-radius: 14px;
  background: linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%);
  box-shadow: 0 30px 100px rgba(0,0,0,.55);
}
#plane-combat .pc-help-card p.lede {
  margin: 0 0 4px;
  max-width: 460px;
  color: #a9c8d7;
  font: 12px/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
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
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 8px;
  background: rgba(0,0,0,.18);
  color: #cfe2ee;
  font: 600 11px/1.4 ui-monospace, "SF Mono", Menlo, monospace;
}
#plane-combat .pc-help-card li b { color: #67e8f9; font-weight: 800; }
#plane-combat .pc-help-actions { display: flex; justify-content: flex-end; margin-top: 16px; }
#plane-combat .pc-help-actions button { min-width: 130px; min-height: 38px; }
@media (max-width: 560px) {
  #plane-combat .pc-panel { width: calc(100vw - 24px); }
  #plane-combat .pc-log { max-height: 110px; }
  #plane-combat .pc-titlebar { font-size: 9px; padding: 7px 12px; }
}
`;

export interface PlaneCombatOptions {
  campaign: CampaignState;
  onAction: (action: InterceptionAction) => void;
  onResolve: () => void;
}

export class PlaneCombatView {
  private readonly root: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(46, 1, 0.1, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  private readonly stage = new Group();
  private readonly interceptorMarker = new Group();
  private readonly ufoMarker = new Group();
  private readonly midpoint = new Vector3(0, 0.08, 0);
  private readonly interceptorAnchor = new Vector3();
  private readonly ufoAnchor = new Vector3();
  private raf = 0;
  private disposed = false;
  private campaign: CampaignState;
  /** Whether an encounter was active on the previous render (drives resolve detection). */
  private wasEngaging: boolean;
  /** Schedules onResolve once the kill explosion has played. */
  private resolveTimer: number | undefined;

  // --- HUD nodes (rebuilt per refresh except the log, which scrolls) ---
  private readonly contactHeading: HTMLHeadingElement;
  private readonly roundsValue: HTMLElement;
  private readonly rangeSegments: HTMLDivElement[] = [];
  private readonly rangeLabels: HTMLSpanElement[] = [];
  private readonly interceptorFill: HTMLDivElement;
  private readonly interceptorValue: HTMLElement;
  private readonly ufoFill: HTMLDivElement;
  private readonly ufoValue: HTMLElement;
  private readonly logBox: HTMLDivElement;
  private readonly actionButtons: HTMLButtonElement[] = [];
  private readonly resolveOverlay: HTMLDivElement;
  /** Label inside the resolve overlay; updated per outcome (crashed/lost/disengaged). */
  private readonly resolveText: HTMLElement;
  /** Concise dogfight HELP overlay (controls + outcomes reference). */
  private helpOverlay: HTMLDivElement | null = null;
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.helpOverlay?.classList.contains("show")) {
      this.toggleHelp(false);
    }
  };

  // --- Pooled combat FX (allocated once, reused per hit; no per-frame alloc) ---
  private tracerLineFx!: Line;
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
  private fxTracerStartMs = 0;
  private fxMuzzleStartMs = 0;
  private fxBurstStartMs = 0;
  private fxExplosionStartMs = 0;
  private fxTracerActive = false;
  private fxMuzzleActive = false;
  private fxBurstSide: "ufo" | "interceptor" | null = null;
  private fxExplosionActive = false;
  private shakeStartMs = 0;
  private shakeActive = false;
  private shakeMagnitude = FX_SHAKE_MAGNITUDE;

  // Reusable scratch (no per-frame allocation).
  private readonly scratchA = new Vector3();
  private readonly scratchB = new Vector3();
  private readonly cameraBase = new Vector3();
  private startTimeMs = 0;

  constructor(private readonly opts: PlaneCombatOptions) {
    injectStyle();
    this.campaign = opts.campaign;
    const enc = opts.campaign.interception ?? null;
    this.wasEngaging = enc !== null;
    this.prevUfoHp = enc?.ufoHp ?? null;
    this.prevInterceptorHp = enc?.interceptorHp ?? null;

    this.root = el("div");
    this.root.id = "plane-combat";
    this.canvasWrap = el("div", "pc-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.buildScene();
    this.buildCombatFx();
    const panels = this.buildHud();
    this.contactHeading = panels.heading;
    this.roundsValue = panels.rounds;
    this.rangeSegments = panels.rangeSegments;
    this.rangeLabels = panels.rangeLabels;
    this.interceptorFill = panels.interceptorFill;
    this.interceptorValue = panels.interceptorValue;
    this.ufoFill = panels.ufoFill;
    this.ufoValue = panels.ufoValue;
    this.logBox = panels.log;
    this.actionButtons = panels.actions;
    this.resolveOverlay = panels.resolve;
    this.resolveText = panels.resolveText;
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

  /** Swap the live campaign state and re-render; detects HP deltas + resolve. */
  update(campaign: CampaignState): void {
    if (this.disposed) return;
    this.campaign = campaign;
    this.detectEncounterDamage();
    this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.resolveTimer !== undefined) window.clearTimeout(this.resolveTimer);
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

    this.scene.add(new AmbientLight(0x6b8aa8, 1.5));
    const key = new DirectionalLight(0xbfe0ff, 2.4);
    key.position.set(2.4, 3.2, 2.6);
    this.scene.add(key);
    const rim = new DirectionalLight(0xfb7185, 1.1);
    rim.position.set(-3, -1, -2);
    this.scene.add(rim);
    const fill = new DirectionalLight(0x67e8f9, 0.7);
    fill.position.set(-2, 1.4, 1);
    this.scene.add(fill);

    this.scene.add(this.stage);
    this.stage.add(this.interceptorMarker, this.ufoMarker);
    this.buildInterceptor();
    this.buildUfo();
    this.scene.add(this.makeStarfield());
  }

  /** Interceptor: fuselage + nose + swept wings + tail + canopy + halo (cyan). */
  private buildInterceptor(): void {
    const body = new MeshStandardMaterial({
      color: 0x22d3ee,
      emissive: new Color(0x06b6d4),
      emissiveIntensity: 1.4,
      roughness: 0.3,
      metalness: 0.45,
    });
    const fuselage = new Mesh(new CylinderGeometry(0.11, 0.19, 1.5, 10), body);
    const nose = new Mesh(new ConeGeometry(0.11, 0.4, 10), body);
    nose.position.y = 0.95;
    const wingGeo = new BoxGeometry(0.62, 0.34, 0.06);
    const wingR = new Mesh(wingGeo, body);
    wingR.position.set(0.4, -0.12, 0);
    wingR.rotation.z = -0.4;
    const wingL = new Mesh(wingGeo, body);
    wingL.position.set(-0.4, -0.12, 0);
    wingL.rotation.z = 0.4;
    const tail = new Mesh(new BoxGeometry(0.06, 0.3, 0.2), body);
    tail.position.set(0, -0.55, 0.11);
    const canopy = new Mesh(
      new SphereGeometry(0.08, 10, 8),
      new MeshStandardMaterial({
        color: 0x0e7490,
        emissive: new Color(0x0891b2),
        emissiveIntensity: 0.9,
        roughness: 0.2,
        metalness: 0.6,
      }),
    );
    canopy.position.set(0, 0.45, 0.04);
    canopy.scale.set(1, 1.5, 0.75);
    const halo = new Mesh(
      new RingGeometry(0.7, 1.0, 28),
      new MeshBasicMaterial({
        color: 0x67e8f9,
        transparent: true,
        opacity: 0.42,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    halo.position.y = -0.18;
    this.interceptorMarker.add(fuselage, nose, wingR, wingL, tail, canopy, halo);
    // Built with forward axis +Y; face the UFO (which sits toward +X from the
    // interceptor's left-stage anchor) by rotating -90deg around Z (+Y -> +X).
    this.interceptorMarker.rotation.z = -Math.PI / 2;
  }

  /** UFO: glowing saucer core + double rings + underside beam (red). */
  private buildUfo(): void {
    const color = 0xfb7185;
    const core = new Mesh(
      new SphereGeometry(0.42, 18, 12),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.96,
        blending: AdditiveBlending,
      }),
    );
    core.scale.y = 0.42;
    const saucer = new Mesh(
      new SphereGeometry(0.62, 22, 10),
      new MeshStandardMaterial({
        color: 0x4a1320,
        emissive: new Color(0x7f1d2b),
        emissiveIntensity: 0.8,
        roughness: 0.4,
        metalness: 0.5,
      }),
    );
    saucer.scale.y = 0.22;
    const ring = new Mesh(
      new RingGeometry(0.7, 1.05, 32),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.6,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    ring.rotation.x = -Math.PI / 2;
    const outerRing = new Mesh(
      new RingGeometry(1.2, 1.42, 32),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.32,
        side: DoubleSide,
        blending: AdditiveBlending,
      }),
    );
    outerRing.rotation.x = -Math.PI / 2;
    const beam = new Mesh(
      new ConeGeometry(0.4, 1.1, 18),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.4,
        blending: AdditiveBlending,
      }),
    );
    beam.position.y = -0.7;
    this.ufoMarker.add(saucer, core, ring, outerRing, beam);
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

  // --------------------------------------------------------------------------
  // Combat FX (pooled)
  // --------------------------------------------------------------------------

  private buildCombatFx(): void {
    const tracerGeo = new BufferGeometry();
    tracerGeo.setAttribute("position", new Float32BufferAttribute(new Float32Array(6), 3));
    this.tracerLineFx = new Line(
      tracerGeo,
      new LineBasicMaterial({ color: 0xfff7cc, transparent: true, opacity: 0, blending: AdditiveBlending }),
    );
    this.tracerLineFx.frustumCulled = false;
    this.tracerLineFx.visible = false;
    this.stage.add(this.tracerLineFx);

    this.muzzleFlash = new Mesh(
      new SphereGeometry(0.18, 12, 10),
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
   * Diff the encounter HP versus the previous render and fire combat FX for any
   * damage dealt. An "attack" round decreases both ufoHp (interceptor volley)
   * and interceptorHp (UFO return fire) in the same update, so both sides can
   * light up together. When the encounter clears this update (resolved), the FX
   * + resolve overlay branch on the post-resolve outcome (read from ufoContact):
   * a crashed UFO plays the killing volley + explosion at the UFO, a lost
   * interceptor explodes at the interceptor anchor with no friendly volley, and
   * a disengage shows a neutral overlay with no kill FX. onResolve fires after
   * the FX has played (RESOLVE_DELAY_MS, shorter for disengage).
   */
  private detectEncounterDamage(): void {
    const enc = this.campaign.interception ?? null;
    if (enc) {
      if (this.prevUfoHp !== null && this.prevInterceptorHp !== null) {
        const ufoDmg = this.prevUfoHp - enc.ufoHp;
        const intDmg = this.prevInterceptorHp - enc.interceptorHp;
        if (ufoDmg > 0) this.fireInterceptorVolley(ufoDmg);
        if (intDmg > 0) this.fireInterceptorHit(intDmg);
      }
      this.prevUfoHp = enc.ufoHp;
      this.prevInterceptorHp = enc.interceptorHp;
      this.wasEngaging = true;
      return;
    }
    // Encounter just resolved this update: branch the FX + resolve overlay on the
    // actual post-resolve outcome. The campaign distinguishes the three terminal
    // states cleanly via ufoContact — crashed (UFO down), undefined (interceptor
    // lost / UFO escaped), or tracked (player disengaged).
    if (this.wasEngaging && this.prevUfoHp !== null && this.prevUfoHp > 0) {
      const ufoContact = this.campaign.ufoContact;
      if (ufoContact?.status === "tracked") {
        // Disengage: the UFO survived and stays tracked. No kill FX, brief overlay.
        this.showResolve("Disengaged");
        this.scheduleResolve(RESOLVE_DISENGAGE_DELAY_MS);
      } else if (ufoContact === undefined) {
        // Interceptor lost / UFO escaped: explode the interceptor, no friendly volley.
        this.fireExplosion(this.interceptorAnchor, performance.now());
        this.kickCamera(FX_SHAKE_KILL_MULT);
        this.showResolve("Interceptor lost");
        this.scheduleResolve(RESOLVE_DELAY_MS);
      } else {
        // UFO forced down: full kill sequence (volley + explosion) at the UFO anchor.
        this.fireInterceptorVolley(this.prevUfoHp);
        this.fireExplosion(this.ufoAnchor, performance.now());
        this.kickCamera(FX_SHAKE_KILL_MULT);
        this.showResolve("Target destroyed");
        this.scheduleResolve(RESOLVE_DELAY_MS);
      }
    }
    this.prevUfoHp = null;
    this.prevInterceptorHp = null;
    this.wasEngaging = false;
  }

  /** Interceptor volley: tracer beam + muzzle flash + impact burst at the UFO. */
  private fireInterceptorVolley(dmg: number): void {
    const now = performance.now();
    const from = this.interceptorAnchor;
    const to = this.ufoAnchor;
    const attr = this.tracerLineFx.geometry.getAttribute("position") as Float32BufferAttribute;
    const arr = attr.array as Float32Array;
    arr[0] = from.x; arr[1] = from.y; arr[2] = from.z;
    arr[3] = to.x; arr[4] = to.y; arr[5] = to.z;
    attr.needsUpdate = true;
    (this.tracerLineFx.material as LineBasicMaterial).opacity = 0.95;
    this.tracerLineFx.visible = true;
    this.fxTracerStartMs = now;
    this.fxTracerActive = true;

    // Muzzle flash just ahead of the interceptor nose (toward the UFO).
    this.scratchA.copy(to).sub(from).normalize().multiplyScalar(0.9).add(from);
    this.muzzleFlash.position.copy(this.scratchA);
    (this.muzzleFlash.material as MeshBasicMaterial).opacity = 1;
    this.muzzleFlash.scale.setScalar(1);
    this.muzzleFlash.visible = true;
    this.fxMuzzleStartMs = now;
    this.fxMuzzleActive = true;

    this.fireBurst(this.ufoBurst, this.ufoBurstPos, to, now);
    this.fxBurstSide = "ufo";
    if (dmg > 0) this.kickCamera(1);
  }

  /** UFO return fire: impact burst at the interceptor + shake. */
  private fireInterceptorHit(_dmg: number): void {
    this.fireBurst(this.interceptorBurst, this.interceptorBurstPos, this.interceptorAnchor, performance.now());
    this.fxBurstSide = "interceptor";
    this.kickCamera(1);
  }

  /** Amplified explosion/debris burst at `pos`. */
  private fireExplosion(pos: Vector3, now: number): void {
    this.fireBurst(this.explosionBurst, this.explosionBurstPos, pos, now);
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
    this.fxBurstStartMs = now;
  }

  /** Arm a decaying camera shake; `mult` scales magnitude (kills hit harder). */
  private kickCamera(mult: number): void {
    this.shakeMagnitude = FX_SHAKE_MAGNITUDE * mult;
    this.shakeStartMs = performance.now();
    this.shakeActive = true;
  }

  private showResolve(label: string): void {
    this.resolveText.textContent = label;
    this.resolveOverlay.classList.add("active");
    this.setActionsEnabled(false);
  }

  /** Schedule onResolve after the resolve FX has played; replaces any prior timer. */
  private scheduleResolve(delayMs: number): void {
    if (this.resolveTimer !== undefined) window.clearTimeout(this.resolveTimer);
    this.resolveTimer = window.setTimeout(() => {
      this.opts.onResolve();
    }, delayMs);
  }

  /** Per-frame FX evolution: fade tracers/flashes, advance burst particles, shake. */
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
        this.muzzleFlash.scale.setScalar(1 + t * 2.2);
      }
    }
    if (this.fxBurstSide) {
      const burst = this.fxBurstSide === "ufo" ? this.ufoBurst : this.interceptorBurst;
      const vel = this.fxBurstSide === "ufo" ? this.ufoBurstVel : this.interceptorBurstVel;
      const pos = this.fxBurstSide === "ufo" ? this.ufoBurstPos : this.interceptorBurstPos;
      this.advanceBurst(burst, vel, pos, BURST_PARTICLES, this.fxBurstStartMs, now, FX_BURST_MS);
      if ((now - this.fxBurstStartMs) / FX_BURST_MS >= 1) {
        this.fxBurstSide = null;
        burst.visible = false;
      }
    }
    if (this.fxExplosionActive) {
      this.advanceBurst(this.explosionBurst, this.explosionBurstVel, this.explosionBurstPos, EXPLOSION_PARTICLES, this.fxExplosionStartMs, now, FX_EXPLOSION_MS);
      if ((now - this.fxExplosionStartMs) / FX_EXPLOSION_MS >= 1) {
        this.fxExplosionActive = false;
        this.explosionBurst.visible = false;
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
    rangeSegments: HTMLDivElement[];
    rangeLabels: HTMLSpanElement[];
    interceptorFill: HTMLDivElement;
    interceptorValue: HTMLElement;
    ufoFill: HTMLDivElement;
    ufoValue: HTMLElement;
    log: HTMLDivElement;
    actions: HTMLButtonElement[];
    resolve: HTMLDivElement;
    resolveText: HTMLElement;
  } {
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
    rangeTitle.textContent = "Weapons range";
    const rangeBar = el("div", "pc-range-bar");
    const rangeLabelsRow = el("div", "pc-range-labels");
    // RANGE_BANDS = [Point-blank(0), Short(1), Medium(2), Long(3)] — render Long..Point-blank left→right.
    for (let band = ENCOUNTER_START_RANGE; band >= 0; band--) {
      const seg = el("div", "pc-range-seg");
      rangeBar.append(seg);
      const label = el("span");
      label.textContent = RANGE_BANDS[band]!;
      rangeLabelsRow.append(label);
    }
    const rangeSegments = Array.from(rangeBar.children) as HTMLDivElement[];
    const rangeLabels = Array.from(rangeLabelsRow.children) as HTMLSpanElement[];

    left.append(eye, heading, meta, rangeTitle, rangeBar, rangeLabelsRow);
    const interceptorBar = this.hpBar("Interceptor", "interceptor");
    const ufoBar = this.hpBar("UFO", "ufo");
    left.append(interceptorBar.wrap, ufoBar.wrap);

    const log = el("div", "pc-log");
    left.append(log);

    const actions = el("div", "pc-actions");
    const closeBtn = el("button");
    closeBtn.textContent = "Close";
    const attackBtn = el("button", "primary");
    attackBtn.textContent = "Attack";
    const disengageBtn = el("button");
    disengageBtn.textContent = "Disengage";
    actions.append(closeBtn, attackBtn, disengageBtn);
    left.append(actions);
    this.root.append(left);

    const titlebar = el("div", "pc-titlebar");
    titlebar.textContent = "● Live dogfight";
    this.root.append(titlebar);

    const resolve = el("div", "pc-resolve");
    const resolveText = el("b");
    resolveText.textContent = "Target destroyed";
    resolve.append(resolveText);
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
    attackBtn.addEventListener("click", () => this.opts.onAction("attack"));
    disengageBtn.addEventListener("click", () => this.opts.onAction("disengage"));
    const actionButtons = [closeBtn, attackBtn, disengageBtn];

    return {
      heading,
      rounds,
      rangeSegments,
      rangeLabels,
      interceptorFill,
      interceptorValue,
      ufoFill,
      ufoValue,
      log,
      actions: actionButtons,
      resolve,
      resolveText,
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
      "Your interceptor duels a hostile UFO across four range bands. Manage the range, trade fire, and bring it down before it brings you down.";
    const list = el("ul");
    const tips: Array<[string, string]> = [
      ["Close", "drops the range one band — closing raises both sides' hit odds and damage."],
      ["Attack", "exchanges fire at the current range: your volley hits the UFO, then it shoots back."],
      ["Disengage", "breaks off the chase and sends the interceptor home, leaving the UFO tracked."],
      ["Range bands", "Long → Medium → Short → Point-blank; the closer you get, the deadlier for both."],
      ["UFO down", "drop the UFO to 0 HP and it crashes to Earth, opening a recovery assault mission."],
      ["Interceptor lost", "if your craft hits 0 HP first, the UFO escapes and the interceptor is destroyed."],
    ];
    for (const [head, copy] of tips) {
      const li = el("li");
      const b = el("b");
      b.textContent = `${head} — `;
      li.append(b, document.createTextNode(copy));
      list.appendChild(li);
    }
    const actions = el("div", "pc-help-actions");
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
    for (const btn of this.actionButtons) btn.disabled = !enabled;
  }

  /** Re-render every HUD field + reposition the craft from the live encounter. */
  private refresh(): void {
    const enc = this.campaign.interception ?? null;
    if (enc) {
      const ufoInfo = ufoTypeInfo(this.campaign.ufoContact?.ufoType);
      this.contactHeading.textContent = `${ufoInfo.label} · ${enc.contactId}`;
      this.roundsValue.innerHTML = `ROUND <b>${enc.roundsElapsed + 1}</b>`;
      const info = rangeInfo(enc.range);
      // Segments are laid out Long(left) → Point-blank(right); flip index to column.
      const activeCol = ENCOUNTER_START_RANGE - info.index;
      for (let i = 0; i < this.rangeSegments.length; i++) {
        const on = i === activeCol;
        this.rangeSegments[i]!.classList.toggle("active", on);
        this.rangeLabels[i]!.classList.toggle("active", on);
      }
      this.updateHp(this.interceptorFill, this.interceptorValue, enc.interceptorHp, enc.interceptorHpMax);
      this.updateHp(this.ufoFill, this.ufoValue, enc.ufoHp, enc.ufoHpMax);
      this.refreshLog(enc);
      this.setActionsEnabled(true);
      this.resolveOverlay.classList.remove("active");
    } else {
      // Resolved: leave the last log + dim the actions (resolve overlay shown by detect path).
      this.setActionsEnabled(false);
    }
    this.placeCraft(enc);
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
      entry.textContent = line;
      this.logBox.append(entry);
    }
    this.logBox.scrollTop = this.logBox.scrollHeight;
  }

  /** Position the two craft from the engagement range (closer range = closer together). */
  private placeCraft(enc: InterceptionEncounter | null): void {
    const range = enc?.range ?? ENCOUNTER_START_RANGE;
    const sep = separationFor(range);
    // Interceptor left-front, UFO right-back: 3/4 chase framing.
    this.interceptorAnchor.set(-sep / 2, -0.18, 0.55);
    this.ufoAnchor.set(sep / 2, 0.42, -0.45);
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

    // Slow dramatic orbit around the engagement midpoint.
    const angle = (now - this.startTimeMs) * 0.001 * CAMERA_ORBIT_RATE;
    this.cameraBase.set(
      Math.sin(angle) * CAMERA_ORBIT_RADIUS,
      CAMERA_ORBIT_HEIGHT,
      Math.cos(angle) * CAMERA_ORBIT_RADIUS,
    );
    // Apply a decaying screen shake on top of the orbit base.
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
          (Math.sin(now * 0.043)) * mag,
        );
        this.camera.position.copy(this.cameraBase).add(this.scratchA);
      }
    } else {
      this.camera.position.copy(this.cameraBase);
    }
    this.camera.lookAt(this.midpoint);

    // Gentle craft bob + saucer spin for life.
    const bob = Math.sin(now * 0.0021) * 0.05;
    this.interceptorMarker.position.y = this.interceptorAnchor.y + bob;
    this.ufoMarker.position.y = this.ufoAnchor.y - Math.sin(now * 0.0017) * 0.06;
    this.ufoMarker.rotation.y = now * 0.0006;

    this.updateCombatFx(now);
    this.renderer.render(this.scene, this.camera);
  };
}

// --------------------------------------------------------------------------
// Module-private helpers (self-contained; geoscape's are not exported).
// --------------------------------------------------------------------------

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
