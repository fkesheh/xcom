import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EdgesGeometry,
  Fog,
  Group,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  PCFSoftShadowMap,
  PointLight,
  Raycaster,
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";

import {
  CONTAINMENT_CAPACITY,
  findBaseFacility,
  facilityCost,
  STARTER_BASE_GRID,
  type BaseFacility,
  type FacilityKind,
  summarizeBaseFacilities,
} from "../campaign/base";
import {
  allBases,
  availableItemCount,
  availableWeaponCount,
  availableBaseFacilities,
  CAMPAIGN_WEAPON_IDS,
  canAssignSoldierItem,
  canAssignSoldierWeapon,
  canBuildFacility,
  canDeploySoldier,
  canPurchaseWeapon,
  canRecruitSoldier,
  canStartResearch,
  CAPTIVE_RANK_ORDER,
  campaignSoldierStatBonus,
  constructedFacilities,
  DEPLOYMENT_SIZE,
  deploymentSoldiers,
  difficultyConfig,
  facilityConstructionDuration,
  hasContainment,
  hasResearch,
  RECRUIT_COST,
  type ManufacturingProject,
  MANUFACTURING_PROJECTS,
  MARKET_CONFIG,
  MAX_EXTRA_BASES,
  type ResearchProject,
  RESEARCH_PROJECTS,
  canStartManufacturing,
  craftHullPoints,
  craftSpeedDegPerHour,
  craftWeaponPower,
  DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR,
  freeHangarSlots,
  manufacturingCost,
  manufacturingDuration,
  researchDuration,
  researchCost,
  researchTree,
  soldierItemIds,
  soldierWeaponId,
} from "../campaign/storage";
import { generateOperation } from "../campaign/operations";
import type {
  CampaignCaptive,
  CampaignSoldier,
  CampaignState,
  CampaignWeaponId,
  Craft,
  ManufacturingProjectId,
  OperationPlan,
  ResearchId,
  UfoContact,
} from "../campaign/types";
import { ITEMS, TEMPLATES, WEAPONS } from "../sim/content";
import {
  accentMaterial,
  BASE_PALETTE,
  concreteMaterial,
  rockMaterial,
  steelMaterial,
  type FacilityRole,
} from "./basePalette";
import { buildFacilityModel } from "./baseFacilities";
import { buildFacilityInterior } from "./baseFacilityInteriors";
import { CrewSystem } from "./basePeople";
import { UI_TOKENS, UI_BASE, UI_COMPONENTS, UI_PRIMITIVES } from "./uiTheme";
import { createCarousel, type CarouselHandle, type CarouselItem } from "./uiCarousel";
import {
  formatCredits,
  formatSignedCredits,
  formatHours,
  formatPercent,
  formatSpeed,
} from "./uiFormat";

/** Global-alert kinds the geoscape (NAV) can surface to a mounted base view.
 *  BASE owns the kind→facility mapping ({@link ALERT_FACILITY}); NAV only passes
 *  a kind + human-readable message and never names a FacilityKind. */
export type BaseAlertKind =
  | "ufoDetected"
  | "ufoShotDown"
  | "ufoLanded"
  | "interceptionReport"
  | "fundingReport"
  | "missionReport"
  | "campaignWon"
  | "campaignLost";

/** A strategic event routed to the base view as a toast + a pulsing facility
 *  beacon. Delivered via {@link BaseView.pushAlert}. */
export interface BaseAlert {
  kind: BaseAlertKind;
  message: string;
}

interface BaseViewOptions {
  campaign: CampaignState;
  operation: OperationPlan;
  onStartResearch: (id: ResearchId) => void;
  onBuildFacility: (id: string) => void;
  onRecruitSoldier: () => void;
  onAssignWeapon: (soldierId: string, weaponId: CampaignWeaponId) => void;
  onAssignItem?: (soldierId: string, itemId: string) => void;
  onUnassignItem?: (soldierId: string, itemId: string) => void;
  onToggleDeployment: (soldierId: string, deployed: boolean) => void;
  onStartManufacturing: (id: ManufacturingProjectId) => void;
  onPurchaseWeapon?: (weaponId: CampaignWeaponId) => void;
  /** Clicking the Command Center facility opens the geoscape (NAV mounts it) —
   *  the command room IS the geoscape, so BASE never renders a DOM room for it. */
  onEnterCommandCenter: () => void;
  onResetCampaign: () => void;
}

/** Every FacilityKind must resolve so `window.__baseEnterRoom` and the test
 *  hooks stay strongly typed. */
declare global {
  interface Window {
    /** Deterministic Playwright room-entry hook — mirrors an on-canvas facility
     *  click for the given kind (command opens the geoscape; others dive into
     *  the facility interior + room). Added on mount, removed on dispose. */
    __baseEnterRoom?: (kind: FacilityKind) => void;
  }
}

const STYLE_ID = "blacksite-base-style";
const CELL = 1.32;
const ROOM_GAP = 0.12;
const BASE_VIEW_YAW = -0.56;

/** Consumable item ids rendered in the barracks backpack, in display order. */
const ITEM_IDS: readonly string[] = Object.keys(ITEMS);
/** Per-item glyph shown beside the label (label always present — never color alone). */
const ITEM_ICON: Record<string, string> = { grenade: "◆", medkit: "✚", stunRod: "⚡" };
/** Max copies of a single item type one soldier may carry. */
const MAX_ITEM_CARRY = 3;

/** Rank insignia glyph shown beside a soldier's name in the barracks dossier —
 *  a quick visual ladder (rank word is always shown too, so it's never color/
 *  glyph alone). */
const RANK_INSIGNIA: Record<string, string> = {
  rookie: "•",
  squaddie: "❭",
  sergeant: "❭❭",
  captain: "★",
};

/** Display name for a captive's sim template id (mirrors sim/content.ts
 *  TEMPLATES names — hardcoded here rather than importing sim content, matching
 *  how ITEM_ICON labels items above). */
const CAPTIVE_SPECIES: Record<string, string> = {
  drone: "Drone",
  stalker: "Stalker",
  sentinel: "Sentinel",
  heavy: "Heavy",
  commander: "Commander",
};

/** Cardinal direction on the base grid. `cellCenter` maps grid +y to world +z,
 *  so north = -y/-z, south = +y/+z, east = +x, west = -x. */
export type CorridorDir = "north" | "south" | "east" | "west";

/** One paved hallway tile — a free grid cell the router turned into corridor.
 *  `open` = sides that seamlessly join another corridor tile; `doors` = sides
 *  that open onto a constructed facility's bay (a doorway threshold); every
 *  remaining side is a rock/pad WALL. Coordinates are grid cells (world via
 *  cellCenter). */
export interface CorridorTile {
  cx: number;
  cy: number;
  open: CorridorDir[];
  doors: CorridorDir[];
}

/** An orthogonal hop between two adjacent corridor tiles — the travel edges the
 *  strip-lights and crew follow. `axis` is the world axis the hop runs along. */
export interface CorridorSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  axis: "x" | "z";
}

/** The routed corridor network, DERIVED from the live facility layout (never
 *  hardcoded). All coordinates are grid cells — convert with the same mapping as
 *  {@link BaseView.getCorridorWaypointLoops}. Exposed via
 *  {@link BaseView.getCorridorGraph} so the crew/people system can walk
 *  personnel along real hallways.
 *  - `tiles`    one entry per paved cell (floor + walls + doorways)
 *  - `segments` adjacent-tile hops (strip-light + crew travel edges)
 *  - `patrols`  one ordered out-and-back loop per connected component with >=2
 *               tiles; consecutive cells AND the closing wrap are always
 *               orthogonally adjacent, so crew never cut across a bay.
 *  - `spine`    index into `patrols` of the component that reaches the access
 *               lift (the main spine), or -1 if none. */
export interface CorridorGraph {
  tiles: CorridorTile[];
  segments: CorridorSegment[];
  patrols: Array<Array<readonly [number, number]>>;
  spine: number;
}

/** Cardinal steps in stable N/E/S/W order — the single source of adjacency for
 *  routing (flood fill, doorway scan, Euler tour) so every pass is deterministic. */
const CORRIDOR_DIRS: ReadonlyArray<readonly [CorridorDir, number, number]> = [
  ["north", 0, -1],
  ["east", 1, 0],
  ["south", 0, 1],
  ["west", -1, 0],
];

/** Corridor curb height/thickness (also used for curb placement offsets). */
const CURB_H = 0.16;
const CURB_T = 0.07;
/**
 * The corridor's fixed set of constant-dimension tile/strip geometries, derived
 * from CELL and built ONCE at module scope — instead of a fresh BoxGeometry per
 * paved tile/segment (~6+ per tile over ~10-15 tiles). Shared across every tile
 * AND every BaseView instance; tagged so a view teardown never frees them.
 */
const CORRIDOR_GEO = (() => {
  const span = CELL - 0.28;
  const wallLen = span * 0.9;
  const thLen = span * 0.5;
  const runLen = CELL * 0.62;
  const g = {
    floor: new BoxGeometry(span, 0.08, span),
    thresholdX: new BoxGeometry(thLen, 0.02, 0.06),
    thresholdZ: new BoxGeometry(0.06, 0.02, thLen),
    curbX: new BoxGeometry(wallLen, CURB_H, CURB_T),
    curbZ: new BoxGeometry(CURB_T, CURB_H, wallLen),
    stripX: new BoxGeometry(wallLen * 0.9, 0.02, 0.04),
    stripZ: new BoxGeometry(0.04, 0.02, wallLen * 0.9),
    center: new BoxGeometry(0.14, 0.008, 0.14),
    railX: new BoxGeometry(runLen, 0.01, 0.03),
    railZ: new BoxGeometry(0.03, 0.01, runLen),
  } as const;
  for (const geo of Object.values(g)) geo.userData.shared = true;
  return g;
})();

type RotationAxis = "x" | "y" | "z";

interface BaseRotator {
  object: Group | Mesh;
  axis: RotationAxis;
  speed: number;
  baseRotation: number;
}

/** A research project paired with its current tree status. Derived from
 *  {@link researchTree}'s return type so it tracks the campaign layer's shape. */
type ResearchTreeNode = ReturnType<typeof researchTree>[number];

