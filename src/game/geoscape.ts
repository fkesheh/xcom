import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  DirectionalLight,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  type Material,
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

import type { BaseLocation, CampaignState, UfoContact } from "../campaign/types";
import {
  canLaunchInterceptor,
  formatCampaignClock,
  GEOSCAPE_SCAN_HOURS,
  interceptionForecast,
  isInterceptorReady,
} from "../campaign/geoscape";
import { campaignObjectiveProgress, highestRegionalPanic } from "../campaign/storage";
import {
  WORLD_CITY_POINTS,
  WORLD_LAND_RINGS,
  type LatLon,
} from "./worldMapData";

interface GeoscapeOptions {
  campaign: CampaignState | null;
  onConfirmBase: (base: BaseLocation) => void;
  onAdvanceTime: (hours: number) => void;
  onInterceptUfo: () => void;
  onResetCampaign: () => void;
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
@media (max-width: 820px) {
  #geoscape .geo-panel { width: calc(100vw - 24px); padding: 13px; }
  #geoscape .geo-left { left: 12px; right: 12px; }
  #geoscape .geo-right { left: 12px; right: 12px; bottom: 12px; }
  #geoscape h1 { font-size: 30px; }
  #geoscape .geo-status { grid-template-columns: 1fr; }
  #geoscape .geo-hint { display: none; }
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
  private selectedBase: BaseLocation | null;
  private raf = 0;
  private down: { x: number; y: number } | null = null;
  private disposed = false;

  constructor(private readonly opts: GeoscapeOptions) {
    injectStyle();
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
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.45;

    this.earthMesh = this.buildScene();
    const panels = this.buildHud();
    this.selectedRegion = panels.region;
    this.selectedCoords = panels.coords;
    this.confirmButton = panels.confirm;
    this.updateSelectionHud();
  }

  mount(container: HTMLElement): void {
    container.replaceChildren(this.root);
    this.canvasWrap.appendChild(this.renderer.domElement);
    this.renderer.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.addEventListener("pointerup", this.onPointerUp);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.frame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.resize);
    this.renderer.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.renderer.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.controls.dispose();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.root.remove();
  }

