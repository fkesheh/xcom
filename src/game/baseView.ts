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
  RingGeometry,
  Scene,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  type Material,
  type Texture,
  Vector3,
  WebGLRenderer,
} from "three";

import {
  findBaseFacility,
  facilityCost,
  STARTER_BASE_GRID,
  type BaseFacility,
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
  highestRegionalPanic,
  RECRUIT_COST,
  MANUFACTURING_PROJECTS,
  MARKET_CONFIG,
  RESEARCH_PROJECTS,
  canStartManufacturing,
  manufacturingCost,
  manufacturingDuration,
  researchDuration,
  researchCost,
  soldierWeaponId,
} from "../campaign/storage";
import type {
  CampaignState,
  CampaignWeaponId,
  ManufacturingProjectId,
  OperationPlan,
  ResearchId,
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
    radial-gradient(circle at 54% 40%, rgba(22,60,76,.55), transparent 36%),
    linear-gradient(160deg, #02070d, #07131d 54%, #010308);
  font: 12px/1.4 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .02em;
}
#base-view::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  pointer-events: none;
  background:
    linear-gradient(90deg, rgba(103,232,249,.035) 1px, transparent 1px),
    linear-gradient(rgba(103,232,249,.03) 1px, transparent 1px),
    radial-gradient(circle at 50% 48%, transparent 44%, rgba(0,0,0,.58) 100%);
  background-size: 38px 38px, 38px 38px, auto;
  mix-blend-mode: screen;
}
#base-view canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
#base-view .base-canvas {
  position: absolute;
  inset: 0;
}
#base-view .base-panel {
  position: absolute;
  z-index: 4;
  width: min(390px, calc(100vw - 28px));
  padding: 16px;
  overflow: hidden;
  border: 1px solid rgba(103,232,249,.28);
  border-radius: 10px;
  background:
    linear-gradient(145deg, rgba(13,31,43,.93), rgba(4,10,16,.94) 62%),
    rgba(4,10,16,.94);
  box-shadow: 0 24px 80px rgba(0,0,0,.42), inset 0 1px rgba(255,255,255,.035);
  backdrop-filter: blur(10px);
}
#base-view .base-panel::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 38%;
  height: 2px;
  background: linear-gradient(90deg, #67e8f9, transparent);
}
#base-view .base-left {
  top: max(18px, env(safe-area-inset-top));
  left: max(18px, env(safe-area-inset-left));
}
#base-view .base-right {
  right: max(18px, env(safe-area-inset-right));
  bottom: max(18px, env(safe-area-inset-bottom));
  max-height: calc(100vh - 36px);
  overflow: auto;
}
#base-view .eyebrow {
  color: #67e8f9;
  font: 800 9px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .2em;
  text-transform: uppercase;
}
#base-view h1 {
  margin: 7px 0 10px;
  font-size: clamp(34px, 5vw, 58px);
  line-height: .88;
  letter-spacing: .04em;
  text-transform: uppercase;
}
#base-view h2 {
  margin: 7px 0 8px;
  font-size: 21px;
  line-height: 1;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view p {
  margin: 0;
  color: #9db5c5;
}
#base-view .base-coords {
  margin-top: 11px;
  color: #fbbf24;
  font: 850 13px/1.3 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .base-stats {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 7px;
  margin-top: 15px;
}
#base-view .base-stat {
  padding: 9px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 7px;
  background: rgba(0,0,0,.16);
}
#base-view .base-stat span {
  display: block;
  color: #7190a4;
  font: 750 8px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#base-view .base-stat b {
  display: block;
  margin-top: 5px;
  color: #e8fbff;
  font: 800 12px/1 ui-monospace, monospace;
}
#base-view .facility-list {
  display: grid;
  gap: 7px;
  max-height: min(360px, 45vh);
  margin: 13px 0;
  overflow: auto;
  padding-right: 3px;
}
#base-view .facility {
  padding: 10px;
  border: 1px solid rgba(103,232,249,.16);
  border-radius: 8px;
  background: rgba(2,12,20,.48);
}
#base-view .facility strong {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #f1fbff;
  font: 850 11px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .facility em {
  color: #4ade80;
  font-style: normal;
}
#base-view .facility p {
  margin-top: 6px;
  font-size: 10px;
}
#base-view .expansion-list {
  display: grid;
  gap: 8px;
  margin: 13px 0;
}
#base-view .expansion-card {
  padding: 11px;
  border: 1px solid rgba(251,191,36,.24);
  border-radius: 8px;
  background: rgba(35,24,4,.18);
}
#base-view .expansion-card strong {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #fef3c7;
  font: 850 11px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .expansion-card em {
  color: #fbbf24;
  font-style: normal;
}
#base-view .expansion-card p {
  margin-top: 7px;
  color: #b9c7d2;
  font-size: 10px;
}
#base-view .expansion-card button {
  width: 100%;
  margin-top: 9px;
}
#base-view .expansion-card.blocked {
  border-color: rgba(148,163,184,.18);
  background: rgba(2,12,20,.34);
}
#base-view .expansion-card.active {
  border-color: rgba(103,232,249,.38);
  background: rgba(8,35,47,.36);
}
#base-view .base-report {
  margin: 13px 0;
  padding: 12px;
  border: 1px solid rgba(251,191,36,.24);
  border-radius: 8px;
  background: rgba(35,24,4,.22);
}
#base-view .strategic-card {
  margin-top: 13px;
  padding: 12px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.48);
}
#base-view .strategic-card strong {
  display: block;
  color: #e8fbff;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .strategic-card p {
  margin-top: 7px;
  color: #adc5d2;
  font-size: 10px;
}
#base-view .strategic-card.won {
  border-color: rgba(74,222,128,.35);
  background: rgba(10,35,22,.35);
}
#base-view .strategic-card.lost {
  border-color: rgba(251,113,133,.42);
  background: rgba(45,11,18,.36);
}
#base-view .operation-card {
  margin: 13px 0;
  padding: 12px;
  border: 1px solid rgba(103,232,249,.24);
  border-radius: 8px;
  background: rgba(2,12,20,.58);
}
#base-view .operation-card strong {
  display: block;
  color: #67e8f9;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .operation-card p {
  margin-top: 7px;
  color: #adc5d2;
  font-size: 10px;
}
#base-view .operation-meta {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 6px;
  margin-top: 9px;
}
#base-view .operation-meta span {
  padding: 6px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 6px;
  color: #e8fbff;
  background: rgba(0,0,0,.15);
  font: 800 9px/1.1 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .research-card,