const CSS = UI_TOKENS + "\n" + UI_BASE + "\n" + UI_COMPONENTS + "\n" + UI_PRIMITIVES + "\n" + `
#base-view {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: var(--ui-text);
  background:
    radial-gradient(circle at 42% 48%, rgba(22,60,76,.5), transparent 40%),
    linear-gradient(160deg, #02070d, #07131d 54%, #010308);
  font: var(--ui-text-base)/1.45 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .01em;
}
#base-view::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(circle at 46% 54%, transparent 30%, rgba(0,0,0,.85) 100%);
}
#base-view canvas,
#base-view .base-canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
#base-view .base-canvas { z-index: 0; }
#base-view .base-topbar {
  position: absolute;
  top: 0; left: 0; right: 0;
  z-index: 5;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-sp-4);
  height: 52px;
  padding: 0 var(--ui-sp-4);
  box-sizing: border-box;
  border-bottom: 1px solid var(--ui-border-console);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow-sm);
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
}
#base-view .topbar-brand {
  display: flex;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
#base-view .brand-name {
  color: var(--ui-cyan);
  font: 800 var(--ui-text-sm)/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .22em;
  text-transform: uppercase;
}
#base-view .brand-region {
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .brand-clock {
  color: var(--ui-amber);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .06em;
}
#base-view .topbar-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--ui-sp-2);
  min-width: 0;
}
#base-view .topbar-right { display: flex; align-items: center; gap: 10px; }
#base-view .topbar-tools { display: flex; gap: 8px; }
#base-view .help-btn {
  min-width: 30px;
  height: 30px;
  padding: 0;
  border-radius: 7px;
  border: 1px solid rgba(103,232,249,.4);
  color: var(--ui-cyan);
  background: rgba(8,28,40,.7);
  font: 800 var(--ui-text-md)/1 ui-monospace, monospace;
  cursor: pointer;
}
#base-view .help-btn:hover { border-color: rgba(103,232,249,.9); background: rgba(14,52,67,.9); }
/* Base topbar stat chips share the .ui-chip primitive so they read as one system
   with the geoscape stat strip. The label is hidden on the narrowest chips to keep
   the strip compact; icon + value always show. */
#base-view .topbar-chips .ui-chip { flex: 0 0 auto; }
/* The base sidebar is a console-glass .ui-panel: a flex column that NEVER scrolls
   as a whole. Its fixed header (operation card) stays pinned while only the body
   scrolls — this is the fix for the "ridiculously bad" clipping panel. .base-sidebar
   contributes ONLY positioning/size; the surface (bg/border/radius/flex) comes from
   .ui-panel so it can't reintroduce the whole-panel overflow. */
#base-view .base-sidebar {
  position: absolute;
  top: 64px;
  right: 12px;
  bottom: 12px;
  width: min(380px, calc(100vw - 24px));
  z-index: 4;
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
}
/* Fixed header region: holds the operation card, never scrolls with the body.
   A max-height + internal scroll is a safety net for extreme short viewports so a
   very tall header can never clip or eat the whole panel. */
#base-view .sidebar-header {
  flex: 0 0 auto;
  max-height: 52%;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--ui-sp-4);
  border-bottom: 1px solid var(--ui-border-console);
}
/* Scrollable body: the single scroll surface for objective strip + facility room.
   Inherits flex:1 / min-height:0 / overflow-y:auto / themed thin scrollbar from
   .ui-panel-body in UI_PRIMITIVES. */
#base-view .sidebar-body { gap: var(--ui-sp-3); }
#base-view .operation-card {
  position: relative;
  padding: var(--ui-sp-4);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-raised);
  box-shadow: var(--ui-shadow-glow);
}
/* The operation-card's launch action is the screen's single primary action, so
   it carries .ui-cta. The generic #base-view button.primary (teal gradient) has
   higher specificity than the shared .ui-cta rule, so this scoped override
   re-asserts the bright cyan CTA treatment for the CTA inside the card only —
   the generic .primary buttons (Open Geoscape, etc.) are untouched. */
#base-view .operation-card .ui-cta {
  width: 100%;
  margin-top: var(--ui-sp-3);
  color: var(--ui-bg-deep);
  background: linear-gradient(180deg, var(--ui-cyan), #2bc5e0);
  border: 1px solid var(--ui-border-bright);
  box-shadow: var(--ui-shadow-glow);
  font-size: var(--ui-text-md);
  letter-spacing: 0.06em;
}
#base-view .operation-card .ui-cta:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
#base-view .operation-card .ui-cta:active:not(:disabled) { transform: translateY(1px); }
#base-view .op-eyebrow {
  color: var(--ui-cyan);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .18em;
  text-transform: uppercase;
}
#base-view .op-title {
  margin: 6px 0 4px;
  color: var(--ui-text);
  font: 800 var(--ui-text-xl)/1.15 Inter, ui-sans-serif, sans-serif;
  letter-spacing: .02em;
}
#base-view .op-region {
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1.3 ui-monospace, monospace;
}
#base-view .op-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 9px 0;
}
#base-view .op-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 9px;
  border: 1px solid rgba(103,232,249,.26);
  border-radius: 999px;
  color: var(--ui-text);
  background: rgba(8,28,40,.5);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .03em;
  white-space: nowrap;
}
#base-view .mission-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 8px 0 0;
  padding: 5px 11px;
  border: 1px solid rgba(103,232,249,.4);
  border-radius: 999px;
  color: var(--ui-text);
  background: rgba(8,35,47,.5);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .mission-chip .mission-icon { color: var(--ui-cyan); font-size: var(--ui-text-sm); }
#base-view .mission-chip.crashSite { border-color: rgba(103,232,249,.4); }
#base-view .mission-chip.terror { border-color: rgba(251,113,133,.55); color: #fecaca; }
#base-view .mission-chip.terror .mission-icon { color: var(--ui-red); }
#base-view .mission-chip.landedUfo { border-color: rgba(167,139,250,.5); color: #ddd6fe; }
#base-view .mission-chip.landedUfo .mission-icon { color: #a78bfa; }
#base-view .mission-chip.baseDefense { border-color: rgba(251,191,36,.55); color: #fde68a; }
#base-view .mission-chip.baseDefense .mission-icon { color: var(--ui-amber); }
#base-view .airborne-banner {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 11px;
  align-items: start;
  margin-top: 4px;
  padding: 11px;
  border: 1px solid rgba(251,191,36,.45);
  border-radius: 10px;
  background: rgba(35,24,4,.26);
}
#base-view .airborne-banner.engaging { border-color: rgba(251,113,133,.5); background: rgba(45,11,18,.28); }
#base-view .airborne-banner.escaped { border-color: rgba(148,163,184,.32); background: rgba(2,12,20,.4); }
#base-view .airborne-banner .banner-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px; height: 32px;
  border: 1px solid rgba(251,191,36,.6);
  border-radius: 8px;
  color: var(--ui-amber);
  font-size: 16px;
}
#base-view .airborne-banner.engaging .banner-icon { border-color: rgba(251,113,133,.6); color: var(--ui-red); }
#base-view .airborne-banner.escaped .banner-icon { border-color: rgba(148,163,184,.4); color: var(--ui-muted); }
#base-view .airborne-banner .banner-body strong {
  display: block;
  color: #fef3c7;
  font: 800 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view .airborne-banner.engaging .banner-body strong { color: #fecaca; }
#base-view .airborne-banner.escaped .banner-body strong { color: var(--ui-muted); }
#base-view .airborne-banner .banner-body p {
  margin: 5px 0 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .airborne-banner .banner-actions {
  display: flex;
  gap: 8px;
  margin-top: 9px;
}
#base-view .airborne-banner .banner-actions button { flex: 1; }
#base-view .objective-strip {
  padding: 11px 12px;
  border: 1px solid rgba(103,232,249,.2);
  border-radius: 10px;
  background: rgba(2,12,20,.45);
}
#base-view .objective-strip .obj-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  color: var(--ui-text);
  font: 700 var(--ui-text-xs)/1.2 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .objective-strip .obj-head b { color: var(--ui-cyan); }
#base-view .progress {
  position: relative;
  height: 7px;
  margin: 7px 0;
  border-radius: 999px;
  background: rgba(103,232,249,.14);
  overflow: hidden;
}
#base-view .progress > i {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: 999px;
  background: linear-gradient(90deg, var(--ui-cyan), color-mix(in srgb, var(--ui-cyan) 70%, #000));
}
#base-view .progress.danger > i { background: linear-gradient(90deg, #fb7185, #f43f5e); }
#base-view .objective-strip .obj-summary {
  margin: 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
/* The facility room grows with its content and lets the sidebar body (the single
   scroll surface) do the scrolling — no nested/competing scrollbars, so nothing
   clips mid-card. */
#base-view .facility-room {
  flex: 0 0 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-3);
}
#base-view .room-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 8px;
  border-bottom: 1px solid rgba(103,232,249,.2);
}
#base-view .room-back {
  min-height: 32px;
  padding: 0 11px;
  margin-right: 2px;
  font-size: var(--ui-text-xs);
}
#base-view .room-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(103,232,249,.4);
  border-radius: 8px;
  color: var(--ui-cyan);
  background: rgba(8,28,40,.5);
  font-size: var(--ui-text-md);
  flex: none;
}
#base-view .room-title {
  color: var(--ui-text);
  font: 800 14px/1 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .room-body {
  flex: 0 0 auto;
  min-width: 0;
  padding: 1px;
}
#base-view .hub-overview {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
#base-view .room-nav {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
/* Facility cards: FIXED height (icon + name + one-line status) so the grid never
   truncates a card mid-content at the panel bottom. Overflow is clipped and the
   status blurb is a single ellipsised line. */
#base-view .room-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ui-sp-1);
  height: 88px;
  min-width: 0;
  padding: var(--ui-sp-3);
  overflow: hidden;
  text-align: left;
  text-transform: none;
  letter-spacing: 0;
  font: 600 var(--ui-text-sm)/1.3 Inter, sans-serif;
  transition: border-color var(--ui-fast) var(--ui-ease),
              background var(--ui-fast) var(--ui-ease),
              transform var(--ui-fast) var(--ui-ease);
}
#base-view .room-card:hover {
  border-color: var(--ui-border-bright);
  background: linear-gradient(180deg, rgba(14,52,67,.95), rgba(8,35,47,.95));
  transform: translateY(-1px);
}
#base-view .room-card .room-name {
  color: var(--ui-text);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view .room-card .room-blurb {
  align-self: stretch;
  color: var(--ui-muted);
  font: 400 var(--ui-text-sm)/1.4 Inter, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#base-view .panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 2px 0 9px;
}
#base-view .panel-head .panel-title {
  color: var(--ui-text);
  font: 800 var(--ui-text-sm)/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .panel-head button {
  min-height: 32px;
  padding: 0 11px;
  font-size: var(--ui-text-xs);
}
#base-view .section-label {
  margin: 6px 0 7px;
  color: var(--ui-cyan);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
}
#base-view .tab-card {
  padding: 11px;
  margin-bottom: 8px;
  border: 1px solid rgba(103,232,249,.2);
  border-radius: 10px;
  background: rgba(2,12,20,.45);
}
#base-view .tab-card > strong {
  display: block;
  color: var(--ui-text);
  font: 800 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .tab-card .card-copy {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .tab-card .card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 7px;
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/1.2 ui-monospace, monospace;
}
#base-view .tab-card .card-cost { color: var(--ui-amber); }
#base-view .tab-card button { margin-top: 9px; }
#base-view .chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 6px 0 2px;
}
#base-view .done-chip {
  padding: 4px 9px;
  border: 1px solid rgba(74,222,128,.4);
  border-radius: 999px;
  color: #bbf7d0;
  background: rgba(10,35,22,.4);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .deploy-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-cyan);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
}
#base-view .deploy-toggle input { width: 15px; height: 15px; accent-color: var(--ui-cyan); }
#base-view .deploy-toggle:has(input:disabled) { color: var(--ui-dim); opacity: .65; }
#base-view .soldier-items {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}
#base-view .item-control {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 6px;
  border: 1px solid rgba(103,232,249,.2);
  border-radius: 6px;
  background: rgba(1,9,15,.55);
  color: var(--ui-text);
  font: 600 var(--ui-text-xs)/1 ui-monospace, monospace;
  white-space: nowrap;
}
#base-view .item-icon { color: var(--ui-cyan); font-size: var(--ui-text-xs); }
#base-view .item-label { color: var(--ui-text); }
#base-view .item-held { color: #fde68a; font-weight: 700; }
#base-view .item-stock { color: var(--ui-muted); }
#base-view .item-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid rgba(103,232,249,.3);
  border-radius: 5px;
  background: rgba(8,35,47,.6);
  color: var(--ui-text);
  font: 700 var(--ui-text-sm)/1 ui-monospace, monospace;
  cursor: pointer;
}
#base-view .item-btn:hover:not(:disabled) {
  border-color: rgba(103,232,249,.6);
  background: rgba(14,51,68,.7);
}
#base-view .item-btn:disabled { opacity: .35; cursor: default; }
#base-view .status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid rgba(103,232,249,.3);
  border-radius: 999px;
  color: var(--ui-text);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  white-space: nowrap;
}
#base-view .status-chip.wounded { border-color: rgba(251,191,36,.5); color: #fde68a; }
#base-view .status-chip.kia { border-color: rgba(251,113,133,.5); color: #fda4af; }
/* Memorial — a somber, muted panel (desaturated slate, no neon) so the fallen
   read with gravity alongside the otherwise luminous cyan base UI. */
#base-view .memorial-panel {
  margin-top: 12px;
  padding: 12px;
  border: 1px solid rgba(148,163,184,.18);
  border-radius: 10px;
  background: rgba(2,8,14,.5);
}
#base-view .memorial-head {
  display: flex;
  align-items: center;
  gap: 9px;
  padding-bottom: 9px;
  border-bottom: 1px solid rgba(148,163,184,.14);
}
#base-view .memorial-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid rgba(148,163,184,.3);
  border-radius: 6px;
  color: var(--ui-muted);
  background: rgba(15,23,42,.4);
  font-size: var(--ui-text-sm);
  flex: none;
}
#base-view .memorial-title {
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
}
#base-view .memorial-subtitle {
  margin: 7px 0 0;
  color: var(--ui-dim);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
  font-style: italic;
}
#base-view .memorial-list {
  display: grid;
  gap: 8px;
  margin-top: 10px;
}
#base-view .memorial-entry {
  padding: 9px 10px;
  border-left: 2px solid rgba(148,163,184,.25);
  border-radius: 0 6px 6px 0;
  background: rgba(15,23,42,.28);
}
#base-view .memorial-name-row {
  display: flex;
  align-items: baseline;
  flex-wrap: wrap;
  gap: 9px;
}
#base-view .memorial-name {
  color: var(--ui-text);
  font: 700 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  letter-spacing: .02em;
}
#base-view .memorial-rank {
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/1 ui-monospace, monospace;
  text-transform: capitalize;
}
#base-view .memorial-detail {
  margin-top: 4px;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .memorial-bio {
  margin-top: 4px;
  color: var(--ui-dim);
  font: 400 italic var(--ui-text-sm)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .facility-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-sp-3);
  padding: var(--ui-sp-2) var(--ui-sp-3);
  margin-bottom: var(--ui-sp-2);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius);
  background: rgba(2,12,20,.42);
  color: var(--ui-text);
  font: 600 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  cursor: pointer;
  transition: border-color var(--ui-fast) var(--ui-ease),
              background var(--ui-fast) var(--ui-ease),
              box-shadow var(--ui-fast) var(--ui-ease);
}
#base-view .facility-row:hover {
  border-color: var(--ui-border-bright);
  background: var(--ui-panel-raised);
  box-shadow: inset 3px 0 0 var(--ui-cyan);
}
#base-view .facility-row.selected {
  border-color: var(--ui-border-bright);
  background: rgba(12,40,52,.55);
  box-shadow: inset 0 0 0 1px var(--ui-border-strong),
              inset 3px 0 0 var(--ui-cyan),
              0 0 14px rgba(103,232,249,.25);
}
#base-view .facility-row .fr-state { color: var(--ui-green); }
#base-view .facility-row .fr-state.building { color: var(--ui-amber); }
#base-view .build-grid {
  display: grid;
  gap: 7px;
  margin-top: 8px;
}
#base-view .build-card {
  padding: 10px;
  border: 1px solid rgba(251,191,36,.24);
  border-radius: 8px;
  background: rgba(35,24,4,.18);
}
#base-view .build-card.blocked { border-color: rgba(148,163,184,.18); background: rgba(2,12,20,.34); }
#base-view .build-card.active { border-color: rgba(103,232,249,.38); background: rgba(8,35,47,.36); }
#base-view .build-card .bc-head {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #fef3c7;
  font: 700 var(--ui-text-xs)/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .build-card .bc-head em { color: var(--ui-amber); font-style: normal; }
#base-view .build-card p {
  margin: 6px 0 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .build-card button { width: 100%; margin-top: 9px; }
#base-view .market-card {
  padding: 11px;
  border: 1px solid rgba(103,232,249,.2);
  border-radius: 10px;
  background: rgba(2,12,20,.45);
}
#base-view .market-card > strong {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: var(--ui-text);
  font: 800 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-card .market-credits { color: var(--ui-amber); }
#base-view .market-card > p {
  margin-top: 6px;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .market-list { display: grid; gap: 7px; margin-top: 9px; }
#base-view .market-item {
  display: grid;
  grid-template-columns: minmax(90px, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 7px;
  background: rgba(2,12,20,.42);
  color: var(--ui-text);
  font: 700 var(--ui-text-xs)/1.1 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-item .market-price { color: var(--ui-amber); }
#base-view .market-item .market-stock { color: var(--ui-muted); }
#base-view .market-item button { min-height: 34px; padding: 0 11px; }
#base-view .market-item button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .5;
  border-color: rgba(148,163,184,.3);
}
#base-view button {
  min-height: 40px;
  padding: 0 14px;
  cursor: pointer;
  color: var(--ui-text);
  border: 1px solid rgba(132,165,188,.32);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(34,51,65,.95), rgba(11,24,34,.96));
  font: 800 var(--ui-text-xs)/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view button.primary {
  width: 100%;
  min-height: 46px;
  margin-top: 11px;
  border-color: rgba(103,232,249,.85);
  background: linear-gradient(180deg, rgba(20,110,138,.98), rgba(8,52,68,.98));
  box-shadow: 0 0 24px rgba(34,211,238,.28);
  font-size: var(--ui-text-sm);
  letter-spacing: .08em;
}
#base-view button:hover {
  border-color: rgba(103,232,249,.9);
  background: linear-gradient(180deg, rgba(38,76,92,.98), rgba(11,39,52,.98));
}
#base-view button:disabled,
#base-view button[aria-disabled="true"] { cursor: default; opacity: .42; }
#base-view .empty-state {
  margin-top: 9px;
  padding: 11px;
  border: 1px dashed rgba(148,163,184,.28);
  border-radius: 8px;
  color: var(--ui-muted);
  background: rgba(2,12,20,.3);
  text-align: center;
  font: 700 var(--ui-text-xs)/1.4 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
/* Top-bar "New campaign" tool — a quiet danger-outline button beside the help
   button (the overview sidebar that used to host it is gone). */
#base-view .reset-btn {
  height: 30px;
  padding: 0 12px;
  border-radius: 7px;
  border: 1px solid rgba(255,176,46,.45);
  color: var(--ui-amber);
  background: rgba(28,18,6,.55);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
  cursor: pointer;
}
#base-view .reset-btn:hover { border-color: rgba(255,176,46,.9); background: rgba(46,30,10,.8); }
/* First-time hint: one unobtrusive line, bottom-center, fading out after the
   first interaction (and whenever a room is open). */
#base-view .base-hint {
  position: absolute;
  left: 50%;
  bottom: 20px;
  z-index: 4;
  transform: translateX(-50%);
  padding: 7px 14px;
  border: 1px solid var(--ui-border-console);
  border-radius: 999px;
  color: var(--ui-muted);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-shadow-sm);
  -webkit-backdrop-filter: blur(8px);
  backdrop-filter: blur(8px);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  pointer-events: none;
  opacity: 1;
  transition: opacity .5s ease;
}
#base-view .base-hint.faded { opacity: 0; }
/* Medbay wounded-recovery readout, folded into the Barracks room. */
#base-view .medbay-list { display: flex; flex-direction: column; gap: 4px; }
#base-view .medbay-row {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
}
#base-view .medbay-name { color: var(--ui-text); font: 700 var(--ui-text-xs)/1.3 ui-monospace, monospace; }
#base-view .medbay-eta { color: var(--ui-amber); font: 700 var(--ui-text-xs)/1.3 ui-monospace, monospace; }
#base-view .base-tooltip {
  position: absolute;
  z-index: 7;
  max-width: 240px;
  padding: 8px 11px;
  border: 1px solid rgba(103,232,249,.5);
  border-radius: 8px;
  color: var(--ui-text);
  background: var(--ui-panel-solid);
  box-shadow: var(--ui-shadow);
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, -130%);
  transition: opacity .12s ease;
  font: 600 var(--ui-text-xs)/1.35 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .base-tooltip.visible { opacity: 1; }
#base-view .base-tooltip strong {
  display: block;
  color: var(--ui-cyan);
  font: 800 var(--ui-text-xs)/1.2 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .base-tooltip span { color: var(--ui-muted); }
/* Transient toast uses the shared .ui-toast primitive (top-center console-glass
   card, [data-tone] accent). It is hidden (display:none) until showNotice() reveals
   it and drives its own JS dismiss timer. */
#base-view .ui-toast { pointer-events: none; }
#base-view .base-overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: none;
  align-items: center;
  justify-content: center;
  padding: 22px;
  pointer-events: auto;
  background: radial-gradient(circle at center, rgba(10,25,35,.78), rgba(2,5,8,.95));
  backdrop-filter: blur(8px);
}
#base-view .base-overlay.show { display: flex; }
#base-view .base-help-card {
  position: relative;
  width: min(620px, 100%);
  overflow: hidden auto;
  max-height: calc(100vh - 44px);
  padding: clamp(22px, 4vw, 38px);
  border: 1px solid rgba(103,232,249,.32);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%),
    rgba(5,11,17,.98);
  box-shadow: 0 30px 100px rgba(0,0,0,.55);
}
#base-view .base-help-card::before {
  content: "";
  position: absolute;
  top: 0; left: 0;
  width: 42%; height: 3px;
  background: linear-gradient(90deg, var(--ui-cyan), transparent);
}
#base-view .base-help-card .eyebrow { color: var(--ui-cyan); font: 700 var(--ui-text-xs)/1.2 ui-monospace, monospace; letter-spacing: .18em; text-transform: uppercase; }
#base-view .base-help-card h2 { margin: 7px 0 8px; font-size: 26px; line-height: 1; letter-spacing: .04em; text-transform: uppercase; }
#base-view .base-help-card p.lede { margin: 0; max-width: 520px; color: var(--ui-muted); font-size: var(--ui-text-sm); }
#base-view .base-help-card ul { margin: 18px 0 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
#base-view .base-help-card li { padding: 9px 12px; border: 1px solid rgba(255,255,255,.07); border-radius: 8px; background: rgba(0,0,0,.18); color: var(--ui-text); font: 600 var(--ui-text-xs)/1.4 ui-monospace, monospace; }
#base-view .base-help-card li b { color: var(--ui-cyan); font-weight: 800; }
#base-view .base-help-actions { display: flex; justify-content: flex-end; margin-top: 18px; }
#base-view .base-help-actions button {
  min-width: 130px;
  min-height: 38px;
  border-radius: 7px;
  border: 1px solid rgba(103,232,249,.7);
  color: var(--ui-text);
  background: linear-gradient(180deg, rgba(17,94,117,.96), rgba(8,49,65,.98));
  font: 800 var(--ui-text-sm)/1 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
  cursor: pointer;
}
@media (max-width: 900px) {
  #base-view .base-sidebar {
    top: auto;
    bottom: 0;
    left: 0;
    right: 0;
    width: 100%;
    max-height: 62vh;
    border-radius: 12px 12px 0 0;
  }
  #base-view .topbar-chips { gap: var(--ui-sp-1); }
}
#base-view .craft-list {
  display: grid;
  gap: 7px;
}
#base-view .craft-row {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 10px;
  align-items: center;
  padding: 8px 10px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 8px;
  background: rgba(2,12,20,.42);
}
#base-view .craft-row.transport { border-color: rgba(74,222,128,.18); }
#base-view .craft-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 7px;
  font-size: 14px;
  color: var(--ui-cyan);
  background: rgba(103,232,249,.12);
}
#base-view .craft-row.transport .craft-icon {
  color: var(--ui-green);
  background: rgba(74,222,128,.12);
}
#base-view .craft-heading {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
#base-view .craft-kind {
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#base-view .craft-row.transport .craft-kind { color: #86efac; }
#base-view .craft-row .craft-heading strong {
  color: var(--ui-text);
  font: 800 var(--ui-text-sm)/1.2 ui-monospace, monospace;
  letter-spacing: .03em;
}
/* Speed chip pinned to the right of the craft heading. */
#base-view .craft-speed {
  margin-left: auto;
  padding: 2px 7px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-pill);
  color: var(--ui-cyan);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .04em;
  white-space: nowrap;
}
/* Advanced (manufactured Phantom) interceptor: distinct violet accent so it reads
   apart from the starting Raptors at a glance. */
#base-view .craft-row.advanced {
  border-color: rgba(192, 96, 255, .42);
  background: rgba(30, 12, 44, .5);
}
#base-view .craft-row.advanced .craft-icon {
  color: var(--ui-purple);
  background: rgba(192, 96, 255, .16);
}
#base-view .craft-row.advanced .craft-kind { color: var(--ui-purple); }
#base-view .craft-row.advanced .craft-speed {
  border-color: rgba(192, 96, 255, .5);
  color: var(--ui-purple);
}
#base-view .craft-stats {
  margin: 3px 0 0;
  color: var(--ui-purple);
  font: 600 var(--ui-text-xs)/1.3 ui-monospace, monospace;
  letter-spacing: .02em;
}
#base-view .craft-body .card-copy { margin: 3px 0 0; }
/* Advanced-craft manufacturing order (Phantom): violet accent, matching its hangar row. */
#base-view .tab-card.craft-order {
  border-color: rgba(192, 96, 255, .34);
}
#base-view .tab-card.craft-order > strong { color: var(--ui-purple); }
/* Keyboard focus indicators (only for keyboard users — :focus-visible never
   fires on mouse click, so this never shows up in mouse-driven screenshots). */
#base-view button:focus-visible,
#base-view .help-btn:focus-visible,
#base-view select:focus-visible,
#base-view input:focus-visible,
#base-view .facility-row:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 2px;
}
/* ============================================================================
   Carousel room content (research / manufacturing / barracks). The carousel
   framing lives in uiCarousel.ts; these style the FULL-detail slide bodies so
   nothing clips horizontally in the narrow sidebar (the old list-card bug). */
#base-view .room-carousel-wrap { min-width: 0; }

/* --- Shared project detail (research + manufacturing) --- */
#base-view .proj-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 12px;
  background: rgba(2,12,20,.5);
}
#base-view .proj-detail.craft-order { border-color: rgba(192,96,255,.38); }
#base-view .proj-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
#base-view .proj-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-pill);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
  color: var(--ui-muted);
}
#base-view .proj-badge-icon { font-size: var(--ui-text-sm); }
#base-view .proj-badge.active { color: var(--ui-amber); border-color: rgba(251,191,36,.55); }
#base-view .proj-badge.completed,
#base-view .proj-badge.done { color: var(--ui-green); border-color: rgba(74,222,128,.5); }
#base-view .proj-badge.available { color: var(--ui-cyan); border-color: var(--ui-border-strong); }
#base-view .proj-badge.locked { color: var(--ui-dim); }
#base-view .proj-tier {
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
  color: var(--ui-dim);
}
#base-view .proj-title {
  margin: 0;
  color: var(--ui-text);
  font: 800 var(--ui-text-lg)/1.15 ui-monospace, monospace;
  letter-spacing: .01em;
}
#base-view .proj-desc {
  margin: 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.5 Inter, sans-serif;
}
#base-view .proj-req {
  color: var(--ui-amber);
  font: 600 var(--ui-text-sm)/1.4 ui-monospace, monospace;
}
#base-view .proj-meta-line {
  color: var(--ui-muted);
  font: 600 var(--ui-text-sm)/1.3 ui-monospace, monospace;
}
#base-view .proj-cost-row {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
#base-view .proj-cost {
  color: var(--ui-amber);
  font: 700 var(--ui-text-sm)/1 ui-monospace, monospace;
}
#base-view .proj-duration {
  color: var(--ui-muted);
  font: 600 var(--ui-text-sm)/1 ui-monospace, monospace;
}
#base-view .proj-action {
  align-self: stretch;
  min-height: 40px;
  margin-top: 2px;
}

/* --- Barracks dossier --- */
#base-view .dossier {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 12px;
  background: rgba(2,12,20,.5);
}
#base-view .dossier.kia { border-color: rgba(148,163,184,.3); opacity: .82; }
#base-view .dossier.wounded { border-color: rgba(251,191,36,.4); }
#base-view .dossier-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
#base-view .dossier-id { display: flex; align-items: center; gap: 10px; min-width: 0; }
#base-view .dossier-insignia {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border: 1px solid var(--ui-border-strong);
  border-radius: 8px;
  color: var(--ui-cyan);
  background: rgba(8,28,40,.5);
  font: 700 var(--ui-text-sm)/1 ui-monospace, monospace;
}
#base-view .dossier-name-wrap { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
#base-view .dossier-name {
  color: var(--ui-text-strong);
  font: 800 var(--ui-text-lg)/1.1 ui-monospace, monospace;
  letter-spacing: .01em;
}
#base-view .dossier-rank {
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#base-view .dossier-deploy {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 12px;
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  background: rgba(8,28,40,.4);
  color: var(--ui-text);
  font: 700 var(--ui-text-sm)/1 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .dossier-deploy input { width: 16px; height: 16px; accent-color: var(--ui-cyan); }
#base-view .dossier-bio {
  margin: 0;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.5 Inter, sans-serif;
}
#base-view .dossier-stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 6px;
}
#base-view .dossier-stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: 8px 4px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(8,24,34,.5);
}
#base-view .dossier-stat-value {
  color: var(--ui-text-strong);
  font: 800 var(--ui-text-lg)/1 ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
}
#base-view .dossier-stat-bonus {
  margin-left: 3px;
  color: var(--ui-green);
  font-size: var(--ui-text-xs);
  font-weight: 700;
}
#base-view .dossier-stat-label {
  color: var(--ui-muted);
  font: 600 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
  text-align: center;
}
#base-view .dossier-career {
  color: var(--ui-muted);
  font: 600 var(--ui-text-sm)/1.4 ui-monospace, monospace;
}
#base-view .dossier-loadout-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
#base-view .dossier-loadout-label {
  color: var(--ui-cyan);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .14em;
  text-transform: uppercase;
}
#base-view .dossier-weapon {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 34px;
  padding: 0 10px;
  color: var(--ui-text);
  background: rgba(8,24,34,.7);
  border: 1px solid var(--ui-border);
  border-radius: 8px;
  font: 600 var(--ui-text-sm)/1 ui-monospace, monospace;
}

/* Respect prefers-reduced-motion: collapse every CSS transition/animation on
   the base screen. The ambient 3D motion (rotators, glow pulses, camera drift)
   is additionally frozen from JS via BaseView.reducedMotion. */
@media (prefers-reduced-motion: reduce) {
  #base-view *,
  #base-view *::before,
  #base-view *::after {
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

function span(text: string, className?: string): HTMLSpanElement {
  const node = el("span", className);
  node.textContent = text;
  return node;
}

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function formatCost(resources: {
  credits: number;
  alloys: number;
  elerium: number;
  alienData: number;
}): string {
  const parts = [
    resources.credits > 0 ? formatCredits(resources.credits) : "",
    resources.alloys > 0 ? `${resources.alloys}a` : "",
    resources.elerium > 0 ? `${resources.elerium}e` : "",
    resources.alienData > 0 ? `${resources.alienData}d` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "No cost";
}

function makeLabel(text: string, color: number): Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2D canvas unavailable");

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "rgba(2,10,16,.82)";
  ctx.strokeStyle = `#${color.toString(16).padStart(6, "0")}`;
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.roundRect(8, 20, 496, 78, 12);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#e8fbff";
  ctx.font = "700 30px ui-monospace, Menlo, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text.toUpperCase(), 256, 60, 452);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const material = new SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new Sprite(material);
  sprite.scale.set(1.25, 0.32, 1);
  return sprite;
}