  private buildScene(): Mesh {
    this.scene.add(new AmbientLight(0x6ecde8, 0.85));
    const sun = new DirectionalLight(0xffffff, 2.6);
    sun.position.set(4, 2, 5);
    this.scene.add(sun);

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
    this.buildUfoMarker();
    this.earthGroup.add(this.ufoMarker);
    if (this.opts.campaign?.ufoContact) this.placeUfoMarker(this.opts.campaign.ufoContact);
    else this.ufoMarker.visible = false;

    return ocean;
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
        color: 0xb8ffcf,
        size: 0.012,
        transparent: true,
        opacity: 0.72,
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

  private buildUfoMarker(): void {
    const core = new Mesh(
      new SphereGeometry(0.045, 16, 10),
      new MeshBasicMaterial({
        color: 0xfb7185,
        transparent: true,
        opacity: 0.95,
        blending: AdditiveBlending,
      }),
    );
    const ring = new Mesh(
      new RingGeometry(0.075, 0.12, 28),
      new MeshBasicMaterial({
        color: 0xfb7185,
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
        color: 0xfb7185,
        transparent: true,
        opacity: 0.46,
        blending: AdditiveBlending,
      }),
    );
    beam.position.y = 0.08;
    this.ufoMarker.add(core, ring, beam);
  }

  private buildHud(): { region: HTMLElement; coords: HTMLElement; confirm: HTMLButtonElement } {
    const left = el("section", "geo-panel geo-left");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Blacksite global command";
    const title = el("h1");
    title.textContent = "Earth Command";
    const copy = el("p");
    copy.textContent = this.opts.campaign
      ? "A clandestine base is established. Advance time to detect UFO contacts, then return to base to launch."
      : "Select a first base site on the globe. This will become the permanent command center for the campaign.";
    const stats = el("div", "geo-status");
    if (this.opts.campaign) {
      const panic = highestRegionalPanic(this.opts.campaign);
      const objective = campaignObjectiveProgress(this.opts.campaign);
      stats.append(
        this.stat("Clock", formatCampaignClock(this.opts.campaign.clock)),
        this.stat("Threat", `${this.opts.campaign.strategic.threat}%`),
        this.stat("Funding", `${this.opts.campaign.strategic.funding}`),
        this.stat("Cores", `${objective.completed}/${objective.required}`),
        this.stat("Panic", `${panic.region} ${panic.panic}%`),
      );
    } else {
      stats.append(
        this.stat("Threat", "Unknown"),
        this.stat("Funding", "Pending"),
        this.stat("Readiness", "Base required"),
      );
    }
    left.append(eyebrow, title, copy, stats);
    if (this.opts.campaign) {
      left.append(
        this.objectiveCard(),
        this.contactCard(),
        this.aircraftCard(),
        this.projectCard(),
        this.councilCard(),
        this.fundingCard(),
      );
    }
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
    const actions = el("div", "geo-actions");
    const reset = el("button");
    reset.textContent = this.opts.campaign ? "New campaign" : "Reset";
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    if (this.opts.campaign) {
      const timeAction = geoscapeTimeAction(this.opts.campaign);
      const scan = el("button");
      scan.textContent = timeAction.label;
      scan.disabled = timeAction.disabled;
      scan.addEventListener("click", () => this.opts.onAdvanceTime(timeAction.hours));
      actions.append(reset, scan);
      if (this.opts.campaign.ufoContact?.status === "tracked") {
        const intercept = el("button", "primary");
        const forecast = interceptionForecast(this.opts.campaign);
        intercept.textContent = isInterceptorReady(this.opts.campaign)
          ? forecast?.risk === "dangerous"
            ? "Risk intercept"
            : "Intercept"
          : "Repairing";
        intercept.disabled = !canLaunchInterceptor(this.opts.campaign);
        intercept.addEventListener("click", () => this.opts.onInterceptUfo());
        actions.append(intercept);
      }
    } else {
      actions.append(reset);
    }
    const confirm = el("button", "primary");
    confirm.addEventListener("click", () => {
      if (this.selectedBase) this.opts.onConfirmBase(this.selectedBase);
    });
    if (!this.opts.campaign?.ufoContact || this.opts.campaign.ufoContact.status === "crashed") {
      actions.append(confirm);
    }
    right.append(siteEye, heading, site, actions);
    this.root.appendChild(right);

    const hint = el("div", "geo-hint");
    hint.textContent = this.opts.campaign
      ? "Scan time from Earth Command / intercept UFOs / launch crash-site recovery from base"
      : "Drag to rotate / wheel to zoom / click Earth to designate base";
    this.root.appendChild(hint);
    return { region, coords, confirm };
  }

  private contactCard(): HTMLElement {
    const contact = this.opts.campaign?.ufoContact;
    const card = el("section", `geo-contact ${contact ? "" : "idle"}`.trim());
    const title = el("strong");
    const copy = el("p");
    if (contact) {
      title.textContent = `${contact.id} / ${contact.status === "crashed" ? "Crash site" : "Airborne"} / ${contact.region}`;
      const remaining = Math.max(0, contact.expiresAtHour - (this.opts.campaign?.clock.elapsedHours ?? 0));
      copy.textContent = contact.status === "crashed"
        ? `${fmtCoord(contact.lat, "N", "S")} / ${fmtCoord(contact.lon, "E", "W")} ` +
          `- crash site expires in ${remaining}h. Return to base to launch recovery. ` +
          `Interceptor damage ${contact.interceptorDamage ?? 0}%.`
        : this.trackedContactCopy(contact, remaining);
    } else {
      title.textContent = "No UFO contact";
      copy.textContent = "Radar is sweeping. Advance time until command detects a recoverable UFO track.";
    }
    card.append(title, copy);
    return card;
  }

  private objectiveCard(): HTMLElement {
    const campaign = this.opts.campaign!;
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

  private trackedContactCopy(contact: UfoContact, remaining: number): string {
    const forecast = interceptionForecast(this.opts.campaign!);
    const location = `${fmtCoord(contact.lat, "N", "S")} / ${fmtCoord(contact.lon, "E", "W")}`;
    if (!forecast) {
      return `${location} - signal expires in ${remaining}h. Launch interceptor before the UFO escapes.`;
    }
    const forecastLine =
      `Strength ${forecast.strength}. Intercept ${forecast.risk.toUpperCase()} ` +
      `(${forecast.interceptorScore}/${forecast.ufoScore}), ${forecast.damage}% estimated damage.`;
    return forecast.canLaunch
      ? `${location} - signal expires in ${remaining}h. ${forecastLine}`
      : `${location} - signal expires in ${remaining}h. Interceptor is repairing. ${forecastLine}`;
  }

  private aircraftCard(): HTMLElement {
    const campaign = this.opts.campaign!;
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
    const campaign = this.opts.campaign!;
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
    const report = this.opts.campaign?.lastFundingReport;
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
    const report = this.opts.campaign?.projectReports[0];
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
    const markerPulse = 1 + Math.sin(performance.now() * 0.004) * 0.08;
    this.baseMarker.scale.setScalar(markerPulse);
    this.ufoMarker.scale.setScalar(1 + Math.sin(performance.now() * 0.006) * 0.14);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };
}
