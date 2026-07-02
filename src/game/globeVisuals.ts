/**
 * Procedural globe visuals — equirectangular earth texture, day/night shader,
 * atmosphere rim, faint graticule, and surface beacon markers.
 *
 * Wired from geoscape.ts; all assets are canvas/procedural (no network fetches).
 */

import {
  AdditiveBlending,
  BackSide,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
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
  };
}

/** Day/night earth material with soft twilight band, night floor, and ocean glint. */
export function createEarthShaderMaterial(map: CanvasTexture): EarthShader {
  const uniforms = {
    uMap: { value: map },
    uSunDir: { value: new Vector3(1, 0, 0) },
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

      float smoothstepf(float e0, float e1, float x) {
        float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }

      void main() {
        vec3 tex = texture2D(uMap, vUv).rgb;
        vec3 n = normalize(vNormalW);
        vec3 sun = normalize(uSunDir);
        float ndotl = dot(n, sun);

        float twilight = 0.17;
        float day = smoothstepf(-twilight, twilight, ndotl);

        vec3 lit = tex * (0.42 + 0.58 * max(ndotl, 0.0));
        vec3 night = tex * vec3(0.38, 0.48, 0.72) + vec3(0.05, 0.07, 0.11);
        night = max(night, vec3(0.15, 0.18, 0.24));

        float duskBand = smoothstepf(twilight * 1.4, 0.0, abs(ndotl));
        vec3 dusk = vec3(1.0, 0.78, 0.52);
        vec3 color = mix(night, lit, day);
        color = mix(color, color * dusk, duskBand * 0.32);

        float isOcean = step(tex.g + 0.06, tex.b);
        vec3 halfV = normalize(sun + normalize(vViewDir));
        float spec = pow(max(dot(n, halfV), 0.0), 52.0) * isOcean * day * 0.28;
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

/** Fresnel rim glow on the day-side limb. */
export function createRimAtmosphere(earthRadius: number): RimAtmosphere {
  const uniforms = {
    uSunDir: { value: new Vector3(1, 0, 0) },
    uColor: { value: new Color(0x67e8f9) },
    uPower: { value: 3.2 },
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
        float a = rim * (0.12 + 0.65 * day);
        gl_FragColor = vec4(uColor, a);
      }
    `,
  });
  const mesh = new Mesh(new SphereGeometry(earthRadius + 0.17, 64, 32), material);
  return { mesh, uniforms };
}

export function makeGraticuleLatLine(lat: number, earthRadius: number): LineLoop {
  const points: Vector3[] = [];
  for (let lon = -180; lon <= 180; lon += 6) {
    points.push(latLonToVector(lat, lon, earthRadius + 0.012));
  }
  const geometry = new BufferGeometry().setFromPoints(points);
  const material = new LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.035 });
  return new LineLoop(geometry, material);
}

export function makeGraticuleLonLine(lon: number, earthRadius: number): Line {
  const points: Vector3[] = [];
  for (let lat = -84; lat <= 84; lat += 4) {
    points.push(latLonToVector(lat, lon, earthRadius + 0.014));
  }
  const geometry = new BufferGeometry().setFromPoints(points);
  const material = new LineBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.03 });
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

function addPulseRing(
  group: Group,
  color: number,
  inner: number,
  outer: number,
): SurfaceBeacon {
  const pulseRing = new Mesh(
    new RingGeometry(inner, outer, 24),
    new MeshBasicMaterial({
      color,
      transparent: true,
      opacity: 0.42,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  pulseRing.rotation.x = -Math.PI / 2;
  group.add(pulseRing);
  return { pulseRing };
}

/** Crisp amber emissive beacon for the primary command base. */
export function populateBaseBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.04;
  const core = new Mesh(
    new SphereGeometry(s * 0.55, 12, 8),
    new MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: new Color(0xf59e0b),
      emissiveIntensity: 2.2,
      roughness: 0.25,
      metalness: 0.2,
    }),
  );
  const pin = new Mesh(
    new ConeGeometry(s * 0.45, s * 1.4, 14),
    new MeshStandardMaterial({
      color: 0xfbbf24,
      emissive: new Color(0xf59e0b),
      emissiveIntensity: 1.6,
      roughness: 0.3,
      metalness: 0.25,
    }),
  );
  pin.position.y = s * 0.75;
  const dome = new Mesh(
    new SphereGeometry(s * 0.7, 14, 10, 0, Math.PI * 2, 0, Math.PI * 0.5),
    new MeshBasicMaterial({
      color: 0xfbbf24,
      transparent: true,
      opacity: 0.35,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  group.add(core, pin, dome);
  return addPulseRing(group, 0xfbbf24, s * 1.1, s * 1.55);
}

/** Slim cyan beacon for secondary radar bases. */
export function populateExtraBaseBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.032;
  const core = new Mesh(
    new SphereGeometry(s * 0.5, 10, 8),
    new MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: new Color(0x22d3ee),
      emissiveIntensity: 2.0,
      roughness: 0.25,
      metalness: 0.2,
    }),
  );
  const pin = new Mesh(
    new ConeGeometry(s * 0.4, s * 1.1, 12),
    new MeshStandardMaterial({
      color: 0x67e8f9,
      emissive: new Color(0x22d3ee),
      emissiveIntensity: 1.4,
      roughness: 0.3,
      metalness: 0.25,
    }),
  );
  pin.position.y = s * 0.6;
  group.add(core, pin);
  return addPulseRing(group, 0x67e8f9, s * 0.95, s * 1.35);
}

/** Menacing violet/magenta endgame HQ spire. */
export function populateHqBeacon(group: Group, earthRadius: number): SurfaceBeacon {
  const s = earthRadius * 0.042;
  const core = new Mesh(
    new SphereGeometry(s * 0.65, 14, 10),
    new MeshBasicMaterial({
      color: 0xc060ff,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
    }),
  );
  const spike = new Mesh(
    new ConeGeometry(s * 0.55, s * 2.0, 6),
    new MeshStandardMaterial({
      color: 0x3b0764,
      emissive: new Color(0xc060ff),
      emissiveIntensity: 2.4,
      roughness: 0.22,
      metalness: 0.5,
    }),
  );
  spike.position.y = s * 1.05;
  const under = new Mesh(
    new ConeGeometry(s * 0.35, s * 0.85, 6),
    new MeshStandardMaterial({
      color: 0x3b0764,
      emissive: new Color(0xa855f7),
      emissiveIntensity: 1.8,
      roughness: 0.22,
      metalness: 0.5,
    }),
  );
  under.rotation.x = Math.PI;
  under.position.y = -s * 0.45;
  const halo = new Mesh(
    new RingGeometry(s * 1.35, s * 1.65, 28),
    new MeshBasicMaterial({
      color: 0xe879f9,
      transparent: true,
      opacity: 0.38,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  halo.rotation.x = -Math.PI / 2;
  group.add(core, spike, under, halo);
  return addPulseRing(group, 0xc060ff, s * 1.2, s * 1.75);
}

/** Mission-colored UFO beacon with optional urgent halo. */
export function populateUfoBeacon(
  group: Group,
  earthRadius: number,
  missionColor: number,
  ufoColor: number,
  urgent: boolean,
): SurfaceBeacon {
  const s = earthRadius * 0.038;
  const core = new Mesh(
    new SphereGeometry(s * 0.55, 14, 10),
    new MeshBasicMaterial({
      color: missionColor,
      transparent: true,
      opacity: 0.95,
      blending: AdditiveBlending,
    }),
  );
  const disc = new Mesh(
    new CylinderGeometry(s * 0.85, s * 0.85, s * 0.22, 18),
    new MeshStandardMaterial({
      color: missionColor,
      emissive: new Color(missionColor),
      emissiveIntensity: 1.6,
      roughness: 0.35,
      metalness: 0.4,
    }),
  );
  disc.position.y = s * 0.35;
  const beam = new Mesh(
    new ConeGeometry(s * 0.35, s * 1.0, 14),
    new MeshBasicMaterial({
      color: missionColor,
      transparent: true,
      opacity: 0.5,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  beam.position.y = s * 0.75;
  const typeRing = new Mesh(
    new RingGeometry(s * 1.45, s * 1.65, 24),
    new MeshBasicMaterial({
      color: ufoColor,
      transparent: true,
      opacity: 0.45,
      side: DoubleSide,
      blending: AdditiveBlending,
      depthWrite: false,
    }),
  );
  typeRing.rotation.x = -Math.PI / 2;
  group.add(core, disc, beam, typeRing);
  if (urgent) {
    const halo = new Mesh(
      new RingGeometry(s * 1.05, s * 1.25, 24),
      new MeshBasicMaterial({
        color: missionColor,
        transparent: true,
        opacity: 0.4,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    halo.rotation.x = -Math.PI / 2;
    group.add(halo);
  }
  return addPulseRing(group, missionColor, s * 1.0, s * 1.4);
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

/** Animate expanding surface pulse rings (respect reducedMotion). */
export function animateBeaconPulse(ring: Mesh, now: number, reducedMotion: boolean, speed = 0.005): void {
  if (reducedMotion) {
    ring.scale.set(1, 1, 1);
    return;
  }
  const phase = (Math.sin(now * speed) + 1) * 0.5;
  const scale = 1 + phase * 0.55;
  ring.scale.set(scale, scale, 1);
  (ring.material as MeshBasicMaterial).opacity = 0.48 * (1 - phase * 0.72);
}