function disposeMaterial(material: Material): void {
  const maps = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap"];
  const withMaps = material as Material & Record<string, Texture | null | undefined>;
  for (const key of maps) withMaps[key]?.dispose();
  material.dispose();
}

/**
 * Free a view's GPU resources on teardown — but NEVER the page-lifetime SHARED
 * singletons (procedural textures/materials in baseTextures, the baseFacilities
 * GEO cache, and the interior diorama geometry/material caches). Those are marked
 * `userData.shared === true` at their cache sites and are reused across every
 * BaseView instance AND across every interior dive; disposing them freed their
 * GPU textures out from under the next dive/re-entry, which rendered subsequent
 * facility interiors as a near-black void (their emissive screens/beacons and
 * mapped surfaces went dark). Skipping them here keeps the shared layer intact
 * while still reclaiming the genuinely per-view geometry/materials (corridor
 * tiles, terrain slab, cutaway shell, labels, per-view tint materials).
 */
function isShared(res: BufferGeometry | Material): boolean {
  return res.userData?.shared === true;
}
function disposeObject(obj: Group | Scene): void {
  const disposedGeometries = new Set<unknown>();
  const disposedMaterials = new Set<Material>();
  obj.traverse((child) => {
    if (child instanceof Mesh || child instanceof LineSegments || child instanceof Sprite) {
      if (child instanceof Mesh || child instanceof LineSegments) {
        if (!disposedGeometries.has(child.geometry) && !isShared(child.geometry)) {
          disposedGeometries.add(child.geometry);
          child.geometry.dispose();
        }
      }
      const material = child.material;
      if (Array.isArray(material)) {
        for (const one of material) {
          if (disposedMaterials.has(one) || isShared(one)) continue;
          disposedMaterials.add(one);
          disposeMaterial(one);
        }
      } else if (!disposedMaterials.has(material) && !isShared(material)) {
        disposedMaterials.add(material);
        disposeMaterial(material);
      }
    }
  });
}

type RoomId =
  | "overview"
  | "research"
  | "engineering"
  | "barracks"
  | "hangar"
  | "construction"
  | "containment"
  | "stores"
  | "radar"
  | "power";

interface RoomDef {
  id: RoomId;
  label: string;
  icon: string;
  blurb: string;
}

const ROOM_META: Record<RoomId, RoomDef> = {
  overview: {
    id: "overview",
    label: "Base Overview",
    icon: "◈",
    blurb: "Base command hub — facilities, capacity, and status at a glance.",
  },
  research: {
    id: "research",
    label: "Research Lab",
    icon: "⚗",
    blurb: "Analyse recovered data and unlock field upgrades.",
  },
  engineering: {
    id: "engineering",
    label: "Workshop",
    icon: "⚙",
    blurb: "Fabricate weapons, armor, and field equipment.",
  },
  barracks: {
    id: "barracks",
    label: "Barracks",
    icon: "⚑",
    blurb: "Roster, deploy, and equip your operatives.",
  },
  hangar: {
    id: "hangar",
    label: "Hangar & Armory",
    icon: "✈",
    blurb: "Interceptor status and the council equipment market.",
  },
  construction: {
    id: "construction",
    label: "Construction",
    icon: "▣",
    blurb: "Expand the base — new facilities, power, and capacity.",
  },
  containment: {
    id: "containment",
    label: "Alien Containment",
    icon: "⛓",
    blurb: "Hold live alien captives for interrogation and HQ intel.",
  },
  stores: {
    id: "stores",
    label: "Stores",
    icon: "▤",
    blurb: "Base inventory — resource stockpile and capacity.",
  },
  radar: {
    id: "radar",
    label: "Radar Tracking",
    icon: "◎",
    blurb: "Detection and UFO contact status.",
  },
  power: {
    id: "power",
    label: "Reactor",
    icon: "✷",
    blurb: "Power budget and reactor status.",
  },
};

/** Map a constructed facility's kind to the dedicated room that manages it.
 *  `command` never resolves here — it is intercepted by the click/hook path and
 *  opens the geoscape via {@link BaseViewOptions.onEnterCommandCenter}. `access`
 *  (the lift) has no room and falls back to the bare 3D overview. */
function roomForFacilityKind(kind: FacilityKind): RoomId {
  switch (kind) {
    case "lab":
      return "research";
    case "workshop":
      return "engineering";
    case "living":
    case "medbay":
      // Medbay has no standalone screen — the wounded-recovery readout is folded
      // into the Barracks room.
      return "barracks";
    case "hangar":
      return "hangar";
    case "containment":
      return "containment";
    case "stores":
      return "stores";
    case "radar":
      return "radar";
    case "power":
      return "power";
    case "command":
      // Command is the geoscape, not a DOM room; callers must intercept it.
      throw new Error("command has no DOM room — enter via onEnterCommandCenter");
    case "access":
    default:
      return "overview";
  }
}

/** Which facility kind's 3D mesh pulses as the beacon for each global alert.
 *  BASE owns this mapping so NAV only ever passes a {@link BaseAlertKind}. */
const ALERT_FACILITY: Record<BaseAlertKind, FacilityKind> = {
  ufoDetected: "radar",
  ufoShotDown: "hangar",
  interceptionReport: "hangar",
  ufoLanded: "command",
  fundingReport: "command",
  missionReport: "command",
  campaignWon: "command",
  campaignLost: "command",
};

/** Resolve a constructed facility's art-directed role (silhouette + accent
 *  glow) from its kind. Overrides the frozen `roleForKind` helper, whose
 *  substring matchers misclassify two starter kinds: `command` hits the radar
 *  branch (`includes("comm")`) and `living` misses barracks (`includes("live")`
 *  has no "e"). Keyed by the closed FacilityKind union so every kind resolves
 *  to its intended model + signature accent color. */
function roleForFacilityKind(kind: FacilityKind): FacilityRole {
  switch (kind) {
    case "command":
      return "command";
    case "lab":
      return "lab";
    case "workshop":
      return "workshop";
    case "living":
      return "barracks";
    case "hangar":
      return "hangar";
    case "radar":
      return "radar";
    case "power":
      return "reactor";
    case "containment":
      return "containment";
    case "access":
    case "medbay":
    case "stores":
      return "command";
    default:
      return "command";
  }
}

