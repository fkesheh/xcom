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
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  Line,
  LineLoop,
  LinearSRGBColorSpace,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  RingGeometry,
  RepeatWrapping,
  ShaderMaterial,
  SphereGeometry,
  SRGBColorSpace,
  TorusGeometry,
  type Texture,
  TubeGeometry,
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

function drawLatLonOpenPath(
  ctx: CanvasRenderingContext2D,
  points: readonly LatLon[],
  width = GLOBE_MAP_WIDTH,
  height = GLOBE_MAP_HEIGHT,
): void {
  points.forEach(([lat, lon], index) => {
    const [x, y] = mapXY(lat, lon, width, height);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
}

interface ReliefPath {
  points: readonly LatLon[];
  prominence: number;
}

/** Major real-world mountain axes, intentionally simplified for strategic-scale relief. */
const MOUNTAIN_RIDGES: readonly ReliefPath[] = [
  { points: [[59, -128], [51, -121], [43, -114], [35, -108], [27, -103]], prominence: 0.9 },
  { points: [[10, -73], [1, -77], [-12, -75], [-24, -70], [-37, -70], [-49, -73]], prominence: 1.0 },
  { points: [[44, -70], [39, -78], [34, -83]], prominence: 0.45 },
  { points: [[34, -10], [33, 0], [35, 10]], prominence: 0.5 },
  { points: [[46, 5], [46, 12], [45, 18]], prominence: 0.6 },
  { points: [[43, 39], [42, 48]], prominence: 0.55 },
  { points: [[35, 70], [32, 79], [29, 89], [28, 99]], prominence: 1.0 },
  { points: [[50, 84], [48, 96], [46, 108]], prominence: 0.7 },
  { points: [[15, 39], [4, 37], [-8, 35], [-20, 31]], prominence: 0.58 },
  { points: [[-16, 146], [-27, 151], [-37, 149]], prominence: 0.48 },
  { points: [[-42, 172], [-45, 168]], prominence: 0.5 },
] as const;

/** Curved seafloor ridges/trenches replace the old horizontal ocean banding. */
const OCEAN_RELIEF_PATHS: readonly ReliefPath[] = [
  { points: [[66, -28], [45, -32], [25, -42], [3, -27], [-22, -15], [-48, -9]], prominence: 0.8 },
  { points: [[33, -116], [9, -108], [-15, -103], [-38, -111], [-55, -123]], prominence: 0.58 },
  { points: [[25, 63], [5, 67], [-18, 66], [-39, 52]], prominence: 0.62 },
  { points: [[-4, 91], [-17, 100], [-33, 112], [-49, 126]], prominence: 0.55 },
  { points: [[45, 146], [26, 143], [7, 150], [-14, 164]], prominence: 0.42 },
] as const;

export interface EarthTextures {
  /** Hand-painted procedural albedo: bathymetry, biomes, terrain texture, coastlines. */
  color: CanvasTexture;
  /** Separate data mask so snowy / desert land never gets mistaken for ocean in the shader. */
  landMask: CanvasTexture;
}

function polygonBounds(polygon: readonly LatLon[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [lat, lon] of polygon) {
    const [x, y] = mapXY(lat, lon);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Build an original, game-legible Earth surface. The color map deliberately stays
 * stylized (the strategic screen needs readable continents), but gains bathymetric
 * shelves, latitude-driven biomes, small terrain variations, polar ice, and crisp
 * coasts. A separate land mask keeps the shader's lighting logic independent from
 * land colour, so snow and desert can be rendered honestly.
 */
export function makeEarthTextures(): EarthTextures {
  const canvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  canvas.width = maskCanvas.width = GLOBE_MAP_WIDTH;
  canvas.height = maskCanvas.height = GLOBE_MAP_HEIGHT;
  const ctx = canvas.getContext("2d");
  const mask = maskCanvas.getContext("2d");
  if (!ctx || !mask) throw new Error("2D canvas unavailable");

  // Deep water first: a slightly brighter equatorial band and darker polar basins.
  // Curved ridge/trench paths below supply scale without the old horizontal banding.
  const ocean = ctx.createLinearGradient(0, 0, 0, GLOBE_MAP_HEIGHT);
  ocean.addColorStop(0, "#173e5d");
  ocean.addColorStop(0.13, "#0a2847");
  ocean.addColorStop(0.42, "#08345a");
  ocean.addColorStop(0.5, "#0b426a");
  ocean.addColorStop(0.58, "#08345a");
  ocean.addColorStop(0.87, "#0a2847");
  ocean.addColorStop(1, "#173e5d");
  ctx.fillStyle = ocean;
  ctx.fillRect(0, 0, GLOBE_MAP_WIDTH, GLOBE_MAP_HEIGHT);

  const abyss = ctx.createRadialGradient(
    GLOBE_MAP_WIDTH * 0.52,
    GLOBE_MAP_HEIGHT * 0.5,
    GLOBE_MAP_WIDTH * 0.05,
    GLOBE_MAP_WIDTH * 0.52,
    GLOBE_MAP_HEIGHT * 0.5,
    GLOBE_MAP_WIDTH * 0.72,
  );
  abyss.addColorStop(0, "rgba(0,8,24,0)");
  abyss.addColorStop(1, "rgba(0,6,18,0.32)");
  ctx.fillStyle = abyss;
  ctx.fillRect(0, 0, GLOBE_MAP_WIDTH, GLOBE_MAP_HEIGHT);
  for (const ridge of OCEAN_RELIEF_PATHS) {
    ctx.beginPath();
    drawLatLonOpenPath(ctx, ridge.points);
    ctx.strokeStyle = `rgba(0,11,31,${0.18 + ridge.prominence * 0.1})`;
    ctx.lineWidth = 16 + ridge.prominence * 10;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.beginPath();
    drawLatLonOpenPath(ctx, ridge.points);
    ctx.strokeStyle = `rgba(52,148,194,${0.08 + ridge.prominence * 0.08})`;
    ctx.lineWidth = 2.2 + ridge.prominence * 2.2;
    ctx.stroke();
  }

  // Polar caps are painted before land, which lets the land-biome gradient cover
  // them with a more opaque continental ice colour where appropriate.
  for (let y = 0; y < GLOBE_MAP_HEIGHT; y += 3) {
    const lat = 90 - (y / GLOBE_MAP_HEIGHT) * 180;
    const cap = Math.max(0, (Math.abs(lat) - 58) / 32);
    if (cap <= 0) continue;
    ctx.fillStyle = `rgba(185,222,232,${0.025 + cap * cap * 0.19})`;
    ctx.fillRect(0, y, GLOBE_MAP_WIDTH, 3);
  }

  // A soft wide shelf under each coast makes the continental edge read in one
  // glance even before the shader's night coast-light turns on.
  for (const polygon of WORLD_LAND_RINGS) {
    ctx.beginPath();
    drawLatLonPath(ctx, polygon);
    ctx.strokeStyle = "rgba(78,183,202,0.20)";
    ctx.lineWidth = 11;
    ctx.lineJoin = "round";
    ctx.stroke();
  }

  const biome = ctx.createLinearGradient(0, 0, 0, GLOBE_MAP_HEIGHT);
  biome.addColorStop(0, "#edf4f0");
  biome.addColorStop(0.08, "#c4dfb8");
  biome.addColorStop(0.19, "#82bd76");
  biome.addColorStop(0.31, "#c6ae66");
  biome.addColorStop(0.42, "#4da96a");
  biome.addColorStop(0.5, "#36b66e");
  biome.addColorStop(0.58, "#4da96a");
  biome.addColorStop(0.69, "#c6ae66");
  biome.addColorStop(0.81, "#82bd76");
  biome.addColorStop(0.92, "#c4dfb8");
  biome.addColorStop(1, "#edf4f0");

  mask.fillStyle = "#000";
  mask.fillRect(0, 0, GLOBE_MAP_WIDTH, GLOBE_MAP_HEIGHT);
  WORLD_LAND_RINGS.forEach((polygon, polyIndex) => {
    const bounds = polygonBounds(polygon);
    const width = Math.max(1, bounds.maxX - bounds.minX);
    const height = Math.max(1, bounds.maxY - bounds.minY);
    const terrainCount = 15 + Math.floor(hash01(polyIndex, 17.4) * 22);

    // Base biome surface and localized terrain tints, clipped so even tiny islands
    // get texture without dirtying the ocean.
    ctx.save();
    ctx.beginPath();
    drawLatLonPath(ctx, polygon);
    ctx.clip();
    ctx.fillStyle = biome;
    ctx.fillRect(bounds.minX - 2, bounds.minY - 2, width + 4, height + 4);
    for (let i = 0; i < terrainCount; i++) {
      const seed = polyIndex * 97 + i;
      const x = bounds.minX + hash01(seed, 19.1) * width;
      const y = bounds.minY + hash01(seed, 23.7) * height;
      const rx = 8 + hash01(seed, 29.2) * Math.max(14, width * 0.18);
      const ry = 4 + hash01(seed, 31.4) * Math.max(10, height * 0.09);
      const dry = hash01(seed, 37.1);
      ctx.fillStyle = dry > 0.7
        ? `rgba(223,178,91,${0.13 + hash01(seed, 41.8) * 0.11})`
        : `rgba(9,67,38,${0.10 + hash01(seed, 43.3) * 0.13})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, (hash01(seed, 47.9) - 0.5) * 0.9, 0, Math.PI * 2);
      ctx.fill();
    }
    // Faint ridges supply relief cues when the camera is close, while clipping
    // guarantees they never draw across the sea.
    for (let i = 0; i < Math.max(2, Math.floor(terrainCount * 0.45)); i++) {
      const seed = polyIndex * 61 + i;
      const x = bounds.minX + hash01(seed, 53.2) * width;
      const y = bounds.minY + hash01(seed, 59.8) * height;
      const length = 10 + hash01(seed, 61.7) * Math.max(18, width * 0.18);
      ctx.strokeStyle = `rgba(239,213,156,${0.11 + hash01(seed, 67.9) * 0.10})`;
      ctx.lineWidth = 1.0 + hash01(seed, 71.3) * 0.9;
      ctx.beginPath();
      ctx.moveTo(x - length * 0.5, y + Math.sin(seed) * 3);
      ctx.quadraticCurveTo(x, y - 5 - hash01(seed, 73.6) * 10, x + length * 0.5, y + Math.cos(seed) * 3);
      ctx.stroke();
    }
    ctx.restore();

    ctx.beginPath();
    drawLatLonPath(ctx, polygon);
    ctx.strokeStyle = "rgba(144,232,221,0.66)";
    ctx.lineWidth = 1.15;
    ctx.lineJoin = "round";
    ctx.stroke();

    mask.beginPath();
    drawLatLonPath(mask, polygon);
    mask.fillStyle = "#fff";
    mask.fill();
  });

  // Major mountain systems get a three-tone relief stroke in the albedo. The
  // matching raised geometry (createMountainRelief) catches the sun separately,
  // so these ranges read both from orbit and at close zoom.
  for (const ridge of MOUNTAIN_RIDGES) {
    ctx.beginPath();
    drawLatLonOpenPath(ctx, ridge.points);
    ctx.strokeStyle = `rgba(45,48,34,${0.34 + ridge.prominence * 0.14})`;
    ctx.lineWidth = 3 + ridge.prominence * 3.5;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.stroke();
    ctx.beginPath();
    drawLatLonOpenPath(ctx, ridge.points);
    ctx.strokeStyle = `rgba(159,145,103,${0.48 + ridge.prominence * 0.16})`;
    ctx.lineWidth = 1.7 + ridge.prominence * 1.8;
    ctx.stroke();
    ctx.beginPath();
    drawLatLonOpenPath(ctx, ridge.points);
    ctx.strokeStyle = `rgba(240,227,192,${0.34 + ridge.prominence * 0.18})`;
    ctx.lineWidth = 0.55 + ridge.prominence * 0.55;
    ctx.stroke();
  }

  const color = new CanvasTexture(canvas);
  const landMask = new CanvasTexture(maskCanvas);
  // Both maps are sampled directly by a raw ShaderMaterial, so retain authored
  // canvas values rather than applying an implicit sRGB decode in the shader path.
  color.colorSpace = LinearSRGBColorSpace;
  landMask.colorSpace = LinearSRGBColorSpace;
  return { color, landMask };
}

export interface EarthShader {
  material: ShaderMaterial;
  uniforms: {
    uMap: { value: Texture };
    uNormalMap: { value: Texture };
    uSpecularMap: { value: Texture };
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
export function createEarthShaderMaterial(
  map: Texture,
  normalMap: Texture,
  specularMap: Texture,
): EarthShader {
  const uniforms = {
    uMap: { value: map },
    uNormalMap: { value: normalMap },
    uSpecularMap: { value: specularMap },
    uSunDir: { value: new Vector3(1, 0, 0) },
    uTexel: { value: new Vector2(1 / 2048, 1 / 1024) },
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
      uniform sampler2D uNormalMap;
      uniform sampler2D uSpecularMap;
      uniform vec3 uSunDir;
      uniform vec2 uTexel;

      float smoothstepf(float e0, float e1, float x) {
        float t = clamp((x - e0) / (e1 - e0), 0.0, 1.0);
        return t * t * (3.0 - 2.0 * t);
      }

      float oceanAt(vec2 uv) {
        return smoothstep(0.34, 0.72, texture2D(uSpecularMap, uv).r);
      }

      void main() {
        vec3 tex = texture2D(uMap, vUv).rgb;
        vec3 sphereNormal = normalize(vNormalW);
        vec3 tangentNormal = texture2D(uNormalMap, vUv).rgb * 2.0 - 1.0;
        tangentNormal.xy *= 0.72;
        vec3 axis = abs(sphereNormal.y) > 0.97 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 east = normalize(cross(axis, sphereNormal));
        vec3 north = normalize(cross(sphereNormal, east));
        vec3 n = normalize(east * tangentNormal.x + north * tangentNormal.y + sphereNormal * tangentNormal.z);
        vec3 sun = normalize(uSunDir);
        float ndotl = dot(n, sun);

        // ~12° twilight half-band (sin 12° ≈ 0.21).
        float twilight = 0.21;
        float day = smoothstepf(-twilight, twilight, ndotl);

        float isOcean = oceanAt(vUv);
        float isLand = 1.0 - isOcean;

        // Distinct night floors keep land visibly greener/lighter than ocean.
        vec3 nightLand = vec3(0.094, 0.149, 0.122) + tex * 0.10;   // >= #18261f
        vec3 nightOcean = vec3(0.039, 0.082, 0.149);               // #0a1526
        vec3 night = mix(nightLand, nightOcean, isOcean);

        float diffuse = max(ndotl, 0.0);
        vec3 lit = tex * (0.72 + 0.28 * diffuse);

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
        float spec = pow(max(dot(n, halfV), 0.0), 58.0) * isOcean * day * 0.30;
        float fresnel = pow(1.0 - max(0.0, dot(normalize(vViewDir), n)), 3.0) * isOcean * day;
        color += vec3(spec) + vec3(0.025, 0.11, 0.16) * fresnel;

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

function sampleReliefPath(path: ReliefPath, earthRadius: number, pathIndex: number): Vector3[] {
  const sampled: Vector3[] = [];
  for (let i = 0; i < path.points.length - 1; i++) {
    const [fromLat, fromLon] = path.points[i]!;
    const [toLat, toLon] = path.points[i + 1]!;
    const from = latLonToVector(fromLat, fromLon, 1).normalize();
    const to = latLonToVector(toLat, toLon, 1).normalize();
    const angle = from.angleTo(to);
    const steps = Math.max(3, Math.ceil(angle / 0.035));
    for (let j = i === 0 ? 0 : 1; j <= steps; j++) {
      const t = j / steps;
      const normal = from.clone().lerp(to, t).normalize();
      const peak = Math.sin(Math.PI * t);
      const rough = (hash01(pathIndex * 101 + i * 17 + j, 109.7) - 0.5) * 0.004;
      const lift = 0.004 + path.prominence * (0.007 + peak * 0.005) + rough * 0.6;
      sampled.push(normal.multiplyScalar(earthRadius + lift));
    }
  }
  return sampled;
}

/**
 * Raised, low-poly mountain chains following the same real-world axes painted into
 * the albedo. They are intentionally shallow enough to stay below the cloud shell,
 * but their faceted normals catch the moving sun and finally give the land physical
 * relief at close geoscape zoom.
 */
export function createMountainRelief(earthRadius: number): Group {
  const group = new Group();
  const rock = new MeshStandardMaterial({
    color: 0xb0aa8b,
    emissive: new Color(0x68624b),
    emissiveIntensity: 0.45,
    roughness: 0.96,
    metalness: 0,
    flatShading: true,
  });
  MOUNTAIN_RIDGES.forEach((ridge, index) => {
    const points = sampleReliefPath(ridge, earthRadius, index);
    if (points.length < 4) return;
    const curve = new CatmullRomCurve3(points, false, "centripetal", 0.35);
    const geometry = new TubeGeometry(
      curve,
      Math.max(12, points.length * 2),
      0.0018 + ridge.prominence * 0.0024,
      5,
      false,
    );
    const mesh = new Mesh(geometry, rock);
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
  });
  return group;
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
 * Compact alien saucer for an airborne UFO: a dark alloy hull, signal-red rim,
 * type-coloured dome, and three running lights. It stays legible as a hostile at
 * globe scale without collapsing into a generic map pin; the separate pulse ring
 * and flight trail carry long-range readability.
 */
export function populateUfoBeacon(
  group: Group,
  earthRadius: number,
  _missionColor: number,
  ufoColor: number,
  _urgent: boolean,
): SurfaceBeacon {
  const s = earthRadius * 0.034;
  const hull = new Mesh(
    new SphereGeometry(s * 0.78, 16, 10),
    new MeshStandardMaterial({
      color: 0x281727,
      emissive: new Color(0x4a1524),
      emissiveIntensity: 0.9,
      roughness: 0.26,
      metalness: 0.68,
    }),
  );
  hull.scale.y = 0.25;
  hull.position.y = s * 0.42;
  const rim = new Mesh(
    new TorusGeometry(s * 0.64, s * 0.075, 8, 24),
    new MeshStandardMaterial({
      color: 0xff5c4d,
      emissive: new Color(0xff3724),
      emissiveIntensity: 1.5,
      roughness: 0.22,
      metalness: 0.54,
    }),
  );
  rim.rotation.x = Math.PI / 2;
  rim.position.y = s * 0.42;
  const dome = new Mesh(
    new SphereGeometry(s * 0.32, 14, 10),
    new MeshStandardMaterial({
      color: ufoColor,
      emissive: new Color(ufoColor),
      emissiveIntensity: 1.25,
      roughness: 0.12,
      metalness: 0.42,
    }),
  );
  dome.scale.y = 0.52;
  dome.position.y = s * 0.62;
  const antenna = new Mesh(
    new CylinderGeometry(s * 0.028, s * 0.045, s * 0.28, 7),
    new MeshBasicMaterial({ color: 0xffb4a7, transparent: true, opacity: 0.9 }),
  );
  antenna.position.y = s * 0.9;
  const lights = new MeshBasicMaterial({
    color: 0xff6958,
    transparent: true,
    opacity: 0.95,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const runningLights = [
    [0, s * 0.42, s * 0.68],
    [s * 0.59, s * 0.42, -s * 0.32],
    [-s * 0.59, s * 0.42, -s * 0.32],
  ] as const;
  for (const [x, y, z] of runningLights) {
    const light = new Mesh(new SphereGeometry(s * 0.075, 8, 6), lights);
    light.position.set(x, y, z);
    group.add(light);
  }
  group.add(hull, rim, dome, antenna);
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

function smoothNoise(edge0: number, edge1: number, value: number): number {
  const t = Math.max(0, Math.min(1, (value - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function periodicValueNoise(x: number, y: number, periodX: number, periodY: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const hash = (gx: number, gy: number): number => {
    const wx = ((gx % periodX) + periodX) % periodX;
    const wy = ((gy % periodY) + periodY) % periodY;
    return hash01(wx + wy * periodX, 127.9 + periodX * 0.37);
  };
  const a = hash(x0, y0);
  const b = hash(x0 + 1, y0);
  const c = hash(x0, y0 + 1);
  const d = hash(x0 + 1, y0 + 1);
  const top = a + (b - a) * sx;
  const bottom = c + (d - c) * sx;
  return top + (bottom - top) * sy;
}

function cloudFbm(u: number, v: number): number {
  let total = 0;
  let weight = 0;
  const periods = [6, 12, 24, 48] as const;
  periods.forEach((period, octave) => {
    const py = Math.max(3, period / 2);
    const shear = Math.sin(v * Math.PI * (3 + octave)) * (0.32 + octave * 0.08);
    const amplitude = 1 / (1 << octave);
    total += periodicValueNoise(u * period + shear, v * py, period, py) * amplitude;
    weight += amplitude;
  });
  return total / weight;
}

/**
 * Procedural cloud deck for the translucent shell. Thresholded, periodic fractal
 * noise forms connected cloud masses; curved fronts add cyclonic weather bands.
 * Horizontal wrapping is seamless at the Pacific texture seam.
 */
export function makeCloudTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");
  const image = ctx.createImageData(canvas.width, canvas.height);
  for (let y = 0; y < canvas.height; y++) {
    const v = y / canvas.height;
    const latitude = (0.5 - v) * Math.PI;
    const polarFade = 1 - smoothNoise(0.78, 1, Math.abs(latitude) / (Math.PI * 0.5));
    const stormBands = 0.055 * Math.sin(latitude * 7.0) + 0.035 * Math.sin(latitude * 13.0);
    for (let x = 0; x < canvas.width; x++) {
      const u = x / canvas.width;
      const density = cloudFbm(u, v) + stormBands;
      const mass = smoothNoise(0.59, 0.77, density) * (0.46 + polarFade * 0.54);
      const wisps = smoothNoise(0.56, 0.72, density) * 0.07;
      const alpha = Math.round(Math.min(0.62, mass * 0.42 + wisps) * 255);
      const idx = (y * canvas.width + x) * 4;
      image.data[idx] = 242 + Math.round(mass * 13);
      image.data[idx + 1] = 248 + Math.round(mass * 7);
      image.data[idx + 2] = 252 + Math.round(mass * 3);
      image.data[idx + 3] = alpha;
    }
  }
  ctx.putImageData(image, 0, 0);

  // Curved partial ellipses read as fronts/spiral arms without becoming opaque
  // rings. Their low alpha layers over the fractal deck and survives minification.
  for (let i = 0; i < 18; i++) {
    const cx = hash01(i, 137.3) * canvas.width;
    const cy = (0.12 + hash01(i, 139.7) * 0.76) * canvas.height;
    const rx = 24 + hash01(i, 149.1) * 62;
    const ry = 5 + hash01(i, 151.9) * 16;
    const rotation = (hash01(i, 157.6) - 0.5) * 0.7;
    const start = hash01(i, 163.2) * Math.PI;
    ctx.strokeStyle = `rgba(238,250,255,${0.035 + hash01(i, 167.4) * 0.045})`;
    ctx.lineWidth = 1 + hash01(i, 173.8) * 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, rx, ry, rotation, start, start + Math.PI * (0.8 + hash01(i, 179.5) * 0.75));
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
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