#base-view .manufacturing-card {
  margin: 13px 0;
  padding: 12px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.48);
}
#base-view .roster-card {
  margin: 13px 0;
  padding: 12px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.48);
}
#base-view .roster-head {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  color: #e8fbff;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .roster-list {
  display: grid;
  gap: 6px;
  margin-top: 9px;
}
#base-view .soldier-row {
  display: grid;
  grid-template-columns: auto minmax(78px, 1fr) auto auto auto minmax(102px, .8fr);
  gap: 8px;
  align-items: center;
  padding: 7px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 6px;
  color: #e8fbff;
  background: rgba(0,0,0,.16);
  font: 800 9px/1.1 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .soldier-row.kia {
  color: #fb7185;
  opacity: .72;
}
#base-view .soldier-row.wounded {
  color: #fbbf24;
}
#base-view .deploy-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  color: #67e8f9;
  font: 850 8px/1 ui-monospace, monospace;
}
#base-view .deploy-toggle input {
  width: 13px;
  height: 13px;
  accent-color: #67e8f9;
}
#base-view .deploy-toggle:has(input:disabled) {
  color: #64748b;
  opacity: .65;
}
#base-view .soldier-row span:nth-last-child(2) {
  color: #8aa7b8;
}
#base-view .soldier-row select {
  min-width: 98px;
  color: #e8fbff;
  border: 1px solid rgba(103,232,249,.22);
  border-radius: 6px;
  background: rgba(1,9,15,.85);
  font: 800 9px/1 ui-monospace, monospace;
  letter-spacing: .05em;
  text-transform: uppercase;
}
#base-view .soldier-row select:disabled {
  opacity: .45;
}
#base-view .roster-card button {
  width: 100%;
  margin-top: 10px;
}
#base-view .research-card strong,
#base-view .manufacturing-card strong {
  display: block;
  color: #e8fbff;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .research-card p,