export class BaseView {
  private readonly root: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  private readonly baseGroup = new Group();
  private readonly pulseMaterials: Array<{ material: MeshBasicMaterial; opacity: number }> = [];
  private readonly rotators: BaseRotator[] = [];
  /** Animated crew (personnel) walking the routed corridor loops — drives life.
   *  One CrewSystem per connected corridor component (the {@link corridorGraph}
   *  patrols), so every hall reads as populated. Each owns its pooled meshes +
   *  deterministic motion; ticked in frame(), disposed on teardown. */
  private crewSystems: CrewSystem[] = [];
  /** The corridor network routed from the current facility layout. Built in
   *  buildScene before the corridor geometry/crew; exposed via getCorridorGraph. */
  private corridorGraph: CorridorGraph = { tiles: [], segments: [], patrols: [], spine: -1 };
  /** Facility name-chip labels collected during build for a one-shot screen-space
   *  de-overlap pass (layoutFacilityLabels). Sprites are camera-facing, so bays
   *  close in world XZ collide; the pass lifts colliders to a higher tier. */
  private readonly facilityLabelAnchors: Array<{
    sprite: Sprite;
    wx: number;
    wz: number;
    baseY: number;
  }> = [];
  /** Expansion-pad niche meshes + their (hidden-by-default) labels, revealed only
   *  on hover so empty EXPANSION slots don't clutter the cutaway. */
  private readonly expansionHovers: Array<{ mesh: Mesh; label: Sprite; id: string }> = [];
  /** The expansion-pad meshes, cached once after buildScene (the set is invariant
   *  for a view's life) so pointermove raycasts never re-.map() a fresh array. */
  private expansionMeshCache: Mesh[] | null = null;
  private hoveredExpansionId: string | null = null;
  /** Previous frame timestamp (ms) for computing a frame delta without per-frame
   *  allocation. 0 sentinel => first frame uses a nominal 16ms step. */
  private prevTimeMs = 0;
  /** Per-bay accent point lights so each constructed facility glows from within.
   *  `base` is the resting intensity; hover/select boosts it for feedback. */
  private readonly bayLights: Array<{ light: PointLight; facilityId: string; base: number }> = [];
  /** Reactor inner-core materials, collected once at build time so the frame
   *  loop can pulse their emissiveIntensity without per-frame traversal. */
  private readonly reactorCores: MeshStandardMaterial[] = [];
  /** Shared PBR materials (one instance each) reused across the cavity + bays.
   *  Created in buildScene; disposed via disposeObject(scene) which dedupes. */
  private sharedConcrete: MeshStandardMaterial | null = null;
  private sharedSteel: MeshStandardMaterial | null = null;
  private sharedRock: MeshStandardMaterial | null = null;
  /** Lighter concrete for corridor floor strips (derived from the palette by
   *  lifting the bay-concrete toward the steel edge tone) — reads as hallways. */
  private corridorFloor: MeshStandardMaterial | null = null;
  /** One shared emissive strip-light material (palette floor-line teal) reused
   *  along every corridor edge + center travel line. */
  private corridorStripMat: MeshBasicMaterial | null = null;
  /** Resting camera position; the frame loop adds a subtle idle drift on top. */
  private readonly camHome = new Vector3(-0.3, 6.4, 7.5);
  /** Dedicated interior mount at the scene root (no hub yaw/scale) so the dive-in
   *  diorama frames cleanly. Empty in hub mode; holds one {@link interiorRoot}. */
  private readonly interiorGroup = new Group();
  /** The currently-mounted facility interior diorama (null in hub mode). Built
   *  by buildFacilityInterors on enter, disposed on exit to avoid leaks. */
  private interiorRoot: Group | null = null;
  /** Resting 3/4 interior hero framing — close, slightly elevated, looking into
   *  the now fully-enclosed diorama (floor + walls + ceiling). Pulled in and the
   *  target lifted so the sealed room fills the frame with lit surfaces instead
   *  of leaving the cavern void around it. The frame loop adds a subtle drift. */
  private readonly interiorCamPos = new Vector3(2.45, 1.9, 3.15);
  private readonly interiorCamTarget = new Vector3(0, 1.05, -0.45);
  /** Hub look-at target (origin). Reused as the dive-out tween destination. */
  private readonly hubCamTarget = new Vector3(0, 0, 0);
  /** The point the camera currently looks at — updated every frame so a dive
   *  tween can start from wherever the camera was actually facing. */
  private readonly currentLookAt = new Vector3(0, 0, 0);
  /** In-progress camera tween (dive in / back to base). Allocation-free: the
   *  frame loop lerps between the persistent from/to vectors each tick. */
  private readonly camFromPos = new Vector3();
  private readonly camToPos = new Vector3();
  private readonly camFromTarget = new Vector3();
  private readonly camToTarget = new Vector3();
  private camStartMs = 0;
  private camDurationMs = 0;
  private camAnimating = false;
  private raf = 0;
  private disposed = false;
  /** Captured once at construction: true when the OS/browser asks for reduced
   *  motion. Gates the ambient frame() FX (rotators, glow + reactor pulses,
   *  idle camera/yaw drift) so those non-essential loops freeze for those users.
   *  Essential transitions (the dive-in/out camera tween) keep running. */
  private readonly reducedMotion: boolean =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  private noticeEl: HTMLDivElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();
  private facilityMeshes: Array<{ mesh: Mesh; facilityId: string }> = [];
  private hoveredFacilityId: string | null = null;
  private selectedFacilityId: string | null = null;
  private activeRoom: RoomId = "overview";
  private expandedSoldierId: string | null = null;
  /** Remembered carousel selection per room so a mid-room refresh (start research,
   *  equip an item) keeps the player on the same PROJECT instead of snapping away.
   *  Persisted by project id (not slide index) because the slide order changes when
   *  a project starts — the active project sorts to slot 0, so a positional index
   *  would land the player on an unrelated project after clicking Start. */
  private researchCarouselProjectId: string | null = null;
  private mfgCarouselProjectId: string | null = null;
  /** Live carousel handles for the currently-mounted room; destroyed (keyboard
   *  listener removed) before every room re-render and on dispose. */
  private roomCarousels: CarouselHandle[] = [];
  private tooltipEl: HTMLDivElement | null = null;
  private topbarChips: HTMLElement | null = null;
  private clockEl: HTMLElement | null = null;
  /** The room panel — the ONLY sidebar content. Hidden entirely on the bare 3D
   *  overview (activeRoom === "overview"); shown when a facility room is open. */
  private sidebar: HTMLElement | null = null;
  private roomHost: HTMLElement | null = null;
  /** First-time "click a facility" hint, faded out after the first interaction. */
  private hintEl: HTMLElement | null = null;
  private hintDismissed = false;
  /** Facility id whose 3D pad currently pulses as an alert beacon (set by
   *  pushAlert, cleared on the next user canvas interaction). */
  private alertBeaconFacilityId: string | null = null;
  private helpOverlay: HTMLDivElement | null = null;
  /** The facility/expansion id the keyboard cursor is currently on (overview only).
   *  Expansion pads (→ Construction room) are prefixed "exp:". Null when the canvas
   *  is unfocused. Reuses the hover highlight for visual feedback. */
  private keyboardFocusId: string | null = null;
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.helpOverlay?.classList.contains("show")) {
      this.toggleHelp(false);
    }
  };

  /** Ordered keyboard-focus targets on the overview: every constructed facility room
   *  (including the command center) then every expansion pad (each opens the
   *  Construction room). Mirrors exactly what a canvas raycast click can reach, so the
   *  keyboard is a first-class equal to the mouse — no room is mouse-only. */
  private focusTargets(): string[] {
    return [
      ...this.facilityMeshes.map((entry) => entry.facilityId),
      ...this.expansionHovers.map((pad) => `exp:${pad.id}`),
    ];
  }

  private setKeyboardFocus(id: string | null): void {
    this.keyboardFocusId = id;
    // A keyboard interaction acknowledges any pending alert beacon, same as a click.
    this.alertBeaconFacilityId = null;
    this.hintDismissed = true;
    if (id !== null && id.startsWith("exp:")) {
      const expId = id.slice(4);
      this.hoveredFacilityId = null;
      this.hoveredExpansionId = expId;
      for (const pad of this.expansionHovers) pad.label.visible = pad.id === expId;
    } else {
      this.hoveredFacilityId = id;
      this.hoveredExpansionId = null;
      for (const pad of this.expansionHovers) pad.label.visible = false;
    }
    this.applyFacilityHighlight();
  }

  private readonly onCanvasBlur = (): void => {
    if (this.keyboardFocusId === null) return;
    this.setKeyboardFocus(null);
  };

  /** Arrow keys cycle the focused facility; Enter/Space opens it. Tab is left alone
   *  so focus can still leave the canvas for the top-bar controls (no focus trap). */
  private readonly onCanvasKeydown = (e: KeyboardEvent): void => {
    if (this.disposed || this.interiorRoot) return;
    const targets = this.focusTargets();
    if (targets.length === 0) return;
    const next = e.key === "ArrowRight" || e.key === "ArrowDown";
    const prev = e.key === "ArrowLeft" || e.key === "ArrowUp";
    if (next || prev) {
      e.preventDefault();
      const cur = this.keyboardFocusId ? targets.indexOf(this.keyboardFocusId) : -1;
      const step = next ? 1 : -1;
      const idx = cur < 0 ? (next ? 0 : targets.length - 1) : (cur + step + targets.length) % targets.length;
      this.setKeyboardFocus(targets[idx]!);
      return;
    }
    if (e.key === "Enter" || e.key === " ") {
      const id = this.keyboardFocusId;
      if (!id) return;
      e.preventDefault();
      if (id.startsWith("exp:")) {
        // Expansion pad → Construction room (mirrors the pad-click path).
        this.selectedFacilityId = null;
        this.activeRoom = "construction";
        this.refreshHud();
        return;
      }
      this.activateFacility(id);
    }
  };

  constructor(private readonly opts: BaseViewOptions) {
    injectStyle();
    this.root = el("div");
    this.root.id = "base-view";
    this.canvasWrap = el("div", "base-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    // Real-time shadows are part of the look (excavation work-light reads
    // through contact shadows). PCFSoftShadowMap keeps edges soft + cinematic.
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFSoftShadowMap;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.12;

    this.camera.position.copy(this.camHome);
    this.camera.lookAt(0, 0, 0);

    this.buildScene();
    this.buildHud();
  }

  mount(container: HTMLElement): void {
    container.replaceChildren(this.root);
    const dom = this.renderer.domElement;
    this.canvasWrap.appendChild(dom);
    // Make the 3D base keyboard-operable: focusable canvas + arrow-key facility
    // navigation. Without this, rooms would be reachable by mouse raycast only.
    dom.tabIndex = 0;
    dom.setAttribute("role", "application");
    dom.setAttribute(
      "aria-label",
      "Base facilities. Use the arrow keys to move between facility rooms and press Enter to open one.",
    );
    window.addEventListener("resize", this.resize);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("click", this.onCanvasClick);
    dom.addEventListener("keydown", this.onCanvasKeydown);
    dom.addEventListener("blur", this.onCanvasBlur);
    window.addEventListener("keydown", this.onKeydown);
    window.__baseEnterRoom = (kind: FacilityKind): void => this.enterRoomForKind(kind);
    this.resize();
    this.frame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointermove", this.onPointerMove);
    dom.removeEventListener("click", this.onCanvasClick);
    dom.removeEventListener("keydown", this.onCanvasKeydown);
    dom.removeEventListener("blur", this.onCanvasBlur);
    window.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("resize", this.resize);
    if (window.__baseEnterRoom) delete window.__baseEnterRoom;
    // CrewSystem owns its pooled meshes/materials; tear each down before the
    // scene walk so its internal dispose() is the single owner of those resources.
    for (const crew of this.crewSystems) crew.dispose();
    this.crewSystems = [];
    this.destroyRoomCarousels();
    // Free the mounted interior diorama explicitly (geometry + materials) so a
    // teardown mid-dive never leaks; the scene walk below handles the hub.
    this.clearInterior();
    disposeObject(this.scene);
    this.renderer.dispose();
    this.root.remove();
  }

  /** In-place refresh: swap the campaign, recompute the derived operation, and
   *  re-render every panel without re-mounting the 3D scene. Safe to call
   *  repeatedly (it only rebuilds DOM text, never the renderer/scene). */
  update(campaign: CampaignState): void {
    if (this.disposed) return;
    this.opts.campaign = campaign;
    this.opts.operation = generateOperation(campaign);
    this.refreshHud();
  }

  /** Surface a strategic event (from the geoscape, via NAV) while the base view
   *  is mounted: a transient toast + a pulsing beacon on the mapped facility's 3D
   *  pad. The beacon persists until the next canvas interaction. BASE owns the
   *  kind→facility mapping ({@link ALERT_FACILITY}); NAV only passes kind+message. */
  pushAlert(alert: BaseAlert): void {
    if (this.disposed) return;
    // Danger/loss kinds read as warnings; everything else is informational.
    const warning =
      alert.kind === "ufoDetected" ||
      alert.kind === "ufoLanded" ||
      alert.kind === "campaignLost";
    this.showNotice(alert.message, warning ? "warning" : "info");
    const kind = ALERT_FACILITY[alert.kind];
    const target = this.facilityMeshes.find(
      (entry) => findBaseFacility(entry.facilityId)?.kind === kind,
    );
    this.alertBeaconFacilityId = target?.facilityId ?? null;
  }

  /** Enter the room for a facility KIND (deterministic test hook + shared by the
   *  canvas click). Command opens the geoscape; every other kind dives into the
   *  first constructed facility of that kind. Unbuilt kinds are a no-op. */
  private enterRoomForKind(kind: FacilityKind): void {
    if (this.disposed) return;
    if (kind === "command") {
      this.alertBeaconFacilityId = null;
      this.opts.onEnterCommandCenter();
      return;
    }
    const facility = constructedFacilities(this.opts.campaign).find((f) => f.kind === kind);
    if (!facility) return;
    this.enterFacility(facility.id, kind);
  }

  /** Shared facility-entry path (canvas click, installed row, test hook): select
   *  the pad, open its room, dive the camera into its interior, and re-render. */
  private enterFacility(facilityId: string, kind: FacilityKind): void {
    this.alertBeaconFacilityId = null;
    this.selectedFacilityId = facilityId;
    this.activeRoom = roomForFacilityKind(kind);
    this.enterFacilityInterior(roleForFacilityKind(kind));
    this.applyFacilityHighlight();
    this.refreshHud();
  }

  /** Lightweight transient notice (toast). Pairs its message text with the kind label so
   *  the warning color is never the sole signal. */
  private showNotice(message: string, kind: "info" | "warning" = "info"): void {
    const notice = this.noticeEl;
    if (!notice) return;
    notice.textContent = message;
    notice.dataset.tone = kind === "warning" ? "warning" : "info";
    notice.style.display = "inline-flex";
    // Re-trigger the enter animation on each show. We drive dismissal from JS
    // (below), not the shared out-animation, so the message stays readable even
    // under prefers-reduced-motion (where the animation collapses to ~0ms).
    notice.style.animation = "none";
    void notice.offsetWidth;
    notice.style.animation = "ui-toast-in var(--ui-mid) var(--ui-ease)";
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      if (this.noticeEl) this.noticeEl.style.display = "none";
      this.noticeTimer = null;
    }, 3200);
  }

  private buildMarketPanel(): HTMLElement {
    const panel = el("section", "market-card");
    const head = el("strong");
    const headLabel = el("span");
    headLabel.textContent = "Armory / Market";
    const credits = el("span", "market-credits");
    credits.textContent = `${formatCredits(this.opts.campaign.resources.credits)} available`;
    head.append(headLabel, credits);
    const intro = el("p");
    intro.textContent =
      "Council suppliers sell weapons direct. Stock restocks every 48h from Earth Command.";
    const list = el("div", "market-list");
    const campaign = this.opts.campaign;
    const totalStock = CAMPAIGN_WEAPON_IDS.reduce(
      (sum, id) => sum + (campaign.market?.stock[id] ?? 0),
      0,
    );
    for (const weaponId of CAMPAIGN_WEAPON_IDS) {
      const item = el("div", "market-item");
      const name = el("span");
      name.textContent = WEAPONS[weaponId]?.name ?? weaponId;
      const price = el("span", "market-price");
      price.textContent = formatCredits(MARKET_CONFIG[weaponId].price);
      const stock = el("span", "market-stock");
      const stockCount = campaign.market?.stock[weaponId] ?? 0;
      stock.textContent = `${stockCount} in stock`;
      const buy = el("button");
      const check = canPurchaseWeapon(campaign, weaponId);
      if (campaign.strategic.status !== "active") {
        buy.textContent = "Locked";
        buy.disabled = true;
      } else if (!check.ok) {
        // Blocked: dim + label with the reason, but keep it clickable so the notice
        // surface can announce the blocker (aria-disabled, not native disabled).
        buy.textContent = check.reason ?? "Unavailable";
        buy.setAttribute("aria-disabled", "true");
        buy.addEventListener("click", () =>
          this.showNotice(check.reason ?? "Purchase blocked", "warning"),
        );
      } else {
        buy.textContent = "Buy";
        buy.addEventListener("click", () => {
          if (this.opts.onPurchaseWeapon) this.opts.onPurchaseWeapon(weaponId);
          else this.showNotice("Armory link offline", "warning");
        });
      }
      item.append(name, price, stock, buy);
      list.appendChild(item);
    }
    panel.append(head, intro, list);
    if (totalStock === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "Market sold out. Advance time on Earth Command to restock.";
      panel.appendChild(empty);
    }
    return panel;
  }

  private buildScene(): void {
    // One curated PBR material per vocabulary surface, shared across the whole
    // base (rock cavity / concrete floor / steel structure). All color traces
    // to BASE_PALETTE — no ad-hoc hex on the architecture.
    this.sharedConcrete = concreteMaterial();
    this.sharedSteel = steelMaterial();
    this.sharedRock = rockMaterial();
    // Corridor surfaces — palette-derived only (no ad-hoc hex). The hallway
    // floor is the bay concrete lifted toward the steel-edge tone so it reads
    // as a distinct, slightly lighter paved strip; the strip-lights glow in the
    // shared teal floor-line accent.
    this.corridorFloor = concreteMaterial();
    this.corridorFloor.color.lerp(new Color(BASE_PALETTE.steelEdge), 0.16);
    this.corridorStripMat = new MeshBasicMaterial({
      color: BASE_PALETTE.floorLine,
      transparent: true,
      opacity: 0.55,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    // Rock-colored LINEAR fog with a near plane: the base (centered ~10 units
    // from the camera) stays crisp while the back rock walls + void fade to
    // black — moody depth falloff without crushing the hero subject.
    this.scene.fog = new Fog(BASE_PALETTE.rock, 9, 20);

    // Low cool ambient — just enough to keep contact shadows legible without
    // lifting the shadow side into mid grey. Tint from the steel anchor.
    this.scene.add(
      new AmbientLight(new Color(BASE_PALETTE.steel).lerp(new Color(1, 1, 1), 0.3), 0.25),
    );

    // Warm key light — the excavation work-light. Strong and tight: a shadow
    // frustum wrapped close around the base footprint (higher texel density)
    // plus a small radius yields crisp contact shadows instead of a diffuse
    // wash. Tint pulled less toward neutral so warm key reads against cool fill.
    const key = new DirectionalLight(
      new Color(BASE_PALETTE.accent.reactor).lerp(new Color(1, 1, 1), 0.55),
      4.0,
    );
    key.position.set(5, 7.5, 6);
    key.target.position.set(0, 0, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 30;
    key.shadow.camera.left = -6;
    key.shadow.camera.right = 6;
    key.shadow.camera.top = 5.5;
    key.shadow.camera.bottom = -5.5;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.025;
    key.shadow.radius = 2.5;
    this.scene.add(key);
    this.scene.add(key.target);

    // Cool rim/back light separates the facility silhouettes from the rock and
    // reinforces the warm-key / cool-fill split. Tint from the teal floor-line.
    const rim = new DirectionalLight(
      new Color(BASE_PALETTE.floorLine).lerp(new Color(1, 1, 1), 0.15),
      1.15,
    );
    rim.position.set(-6, 5, -5);
    this.scene.add(rim);

    this.baseGroup.position.set(0, -0.12, 0);
    this.baseGroup.rotation.y = BASE_VIEW_YAW;
    this.baseGroup.scale.setScalar(1.15);
    this.scene.add(this.baseGroup);
    // Interior mount lives at the scene root (not under baseGroup) so the dive-in
    // diorama avoids the hub's yaw/scale and frames cleanly on its own terms.
    this.scene.add(this.interiorGroup);

    // Route the corridor network FIRST (data-driven, from the live layout) so the
    // corridor geometry and the crew share one graph.
    this.corridorGraph = this.computeCorridorGraph();
    this.buildTerrainSlab();
    this.buildCutawayShell();
    this.buildCorridorGrid();
    const padFacilities = availableBaseFacilities(this.opts.campaign);
    // availableBaseFacilities excludes the facility currently under construction, and
    // the construction bay has no facility mesh yet — so when the LAST buildable
    // facility is being built there would be ZERO expansion pads, and the pads are the
    // only door into the Construction room (progress + build queue). Add a pad for the
    // in-progress facility so that room is never stranded on a base view remount.
    const buildingId = this.opts.campaign.activeConstruction?.facilityId;
    const buildingFacility =
      buildingId !== undefined && !padFacilities.some((f) => f.id === buildingId)
        ? findBaseFacility(buildingId)
        : undefined;
    for (const facility of padFacilities) this.buildExpansionPad(facility);
    if (buildingFacility) this.buildExpansionPad(buildingFacility);
    for (const facility of constructedFacilities(this.opts.campaign)) this.buildFacility(facility);
    // One-shot de-overlap of the facility name chips once every bay is placed.
    this.layoutFacilityLabels();
    this.addOverheadSystems();
    this.addCrew();
    this.addPerimeterShafts();
  }

  private buildTerrainSlab(): void {
    const rock = this.sharedRock!;
    const concrete = this.sharedConcrete!;
    const width = STARTER_BASE_GRID.width * CELL;
    const depth = STARTER_BASE_GRID.height * CELL;

    // The rock mass the facility is carved into — extends past the floor on
    // every side so the cavity walls (buildCutawayShell) read as continuous.
    const rockBed = new Mesh(new BoxGeometry(width + 4.6, 1.4, depth + 4.6), rock);
    rockBed.position.y = -0.7;
    rockBed.receiveShadow = true;
    rockBed.castShadow = true;
    this.baseGroup.add(rockBed);

    // Concrete floor of the excavated level, sized to the build grid. Receives
    // the warm key-light contact shadows from every facility silhouette.
    const slab = new Mesh(new BoxGeometry(width, 0.16, depth), concrete);
    slab.position.y = -0.06;
    slab.receiveShadow = true;
    this.baseGroup.add(slab);

    // Subtle teal floor-line border (scale grid) — additive glow line, palette color.
    const edge = new LineSegments(
      new EdgesGeometry(slab.geometry),
      new MeshBasicMaterial({
        color: BASE_PALETTE.floorLine,
        transparent: true,
        opacity: 0.4,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    edge.position.copy(slab.position);
    this.baseGroup.add(edge);

    // Teal construction grid on the concrete — reads the cell scale at a glance.
    const gridMat = new MeshBasicMaterial({
      color: BASE_PALETTE.floorLine,
      transparent: true,
      opacity: 0.16,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    for (let x = -STARTER_BASE_GRID.width / 2; x <= STARTER_BASE_GRID.width / 2; x++) {
      const line = new Mesh(new BoxGeometry(0.012, 0.012, depth), gridMat);
      line.position.set(x * CELL, 0.03, 0);
      this.baseGroup.add(line);
    }
    for (let y = -STARTER_BASE_GRID.height / 2; y <= STARTER_BASE_GRID.height / 2; y++) {
      const line = new Mesh(new BoxGeometry(width, 0.012, 0.012), gridMat);
      line.position.set(0, 0.032, y * CELL);
      this.baseGroup.add(line);
    }
  }

  private buildCutawayShell(): void {
    const rock = this.sharedRock!;
    const concrete = this.sharedConcrete!;
    const width = STARTER_BASE_GRID.width * CELL;
    const depth = STARTER_BASE_GRID.height * CELL;
    const wallHeight = 3.0;
    const wallT = 1.0;

    // Back rock wall (far side from camera). Casts shadow so the key light
    // throws dramatic rock-face shadow across the concrete floor.
    const backWall = new Mesh(new BoxGeometry(width + 2.6, wallHeight, wallT), rock);
    backWall.position.set(0, wallHeight / 2 - 0.55, -depth / 2 - wallT / 2);
    backWall.castShadow = true;
    backWall.receiveShadow = true;
    // Left rock wall.
    const leftWall = new Mesh(new BoxGeometry(wallT, wallHeight, depth + 2.6), rock);
    leftWall.position.set(-width / 2 - wallT / 2, wallHeight / 2 - 0.55, 0);
    leftWall.castShadow = true;
    leftWall.receiveShadow = true;
    // Partial right return enclosing the back-right corner — the front-right
    // stays open as the cutaway sightline.
    const returnLen = depth * 0.6;
    const rightReturn = new Mesh(new BoxGeometry(wallT, wallHeight, returnLen + 0.6), rock);
    rightReturn.position.set(width / 2 + wallT / 2, wallHeight / 2 - 0.55, -depth / 2 + returnLen / 2);
    rightReturn.castShadow = true;
    rightReturn.receiveShadow = true;
    this.baseGroup.add(backWall, leftWall, rightReturn);

    // Cave-roof overhang at the enclosed back-left corner — implies the cavern
    // continues overhead without lid-ing the whole diorama.
    const overhang = new Mesh(new BoxGeometry(width * 0.62, 0.5, depth * 0.62), rock);
    overhang.position.set(-width / 4 + 0.2, wallHeight - 0.6, -depth / 4 - 0.2);
    overhang.castShadow = true;
    overhang.receiveShadow = true;
    this.baseGroup.add(overhang);

    // Horizontal rock strata (subtle teal veins) — additive glow lines.
    const strataMat = new MeshBasicMaterial({
      color: BASE_PALETTE.floorLine,
      transparent: true,
      opacity: 0.14,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    for (let i = 0; i < 6; i++) {
      const y = -0.2 + i * 0.34;
      const backVein = new Mesh(new BoxGeometry(width + 1.8, 0.016, 0.016), strataMat);
      backVein.position.set(0, y, -depth / 2 - wallT + 0.04);
      const leftVein = new Mesh(new BoxGeometry(0.016, 0.016, depth + 1.8), strataMat);
      leftVein.position.set(-width / 2 - wallT + 0.04, y, 0);
      this.baseGroup.add(backVein, leftVein);
    }

    // Clean saw-cut lips on the open cutaway edges (front + front-right).
    const lipMat = concrete;
    const frontLip = new Mesh(new BoxGeometry(width + 0.4, 0.22, 0.22), lipMat);
    frontLip.position.set(0, -0.04, depth / 2 + 0.18);
    frontLip.castShadow = true;
    frontLip.receiveShadow = true;
    const rightLip = new Mesh(new BoxGeometry(0.22, 0.22, depth - returnLen + 0.4), lipMat);
    rightLip.position.set(width / 2 + 0.18, -0.04, depth / 2 - (depth - returnLen) / 2 + 0.1);
    rightLip.castShadow = true;
    rightLip.receiveShadow = true;
    const lipLine = new MeshBasicMaterial({
      color: BASE_PALETTE.floorLine,
      transparent: true,
      opacity: 0.5,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const frontLine = new Mesh(new BoxGeometry(width + 0.42, 0.014, 0.03), lipLine);
    frontLine.position.set(0, 0.08, depth / 2 + 0.28);
    this.baseGroup.add(frontLip, rightLip, frontLine);

    const label = makeLabel("Sublevel 01 / interior cutaway", BASE_PALETTE.floorLine);
    label.position.set(-width / 2 + 1.9, wallHeight - 0.7, -depth / 2 - wallT + 0.06);
    label.scale.set(1.7, 0.36, 1);
    this.baseGroup.add(label);
  }

  private cellCenter(x: number, y: number, w: number, h: number): Vector3 {
    return new Vector3(
      (x + w / 2 - STARTER_BASE_GRID.width / 2) * CELL,
      0,
      (y + h / 2 - STARTER_BASE_GRID.height / 2) * CELL,
    );
  }

  private roomCenter(facility: BaseFacility): Vector3 {
    return this.cellCenter(facility.x, facility.y, facility.w, facility.h);
  }

  private glowMaterial(color: number, opacity = 0.72): MeshBasicMaterial {
    const material = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
      side: DoubleSide,
    });
    this.pulseMaterials.push({ material, opacity });
    return material;
  }

  private addRotator(object: Group | Mesh, axis: RotationAxis, speed: number): void {
    const baseRotation =
      axis === "x" ? object.rotation.x : axis === "y" ? object.rotation.y : object.rotation.z;
    this.rotators.push({ object, axis, speed, baseRotation });
  }

  /** Route the corridor network from the CURRENT facility layout (data-driven,
   *  never hardcoded): pave the free grid cells that form hallways between bays,
   *  give each constructed facility exactly one doorway onto the hall, and emit
   *  per-component patrol loops for the crew. Corridors are strictly orthogonal
   *  and only ever occupy FREE cells, so a hall can never cross a facility or
   *  expansion footprint. */
  private computeCorridorGraph(): CorridorGraph {
    const W = STARTER_BASE_GRID.width;
    const H = STARTER_BASE_GRID.height;
    const inBounds = (x: number, y: number): boolean => x >= 0 && x < W && y >= 0 && y < H;
    const key = (x: number, y: number): number => y * W + x;

    // Occupancy: constructed facilities AND expansion pads both block corridors
    // (pads render as solid rock niches). Only cells free of both get paved.
    const facilityAt: (string | null)[] = new Array<string | null>(W * H).fill(null);
    const blocked: boolean[] = new Array<boolean>(W * H).fill(false);
    const accessKeys = new Set<number>();
    for (const f of constructedFacilities(this.opts.campaign)) {
      for (let dx = 0; dx < f.w; dx++)
        for (let dy = 0; dy < f.h; dy++) {
          const k = key(f.x + dx, f.y + dy);
          blocked[k] = true;
          facilityAt[k] = f.id;
          if (f.kind === "access") accessKeys.add(k);
        }
    }
    for (const f of availableBaseFacilities(this.opts.campaign)) {
      for (let dx = 0; dx < f.w; dx++)
        for (let dy = 0; dy < f.h; dy++) blocked[key(f.x + dx, f.y + dy)] = true;
    }
    const fidAt = (k: number): string | null => facilityAt[k] ?? null;
    const isFree = (x: number, y: number): boolean => inBounds(x, y) && !blocked[key(x, y)];

    // Free cells scanned row-major → deterministic component + doorway ordering.
    const free: Array<[number, number]> = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (isFree(x, y)) free.push([x, y]);

    // 4-connected components of free cells (flood fill).
    const comp: number[] = new Array<number>(W * H).fill(-1);
    const components: Array<Array<[number, number]>> = [];
    for (const [sx, sy] of free) {
      if (comp[key(sx, sy)] !== -1) continue;
      const id = components.length;
      const cells: Array<[number, number]> = [];
      const stack: Array<[number, number]> = [[sx, sy]];
      comp[key(sx, sy)] = id;
      while (stack.length > 0) {
        const [x, y] = stack.pop()!;
        cells.push([x, y]);
        for (const [, dx, dy] of CORRIDOR_DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          if (!isFree(nx, ny) || comp[key(nx, ny)] !== -1) continue;
          comp[key(nx, ny)] = id;
          stack.push([nx, ny]);
        }
      }
      components.push(cells);
    }

    // A component is a real hallway only if a bay opens onto it. Keep those with
    // >=2 cells; a lone free cell reads as a floating plank, so drop singletons
    // UNLESS dropping one would orphan a facility from every corridor.
    const bordersFacility = (cells: Array<[number, number]>): boolean =>
      cells.some(([x, y]) =>
        CORRIDOR_DIRS.some(([, dx, dy]) => {
          const nx = x + dx;
          const ny = y + dy;
          return inBounds(nx, ny) && fidAt(key(nx, ny)) !== null;
        }),
      );
    const servedFacilities = (cells: Array<[number, number]>): Set<string> => {
      const set = new Set<string>();
      for (const [x, y] of cells)
        for (const [, dx, dy] of CORRIDOR_DIRS) {
          const nx = x + dx;
          const ny = y + dy;
          const fid = inBounds(nx, ny) ? fidAt(key(nx, ny)) : null;
          if (fid) set.add(fid);
        }
      return set;
    };

    const kept = new Set<number>();
    const reachable = new Set<string>();
    for (let i = 0; i < components.length; i++) {
      const cells = components[i]!;
      if (cells.length >= 2 && bordersFacility(cells)) {
        kept.add(i);
        for (const fid of servedFacilities(cells)) reachable.add(fid);
      }
    }
    // Orphan guard: re-admit any singleton that is the ONLY corridor a facility
    // can reach, so no bay is left doorless.
    for (let i = 0; i < components.length; i++) {
      if (kept.has(i)) continue;
      const cells = components[i]!;
      const serves = servedFacilities(cells);
      if (serves.size === 0) continue;
      if ([...serves].some((fid) => !reachable.has(fid))) {
        kept.add(i);
        for (const fid of serves) reachable.add(fid);
      }
    }

    const paved = new Set<number>();
    for (const i of kept) for (const [x, y] of components[i]!) paved.add(key(x, y));

    // Row-major paved order so tiles/segments/doorways are emitted deterministically.
    const orderedPaved: Array<[number, number]> = [];
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) if (paved.has(key(x, y))) orderedPaved.push([x, y]);

    // Tiles: classify each side. Each constructed facility gets exactly ONE
    // doorway (the first paved edge, in row-major N/E/S/W order, that borders it)
    // so every bay reads with a single clear entrance onto the hall.
    const tiles: CorridorTile[] = [];
    const doorAssigned = new Set<string>();
    for (const [x, y] of orderedPaved) {
      const open: CorridorDir[] = [];
      const doors: CorridorDir[] = [];
      for (const [dir, dx, dy] of CORRIDOR_DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const nk = key(nx, ny);
        if (paved.has(nk)) {
          open.push(dir);
          continue;
        }
        const fid = fidAt(nk);
        if (fid !== null && !doorAssigned.has(fid)) {
          doors.push(dir);
          doorAssigned.add(fid);
        }
      }
      tiles.push({ cx: x, cy: y, open, doors });
    }

    // Segments: one per adjacent paved pair (scan east + south only to dedup).
    const segments: CorridorSegment[] = [];
    for (const [x, y] of orderedPaved) {
      if (x + 1 < W && paved.has(key(x + 1, y)))
        segments.push({ ax: x, ay: y, bx: x + 1, by: y, axis: "x" });
      if (y + 1 < H && paved.has(key(x, y + 1)))
        segments.push({ ax: x, ay: y, bx: x, by: y + 1, axis: "z" });
    }

    // Patrol loops (largest component first, so the biggest gets the most crew).
    const patrols: Array<Array<readonly [number, number]>> = [];
    let spine = -1;
    const keptSorted = [...kept].sort((a, b) => components[b]!.length - components[a]!.length);
    for (const i of keptSorted) {
      const loop = this.eulerTour(components[i]!, paved);
      if (loop.length < 2) continue;
      const idx = patrols.length;
      patrols.push(loop);
      if (
        spine === -1 &&
        components[i]!.some(([x, y]) =>
          CORRIDOR_DIRS.some(([, dx, dy]) => {
            const nx = x + dx;
            const ny = y + dy;
            return inBounds(nx, ny) && accessKeys.has(key(nx, ny));
          }),
        )
      ) {
        spine = idx;
      }
    }

    return { tiles, segments, patrols, spine };
  }

  /** Euler tour of a free-cell component's spanning tree: visit every cell and
   *  return toward the start so every consecutive pair — AND the closing wrap
   *  from the last cell back to the first — is orthogonally adjacent. That yields
   *  a clean crew loop that never cuts across a bay. Deterministic: the start is
   *  the lowest row-major cell and neighbours are walked in fixed N/E/S/W order. */
  private eulerTour(
    cells: Array<[number, number]>,
    paved: Set<number>,
  ): Array<readonly [number, number]> {
    const W = STARTER_BASE_GRID.width;
    const H = STARTER_BASE_GRID.height;
    const key = (x: number, y: number): number => y * W + x;
    const visited = new Set<number>();
    const order: Array<readonly [number, number]> = [];
    const start = cells.reduce((a, b) => (key(a[0], a[1]) <= key(b[0], b[1]) ? a : b));
    const walk = (x: number, y: number): void => {
      visited.add(key(x, y));
      order.push([x, y]);
      for (const [, dx, dy] of CORRIDOR_DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const nk = key(nx, ny);
        if (!paved.has(nk) || visited.has(nk)) continue;
        walk(nx, ny);
        order.push([x, y]); // backtrack edge keeps every step adjacent
      }
    };
    walk(start[0], start[1]);
    // The tour ends back at `start`; drop that trailing duplicate so the closing
    // wrap (last -> first) is a genuine single-cell hop, not a zero-length hold.
    if (order.length > 1) order.pop();
    return order;
  }

  /** The routed corridor network derived from the current facility layout.
   *  Exposed so the crew/people system can path personnel along real hallways.
   *  Shape: {@link CorridorGraph} — `tiles` / `segments` / `patrols` / `spine`,
   *  all in grid-cell coordinates (convert to world with the same mapping as
   *  {@link getCorridorWaypointLoops}). */
  getCorridorGraph(): CorridorGraph {
    return this.corridorGraph;
  }

  /** World-space (baseGroup-local) patrol loops — one per corridor component,
   *  pinned to the corridor floor (y≈0.08, the figure origin is at the feet).
   *  Handed to CrewSystem so personnel walk the real routed hallways. */
  getCorridorWaypointLoops(): Vector3[][] {
    return this.corridorGraph.patrols.map((loop) =>
      loop.map(([cx, cy]) => {
        const p = this.cellCenter(cx, cy, 1, 1);
        p.y = 0.08;
        return p;
      }),
    );
  }

  /** Lay the corridor geometry from the routed graph: a paved floor tile per
   *  cell, lit rails along every travel segment, and per-tile walls/doorways.
   *  Shared floor/strip/steel materials are created once in buildScene. */
  private buildCorridorGrid(): void {
    for (const tile of this.corridorGraph.tiles) this.buildCorridorTile(tile);
    for (const segment of this.corridorGraph.segments) this.buildCorridorStrip(segment);
  }

  /** One paved hallway cell: recessed-flush concrete floor, steel curbs + dim
   *  strip-lights on WALL sides (rock/pad), an open gap + bright threshold on
   *  DOORWAY sides (a bay entrance), and a seamless join on OPEN sides (another
   *  corridor tile). Strictly orthogonal — no diagonal or floating segments. */
  private buildCorridorTile(tile: CorridorTile): void {
    const steel = this.sharedSteel!;
    const group = new Group();
    group.position.copy(this.cellCenter(tile.cx, tile.cy, 1, 1));
    this.baseGroup.add(group);

    const floor = new Mesh(CORRIDOR_GEO.floor, this.corridorFloor!);
    floor.position.y = 0.035;
    floor.receiveShadow = true;
    group.add(floor);

    const half = CELL / 2;
    const edge = half - CURB_T / 2 - 0.03;
    const openSet = new Set(tile.open);
    const doorSet = new Set(tile.doors);
    // north=-z, south=+z, east=+x, west=-x; `alongX` = the wall runs on the x axis.
    const sides: ReadonlyArray<{ dir: CorridorDir; x: number; z: number; alongX: boolean }> = [
      { dir: "north", x: 0, z: -edge, alongX: true },
      { dir: "south", x: 0, z: edge, alongX: true },
      { dir: "east", x: edge, z: 0, alongX: false },
      { dir: "west", x: -edge, z: 0, alongX: false },
    ];
    for (const s of sides) {
      if (openSet.has(s.dir)) continue; // seamless join — no wall between tiles
      if (doorSet.has(s.dir)) {
        // Doorway: leave the gap open, mark it with a bright threshold strip.
        const threshold = new Mesh(
          s.alongX ? CORRIDOR_GEO.thresholdX : CORRIDOR_GEO.thresholdZ,
          this.corridorStripMat!,
        );
        threshold.position.set(s.x, 0.085, s.z);
        group.add(threshold);
        continue;
      }
      // WALL: steel curb hugging the edge + a dim edge strip-light on top.
      const curb = new Mesh(s.alongX ? CORRIDOR_GEO.curbX : CORRIDOR_GEO.curbZ, steel);
      curb.position.set(s.x, CURB_H / 2 + 0.03, s.z);
      curb.castShadow = true;
      curb.receiveShadow = true;
      group.add(curb);
      const strip = new Mesh(
        s.alongX ? CORRIDOR_GEO.stripX : CORRIDOR_GEO.stripZ,
        this.corridorStripMat!,
      );
      strip.position.set(s.x, 0.12, s.z);
      group.add(strip);
    }

    // Faint center travel dot so a through-tile still reads as lit hallway.
    const center = new Mesh(CORRIDOR_GEO.center, this.corridorStripMat!);
    center.position.y = 0.078;
    group.add(center);
  }

  /** Twin lit rails spanning a travel segment (the gap between two adjacent tile
   *  centers) so the corridor path reads as one continuous lit strip. Runs along
   *  the segment axis — strictly orthogonal, following the routed graph edges. */
  private buildCorridorStrip(segment: CorridorSegment): void {
    const a = this.cellCenter(segment.ax, segment.ay, 1, 1);
    const b = this.cellCenter(segment.bx, segment.by, 1, 1);
    const group = new Group();
    group.position.set((a.x + b.x) / 2, 0.079, (a.z + b.z) / 2);
    this.baseGroup.add(group);
    const off = CELL * 0.24;
    for (const sign of [-1, 1]) {
      const rail = new Mesh(
        segment.axis === "x" ? CORRIDOR_GEO.railX : CORRIDOR_GEO.railZ,
        this.corridorStripMat!,
      );
      if (segment.axis === "x") rail.position.z = sign * off;
      else rail.position.x = sign * off;
      group.add(rail);
    }
  }

  private buildFacility(facility: BaseFacility): void {
    const role = roleForFacilityKind(facility.kind);
    const accent = BASE_PALETTE.accent[role];
    const group = new Group();
    group.position.copy(this.roomCenter(facility));
    this.baseGroup.add(group);

    const width = facility.w * CELL - ROOM_GAP;
    const depth = facility.h * CELL - ROOM_GAP;
    // How far the bay floor is sunk below the level slab — bays read as carved
    // niches, not tiles on a flat surface.
    const recess = 0.2;
    const floorY = 0.02 - recess;

    // Recessed concrete niche floor — the bay is carved into the level slab.
    const floor = new Mesh(new BoxGeometry(width, 0.14, depth), this.sharedConcrete!);
    floor.position.y = floorY - 0.07;
    floor.receiveShadow = true;
    floor.castShadow = true;
    group.add(floor);

    // Accent-glow hit pad: carries userData.facilityId so the existing hover
    // tooltip + emissive highlight + click→open-room raycasting still works.
    // Its OWN accentMaterial instance so applyFacilityHighlight can boost it.
    const padMat = accentMaterial(role, 0.32);
    const pad = new Mesh(new BoxGeometry(width - 0.18, 0.04, depth - 0.18), padMat);
    pad.position.y = floorY + 0.03;
    pad.receiveShadow = true;
    pad.userData.facilityId = facility.id;
    this.facilityMeshes.push({ mesh: pad, facilityId: facility.id });
    group.add(pad);

    const trim = new LineSegments(
      new EdgesGeometry(pad.geometry),
      new MeshBasicMaterial({
        color: accent,
        transparent: true,
        opacity: 0.7,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    trim.position.copy(pad.position);
    group.add(trim);

    // Raised steel partition walls frame the sunken niche as a room (door gaps
    // connect neighbouring bays).
    this.addPartitionCurbs(group, width, depth, floorY);

    // The detailed facility diorama — distinct silhouette per role, built from
    // the shared palette materials + its signature accent glow. Scaled up to
    // fill the bay and dropped onto the recessed niche floor. Reactor cores
    // tag themselves (userData.reactorPulse) so the frame loop can pulse them.
    const model = buildFacilityModel(role);
    model.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
        if (child.userData.reactorPulse && child.material instanceof MeshStandardMaterial) {
          this.reactorCores.push(child.material);
        }
      }
    });
    model.position.y = floorY;
    // Scale the (≈1-unit) diorama to fill its bay on the SHORT axis with a
    // margin, clamped so bigger modules read at gameplay distance (~1.5x in the
    // roomy 2x2 bays) while narrow 1x1 bays never let equipment collide with
    // the partition walls. Bay-adaptive => robust to the facility geometry.
    const baySpan = Math.min(width, depth);
    const modelScale = Math.min(1.5, Math.max(1.0, (baySpan - 0.16) * 0.92));
    model.scale.setScalar(modelScale);
    group.add(model);

    // Per-bay accent point light — rooms glow from within (the hero detail).
    const baseIntensity = 5.0;
    const bayLight = new PointLight(accent, baseIntensity, 6.5, 2);
    bayLight.position.set(0, floorY + 0.9, 0);
    group.add(bayLight);
    this.bayLights.push({ light: bayLight, facilityId: facility.id, base: baseIntensity });

    const label = makeLabel(facility.label, accent);
    const labelBaseY = floorY + 0.92;
    label.position.set(0, labelBaseY, -depth * 0.32);
    group.add(label);
    // Register for the one-shot de-overlap pass (layoutFacilityLabels). The bay
    // group sits at y=0, so the label's LOCAL y equals its world y — safe to
    // compare across bays. wx/wz are the bay center in baseGroup-local space.
    const center = this.roomCenter(facility);
    this.facilityLabelAnchors.push({ sprite: label, wx: center.x, wz: center.z, baseY: labelBaseY });
  }

  /** One-shot facility name-chip de-overlap. Camera-facing sprites at similar
   *  world XZ collide on screen; walk them in build order and lift any that lands
   *  near an already-placed chip to a higher tier. Deterministic (stable build
   *  order) and runs once — no per-frame cost. */
  private layoutFacilityLabels(): void {
    const placed: Array<{ wx: number; wz: number; y: number }> = [];
    const stepY = 0.36;
    const near = CELL * 1.05;
    for (const anchor of this.facilityLabelAnchors) {
      let y = anchor.baseY;
      let collided = true;
      while (collided) {
        collided = false;
        for (const p of placed) {
          if (
            Math.abs(p.wx - anchor.wx) < near &&
            Math.abs(p.wz - anchor.wz) < near &&
            Math.abs(p.y - y) < stepY * 0.9
          ) {
            y += stepY;
            collided = true;
            break;
          }
        }
      }
      anchor.sprite.position.y = y;
      placed.push({ wx: anchor.wx, wz: anchor.wz, y });
    }
  }

  /** Low steel partition curbs around a bay — frames it as a room while leaving
   *  a central door gap in each side so bays read as connected niches. */
  private addPartitionCurbs(group: Group, width: number, depth: number, baseY: number): void {
    const steel = this.sharedSteel!;
    const h = 0.55;
    const t = 0.07;
    const gap = Math.min(0.52, Math.min(width, depth) * 0.3);
    const halfW = width / 2;
    const halfD = depth / 2;
    const segX = (width - gap) / 2;
    const segZ = (depth - gap) / 2;
    const gx = gap / 2 + segX / 2;
    const gz = gap / 2 + segZ / 2;
    const y = h / 2 + baseY;
    const make = (geoX: number, geoZ: number, x: number, z: number): void => {
      const curb = new Mesh(new BoxGeometry(geoX, h, geoZ), steel);
      curb.position.set(x, y, z);
      curb.castShadow = true;
      curb.receiveShadow = true;
      group.add(curb);
    };
    make(segX, t, -gx, halfD - t / 2);
    make(segX, t, gx, halfD - t / 2);
    make(segX, t, -gx, -halfD + t / 2);
    make(segX, t, gx, -halfD + t / 2);
    make(t, segZ, -halfW + t / 2, -gz);
    make(t, segZ, -halfW + t / 2, gz);
    make(t, segZ, halfW - t / 2, -gz);
    make(t, segZ, halfW - t / 2, gz);
  }

  private buildExpansionPad(facility: BaseFacility): void {
    const group = new Group();
    group.position.copy(this.roomCenter(facility));
    this.baseGroup.add(group);

    const width = facility.w * CELL - ROOM_GAP;
    const depth = facility.h * CELL - ROOM_GAP;
    // Dark carved niche — unexcavated rock sunk below the concrete level, hint
    // it can be excavated. Reads as negative space against the lit bays.
    const niche = new Mesh(new BoxGeometry(width, 0.18, depth), this.sharedRock!);
    niche.position.y = -0.05;
    niche.receiveShadow = true;
    niche.castShadow = true;
    niche.userData.expansionId = facility.id;
    group.add(niche);

    const edge = new LineSegments(
      new EdgesGeometry(niche.geometry),
      new MeshBasicMaterial({
        color: BASE_PALETTE.floorLine,
        transparent: true,
        opacity: 0.34,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    edge.position.copy(niche.position);
    group.add(edge);

    // EXPANSION label is hidden until the pad is hovered so empty slots don't
    // clutter the cutaway (revealed by onPointerMove).
    const marker = makeLabel("Expansion", BASE_PALETTE.floorLine);
    marker.position.set(0, 0.32, 0);
    marker.scale.set(0.9, 0.24, 1);
    marker.visible = false;
    group.add(marker);
    this.expansionHovers.push({ mesh: niche, label: marker, id: facility.id });
  }

  private addOverheadSystems(): void {
    const pipeMat = this.sharedSteel!;
    const glow = this.glowMaterial(BASE_PALETTE.floorLine, 0.34);
    const systems = [
      { x: 3.25, y: 1.5, sx: CELL * 3.9, sz: 0.045 },
      { x: 4, y: 2.5, sx: 0.045, sz: CELL * 3.1 },
      { x: 2.2, y: 3.2, sx: CELL * 2.2, sz: 0.045 },
      { x: 5.5, y: 3.2, sx: CELL * 2.4, sz: 0.045 },
    ];

    for (const item of systems) {
      const center = this.cellCenter(item.x, item.y, 1, 1);
      const tray = new Mesh(new BoxGeometry(item.sx, 0.045, item.sz), pipeMat);
      tray.position.set(center.x, 0.74, center.z);
      tray.castShadow = true;
      tray.receiveShadow = true;
      const light = new Mesh(new BoxGeometry(item.sx * 0.86, 0.018, item.sz * 0.86), glow);
      light.position.set(center.x, 0.785, center.z);
      this.baseGroup.add(tray, light);
    }
  }

  /** Spawn the animated crew — a handful of personnel walking the corridor
   *  loop between rooms (plus idle figures) so the base reads as alive. The
   *  dedicated CrewSystem owns its pooled meshes, deterministic motion (seeded
   *  LCG), and disposal; we just place its group on the base so it transforms
   *  with the carved facility and tick it each frame. */
  private addCrew(): void {
    // One CrewSystem per routed corridor component (spine gets the most crew).
    // Seeds are deterministic per component index — no Math.random / Date.now —
    // so reloads reproduce the same personnel placement.
    const loops = this.getCorridorWaypointLoops();
    for (let i = 0; i < loops.length; i++) {
      const loop = loops[i]!;
      if (loop.length < 2) continue;
      const isSpine = i === this.corridorGraph.spine;
      const crew = new CrewSystem({
        waypoints: loop,
        count: isSpine ? 9 : 3,
        seed: isSpine ? 1337 : (0x9e3779b9 ^ ((i + 1) * 0x85ebca6b)) >>> 0,
        // Honour prefers-reduced-motion: freeze the idle turn/sway/bob decoration
        // (walkers still travel — that's state, not decoration).
        reducedMotion: this.reducedMotion,
      });
      this.baseGroup.add(crew.group);
      this.crewSystems.push(crew);
    }
  }

  private updateRotators(elapsed: number): void {
    for (const item of this.rotators) {
      const value = item.baseRotation + elapsed * item.speed;
      if (item.axis === "x") item.object.rotation.x = value;
      else if (item.axis === "y") item.object.rotation.y = value;
      else item.object.rotation.z = value;
    }
  }

  private addPerimeterShafts(): void {
    const width = STARTER_BASE_GRID.width * CELL;
    const depth = STARTER_BASE_GRID.height * CELL;
    const mat = this.sharedSteel!;
    const glow = this.glowMaterial(BASE_PALETTE.floorLine, 0.4);
    const positions = [
      [-width / 2 - 0.28, -depth / 2 - 0.18],
      [width / 2 + 0.28, depth / 2 + 0.18],
    ] as const;
    for (const [x, z] of positions) {
      const shaft = new Mesh(new CylinderGeometry(0.12, 0.16, 1.35, 10), mat);
      shaft.position.set(x, 0.42, z);
      shaft.castShadow = true;
      shaft.receiveShadow = true;
      const beacon = new Mesh(new RingGeometry(0.13, 0.2, 24), glow);
      beacon.rotation.x = -Math.PI / 2;
      beacon.position.set(x, 1.12, z);
      this.baseGroup.add(shaft, beacon);
    }
  }

  /** Build the persistent DOM shell once: a full-width top bar, a right sidebar
   *  (primary CTA + objective strip + facility-room detail), a corner footer, a
   *  floating facility tooltip, and the transient notice toast. All campaign-
   *  dependent content is filled in by refreshHud(). */
  private buildHud(): void {
    const topbar = el("div", "base-topbar");
    const brand = el("div", "topbar-brand");
    const brandName = el("span", "brand-name");
    brandName.textContent = "Blacksite Command";
    const brandRegion = el("span", "brand-region");
    brandRegion.textContent = this.opts.campaign.base.region;
    const clock = el("span", "brand-clock");
    brand.append(brandName, brandRegion, clock);
    const chips = el("div", "topbar-chips");
    const tools = el("div", "topbar-tools");
    const help = el("button", "help-btn");
    help.type = "button";
    help.textContent = "?";
    help.title = "Base controls — click for help";
    help.setAttribute("aria-label", "Open base help");
    help.addEventListener("click", () => this.toggleHelp(true));
    // The overview sidebar (which used to host the reset control) is gone, so the
    // "New campaign" action lives in the persistent top-bar tools instead.
    const reset = el("button", "reset-btn");
    reset.type = "button";
    reset.textContent = "New campaign";
    reset.setAttribute("aria-label", "Abandon this campaign and start a new one");
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    tools.append(help, reset);
    const topRight = el("div", "topbar-right");
    topRight.append(chips, tools);
    topbar.append(brand, topRight);

    // Console-glass panel: the room panel is the ONLY sidebar content. It renders
    // per-facility content when a room is open and is hidden entirely on the bare
    // 3D overview. Nothing global (objective/contact cards) lives here anymore.
    const sidebar = el("aside", "base-sidebar ui-panel");
    const body = el("div", "sidebar-body ui-panel-body");
    const roomHost = el("div", "facility-room");
    body.append(roomHost);
    sidebar.append(body);

    const tooltip = el("div", "base-tooltip");
    tooltip.setAttribute("role", "tooltip");
    const notice = el("div", "ui-toast");
    notice.dataset.tone = "info";
    notice.style.display = "none";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");

    // First-time hint: one small unobtrusive line at bottom-center that fades out
    // after the first facility interaction.
    const hint = el("div", "base-hint");
    hint.textContent = "Click a facility to enter its room";

    this.topbarChips = chips;
    this.clockEl = clock;
    this.sidebar = sidebar;
    this.roomHost = roomHost;
    this.hintEl = hint;
    this.tooltipEl = tooltip;
    this.noticeEl = notice;
    this.helpOverlay = this.buildHelpOverlay();

    this.root.append(topbar, sidebar, hint, tooltip, notice, this.helpOverlay);
    this.refreshHud();
  }

  /** Toggle the base HELP overlay (concise controls + mechanics reference). */
  toggleHelp(force?: boolean): void {
    if (!this.helpOverlay) return;
    const show = force ?? !this.helpOverlay.classList.contains("show");
    this.helpOverlay.classList.toggle("show", show);
  }

  private buildHelpOverlay(): HTMLDivElement {
    const overlay = el("div", "base-overlay");
    const card = el("div", "base-help-card");
    const eye = el("div", "eyebrow");
    eye.textContent = "Base controls";
    const title = el("h2");
    title.textContent = "Blacksite command";
    const lede = el("p", "lede");
    lede.textContent =
      "Your underground headquarters. Expand facilities, research alien tech, equip your squad, and launch assaults from here.";
    const list = el("ul");
    const tips: Array<[string, string]> = [
      ["Click a facility", "to dive in and manage its room, staff, and projects."],
      ["Armory / Market", "buy weapons and gear from Council suppliers."],
      ["Barracks", "assign weapons & items, then deploy soldiers to the squad."],
      ["Lab / Workshop", "research alien tech and manufacture captured equipment."],
      ["Command Center", "click it to open the geoscape — scan, intercept, and launch assaults."],
      ["Resources", "$ buys gear & recruits; alloys, elerium, and alien data fuel research and manufacturing."],
    ];
    for (const [head, copy] of tips) {
      const li = el("li");
      const b = el("b");
      b.textContent = `${head} — `;
      li.append(b, document.createTextNode(copy));
      list.appendChild(li);
    }
    const actions = el("div", "base-help-actions");
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

  /** Re-render every dynamic region (top-bar chips/clock, primary CTA, objective
   *  strip, active facility room) from the current campaign/operation. Rebuilds
   *  DOM children only — the 3D scene, renderer, and rAF loop are never touched,
   *  so this is safe to call repeatedly (including from update()). */
  private refreshHud(): void {
    if (!this.roomHost || !this.sidebar) return;
    const campaign = this.opts.campaign;
    this.fillTopbar(campaign);
    // The room panel is the ONLY sidebar content: shown per-facility when a room
    // is open, and removed entirely on the bare 3D overview.
    const overview = this.activeRoom === "overview";
    this.sidebar.style.display = overview ? "none" : "";
    this.roomHost.replaceChildren(overview ? el("div") : this.renderRoom(campaign));
    if (this.hintEl) {
      this.hintEl.classList.toggle("faded", this.hintDismissed || !overview);
    }
    this.applyFacilityHighlight();
  }

  private fillTopbar(campaign: CampaignState): void {
    if (!this.topbarChips || !this.clockEl) return;
    this.clockEl.textContent =
      `Day ${campaign.clock.day} · ${String(campaign.clock.hour).padStart(2, "0")}:00`;
    const constructed = constructedFacilities(campaign);
    const scientists = constructed
      .filter((facility) => facility.kind === "lab")
      .reduce((sum, facility) => sum + facility.staff, 0);
    const engineers = constructed
      .filter((facility) => facility.kind === "workshop")
      .reduce((sum, facility) => sum + facility.staff, 0);
    const threat = campaign.strategic.threat;
    const threatTone = threat >= 70 ? "danger" : threat >= 40 ? "warn" : undefined;
    this.topbarChips.replaceChildren(
      this.topChip("$", "Credits", formatCredits(campaign.resources.credits), "accent", "currency — buys weapons, recruits, and construction"),
      this.topChip("⬢", "Alloys", `${campaign.resources.alloys}`, undefined, "alien alloys — manufacture advanced gear"),
      this.topChip("✦", "Elerium", `${campaign.resources.elerium}`, undefined, "elerium-115 — powers advanced research and manufacturing"),
      this.topChip("◈", "Alien Data", `${campaign.resources.alienData}`, undefined, "recovered data — unlocks and accelerates research"),
      this.topChip("⚗", "Scientists", `${scientists}`, "info", "staffed lab researchers — more = faster research"),
      this.topChip("⚙", "Engineers", `${engineers}`, "info", "staffed workshop engineers — more = faster manufacturing"),
      this.topChip("▲", "Threat", formatPercent(threat), threatTone, "global X-COM threat — high threat raises council panic"),
      this.topChip("◆", "Difficulty", difficultyConfig(campaign).label, undefined, "campaign difficulty — affects enemy counts and starting threat"),
      this.topChip("⌖", "Bases", `${allBases(campaign).length}/${MAX_EXTRA_BASES + 1}`, undefined, "Primary base + built radar bases (max 3 extra)"),
    );
  }

  /** Compact top-bar stat chip built on the shared .ui-chip primitive (icon + label
   *  + value) so the base strip reads as one system with the geoscape stat strip.
   *  `tone` maps to a .ui-chip semantic modifier; the hover title carries the full
   *  label so a color is never the sole signal. */
  private topChip(icon: string, label: string, value: string, tone?: string, hint?: string): HTMLSpanElement {
    const node = el("span", `ui-chip${tone ? ` ui-chip--${tone}` : ""}`);
    node.title = hint ? `${label} — ${hint} (${value})` : `${label}: ${value}`;
    const iconEl = el("span", "ui-chip__icon");
    iconEl.textContent = icon;
    const labelEl = el("span", "ui-chip__label");
    labelEl.textContent = label;
    const valEl = el("span", "ui-chip__value");
    valEl.textContent = value;
    node.append(iconEl, labelEl, valEl);
    return node;
  }

  /** Render the active facility room: a header (icon + facility name + back to
   *  base) followed by the room's focused body. The selected room persists across
   *  update() refreshes because activeRoom is a class field. */
  private renderRoom(campaign: CampaignState): HTMLElement {
    // Tear down any carousels from the previous render (removes their scoped
    // keyboard listeners) before building the new room DOM — dispose discipline.
    this.destroyRoomCarousels();
    const meta = ROOM_META[this.activeRoom];
    const room = el("div", "facility-room");
    // Every room keeps a consistent header (facility name + Back to Base). renderRoom
    // is only ever called for a non-overview room, so the back affordance always shows.
    room.append(this.renderRoomHeader(meta, true));
    const body = el("div", "room-body");
    switch (this.activeRoom) {
      case "research":
        body.append(this.renderResearchRoom(campaign));
        break;
      case "engineering":
        body.append(this.renderEngineeringRoom(campaign));
        break;
      case "barracks":
        body.append(this.renderBarracksRoom(campaign));
        break;
      case "hangar":
        body.append(this.renderHangarRoom(campaign));
        break;
      case "construction":
        body.append(this.renderConstructionRoom(campaign));
        break;
      case "containment":
        body.append(this.renderContainmentRoom(campaign));
        break;
      case "stores":
        body.append(this.renderStoresRoom(campaign));
        break;
      case "radar":
        body.append(this.renderRadarRoom(campaign));
        break;
      case "power":
        body.append(this.renderPowerRoom(campaign));
        break;
      case "overview":
      default:
        // Overview has no panel — refreshHud never renders a room for it.
        break;
    }
    room.append(body);
    return room;
  }

  /** Destroy every carousel mounted for the current room (removes each one's
   *  root-scoped keydown listener). Called before each re-render and on dispose. */
  private destroyRoomCarousels(): void {
    for (const carousel of this.roomCarousels) carousel.destroy();
    this.roomCarousels = [];
  }

  /** Build a carousel over `items`, track it for teardown, and return its root so
   *  a room can drop it straight into its DOM. `onIndexChange` persists the slide
   *  position so a refresh keeps the player where they were. */
  private mountCarousel(
    items: CarouselItem[],
    ariaLabel: string,
    initialIndex: number,
    onIndexChange: (index: number) => void,
  ): HTMLElement {
    const carousel = createCarousel({ items, ariaLabel, initialIndex, onIndexChange });
    this.roomCarousels.push(carousel);
    return carousel.root;
  }

  /** Room header: a "Back to Base" affordance (hidden on the overview hub) plus
   *  the facility-type icon and name, so the screen is never identified by color
   *  alone. */
  private renderRoomHeader(meta: RoomDef, showBack: boolean): HTMLElement {
    const header = el("div", "room-header");
    if (showBack) {
      const back = el("button", "room-back");
      back.textContent = "← Back to Base";
      // exitToHub reverses a 3D interior dive (if any) AND returns to overview,
      // so the same control works for both the dive and a plain room change.
      back.addEventListener("click", () => this.exitToHub());
      header.appendChild(back);
    }
    const icon = el("span", "room-icon");
    icon.textContent = meta.icon;
    const title = el("span", "room-title");
    title.textContent = meta.label;
    header.append(icon, title);
    return header;
  }

  /** Stores room: the base inventory/resource stockpile (credits, alloys,
   *  elerium, alien data) plus the raw capacity readout (power/staff/rooms/
   *  hangar). Read-only — resources are earned on operations, not traded here. */
  private renderStoresRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const summary = summarizeBaseFacilities(constructedFacilities(campaign));
    const invLabel = el("div", "section-label");
    invLabel.textContent = "Stockpile";
    const res = campaign.resources;
    const inv = el("div", "op-chips");
    inv.append(
      span(`${formatCredits(res.credits)} credits`),
      span(`${res.alloys} alloys`),
      span(`${res.elerium} elerium`),
      span(`${res.alienData} alien data`),
    );
    const capLabel = el("div", "section-label");
    capLabel.textContent = "Capacity";
    const cap = el("div", "op-chips");
    cap.append(
      span(`Power ${summary.powerUsed}/${summary.powerCapacity}`),
      span(`Staff ${summary.staffAssigned}`),
      span(`Rooms ${summary.facilities}`),
      span(`Hangar ${summary.hangarSlots} slots`),
    );
    const hint = el("p", "card-copy");
    hint.textContent =
      "Alloys, elerium, and alien data are recovered on operations and fuel research and manufacturing. Credits buy gear and recruits.";
    wrap.append(invLabel, inv, capLabel, cap, hint);
    return wrap;
  }

  /** Radar room: read-only detection/tracking status — the current UFO contact
   *  summary (reused from the airborne banner logic) and a pointer to the Command
   *  Center for the actual intercept/launch. No launch button lives here. */
  private renderRadarRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const label = el("div", "section-label");
    label.textContent = "Detection";
    wrap.appendChild(label);
    const contact = campaign.ufoContact;
    const card = el("section", "tab-card");
    const head = el("div", "panel-head");
    const title = el("span", "panel-title");
    const copy = el("p", "card-copy");
    if (!contact) {
      title.textContent = "No contact";
      copy.textContent =
        "Radar array online and sweeping. Advance time in the Command Center to pick up a UFO track.";
    } else if (contact.status === "engaging") {
      title.textContent = `Tracking ${contact.id} — engaging`;
      copy.textContent = `Interceptor engaging ${contact.id} over ${contact.region}. Direct the dogfight from the Command Center.`;
    } else if (contact.status === "escaped") {
      title.textContent = `${contact.id} — lost`;
      copy.textContent = `${contact.id} slipped the intercept over ${contact.region}. Resume the sweep from the Command Center.`;
    } else if (contact.status === "crashed" || contact.status === "landed") {
      title.textContent = `${contact.id} — grounded`;
      copy.textContent = `${contact.id} is down over ${contact.region}. Open the Command Center to launch the recovery operation.`;
    } else {
      title.textContent = `Tracking ${contact.id}`;
      copy.textContent = `${contact.id} is airborne over ${contact.region}. Open the Command Center to intercept.`;
    }
    head.append(title);
    card.append(head, copy);
    const pointer = el("p", "card-copy");
    pointer.textContent = "Intercepts and launches are run from the Command Center (Earth view).";
    wrap.append(card, pointer);
    return wrap;
  }

  /** Reactor room: the base power budget (used vs. capacity) and a plain-language
   *  reactor status derived from the facility summary. */
  private renderPowerRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const summary = summarizeBaseFacilities(constructedFacilities(campaign));
    const label = el("div", "section-label");
    label.textContent = "Power budget";
    const chips = el("div", "op-chips");
    const margin = summary.powerCapacity - summary.powerUsed;
    chips.append(
      span(`Load ${summary.powerUsed}/${summary.powerCapacity}`),
      span(margin >= 0 ? `+${margin} spare` : `${margin} over`),
    );
    const bar = el("div", margin < 0 ? "progress danger" : "progress");
    const fill = el("i");
    const pct = summary.powerCapacity > 0
      ? Math.min(100, Math.round((summary.powerUsed / summary.powerCapacity) * 100))
      : 0;
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    const copy = el("p", "card-copy");
    copy.textContent = margin >= 0
      ? `Reactor stable — ${margin} power units in reserve for new facilities.`
      : `Reactor over budget by ${-margin} units. Build another reactor or shut down a facility.`;
    wrap.append(label, chips, bar, copy);
    return wrap;
  }

  /** Hangar room: the fleet roster (2 interceptors + 1 Skyranger transport) with
   *  per-craft integrity/sorties/repair status, followed by the council equipment
   *  market. The market keeps its `.market-card` container with Buy buttons so
   *  smoke/screen readers can always locate it here. */
  private renderHangarRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const status = el("section", "tab-card");
    const head = el("div", "panel-head");
    const title = el("span", "panel-title");
    title.textContent = "Fleet";
    head.append(title);
    const list = el("div", "craft-list");
    for (const craft of this.resolveFleet(campaign)) {
      list.appendChild(this.renderCraftRow(campaign, craft));
    }
    status.append(head, list);
    wrap.append(status, this.buildMarketPanel());
    return wrap;
  }

  /** Resolve the hangar fleet. New saves carry `campaign.fleet` directly; older
   *  single-interceptor saves (pre-fleet) synthesize the 3-craft roster from the
   *  legacy interceptor so the hangar always lists the full fleet. */
  private resolveFleet(campaign: CampaignState): Craft[] {
    if (campaign.fleet && campaign.fleet.length > 0) {
      return campaign.fleet;
    }
    const legacy = campaign.interceptor;
    return [
      {
        id: "int-1",
        kind: "interceptor",
        name: "Raptor-1",
        damage: legacy.damage,
        sorties: legacy.sorties,
        repairedAtHour: legacy.repairedAtHour,
      },
      { id: "int-2", kind: "interceptor", name: "Raptor-2", damage: 0, sorties: 0 },
      { id: "sky-1", kind: "transport", name: "Skyranger", damage: 0, sorties: 0 },
    ];
  }

  /** One craft row: a kind label + name (the icon color is always paired with the
   *  kind label text, never conveyed by color alone) and an integrity / sorties /
   *  repair status line. Interceptors show damage + sorties; the transport shows
   *  deployment readiness. */
  private renderCraftRow(campaign: CampaignState, craft: Craft): HTMLElement {
    const speed = craftSpeedDegPerHour(craft);
    // Advanced interceptor (the manufactured Phantom): cruises faster than the
    // starting Raptor. Gets a distinct violet accent + diamond glyph and shows its
    // air-combat stats. Detection is data-driven (speed above the default cruise),
    // so it never hardcodes a craft id/name.
    const advanced = craft.kind === "interceptor" && speed > DEFAULT_INTERCEPTOR_SPEED_DEG_PER_HOUR;
    const row = el("div", `craft-row ${craft.kind}${advanced ? " advanced" : ""}`);
    const icon = el("span", "craft-icon");
    icon.textContent = advanced ? "◆" : "✈";
    const body = el("div", "craft-body");
    const heading = el("div", "craft-heading");
    const kind = el("span", "craft-kind");
    kind.textContent = advanced
      ? "Advanced interceptor"
      : craft.kind === "interceptor"
        ? "Interceptor"
        : "Transport";
    const name = el("strong");
    name.textContent = craft.name;
    const speedChip = el("span", "craft-speed");
    speedChip.textContent = formatSpeed(speed);
    speedChip.title = "Cruise / pursuit speed";
    heading.append(kind, name, speedChip);
    const copy = el("p", "card-copy");
    const repairedAt = craft.repairedAtHour;
    const repairing = repairedAt !== undefined && repairedAt > campaign.clock.elapsedHours;
    const integrity = Math.max(0, 100 - craft.damage);
    if (craft.kind === "transport") {
      copy.textContent = repairing
        ? `In maintenance — ${formatHours(repairedAt! - campaign.clock.elapsedHours)} until ready.`
        : `Ready for deployment — ${craft.sorties} sorties flown.`;
    } else if (repairing) {
      copy.textContent =
        `Integrity ${formatPercent(integrity)} — repairs underway (${formatHours(repairedAt! - campaign.clock.elapsedHours)} remaining).`;
    } else {
      copy.textContent = `Integrity ${formatPercent(integrity)} — ${craft.sorties} sorties flown. Ready to intercept.`;
    }
    body.append(heading, copy);
    if (advanced) {
      // Surface the manufactured craft's combat edge (hull + weapon multiplier).
      const stats = el("p", "craft-stats");
      stats.textContent = `Hull ${craftHullPoints(craft)} · weapon ${formatPercent(craftWeaponPower(craft) * 100)} · runs down any UFO.`;
      body.append(stats);
    }
    row.append(icon, body);
    return row;
  }

  /** Barracks room: compact roster table — deploy toggle, name, rank, status
   *  chip, weapon select — one row per operative. Click a row to expand inline
   *  stats. The header row carries the deploy count + recruit action. */
  private renderBarracksRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const deployment = deploymentSoldiers(campaign);
    const deployedIds = new Set(deployment.map((soldier) => soldier.id));
    // RECRUIT stays in the room header, OUTSIDE the per-soldier carousel.
    const head = el("div", "panel-head");
    const title = el("span", "panel-title");
    title.textContent = `${deployment.length}/${DEPLOYMENT_SIZE} deployed`;
    const recruit = el("button");
    recruit.textContent = `Recruit (${RECRUIT_COST}c)`;
    recruit.disabled = campaign.strategic.status !== "active" || !canRecruitSoldier(campaign);
    recruit.addEventListener("click", () => this.opts.onRecruitSoldier());
    head.append(title, recruit);
    wrap.appendChild(head);

    if (campaign.soldiers.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No operatives on roster. Recruit to field a squad.";
      wrap.appendChild(empty);
    } else {
      // One sliding dossier per soldier. The strip cell's dot signals readiness.
      const items: CarouselItem[] = campaign.soldiers.map((soldier) => ({
        id: soldier.id,
        stripLabel: soldier.name,
        stripStatus:
          soldier.status === "kia" ? "locked"
            : soldier.status === "wounded" ? "active"
            : deployedIds.has(soldier.id) ? "done"
            : "ready",
        render: () => this.renderSoldierDossier(campaign, soldier, deployedIds),
      }));
      const selected = campaign.soldiers.findIndex((soldier) => soldier.id === this.expandedSoldierId);
      const initial = selected >= 0 ? selected : 0;
      const carouselWrap = el("div", "room-carousel-wrap");
      carouselWrap.appendChild(
        this.mountCarousel(items, "Squad roster", initial, (index) => {
          this.expandedSoldierId = campaign.soldiers[index]?.id ?? null;
        }),
      );
      wrap.appendChild(carouselWrap);
    }
    // Medbay has no standalone room — its wounded-recovery readout folds in here.
    const wounded = campaign.soldiers.filter((soldier) => soldier.status === "wounded");
    if (wounded.length > 0) {
      const medbay = el("section", "tab-card");
      const mHead = el("div", "panel-head");
      const mTitle = el("span", "panel-title");
      mTitle.textContent = `Medbay — ${wounded.length} recovering`;
      mHead.append(mTitle);
      const list = el("div", "medbay-list");
      for (const soldier of wounded) {
        const remaining = Math.max(
          0,
          (soldier.woundedUntilHour ?? campaign.clock.elapsedHours) - campaign.clock.elapsedHours,
        );
        const row = el("div", "medbay-row");
        row.append(span(soldier.name, "medbay-name"), span(formatHours(remaining), "medbay-eta"));
        list.appendChild(row);
      }
      medbay.append(mHead, list);
      wrap.appendChild(medbay);
    }
    const fallen = campaign.soldiers.filter((soldier) => soldier.status === "kia");
    if (fallen.length > 0) wrap.appendChild(this.renderMemorial(campaign, fallen));
    return wrap;
  }

  /** Memorial panel — a somber roll of the KIA. Each entry honours the operative
   *  with name, rank, missions survived, how they fell (when the last mission
   *  report records it), and their background. Muted slate palette by design. */
  private renderMemorial(campaign: CampaignState, fallen: readonly CampaignSoldier[]): HTMLElement {
    const panel = el("section", "memorial-panel");
    const head = el("div", "memorial-head");
    const icon = el("span", "memorial-icon");
    icon.textContent = "✚";
    const title = el("span", "memorial-title");
    title.textContent = `In Memoriam · ${fallen.length} fallen`;
    head.append(icon, title);
    const subtitle = el("p", "memorial-subtitle");
    subtitle.textContent = "We honour those who gave everything in defence of Earth.";
    const list = el("div", "memorial-list");
    for (const soldier of fallen) {
      list.appendChild(this.renderMemorialEntry(campaign, soldier));
    }
    panel.append(head, subtitle, list);
    return panel;
  }

  private renderMemorialEntry(campaign: CampaignState, soldier: CampaignSoldier): HTMLElement {
    const entry = el("div", "memorial-entry");
    const nameRow = el("div", "memorial-name-row");
    nameRow.append(span(soldier.name, "memorial-name"), span(soldier.rank, "memorial-rank"));
    const detailParts = [
      `${soldier.survivedMissions} mission${soldier.survivedMissions === 1 ? "" : "s"} survived`,
    ];
    const death = this.soldierDeathContext(campaign, soldier.id);
    if (death) detailParts.push(death);
    const detail = el("div", "memorial-detail");
    detail.textContent = detailParts.join(" · ");
    entry.append(nameRow, detail);
    if (soldier.bio) {
      const bioEl = el("div", "memorial-bio");
      bioEl.textContent = soldier.bio;
      entry.appendChild(bioEl);
    }
    return entry;
  }

  /** Resolves how a fallen operative died from the most recent mission report.
   *  Only `lastMission` is persisted, so this is authoritative for the latest
   *  losses and falls back to a generic honourable mention for older casualties. */
  private soldierDeathContext(campaign: CampaignState, soldierId: string): string | null {
    const last = campaign.lastMission;
    if (!last || !last.kiaSoldierIds.includes(soldierId)) return null;
    return `Killed in action during Operation ${last.codename} (${last.region})`;
  }

  /** Full per-soldier dossier shown as one carousel slide: name + rank insignia +
   *  deploy toggle, bio, a stat block (TU/HP/accuracy/reactions/bravery with
   *  survived-mission growth), a career line, the weapon selector, and the item
   *  loadout rows. Nothing is clipped — every field has the full panel width. */
  private renderSoldierDossier(
    campaign: CampaignState,
    soldier: CampaignSoldier,
    deployedIds: Set<string>,
  ): HTMLElement {
    const node = el("article", `dossier ${soldier.status}`);
    const deployed = deployedIds.has(soldier.id);

    // --- Header: identity + deploy toggle ---
    const head = el("div", "dossier-head");
    const idBlock = el("div", "dossier-id");
    const insignia = el("span", "dossier-insignia");
    insignia.textContent = RANK_INSIGNIA[soldier.rank] ?? "•";
    insignia.title = soldier.rank;
    const nameWrap = el("div", "dossier-name-wrap");
    const nameEl = el("span", "dossier-name");
    nameEl.textContent = soldier.name;
    const rankEl = el("span", "dossier-rank");
    rankEl.textContent = soldier.rank;
    nameWrap.append(nameEl, rankEl);
    idBlock.append(insignia, nameWrap);
    head.append(idBlock, this.renderSoldierStatus(campaign, soldier));
    node.appendChild(head);

    // --- Deploy toggle (own row, clearly tappable) ---
    const deployToggle = el("label", "deploy-toggle dossier-deploy");
    const deployCheckbox = document.createElement("input");
    deployCheckbox.type = "checkbox";
    deployCheckbox.checked = deployed;
    // While a deployment flight is airborne / on station the squad is committed aboard
    // the Skyranger — editing (or emptying) it would strand the arrival DEPLOY chip on
    // a squad that no longer exists (a silent no-op in onBeginAssault). Lock the roster
    // for the duration of the flight.
    const deploymentAirborne = (campaign.activeFlights ?? []).some((f) => f.purpose === "deployment");
    deployCheckbox.disabled =
      campaign.strategic.status !== "active" ||
      deploymentAirborne ||
      (deployed ? false : !canDeploySoldier(campaign, soldier.id));
    if (deploymentAirborne) {
      deployToggle.title = "Squad is aboard the Skyranger — recall or complete the operation to change the roster.";
    }
    deployCheckbox.setAttribute("aria-label", `${deployed ? "Remove" : "Deploy"} ${soldier.name}`);
    deployCheckbox.addEventListener("change", () => {
      this.opts.onToggleDeployment(soldier.id, deployCheckbox.checked);
    });
    deployToggle.append(
      deployCheckbox,
      document.createTextNode(deployed ? "Deployed — drop from squad" : "Add to deployment"),
    );
    node.appendChild(deployToggle);

    // --- Bio ---
    if (soldier.bio) {
      const bioEl = el("p", "dossier-bio");
      bioEl.textContent = soldier.bio;
      node.appendChild(bioEl);
    }

    // --- Stat block: effective battle stats (trooper base + rank/armor/growth). ---
    const base = TEMPLATES.trooper?.stats;
    const bonus = campaignSoldierStatBonus(campaign, soldier);
    const grid = el("div", "dossier-stats");
    grid.append(
      this.dossierStat("TU", (base?.timeUnits ?? 0) + bonus.timeUnits, bonus.timeUnits),
      this.dossierStat("HP", (base?.health ?? 0) + bonus.health, bonus.health),
      this.dossierStat("Accuracy", (base?.firingAccuracy ?? 0) + bonus.firingAccuracy, bonus.firingAccuracy),
      this.dossierStat("Reactions", (base?.reactions ?? 0) + bonus.reactions, bonus.reactions),
      this.dossierStat("Bravery", base?.bravery ?? 0, 0),
    );
    node.appendChild(grid);

    // --- Career line ---
    const career = el("div", "dossier-career");
    const growth = soldier.statGrowth ? this.formatStatDeltas(soldier.statGrowth) : "";
    let careerText = `${soldier.missions} missions · ${soldier.survivedMissions} survived`;
    if (growth) careerText += ` · career growth ${growth}`;
    career.textContent = careerText;
    node.appendChild(career);

    // --- Weapon loadout row ---
    const weaponRow = el("div", "dossier-loadout-row");
    const weaponLabel = el("span", "dossier-loadout-label");
    weaponLabel.textContent = "Weapon";
    const currentWeapon = soldierWeaponId(campaign, soldier.id);
    const weaponSelect = el("select", "dossier-weapon");
    weaponSelect.disabled = soldier.status === "kia" || campaign.strategic.status !== "active";
    weaponSelect.setAttribute("aria-label", `Weapon for ${soldier.name}`);
    for (const weaponId of CAMPAIGN_WEAPON_IDS) {
      const option = document.createElement("option");
      option.value = weaponId;
      option.textContent =
        `${WEAPONS[weaponId]?.name ?? weaponId} (${availableWeaponCount(campaign, weaponId, soldier.id)})`;
      option.selected = weaponId === currentWeapon;
      option.disabled = weaponId !== currentWeapon && !canAssignSoldierWeapon(campaign, soldier.id, weaponId);
      weaponSelect.appendChild(option);
    }
    weaponSelect.addEventListener("change", () => {
      this.opts.onAssignWeapon(soldier.id, weaponSelect.value as CampaignWeaponId);
    });
    weaponRow.append(weaponLabel, weaponSelect);
    node.appendChild(weaponRow);

    // --- Item loadout ---
    const itemsLabel = el("span", "dossier-loadout-label");
    itemsLabel.textContent = "Items";
    node.append(itemsLabel, this.renderSoldierItems(campaign, soldier));
    return node;
  }

  /** One stat tile in the dossier stat block: label, value, and a `+N` growth
   *  badge when the effective stat is above the trooper baseline. */
  private dossierStat(label: string, value: number, bonus: number): HTMLElement {
    const tile = el("div", "dossier-stat");
    const val = el("span", "dossier-stat-value");
    val.textContent = `${value}`;
    if (bonus > 0) {
      const badge = el("span", "dossier-stat-bonus");
      badge.textContent = `+${bonus}`;
      val.appendChild(badge);
    }
    const lab = el("span", "dossier-stat-label");
    lab.textContent = label;
    tile.append(val, lab);
    return tile;
  }

  /** Format a stat delta block as `+N acc/+M rea/...`, omitting zero entries and
   *  following the acc/rea/hp/TU order. Returns "" when every entry is zero.
   *  Works for both accumulated {@link SoldierStatGrowth} and the effective
   *  {@link SoldierStatBonus} since they share the same four numeric fields. */
  private formatStatDeltas(delta: {
    firingAccuracy: number;
    reactions: number;
    health: number;
    timeUnits: number;
  }): string {
    const segments: string[] = [];
    if (delta.firingAccuracy !== 0) segments.push(`+${delta.firingAccuracy} acc`);
    if (delta.reactions !== 0) segments.push(`+${delta.reactions} rea`);
    if (delta.health !== 0) segments.push(`+${delta.health} hp`);
    if (delta.timeUnits !== 0) segments.push(`+${delta.timeUnits} TU`);
    return segments.join("/");
  }

  /** Compact per-soldier backpack: for each consumable item type, show how many
   *  the soldier carries vs. the armory's available stock, with +/− equip
   *  controls that route through onAssignItem/onUnassignItem. Icon + label carry
   *  the meaning; color is secondary. The row stays one line per soldier. */
  private renderSoldierItems(campaign: CampaignState, soldier: CampaignSoldier): HTMLElement {
    const wrap = el("div", "soldier-items");
    const interactive =
      campaign.strategic.status === "active" && soldier.status !== "kia";
    const wired = this.opts.onAssignItem !== undefined && this.opts.onUnassignItem !== undefined;
    const carried = soldierItemIds(campaign, soldier.id);
    for (const itemId of ITEM_IDS) {
      const meta = ITEMS[itemId];
      const held = carried.filter((id) => id === itemId).length;
      const stock = availableItemCount(campaign, itemId);
      const group = el("div", "item-control");
      const icon = el("span", "item-icon");
      icon.textContent = ITEM_ICON[itemId] ?? "■";
      const label = el("span", "item-label");
      label.textContent = meta?.name ?? itemId;
      const heldEl = el("span", "item-held");
      heldEl.textContent = `×${held}`;
      const stockEl = el("span", "item-stock");
      stockEl.textContent = `${stock} in armory`;
      const minusBtn = el("button", "item-btn");
      minusBtn.type = "button";
      minusBtn.textContent = "−";
      minusBtn.setAttribute(
        "aria-label",
        `Remove one ${meta?.name ?? itemId} from ${soldier.name}`,
      );
      minusBtn.disabled = !interactive || !wired || held === 0;
      minusBtn.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        this.opts.onUnassignItem?.(soldier.id, itemId);
      });
      const plusBtn = el("button", "item-btn");
      plusBtn.type = "button";
      plusBtn.textContent = "+";
      plusBtn.setAttribute(
        "aria-label",
        `Assign one ${meta?.name ?? itemId} to ${soldier.name}`,
      );
      plusBtn.disabled =
        !interactive ||
        !wired ||
        held >= MAX_ITEM_CARRY ||
        !canAssignSoldierItem(campaign, soldier.id, itemId);
      plusBtn.addEventListener("click", (event: MouseEvent) => {
        event.stopPropagation();
        this.opts.onAssignItem?.(soldier.id, itemId);
      });
      group.append(icon, label, heldEl, stockEl, minusBtn, plusBtn);
      wrap.appendChild(group);
    }
    return wrap;
  }

  /** Status chip: icon + text carry the meaning, color is secondary. */
  private renderSoldierStatus(campaign: CampaignState, soldier: CampaignSoldier): HTMLElement {
    const chipEl = el("span", `status-chip ${soldier.status}`);
    const icon = el("span");
    if (soldier.status === "wounded") {
      const remaining = Math.max(
        0,
        (soldier.woundedUntilHour ?? campaign.clock.elapsedHours) - campaign.clock.elapsedHours,
      );
      icon.textContent = "✚";
      chipEl.append(icon, document.createTextNode(`Rec ${formatHours(remaining)}`));
    } else if (soldier.status === "kia") {
      icon.textContent = "✖";
      chipEl.append(icon, document.createTextNode("KIA"));
    } else {
      icon.textContent = "✓";
      chipEl.append(icon, document.createTextNode("Ready"));
    }
    return chipEl;
  }

  /** Construction room: base power/staff/room capacity chips, then active
   *  construction + buildable/expansion facilities. Reached by clicking an
   *  unexcavated expansion pad in the 3D base. The old "Installed" facility-row
   *  nav list was overview's DOM room-switcher and is gone with the sidebar —
   *  facilities are entered by clicking their 3D pad. */
  private renderConstructionRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const summary = summarizeBaseFacilities(constructedFacilities(campaign));
    const capLabel = el("div", "section-label");
    capLabel.textContent = "Base capacity";
    const chips = el("div", "op-chips");
    chips.append(
      span(`Power ${summary.powerUsed}/${summary.powerCapacity}`),
      span(`Staff ${summary.staffAssigned}`),
      span(`Rooms ${summary.facilities}`),
    );

    wrap.append(capLabel, chips, this.renderConstructionList(campaign));
    return wrap;
  }

  /** Containment room: a capacity readout, the held-captive roster (or an
   *  empty-state directing the player to bring specimens back alive), and a
   *  hint that interrogation research consumes captives for HQ intel. Reuses
   *  the hangar's craft-list layout — a captive roster shares the same shape
   *  (icon + heading + status copy). */
  private renderContainmentRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const captives = campaign.captives ?? [];
    const capacity = hasContainment(campaign) ? CONTAINMENT_CAPACITY : 0;
    const head = el("div", "panel-head");
    const title = el("span", "panel-title");
    title.textContent = `Held ${captives.length}/${capacity}`;
    head.append(title);
    wrap.appendChild(head);

    if (captives.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent =
        "No live specimens held. Stun aliens with a stun rod and win the mission to bring them back — a built containment cell secures them.";
      wrap.appendChild(empty);
    } else {
      const list = el("div", "craft-list");
      for (const captive of captives) list.appendChild(this.renderCaptiveRow(campaign, captive));
      wrap.appendChild(list);
    }

    const hint = el("p", "card-copy");
    hint.textContent =
      "Interrogation research (alien / leader / commander) consumes a qualifying captive to unlock intel and, eventually, reveal the alien HQ.";
    wrap.appendChild(hint);
    return wrap;
  }

  private renderCaptiveRow(campaign: CampaignState, captive: CampaignCaptive): HTMLElement {
    const row = el("div", "craft-row");
    const icon = el("span", "craft-icon");
    icon.textContent = "⛓";
    const body = el("div", "craft-body");
    const heading = el("div", "craft-heading");
    const kind = el("span", "craft-kind");
    kind.textContent = captive.rank;
    const name = el("strong");
    name.textContent = CAPTIVE_SPECIES[captive.templateId] ?? captive.templateId;
    heading.append(kind, name);
    const copy = el("p", "card-copy");
    const hoursAgo = Math.max(0, campaign.clock.elapsedHours - captive.capturedAtHour);
    copy.textContent = `Captured ${formatHours(hoursAgo)} ago.`;
    body.append(heading, copy);
    row.append(icon, body);
    return row;
  }

  /** Research room rendered as a prerequisite tech tree. Projects are grouped
   *  into tier columns (tier = longest prerequisite chain depth; tier-0 roots in
   *  the first column) with a connector rail linking each tier to the one before
   *  it. Each node is color-coded AND labeled by status (icon + text badge, never
   *  color alone): completed (green check), available (cyan, Start button),
   *  locked (muted, lists unmet prerequisites), or in-progress (amber bar).
   *  Status comes from {@link researchTree}; the active project is always rendered
   *  with its progress bar regardless of its tree status. */
  private renderResearchRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div", "room-carousel-wrap");

    // Order projects the way the old tier columns read: tier ascending, then the
    // tree's own order within a tier. One carousel slide per project.
    const tree = researchTree(campaign);
    const tierOf = this.researchTiers();
    const ordered = [...tree].sort((a, b) => {
      const ta = tierOf.get(a.project.id) ?? 0;
      const tb = tierOf.get(b.project.id) ?? 0;
      if (ta !== tb) return ta - tb;
      return tree.indexOf(a) - tree.indexOf(b);
    });

    if (ordered.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No research projects available.";
      wrap.appendChild(empty);
      return wrap;
    }

    const items: CarouselItem[] = ordered.map((entry) => {
      const status = this.researchReconciledStatus(campaign, entry);
      return {
        id: entry.project.id,
        stripLabel: entry.project.title,
        stripStatus:
          status === "active" ? "active"
            : status === "completed" ? "done"
            : status === "available" ? "ready"
            : "locked",
        render: () => this.renderResearchDetail(campaign, entry, tierOf.get(entry.project.id) ?? 0),
      };
    });

    const savedResearch = items.findIndex((it) => it.id === this.researchCarouselProjectId);
    const initial = savedResearch >= 0 ? savedResearch : 0;
    wrap.appendChild(
      this.mountCarousel(items, "Research projects", initial, (index) => {
        this.researchCarouselProjectId = items[index]?.id ?? null;
      }),
    );
    return wrap;
  }

  /** Compute each project's tier (longest prerequisite chain depth). Tier-0 roots
   *  have no prerequisites; every other project sits one tier deeper than its
   *  deepest prerequisite. Cycle-guarded so a malformed graph can't hang the UI. */
  private researchTiers(): Map<ResearchId, number> {
    const byId = new Map<ResearchId, ResearchProject>();
    for (const project of RESEARCH_PROJECTS) byId.set(project.id, project);
    const cache = new Map<ResearchId, number>();
    const visiting = new Set<ResearchId>();
    const resolve = (id: ResearchId): number => {
      const cached = cache.get(id);
      if (cached !== undefined) return cached;
      if (visiting.has(id)) return 0;
      visiting.add(id);
      const project = byId.get(id);
      let tier = 0;
      if (project) {
        for (const req of project.requires) tier = Math.max(tier, resolve(req) + 1);
      }
      visiting.delete(id);
      cache.set(id, tier);
      return tier;
    };
    for (const project of RESEARCH_PROJECTS) resolve(project.id);
    return cache;
  }

  /** Reconcile a project's tree status into the four states the UI renders.
   *  researchTree may report "locked" merely because the lab is busy; a project
   *  whose prerequisites are all met is treated as "available" (lab-blocked) so we
   *  never show a misleading "Requires:" line on something already unlocked. */
  private researchReconciledStatus(
    campaign: CampaignState,
    entry: ResearchTreeNode,
  ): "completed" | "available" | "locked" | "active" {
    if (campaign.activeResearch?.projectId === entry.project.id) return "active";
    const requiresMet = entry.project.requires.every((req) => hasResearch(campaign, req));
    if (entry.status === "locked" && requiresMet) return "available";
    return entry.status;
  }

  /** Full-detail research slide for the carousel: status badge, complete title +
   *  description (no horizontal clip), cost/duration chips, requirement notes,
   *  progress bar when active, and the wired action button. */
  private renderResearchDetail(
    campaign: CampaignState,
    entry: ResearchTreeNode,
    tier: number,
  ): HTMLElement {
    const project = entry.project;
    const activeRes = campaign.activeResearch;
    const status = this.researchReconciledStatus(campaign, entry);
    const unmetRequires = project.requires
      .filter((req) => !hasResearch(campaign, req))
      .map((req) => RESEARCH_PROJECTS.find((candidate) => candidate.id === req)?.title ?? req);

    const node = el("article", `proj-detail ${status}`);

    const head = el("div", "proj-detail-head");
    const badge = el("span", `proj-badge ${status}`);
    const badgeIcon = el("span", "proj-badge-icon");
    if (status === "active") {
      badgeIcon.textContent = "↻";
      badge.append(badgeIcon, document.createTextNode("In progress"));
    } else if (status === "completed") {
      badgeIcon.textContent = "✓";
      badge.append(badgeIcon, document.createTextNode("Completed"));
    } else if (status === "available") {
      badgeIcon.textContent = "▸";
      badge.append(badgeIcon, document.createTextNode("Available"));
    } else {
      badgeIcon.textContent = "⊘";
      badge.append(badgeIcon, document.createTextNode("Locked"));
    }
    const tierTag = el("span", "proj-tier");
    tierTag.textContent = `Tier ${tier}`;
    head.append(badge, tierTag);
    node.appendChild(head);

    const title = el("h3", "proj-title");
    title.textContent = project.title;
    node.appendChild(title);

    const desc = el("p", "proj-desc");
    desc.textContent = status === "completed" ? project.completedDescription : project.description;
    node.appendChild(desc);

    // Captive-gated nodes (the interrogation chain) annotate their requirement.
    const captiveLabel = this.captiveRequirementLabel(project);
    const captiveQualified = captiveLabel === null || this.hasQualifyingCaptiveFor(campaign, project);
    if (captiveLabel && status !== "completed") {
      const note = el("div", "proj-req");
      note.textContent =
        status === "available" && !captiveQualified ? this.captiveBlockedNote(project) : captiveLabel;
      node.appendChild(note);
    }

    if (status === "active" && activeRes) {
      const remaining = Math.max(0, activeRes.completesAtHour - campaign.clock.elapsedHours);
      const duration = activeRes.completesAtHour - activeRes.startedAtHour;
      const fraction =
        duration > 0
          ? Math.min(1, Math.max(0, (campaign.clock.elapsedHours - activeRes.startedAtHour) / duration))
          : 0;
      const bar = el("div", "progress");
      const fill = el("i");
      fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.appendChild(fill);
      const meta = el("div", "proj-meta-line");
      meta.textContent = `${formatHours(remaining)} remaining — scientists are working`;
      node.append(bar, meta);
      return node;
    }

    if (status === "completed") return node;

    if (status === "locked") {
      const req = el("div", "proj-req");
      req.textContent =
        unmetRequires.length > 0 ? `Requires: ${unmetRequires.join(", ")}` : "Locked";
      node.appendChild(req);
      return node;
    }

    // available: cost + duration chips, then the Start action.
    const cost = researchCost(campaign, project.id);
    const chips = el("div", "proj-cost-row");
    chips.append(
      span(formatCost(cost), "proj-cost"),
      span(formatHours(researchDuration(campaign, project.id)), "proj-duration"),
    );
    node.appendChild(chips);

    const labBusy = !!campaign.activeResearch;
    const canStart = canStartResearch(campaign, project.id);
    const button = el("button", "proj-action");
    button.textContent = labBusy
      ? "Lab busy"
      : canStart
        ? "Start research"
        : !captiveQualified
          ? "Need captive"
          : "Need resources";
    button.disabled = labBusy || !canStart;
    button.addEventListener("click", () => this.opts.onStartResearch(project.id));
    node.appendChild(button);
    return node;
  }

  /** Requirement label for a captive-gated research node ("Requires live
   *  captive", optionally rank-floored), or null when the project has no
   *  captive requirement. */
  private captiveRequirementLabel(project: ResearchProject): string | null {
    if (project.requiresCaptiveRank === "commander") return "Requires live captive (commander)";
    if (project.requiresCaptiveRank === "leader") return "Requires live captive (leader+)";
    if (project.requiresCaptive) return "Requires live captive";
    return null;
  }

  /** Explains why a captive-gated node can't start: the rank floor is unmet or
   *  no captive is held at all. Mirrors storage.ts's private
   *  captiveQualifies/hasQualifyingCaptive so the research room can surface the
   *  reason without exposing that internal helper. */
  private captiveBlockedNote(project: ResearchProject): string {
    return project.requiresCaptiveRank
      ? `Blocked — no ${project.requiresCaptiveRank}-rank captive in containment`
      : "Blocked — no live captive in containment";
  }

  private hasQualifyingCaptiveFor(campaign: CampaignState, project: ResearchProject): boolean {
    if (!project.requiresCaptive && !project.requiresCaptiveRank) return true;
    const captives = campaign.captives ?? [];
    if (!project.requiresCaptiveRank) return captives.length > 0;
    const floor = CAPTIVE_RANK_ORDER.indexOf(project.requiresCaptiveRank);
    return captives.some((captive) => CAPTIVE_RANK_ORDER.indexOf(captive.rank) >= floor);
  }

  /** Engineering room: active manufacturing with a progress bar, then buildable
   *  items (cost + Start). */
  private renderEngineeringRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div", "room-carousel-wrap");
    const activeMfg = campaign.activeManufacturing;

    // One carousel slide per manufacturing project; the in-production order (if
    // any) leads so its progress is the first thing the player sees.
    const ordered = [...MANUFACTURING_PROJECTS].sort((a, b) => {
      const aActive = a.id === activeMfg?.projectId ? 0 : 1;
      const bActive = b.id === activeMfg?.projectId ? 0 : 1;
      if (aActive !== bActive) return aActive - bActive;
      return MANUFACTURING_PROJECTS.indexOf(a) - MANUFACTURING_PROJECTS.indexOf(b);
    });

    if (ordered.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No manufacturing projects available.";
      wrap.appendChild(empty);
      return wrap;
    }

    const items: CarouselItem[] = ordered.map((project) => {
      const isActive = project.id === activeMfg?.projectId;
      const locked = !!project.requiresResearch && !hasResearch(campaign, project.requiresResearch);
      return {
        id: project.id,
        stripLabel: project.title,
        stripStatus: isActive ? "active" : locked ? "locked" : "ready",
        render: () => this.renderManufacturingDetail(campaign, project, !!activeMfg),
      };
    });

    const savedMfg = items.findIndex((it) => it.id === this.mfgCarouselProjectId);
    const initial = savedMfg >= 0 ? savedMfg : 0;
    wrap.appendChild(
      this.mountCarousel(items, "Manufacturing projects", initial, (index) => {
        this.mfgCarouselProjectId = items[index]?.id ?? null;
      }),
    );
    return wrap;
  }

  /** Full-detail manufacturing slide: title, in-production progress OR complete
   *  description + cost/duration chips, and the wired action button. */
  private renderManufacturingDetail(
    campaign: CampaignState,
    project: ManufacturingProject,
    workshopBusy: boolean,
  ): HTMLElement {
    const activeMfg = campaign.activeManufacturing;
    const isActive = project.id === activeMfg?.projectId;
    const isCraft = project.product.kind === "craft";
    const node = el("article", `proj-detail${isCraft ? " craft-order" : ""}`);

    const locked = !!project.requiresResearch && !hasResearch(campaign, project.requiresResearch);
    const canManufacture = canStartManufacturing(campaign, project.id);
    const cost = manufacturingCost(campaign, project.id);
    // A craft product also needs a free hangar berth — surfaced distinctly so a
    // full hangar never reads as the generic "Need resources".
    const hangarFull = isCraft && !locked && freeHangarSlots(campaign) < 1;
    const requiresTitle = project.requiresResearch
      ? RESEARCH_PROJECTS.find((candidate) => candidate.id === project.requiresResearch)?.title ??
        project.requiresResearch
      : "";

    const head = el("div", "proj-detail-head");
    const badge = el("span", `proj-badge ${isActive ? "active" : locked ? "locked" : "available"}`);
    const badgeIcon = el("span", "proj-badge-icon");
    if (isActive) {
      badgeIcon.textContent = "↻";
      badge.append(badgeIcon, document.createTextNode("In production"));
    } else if (locked) {
      badgeIcon.textContent = "⊘";
      badge.append(badgeIcon, document.createTextNode("Research required"));
    } else {
      badgeIcon.textContent = "▸";
      badge.append(badgeIcon, document.createTextNode(isCraft ? "Craft order" : "Buildable"));
    }
    head.appendChild(badge);
    node.appendChild(head);

    const title = el("h3", "proj-title");
    title.textContent = project.title;
    node.appendChild(title);

    if (isActive && activeMfg) {
      const remaining = Math.max(0, activeMfg.completesAtHour - campaign.clock.elapsedHours);
      const duration = activeMfg.completesAtHour - activeMfg.startedAtHour;
      const fraction =
        duration > 0
          ? Math.min(1, Math.max(0, (campaign.clock.elapsedHours - activeMfg.startedAtHour) / duration))
          : 0;
      const desc = el("p", "proj-desc");
      desc.textContent = project.description;
      const bar = el("div", "progress");
      const fill = el("i");
      fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.appendChild(fill);
      const meta = el("div", "proj-meta-line");
      meta.textContent = `${formatHours(remaining)} remaining — workshop is fabricating.`;
      node.append(desc, bar, meta);
      return node;
    }

    const desc = el("p", "proj-desc");
    const berthNote = isCraft ? " Occupies one hangar berth." : "";
    desc.textContent = locked
      ? `Requires ${requiresTitle}. ${project.description}`
      : hangarFull
        ? `${project.description} No free hangar berth — scrap or lose a craft first.`
        : `${project.description}${berthNote}`;
    node.appendChild(desc);

    if (!locked) {
      const chips = el("div", "proj-cost-row");
      chips.append(
        span(formatCost(cost), "proj-cost"),
        span(formatHours(manufacturingDuration(campaign, project.id)), "proj-duration"),
      );
      node.appendChild(chips);
    }

    const button = el("button", "proj-action");
    button.textContent = workshopBusy
      ? "Workshop busy"
      : locked
        ? "Research required"
        : hangarFull
          ? "Hangar full"
          : canManufacture
            ? "Start production"
            : "Need resources";
    button.disabled = workshopBusy || !canManufacture;
    button.addEventListener("click", () => this.opts.onStartManufacturing(project.id));
    node.appendChild(button);
    return node;
  }

  /** Active construction (remaining hours) + buildable facilities (cost + Build). */
  private renderConstructionList(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const activeConstruction = campaign.activeConstruction;
    const constructionFacility = activeConstruction
      ? findBaseFacility(activeConstruction.facilityId)
      : undefined;
    if (activeConstruction && constructionFacility) {
      const remaining = Math.max(0, activeConstruction.completesAtHour - campaign.clock.elapsedHours);
      const card = el("article", "build-card active");
      const head = el("div", "bc-head");
      head.append(
        document.createTextNode(constructionFacility.label),
        Object.assign(el("em"), { textContent: formatHours(remaining) }),
      );
      const detail = el("p");
      detail.textContent =
        `${constructionFacility.description} Construction crews are installing this facility.`;
      const button = el("button");
      button.textContent = "Under construction";
      button.disabled = true;
      card.append(head, detail, button);
      wrap.appendChild(card);
    }
    const buildable = availableBaseFacilities(campaign);
    if (buildable.length > 0) {
      const label = el("div", "section-label");
      label.textContent = activeConstruction ? "Queue" : "Buildable";
      wrap.appendChild(label);
      const grid = el("div", "build-grid");
      for (const facility of buildable) {
        const canBuild = canBuildFacility(campaign, facility.id);
        const card = el("article", `build-card${canBuild ? "" : " blocked"}`.trim());
        const cost = facilityCost(facility);
        const head = el("div", "bc-head");
        head.append(
          document.createTextNode(facility.label),
          Object.assign(el("em"), { textContent: formatCost(cost) }),
        );
        const detail = el("p");
        detail.textContent =
          `${facility.effect} ` +
          `Power ${facility.powerUse > 0 ? `+${facility.powerUse} use` : `+${facility.powerOutput} cap`}. ` +
          `Build ${formatHours(facilityConstructionDuration(campaign, facility.id))}.`;
        const button = el("button");
        button.textContent = canBuild ? "Build" : activeConstruction ? "Queue full" : "Need resources";
        button.disabled = !canBuild;
        button.addEventListener("click", () => this.opts.onBuildFacility(facility.id));
        card.append(head, detail, button);
        grid.appendChild(card);
      }
      wrap.appendChild(grid);
    }
    return wrap;
  }

  /** Convert a pointer position to a ray and return the facility floor under it,
   *  if any. Used by both hover and click handlers. */
  private facilityMeshAt(
    event: PointerEvent | MouseEvent,
  ): { mesh: Mesh; facilityId: string } | null {
    const dom = this.renderer.domElement;
    const rect = dom.getBoundingClientRect();
    this.pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    this.pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const meshes = this.facilityMeshes.map((entry) => entry.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0]!;
    return this.facilityMeshes.find((entry) => entry.mesh === hit.object) ?? null;
  }

  /** Hover: show a floating tooltip + boost the facility's emissive + cursor
   *  pointer. Clearing hover restores the defaults. */
  private onPointerMove = (event: PointerEvent): void => {
    if (this.disposed || this.facilityMeshes.length === 0 || this.interiorRoot) return;
    const hit = this.facilityMeshAt(event);
    const id = hit?.facilityId ?? null;
    const facilityChanged = id !== this.hoveredFacilityId;
    if (facilityChanged) {
      this.hoveredFacilityId = id;
      this.applyFacilityHighlight();
    }
    // Expansion-pad hover (facilities win): reveal only the hovered slot's label.
    const expId = hit ? null : this.expansionIdAt();
    const expansionChanged = expId !== this.hoveredExpansionId;
    if (expansionChanged) {
      this.hoveredExpansionId = expId;
      for (const pad of this.expansionHovers) pad.label.visible = pad.id === expId;
    }
    const dom = this.renderer.domElement;
    if (!this.tooltipEl) return;
    // Rebuild the tooltip's DOM only when the hovered target actually changes;
    // every subsequent move over the same target only repositions it (no per-move
    // findBaseFacility lookup or replaceChildren() churn).
    const hovering = hit !== null || expId !== null;
    if (facilityChanged || expansionChanged) {
      if (hit) {
        const facility = findBaseFacility(hit.facilityId);
        const building = this.opts.campaign.activeConstruction?.facilityId === hit.facilityId;
        this.tooltipEl.replaceChildren();
        const strong = el("strong");
        strong.textContent = facility?.label ?? hit.facilityId;
        const note = el("span");
        note.textContent = building ? "Under construction" : (facility?.effect ?? "");
        this.tooltipEl.append(strong, note);
      } else if (expId) {
        const facility = findBaseFacility(expId);
        this.tooltipEl.replaceChildren();
        const strong = el("strong");
        strong.textContent = facility?.label ?? "Expansion slot";
        const note = el("span");
        note.textContent = "Unexcavated — open Construction to build here";
        this.tooltipEl.append(strong, note);
      }
      this.tooltipEl.classList.toggle("visible", hovering);
    }
    if (hovering) {
      this.tooltipEl.style.left = `${event.clientX}px`;
      this.tooltipEl.style.top = `${event.clientY}px`;
      dom.style.cursor = "pointer";
    } else {
      dom.style.cursor = "default";
    }
  };

  /** Raycast the expansion-pad niches under the current pointer ray (already set
   *  by facilityMeshAt earlier in the same pointermove). Returns the hovered pad
   *  id, or null. The mesh list is invariant after buildScene, so it is cached. */
  private expansionIdAt(): string | null {
    if (this.expansionHovers.length === 0) return null;
    if (this.expansionMeshCache === null) {
      this.expansionMeshCache = this.expansionHovers.map((pad) => pad.mesh);
    }
    const hits = this.raycaster.intersectObjects(this.expansionMeshCache, false);
    if (hits.length === 0) return null;
    const id = hits[0]!.object.userData.expansionId;
    return typeof id === "string" ? id : null;
  }

  /** Click a facility floor in the 3D base. The Command Center opens the geoscape
   *  (it IS the command room); every other buildable facility opens its dedicated
   *  room and dives the camera INTO its 3D interior. `access` (the lift) has no
   *  room and returns to the bare overview. Any canvas click also clears a pending
   *  alert beacon and fades the first-time hint. Ignored while an interior is open. */
  private onCanvasClick = (event: MouseEvent): void => {
    if (this.disposed || this.facilityMeshes.length === 0 || this.interiorRoot) return;
    if (this.alertBeaconFacilityId) {
      // Acknowledge + clear the beacon. The frame loop stops overriding this pad's
      // emissive the moment the id is null, so without a highlight repaint the pad
      // would freeze at its last mid-pulse sine sample. Repaint to the static
      // selected/hover/base value so an empty-space dismiss doesn't leave it half-lit.
      this.alertBeaconFacilityId = null;
      this.applyFacilityHighlight();
    }
    this.hintDismissed = true;
    const hit = this.facilityMeshAt(event);
    if (!hit) {
      // Clicking an unexcavated expansion pad (which shows a pointer cursor +
      // "open Construction to build here" tooltip) opens the Construction room so
      // the advertised click is not a silent no-op.
      const expId = this.expansionIdAt();
      if (expId !== null) {
        this.selectedFacilityId = null;
        this.activeRoom = "construction";
        this.refreshHud();
      }
      return;
    }
    this.activateFacility(hit.facilityId);
  };

  /** Open the room for a facility id. Shared by the canvas click raycast and the
   *  keyboard activation path so both routes into a room behave identically. */
  private activateFacility(facilityId: string): void {
    const facility = findBaseFacility(facilityId);
    if (facility?.kind === "command") {
      // The command room is the geoscape — NAV mounts it; BASE never renders a
      // DOM room for it.
      this.opts.onEnterCommandCenter();
      return;
    }
    if (!facility || facility.kind === "access") {
      // No dedicated room (the lift) — stay on the bare overview.
      this.selectedFacilityId = null;
      this.activeRoom = "overview";
      this.applyFacilityHighlight();
      this.refreshHud();
      return;
    }
    this.enterFacility(facilityId, facility.kind);
  }

  /** Dive the camera INTO a facility's 3D interior: mount its diorama (built by
   *  baseFacilityInteriors), hide the hub exterior, and tween the camera to a
   *  close 3/4 hero framing. The facility's existing DOM room controls stay
   *  overlaid (refreshHud re-renders the sidebar) so the player can still act. */
  private enterFacilityInterior(role: FacilityRole): void {
    if (this.disposed) return;
    // Tear down any prior interior first (defensive — never two at once).
    this.clearInterior();
    // Pass the LIVE captive count so containment occupancy reads correctly without
    // re-parsing the whole persisted campaign blob from localStorage on every dive.
    const captiveCount = this.opts.campaign.captives?.length ?? 0;
    const diorama = buildFacilityInterior(role, captiveCount);
    diorama.traverse((child) => {
      if (child instanceof Mesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });
    this.interiorGroup.add(diorama);
    this.interiorRoot = diorama;
    this.baseGroup.visible = false;
    // Clear any lingering hover affordance (tooltip + pointer cursor) from the
    // hub facility the player just clicked — the dive replaces that interaction.
    this.hoveredFacilityId = null;
    if (this.hoveredExpansionId !== null) {
      this.hoveredExpansionId = null;
      for (const pad of this.expansionHovers) pad.label.visible = false;
    }
    if (this.tooltipEl) this.tooltipEl.classList.remove("visible");
    this.renderer.domElement.style.cursor = "default";
    this.beginCameraTween(this.interiorCamPos, this.interiorCamTarget, 760);
  }

  /** Dispose the mounted interior diorama (geometry + materials) and detach it,
   *  so diving into another facility or returning to the hub never leaks GPU
   *  memory. disposeObject dedupes shared resources. */
  private clearInterior(): void {
    if (!this.interiorRoot) return;
    disposeObject(this.interiorRoot);
    this.interiorGroup.remove(this.interiorRoot);
    this.interiorRoot = null;
  }

  /** Reverse the dive: unmount the interior, reveal the hub exterior, and tween
   *  the camera back to the resting hub framing. No-op when no interior is open. */
  private exitFacilityInterior(): void {
    if (!this.interiorRoot) return;
    this.clearInterior();
    this.baseGroup.visible = true;
    this.beginCameraTween(this.camHome, this.hubCamTarget, 760);
  }

  /** "Back to Base": leave the focused facility (interior + DOM room) and return
   *  to the overview hub. Wired to the room header's back affordance so the
   *  existing control also reverses the 3D dive. */
  private exitToHub(): void {
    this.activeRoom = "overview";
    this.exitFacilityInterior();
    this.refreshHud();
  }

  /** Kick off an eased camera move (position + look-at target) over `durationMs`.
   *  The frame loop drives the interpolation; from-state is snapshotted from the
   *  camera's current position/look-at so dives chain correctly. */
  private beginCameraTween(toPos: Vector3, toTarget: Vector3, durationMs: number): void {
    this.camFromPos.copy(this.camera.position);
    this.camToPos.copy(toPos);
    this.camFromTarget.copy(this.currentLookAt);
    this.camToTarget.copy(toTarget);
    this.camStartMs = performance.now();
    this.camDurationMs = durationMs;
    this.camAnimating = true;
  }

  /** Boost the emissive of the selected/hovered facility pad and its accent
   *  point light so the 3D cutaway stays in sync with the open room and the
   *  glow reacts to focus. Selection wins (brightest); an independently hovered
   *  facility still gets a clear lift so the 3D pad reads as clickable even after
   *  another facility has been selected. onPointerMove reverts hover on un-hover. */
  private applyFacilityHighlight(): void {
    const selected = this.selectedFacilityId;
    const hovered = this.hoveredFacilityId;
    for (const entry of this.facilityMeshes) {
      const mat = entry.mesh.material;
      if (mat instanceof MeshStandardMaterial) {
        mat.emissiveIntensity =
          entry.facilityId === selected ? 1.1
          : entry.facilityId === hovered ? 0.72
          : 0.32;
      }
    }
    for (const bay of this.bayLights) {
      const boosted = bay.facilityId === selected || bay.facilityId === hovered;
      bay.light.intensity = boosted ? bay.base * 1.9 : bay.base;
    }
  }

  private resize = (): void => {
    const rect = this.canvasWrap.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  private frame = (): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const now = performance.now();
    const elapsed = now * 0.001;
    // Frame delta (ms) for time-based animation (crew). Capped so a stalled
    // tab / first frame can't catapult actors; no per-frame allocation.
    const dt = this.prevTimeMs === 0 ? 16 : Math.min(50, now - this.prevTimeMs);
    this.prevTimeMs = now;
    this.baseGroup.rotation.y = BASE_VIEW_YAW + (this.reducedMotion ? 0 : Math.sin(elapsed * 0.16) * 0.028);
    // Camera direction is one of: an in-progress dive/back tween (priority),
    // a resting interior hero frame (when a diorama is mounted), or the hub
    // idle drift. All branches write position + currentLookAt in place — no
    // per-frame allocation — then a single lookAt() applies it.
    if (this.camAnimating) {
      const t01 = Math.min(1, (now - this.camStartMs) / this.camDurationMs);
      // ease-in-out cubic: smooth dive that settles gently on the hero frame.
      const e = t01 < 0.5 ? 4 * t01 * t01 * t01 : 1 - Math.pow(-2 * t01 + 2, 3) / 2;
      this.camera.position.lerpVectors(this.camFromPos, this.camToPos, e);
      this.currentLookAt.lerpVectors(this.camFromTarget, this.camToTarget, e);
      if (t01 >= 1) this.camAnimating = false;
    } else if (this.interiorRoot) {
      // Subtle idle drift around the interior hero frame — reuses the resting
      // position/target (allocation-free) so the diorama feels alive up close.
      if (this.reducedMotion) {
        this.camera.position.copy(this.interiorCamPos);
      } else {
        this.camera.position.x = this.interiorCamPos.x + Math.sin(elapsed * 0.18) * 0.05;
        this.camera.position.y = this.interiorCamPos.y + Math.sin(elapsed * 0.13 + 0.7) * 0.03;
        this.camera.position.z = this.interiorCamPos.z + Math.cos(elapsed * 0.15) * 0.05;
      }
      this.currentLookAt.copy(this.interiorCamTarget);
    } else {
      // Hub idle drift — reuses camHome (no per-frame allocation).
      if (this.reducedMotion) {
        this.camera.position.copy(this.camHome);
      } else {
        this.camera.position.x = this.camHome.x + Math.sin(elapsed * 0.12) * 0.14;
        this.camera.position.y = this.camHome.y + Math.sin(elapsed * 0.09 + 1.1) * 0.1;
        this.camera.position.z = this.camHome.z + Math.cos(elapsed * 0.1) * 0.12;
      }
      this.currentLookAt.set(0, 0, 0);
    }
    this.camera.lookAt(this.currentLookAt);
    if (this.reducedMotion) {
      // Hold glow strips + reactor cores at their resting values; skip rotators.
      for (const item of this.pulseMaterials) item.material.opacity = item.opacity;
      for (const mat of this.reactorCores) mat.emissiveIntensity = 1.4;
    } else {
      const pulse = 0.82 + Math.sin(elapsed * 3) * 0.18;
      for (const item of this.pulseMaterials) item.material.opacity = item.opacity * pulse;
      // Reactor cores visibly pulse — mutates the pre-collected materials (no
      // per-frame allocation/traversal).
      const reactorPulse = 1.4 + Math.sin(elapsed * 2.2) * 0.7;
      for (const mat of this.reactorCores) mat.emissiveIntensity = reactorPulse;
      this.updateRotators(elapsed);
    }
    // Alert beacon: pulse the mapped facility's pad emissive so a strategic event
    // that fired on the globe surfaces as a hard-to-miss beacon back at base. Runs
    // after applyFacilityHighlight's static values so it wins each frame; cleared
    // on the next canvas interaction. Static (reducedMotion) → a steady lift.
    if (this.alertBeaconFacilityId) {
      const entry = this.facilityMeshes.find(
        (e) => e.facilityId === this.alertBeaconFacilityId,
      );
      const mat = entry?.mesh.material;
      if (mat instanceof MeshStandardMaterial) {
        mat.emissiveIntensity = this.reducedMotion ? 1.15 : 1.0 + Math.sin(elapsed * 4) * 0.65;
      }
    }
    for (const crew of this.crewSystems) crew.tick(dt);
    this.renderer.render(this.scene, this.camera);
  };
}
