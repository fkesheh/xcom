/**
 * Procedural globe visuals — equirectangular earth texture, day/night shader,
 * atmosphere rim, faint graticule, and surface beacon markers.
 *
 * Wired from geoscape.ts; all assets are canvas/procedural (no network fetches).
 */

import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  DoubleSide,
  Group,
  Line,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
} from "three";

import { WORLD_LAND_RINGS, type LatLon } from "./worldMapData";

export const GLOBE_MAP_WIDTH = 2048;
export const GLOBE_MAP_HEIGHT = 1024;

/** Deterministic hash in [0, 1) from two seeds (no Math.random). */
export function hash01(a: number, b: number): number {
  const n = Math.sin(a * 127.1 + b * 311.7) * 43758.5453123;
  return n - Math.floor(n);
}

export function mapXY(
  lat: number,
  lon: number,
  width = GLOBE_MAP_WIDTH,
  height = GLOBE_MAP_HEIGHT,
): [number, number] {
  return [((lon + 180) / 360) * width, ((90 - lat) / 180) * height];
}

function drawLatLonPath(
  ctx: CanvasRenderingContext2D,
  polygon: readonly LatLon[],
  width = GLOBE_MAP_WIDTH,
  height = GLOBE_MAP_HEIGHT,
): void {
  polygon.forEach(([lat, lon], index) => {
    const [x, y] = mapXY(lat, lon, width, height);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.closePath();
}

/** Filled landmasses on a deep-navy equirectangular map (2048×1024). */
export function makeEarthTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = GLOBE_MAP_WIDTH;
  canvas.height = GLOBE_MAP_HEIGHT;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  const ocean = ctx.createLinearGradient(0, 0, 0, GLOBE_MAP_HEIGHT);
  ocean.addColorStop(0, "#1e3a52");
  ocean.addColorStop(0.12, "#061828");
  ocean.addColorStop(0.5, "#0a2a48");
  ocean.addColorStop(0.88, "#061828");
  ocean.addColorStop(1, "#1e3a52");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, GLOBE_MAP_WIDTH, GLOBE_MAP_HEIGHT);

  const depth = ctx.createLinearGradient(0, 0, GLOBE_MAP_WIDTH, 0);
  depth.addColorStop(0, "rgba(0,0,0,0.12)");
  depth.addColorStop(0.5, "rgba(0,0,0,0)");
  depth.addColorStop(1, "rgba(0,0,0,0.12)");
  ctx.fillStyle = depth;
  ctx.fillRect(0, 0, GLOBE_MAP_WIDTH, GLOBE_MAP_HEIGHT);

  for (let y = 0; y < GLOBE_MAP_HEIGHT; y += 2) {
    const lat = 90 - (y / GLOBE_MAP_HEIGHT) * 180;
    const polar = Math.max(0, (Math.abs(lat) - 62) / 28);
    if (polar <= 0) continue;
    const ice = Math.round(180 + polar * 55);
    ctx.fillStyle = `rgba(${ice},${ice + 8},${ice + 18},${0.06 + polar * 0.14})`;
    ctx.fillRect(0, y, GLOBE_MAP_WIDTH, 2);
  }

  WORLD_LAND_RINGS.forEach((polygon, polyIndex) => {
    const shade = hash01(polyIndex, 2.17);
    const r = Math.round(32 + shade * 28);
    const g = Math.round(88 + shade * 42);
    const b = Math.round(72 + shade * 32);
    const cr = Math.min(255, r + 38);
    const cg = Math.min(255, g + 44);
    const cb = Math.min(255, b + 36);

    ctx.beginPath();
    drawLatLonPath(ctx, polygon);
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.72)`;
    ctx.lineWidth = 1.6;
    ctx.lineJoin = "round";
    ctx.stroke();
  });

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

export interface EarthShader {
  material: ShaderMaterial;
  uniforms: {
    uMap: { value: CanvasTexture };
    uSunDir: { value: Vector3 };
    uTexel: { value: Vector2 };
  };
}

/**
 * Day/night earth material.
 *
 * Night readability: land and ocean get DISTINCT dark floors (land `#18261f`,
 * ocean `#0a1526`) so continents never vanish into the sea on the dark side, and
 * a faint cool coastline emissive (one-texel land/ocean edge, night side only)
 * traces the continent outlines. Twilight is a smooth ~12° band with a warm
 * `#c97b3e` dusk tint that fades both ways. Ocean keeps a subtle sun glint.
 */
export function createEarthShaderMaterial(map: CanvasTexture): EarthShader {
  const uniforms = {
    uMap: { value: map },
    uSunDir: { value: new Vector3(1, 0, 0) },
    uTexel: { value: new Vector2(1 / GLOBE_MAP_WIDTH, 1 / GLOBE_MAP_HEIGHT) },
  };
  const material = new ShaderMaterial({
    uniforms,
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      void main() {
        vUv = uv;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vNormalW = normalize(mat3(modelMatrix) * normal);
        vViewDir = normalize(cameraPosition - wp.xyz);
        gl_Position = projectionMatrix * viewMatrix * wp;
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec3 vNormalW;
      varying vec3 vViewDir;
      uniform sampler2D uMap;
      uniform vec3 uSunDir;
      uniform vec2 uTexel;

      float smoothstepf(float e0, float e1, float x) {
        float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }

      // 1.0 where the sampled texel reads as ocean (blue-dominant), else 0.0.
      float oceanAt(vec2 uv) {
        vec3 t = texture2D(uMap, uv).rgb;
        return step(t.g + 0.06, t.b);
      }

      void main() {
        vec3 tex = texture2D(uMap, vUv).rgb;
        vec3 n = normalize(vNormalW);
        vec3 sun = normalize(uSunDir);
        float ndotl = dot(n, sun);

        // ~12° twilight half-band (sin 12° ≈ 0.21).
        float twilight = 0.21;
        float day = smoothstepf(-twilight, twilight, ndotl);

        float isOcean = oceanAt(vUv);

        // Distinct night floors keep land visibly greener/lighter than ocean.
        vec3 nightLand = vec3(0.094, 0.149, 0.122) + tex * 0.10;   // >= #18261f
        vec3 nightOcean = vec3(0.039, 0.082, 0.149);               // #0a1526
        vec3 night = mix(nightLand, nightOcean, isOcean);

        vec3 lit = tex * (0.42 + 0.58 * max(ndotl, 0.0));

        vec3 color = mix(night, lit, day);

        // Warm dusk band, symmetric around the terminator, fading both ways.
        float duskBand = smoothstepf(twilight * 1.4, 0.0, abs(ndotl));
        vec3 dusk = vec3(0.788, 0.482, 0.243); // #c97b3e
        color = mix(color, color * dusk + dusk * 0.12, duskBand * 0.34);

        // Cool coastline emissive: land/ocean edge, night side only.
        float edge = 0.0;
        edge += abs(isOcean - oceanAt(vUv + vec2(uTexel.x, 0.0)));
        edge += abs(isOcean - oceanAt(vUv - vec2(uTexel.x, 0.0)));
        edge += abs(isOcean - oceanAt(vUv + vec2(0.0, uTexel.y)));
        edge += abs(isOcean - oceanAt(vUv - vec2(0.0, uTexel.y)));
        float coast = clamp(edge, 0.0, 1.0);
        color += vec3(0.29, 0.55, 0.63) * coast * (1.0 - day) * 0.55;

        // Subtle ocean sun glint on the day side only.
        vec3 halfV = normalize(sun + normalize(vViewDir));
        float spec = pow(max(dot(n, halfV), 0.0), 52.0) * isOcean * day * 0.22;
        color += vec3(spec);

        gl_FragColor = vec4(color, 1.0);
      }
    `,
  });
  return { material, uniforms };
}

export interface RimAtmosphere {
  mesh: Mesh;
  uniforms: { uSunDir: { value: Vector3 }; uColor: { value: Color }; uPower: { value: number } };
}

/** Single tight fresnel rim glow on the day-side limb. */
export function createRimAtmosphere(earthRadius: number): RimAtmosphere {
  const uniforms = {
    uSunDir: { value: new Vector3(1, 0, 0) },
    uColor: { value: new Color(0x67e8f9) },
    uPower: { value: 4.6 },
  };
  const material = new ShaderMaterial({
    transparent: true,
    blending: AdditiveBlending,
    side: BackSide,
    depthWrite: false,
    uniforms,
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
        float a = rim * (0.08 + 0.6 * day);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const mesh = new Mesh(new SphereGeometry(earthRadius + 0.12, 64, 32), material);
  return { mesh, uniforms };
}

export interface GraticuleMaterial {
  material: ShaderMaterial;
  uniforms: { uSunDir: { value: Vector3 } };
}

/**
 * Shared whisper-faint graticule material that fades to nothing on the night
 * side (day-side only). `uSunDir` is refreshed each frame from the live sun.
 * One material is shared by every lat/lon line so it is created + disposed once.
 */
export function createGraticuleMaterial(): GraticuleMaterial {
  const uniforms = { uSunDir: { value: new Vector3(1, 0, 0) } };
  const material = new ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms,
    vertexShader: `
      varying float vDay;
      uniform vec3 uSunDir;
      void main() {
        vec3 nW = normalize(mat3(modelMatrix) * normalize(position));
        vDay = smoothstep(0.0, 0.28, dot(nW, normalize(uSunDir)));
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying float vDay;
      void main() {
        gl_FragColor = vec4(vec3(0.404, 0.910, 0.976), 0.05 * vDay);
      }
    `,
  });
  return { material, uniforms };
}

export function makeGraticuleLatLine(
  lat: number,
  earthRadius: number,
  material: ShaderMaterial,
): LineLoop {
  const points: Vector3[] = [];
  for (let lon = -180; lon <= 180; lon += 6) {
    points.push(latLonToVector(lat, lon, earthRadius + 0.012));
  }
  const geometry = new BufferGeometry().setFromPoints(points);
  return new LineLoop(geometry, material);
}

export function makeGraticuleLonLine(
  lon: number,
  earthRadius: number,
  material: ShaderMaterial,
): Line {
  const points: Vector3[] = [];
  for (let lat = -84; lat <= 84; lat += 4) {
    points.push(latLonToVector(lat, lon, earthRadius + 0.014));
  }
  const geometry = new BufferGeometry().setFromPoints(points);
  return new Line(geometry, material);
}

function latLonToVector(lat: number, lon: number, radius: number): Vector3 {
  const phi = ((90 - lat) * Math.PI) / 180;
  const theta = ((lon + 180) * Math.PI) / 180;
  return new Vector3(
    -radius * Math.sin(phi) * Math.cos(theta),
    radius * Math.cos(phi),
    radius * Math.sin(phi) * Math.sin(theta),
  );
}

export interface SurfaceBeacon {
  pulseRing: Mesh;
}

/**
 * ONE thin pulse ring flat on the surface — the single glow per beacon class.
 * `inner`/`outer` are kept close so the stroke reads as a crisp ~2px line; the
 * frame loop expands it 1→1.6× and fades it (or holds it static under
 * reducedMotion) via animateBeaconPulse.
 */
function addPulseRing(
  group: Group,
  color: number,
  inner: number,
  outer: number,
): SurfaceBeacon {
  const pulseRing = new Mesh(
    new RingGeometry(inner, outer, 40),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.5,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  pulseRing.rotation.x = -Math.PI / 2;
  group.add(pulseRing);
  return { pulseRing };
}

/** Crisp small amber pin + one thin pulse ring for the primary command base. */
export function populateBaseBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.03;
  const core = new Mesh(
    new SphereGeometry(s * 0.34, 12, 8),
    new MeshBasicMaterial({ color: 0xffce6a, transparent: true, opacity: 0.95 }),
  );
  const pin = new Mesh(
    new ConeGeometry(s * 0.34, s * 1.15, 16),
    new MeshStandardMaterial({
      color: 0xffb02e,
      emissive: new Color(0xffb02e),
      emissiveIntensity: 1.8,
      roughness: 0.3,
      metalness: 0.2,
    }),
  );
  pin.position.y = s * 0.75;
  group.add(core, pin);
  return addPulseRing(group, 0xffb02e, s * 0.82, s * 0.98);
}

/** Slim cyan pin + one thin pulse ring for secondary radar bases. */
export function populateExtraBaseBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.026;
  const core = new Mesh(
    new SphereGeometry(s * 0.32, 10, 8),
    new MeshBasicMaterial({ color: 0x9fe8f5, transparent: true, opacity: 0.9 }),
  );
  const pin = new Mesh(
    new ConeGeometry(s * 0.32, s * 0.95, 12),
    new MeshStandardMaterial({
      color: 0x38e8d2,
      emissive: new Color(0x38e8d2),
      emissiveIntensity: 1.6,
      roughness: 0.3,
      metalness: 0.2,
    }),
  );
  pin.position.y = s * 0.6;
  group.add(core, pin);
  return addPulseRing(group, 0x38e8d2, s * 0.8, s * 0.96);
}

/** Violet pulsing hex + one thin pulse ring for the revealed endgame alien HQ. */
export function populateHqBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.036;
  // Flat hexagon plate lying tangent to the surface (6-segment ring annulus).
  const hex = new Mesh(
    new RingGeometry(s * 0.5, s * 0.95, 6),
    new MeshBasicMaterial({
      color: 0xc86bff,
      transparent: true,
      opacity: 0.85,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  hex.rotation.x = -Math.PI / 2;
  // Bright violet core dot at the hex centre.
  const core = new Mesh(
    new SphereGeometry(s * 0.28, 12, 10),
    new MeshBasicMaterial({ color: 0xe0a6ff, transparent: true, opacity: 0.95 }),
  );
  core.position.y = s * 0.12;
  group.add(hex, core);
  return addPulseRing(group, 0xc86bff, s * 1.02, s * 1.2);
}

/**
 * Signal-red UFO delta (flat triangular marker) + one thin pulse ring. A tiny
 * `ufoColor` core pip keeps UFO-type variety readable up close while the
 * silhouette always reads red. The airborne trail is drawn separately by the
 * geoscape (the UFO's recent great-circle path).
 */
export function populateUfoBeacon(
  group: Group,
  earthRadius: number,
  _missionColor: number,
  ufoColor: number,
  _urgent: boolean,
): SurfaceBeacon {
  const s = earthRadius * 0.034;
  // Delta: a low 3-sided pyramid (reads as a triangle marker over the surface).
  const delta = new Mesh(
    new ConeGeometry(s * 0.95, s * 0.5, 3),
    new MeshStandardMaterial({
      color: 0xff4a3a,
      emissive: new Color(0xff4a3a),
      emissiveIntensity: 1.9,
      roughness: 0.3,
      metalness: 0.25,
    }),
  );
  delta.position.y = s * 0.4;
  const pip = new Mesh(
    new SphereGeometry(s * 0.2, 10, 8),
    new MeshBasicMaterial({ color: ufoColor, transparent: true, opacity: 0.95 }),
  );
  pip.position.y = s * 0.4;
  group.add(delta, pip);
  return addPulseRing(group, 0xff4a3a, s * 0.86, s * 1.02);
}

/** Amber downed cross + one thin pulse ring for a crashed UFO (assault site). */
export function populateCrashBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.032;
  const bar = new MeshStandardMaterial({
    color: 0xffb02e,
    emissive: new Color(0xffb02e),
    emissiveIntensity: 1.7,
    roughness: 0.35,
    metalness: 0.2,
  });
  // Two thin crossed bars lying tangent to the surface (an "X" downed marker).
  const barA = new Mesh(new BoxGeometry(s * 1.5, s * 0.12, s * 0.28), bar);
  const barB = new Mesh(new BoxGeometry(s * 1.5, s * 0.12, s * 0.28), bar);
  barA.position.y = s * 0.12;
  barB.position.y = s * 0.12;
  barA.rotation.y = Math.PI / 4;
  barB.rotation.y = -Math.PI / 4;
  group.add(barA, barB);
  return addPulseRing(group, 0xffb02e, s * 0.86, s * 1.02);
}

/** Faint procedural cloud wisps for the translucent shell. */
export function makeCloudTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
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

/**
 * Animate a surface pulse ring: expand 1→1.6× while fading, then repeat
 * (a single emitted ring per period). Under reducedMotion the ring holds
 * static at rest scale + a steady opacity.
 */
export function animateBeaconPulse(
  ring: Mesh,
  now: number,
  reducedMotion: boolean,
  periodMs = 2400,
): void {
  const mat = ring.material as MeshBasicMaterial;
  if (reducedMotion) {
    ring.scale.set(1, 1, 1);
    mat.opacity = 0.5;
    return;
  }
  const phase = (now % periodMs) / periodMs; // 0 → 1 sawtooth
  const scale = 1 + phase * 0.6;
  ring.scale.set(scale, scale, 1);
  mat.opacity = 0.55 * (1 - phase);
}
