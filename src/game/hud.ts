/**
 * Tactical DOM HUD layered over the WebGL battlefield.
 *
 * This module presents state and raises callbacks only. Simulation decisions
 * stay in src/sim and the controller remains responsible for dispatching them.
 */

import type {
  BattleState,
  ReserveMode,
  ShotKind,
  ShotMode,
  ShotPreview,
  Unit,
  UnitId,
} from "../sim/types";

export interface HudHover {
  kind: "target" | "move" | "blocked";
  label: string;
  detail?: string;
  previews?: Partial<Record<ShotKind, ShotPreview>>;
  moveCost?: number;
  tuAfter?: number;
  reachable?: boolean;
}

export interface HudRuntime {
  seed: number;
  missionName: string;
  objective: string;
  briefing: string;
  debrief?: HudDebrief;
  muted: boolean;
  busy: boolean;
}

export interface HudDebrief {
  result: "success" | "failure";
  operation: string;
  summary: string;
  reward: {
    credits: number;
    alloys: number;
    elerium: number;
    alienData: number;
  };
  casualties: string[];
  strategicStatus: "active" | "won" | "lost";
  threat: number;
  funding: number;
  score: number;
}

export interface HudCallbacks {
  onEndTurn: () => void;
  onSelectMode: (kind: ShotKind) => void;
  onSetReserve: (mode: ReserveMode) => void;
  onReload: () => void;
  onSelectUnit: (id: UnitId) => void;
  onToggleMute: () => boolean;
  onOpenGeoscape: () => void;
  onReturnToBase: () => void;
}

export type ToastTone = "info" | "success" | "danger";

const MODES: readonly ShotKind[] = ["snap", "aimed", "auto"];
const RESERVES: readonly ReserveMode[] = ["none", "snap", "aimed", "auto"];
const STYLE_ID = "blacksite-hud-style";
const LOG_TAIL = 7;