#base-view .manufacturing-card p {
  margin-top: 7px;
  color: #adc5d2;
  font-size: 10px;
}
#base-view .research-card button,
#base-view .manufacturing-card button {
  width: 100%;
  margin-top: 10px;
}
#base-view .base-report strong {
  display: block;
  color: #fbbf24;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .base-report p {
  margin-top: 7px;
  color: #adc5d2;
  font-size: 10px;
}
#base-view .base-actions {
  display: flex;
  gap: 8px;
}
#base-view button {
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
#base-view button.primary {
  flex: 1;
  border-color: rgba(103,232,249,.78);
  background: linear-gradient(180deg, rgba(17,94,117,.98), rgba(8,49,65,.98));
}
#base-view button:hover {
  border-color: rgba(103,232,249,.9);
  background: linear-gradient(180deg, rgba(38,76,92,.98), rgba(11,39,52,.98));
}
#base-view button:disabled {
  cursor: default;
  opacity: .42;
}
#base-view .base-hint {
  position: absolute;
  left: 50%;
  bottom: max(22px, env(safe-area-inset-bottom));
  z-index: 3;
  width: min(600px, calc(100vw - 36px));
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
#base-view .difficulty-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 8px;
  padding: 4px 10px;
  border: 1px solid rgba(251,191,36,.42);
  border-radius: 999px;
  color: #fbbf24;
  background: rgba(35,24,4,.32);
  font: 800 9px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#base-view .difficulty-chip::before {
  content: "◆";
  color: #fbbf24;
}
#base-view .mission-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 9px 0 0;
  padding: 4px 10px;
  border: 1px solid rgba(103,232,249,.4);
  border-radius: 999px;
  color: #e8fbff;
  background: rgba(8,35,47,.5);
  font: 800 9px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#base-view .mission-chip .mission-icon {
  color: #67e8f9;
  font-size: 11px;
}
#base-view .mission-chip.crashSite { border-color: rgba(103,232,249,.4); }
#base-view .mission-chip.terror { border-color: rgba(251,113,133,.55); color: #fecaca; }
#base-view .mission-chip.terror .mission-icon { color: #fb7185; }
#base-view .mission-chip.landedUfo { border-color: rgba(167,139,250,.5); color: #ddd6fe; }
#base-view .mission-chip.landedUfo .mission-icon { color: #a78bfa; }
#base-view .mission-chip.baseDefense { border-color: rgba(251,191,36,.55); color: #fde68a; }
#base-view .mission-chip.baseDefense .mission-icon { color: #fbbf24; }
#base-view .operation-objective {
  margin-top: 7px;
  color: #fbbf24;
  font: 800 9px/1.3 ui-monospace, monospace;
  letter-spacing: .06em;
  text-transform: uppercase;
}
#base-view .market-card {
  margin: 13px 0;
  padding: 12px;
  border: 1px solid rgba(103,232,249,.18);
  border-radius: 8px;
  background: rgba(2,12,20,.48);
}
#base-view .market-card > strong {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  color: #e8fbff;
  font: 850 12px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-card .market-credits {
  color: #fbbf24;
}
#base-view .market-card > p {
  margin-top: 7px;
  color: #adc5d2;
  font-size: 10px;
}
#base-view .market-list {
  display: grid;
  gap: 7px;
  margin-top: 10px;
}
#base-view .market-item {
  display: grid;
  grid-template-columns: minmax(92px, 1fr) auto auto auto;
  gap: 8px;
  align-items: center;
  padding: 8px;
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 6px;
  background: rgba(0,0,0,.16);
  color: #e8fbff;
  font: 800 9px/1.1 ui-monospace, monospace;
  text-transform: uppercase;
}
#base-view .market-item .market-price { color: #fbbf24; }
#base-view .market-item .market-stock { color: #8aa7b8; }
#base-view .market-item button {
  min-height: 32px;
  padding: 0 10px;
}
#base-view .market-item button[aria-disabled="true"] {
  cursor: not-allowed;
  opacity: .5;
  border-color: rgba(148,163,184,.3);
}
#base-view .empty-state {
  margin-top: 9px;
  padding: 10px;
  border: 1px dashed rgba(148,163,184,.28);
  border-radius: 7px;
  color: #8aa7b8;
  background: rgba(2,12,20,.3);
  text-align: center;
  font: 800 9px/1.4 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#base-view .notice-toast {
  position: absolute;
  top: max(18px, env(safe-area-inset-top));
  left: 50%;
  z-index: 6;
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
  font: 800 10px/1.3 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#base-view .notice-toast.visible {
  opacity: 1;
  transform: translate(-50%, 0);
}
#base-view .notice-toast[data-kind="warning"] {
  border-color: rgba(251,113,133,.55);
  color: #fecaca;
  background: rgba(45,11,18,.92);
}
@media (max-width: 900px) {
  #base-view .base-panel { width: calc(100vw - 24px); padding: 13px; }
  #base-view .base-left { left: 12px; right: 12px; }
  #base-view .base-right { left: 12px; right: 12px; bottom: 12px; }
  #base-view h1 { font-size: 30px; }
  #base-view .base-stats { grid-template-columns: 1fr; }
  #base-view .base-hint { display: none; }
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

function fmtCoord(value: number, pos: string, neg: string): string {
  const dir = value >= 0 ? pos : neg;
  return `${Math.abs(value).toFixed(1)}°${dir}`;
}

function strategicSummary(campaign: CampaignState): string {
  if (campaign.strategic.status === "won") return "Campaign won. The invasion cell has been broken.";
  if (campaign.strategic.status === "lost") {
    if (activeSoldiers(campaign).length === 0 && !canRecruitSoldier(campaign)) {
      return "Campaign lost. No active operatives remain and recruitment reserves are exhausted.";
    }
    return "Campaign lost. Threat saturation has exceeded command capacity.";
  }
  return "Campaign active. Keep threat low and funding stable while recovering alien material.";
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

function formatNet(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
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

  constructor(private readonly opts: BaseViewOptions) {
    injectStyle();
    this.root = el("div");
    this.root.id = "base-view";
    this.canvasWrap = el("div", "base-canvas");
    this.root.appendChild(this.canvasWrap);

    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));

    this.camera.position.set(-0.35, 7.2, 8.4);
    this.camera.lookAt(-0.4, 0.05, 0.05);

    this.buildScene();
    this.buildHud();
  }

  mount(container: HTMLElement): void {
    container.replaceChildren(this.root);
    this.canvasWrap.appendChild(this.renderer.domElement);
    window.addEventListener("resize", this.resize);
    this.resize();
    this.frame();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    if (this.noticeTimer !== null) clearTimeout(this.noticeTimer);
    window.removeEventListener("resize", this.resize);
    disposeObject(this.scene);
    this.renderer.dispose();
    this.root.remove();
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

    this.baseGroup.position.set(-0.28, -0.12, 0.12);
    this.baseGroup.rotation.y = BASE_VIEW_YAW;
    this.baseGroup.scale.setScalar(0.95);
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

  private buildHud(): void {
    const facilities = constructedFacilities(this.opts.campaign);
    const expansions = availableBaseFacilities(this.opts.campaign);
    const summary = summarizeBaseFacilities(facilities);
    const activeRoster = activeSoldiers(this.opts.campaign);
    const deployment = deploymentSoldiers(this.opts.campaign);
    const deployedIds = new Set(deployment.map((soldier) => soldier.id));
    const panic = highestRegionalPanic(this.opts.campaign);
    const objective = campaignObjectiveProgress(this.opts.campaign);
    const contact = this.opts.campaign.ufoContact;
    // Ground assaults (terror, landed UFO, base defense) spawn already on the ground
    // ("landed"); only crash-site contacts are "tracked" until shot down. Both
    // "crashed" and "landed" are terminal, launchable states — match the controller.
    const launchable = contact?.status === "crashed" || contact?.status === "landed";
    const launchContact = launchable ? contact : undefined;
    const canLaunch =
      this.opts.campaign.strategic.status === "active" && deployment.length > 0 && !!launchContact;
    const left = el("section", "base-panel base-left");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Blacksite command";
    const title = el("h1");
    title.textContent =
      this.opts.campaign.strategic.status === "won"
        ? "Campaign Won"
        : this.opts.campaign.strategic.status === "lost"
          ? "Campaign Lost"
          : "Base Interior";
    const copy = el("p");
    const nextMission = this.opts.operation.missionNumber;
    copy.textContent = launchContact
      ? `Command center is online. Review facilities, then launch Operation ${this.opts.operation.codename}.`
      : contact
        ? "Command center is online. Launch an interceptor from Earth Command before committing ground troops."
        : "Command center is online. Use Earth Command to scan for UFO contacts before launching a recovery team.";
    const coords = el("div", "base-coords");
    coords.textContent =
      `${this.opts.campaign.base.region}  /  ${fmtCoord(this.opts.campaign.base.lat, "N", "S")} ` +
      `${fmtCoord(this.opts.campaign.base.lon, "E", "W")}`;
    const stats = el("div", "base-stats");
    stats.append(
      this.stat("Credits", `${this.opts.campaign.resources.credits}`),
      this.stat("Alloys", `${this.opts.campaign.resources.alloys}`),
      this.stat("Elerium", `${this.opts.campaign.resources.elerium}`),
      this.stat("Data", `${this.opts.campaign.resources.alienData}`),
      this.stat("Cores", `${objective.completed}/${objective.required}`),
      this.stat("Squad", `${deployment.length}/${DEPLOYMENT_SIZE}`),
      this.stat(
        "Craft",
        this.opts.campaign.interceptor.repairedAtHour &&
          this.opts.campaign.interceptor.repairedAtHour > this.opts.campaign.clock.elapsedHours
          ? `Repair ${this.opts.campaign.interceptor.repairedAtHour - this.opts.campaign.clock.elapsedHours}h`
          : "Ready",
      ),
      this.stat("Power", `${summary.powerUsed}/${summary.powerCapacity}`),
    );
    const strategic = el("section", `strategic-card ${this.opts.campaign.strategic.status}`);
    const strategicTitle = el("strong");
    strategicTitle.textContent =
      `${this.opts.campaign.strategic.status} / Threat ${this.opts.campaign.strategic.threat}%`;
    const difficultyChip = el("div", "difficulty-chip");
    difficultyChip.textContent = `Difficulty / ${difficultyConfig(this.opts.campaign).label}`;
    const strategicCopy = el("p");
    strategicCopy.textContent =
      `${strategicSummary(this.opts.campaign)} ` +
      `Funding ${this.opts.campaign.strategic.funding}, score ${this.opts.campaign.strategic.score}.` +
      ` ${objective.summary}` +
      ` Council panic peaks in ${panic.region} at ${panic.panic}%.` +
      (this.opts.campaign.lastFundingReport
        ? ` Last report net ${formatNet(this.opts.campaign.lastFundingReport.net)}c.`
        : "");
    strategic.append(strategicTitle, difficultyChip, strategicCopy);
    left.append(eyebrow, title, copy, coords, stats, strategic);
    this.root.appendChild(left);

    const right = el("section", "base-panel base-right");
    const siteEye = el("div", "eyebrow");
    siteEye.textContent = "Starter installation";
    const heading = el("h2");
    heading.textContent = "Facilities";
    const list = el("div", "facility-list");
    for (const facility of facilities) {
      const item = el("article", "facility");
      const head = el("strong");
      head.append(document.createTextNode(facility.label), Object.assign(el("em"), { textContent: "ONLINE" }));
      const detail = el("p");
      detail.textContent = `${facility.description} ${facility.effect}`;
      item.append(head, detail);
      list.appendChild(item);
    }
    const expansionList = el("div", "expansion-list");
    const activeConstruction = this.opts.campaign.activeConstruction;
    const constructionFacility = activeConstruction ? findBaseFacility(activeConstruction.facilityId) : undefined;
    if (activeConstruction && constructionFacility) {
      const remaining = Math.max(0, activeConstruction.completesAtHour - this.opts.campaign.clock.elapsedHours);
      const item = el("article", "expansion-card active");
      const head = el("strong");
      head.append(
        document.createTextNode(constructionFacility.label),
        Object.assign(el("em"), { textContent: `${remaining}h` }),
      );
      const detail = el("p");
      detail.textContent =
        `${constructionFacility.description} Construction crews are installing this facility. ` +
        "Advance time from Earth Command to bring it online.";
      const button = el("button");
      button.textContent = "Under construction";
      button.disabled = true;
      item.append(head, detail, button);
      expansionList.appendChild(item);
    }
    for (const facility of expansions) {
      const canBuild = canBuildFacility(this.opts.campaign, facility.id);
      const item = el("article", `expansion-card ${canBuild ? "" : "blocked"}`.trim());
      const cost = facilityCost(facility);
      const head = el("strong");
      head.append(document.createTextNode(facility.label), Object.assign(el("em"), { textContent: formatCost(cost) }));
      const detail = el("p");
      detail.textContent =
        `${facility.description} ${facility.effect} ` +
        `Power ${facility.powerUse > 0 ? `+${facility.powerUse} use` : `+${facility.powerOutput} capacity`}. ` +
        `Build ${facilityConstructionDuration(this.opts.campaign, facility.id)}h.`;
      const button = el("button");
      button.textContent = canBuild
        ? "Start construction"
        : activeConstruction
          ? "Construction busy"
          : "Need resources or power";
      button.disabled = !canBuild;
      button.addEventListener("click", () => this.opts.onBuildFacility(facility.id));
      item.append(head, detail, button);
      expansionList.appendChild(item);
    }
    const report = el("section", "base-report");
    const reportTitle = el("strong");
    const reportCopy = el("p");
    if (this.opts.campaign.lastMission) {
      const last = this.opts.campaign.lastMission;
      const kiaNames = last.kiaSoldierIds
        .map((id) => this.opts.campaign.soldiers.find((soldier) => soldier.id === id)?.name ?? id)
        .join(", ");
      reportTitle.textContent =
        last.result === "success"
          ? `Operation ${last.missionNumber} secured`
          : `Operation ${last.missionNumber} failed`;
      reportCopy.textContent = `${last.region}: ${last.summary}${kiaNames ? ` KIA: ${kiaNames}.` : ""}`;
    } else {
      reportTitle.textContent = "No field report";
      reportCopy.textContent = "The first recovery operation has not launched.";
    }
    report.append(reportTitle, reportCopy);

    const projectReport = el("section", "base-report");
    const projectTitle = el("strong");
    const projectCopy = el("p");
    const latestProject = this.opts.campaign.projectReports[0];
    if (latestProject) {
      projectTitle.textContent = `Project complete / ${latestProject.title}`;
      projectCopy.textContent = `${latestProject.summary} Completed at campaign hour ${latestProject.completedAtHour}.`;
    } else {
      projectTitle.textContent = "No completed projects";
      projectCopy.textContent = "Research, manufacturing, and construction reports will appear here when crews finish work.";
    }
    projectReport.append(projectTitle, projectCopy);

    const objectiveReport = el("section", "base-report");
    const objectiveTitle = el("strong");
    objectiveTitle.textContent = `${objective.title} / ${objective.completed}/${objective.required}`;
    const objectiveCopy = el("p");
    objectiveCopy.textContent =
      `${objective.summary} Campaign progress ${objective.percent}%. ` +
      (objective.status === "active"
        ? "Secure crash sites to recover more power cores."
        : "Strategic operations are closed.");
    objectiveReport.append(objectiveTitle, objectiveCopy);

    const operation = el("section", "operation-card");
    const operationTitle = el("strong");
    operationTitle.textContent = launchContact
      ? `Operation ${this.opts.operation.codename}`
      : contact
        ? "UFO airborne"
        : "No active UFO contact";
    const operationCopy = el("p");
    operationCopy.textContent = launchContact
      ? this.opts.operation.briefing
      : contact
        ? `${contact.id} is tracked over ${contact.region}. Return to Earth Command and launch the interceptor.`
        : "Return to Earth Command and scan time forward until radar detects a UFO track.";
    const operationMeta = el("div", "operation-meta");
    if (launchContact) {
      operationMeta.append(
        Object.assign(el("span"), { textContent: this.opts.operation.themeId }),
        Object.assign(el("span"), { textContent: `${this.opts.operation.enemyCount} contacts` }),
        Object.assign(el("span"), { textContent: `${this.opts.operation.durationHours}h field time` }),
        Object.assign(el("span"), {
          textContent:
            `+${this.opts.operation.reward.credits}c ` +
            `+${this.opts.operation.reward.alloys}a ` +
            `+${this.opts.operation.reward.elerium}e ` +
            `+${this.opts.operation.reward.alienData}d`,
        }),
      );
    } else {
      operationMeta.append(
        Object.assign(el("span"), { textContent: "scan" }),
        Object.assign(el("span"), { textContent: "radar idle" }),
        Object.assign(el("span"), { textContent: "no target" }),
      );
    }
    if (launchContact) {
      const missionMeta = missionTypeMeta(this.opts.operation);
      const chip = el("div", `mission-chip ${this.opts.operation.missionType ?? "crashSite"}`);
      const chipIcon = el("span", "mission-icon");
      chipIcon.textContent = missionMeta.icon;
      chip.append(chipIcon, document.createTextNode(missionMeta.label));
      const objectiveLine = el("div", "operation-objective");
      objectiveLine.textContent = missionMeta.detail;
      operation.append(operationTitle, chip, operationCopy, objectiveLine, operationMeta);
    } else {
      operation.append(operationTitle, operationCopy, operationMeta);
    }

    const roster = el("section", "roster-card");
    const rosterHead = el("div", "roster-head");
    rosterHead.append(
      Object.assign(el("span"), { textContent: "Operatives" }),
      Object.assign(el("span"), {
        textContent:
          `${deployment.length}/${DEPLOYMENT_SIZE} deployed, ${activeRoster.length} ready / ` +
          CAMPAIGN_WEAPON_IDS
            .map((weaponId) => `${weaponId.toUpperCase()} ${this.opts.campaign.armory.weapons[weaponId]}`)
            .join(" "),
      }),
    );
    const rosterList = el("div", "roster-list");
    for (const soldier of this.opts.campaign.soldiers) {
      const row = el("div", `soldier-row ${soldier.status}`);
      const status =
        soldier.status === "wounded"
          ? `recovery ${Math.max(0, (soldier.woundedUntilHour ?? this.opts.campaign.clock.elapsedHours) - this.opts.campaign.clock.elapsedHours)}h`
          : soldier.status;
      const deployed = deployedIds.has(soldier.id);
      const deployToggle = el("label", "deploy-toggle");
      const deployCheckbox = document.createElement("input");
      deployCheckbox.type = "checkbox";
      deployCheckbox.checked = deployed;
      deployCheckbox.disabled =
        this.opts.campaign.strategic.status !== "active" ||
        (deployed ? false : !canDeploySoldier(this.opts.campaign, soldier.id));
      deployCheckbox.setAttribute("aria-label", `${deployed ? "Remove" : "Deploy"} ${soldier.name}`);
      deployCheckbox.addEventListener("change", () => {
        this.opts.onToggleDeployment(soldier.id, deployCheckbox.checked);
      });
      deployToggle.append(deployCheckbox, document.createTextNode(deployed ? "DROP" : "DEPLOY"));
      const currentWeapon = soldierWeaponId(this.opts.campaign, soldier.id);
      const weaponSelect = el("select");
      weaponSelect.disabled = soldier.status === "kia" || this.opts.campaign.strategic.status !== "active";
      weaponSelect.setAttribute("aria-label", `Weapon for ${soldier.name}`);
      for (const weaponId of CAMPAIGN_WEAPON_IDS) {
        const option = document.createElement("option");
        option.value = weaponId;
        option.textContent =
          `${WEAPONS[weaponId]?.name ?? weaponId} ` +
          `(${availableWeaponCount(this.opts.campaign, weaponId, soldier.id)} free)`;
        option.selected = weaponId === currentWeapon;
        option.disabled =
          weaponId !== currentWeapon &&
          !canAssignSoldierWeapon(this.opts.campaign, soldier.id, weaponId);
        weaponSelect.appendChild(option);
      }
      weaponSelect.addEventListener("change", () => {
        const next = weaponSelect.value as CampaignWeaponId;
        this.opts.onAssignWeapon(soldier.id, next);
      });
      row.append(
        deployToggle,
        Object.assign(el("span"), { textContent: soldier.name }),
        Object.assign(el("span"), { textContent: soldier.rank }),
        Object.assign(el("span"), { textContent: status }),
        Object.assign(el("span"), { textContent: `${soldier.survivedMissions}/${soldier.missions}` }),
        weaponSelect,
      );
      rosterList.appendChild(row);
    }
    if (this.opts.campaign.soldiers.length === 0) {
      const empty = el("div", "empty-state");
      empty.textContent = "No operatives on roster. Recruit to field a squad.";
      rosterList.appendChild(empty);
    }
    const recruit = el("button");
    recruit.textContent = `Recruit operative (${RECRUIT_COST}c)`;
    recruit.disabled = this.opts.campaign.strategic.status !== "active" || !canRecruitSoldier(this.opts.campaign);
    recruit.addEventListener("click", () => this.opts.onRecruitSoldier());
    roster.append(rosterHead, rosterList, recruit);

    const manufacturingCards = MANUFACTURING_PROJECTS.map((project) => {
      const manufacturing = el("section", "manufacturing-card");
      const title = el("strong");
      const copy = el("p");
      const active = this.opts.campaign.activeManufacturing?.projectId === project.id
        ? this.opts.campaign.activeManufacturing
        : undefined;
      const workshopBusy = !!this.opts.campaign.activeManufacturing && !active;
      const activeProject = MANUFACTURING_PROJECTS.find(
        (candidate) => candidate.id === this.opts.campaign.activeManufacturing?.projectId,
      );
      const locked = !!project.requiresResearch && !hasResearch(this.opts.campaign, project.requiresResearch);
      const canManufacture = canStartManufacturing(this.opts.campaign, project.id);
      const cost = manufacturingCost(this.opts.campaign, project.id);
      title.textContent = active
        ? `Workshop: ${project.title} in production`
        : `Manufacture: ${project.title}`;
      copy.textContent = active
        ? `${Math.max(0, active.completesAtHour - this.opts.campaign.clock.elapsedHours)}h remaining. Advance time from Earth Command.`
        : workshopBusy
          ? `Workshop is committed to ${activeProject?.title ?? "another order"}.`
          : locked
            ? `Requires ${project.requiresResearch}. ${project.description}`
            : `${project.description} Cost ${formatCost(cost)}, ${manufacturingDuration(this.opts.campaign, project.id)}h.`;
      const button = el("button");
      button.textContent = active
        ? "In production"
        : workshopBusy
          ? "Workshop busy"
          : locked
            ? "Research required"
            : canManufacture
              ? "Start production"
              : "Need resources";
      button.disabled = !!active || workshopBusy || !canManufacture;
      button.addEventListener("click", () => this.opts.onStartManufacturing(project.id));
      manufacturing.append(title, copy, button);
      return manufacturing;
    });

    const researchCards = RESEARCH_PROJECTS.map((project) => {
      const research = el("section", "research-card");
      const researchTitle = el("strong");
      const researchCopy = el("p");
      const researched = hasResearch(this.opts.campaign, project.id);
      const active = this.opts.campaign.activeResearch?.projectId === project.id
        ? this.opts.campaign.activeResearch
        : undefined;
      const labBusy = !!this.opts.campaign.activeResearch && !active;
      const activeProject = RESEARCH_PROJECTS.find(
        (candidate) => candidate.id === this.opts.campaign.activeResearch?.projectId,
      );
      const canResearch = canStartResearch(this.opts.campaign, project.id);
      const cost = researchCost(this.opts.campaign, project.id);
      researchTitle.textContent = researched
        ? `${project.title} online`
        : active
          ? `${project.title} in progress`
          : `Research: ${project.title}`;
      researchCopy.textContent = researched
        ? project.completedDescription
        : active
          ? `Scientists are working. ${Math.max(0, active.completesAtHour - this.opts.campaign.clock.elapsedHours)}h remaining. Advance time from Earth Command.`
          : labBusy
            ? `Research lab is committed to ${activeProject?.title ?? "another project"}.`
            : `${project.description} Requires ${cost.alienData} data, ${cost.alloys} alloys, ` +
              `${cost.elerium} elerium, ${cost.credits} credits, ${researchDuration(this.opts.campaign, project.id)}h.`;
      const researchButton = el("button");
      researchButton.textContent = researched
        ? "Research complete"
        : active
          ? "In progress"
          : labBusy
            ? "Lab busy"
          : "Start research";
      researchButton.disabled = researched || !!active || !canResearch;
      researchButton.addEventListener("click", () => this.opts.onStartResearch(project.id));
      research.append(researchTitle, researchCopy, researchButton);
      return research;
    });

    const allResearched = RESEARCH_PROJECTS.every((project) =>
      hasResearch(this.opts.campaign, project.id),
    );
    const researchNodes: HTMLElement[] = allResearched
      ? [
          Object.assign(el("div", "empty-state"), {
            textContent: "All research projects complete. The lab stands ready for new specimens.",
          }),
        ]
      : researchCards;

    const actions = el("div", "base-actions");
    const earth = el("button");
    earth.textContent = "Earth";
    earth.addEventListener("click", () => this.opts.onOpenGeoscape());
    const reset = el("button");
    reset.textContent = "New campaign";
    reset.addEventListener("click", () => this.opts.onResetCampaign());
    const launch = el("button", "primary");
    launch.textContent = canLaunch
      ? `${missionTypeMeta(this.opts.operation).launchLabel} (op ${nextMission})`
      : this.opts.campaign.strategic.status === "active"
        ? activeRoster.length === 0
          ? "No operatives"
          : deployment.length === 0
            ? "Select squad"
          : contact && !launchContact
            ? "Intercept first"
            : "Awaiting contact"
        : "Campaign complete";
    launch.disabled = !canLaunch;
    launch.addEventListener("click", () => this.opts.onLaunchMission());
    actions.append(earth, reset, launch);
    right.append(
      siteEye,
      heading,
      list,
      expansionList,
      operation,
      objectiveReport,
      report,
      projectReport,
      roster,
      ...manufacturingCards,
      this.buildMarketPanel(),
      ...researchNodes,
      actions,
    );
    this.root.appendChild(right);

    const hint = el("div", "base-hint");
    hint.textContent = "Base command is the campaign hub / tactical launch starts from here";
    this.root.appendChild(hint);

    const notice = el("div", "notice-toast");
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    this.noticeEl = notice;
    this.root.appendChild(notice);
  }

  private stat(label: string, value: string): HTMLElement {
    const node = el("div", "base-stat");
    const span = el("span");
    span.textContent = label;
    const b = el("b");
    b.textContent = value;
    node.append(span, b);
    return node;
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
