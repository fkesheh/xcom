import {
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
  findBaseFacility,
  facilityCost,
  STARTER_BASE_GRID,
  type BaseFacility,
  type FacilityKind,
  summarizeBaseFacilities,
} from "../campaign/base";
import {
  activeSoldiers,
  availableWeaponCount,
  availableBaseFacilities,
  CAMPAIGN_WEAPON_IDS,
  canAssignSoldierWeapon,
  canBuildFacility,
  canDeploySoldier,
  canPurchaseWeapon,
  canRecruitSoldier,
  canStartResearch,
  campaignObjectiveProgress,
  constructedFacilities,
  DEPLOYMENT_SIZE,
  deploymentSoldiers,
  difficultyConfig,
  facilityConstructionDuration,
  hasResearch,
  RECRUIT_COST,
  type ManufacturingProject,
  MANUFACTURING_PROJECTS,
  MARKET_CONFIG,
  type ResearchProject,
  RESEARCH_PROJECTS,
  canStartManufacturing,
  manufacturingCost,
  manufacturingDuration,
  researchDuration,
  researchCost,
  soldierWeaponId,
} from "../campaign/storage";
import { generateOperation } from "../campaign/operations";
import type {
  CampaignSoldier,
  CampaignState,
  CampaignWeaponId,
  ManufacturingProjectId,
  OperationPlan,
  ResearchId,
  UfoContact,
} from "../campaign/types";
import { WEAPONS } from "../sim/content";

