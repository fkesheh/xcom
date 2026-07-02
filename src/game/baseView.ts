import {
  ACESFilmicToneMapping,
  AdditiveBlending,
  AmbientLight,
  BoxGeometry,
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
  activeSoldiers,
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
  campaignObjectiveProgress,
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
import { ITEMS, WEAPONS } from "../sim/content";
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
import { UI_TOKENS, UI_BASE, UI_COMPONENTS } from "./uiTheme";

interface BaseViewOptions {
  campaign: CampaignState;
  operation: OperationPlan;
  onLaunchMission: () => void;
  onStartResearch: (id: ResearchId) => void;
  onBuildFacility: (id: string) => void;
  onRecruitSoldier: () => void;
  onAssignWeapon: (soldierId: string, weaponId: CampaignWeaponId) => void;
  onAssignItem?: (soldierId: string, itemId: string) => void;
  onUnassignItem?: (soldierId: string, itemId: string) => void;
  onToggleDeployment: (soldierId: string, deployed: boolean) => void;
  onStartManufacturing: (id: ManufacturingProjectId) => void;
  onPurchaseWeapon?: (weaponId: CampaignWeaponId) => void;
  onOpenGeoscape: () => void;
  onResetCampaign: () => void;
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

interface BaseCorridor {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

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

/** Corridor cells (the empty grid cells between bays). Bay positions are sealed
 *  in src/campaign/base.ts, and the unbuildable facilities render as expansion
 *  pads (lab-2 / medbay-2 / workshop-2 / power-2 fill the entire y=4 row;
 *  radar-2 fills [7,0]-[7,1]), so the empty cells collapse into three
 *  4-connected components that cannot be bridged without editing campaign data:
 *    spine      x=4, y=0..3  (radar -> command/workshop -> stores -> access/power)
 *    left hall  x=0..1, y=2  (hangar south face <-> living north face)
 *    right hall x=7, y=2..3  (stores east face <-> power east face)
 *  The old single-cell pads [2,0] and [2,3] connected to NOTHING (every 4-neighbor
 *  a bay or pad), so they are dropped — they read as concrete strips floating in
 *  rock. Each bay still opens onto a corridor via its partition-curb doorway gap,
 *  and crew patrol every component (see CREW_LOOP_CELLS / _LEFT) so the base
 *  reads as one lived-in facility rather than isolated boxes. */
const BASE_CORRIDORS: readonly BaseCorridor[] = [
  { id: "spine-radar", x: 4, y: 0, w: 1, h: 1 },
  { id: "spine-command-workshop", x: 4, y: 1, w: 1, h: 1 },
  { id: "spine-command-stores", x: 4, y: 2, w: 1, h: 1 },
  { id: "spine-access-power", x: 4, y: 3, w: 1, h: 1 },
  { id: "left-hangar-living-a", x: 0, y: 2, w: 1, h: 1 },
  { id: "left-hangar-living-b", x: 1, y: 2, w: 1, h: 1 },
  { id: "right-stores", x: 7, y: 2, w: 1, h: 1 },
  { id: "right-power", x: 7, y: 3, w: 1, h: 1 },
];

/** Spine patrol (cell coords) — a closed out-and-back along the x=4 hall, the
 *  largest corridor component. Every consecutive pair AND the closing
 *  last->first are orthogonally adjacent, and each cell resolves to a corridor
 *  cellCenter, so crew never leave the hallway or cut across a bay niche. (The
 *  old loop strung together non-adjacent cells and clipped through the radar
 *  dish, the access lift, and the command bay, floating above their recessed
 *  floors.) Cell centers resolve to baseGroup-local space at build time. */
const CREW_LOOP_CELLS: ReadonlyArray<readonly [number, number]> = [
  [4, 0],
  [4, 1],
  [4, 2],
  [4, 3],
  [4, 2],
  [4, 1],
];

/** Left-hall patrol — the hangar<->living connector, a separate corridor
 *  component walled off from the spine by hangar/command/living. Same
 *  orthogonal-adjacency rule; populated by its own CrewSystem (addCrew) so that
 *  hall reads as lived-in too rather than dead space. */
const CREW_LOOP_CELLS_LEFT: ReadonlyArray<readonly [number, number]> = [
  [0, 2],
  [1, 2],
];

/** Right-hall patrol — the stores<->power connector along x=7, the third
 *  corridor component. Its own CrewSystem so every visible hallway reads as
 *  populated at hero distance. Same orthogonal-adjacency rule (no bay clipping). */
const CREW_LOOP_CELLS_RIGHT: ReadonlyArray<readonly [number, number]> = [
  [7, 2],
  [7, 3],
];

const CSS = UI_TOKENS + "\n" + UI_BASE + "\n" + UI_COMPONENTS + "\n" + `
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
  gap: 16px;
  height: 52px;
  padding: 0 16px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(103,232,249,.22);
  background: linear-gradient(180deg, rgba(6,14,22,.9), rgba(6,14,22,.62));
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
  gap: 7px;
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
#base-view .top-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid rgba(103,232,249,.24);
  border-radius: 999px;
  color: var(--ui-text);
  background: rgba(8,28,40,.55);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .03em;
  white-space: nowrap;
}
#base-view .top-chip .chip-icon { color: var(--ui-cyan); font-size: var(--ui-text-sm); }
#base-view .top-chip.warn { border-color: rgba(251,191,36,.5); }
#base-view .top-chip.warn .chip-icon { color: var(--ui-amber); }
#base-view .top-chip.danger { border-color: rgba(251,113,133,.5); color: #fecaca; }
#base-view .top-chip.danger .chip-icon { color: var(--ui-red); }
#base-view .base-sidebar {
  position: absolute;
  top: 64px;
  right: 12px;
  bottom: 12px;
  width: min(380px, calc(100vw - 24px));
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-4);
  padding: var(--ui-sp-4);
  overflow: auto;
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-lg);
  background: var(--ui-panel);
  box-shadow: var(--ui-shadow);
  backdrop-filter: blur(10px);
}
#base-view .operation-card {
  position: relative;
  padding: var(--ui-sp-4);
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-lg);
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
#base-view .facility-room {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 9px;
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
  flex: 1;
  min-height: 0;
  padding: 1px;
  overflow: auto;
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
#base-view .room-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--ui-sp-1);
  min-height: 70px;
  padding: var(--ui-sp-3);
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
  color: var(--ui-muted);
  font: 400 var(--ui-text-sm)/1.4 Inter, sans-serif;
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
#base-view .tech-legend {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 11px;
  padding: 8px 11px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.4);
}
#base-view .tech-legend-item {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view .tech-legend-item.completed { color: #bbf7d0; }
#base-view .tech-legend-item.available { color: var(--ui-cyan); }
#base-view .tech-legend-item.locked { color: var(--ui-muted); }
#base-view .tech-tree {
  display: flex;
  align-items: flex-start;
  gap: 0;
  overflow-x: auto;
  padding-bottom: 6px;
}
#base-view .tech-tier {
  display: flex;
  flex-direction: column;
  gap: 9px;
  min-width: 212px;
  flex: 0 0 auto;
  padding-right: 14px;
}
#base-view .tech-tier.linked {
  padding-left: 22px;
  border-left: 2px solid rgba(103,232,249,.2);
}
#base-view .tech-tier-label {
  margin-bottom: 2px;
  color: var(--ui-cyan);
  font: 800 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .16em;
  text-transform: uppercase;
}
#base-view .tech-node {
  position: relative;
  padding: 10px 11px;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 10px;
  background: rgba(2,12,20,.5);
}
#base-view .tech-node.completed {
  border-color: rgba(74,222,128,.45);
  background: rgba(10,35,22,.4);
}
#base-view .tech-node.available {
  border-color: rgba(103,232,249,.6);
  background: rgba(8,35,47,.45);
  box-shadow: 0 0 18px rgba(34,211,238,.12);
}
#base-view .tech-node.locked {
  border-color: rgba(148,163,184,.22);
  background: rgba(2,12,20,.42);
  opacity: .82;
}
#base-view .tech-node.active {
  border-color: rgba(251,191,36,.6);
  background: rgba(35,24,4,.32);
  box-shadow: 0 0 20px rgba(251,191,36,.16);
}
#base-view .tech-connector {
  position: absolute;
  left: -22px;
  top: 17px;
  width: 18px;
  color: rgba(103,232,249,.55);
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  text-align: center;
}
#base-view .tech-node-head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 5px;
}
#base-view .tech-node-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  flex: none;
  font-size: var(--ui-text-sm);
}
#base-view .tech-node.completed .tech-node-icon { color: var(--ui-green); }
#base-view .tech-node.available .tech-node-icon { color: var(--ui-cyan); }
#base-view .tech-node.locked .tech-node-icon { color: var(--ui-muted); }
#base-view .tech-node.active .tech-node-icon { color: var(--ui-amber); }
#base-view .tech-node-title {
  flex: 1;
  min-width: 0;
  color: var(--ui-text);
  font: 800 var(--ui-text-xs)/1.2 ui-monospace, monospace;
  letter-spacing: .03em;
  text-transform: uppercase;
}
#base-view .tech-node.locked .tech-node-title { color: var(--ui-muted); }
#base-view .tech-node-status {
  flex: none;
  padding: 2px 7px;
  border-radius: 999px;
  font: 700 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
  white-space: nowrap;
}
#base-view .tech-node.completed .tech-node-status { color: #bbf7d0; border: 1px solid rgba(74,222,128,.4); }
#base-view .tech-node.available .tech-node-status { color: var(--ui-cyan); border: 1px solid rgba(103,232,249,.4); }
#base-view .tech-node.locked .tech-node-status { color: var(--ui-muted); border: 1px solid rgba(148,163,184,.3); }
#base-view .tech-node.active .tech-node-status { color: #fde68a; border: 1px solid rgba(251,191,36,.5); }
#base-view .tech-node-desc {
  margin: 0 0 7px;
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .tech-node-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  color: var(--ui-muted);
  font: 700 var(--ui-text-xs)/1.2 ui-monospace, monospace;
}
#base-view .tech-node-meta .card-cost { color: var(--ui-amber); }
#base-view .tech-node-req {
  color: var(--ui-red);
  font: 700 var(--ui-text-xs)/1.35 ui-monospace, monospace;
  letter-spacing: .02em;
}
#base-view .tech-node .tech-progress { margin: 2px 0 6px; }
#base-view .tech-node button {
  width: 100%;
  margin-top: 9px;
  min-height: 36px;
  font-size: var(--ui-text-sm);
}
#base-view .soldier-table {
  display: grid;
  gap: 6px;
}
#base-view .soldier-row {
  display: grid;
  grid-template-columns: auto minmax(64px, 1.4fr) auto auto minmax(92px, 1fr) minmax(196px, 1.7fr);
  gap: 8px;
  align-items: center;
  padding: 8px 9px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 8px;
  color: var(--ui-text);
  background: rgba(2,12,20,.42);
  font: 600 var(--ui-text-xs)/1.2 ui-monospace, monospace;
}
#base-view .soldier-row.selected,
#base-view .soldier-row:hover {
  border-color: rgba(103,232,249,.45);
  background: rgba(8,35,47,.5);
}
#base-view .soldier-row.kia { color: var(--ui-red); opacity: .75; }
#base-view .soldier-row.wounded { color: var(--ui-amber); }
#base-view .soldier-row .s-name { color: var(--ui-text); }
#base-view .soldier-row .s-rank { color: var(--ui-muted); }
#base-view .s-name-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
#base-view .s-bio {
  color: var(--ui-muted);
  font: 400 var(--ui-text-sm)/1.4 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
  white-space: normal;
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
#base-view .soldier-row select {
  min-width: 92px;
  color: var(--ui-text);
  border: 1px solid rgba(103,232,249,.24);
  border-radius: 6px;
  background: rgba(1,9,15,.85);
  font: 600 var(--ui-text-xs)/1 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .soldier-row select:disabled { opacity: .45; }
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
#base-view .soldier-detail {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding: 8px 9px;
  border-top: 1px dashed rgba(103,232,249,.2);
  color: var(--ui-muted);
  font: 400 var(--ui-text-base)/1.45 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
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
#base-view .base-footer {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 4;
  display: flex;
  gap: 8px;
}
#base-view .base-footer button { min-height: 38px; }
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
#base-view .notice-toast {
  position: absolute;
  top: 62px;
  left: 50%;
  z-index: 8;
  max-width: min(440px, calc(100vw - 36px));
  padding: 10px 16px;
  border: 1px solid rgba(251,191,36,.5);
  border-radius: 999px;
  color: #fef3c7;
  background: rgba(35,24,4,.92);
  box-shadow: 0 18px 50px rgba(0,0,0,.5);
  text-align: center;
  transform: translate(-50%, -16px);
  opacity: 0;
  pointer-events: none;
  transition: opacity .2s ease, transform .2s ease;
  font: 800 var(--ui-text-xs)/1.3 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .notice-toast.visible { opacity: 1; transform: translate(-50%, 0); }
#base-view .notice-toast[data-kind="warning"] {
  border-color: rgba(251,113,133,.55);
  color: #fecaca;
  background: rgba(45,11,18,.92);
}
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
  #base-view .topbar-chips { gap: 5px; }
  #base-view .top-chip { padding: 5px 8px; }
  #base-view .base-footer { bottom: auto; top: 56px; }
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
#base-view .craft-body .card-copy { margin: 3px 0 0; }
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
    resources.credits > 0 ? `${resources.credits}c` : "",
    resources.alloys > 0 ? `${resources.alloys}a` : "",
    resources.elerium > 0 ? `${resources.elerium}e` : "",
    resources.alienData > 0 ? `${resources.alienData}d` : "",
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : "No cost";
}

interface MissionTypeMeta {
  label: string;
  icon: string;
  detail: string;
  launchLabel: string;
}

/** Mission-type display metadata. The icon glyph + label carry meaning together so the
 *  colored chip is never the sole signal (color is secondary reinforcement). */
function missionTypeMeta(operation: OperationPlan): MissionTypeMeta {
  switch (operation.missionType) {
    case "terror":
      return {
        label: "Terror mission",
        icon: "▲",
        detail:
          operation.missionContext?.civilianCount !== undefined
            ? `Rescue ${operation.missionContext.civilianCount} civilians`
            : "Defend civilians from the alien assault",
        launchLabel: "Deploy to terror site",
      };
    case "landedUfo":
      return {
        label: "Landed UFO",
        icon: "◆",
        detail: "Assault the intact vessel before it departs",
        launchLabel: "Assault landed UFO",
      };
    case "baseDefense":
      return {
        label: "Base defense",
        icon: "■",
        detail:
          operation.missionContext?.defenderFacility
            ? `Hold the line at ${operation.missionContext.defenderFacility}`
            : "Repel the assault on the blacksite",
        launchLabel: "Defend the base",
      };
    case "crashSite":
    default:
      return {
        label: "Crash site",
        icon: "▼",
        detail: "Recover the downed UFO power core",
        launchLabel: "Recover UFO core",
      };
  }
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

function disposeObject(obj: Group | Scene): void {
  const disposedGeometries = new Set<unknown>();
  const disposedMaterials = new Set<Material>();
  obj.traverse((child) => {
    if (child instanceof Mesh || child instanceof LineSegments || child instanceof Sprite) {
      if (child instanceof Mesh || child instanceof LineSegments) {
        if (!disposedGeometries.has(child.geometry)) {
          disposedGeometries.add(child.geometry);
          child.geometry.dispose();
        }
      }
      const material = child.material;
      if (Array.isArray(material)) {
        for (const one of material) {
          if (disposedMaterials.has(one)) continue;
          disposedMaterials.add(one);
          disposeMaterial(one);
        }
      } else if (!disposedMaterials.has(material)) {
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
  | "containment";

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
};

/** Rooms reachable from the overview hub's facility list. */
const ROOM_NAV: readonly RoomId[] = [
  "research",
  "engineering",
  "barracks",
  "hangar",
  "construction",
  "containment",
];

/** Map a constructed facility's kind to the dedicated room that manages it.
 *  Facilities without their own screen (power, radar, stores, etc.) fall back
 *  to the overview hub. */
function roomForFacilityKind(kind: FacilityKind): RoomId {
  switch (kind) {
    case "lab":
      return "research";
    case "workshop":
      return "engineering";
    case "living":
      return "barracks";
    case "hangar":
      return "hangar";
    case "containment":
      return "containment";
    case "command":
    case "stores":
    case "medbay":
    case "power":
    case "radar":
    case "access":
    default:
      return "overview";
  }
}

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
  /** Animated crew (personnel) walking the corridor loop — drives life. Owned
   *  by the dedicated CrewSystem module; ticked in frame(), disposed on teardown. */
  private crewSystem: CrewSystem | null = null;
  /** Second crew system patrolling the disconnected left hall (hangar<->living)
   *  so every corridor component reads as populated. Same lifecycle as the spine
   *  crew: ticked in frame(), disposed on teardown. */
  private crewSystemLeft: CrewSystem | null = null;
  /** Third crew system patrolling the right hall (stores<->power) so every
   *  visible corridor reads as populated at hero distance. Same lifecycle. */
  private crewSystemRight: CrewSystem | null = null;
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
   *  the open-front diorama. The frame loop adds a subtle drift on top. */
  private readonly interiorCamPos = new Vector3(3.0, 2.2, 4.2);
  private readonly interiorCamTarget = new Vector3(0, 0.85, -0.2);
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
  private tooltipEl: HTMLDivElement | null = null;
  private topbarChips: HTMLElement | null = null;
  private clockEl: HTMLElement | null = null;
  private primaryHost: HTMLElement | null = null;
  private objectiveHost: HTMLElement | null = null;
  private roomHost: HTMLElement | null = null;
  private helpOverlay: HTMLDivElement | null = null;
  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape" && this.helpOverlay?.classList.contains("show")) {
      this.toggleHelp(false);
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
    window.addEventListener("resize", this.resize);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("click", this.onCanvasClick);
    window.addEventListener("keydown", this.onKeydown);
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
    window.removeEventListener("keydown", this.onKeydown);
    window.removeEventListener("resize", this.resize);
    // CrewSystem owns its pooled meshes/materials; tear it down before the scene
    // walk so its internal dispose() is the single owner of those resources.
    this.crewSystem?.dispose();
    this.crewSystem = null;
    this.crewSystemLeft?.dispose();
    this.crewSystemLeft = null;
    this.crewSystemRight?.dispose();
    this.crewSystemRight = null;
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

  /** Lightweight transient notice (toast). Pairs its message text with the kind label so
   *  the warning color is never the sole signal. */
  private showNotice(message: string, kind: "info" | "warning" = "info"): void {
    if (!this.noticeEl) return;
    const prefix = kind === "warning" ? "! " : "";
    this.noticeEl.textContent = `${prefix}${message}`;
    this.noticeEl.dataset.kind = kind;
    this.noticeEl.classList.add("visible");
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      if (this.noticeEl) this.noticeEl.classList.remove("visible");
      this.noticeTimer = null;
    }, 3200);
  }

  private buildMarketPanel(): HTMLElement {
    const panel = el("section", "market-card");
    const head = el("strong");
    const headLabel = el("span");
    headLabel.textContent = "Armory / Market";
    const credits = el("span", "market-credits");
    credits.textContent = `${this.opts.campaign.resources.credits}c available`;
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
      price.textContent = `${MARKET_CONFIG[weaponId].price}c`;
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

    this.buildTerrainSlab();
    this.buildCutawayShell();
    this.buildCorridorGrid();
    for (const facility of availableBaseFacilities(this.opts.campaign)) this.buildExpansionPad(facility);
    for (const facility of constructedFacilities(this.opts.campaign)) this.buildFacility(facility);
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

  /** Lay every corridor in the connected network so the bays read as one
   *  facility. Shared floor/strip materials are created once in buildScene. */
  private buildCorridorGrid(): void {
    for (const corridor of BASE_CORRIDORS) this.buildCorridor(corridor);
  }

  private buildCorridor(corridor: BaseCorridor): void {
    const steel = this.sharedSteel!;
    const group = new Group();
    group.position.copy(this.cellCenter(corridor.x, corridor.y, corridor.w, corridor.h));
    this.baseGroup.add(group);

    const width = corridor.w * CELL - 0.28;
    const depth = corridor.h * CELL - 0.28;
    const long = Math.max(width, depth);
    const short = Math.min(width, depth);
    const longAxisIsX = width >= depth;

    // Lighter concrete trench floor (palette-derived) — a paved hallway strip a
    // touch brighter than the sunken bay floors, connecting the rooms.
    const floor = new Mesh(new BoxGeometry(width, 0.08, depth), this.corridorFloor!);
    floor.position.y = 0.035;
    floor.receiveShadow = true;
    group.add(floor);

    const edge = new LineSegments(
      new EdgesGeometry(floor.geometry),
      this.corridorStripMat!,
    );
    edge.position.copy(floor.position);
    group.add(edge);

    // Low steel curbs along the long sides only — frames the hall as built
    // while leaving the short ends fully open as DOORWAY gaps onto each bay.
    const curbH = 0.16;
    const curbLong = long * 0.42;
    const curbDeep = 0.07;
    const offset = short / 2 - 0.05;
    for (const sign of [-1, 1]) {
      const curb = new Mesh(
        longAxisIsX
          ? new BoxGeometry(curbLong, curbH, curbDeep)
          : new BoxGeometry(curbDeep, curbH, curbLong),
        steel,
      );
      curb.position.y = curbH / 2 + 0.03;
      if (longAxisIsX) curb.position.z = sign * offset;
      else curb.position.x = sign * offset;
      curb.castShadow = true;
      curb.receiveShadow = true;
      group.add(curb);
    }

    // Low emissive STRIP-LIGHTS along both long edges (the hallway work-lights)
    // plus a faint center travel line. Shared palette-teal glow material.
    const stripLen = long * 0.78;
    const stripOff = short / 2 - 0.06;
    for (const sign of [-1, 1]) {
      const strip = new Mesh(
        longAxisIsX
          ? new BoxGeometry(stripLen, 0.02, 0.05)
          : new BoxGeometry(0.05, 0.02, stripLen),
        this.corridorStripMat!,
      );
      strip.position.y = 0.11;
      if (longAxisIsX) strip.position.z = sign * stripOff;
      else strip.position.x = sign * stripOff;
      group.add(strip);
    }
    const travel = new Mesh(
      longAxisIsX
        ? new BoxGeometry(long * 0.86, 0.008, 0.022)
        : new BoxGeometry(0.022, 0.008, long * 0.86),
      this.corridorStripMat!,
    );
    travel.position.y = 0.078;
    group.add(travel);
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
    label.position.set(0, floorY + 0.92, -depth * 0.32);
    group.add(label);
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

    const marker = makeLabel("Expansion", BASE_PALETTE.floorLine);
    marker.position.set(0, 0.22, 0);
    marker.scale.set(0.9, 0.24, 1);
    group.add(marker);
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
    this.crewSystem = new CrewSystem({
      waypoints: this.crewLoopToWorld(CREW_LOOP_CELLS),
      count: 9,
      seed: 1337,
    });
    this.baseGroup.add(this.crewSystem.group);

    // The left hall is a separate corridor component walled off from the spine;
    // give it its own small crew so it reads as a lived-in connector, not dead
    // space. Patrols only orthogonally-adjacent corridor cells (no bay clipping).
    this.crewSystemLeft = new CrewSystem({
      waypoints: this.crewLoopToWorld(CREW_LOOP_CELLS_LEFT),
      count: 3,
      seed: 4242,
    });
    this.baseGroup.add(this.crewSystemLeft.group);

    // The right hall (stores<->power) is the third corridor component; populate
    // it too so every visible foreground hallway has moving personnel.
    this.crewSystemRight = new CrewSystem({
      waypoints: this.crewLoopToWorld(CREW_LOOP_CELLS_RIGHT),
      count: 3,
      seed: 9900,
    });
    this.baseGroup.add(this.crewSystemRight.group);
  }

  /** Resolve a cell-coord patrol loop to baseGroup-local waypoints pinned to the
   *  corridor floor (top ~0.075; the figure origin is at the feet). */
  private crewLoopToWorld(cells: ReadonlyArray<readonly [number, number]>): Vector3[] {
    return cells.map(([cx, cy]) => {
      const p = this.cellCenter(cx, cy, 1, 1);
      p.y = 0.08;
      return p;
    });
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
    tools.appendChild(help);
    const topRight = el("div", "topbar-right");
    topRight.append(chips, tools);
    topbar.append(brand, topRight);

    const sidebar = el("aside", "base-sidebar");
    const primaryHost = el("div");
    const objectiveHost = el("div");
    const roomHost = el("div", "facility-room");
    sidebar.append(primaryHost, objectiveHost, roomHost);

    const footer = el("div", "base-footer");
    const earth = el("button");
    earth.textContent = "Earth";
    earth.setAttribute("aria-label", "Return to Earth Command (geoscape)");
    earth.addEventListener("click", () => this.opts.onOpenGeoscape());
    const reset = el("button");
    reset.textContent = "New campaign";
    reset.setAttribute("aria-label", "Abandon this campaign and start a new one");
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    footer.append(earth, reset);

    const tooltip = el("div", "base-tooltip");
    tooltip.setAttribute("role", "tooltip");
    const notice = el("div", "notice-toast");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");

    this.topbarChips = chips;
    this.clockEl = clock;
    this.primaryHost = primaryHost;
    this.objectiveHost = objectiveHost;
    this.roomHost = roomHost;
    this.tooltipEl = tooltip;
    this.noticeEl = notice;
    this.helpOverlay = this.buildHelpOverlay();

    this.root.append(topbar, sidebar, footer, tooltip, notice, this.helpOverlay);
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
      ["Earth (footer)", "open the geoscape to scan, intercept, and launch assaults."],
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
    if (!this.primaryHost || !this.roomHost || !this.objectiveHost) return;
    const campaign = this.opts.campaign;
    const operation = this.opts.operation;
    const contact = campaign.ufoContact;
    // Ground assaults (terror, landed UFO, base defense) spawn already on the
    // ground ("landed"); crash-site contacts stay "tracked" until shot down.
    // Only "crashed"/"landed" are terminal, launchable states — match controller.
    const launchable = contact?.status === "crashed" || contact?.status === "landed";
    const launchContact = launchable ? contact : undefined;

    this.fillTopbar(campaign);
    this.primaryHost.replaceChildren(
      this.renderPrimaryCard(campaign, operation, contact, launchContact),
    );
    this.objectiveHost.replaceChildren(this.renderObjectiveStrip(campaign));
    this.roomHost.replaceChildren(this.renderRoom(campaign));
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
    const threatCls = threat >= 70 ? "danger" : threat >= 40 ? "warn" : "";
    this.topbarChips.replaceChildren(
      this.topChip("$", "Credits", `${campaign.resources.credits}`, undefined, "currency — buys weapons, recruits, and construction"),
      this.topChip("⬢", "Alloys", `${campaign.resources.alloys}`, undefined, "alien alloys — manufacture advanced gear"),
      this.topChip("✦", "Elerium", `${campaign.resources.elerium}`, undefined, "elerium-115 — powers advanced research and manufacturing"),
      this.topChip("◈", "Alien Data", `${campaign.resources.alienData}`, undefined, "recovered data — unlocks and accelerates research"),
      this.topChip("⚗", "Scientists", `${scientists}`, undefined, "staffed lab researchers — more = faster research"),
      this.topChip("⚙", "Engineers", `${engineers}`, undefined, "staffed workshop engineers — more = faster manufacturing"),
      this.topChip("▲", "Threat", `${threat}%`, threatCls, "global X-COM threat — high threat raises council panic"),
      this.topChip("◆", "Difficulty", difficultyConfig(campaign).label, undefined, "campaign difficulty — affects enemy counts and starting threat"),
      this.topChip("⌖", "Bases", `${allBases(campaign).length}/${MAX_EXTRA_BASES + 1}`, undefined, "Primary base + built radar bases (max 3 extra)"),
    );
  }

  /** Compact top-bar chip: icon + value with a hover tooltip carrying the full
   *  label, so the threat color class is never the sole signal. */
  private topChip(icon: string, label: string, value: string, cls?: string, hint?: string): HTMLSpanElement {
    const node = el("span", `top-chip${cls ? ` ${cls}` : ""}`);
    node.title = hint ? `${label} — ${hint} (${value})` : `${label}: ${value}`;
    const iconEl = el("span", "chip-icon");
    iconEl.textContent = icon;
    const valEl = el("span", "chip-val");
    valEl.textContent = value;
    node.append(iconEl, valEl);
    return node;
  }

  /** Primary action card — the dominant, always-present CTA. Three variants:
   *  launchable ground assault (big LAUNCH button), airborne UFO (intercept
   *  guidance + Geoscape CTA), or no contact (scan guidance + Geoscape). */
  private renderPrimaryCard(
    campaign: CampaignState,
    operation: OperationPlan,
    contact: UfoContact | undefined,
    launchContact: UfoContact | undefined,
  ): HTMLElement {
    const card = el("section", "operation-card");
    const meta = missionTypeMeta(operation);

    if (launchContact) {
      const eyebrow = el("div", "op-eyebrow ui-eyebrow");
      eyebrow.textContent = "Operation ready";
      const title = el("div", "op-title ui-section-title");
      title.textContent = `Operation ${operation.codename}`;
      const chipEl = el("div", `mission-chip ${operation.missionType ?? "crashSite"}`);
      const chipIcon = el("span", "mission-icon");
      chipIcon.textContent = meta.icon;
      chipEl.append(chipIcon, document.createTextNode(meta.label));
      const region = el("div", "op-region");
      region.textContent =
        `${operation.region} · ${operation.enemyCount} contacts · ${operation.durationHours}h field time`;
      const chips = el("div", "op-chips");
      const reward = operation.reward;
      chips.append(
        span(`+${reward.credits}c`),
        span(`+${reward.alloys}a`),
        span(`+${reward.elerium}e`),
        span(`+${reward.alienData}d`),
      );
      const deployment = deploymentSoldiers(campaign);
      const activeRoster = activeSoldiers(campaign);
      const canLaunch = campaign.strategic.status === "active" && deployment.length > 0;
      const launch = el("button", "primary ui-cta");
      launch.textContent = canLaunch
        ? `${meta.launchLabel} (op ${operation.missionNumber})`
        : campaign.strategic.status !== "active"
          ? "Campaign complete"
          : activeRoster.length === 0
            ? "No operatives"
            : "Select squad";
      launch.disabled = !canLaunch;
      launch.addEventListener("click", () => this.opts.onLaunchMission());
      card.append(eyebrow, title, chipEl, region, chips, launch);
      return card;
    }

    if (contact) {
      card.appendChild(this.renderAirborneBanner(contact));
      return card;
    }

    const eyebrow = el("div", "op-eyebrow ui-eyebrow");
    eyebrow.textContent = "No active contact";
    const title = el("div", "op-title ui-section-title");
    title.textContent = "Scan for UFO contacts";
    const copy = el("div", "op-region");
    copy.textContent = "Advance time on the Geoscape to detect a UFO track.";
    const openGeo = el("button", "primary");
    openGeo.textContent = "Open Geoscape";
    openGeo.addEventListener("click", () => this.opts.onOpenGeoscape());
    card.append(eyebrow, title, copy, openGeo);
    return card;
  }

  /** Airborne intercept banner rendered inside the primary card. Carries an
   *  enabled Open-Geoscape CTA plus a disabled "Intercept first" indicator so the
   *  player is never offered a launchable crash-site mission while the UFO is
   *  still airborne. Variant class tracks engaging/escaped. */
  private renderAirborneBanner(contact: UfoContact): HTMLElement {
    const banner = el("div", `airborne-banner ${contact.status}`);
    const icon = el("span", "banner-icon");
    const body = el("div", "banner-body");
    const title = el("strong");
    const copy = el("p");
    if (contact.status === "engaging") {
      icon.textContent = "✦";
      title.textContent = "Interceptor engaging";
      copy.textContent = `${contact.id} over ${contact.region}. Direct the dogfight on the Geoscape to bring it down.`;
    } else if (contact.status === "escaped") {
      icon.textContent = "↗";
      title.textContent = "UFO escaped";
      copy.textContent = `${contact.id} slipped the intercept. Resume the scan on the Geoscape.`;
    } else {
      icon.textContent = "✈";
      title.textContent = "Airborne UFO detected";
      copy.textContent = `${contact.id} is tracked over ${contact.region}. Intercept to bring it down.`;
    }
    const actions = el("div", "banner-actions");
    const openGeo = el("button", "primary");
    openGeo.textContent = "Open Geoscape";
    openGeo.addEventListener("click", () => this.opts.onOpenGeoscape());
    const intercept = el("button", "ui-cta");
    intercept.textContent = "Intercept first";
    intercept.disabled = true;
    actions.append(openGeo, intercept);
    body.append(title, copy, actions);
    banner.append(icon, body);
    return banner;
  }

  /** Slim campaign-objective progress bar + a one-line last-mission summary. */
  private renderObjectiveStrip(campaign: CampaignState): HTMLElement {
    const objective = campaignObjectiveProgress(campaign);
    const strip = el("div", "objective-strip");
    const head = el("div", "obj-head");
    const headLabel = el("span");
    headLabel.textContent = objective.title;
    const headVal = el("b");
    headVal.textContent = `${objective.completed}/${objective.required} cores`;
    head.append(headLabel, headVal);
    const bar = el("div", objective.status === "lost" ? "progress danger" : "progress");
    const fill = el("i");
    fill.style.width = `${objective.percent}%`;
    bar.appendChild(fill);
    const summary = el("p", "obj-summary");
    const last = campaign.lastMission;
    summary.textContent = last
      ? `Last op ${last.missionNumber} ${last.result === "success" ? "secured" : "failed"} — ${last.region}: ${last.summary}`
      : "No field report yet. Launch a recovery operation to begin.";
    strip.append(head, bar, summary);
    return strip;
  }

  /** Render the active facility room: a header (icon + facility name + back to
   *  base) followed by the room's focused body. The selected room persists across
   *  update() refreshes because activeRoom is a class field. */
  private renderRoom(campaign: CampaignState): HTMLElement {
    const meta = ROOM_META[this.activeRoom];
    const room = el("div", "facility-room");
    // The back affordance shows for any non-overview room AND whenever a facility
    // interior is mounted — overview-mapped facilities (power/radar/stores/...)
    // still need a way back out of their dive.
    room.append(this.renderRoomHeader(meta, this.activeRoom !== "overview" || this.interiorRoot !== null));
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
      case "overview":
      default:
        body.append(this.renderOverview(campaign));
        break;
    }
    room.append(body);
    return room;
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

  /** Overview hub (default room): base capacity at a glance, a hint to click a 3D
   *  facility, and a grid of facility rooms that each open their dedicated screen.
   *  This is the non-3D equivalent of clicking a facility in the cutaway. */
  private renderOverview(campaign: CampaignState): HTMLElement {
    const wrap = el("div", "hub-overview");
    const summary = summarizeBaseFacilities(constructedFacilities(campaign));
    const stats = el("div", "op-chips");
    stats.append(
      span(`Power ${summary.powerUsed}/${summary.powerCapacity}`),
      span(`Staff ${summary.staffAssigned}`),
      span(`Rooms ${summary.facilities}`),
      span(`Hangar ${summary.hangarSlots} slots`),
    );
    const hint = el("div", "empty-state");
    hint.textContent = "Click a facility in the base, or pick a room below.";
    const label = el("div", "section-label");
    label.textContent = "Facilities";
    const nav = el("div", "room-nav");
    for (const id of ROOM_NAV) {
      const meta = ROOM_META[id];
      const card = el("button", "room-card");
      const icon = el("span", "room-icon");
      icon.textContent = meta.icon;
      const name = el("span", "room-name");
      name.textContent = meta.label;
      const blurb = el("span", "room-blurb");
      blurb.textContent = meta.blurb;
      card.append(icon, name, blurb);
      card.addEventListener("click", () => {
        this.activeRoom = id;
        this.refreshHud();
      });
      nav.appendChild(card);
    }
    wrap.append(stats, hint, label, nav);
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
    const row = el("div", `craft-row ${craft.kind}`);
    const icon = el("span", "craft-icon");
    icon.textContent = "✈";
    const body = el("div", "craft-body");
    const heading = el("div", "craft-heading");
    const kind = el("span", "craft-kind");
    kind.textContent = craft.kind === "interceptor" ? "Interceptor" : "Transport";
    const name = el("strong");
    name.textContent = craft.name;
    heading.append(kind, name);
    const copy = el("p", "card-copy");
    const repairedAt = craft.repairedAtHour;
    const repairing = repairedAt !== undefined && repairedAt > campaign.clock.elapsedHours;
    const integrity = Math.max(0, 100 - craft.damage);
    if (craft.kind === "transport") {
      copy.textContent = repairing
        ? `In maintenance — ${repairedAt! - campaign.clock.elapsedHours}h until ready.`
        : `Ready for deployment — ${craft.sorties} sorties flown.`;
    } else if (repairing) {
      copy.textContent =
        `Integrity ${integrity}% — repairs underway (${repairedAt! - campaign.clock.elapsedHours}h remaining).`;
    } else {
      copy.textContent = `Integrity ${integrity}% — ${craft.sorties} sorties flown. Ready to intercept.`;
    }
    body.append(heading, copy);
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
    const head = el("div", "panel-head");
    const title = el("span", "panel-title");
    title.textContent = `${deployment.length}/${DEPLOYMENT_SIZE} deployed`;
    const recruit = el("button");
    recruit.textContent = `Recruit (${RECRUIT_COST}c)`;
    recruit.disabled = campaign.strategic.status !== "active" || !canRecruitSoldier(campaign);
    recruit.addEventListener("click", () => this.opts.onRecruitSoldier());
    head.append(title, recruit);
    const table = el("div", "soldier-table");
    if (campaign.soldiers.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No operatives on roster. Recruit to field a squad.";
      table.appendChild(empty);
    }
    for (const soldier of campaign.soldiers) {
      table.appendChild(this.renderSoldierRow(campaign, soldier, deployedIds));
    }
    wrap.append(head, table);
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

  private renderSoldierRow(
    campaign: CampaignState,
    soldier: CampaignSoldier,
    deployedIds: Set<string>,
  ): HTMLElement {
    const row = el(
      "div",
      `soldier-row ${soldier.status}${this.expandedSoldierId === soldier.id ? " selected" : ""}`,
    );
    const deployed = deployedIds.has(soldier.id);
    const deployToggle = el("label", "deploy-toggle");
    const deployCheckbox = document.createElement("input");
    deployCheckbox.type = "checkbox";
    deployCheckbox.checked = deployed;
    deployCheckbox.disabled =
      campaign.strategic.status !== "active" || (deployed ? false : !canDeploySoldier(campaign, soldier.id));
    deployCheckbox.setAttribute("aria-label", `${deployed ? "Remove" : "Deploy"} ${soldier.name}`);
    deployCheckbox.addEventListener("click", (event) => event.stopPropagation());
    deployCheckbox.addEventListener("change", () => {
      this.opts.onToggleDeployment(soldier.id, deployCheckbox.checked);
    });
    deployToggle.append(deployCheckbox, document.createTextNode(deployed ? "DROP" : "ADD"));

    const nameCell = el("div", "s-name-cell");
    const nameEl = el("span", "s-name");
    nameEl.textContent = soldier.name;
    nameCell.append(nameEl);
    if (soldier.bio) {
      const bioEl = el("span", "s-bio");
      bioEl.textContent = soldier.bio;
      nameCell.append(bioEl);
    }
    const rankEl = el("span", "s-rank");
    rankEl.textContent = soldier.rank;

    const currentWeapon = soldierWeaponId(campaign, soldier.id);
    const weaponSelect = el("select");
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
    weaponSelect.addEventListener("click", (event) => event.stopPropagation());
    weaponSelect.addEventListener("change", () => {
      const next = weaponSelect.value as CampaignWeaponId;
      this.opts.onAssignWeapon(soldier.id, next);
    });

    row.append(
      deployToggle,
      nameCell,
      rankEl,
      this.renderSoldierStatus(campaign, soldier),
      weaponSelect,
      this.renderSoldierItems(campaign, soldier),
    );
    if (this.expandedSoldierId === soldier.id) {
      const detail = el("div", "soldier-detail");
      const growth = soldier.statGrowth ? this.formatStatDeltas(soldier.statGrowth) : "";
      const effective = this.formatStatDeltas(campaignSoldierStatBonus(campaign, soldier));
      let detailText =
        `${soldier.missions} missions · ${soldier.survivedMissions} survived · rank ${soldier.rank}`;
      if (soldier.status === "wounded") detailText += " · wounded";
      if (growth) detailText += ` · growth ${growth}`;
      if (effective) detailText += ` · effective ${effective}`;
      detail.textContent = `${detailText}.`;
      row.appendChild(detail);
    }
    row.addEventListener("click", () => {
      this.expandedSoldierId = this.expandedSoldierId === soldier.id ? null : soldier.id;
      this.refreshHud();
    });
    return row;
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
      chipEl.append(icon, document.createTextNode(`Rec ${remaining}h`));
    } else if (soldier.status === "kia") {
      icon.textContent = "✖";
      chipEl.append(icon, document.createTextNode("KIA"));
    } else {
      icon.textContent = "✓";
      chipEl.append(icon, document.createTextNode("Ready"));
    }
    return chipEl;
  }

  /** Construction room: base power/staff/room capacity chips, clickable
   *  installed-facility rows (each opens that facility's own room and highlights
   *  the 3D cutaway), then active construction + buildable facilities. */
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

    const label = el("div", "section-label");
    label.textContent = "Installed";
    const installed = el("div");
    for (const facility of constructedFacilities(campaign)) {
      const row = el(
        "div",
        `facility-row${facility.id === this.selectedFacilityId ? " selected" : ""}`,
      );
      const name = el("span", "fr-name");
      name.textContent = facility.label;
      const state = el("span", "fr-state");
      state.textContent = "Open";
      row.append(name, state);
      // The facility row is a click target but a <div>; promote it to a real
      // button role so Tab reaches it and Enter/Space activates it (mirrors the
      // on-canvas facility click + the overview room-cards, which are buttons).
      row.setAttribute("role", "button");
      row.tabIndex = 0;
      row.setAttribute("aria-label", `Open ${facility.label} facility room`);
      const open = (): void => this.selectFacility(facility.id);
      row.addEventListener("click", open);
      row.addEventListener("keydown", (event: KeyboardEvent) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      });
      installed.appendChild(row);
    }

    wrap.append(capLabel, chips, label, installed, this.renderConstructionList(campaign));
    return wrap;
  }

  /** Selecting an installed facility (from the Construction room list) opens that
   *  facility's dedicated room, lifts its emissive, and dives the camera into its
   *  3D interior — mirroring the on-canvas facility click end to end. */
  private selectFacility(facilityId: string): void {
    const facility = findBaseFacility(facilityId);
    this.selectedFacilityId = facilityId;
    this.activeRoom = facility ? roomForFacilityKind(facility.kind) : "overview";
    if (facility) this.enterFacilityInterior(roleForFacilityKind(facility.kind));
    this.applyFacilityHighlight();
    this.refreshHud();
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
    copy.textContent = `Captured ${hoursAgo}h ago.`;
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
    const wrap = el("div");

    const legend = el("div", "tech-legend");
    legend.append(
      this.techLegend("✓", "Completed", "completed"),
      this.techLegend("▸", "Available", "available"),
      this.techLegend("⊘", "Locked", "locked"),
    );
    wrap.appendChild(legend);

    const tree = researchTree(campaign);
    const tierOf = this.researchTiers();
    const maxTier = Math.max(0, ...tierOf.values());
    const treeEl = el("div", "tech-tree");
    for (let tier = 0; tier <= maxTier; tier++) {
      const entries = tree.filter((node) => tierOf.get(node.project.id) === tier);
      if (entries.length === 0) continue;
      const column = el("div", tier > 0 ? "tech-tier linked" : "tech-tier");
      const label = el("div", "tech-tier-label");
      label.textContent = `Tier ${tier}`;
      column.appendChild(label);
      for (const entry of entries) {
        column.appendChild(
          this.renderResearchNode(campaign, entry, tier),
        );
      }
      treeEl.appendChild(column);
    }
    wrap.appendChild(treeEl);
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

  private techLegend(icon: string, label: string, cls: string): HTMLElement {
    const chip = el("span", `tech-legend-item ${cls}`);
    const iconEl = el("span", "tech-node-icon");
    iconEl.textContent = icon;
    chip.append(iconEl, document.createTextNode(label));
    return chip;
  }

  private renderResearchNode(
    campaign: CampaignState,
    entry: ResearchTreeNode,
    tier: number,
  ): HTMLElement {
    const project = entry.project;
    const activeRes = campaign.activeResearch;
    const isActive = activeRes?.projectId === project.id;

    // Reconcile the tree status: researchTree may report "locked" simply because
    // the lab is busy. A project whose prerequisites are all met is rendered as
    // available (just lab-blocked), so we never show a misleading "Requires:"
    // line on something the player has actually unlocked.
    const unmetRequires = project.requires
      .filter((req) => !hasResearch(campaign, req))
      .map((req) => RESEARCH_PROJECTS.find((candidate) => candidate.id === req)?.title ?? req);
    const requiresMet = unmetRequires.length === 0;
    const status: "completed" | "available" | "locked" | "active" =
      isActive ? "active"
        : entry.status === "locked" && requiresMet ? "available"
        : entry.status;

    const node = el("article", `tech-node ${status}`);

    if (tier > 0) {
      const connector = el("span", "tech-connector");
      connector.textContent = "►";
      connector.title = `Descends from Tier ${tier - 1}`;
      node.appendChild(connector);
    }

    const head = el("div", "tech-node-head");
    const icon = el("span", "tech-node-icon");
    const badge = el("span", "tech-node-status");
    if (status === "active") {
      icon.textContent = "↻";
      badge.textContent = "In progress";
    } else if (status === "completed") {
      icon.textContent = "✓";
      badge.textContent = "Completed";
    } else if (status === "available") {
      icon.textContent = "▸";
      badge.textContent = "Available";
    } else {
      icon.textContent = "⊘";
      badge.textContent = "Locked";
    }
    const title = el("span", "tech-node-title");
    title.textContent = project.title;
    head.append(icon, title, badge);
    node.appendChild(head);

    const desc = el("p", "tech-node-desc");
    desc.textContent = project.description;
    node.appendChild(desc);

    // Captive-gated nodes (the interrogation chain) get a small requirement
    // annotation. When the node is otherwise startable but no qualifying
    // captive is held, the annotation explains WHY instead of the generic
    // "Need resources" button label.
    const captiveLabel = this.captiveRequirementLabel(project);
    const captiveQualified = captiveLabel === null || this.hasQualifyingCaptiveFor(campaign, project);
    if (captiveLabel && status !== "completed") {
      const note = el("div", "tech-node-req");
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
      const bar = el("div", "progress tech-progress");
      const fill = el("i");
      fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.appendChild(fill);
      const meta = el("div", "tech-node-meta");
      meta.textContent = `${remaining}h remaining — scientists are working`;
      node.append(bar, meta);
      return node;
    }

    if (status === "completed") {
      const meta = el("div", "tech-node-meta");
      meta.textContent = project.completedDescription;
      node.appendChild(meta);
      return node;
    }

    if (status === "locked") {
      const req = el("div", "tech-node-req");
      req.textContent = unmetRequires.length > 0
        ? `Requires: ${unmetRequires.join(", ")}`
        : "Locked";
      node.appendChild(req);
      return node;
    }

    // available
    const cost = researchCost(campaign, project.id);
    const meta = el("div", "tech-node-meta");
    meta.append(
      span(formatCost(cost), "card-cost"),
      span(`${researchDuration(campaign, project.id)}h`),
    );
    node.appendChild(meta);

    const labBusy = !!campaign.activeResearch;
    const canStart = canStartResearch(campaign, project.id);
    const button = el("button");
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
    const wrap = el("div");

    const activeMfg = campaign.activeManufacturing;
    if (activeMfg) {
      const project = MANUFACTURING_PROJECTS.find((candidate) => candidate.id === activeMfg.projectId);
      const remaining = Math.max(0, activeMfg.completesAtHour - campaign.clock.elapsedHours);
      const duration = activeMfg.completesAtHour - activeMfg.startedAtHour;
      const fraction =
        duration > 0
          ? Math.min(1, Math.max(0, (campaign.clock.elapsedHours - activeMfg.startedAtHour) / duration))
          : 0;
      const card = el("section", "tab-card");
      const strong = el("strong");
      strong.textContent = `${project?.title ?? activeMfg.projectId} in production`;
      const bar = el("div", "progress");
      const fill = el("i");
      fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.appendChild(fill);
      const copy = el("p", "card-copy");
      copy.textContent = `${remaining}h remaining — workshop is fabricating.`;
      card.append(strong, bar, copy);
      wrap.appendChild(card);
    }

    const available = MANUFACTURING_PROJECTS.filter((project) => project.id !== activeMfg?.projectId);
    if (available.length > 0) {
      const label = el("div", "section-label");
      label.textContent = "Buildable items";
      wrap.appendChild(label);
      for (const project of available) {
        wrap.appendChild(this.renderManufacturingCard(campaign, project, !!activeMfg));
      }
    }
    return wrap;
  }

  private renderManufacturingCard(
    campaign: CampaignState,
    project: ManufacturingProject,
    workshopBusy: boolean,
  ): HTMLElement {
    const card = el("section", "tab-card");
    const locked = !!project.requiresResearch && !hasResearch(campaign, project.requiresResearch);
    const canManufacture = canStartManufacturing(campaign, project.id);
    const cost = manufacturingCost(campaign, project.id);
    const title = el("strong");
    title.textContent = project.title;
    const copy = el("p", "card-copy");
    copy.textContent = workshopBusy
      ? "Workshop is committed to another order."
      : locked
        ? `Requires ${project.requiresResearch}. ${project.description}`
        : `${project.description} Cost ${formatCost(cost)}, ${manufacturingDuration(campaign, project.id)}h.`;
    const row = el("div", "card-row");
    const costLabel = el("span", "card-cost");
    costLabel.textContent = formatCost(cost);
    const button = el("button");
    button.textContent = workshopBusy
      ? "Workshop busy"
      : locked
        ? "Research required"
        : canManufacture
          ? "Start production"
          : "Need resources";
    button.disabled = workshopBusy || !canManufacture;
    button.addEventListener("click", () => this.opts.onStartManufacturing(project.id));
    row.append(costLabel, button);
    card.append(title, copy, row);
    return card;
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
        Object.assign(el("em"), { textContent: `${remaining}h` }),
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
          `Build ${facilityConstructionDuration(campaign, facility.id)}h.`;
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
    if (id !== this.hoveredFacilityId) {
      this.hoveredFacilityId = id;
      this.applyFacilityHighlight();
    }
    const dom = this.renderer.domElement;
    if (!this.tooltipEl) return;
    if (hit) {
      const facility = findBaseFacility(hit.facilityId);
      const building = this.opts.campaign.activeConstruction?.facilityId === hit.facilityId;
      this.tooltipEl.replaceChildren();
      const strong = el("strong");
      strong.textContent = facility?.label ?? hit.facilityId;
      const note = el("span");
      note.textContent = building ? "Under construction" : (facility?.effect ?? "");
      this.tooltipEl.append(strong, note);
      this.tooltipEl.style.left = `${event.clientX}px`;
      this.tooltipEl.style.top = `${event.clientY}px`;
      this.tooltipEl.classList.add("visible");
      dom.style.cursor = "pointer";
    } else {
      this.tooltipEl.classList.remove("visible");
      dom.style.cursor = "default";
    }
  };

  /** Click a facility floor in the 3D base: open that facility's dedicated room
   *  (the lab, workshop, barracks, or hangar), keep it selected so the cutaway
   *  stays highlighted, dive the camera INTO its 3D interior, and re-render the
   *  detail panel. Facilities without their own screen fall back to the overview
   *  hub. Ignored while an interior is already open (use Back to Base first). */
  private onCanvasClick = (event: MouseEvent): void => {
    if (this.disposed || this.facilityMeshes.length === 0 || this.interiorRoot) return;
    const hit = this.facilityMeshAt(event);
    if (!hit) return;
    this.selectedFacilityId = hit.facilityId;
    const facility = findBaseFacility(hit.facilityId);
    this.activeRoom = facility ? roomForFacilityKind(facility.kind) : "overview";
    if (facility) this.enterFacilityInterior(roleForFacilityKind(facility.kind));
    this.applyFacilityHighlight();
    this.refreshHud();
  };

  /** Dive the camera INTO a facility's 3D interior: mount its diorama (built by
   *  baseFacilityInteriors), hide the hub exterior, and tween the camera to a
   *  close 3/4 hero framing. The facility's existing DOM room controls stay
   *  overlaid (refreshHud re-renders the sidebar) so the player can still act. */
  private enterFacilityInterior(role: FacilityRole): void {
    if (this.disposed) return;
    // Tear down any prior interior first (defensive — never two at once).
    this.clearInterior();
    const diorama = buildFacilityInterior(role);
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
    this.crewSystem?.tick(dt);
    this.crewSystemLeft?.tick(dt);
    this.crewSystemRight?.tick(dt);
    this.renderer.render(this.scene, this.camera);
  };
}