const CSS = `
:root {
  --hud-cyan: #67e8f9;
  --hud-cyan-soft: rgba(103,232,249,.16);
  --hud-amber: #fbbf24;
  --hud-green: #4ade80;
  --hud-red: #fb7185;
  --hud-text: #e5f0f8;
  --hud-muted: #86a0b5;
  --hud-panel: rgba(7,13,20,.88);
  --hud-border: rgba(132,165,188,.25);
}
#hud {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  color: var(--hud-text);
  font: 12px/1.35 Inter, ui-sans-serif, system-ui, sans-serif;
  letter-spacing: .01em;
}
#hud::before {
  content: "";
  position: absolute;
  inset: 0;
  background:
    linear-gradient(180deg, rgba(2,6,10,.48), transparent 19%, transparent 72%, rgba(2,6,10,.42)),
    radial-gradient(circle at center, transparent 48%, rgba(0,0,0,.36) 100%);
  pointer-events: none;
}
#hud .panel {
  position: absolute;
  overflow: hidden;
  background:
    linear-gradient(145deg, rgba(18,31,43,.93), var(--hud-panel) 56%),
    var(--hud-panel);
  border: 1px solid var(--hud-border);
  border-radius: 10px;
  box-shadow: 0 18px 48px rgba(0,0,0,.28), inset 0 1px rgba(255,255,255,.025);
  backdrop-filter: blur(10px);
}
#hud .panel::after {
  content: "";
  position: absolute;
  inset: 0 auto auto 0;
  width: 74px;
  height: 2px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
}
#hud .eyebrow {
  color: var(--hud-cyan);
  font: 700 9px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .18em;
  text-transform: uppercase;
}
#hud .muted { color: var(--hud-muted); }
#hud button {
  pointer-events: auto;
  min-height: 38px;
  cursor: pointer;
  color: var(--hud-text);
  border: 1px solid rgba(130,160,181,.28);
  border-radius: 7px;
  background: linear-gradient(180deg, rgba(34,51,65,.92), rgba(16,26,35,.94));
  font: 700 11px/1.1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .04em;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
#hud button:hover:not(:disabled) {
  border-color: rgba(103,232,249,.75);
  background: linear-gradient(180deg, rgba(38,69,86,.96), rgba(18,39,51,.96));
}
#hud button:active:not(:disabled) { transform: translateY(1px); }
#hud button:focus-visible { outline: 2px solid var(--hud-cyan); outline-offset: 2px; }
#hud button:disabled { opacity: .35; cursor: default; }
#hud button.active {
  color: #effcff;
  border-color: var(--hud-cyan);
  background: linear-gradient(180deg, rgba(20,91,112,.9), rgba(14,52,67,.96));
  box-shadow: inset 0 0 18px rgba(103,232,249,.08);
}

#hud .mission {
  top: max(14px, env(safe-area-inset-top));
  left: max(14px, env(safe-area-inset-left));
  width: 292px;
  padding: 13px 15px 12px;
}
#hud .mission-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 12px; }
#hud .mission h1 { margin: 3px 0 0; font-size: 17px; line-height: 1; letter-spacing: .08em; text-transform: uppercase; }
#hud .turn { color: var(--hud-muted); text-align: right; font: 600 10px/1.35 ui-monospace, monospace; }
#hud .turn b { display: block; color: var(--hud-cyan); font-size: 12px; text-transform: uppercase; }
#hud .mission-meta { display: flex; gap: 6px; margin-top: 10px; }
#hud .chip {
  padding: 4px 7px;
  border: 1px solid rgba(130,160,181,.2);
  border-radius: 999px;
  color: var(--hud-muted);
  background: rgba(0,0,0,.18);
  font: 700 9px/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#hud .chip.live { color: var(--hud-green); border-color: rgba(74,222,128,.3); }
#hud .chip.enemy { color: var(--hud-red); border-color: rgba(251,113,133,.3); }

#hud .objective {
  top: max(14px, env(safe-area-inset-top));
  left: 50%;
  width: 390px;
  padding: 12px 16px;
  transform: translateX(-50%);
}
#hud .objective-head { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
#hud .objective-title { margin-top: 3px; font-size: 13px; font-weight: 760; letter-spacing: .04em; }
#hud .objective-count { color: var(--hud-amber); font: 800 22px/1 ui-monospace, monospace; }
#hud .objective-track { height: 3px; margin-top: 10px; border-radius: 4px; background: rgba(255,255,255,.07); overflow: hidden; }
#hud .objective-track i { display: block; height: 100%; background: linear-gradient(90deg, var(--hud-cyan), var(--hud-green)); }

#hud .tools {
  position: absolute;
  top: max(14px, env(safe-area-inset-top));
  right: max(14px, env(safe-area-inset-right));
  display: flex;
  gap: 7px;
  pointer-events: auto;
}
#hud .tools button { min-width: 42px; height: 42px; padding: 0 11px; }
#hud .tools button.abort-armed {
  color: #ffe4e6;
  border-color: rgba(251,113,133,.82);
  background: linear-gradient(180deg, rgba(127,29,29,.96), rgba(69,10,10,.96));
}

#hud .log {
  top: 74px;
  right: max(14px, env(safe-area-inset-right));
  width: 330px;
  padding: 12px 14px;
}
#hud .log-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
#hud .log .line {
  padding: 4px 0;
  color: #8fa6b9;
  border-top: 1px solid rgba(255,255,255,.035);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font: 500 10px/1.25 ui-monospace, monospace;
}
#hud .log .line.current { color: #dbeaf4; }

#hud .unit {
  left: max(14px, env(safe-area-inset-left));
  bottom: max(14px, env(safe-area-inset-bottom));
  width: 320px;
  padding: 15px;
}
#hud .identity { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; margin-bottom: 12px; }
#hud .identity h2 { margin: 3px 0 2px; font-size: 20px; line-height: 1; letter-spacing: .03em; }
#hud .weapon { color: var(--hud-muted); font-size: 11px; }
#hud .unit-badge {
  min-width: 62px;
  padding: 7px 8px;
  border-radius: 6px;
  color: var(--hud-cyan);
  background: var(--hud-cyan-soft);
  border: 1px solid rgba(103,232,249,.25);
  text-align: center;
  font: 800 10px/1.15 ui-monospace, monospace;
}
#hud .meter-head { display: flex; justify-content: space-between; margin-top: 8px; color: var(--hud-muted); font: 700 9px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
#hud .meter-head b { color: var(--hud-text); font-weight: 700; letter-spacing: 0; }
#hud .bar { height: 7px; margin-top: 6px; border-radius: 7px; background: rgba(255,255,255,.07); overflow: hidden; }
#hud .bar i { display: block; height: 100%; border-radius: inherit; transition: width 180ms ease; }
#hud .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 12px; }
#hud .stat { padding: 7px; border: 1px solid rgba(255,255,255,.06); border-radius: 6px; background: rgba(0,0,0,.13); }
#hud .stat span { display: block; color: var(--hud-muted); font: 700 8px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .stat b { display: block; margin-top: 4px; font: 750 12px/1 ui-monospace, monospace; }

#hud .actions {
  left: 50%;
  bottom: max(14px, env(safe-area-inset-bottom));
  width: 438px;
  padding: 14px;
  transform: translateX(-50%);
}
#hud .context { display: flex; justify-content: space-between; gap: 16px; min-height: 42px; }
#hud .context h3 { margin: 3px 0 0; font-size: 14px; line-height: 1.2; }
#hud .context-detail { max-width: 190px; color: var(--hud-muted); text-align: right; font-size: 10px; }
#hud .context-cost { color: var(--hud-green); font: 800 15px/1 ui-monospace, monospace; }
#hud .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 11px; }
#hud .modes button { min-height: 57px; padding: 7px 6px; }
#hud .modes .mode-name { display: block; text-transform: uppercase; }
#hud .modes .mode-meta { display: flex; justify-content: center; gap: 7px; margin-top: 5px; color: #9db1c1; font-size: 9px; }
#hud .modes .chance { color: var(--hud-amber); }
#hud .reserve-row,
#hud .reload-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
#hud .reserve-row > span { width: 76px; color: var(--hud-muted); font: 700 8px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .reload-row > span { width: 76px; color: var(--hud-muted); font: 700 8px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .reserve { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; flex: 1; }
#hud .reserve button { min-height: 30px; padding: 4px; font-size: 8px; text-transform: uppercase; }
#hud .reload-row button { flex: 1; min-height: 32px; padding: 4px 8px; font-size: 9px; text-transform: uppercase; }

#hud .squad {
  right: max(14px, env(safe-area-inset-right));
  bottom: 75px;
  width: 334px;
  padding: 13px;
}
#hud .squad-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
#hud .roster { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
#hud .roster button { min-height: 48px; padding: 7px 9px; text-align: left; }
#hud .roster .roster-top { display: flex; justify-content: space-between; align-items: center; gap: 7px; }
#hud .roster .roster-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .roster .roster-status { color: var(--hud-green); font-size: 8px; }
#hud .roster .roster-status.spent { color: var(--hud-amber); }
#hud .roster .roster-status.kia { color: var(--hud-red); }
#hud .roster .roster-bars { display: flex; gap: 3px; height: 3px; margin-top: 6px; }
#hud .roster .roster-bars i { display: block; border-radius: 3px; background: var(--hud-cyan); }
#hud .roster .roster-bars i:last-child { background: var(--hud-green); }

#hud .endturn {
  position: absolute;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(14px, env(safe-area-inset-bottom));
  min-width: 156px;
  min-height: 50px;
  padding: 0 16px;
  color: #ecfeff;
  border-color: rgba(103,232,249,.78);
  background: linear-gradient(180deg, rgba(16,93,115,.95), rgba(9,49,64,.98));
  text-transform: uppercase;
  letter-spacing: .09em;
}
#hud .endturn.ready { animation: endturn-pulse 1.8s ease-in-out infinite; }
@keyframes endturn-pulse { 50% { box-shadow: 0 0 24px rgba(103,232,249,.2); } }

#hud .toast {
  position: absolute;
  top: 91px;
  left: 50%;
  z-index: 12;
  min-width: 240px;
  max-width: min(440px, calc(100vw - 28px));
  padding: 11px 16px;
  border: 1px solid rgba(103,232,249,.4);
  border-radius: 7px;
  color: var(--hud-text);
  background: rgba(7,15,22,.94);
  box-shadow: 0 14px 40px rgba(0,0,0,.38);
  text-align: center;
  font: 750 11px/1.3 ui-monospace, monospace;
  letter-spacing: .04em;
  opacity: 0;
  transform: translate(-50%, -8px);
  transition: opacity 150ms ease, transform 150ms ease;
}
#hud .toast.show { opacity: 1; transform: translate(-50%, 0); }
#hud .toast.success { color: var(--hud-green); border-color: rgba(74,222,128,.45); }
#hud .toast.danger { color: #fecdd3; border-color: rgba(251,113,133,.5); }

#hud .banner,
#hud .briefing {
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
#hud .banner.show,
#hud .briefing.show { display: flex; }
#hud .banner-card,
#hud .briefing-card {
  position: relative;
  width: min(720px, 100%);
  overflow: hidden;
  padding: clamp(24px, 5vw, 46px);
  border: 1px solid rgba(103,232,249,.28);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%),
    rgba(5,11,17,.98);
  box-shadow: 0 30px 100px rgba(0,0,0,.55);
}
#hud .briefing-card::before {
  content: "";
  position: absolute;
  top: 0;
  left: 0;
  width: 42%;
  height: 3px;
  background: linear-gradient(90deg, var(--hud-cyan), transparent);
}
#hud .briefing h2,
#hud .banner h1 { margin: 7px 0 10px; font-size: clamp(30px, 6vw, 54px); line-height: .95; letter-spacing: .04em; text-transform: uppercase; }
#hud .briefing-lede { max-width: 590px; margin: 0; color: #a9bdcb; font-size: 14px; }
#hud .debrief-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0 4px;
}
#hud .debrief-stat {
  padding: 10px;
  border: 1px solid rgba(255,255,255,.08);
  border-radius: 8px;
  background: rgba(0,0,0,.18);
}
#hud .debrief-stat span {
  display: block;
  color: var(--hud-muted);
  font: 800 8px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#hud .debrief-stat b {
  display: block;
  margin-top: 7px;
  color: var(--hud-text);
  font: 850 11px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}
#hud .briefing-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 26px 0; }
#hud .briefing-step { padding: 13px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(0,0,0,.14); }
#hud .briefing-step b { display: block; margin: 5px 0; font-size: 13px; text-transform: uppercase; }
#hud .briefing-step p { margin: 0; color: var(--hud-muted); font-size: 10px; }
#hud .briefing-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
#hud .briefing-actions span { color: var(--hud-muted); font: 600 9px/1.45 ui-monospace, monospace; }
#hud .briefing-actions button,
#hud .banner button { min-width: 174px; padding: 0 18px; border-color: var(--hud-cyan); }
#hud .banner-card { text-align: center; }
#hud .banner.win h1 { color: var(--hud-green); }
#hud .banner.lose h1 { color: var(--hud-red); }

@media (max-width: 1120px) {
  #hud .objective, #hud .log { display: none; }
  #hud .actions { left: 348px; width: 410px; transform: none; }
  #hud .squad { width: 292px; }
}
@media (max-width: 820px) {
  #hud .mission { width: 226px; padding: 11px 12px; }
  #hud .mission h1 { font-size: 14px; }
  #hud .mission-meta .chip:last-child { display: none; }
  #hud .tools button { min-width: 38px; width: 38px; padding: 0; }
  #hud .squad { display: none; }
  #hud .unit {
    right: max(10px, env(safe-area-inset-right));
    bottom: max(10px, env(safe-area-inset-bottom));
    width: auto;
    padding: 11px 152px 11px 12px;
  }
  #hud .identity { margin-bottom: 7px; }
  #hud .identity h2 { font-size: 16px; }
  #hud .unit-badge, #hud .stats { display: none; }
  #hud .actions {
    left: max(10px, env(safe-area-inset-left));
    right: max(10px, env(safe-area-inset-right));
    bottom: 146px;
    width: auto;
    padding: 10px;
  }
  #hud .reserve-row,
  #hud .reload-row { display: none; }
  #hud .modes { margin-top: 7px; }
  #hud .modes button { min-height: 48px; }
  #hud .endturn { right: 20px; bottom: 36px; min-width: 104px; min-height: 46px; font-size: 9px; }
  #hud .briefing-grid { grid-template-columns: 1fr; }
  #hud .briefing-step { padding: 10px 12px; }
  #hud .briefing-actions { align-items: stretch; flex-direction: column; }
  #hud .briefing-actions button { width: 100%; }
}
@media (max-height: 660px) {
  #hud .log, #hud .squad { display: none; }
  #hud .unit { padding-top: 10px; padding-bottom: 10px; }
  #hud .stats { display: none; }
  #hud .briefing-card { padding-top: 24px; padding-bottom: 24px; }
  #hud .briefing-grid { margin: 16px 0; }
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

function modeTuCost(unit: Unit, mode: ShotMode): number {
  return Math.ceil((unit.stats.timeUnits * mode.tuPercent) / 100);
}

function reloadTuCost(unit: Unit, reloadTuPercent: number): number {
  return Math.ceil((unit.stats.timeUnits * reloadTuPercent) / 100);
}

function percent(value: number, max: number): number {
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
}

function titleCase(value: string): string {
  return value.replace(/(^|_)([a-z])/g, (_match, prefix: string, char: string) =>
    `${prefix ? " " : ""}${char.toUpperCase()}`,
  );
}

export class Hud {
  private readonly root: HTMLDivElement;
  private readonly missionTitle: HTMLHeadingElement;
  private readonly turnEl: HTMLDivElement;
  private readonly themeChip: HTMLSpanElement;
  private readonly seedChip: HTMLSpanElement;
  private readonly objectiveTitle: HTMLDivElement;
  private readonly objectiveCount: HTMLDivElement;
  private readonly objectiveFill: HTMLElement;
  private readonly nameEl: HTMLHeadingElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly unitBadge: HTMLDivElement;
  private readonly tuFill: HTMLElement;
  private readonly tuText: HTMLElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly accuracyEl: HTMLElement;
  private readonly reactionsEl: HTMLElement;
  private readonly visionEl: HTMLElement;
  private readonly contextEyebrow: HTMLDivElement;
  private readonly contextTitle: HTMLHeadingElement;
  private readonly contextDetail: HTMLDivElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly modeButtons = new Map<ShotKind, HTMLButtonElement>();
  private readonly reserveButtons = new Map<ReserveMode, HTMLButtonElement>();
  private readonly rosterEl: HTMLDivElement;
  private readonly logEl: HTMLElement;
  private readonly endTurn: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly abortButton: HTMLButtonElement;
  private readonly toast: HTMLDivElement;
  private readonly banner: HTMLDivElement;
  private readonly bannerTitle: HTMLHeadingElement;
  private readonly bannerCopy: HTMLParagraphElement;
  private readonly bannerReport: HTMLDivElement;
  private readonly briefing: HTMLDivElement;
  private briefingTitle!: HTMLHeadingElement;
  private briefingLede!: HTMLParagraphElement;

  private activeMode: ShotKind = "snap";
  private toastTimer: number | null = null;
  private abortConfirmTimer: number | null = null;

  constructor(private readonly cb: HudCallbacks) {
    this.injectStyle();
    this.root = el("div");
    this.root.id = "hud";

    const mission = el("section", "panel mission");
    const missionRow = el("div", "mission-row");
    const brand = el("div");
    const brandEyebrow = el("div", "eyebrow");
    brandEyebrow.textContent = "Blacksite command";
    this.missionTitle = el("h1");
    this.missionTitle.textContent = "Operation";
    brand.append(brandEyebrow, this.missionTitle);
    this.turnEl = el("div", "turn");
    missionRow.append(brand, this.turnEl);
    const missionMeta = el("div", "mission-meta");
    this.themeChip = el("span", "chip live");
    this.seedChip = el("span", "chip");
    const ironman = el("span", "chip");
    ironman.textContent = "Live intel";
    missionMeta.append(this.themeChip, this.seedChip, ironman);
    mission.append(missionRow, missionMeta);
    this.root.appendChild(mission);

    const objective = el("section", "panel objective");
    const objectiveHead = el("div", "objective-head");
    const objectiveCopy = el("div");
    const objectiveEye = el("div", "eyebrow");
    objectiveEye.textContent = "Primary objective";
    this.objectiveTitle = el("div", "objective-title");
    this.objectiveTitle.textContent = "Secure the crash site and neutralize hostiles";
    objectiveCopy.append(objectiveEye, this.objectiveTitle);
    this.objectiveCount = el("div", "objective-count");
    objectiveHead.append(objectiveCopy, this.objectiveCount);
    const objectiveTrack = el("div", "objective-track");
    this.objectiveFill = el("i");
    objectiveTrack.appendChild(this.objectiveFill);
    objective.append(objectiveHead, objectiveTrack);
    this.root.appendChild(objective);

    const tools = el("div", "tools");
    const help = el("button");
    help.textContent = "?";
    help.title = "Mission controls (H)";
    help.setAttribute("aria-label", "Open mission controls");
    help.addEventListener("click", () => this.toggleBriefing(true));
    this.muteButton = el("button");
    this.muteButton.textContent = "SFX";
    this.muteButton.title = "Toggle audio (M)";
    this.muteButton.addEventListener("click", () => {
      const muted = this.cb.onToggleMute();
      this.setMuted(muted);
    });
    this.abortButton = el("button");
    this.abortButton.textContent = "ABORT";
    this.abortButton.title = "Abort operation and return to Earth Command";
    this.abortButton.addEventListener("click", () => this.requestAbort());
    tools.append(help, this.muteButton, this.abortButton);
    this.root.appendChild(tools);

    this.logEl = el("section", "panel log");
    this.root.appendChild(this.logEl);

    const unit = el("section", "panel unit");
    const identity = el("div", "identity");
    const identityCopy = el("div");
    const unitEye = el("div", "eyebrow");
    unitEye.textContent = "Selected operative";
    this.nameEl = el("h2");
    this.weaponEl = el("div", "weapon");
    identityCopy.append(unitEye, this.nameEl, this.weaponEl);
    this.unitBadge = el("div", "unit-badge");
    identity.append(identityCopy, this.unitBadge);
    unit.appendChild(identity);

    const tuHead = el("div", "meter-head");
    tuHead.append(document.createTextNode("Time units"));
    this.tuText = el("b");
    tuHead.appendChild(this.tuText);
    const tuBar = el("div", "bar");
    this.tuFill = el("i");
    this.tuFill.style.background = "linear-gradient(90deg,#22d3ee,#67e8f9)";
    tuBar.appendChild(this.tuFill);

    const hpHead = el("div", "meter-head");
    hpHead.append(document.createTextNode("Vital signs"));
    this.hpText = el("b");
    hpHead.appendChild(this.hpText);
    const hpBar = el("div", "bar");
    this.hpFill = el("i");
    hpBar.appendChild(this.hpFill);
    unit.append(tuHead, tuBar, hpHead, hpBar);

    const stats = el("div", "stats");
    this.accuracyEl = this.makeStat(stats, "Accuracy");
    this.reactionsEl = this.makeStat(stats, "Reactions");
    this.visionEl = this.makeStat(stats, "Vision");
    unit.appendChild(stats);
    this.root.appendChild(unit);

    const actions = el("section", "panel actions");
    const context = el("div", "context");
    const contextCopy = el("div");
    this.contextEyebrow = el("div", "eyebrow");
    this.contextTitle = el("h3");
    contextCopy.append(this.contextEyebrow, this.contextTitle);
    this.contextDetail = el("div", "context-detail");
    context.append(contextCopy, this.contextDetail);
    actions.appendChild(context);

    const modes = el("div", "modes");
    for (const kind of MODES) {
      const button = el("button");
      button.dataset.kind = kind;
      button.addEventListener("click", () => this.cb.onSelectMode(kind));
      this.modeButtons.set(kind, button);
      modes.appendChild(button);
    }
    actions.appendChild(modes);

    const reloadRow = el("div", "reload-row");
    const reloadLabel = el("span");
    reloadLabel.textContent = "Magazine";
    this.reloadButton = el("button");
    this.reloadButton.textContent = "Reload [L]";
    this.reloadButton.addEventListener("click", () => this.cb.onReload());
    reloadRow.append(reloadLabel, this.reloadButton);
    actions.appendChild(reloadRow);

    const reserveRow = el("div", "reserve-row");
    const reserveLabel = el("span");
    reserveLabel.textContent = "Reaction reserve";
    const reserve = el("div", "reserve");
    for (const mode of RESERVES) {
      const button = el("button");
      button.textContent = mode;
      button.addEventListener("click", () => this.cb.onSetReserve(mode));
      this.reserveButtons.set(mode, button);
      reserve.appendChild(button);
    }
    reserveRow.append(reserveLabel, reserve);
    actions.appendChild(reserveRow);
    this.root.appendChild(actions);

    const squad = el("section", "panel squad");
    const squadHead = el("div", "squad-head");
    const squadEye = el("div", "eyebrow");
    squadEye.textContent = "Strike team";
    const squadHint = el("span", "muted");
    squadHint.textContent = "TAB / SPACE";
    squadHead.append(squadEye, squadHint);
    this.rosterEl = el("div", "roster");
    squad.append(squadHead, this.rosterEl);
    this.root.appendChild(squad);

    this.endTurn = el("button", "endturn");
    this.endTurn.textContent = "End turn [Enter]";
    this.endTurn.addEventListener("click", () => this.cb.onEndTurn());
    this.root.appendChild(this.endTurn);

    this.toast = el("div", "toast");
    this.root.appendChild(this.toast);

    this.banner = el("div", "banner");
    const bannerCard = el("div", "banner-card");
    const bannerEye = el("div", "eyebrow");
    bannerEye.textContent = "Operation complete";
    this.bannerTitle = el("h1");
    this.bannerCopy = el("p", "briefing-lede");
    this.bannerCopy.textContent = "Mission report transmitted to base command.";
    this.bannerReport = el("div", "debrief-grid");
    this.bannerReport.hidden = true;
    const newMission = el("button");
    newMission.textContent = "Return to Base";
    newMission.addEventListener("click", () => this.cb.onReturnToBase());
    bannerCard.append(bannerEye, this.bannerTitle, this.bannerCopy, this.bannerReport, newMission);
    this.banner.appendChild(bannerCard);
    this.root.appendChild(this.banner);

    this.briefing = this.buildBriefing();
    this.root.appendChild(this.briefing);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  setMode(kind: ShotKind): void {
    this.activeMode = kind;
    for (const [mode, button] of this.modeButtons) {
      button.classList.toggle("active", mode === kind);
    }
  }

  setMuted(muted: boolean): void {
    this.muteButton.classList.toggle("active", muted);
    this.muteButton.textContent = muted ? "MUTE" : "SFX";
  }

  toggleBriefing(force?: boolean): void {
    const show = force ?? !this.briefing.classList.contains("show");
    this.briefing.classList.toggle("show", show);
  }

  isBriefingOpen(): boolean {
    return this.briefing.classList.contains("show");
  }

  notify(message: string, tone: ToastTone = "info"): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    this.toast.textContent = message;
    this.toast.className = `toast ${tone}`;
    requestAnimationFrame(() => this.toast.classList.add("show"));
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove("show");
      this.toastTimer = null;
    }, 2100);
  }

  private requestAbort(): void {
    if (this.abortButton.classList.contains("abort-armed")) {
      this.clearAbortConfirm();
      this.cb.onOpenGeoscape();
      return;
    }

    this.abortButton.classList.add("abort-armed");
    this.abortButton.textContent = "CONFIRM";
    this.abortButton.title = "Click again to abandon the operation and record a failure";
    this.notify("CLICK CONFIRM TO ABORT", "danger");
    if (this.abortConfirmTimer !== null) window.clearTimeout(this.abortConfirmTimer);
    this.abortConfirmTimer = window.setTimeout(() => this.clearAbortConfirm(), 3500);
  }

  private clearAbortConfirm(): void {
    if (this.abortConfirmTimer !== null) {
      window.clearTimeout(this.abortConfirmTimer);
      this.abortConfirmTimer = null;
    }
    this.abortButton.classList.remove("abort-armed");
    this.abortButton.textContent = "ABORT";
    this.abortButton.title = "Abort operation and return to Earth Command";
  }

  update(
    state: BattleState,
    selected: Unit | null,
    hover: HudHover | null,
    runtime: HudRuntime,
  ): void {
    const players = state.units.filter((unit) => unit.faction === "player");
    const enemies = state.units.filter((unit) => unit.faction === "enemy");
    const livingPlayers = players.filter((unit) => unit.alive);
    const livingEnemies = enemies.filter((unit) => unit.alive);
    const enemyTurn = state.activeFaction === "enemy";

    this.turnEl.replaceChildren(
      document.createTextNode(`ROUND ${state.turn}`),
      Object.assign(el("b"), {
        textContent: enemyTurn ? "Enemy activity" : runtime.busy ? "Resolving order" : "Your command",
      }),
    );
    this.themeChip.textContent = titleCase(state.themeId ?? "unknown zone");
    this.themeChip.classList.toggle("enemy", enemyTurn);
    this.themeChip.classList.toggle("live", !enemyTurn);
    this.seedChip.textContent = `Seed ${runtime.seed}`;
    this.missionTitle.textContent = runtime.missionName;
    this.objectiveTitle.textContent = state.objective?.recovered && !state.objective.extracted
      ? "Return the UFO core to the dropship extraction zone"
      : runtime.objective;
    this.briefingTitle.textContent = runtime.missionName;
    this.briefingLede.textContent = runtime.briefing;

    if (state.objective) {
      this.objectiveCount.textContent = state.objective.extracted
        ? "CORE EXTRACTED"
        : state.objective.recovered
          ? "EXTRACT CORE"
          : "CORE LIVE";
    } else {
      this.objectiveCount.textContent = `${livingEnemies.length} CONTACT${livingEnemies.length === 1 ? "" : "S"}`;
    }
    const progress = state.objective
      ? state.objective.extracted
        ? 100
        : state.objective.recovered
          ? 50
          : 0
      : enemies.length > 0
        ? ((enemies.length - livingEnemies.length) / enemies.length) * 100
        : 100;
    this.objectiveFill.style.width = `${progress}%`;

    this.updateUnit(state, selected);
    this.updateContext(hover, selected);
    this.updateModeButtons(state, selected, hover, runtime);
    this.updateReloadButton(state, selected, runtime);
    this.updateReserveButtons(selected, runtime);
    this.renderRoster(players, selected, runtime);
    this.renderLog(state);
    this.updateBanner(state, runtime);
    this.setMuted(runtime.muted);
    this.abortButton.disabled = runtime.busy || state.status !== "playing";
    if (this.abortButton.disabled) this.clearAbortConfirm();

    const allSpent = livingPlayers.every((unit) => unit.tu <= 0);
    this.endTurn.disabled = runtime.busy || enemyTurn || state.status !== "playing";
    this.endTurn.classList.toggle("ready", allSpent && !this.endTurn.disabled);
    this.endTurn.textContent = runtime.busy ? "Resolving..." : "End turn [Enter]";
  }

  private updateUnit(state: BattleState, selected: Unit | null): void {
    if (!selected) {
      this.nameEl.textContent = "No operative";
      this.weaponEl.textContent = "Select a squad member";
      this.unitBadge.textContent = "--";
      this.tuFill.style.width = "0%";
      this.hpFill.style.width = "0%";
      this.tuText.textContent = "--";
      this.hpText.textContent = "--";
      this.accuracyEl.textContent = "--";
      this.reactionsEl.textContent = "--";
      this.visionEl.textContent = "--";
      return;
    }

    this.nameEl.textContent = selected.name;
    const weapon = state.weapons[selected.weaponId];
    this.weaponEl.textContent = weapon
      ? `${weapon.name} - Ammo ${selected.ammo}/${weapon.magazineSize}`
      : selected.weaponId;
    this.unitBadge.textContent = selected.tu > 0 ? "READY" : "SPENT";
    this.tuFill.style.width = `${percent(selected.tu, selected.stats.timeUnits)}%`;
    this.tuText.textContent = `${selected.tu} / ${selected.stats.timeUnits}`;
    const hpPct = percent(selected.hp, selected.stats.health);
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background =
      hpPct >= 60 ? "#4ade80" : hpPct >= 30 ? "#fbbf24" : "#fb7185";
    this.hpText.textContent = `${selected.hp} / ${selected.stats.health}`;
    this.accuracyEl.textContent = String(selected.stats.firingAccuracy);
    this.reactionsEl.textContent = String(selected.stats.reactions);
    this.visionEl.textContent = `${selected.sightRange} tiles`;
  }

  private updateContext(hover: HudHover | null, selected: Unit | null): void {
    if (!selected) {
      this.contextEyebrow.textContent = "No active unit";
      this.contextTitle.textContent = "Select an operative";
      this.contextDetail.textContent = "Use the roster or click a blue unit.";
      return;
    }
    if (!hover) {
      this.contextEyebrow.textContent = "Awaiting order";
      this.contextTitle.textContent = "Choose a destination or target";
      this.contextDetail.textContent = "Click to move. Hover a hostile to preview fire.";
      return;
    }

    this.contextEyebrow.textContent =
      hover.kind === "target" ? "Target acquired" : hover.kind === "move" ? "Move preview" : "Route blocked";
    this.contextTitle.textContent = hover.label;
    if (hover.kind === "move" && hover.moveCost !== undefined) {
      this.contextDetail.replaceChildren(
        Object.assign(el("span", "context-cost"), { textContent: `${hover.moveCost} TU` }),
        document.createElement("br"),
        document.createTextNode(
          hover.reachable === false
            ? `Advance to limit, ${hover.tuAfter ?? 0} TU left`
            : `${hover.tuAfter ?? 0} TU remaining`,
        ),
      );
    } else {
      this.contextDetail.textContent = hover.detail ?? "";
    }
  }

  private updateModeButtons(
    state: BattleState,
    selected: Unit | null,
    hover: HudHover | null,
    runtime: HudRuntime,
  ): void {
    const weapon = selected ? state.weapons[selected.weaponId] : undefined;
    for (const kind of MODES) {
      const button = this.modeButtons.get(kind);
      if (!button) continue;
      const mode = weapon?.modes.find((candidate) => candidate.kind === kind);
      const costValue = mode && selected ? modeTuCost(selected, mode) : null;
      const ammoValue = mode && selected ? `${Math.min(selected.ammo, mode.shots)}/${mode.shots} RDS` : "N/A";
      const preview = hover?.previews?.[kind];
      const chance =
        preview && preview.possible
          ? `${Math.round(preview.hitChance * 100)}%`
          : preview
            ? "BLOCKED"
            : "--";

      const name = el("span", "mode-name");
      name.textContent = kind;
      const meta = el("span", "mode-meta");
      const cost = el("span");
      cost.textContent = costValue === null ? "N/A" : `${costValue} TU`;
      const ammo = el("span");
      ammo.textContent = ammoValue;
      const odds = el("span", "chance");
      odds.textContent = chance;
      meta.append(cost, ammo, odds);
      button.replaceChildren(name, meta);
      button.disabled =
        !mode ||
        !selected ||
        runtime.busy ||
        state.activeFaction !== "player" ||
        (costValue !== null && selected.tu < costValue) ||
        (mode !== undefined && selected.ammo < mode.shots);
      button.classList.toggle("active", kind === this.activeMode && !!mode);
      button.title = preview?.reason ??
        (mode && selected && selected.ammo < mode.shots ? "not enough ammo" : `${titleCase(kind)} fire`);
    }
  }

  private updateReloadButton(state: BattleState, selected: Unit | null, runtime: HudRuntime): void {
    const weapon = selected ? state.weapons[selected.weaponId] : undefined;
    const cost = selected && weapon ? reloadTuCost(selected, weapon.reloadTuPercent) : 0;
    const full = !!selected && !!weapon && selected.ammo >= weapon.magazineSize;
    this.reloadButton.textContent = selected && weapon
      ? `Reload ${selected.ammo}/${weapon.magazineSize} (${cost} TU) [L]`
      : "Reload [L]";
    this.reloadButton.disabled =
      !selected ||
      !weapon ||
      full ||
      runtime.busy ||
      state.activeFaction !== "player" ||
      state.status !== "playing" ||
      selected.tu < cost;
    this.reloadButton.title = !selected
      ? "Select an operative"
      : !weapon
        ? "No weapon"
        : full
          ? "Magazine full"
          : selected.tu < cost
            ? "Not enough TU"
            : "Reload weapon";
  }

  private updateReserveButtons(selected: Unit | null, runtime: HudRuntime): void {
    for (const [mode, button] of this.reserveButtons) {
      button.disabled = !selected || runtime.busy;
      button.classList.toggle("active", !!selected && selected.reserve === mode);
    }
  }

  private renderRoster(players: Unit[], selected: Unit | null, runtime: HudRuntime): void {
    const buttons = players.map((unit) => {
      const button = el("button");
      const top = el("span", "roster-top");
      const name = el("span", "roster-name");
      name.textContent = unit.name;
      const status = el("span", "roster-status");
      status.textContent = !unit.alive ? "KIA" : unit.tu > 0 ? `${unit.tu} TU` : "SPENT";
      status.classList.toggle("spent", unit.alive && unit.tu <= 0);
      status.classList.toggle("kia", !unit.alive);
      top.append(name, status);

      const bars = el("span", "roster-bars");
      const tu = el("i");
      tu.style.width = `${percent(unit.tu, unit.stats.timeUnits)}%`;
      const hp = el("i");
      hp.style.width = `${percent(unit.hp, unit.stats.health)}%`;
      bars.append(tu, hp);
      button.append(top, bars);
      button.classList.toggle("active", selected?.id === unit.id);
      button.disabled = !unit.alive || runtime.busy;
      button.addEventListener("click", () => this.cb.onSelectUnit(unit.id));
      return button;
    });
    this.rosterEl.replaceChildren(...buttons);
  }

  private renderLog(state: BattleState): void {
    const head = el("div", "log-head");
    const label = el("div", "eyebrow");
    label.textContent = "Combat feed";
    const count = el("span", "muted");
    count.textContent = `${state.log.length} events`;
    head.append(label, count);

    const tail = state.log.slice(-LOG_TAIL).reverse();
    const lines = tail.map((line, index) => {
      const node = el("div", `line${index === 0 ? " current" : ""}`);
      node.textContent = line;
      node.title = line;
      return node;
    });
    this.logEl.replaceChildren(head, ...lines);
  }

  private updateBanner(state: BattleState, runtime: HudRuntime): void {
    if (state.status === "playing") {
      this.banner.classList.remove("show", "win", "lose");
      return;
    }
    const win = state.status === "player_win";
    const debrief = runtime.debrief;
    this.bannerTitle.textContent = debrief?.strategicStatus === "won"
      ? "Campaign Won"
      : debrief?.strategicStatus === "lost"
        ? "Campaign Lost"
        : win
          ? "Site Secured"
          : "Squad Lost";
    this.bannerCopy.textContent = debrief?.summary ?? "Mission report transmitted to base command.";
    this.bannerReport.hidden = !debrief;
    if (debrief) {
      const reward =
        `+${debrief.reward.credits}C +${debrief.reward.alloys}A ` +
        `+${debrief.reward.elerium}E +${debrief.reward.alienData}D`;
      const casualties = debrief.casualties.length > 0 ? debrief.casualties.join(", ") : "None";
      const campaign =
        debrief.strategicStatus === "active"
          ? `Threat ${debrief.threat}% / Funding ${debrief.funding} / Score ${debrief.score}`
          : debrief.strategicStatus;
      this.bannerReport.replaceChildren(
        this.debriefStat("Reward", reward),
        this.debriefStat("KIA", casualties),
        this.debriefStat("Campaign", campaign),
      );
    } else {
      this.bannerReport.replaceChildren();
    }
    this.banner.classList.add("show", win ? "win" : "lose");
    this.banner.classList.remove(win ? "lose" : "win");
  }

  private debriefStat(label: string, value: string): HTMLElement {
    const node = el("div", "debrief-stat");
    const span = el("span");
    span.textContent = label;
    const strong = el("b");
    strong.textContent = value;
    node.append(span, strong);
    return node;
  }

  private makeStat(parent: HTMLElement, label: string): HTMLElement {
    const box = el("div", "stat");
    const caption = el("span");
    caption.textContent = label;
    const value = el("b");
    box.append(caption, value);
    parent.appendChild(box);
    return value;
  }

  private buildBriefing(): HTMLDivElement {
    const overlay = el("div", "briefing show");
    const card = el("div", "briefing-card");
    const eye = el("div", "eyebrow");
    eye.textContent = "Operation briefing / 06:20 local";
    this.briefingTitle = el("h2");
    this.briefingTitle.textContent = "Operation";
    this.briefingLede = el("p", "briefing-lede");
    this.briefingLede.textContent =
      "An unidentified craft is down beyond the perimeter. Advance from the dropship, recover the power source, and survive hostile contact.";

    const grid = el("div", "briefing-grid");
    const steps: Array<[string, string, string]> = [
      ["01", "Move", "Click a green path to advance. Every tile spends Time Units."],
      ["02", "Engage", "Hover a hostile for honest hit odds, then click to fire."],
      ["03", "Recover", "Click the power-source beacon to move adjacent or secure it."],
    ];
    for (const [number, heading, copy] of steps) {
      const step = el("div", "briefing-step");
      const stepEye = el("div", "eyebrow");
      stepEye.textContent = number;
      const stepTitle = el("b");
      stepTitle.textContent = heading;
      const stepCopy = el("p");
      stepCopy.textContent = copy;
      step.append(stepEye, stepTitle, stepCopy);
      grid.appendChild(step);
    }

    const actions = el("div", "briefing-actions");
    const keys = el("span");
    keys.textContent = "WASD PAN / Q E ROTATE / WHEEL ZOOM / TAB CYCLE / H HELP";
    const begin = el("button");
    begin.textContent = "Deploy squad";
    begin.addEventListener("click", () => this.toggleBriefing(false));
    actions.append(keys, begin);
    card.append(eye, this.briefingTitle, this.briefingLede, grid, actions);
    overlay.appendChild(card);
    return overlay;
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}