interface BaseViewOptions {
  campaign: CampaignState;
  operation: OperationPlan;
  onLaunchMission: () => void;
  onStartResearch: (id: ResearchId) => void;
  onBuildFacility: (id: string) => void;
  onRecruitSoldier: () => void;
  onAssignWeapon: (soldierId: string, weaponId: CampaignWeaponId) => void;
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

interface BaseWalker {
  actor: Group;
  path: Vector3[];
  segmentLengths: number[];
  totalLength: number;
  speed: number;
  offset: number;
}

const BASE_CORRIDORS: readonly BaseCorridor[] = [
  { id: "north-link", x: 2, y: 0, w: 1, h: 1 },
  { id: "east-spine-1", x: 4, y: 1, w: 1, h: 1 },
  { id: "east-spine-2", x: 4, y: 2, w: 1, h: 1 },
  { id: "quarters-link", x: 2, y: 3, w: 1, h: 1 },
  { id: "generator-link", x: 4, y: 3, w: 1, h: 1 },
];

const CSS = `
#base-view {
  position: fixed;
  inset: 0;
  overflow: hidden;
  color: #e7f7ff;
  background:
    radial-gradient(circle at 42% 48%, rgba(22,60,76,.5), transparent 40%),
    linear-gradient(160deg, #02070d, #07131d 54%, #010308);
  font: 13px/1.45 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .01em;
}
#base-view::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 1;
  pointer-events: none;
  background: radial-gradient(circle at 46% 54%, transparent 36%, rgba(0,0,0,.68) 100%);
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
  color: #67e8f9;
  font: 800 13px/1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .22em;
  text-transform: uppercase;
}
#base-view .brand-region {
  color: #9db5c5;
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .brand-clock {
  color: #fbbf24;
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .06em;
}
#base-view .topbar-chips {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
}
#base-view .top-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border: 1px solid rgba(103,232,249,.24);
  border-radius: 999px;
  color: #e7f7ff;
  background: rgba(8,28,40,.55);
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .03em;
  white-space: nowrap;
}
#base-view .top-chip .chip-icon { color: #67e8f9; font-size: 13px; }
#base-view .top-chip.warn { border-color: rgba(251,191,36,.5); }
#base-view .top-chip.warn .chip-icon { color: #fbbf24; }
#base-view .top-chip.danger { border-color: rgba(251,113,133,.5); color: #fecaca; }
#base-view .top-chip.danger .chip-icon { color: #fb7185; }
#base-view .base-sidebar {
  position: absolute;
  top: 64px;
  right: 12px;
  bottom: 12px;
  width: min(380px, calc(100vw - 24px));
  z-index: 4;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  overflow: auto;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 12px;
  background: linear-gradient(180deg, rgba(8,18,28,.86), rgba(4,10,16,.9));
  box-shadow: 0 24px 80px rgba(0,0,0,.5);
  backdrop-filter: blur(10px);
}
#base-view .operation-card {
  position: relative;
  padding: 14px;
  border: 1px solid rgba(103,232,249,.5);
  border-radius: 12px;
  background: linear-gradient(160deg, rgba(10,34,46,.92), rgba(4,16,24,.94));
  box-shadow: 0 0 0 1px rgba(103,232,249,.1), 0 10px 38px rgba(8,80,100,.26);
}
#base-view .op-eyebrow {
  color: #67e8f9;
  font: 800 12px/1 ui-monospace, monospace;
  letter-spacing: .18em;
  text-transform: uppercase;
}
#base-view .op-title {
  margin: 6px 0 4px;
  color: #e7f7ff;
  font: 800 18px/1.15 Inter, ui-sans-serif, sans-serif;
  letter-spacing: .02em;
}
#base-view .op-region {
  color: #9db5c5;
  font: 700 12px/1.3 ui-monospace, monospace;
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
  color: #cfeaf6;
  background: rgba(8,28,40,.5);
  font: 700 12px/1 ui-monospace, monospace;
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
  color: #e7f7ff;
  background: rgba(8,35,47,.5);
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .mission-chip .mission-icon { color: #67e8f9; font-size: 13px; }
#base-view .mission-chip.crashSite { border-color: rgba(103,232,249,.4); }
#base-view .mission-chip.terror { border-color: rgba(251,113,133,.55); color: #fecaca; }
#base-view .mission-chip.terror .mission-icon { color: #fb7185; }
#base-view .mission-chip.landedUfo { border-color: rgba(167,139,250,.5); color: #ddd6fe; }
#base-view .mission-chip.landedUfo .mission-icon { color: #a78bfa; }
#base-view .mission-chip.baseDefense { border-color: rgba(251,191,36,.55); color: #fde68a; }
#base-view .mission-chip.baseDefense .mission-icon { color: #fbbf24; }
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
  color: #fbbf24;
  font-size: 16px;
}
#base-view .airborne-banner.engaging .banner-icon { border-color: rgba(251,113,133,.6); color: #fb7185; }
#base-view .airborne-banner.escaped .banner-icon { border-color: rgba(148,163,184,.4); color: #94a3b8; }
#base-view .airborne-banner .banner-body strong {
  display: block;
  color: #fef3c7;
  font: 800 13px/1.2 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view .airborne-banner.engaging .banner-body strong { color: #fecaca; }
#base-view .airborne-banner.escaped .banner-body strong { color: #cbd5e1; }
#base-view .airborne-banner .banner-body p {
  margin: 5px 0 0;
  color: #c2d2dd;
  font: 500 12px/1.4 Inter, sans-serif;
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
  color: #cfeaf6;
  font: 700 12px/1.2 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .objective-strip .obj-head b { color: #67e8f9; }
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
  background: linear-gradient(90deg, #22d3ee, #67e8f9);
}
#base-view .progress.danger > i { background: linear-gradient(90deg, #fb7185, #f43f5e); }
#base-view .objective-strip .obj-summary {
  margin: 0;
  color: #9db5c5;
  font: 500 12px/1.4 Inter, sans-serif;
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
  font-size: 12px;
}
#base-view .room-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid rgba(103,232,249,.4);
  border-radius: 8px;
  color: #67e8f9;
  background: rgba(8,28,40,.5);
  font-size: 15px;
  flex: none;
}
#base-view .room-title {
  color: #e7f7ff;
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
  gap: 5px;
  min-height: 70px;
  padding: 10px 11px;
  text-align: left;
  text-transform: none;
  letter-spacing: 0;
  font: 600 12px/1.3 Inter, sans-serif;
}
#base-view .room-card .room-name {
  color: #e7f7ff;
  font: 800 12px/1 ui-monospace, monospace;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view .room-card .room-blurb {
  color: #9db5c5;
  font: 500 11px/1.35 Inter, sans-serif;
}
#base-view .panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 2px 0 9px;
}
#base-view .panel-head .panel-title {
  color: #cfeaf6;
  font: 800 13px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}
#base-view .panel-head button {
  min-height: 32px;
  padding: 0 11px;
  font-size: 12px;
}
#base-view .section-label {
  margin: 6px 0 7px;
  color: #67e8f9;
  font: 800 12px/1 ui-monospace, monospace;
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
  color: #e7f7ff;
  font: 800 13px/1.2 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .tab-card .card-copy {
  margin: 6px 0 0;
  color: #adc5d2;
  font: 500 12px/1.4 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .tab-card .card-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
  margin-top: 7px;
  color: #9db5c5;
  font: 600 12px/1.2 ui-monospace, monospace;
}
#base-view .tab-card .card-cost { color: #fbbf24; }
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
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .soldier-table {
  display: grid;
  gap: 6px;
}
#base-view .soldier-row {
  display: grid;
  grid-template-columns: auto minmax(64px, 1.4fr) auto auto minmax(92px, 1fr);
  gap: 8px;
  align-items: center;
  padding: 8px 9px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 8px;
  color: #e7f7ff;
  background: rgba(2,12,20,.42);
  font: 600 12px/1.2 ui-monospace, monospace;
}
#base-view .soldier-row.selected,
#base-view .soldier-row:hover {
  border-color: rgba(103,232,249,.45);
  background: rgba(8,35,47,.5);
}
#base-view .soldier-row.kia { color: #fb7185; opacity: .75; }
#base-view .soldier-row.wounded { color: #fbbf24; }
#base-view .soldier-row .s-name { color: #e7f7ff; }
#base-view .soldier-row .s-rank { color: #9db5c5; }
#base-view .deploy-toggle {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  color: #67e8f9;
  font: 700 12px/1 ui-monospace, monospace;
}
#base-view .deploy-toggle input { width: 15px; height: 15px; accent-color: #67e8f9; }
#base-view .deploy-toggle:has(input:disabled) { color: #64748b; opacity: .65; }
#base-view .soldier-row select {
  min-width: 92px;
  color: #e7f7ff;
  border: 1px solid rgba(103,232,249,.24);
  border-radius: 6px;
  background: rgba(1,9,15,.85);
  font: 600 12px/1 ui-monospace, monospace;
  letter-spacing: .03em;
}
#base-view .soldier-row select:disabled { opacity: .45; }
#base-view .status-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  border: 1px solid rgba(103,232,249,.3);
  border-radius: 999px;
  color: #e7f7ff;
  font: 700 12px/1 ui-monospace, monospace;
  white-space: nowrap;
}
#base-view .status-chip.wounded { border-color: rgba(251,191,36,.5); color: #fde68a; }
#base-view .status-chip.kia { border-color: rgba(251,113,133,.5); color: #fda4af; }
#base-view .soldier-detail {
  grid-column: 1 / -1;
  margin-top: 6px;
  padding: 8px 9px;
  border-top: 1px dashed rgba(103,232,249,.2);
  color: #9db5c5;
  font: 500 12px/1.4 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .facility-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 9px;
  margin-bottom: 6px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 8px;
  background: rgba(2,12,20,.42);
  color: #e7f7ff;
  font: 600 12px/1.2 ui-monospace, monospace;
  cursor: pointer;
}
#base-view .facility-row:hover { border-color: rgba(103,232,249,.4); }
#base-view .facility-row.selected {
  border-color: rgba(103,232,249,.7);
  box-shadow: inset 0 0 0 1px rgba(103,232,249,.3);
  background: rgba(12,40,52,.55);
}
#base-view .facility-row .fr-state { color: #4ade80; }
#base-view .facility-row .fr-state.building { color: #fbbf24; }
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
  font: 700 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .build-card .bc-head em { color: #fbbf24; font-style: normal; }
#base-view .build-card p {
  margin: 6px 0 0;
  color: #b9c7d2;
  font: 500 12px/1.4 Inter, sans-serif;
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
  color: #e7f7ff;
  font: 800 13px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-card .market-credits { color: #fbbf24; }
#base-view .market-card > p {
  margin-top: 6px;
  color: #adc5d2;
  font: 500 12px/1.4 Inter, sans-serif;
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
  color: #e7f7ff;
  font: 700 12px/1.1 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-item .market-price { color: #fbbf24; }
#base-view .market-item .market-stock { color: #8aa7b8; }
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
  color: #ecfeff;
  border: 1px solid rgba(132,165,188,.32);
  border-radius: 8px;
  background: linear-gradient(180deg, rgba(34,51,65,.95), rgba(11,24,34,.96));
  font: 800 12px/1 ui-monospace, "SF Mono", Menlo, monospace;
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
  font-size: 13px;
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
  color: #8aa7b8;
  background: rgba(2,12,20,.3);
  text-align: center;
  font: 700 12px/1.4 ui-monospace, monospace;
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
  color: #e7f7ff;
  background: rgba(4,14,22,.95);
  box-shadow: 0 12px 36px rgba(0,0,0,.5);
  pointer-events: none;
  opacity: 0;
  transform: translate(-50%, -130%);
  transition: opacity .12s ease;
  font: 600 12px/1.35 Inter, sans-serif;
  letter-spacing: 0;
  text-transform: none;
}
#base-view .base-tooltip.visible { opacity: 1; }
#base-view .base-tooltip strong {
  display: block;
  color: #67e8f9;
  font: 800 12px/1.2 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .base-tooltip span { color: #adc5d2; }
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
  font: 800 12px/1.3 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .notice-toast.visible { opacity: 1; transform: translate(-50%, 0); }
#base-view .notice-toast[data-kind="warning"] {
  border-color: rgba(251,113,133,.55);
  color: #fecaca;
  background: rgba(45,11,18,.92);
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

function facilityColor(kind: BaseFacility["kind"]): number {
  switch (kind) {
    case "hangar":
      return 0x3b82f6;
    case "command":
      return 0x67e8f9;
    case "lab":
      return 0xa78bfa;
    case "workshop":
      return 0xf59e0b;
    case "stores":
      return 0x94a3b8;
    case "living":
      return 0x4ade80;
    case "medbay":
      return 0x5eead4;
    case "power":
      return 0xfbbf24;
    case "radar":
      return 0x22d3ee;
    case "access":
      return 0xf87171;
  }
}

function makeMaterial(color: number, emissive = 0, emissiveIntensity = 0): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity,
    roughness: 0.58,
    metalness: 0.28,
  });
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

type RoomId = "overview" | "research" | "engineering" | "barracks" | "hangar" | "construction";

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
};

/** Rooms reachable from the overview hub's facility list. */
const ROOM_NAV: readonly RoomId[] = [
  "research",
  "engineering",
  "barracks",
  "hangar",
  "construction",
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

export class BaseView {
  private readonly root: HTMLDivElement;
  private readonly canvasWrap: HTMLDivElement;
  private readonly scene = new Scene();
  private readonly camera = new PerspectiveCamera(42, 1, 0.1, 100);
  private readonly renderer = new WebGLRenderer({ antialias: true, alpha: true });
  private readonly baseGroup = new Group();
  private readonly pulseMaterials: Array<{ material: MeshBasicMaterial; opacity: number }> = [];
  private readonly rotators: BaseRotator[] = [];
  private readonly walkers: BaseWalker[] = [];
  private raf = 0;
  private disposed = false;
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

  constructor(private readonly opts: BaseViewOptions) {
    injectStyle();
    this.root = el("div");
    this.root.id = "base-view";
    this.canvasWrap = el("div", "base-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.camera.position.set(-0.3, 6.4, 7.5);
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
    window.removeEventListener("resize", this.resize);
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
    this.scene.fog = new Fog(0x02070d, 8, 18);
    this.scene.add(new AmbientLight(0x9bdcf4, 0.55));
    const key = new DirectionalLight(0xe7fbff, 2.1);
    key.position.set(4.5, 7, 5.5);
    this.scene.add(key);
    const rim = new DirectionalLight(0x3b82f6, 1.2);
    rim.position.set(-5, 4, -5);
    this.scene.add(rim);
    const glow = new PointLight(0x67e8f9, 6, 9, 2);
    glow.position.set(0, 2.2, 0);
    this.scene.add(glow);

    this.baseGroup.position.set(0, -0.12, 0);
    this.baseGroup.rotation.y = BASE_VIEW_YAW;
    this.baseGroup.scale.setScalar(1.15);
    this.scene.add(this.baseGroup);

    this.buildTerrainSlab();
    this.buildCutawayShell();
    for (const corridor of BASE_CORRIDORS) this.buildCorridor(corridor);
    for (const facility of availableBaseFacilities(this.opts.campaign)) this.buildExpansionPad(facility);
    for (const facility of constructedFacilities(this.opts.campaign)) this.buildFacility(facility);
    this.addOverheadSystems();
    this.addInteriorTraffic();
    this.addPerimeterShafts();
  }

  private buildTerrainSlab(): void {
    const width = STARTER_BASE_GRID.width * CELL + 1.5;
    const depth = STARTER_BASE_GRID.height * CELL + 1.5;
    const earth = new Mesh(
      new BoxGeometry(width + 2.2, 0.72, depth + 2.2),
      makeMaterial(0x06111a, 0x02070d, 0.16),
    );
    earth.position.y = -0.58;
    this.baseGroup.add(earth);

    const slab = new Mesh(
      new BoxGeometry(width, 0.18, depth),
      makeMaterial(0x15293a, 0x05131c, 0.36),
    );
    slab.position.y = -0.13;
    this.baseGroup.add(slab);

    const edge = new LineSegments(
      new EdgesGeometry(slab.geometry),
      new MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.28 }),
    );
    edge.position.copy(slab.position);
    this.baseGroup.add(edge);

    const gridMat = new MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.09,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    for (let x = -STARTER_BASE_GRID.width / 2; x <= STARTER_BASE_GRID.width / 2; x++) {
      const line = new Mesh(new BoxGeometry(0.01, 0.012, STARTER_BASE_GRID.height * CELL), gridMat);
      line.position.set(x * CELL, 0.012, 0);
      this.baseGroup.add(line);
    }
    for (let y = -STARTER_BASE_GRID.height / 2; y <= STARTER_BASE_GRID.height / 2; y++) {
      const line = new Mesh(new BoxGeometry(STARTER_BASE_GRID.width * CELL, 0.012, 0.01), gridMat);
      line.position.set(0, 0.014, y * CELL);
      this.baseGroup.add(line);
    }
  }

  private buildCutawayShell(): void {
    const width = STARTER_BASE_GRID.width * CELL + 1.5;
    const depth = STARTER_BASE_GRID.height * CELL + 1.5;
    const wallHeight = 1.44;
    const rockMat = makeMaterial(0x040a11, 0x0b2230, 0.2);
    const rockLine = new MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0.12,
      blending: AdditiveBlending,
      depthWrite: false,
    });

    const backWall = new Mesh(new BoxGeometry(width + 2.2, wallHeight, 0.26), rockMat);
    backWall.position.set(0, 0.42, -depth / 2 - 0.82);
    const leftWall = new Mesh(new BoxGeometry(0.26, wallHeight * 0.92, depth + 1.55), rockMat);
    leftWall.position.set(-width / 2 - 0.82, 0.36, 0);
    const rearCap = new Mesh(new BoxGeometry(width + 2.4, 0.12, 0.44), makeMaterial(0x07131d, 0x0b2230, 0.24));
    rearCap.position.set(0, 1.14, -depth / 2 - 0.82);
    const sideCap = new Mesh(new BoxGeometry(0.44, 0.12, depth + 1.7), makeMaterial(0x07131d, 0x0b2230, 0.24));
    sideCap.position.set(-width / 2 - 0.82, 1.06, 0);
    this.baseGroup.add(backWall, leftWall, rearCap, sideCap);

    for (let i = 0; i < 5; i++) {
      const y = -0.18 + i * 0.28;
      const backStrata = new Mesh(new BoxGeometry(width + 1.7, 0.018, 0.018), rockLine);
      backStrata.position.set(0, y, -depth / 2 - 0.675);
      const sideStrata = new Mesh(new BoxGeometry(0.018, 0.018, depth + 1.1), rockLine);
      sideStrata.position.set(-width / 2 - 0.675, y - 0.03, 0);
      this.baseGroup.add(backStrata, sideStrata);
    }

    const frontLip = new Mesh(
      new BoxGeometry(width + 1.2, 0.18, 0.18),
      makeMaterial(0x081723, 0x123145, 0.28),
    );
    frontLip.position.set(0, -0.02, depth / 2 + 0.64);
    const rightLip = new Mesh(
      new BoxGeometry(0.18, 0.18, depth + 1.0),
      makeMaterial(0x081723, 0x123145, 0.28),
    );
    rightLip.position.set(width / 2 + 0.64, -0.02, 0);
    this.baseGroup.add(frontLip, rightLip);

    const label = makeLabel("Sublevel 01 / interior cutaway", 0x67e8f9);
    label.position.set(-width / 2 + 1.8, 1.18, -depth / 2 - 0.62);
    label.scale.set(1.6, 0.34, 1);
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

  private pathPoint(x: number, y: number): Vector3 {
    const point = this.cellCenter(x, y, 1, 1);
    point.y = 0.08;
    return point;
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

  private makeCrewFigure(color: number, scale = 1): Group {
    const person = new Group();
    const bodyMat = makeMaterial(0x0f172a, color, 0.24);
    const visorMat = this.glowMaterial(0xdffbff, 0.68);
    const body = new Mesh(new CylinderGeometry(0.045 * scale, 0.06 * scale, 0.2 * scale, 8), bodyMat);
    body.position.y = 0.22 * scale;
    const head = new Mesh(new SphereGeometry(0.055 * scale, 12, 8), visorMat);
    head.position.y = 0.36 * scale;
    const visor = new Mesh(new BoxGeometry(0.05 * scale, 0.024 * scale, 0.03 * scale), visorMat);
    visor.position.set(0, 0.36 * scale, 0.055 * scale);
    const pack = new Mesh(new BoxGeometry(0.065 * scale, 0.09 * scale, 0.025 * scale), bodyMat);
    pack.position.set(0, 0.24 * scale, -0.055 * scale);
    person.add(body, head, visor, pack);
    return person;
  }

  private buildCorridor(corridor: BaseCorridor): void {
    const group = new Group();
    group.position.copy(this.cellCenter(corridor.x, corridor.y, corridor.w, corridor.h));
    this.baseGroup.add(group);

    const width = corridor.w * CELL - 0.28;
    const depth = corridor.h * CELL - 0.28;
    const floor = new Mesh(
      new BoxGeometry(width, 0.08, depth),
      makeMaterial(0x1f3344, 0x061522, 0.18),
    );
    floor.position.y = 0.035;
    group.add(floor);

    const edge = new LineSegments(
      new EdgesGeometry(floor.geometry),
      new MeshBasicMaterial({ color: 0x67e8f9, transparent: true, opacity: 0.45 }),
    );
    edge.position.copy(floor.position);
    group.add(edge);

    this.addWalls(group, width, depth, 0x67e8f9, 0.28, 0.035, 0.1);
    this.addFloorPanelLines(group, width, depth, 0x67e8f9, 0.28);

    const strip = new Mesh(new BoxGeometry(width * 0.72, 0.018, 0.035), this.glowMaterial(0x67e8f9, 0.42));
    strip.position.y = 0.13;
    group.add(strip);
  }

  private buildFacility(facility: BaseFacility): void {
    const color = facilityColor(facility.kind);
    const group = new Group();
    group.position.copy(this.roomCenter(facility));
    this.baseGroup.add(group);

    const width = facility.w * CELL - ROOM_GAP;
    const depth = facility.h * CELL - ROOM_GAP;
    const floor = new Mesh(
      new BoxGeometry(width, 0.12, depth),
      makeMaterial(color, color, 0.12),
    );
    floor.position.y = 0;
    floor.userData.facilityId = facility.id;
    this.facilityMeshes.push({ mesh: floor, facilityId: facility.id });
    group.add(floor);

    const inset = new Mesh(
      new BoxGeometry(Math.max(0.2, width - 0.22), 0.025, Math.max(0.2, depth - 0.22)),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.16,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    inset.position.y = 0.085;
    group.add(inset);

    const edge = new LineSegments(
      new EdgesGeometry(floor.geometry),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.75 }),
    );
    edge.position.copy(floor.position);
    group.add(edge);

    this.addWalls(group, width, depth, color);
    this.addSupportColumns(group, width, depth, color);
    this.addFloorPanelLines(group, width, depth, color, 0.22);
    this.addDoorMarkers(group, width, depth, color);
    this.addEquipment(group, facility, color, width, depth);
    this.addCrew(group, facility, color, width, depth);

    const label = makeLabel(facility.label, color);
    label.position.set(0, 0.84, -depth * 0.3);
    group.add(label);
  }

  private buildExpansionPad(facility: BaseFacility): void {
    const color = facilityColor(facility.kind);
    const group = new Group();
    group.position.copy(this.roomCenter(facility));
    this.baseGroup.add(group);

    const width = facility.w * CELL - ROOM_GAP;
    const depth = facility.h * CELL - ROOM_GAP;
    const floor = new Mesh(
      new BoxGeometry(width, 0.06, depth),
      new MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.08,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    floor.position.y = 0.025;
    group.add(floor);

    const edge = new LineSegments(
      new EdgesGeometry(floor.geometry),
      new MeshBasicMaterial({ color, transparent: true, opacity: 0.24 }),
    );
    edge.position.copy(floor.position);
    group.add(edge);

    const marker = makeLabel("Expansion", color);
    marker.position.set(0, 0.32, 0);
    marker.scale.set(0.9, 0.24, 1);
    group.add(marker);
  }

  private addWalls(
    group: Group,
    width: number,
    depth: number,
    color: number,
    wallHeight = 0.62,
    thick = 0.05,
    opacity = 0.14,
  ): void {
    const wallMat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      side: DoubleSide,
      depthWrite: false,
    });
    const front = new Mesh(new BoxGeometry(width, wallHeight, thick), wallMat);
    const back = front.clone();
    front.position.set(0, wallHeight / 2, depth / 2);
    back.position.set(0, wallHeight / 2, -depth / 2);
    const left = new Mesh(new BoxGeometry(thick, wallHeight, depth), wallMat);
    const right = left.clone();
    left.position.set(-width / 2, wallHeight / 2, 0);
    right.position.set(width / 2, wallHeight / 2, 0);
    group.add(front, back, left, right);
  }

  private addSupportColumns(group: Group, width: number, depth: number, color: number): void {
    if (width < 1.6 || depth < 1.1) return;
    const mat = makeMaterial(0x0d1b27, color, 0.16);
    const xs = [-width / 2 + 0.18, width / 2 - 0.18];
    const zs = [-depth / 2 + 0.18, depth / 2 - 0.18];
    for (const x of xs) {
      for (const z of zs) {
        const column = new Mesh(new CylinderGeometry(0.035, 0.055, 0.68, 8), mat);
        column.position.set(x, 0.36, z);
        group.add(column);
      }
    }
  }

  private addFloorPanelLines(
    group: Group,
    width: number,
    depth: number,
    color: number,
    opacity: number,
  ): void {
    const mat = new MeshBasicMaterial({
      color,
      transparent: true,
      opacity,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    const inset = 0.18;
    const lineY = 0.105;
    if (width > 1.3) {
      const line = new Mesh(new BoxGeometry(width - inset, 0.012, 0.018), mat);
      line.position.y = lineY;
      group.add(line);
    }
    if (depth > 1.3) {
      const line = new Mesh(new BoxGeometry(0.018, 0.012, depth - inset), mat);
      line.position.y = lineY + 0.002;
      group.add(line);
    }
  }

  private addDoorMarkers(group: Group, width: number, depth: number, color: number): void {
    const mat = this.glowMaterial(color, 0.55);
    const doorW = 0.26;
    const doorH = 0.18;
    const markers = [
      { x: 0, z: depth / 2 + 0.026, sx: doorW, sz: 0.035 },
      { x: 0, z: -depth / 2 - 0.026, sx: doorW, sz: 0.035 },
      { x: width / 2 + 0.026, z: 0, sx: 0.035, sz: doorW },
      { x: -width / 2 - 0.026, z: 0, sx: 0.035, sz: doorW },
    ];
    for (const marker of markers) {
      const door = new Mesh(new BoxGeometry(marker.sx, doorH, marker.sz), mat);
      door.position.set(marker.x, 0.28, marker.z);
      group.add(door);
    }
  }

  private addEquipment(
    group: Group,
    facility: BaseFacility,
    color: number,
    width: number,
    depth: number,
  ): void {
    const mat = makeMaterial(0x27384a, color, 0.28);
    const accent = this.glowMaterial(color, 0.76);

    switch (facility.kind) {
      case "hangar": {
        const ring = new Mesh(new RingGeometry(0.42, 0.52, 48), accent);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.08;
        const craft = new Group();
        const body = new Mesh(new BoxGeometry(0.82, 0.16, 0.32), mat);
        body.position.y = 0.25;
        const wing = new Mesh(new BoxGeometry(1.15, 0.04, 0.12), mat);
        wing.position.y = 0.25;
        const nose = new Mesh(new ConeGeometry(0.16, 0.36, 18), mat);
        nose.rotation.z = -Math.PI / 2;
        nose.position.set(0.56, 0.25, 0);
        const tail = new Mesh(new BoxGeometry(0.12, 0.22, 0.42), mat);
        tail.position.set(-0.48, 0.29, 0);
        const gantry = new Mesh(new BoxGeometry(width * 0.82, 0.06, 0.06), accent);
        gantry.position.set(0, 0.58, -depth * 0.34);
        craft.add(body, wing, nose, tail);
        group.add(gantry);
        group.add(ring, craft);
        this.addRotator(ring, "z", 0.72);
        break;
      }
      case "command": {
        for (let i = 0; i < 5; i++) {
          const angle = (i / 5) * Math.PI * 2;
          const consoleMesh = new Mesh(new BoxGeometry(0.32, 0.18, 0.18), mat);
          consoleMesh.position.set(Math.cos(angle) * 0.42, 0.17, Math.sin(angle) * 0.42);
          consoleMesh.rotation.y = -angle;
          group.add(consoleMesh);
        }
        const table = new Mesh(new CylinderGeometry(0.26, 0.34, 0.16, 24), accent);
        table.position.y = 0.25;
        const hologram = new Mesh(new SphereGeometry(0.18, 24, 12), this.glowMaterial(0x67e8f9, 0.42));
        hologram.position.y = 0.54;
        group.add(table, hologram);
        this.addRotator(hologram, "y", 0.8);
        break;
      }
      case "lab": {
        for (let i = -1; i <= 1; i += 2) {
          const bench = new Mesh(new BoxGeometry(0.54, 0.18, 0.18), mat);
          bench.position.set(i * 0.38, 0.18, 0);
          group.add(bench);
          const tank = new Mesh(new CylinderGeometry(0.08, 0.08, 0.42, 18), accent);
          tank.position.set(i * 0.38, 0.47, 0);
          group.add(tank);
        }
        const scanner = new Mesh(new RingGeometry(0.18, 0.24, 32), accent);
        scanner.rotation.x = -Math.PI / 2;
        scanner.position.set(0, 0.4, depth * 0.18);
        group.add(scanner);
        this.addRotator(scanner, "z", 1.25);
        break;
      }
      case "medbay": {
        for (let i = -1; i <= 1; i += 2) {
          const pod = new Mesh(new BoxGeometry(0.28, 0.12, 0.58), mat);
          pod.position.set(i * 0.24, 0.17, 0.04);
          group.add(pod);
          const canopy = new Mesh(new BoxGeometry(0.22, 0.06, 0.36), accent);
          canopy.position.set(i * 0.24, 0.3, 0.02);
          group.add(canopy);
        }
        const scanner = new Mesh(new RingGeometry(0.2, 0.27, 32), accent);
        scanner.rotation.x = -Math.PI / 2;
        scanner.position.set(0, 0.48, -depth * 0.22);
        group.add(scanner);
        this.addRotator(scanner, "z", 0.9);
        break;
      }
      case "workshop": {
        for (let i = -1; i <= 1; i++) {
          const crate = new Mesh(new BoxGeometry(0.28, 0.22 + i * 0.02, 0.28), mat);
          crate.position.set(i * 0.32, 0.18, i % 2 === 0 ? 0.16 : -0.16);
          group.add(crate);
        }
        const crane = new Mesh(new BoxGeometry(width * 0.72, 0.05, 0.05), accent);
        crane.position.set(0, 0.54, -depth * 0.24);
        group.add(crane);
        break;
      }
      case "stores": {
        for (let row = -1; row <= 1; row += 2) {
          const rack = new Mesh(new BoxGeometry(width * 0.68, 0.34, 0.16), mat);
          rack.position.set(0, 0.26, row * depth * 0.22);
          group.add(rack);
          for (let i = -1; i <= 1; i++) {
            const crate = new Mesh(new BoxGeometry(0.2, 0.15, 0.14), makeMaterial(0x334155, color, 0.12));
            crate.position.set(i * 0.24, 0.52, row * depth * 0.22);
            group.add(crate);
          }
        }
        break;
      }
      case "power": {
        for (let i = -1; i <= 1; i += 2) {
          const core = new Mesh(new CylinderGeometry(0.14, 0.18, 0.58, 24), accent);
          core.position.set(i * 0.3, 0.36, 0);
          group.add(core);
        }
        const reactorRing = new Mesh(new RingGeometry(0.45, 0.55, 42), accent);
        reactorRing.rotation.x = -Math.PI / 2;
        reactorRing.position.y = 0.13;
        group.add(reactorRing);
        this.addRotator(reactorRing, "z", 0.64);
        break;
      }
      case "radar": {
        const mast = new Mesh(new CylinderGeometry(0.04, 0.06, 0.56, 12), mat);
        mast.position.y = 0.34;
        const dish = new Mesh(new ConeGeometry(0.28, 0.22, 32, 1, true), accent);
        dish.position.y = 0.72;
        dish.rotation.x = Math.PI * 0.38;
        group.add(mast, dish);
        this.addRotator(dish, "y", 0.72);
        break;
      }
      case "access": {
        const shaft = new Mesh(new CylinderGeometry(0.28, 0.28, 0.5, 6), mat);
        shaft.position.y = 0.31;
        const cap = new Mesh(new RingGeometry(0.24, 0.36, 6), accent);
        cap.rotation.x = -Math.PI / 2;
        cap.position.y = 0.58;
        const lift = new Mesh(new BoxGeometry(0.34, 0.1, 0.34), accent);
        lift.position.y = 0.18;
        group.add(shaft, cap, lift);
        break;
      }
      case "living": {
        const bunks = Math.max(2, Math.floor(width / 0.48));
        for (let i = 0; i < bunks; i++) {
          const bunk = new Mesh(new BoxGeometry(0.32, 0.14, 0.5), mat);
          bunk.position.set(-width / 2 + 0.32 + i * 0.46, 0.15, depth * 0.05);
          group.add(bunk);
        }
        const mess = new Mesh(new BoxGeometry(0.42, 0.12, 0.32), accent);
        mess.position.set(width * 0.25, 0.21, -depth * 0.24);
        group.add(mess);
        break;
      }
      default: {
        break;
      }
    }
  }

  private addCrew(
    group: Group,
    facility: BaseFacility,
    color: number,
    width: number,
    depth: number,
  ): void {
    const count =
      facility.kind === "access" || facility.kind === "radar"
        ? 1
        : facility.kind === "hangar" || facility.kind === "command"
          ? 3
          : 2;
    const positions = [
      [-0.28, -0.18],
      [0.28, 0.16],
      [-0.08, 0.28],
      [0.12, -0.3],
    ] as const;

    for (let i = 0; i < count; i++) {
      const [ox, oz] = positions[i % positions.length]!;
      const person = this.makeCrewFigure(color);
      person.position.set(
        Math.max(-width / 2 + 0.24, Math.min(width / 2 - 0.24, ox * width)),
        0,
        Math.max(-depth / 2 + 0.24, Math.min(depth / 2 - 0.24, oz * depth)),
      );
      person.rotation.y = (i / count) * Math.PI * 0.8;
      group.add(person);
    }
  }

  private addOverheadSystems(): void {
    const pipeMat = makeMaterial(0x0b1b28, 0x67e8f9, 0.22);
    const glow = this.glowMaterial(0x67e8f9, 0.32);
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
      const light = new Mesh(new BoxGeometry(item.sx * 0.86, 0.018, item.sz * 0.86), glow);
      light.position.set(center.x, 0.785, center.z);
      this.baseGroup.add(tray, light);
    }
  }

  private addInteriorTraffic(): void {
    this.addWalker(
      [
        this.pathPoint(1, 1),
        this.pathPoint(2, 1),
        this.pathPoint(3, 2),
        this.pathPoint(4, 2),
        this.pathPoint(5, 2),
        this.pathPoint(5, 3),
        this.pathPoint(4, 3),
        this.pathPoint(3, 3),
        this.pathPoint(2, 3),
      ],
      0x67e8f9,
      0.46,
      0,
    );
    this.addWalker(
      [
        this.pathPoint(3, 0),
        this.pathPoint(3, 1),
        this.pathPoint(4, 1),
        this.pathPoint(4, 2),
        this.pathPoint(4, 3),
        this.pathPoint(5, 3),
      ],
      0xfbbf24,
      0.36,
      2.4,
    );
    this.addWalker(
      [
        this.pathPoint(5, 0),
        this.pathPoint(4, 1),
        this.pathPoint(3, 2),
        this.pathPoint(2, 3),
        this.pathPoint(1, 3),
      ],
      0x4ade80,
      0.3,
      4.2,
    );
  }

  private addWalker(path: Vector3[], color: number, speed: number, offset: number): void {
    if (path.length < 2) return;
    const actor = this.makeCrewFigure(color, 1.08);
    actor.position.copy(path[0]!);
    this.baseGroup.add(actor);

    const segmentLengths: number[] = [];
    let totalLength = 0;
    for (let i = 0; i < path.length; i++) {
      const current = path[i]!;
      const next = path[(i + 1) % path.length]!;
      const length = current.distanceTo(next);
      segmentLengths.push(length);
      totalLength += length;
    }
    this.walkers.push({ actor, path, segmentLengths, totalLength, speed, offset });
  }

  private updateRotators(elapsed: number): void {
    for (const item of this.rotators) {
      const value = item.baseRotation + elapsed * item.speed;
      if (item.axis === "x") item.object.rotation.x = value;
      else if (item.axis === "y") item.object.rotation.y = value;
      else item.object.rotation.z = value;
    }
  }

  private updateWalkers(elapsed: number): void {
    for (const walker of this.walkers) {
      if (walker.totalLength <= 0) continue;
      let distance = (elapsed * walker.speed + walker.offset) % walker.totalLength;
      for (let i = 0; i < walker.path.length; i++) {
        const length = walker.segmentLengths[i]!;
        if (distance > length) {
          distance -= length;
          continue;
        }
        const from = walker.path[i]!;
        const to = walker.path[(i + 1) % walker.path.length]!;
        const alpha = length > 0 ? distance / length : 0;
        walker.actor.position.lerpVectors(from, to, alpha);
        walker.actor.position.y = 0.08 + Math.sin(elapsed * 9 + walker.offset) * 0.018;
        walker.actor.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
        break;
      }
    }
  }

  private addPerimeterShafts(): void {
    const width = STARTER_BASE_GRID.width * CELL;
    const depth = STARTER_BASE_GRID.height * CELL;
    const mat = makeMaterial(0x0b1b28, 0x67e8f9, 0.18);
    const glow = this.glowMaterial(0x67e8f9, 0.36);
    const positions = [
      [-width / 2 - 0.28, -depth / 2 - 0.18],
      [width / 2 + 0.28, depth / 2 + 0.18],
    ] as const;
    for (const [x, z] of positions) {
      const shaft = new Mesh(new CylinderGeometry(0.12, 0.16, 1.35, 10), mat);
      shaft.position.set(x, 0.42, z);
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
    topbar.append(brand, chips);

    const sidebar = el("aside", "base-sidebar");
    const primaryHost = el("div");
    const objectiveHost = el("div");
    const roomHost = el("div", "facility-room");
    sidebar.append(primaryHost, objectiveHost, roomHost);

    const footer = el("div", "base-footer");
    const earth = el("button");
    earth.textContent = "Earth";
    earth.addEventListener("click", () => this.opts.onOpenGeoscape());
    const reset = el("button");
    reset.textContent = "New campaign";
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

    this.root.append(topbar, sidebar, footer, tooltip, notice);
    this.refreshHud();
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
      this.topChip("$", "Credits", `${campaign.resources.credits}`),
      this.topChip("⬢", "Alloys", `${campaign.resources.alloys}`),
      this.topChip("✦", "Elerium", `${campaign.resources.elerium}`),
      this.topChip("◈", "Alien Data", `${campaign.resources.alienData}`),
      this.topChip("⚗", "Scientists", `${scientists}`),
      this.topChip("⚙", "Engineers", `${engineers}`),
      this.topChip("▲", "Threat", `${threat}%`, threatCls),
      this.topChip("◆", "Difficulty", difficultyConfig(campaign).label),
    );
  }

  /** Compact top-bar chip: icon + value with a hover tooltip carrying the full
   *  label, so the threat color class is never the sole signal. */
  private topChip(icon: string, label: string, value: string, cls?: string): HTMLSpanElement {
    const node = el("span", `top-chip${cls ? ` ${cls}` : ""}`);
    node.title = `${label}: ${value}`;
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
      const eyebrow = el("div", "op-eyebrow");
      eyebrow.textContent = "Operation ready";
      const title = el("div", "op-title");
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
      const launch = el("button", "primary");
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

    const eyebrow = el("div", "op-eyebrow");
    eyebrow.textContent = "No active contact";
    const title = el("div", "op-title");
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
    const intercept = el("button");
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
    room.append(this.renderRoomHeader(meta, this.activeRoom !== "overview"));
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
      back.addEventListener("click", () => {
        this.activeRoom = "overview";
        this.refreshHud();
      });
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

  /** Hangar room: interceptor status (integrity + sorties/repair) followed by the
   *  council equipment market. The market keeps its `.market-card` container with
   *  Buy buttons so smoke/screen readers can always locate it here. */
  private renderHangarRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");
    const status = el("section", "tab-card");
    const strong = el("strong");
    strong.textContent = "Interceptor";
    const integrity = Math.max(0, 100 - campaign.interceptor.damage);
    const repairedAt = campaign.interceptor.repairedAtHour;
    const repairing = repairedAt !== undefined && repairedAt > campaign.clock.elapsedHours;
    const copy = el("p", "card-copy");
    copy.textContent = repairing
      ? `Integrity ${integrity}% — repairs underway (${repairedAt! - campaign.clock.elapsedHours}h remaining).`
      : `Integrity ${integrity}% — ${campaign.interceptor.sorties} sorties flown. Ready to intercept.`;
    status.append(strong, copy);
    wrap.append(status, this.buildMarketPanel());
    return wrap;
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
    return wrap;
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

    const nameEl = el("span", "s-name");
    nameEl.textContent = soldier.name;
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

    row.append(deployToggle, nameEl, rankEl, this.renderSoldierStatus(campaign, soldier), weaponSelect);
    if (this.expandedSoldierId === soldier.id) {
      const detail = el("div", "soldier-detail");
      detail.textContent =
        `${soldier.missions} missions · ${soldier.survivedMissions} survived · rank ${soldier.rank}` +
        (soldier.status === "wounded" ? " · wounded" : "") + ".";
      row.appendChild(detail);
    }
    row.addEventListener("click", () => {
      this.expandedSoldierId = this.expandedSoldierId === soldier.id ? null : soldier.id;
      this.refreshHud();
    });
    return row;
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
      row.addEventListener("click", () => this.selectFacility(facility.id));
      installed.appendChild(row);
    }

    wrap.append(capLabel, chips, label, installed, this.renderConstructionList(campaign));
    return wrap;
  }

  /** Selecting an installed facility (from the Construction room list) opens that
   *  facility's dedicated room and lifts its emissive so the 3D cutaway mirrors
   *  the selection. Mirrors the on-canvas facility click. */
  private selectFacility(facilityId: string): void {
    const facility = findBaseFacility(facilityId);
    this.selectedFacilityId = facilityId;
    this.activeRoom = facility ? roomForFacilityKind(facility.kind) : "overview";
    this.applyFacilityHighlight();
    this.refreshHud();
  }

  /** Research room: completed work as chips, the active project with a progress
   *  bar + remaining hours, then available projects (cost + Start). */
  private renderResearchRoom(campaign: CampaignState): HTMLElement {
    const wrap = el("div");

    if (campaign.completedResearch.length > 0) {
      const chipRow = el("div", "chip-row");
      for (const id of campaign.completedResearch) {
        const project = RESEARCH_PROJECTS.find((candidate) => candidate.id === id);
        const chip = el("span", "done-chip");
        chip.textContent = project?.title ?? id;
        chipRow.appendChild(chip);
      }
      wrap.appendChild(chipRow);
    }

    const activeRes = campaign.activeResearch;
    if (activeRes) {
      const project = RESEARCH_PROJECTS.find((candidate) => candidate.id === activeRes.projectId);
      const remaining = Math.max(0, activeRes.completesAtHour - campaign.clock.elapsedHours);
      const duration = activeRes.completesAtHour - activeRes.startedAtHour;
      const fraction =
        duration > 0
          ? Math.min(1, Math.max(0, (campaign.clock.elapsedHours - activeRes.startedAtHour) / duration))
          : 0;
      const card = el("section", "tab-card");
      const strong = el("strong");
      strong.textContent = `${project?.title ?? activeRes.projectId} in progress`;
      const bar = el("div", "progress");
      const fill = el("i");
      fill.style.width = `${Math.round(fraction * 100)}%`;
      bar.appendChild(fill);
      const copy = el("p", "card-copy");
      copy.textContent = `${remaining}h remaining — scientists are working.`;
      card.append(strong, bar, copy);
      wrap.appendChild(card);
    }

    const available = RESEARCH_PROJECTS.filter(
      (project) => !hasResearch(campaign, project.id) && project.id !== activeRes?.projectId,
    );
    if (available.length > 0) {
      const label = el("div", "section-label");
      label.textContent = "Available projects";
      wrap.appendChild(label);
      for (const project of available) {
        wrap.appendChild(this.renderResearchCard(campaign, project, !!activeRes));
      }
    } else if (!activeRes) {
      const empty = el("div", "empty-state");
      empty.textContent = "All research projects complete.";
      wrap.appendChild(empty);
    }
    return wrap;
  }

  private renderResearchCard(
    campaign: CampaignState,
    project: ResearchProject,
    labBusy: boolean,
  ): HTMLElement {
    const card = el("section", "tab-card");
    const canResearch = canStartResearch(campaign, project.id);
    const cost = researchCost(campaign, project.id);
    const title = el("strong");
    title.textContent = project.title;
    const copy = el("p", "card-copy");
    copy.textContent =
      `${project.description} Requires ${cost.alienData} data, ${cost.alloys} alloys, ` +
      `${cost.elerium} elerium, ${cost.credits}c · ${researchDuration(campaign, project.id)}h.`;
    const row = el("div", "card-row");
    const costLabel = el("span", "card-cost");
    costLabel.textContent = formatCost(cost);
    const button = el("button");
    button.textContent = labBusy ? "Lab busy" : canResearch ? "Start research" : "Need resources";
    button.disabled = labBusy || !canResearch;
    button.addEventListener("click", () => this.opts.onStartResearch(project.id));
    row.append(costLabel, button);
    card.append(title, copy, row);
    return card;
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
    if (this.disposed || this.facilityMeshes.length === 0) return;
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
   *  stays highlighted, and re-render the detail panel. Facilities without their
   *  own screen fall back to the overview hub. */
  private onCanvasClick = (event: MouseEvent): void => {
    if (this.disposed || this.facilityMeshes.length === 0) return;
    const hit = this.facilityMeshAt(event);
    if (!hit) return;
    this.selectedFacilityId = hit.facilityId;
    const facility = findBaseFacility(hit.facilityId);
    this.activeRoom = facility ? roomForFacilityKind(facility.kind) : "overview";
    this.applyFacilityHighlight();
    this.refreshHud();
  };

  /** Boost the emissive of the selected/hovered facility floor so the 3D cutaway
   *  stays in sync with the open room. */
  private applyFacilityHighlight(): void {
    const active = this.selectedFacilityId ?? this.hoveredFacilityId;
    for (const entry of this.facilityMeshes) {
      const mat = entry.mesh.material;
      if (mat instanceof MeshStandardMaterial) {
        mat.emissiveIntensity = entry.facilityId === active ? 0.55 : 0.12;
      }
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
    const elapsed = performance.now() * 0.001;
    this.baseGroup.rotation.y = BASE_VIEW_YAW + Math.sin(elapsed * 0.16) * 0.028;
    const pulse = 0.82 + Math.sin(elapsed * 3) * 0.18;
    for (const item of this.pulseMaterials) item.material.opacity = item.opacity * pulse;
    this.updateRotators(elapsed);
    this.updateWalkers(elapsed);
    this.renderer.render(this.scene, this.camera);
  };
}
