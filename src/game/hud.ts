/**
 * Tactical DOM HUD layered over the WebGL battlefield.
 *
 * This module presents state and raises callbacks only. Simulation decisions
 * stay in src/sim and the controller remains responsible for dispatching them.
 */

import { MORALE, STANCE } from "../sim/types";
import type {
  BattleState,
  Item,
  ItemInstance,
  PsiKind,
  ReserveMode,
  ShotKind,
  ShotMode,
  ShotPreview,
  Unit,
  UnitId,
  UnitStance,
  Weapon,
} from "../sim/types";
import { coverDefenseFor } from "../sim/combat";
import { visibleEnemyIds } from "../sim/index";
import type { SoldierRank, SoldierStatGrowth } from "../campaign/types";
import { UI_TOKENS, UI_BASE, UI_COMPONENTS, UI_PRIMITIVES } from "./uiTheme";
import {
  formatCredits,
  formatDuration,
  formatPercent,
  formatSignedCredits,
  ratioToPercent,
} from "./uiFormat";

export interface HudHover {
  kind: "target" | "move" | "blocked";
  label: string;
  detail?: string;
  previews?: Partial<Record<ShotKind, ShotPreview>>;
  moveCost?: number;
  tuAfter?: number;
  reachable?: boolean;
}

/** Optional campaign career detail shown in the soldier dossier overlay. */
export interface HudSoldierDetail {
  rank?: string;
  missions?: number;
  survived?: number;
  kills?: number;
}

export interface HudRuntime {
  seed: number;
  missionName: string;
  objective: string;
  briefing: string;
  debrief?: HudDebrief;
  muted: boolean;
  busy: boolean;
  /** Units currently in a panicked state (inferred by the integrator from sim events). */
  panickedUnitIds?: number[];
  /** When set, the end-of-mission banner becomes a full campaign victory/defeat screen. */
  campaignStatus?: "won" | "lost";
  /** Campaign career data for the currently selected soldier, when available. */
  soldierDetail?: HudSoldierDetail;
  /** Psionic-action availability for the selected operative. Omitted (and the PSI
   *  row hidden) when the operative has no psi skill. TU costs + the Mind Control
   *  hard-cap ("1 per battle") are computed by the controller so the HUD never
   *  reaches into the sim's PSI tuning constants directly. */
  psi?: HudPsiInfo;
}

/** Psionic action availability surfaced to the HUD for the selected operative. */
export interface HudPsiInfo {
  /** TU the Panic psi action would cost. */
  panicTuCost: number;
  /** Panic actionable right now (player's turn, not busy, enough TU). */
  panicAvailable: boolean;
  /** TU the Mind Control psi action would cost. */
  mcTuCost: number;
  /** Mind Control actionable right now (also false once the per-battle hard cap is spent). */
  mcAvailable: boolean;
  /** True once the 1-MC-per-battle hard cap has been used (disables the MC button). */
  mcSpent: boolean;
}

/** A KIA operative surfaced by name on the debrief (the permadeath payoff). */
export interface HudDebriefCasualty {
  id: string;
  name: string;
  rank: SoldierRank;
  /** Procedural background rolled at recruit; shown as the operative's epitaph. */
  bio?: string;
}

/** A surviving operative, with the career progress they earned this mission. */
export interface HudDebriefSurvivor {
  id: string;
  name: string;
  rank: SoldierRank;
  /** Rank held before this mission; present lets the HUD flag a promotion. */
  previousRank?: SoldierRank;
  wounded?: boolean;
  /** Recovery hours remaining at debrief time (wounded soldiers only). */
  woundRecoveryHours?: number;
  /** Stat growth earned THIS mission (delta), when the controller can derive it. */
  statGrowth?: SoldierStatGrowth;
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
  /** Legacy KIA list (names/ids). Superseded by `kia` when the controller provides it. */
  casualties: string[];
  strategicStatus: "active" | "won" | "lost";
  threat: number;
  funding: number;
  score: number;
  /** KIA operatives with full identity (name/rank/bio). Optional — controller-provided. */
  kia?: HudDebriefCasualty[];
  /** Surviving operatives with growth/promotions/wounds. Optional — controller-provided. */
  survivors?: HudDebriefSurvivor[];
  /** Per-mission score contribution (before → after strategic score). Drives the rating. */
  missionScore?: number;
  /** Civilians saved on a terror mission, when applicable. */
  civiliansRescued?: number;
  civilianCasualties?: number;
  /** Live aliens taken (stunned) this mission: secured into containment vs lost.
   *  `hadContainment` distinguishes a full facility (held/capacity) from an absent
   *  one. Present only when at least one capture was made. */
  captures?: {
    secured: { rank: string; species: string }[];
    lostCount: number;
    hadContainment: boolean;
    held: number;
    capacity: number;
  };
  /** Signed post-mission threat delta (after − before), in the same percent units as
   *  {@link threat}. Negative reads as a reduction (good direction). Controller-derived. */
  threatDelta?: number;
  /** Signed funding delta (after − before), in credits. Positive reads as a gain (good). */
  fundingDelta?: number;
  /** Signed aggregate/highest regional panic delta, in percent units. Negative reads as a
   *  panic reduction (good direction). Controller-derived. */
  panicDelta?: number;
  /** Mission objective progress lines, each flagged done/not-done. Controller-derived. */
  objectives?: { label: string; done: boolean }[];
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
  onThrowItem?: (itemId: string) => void;
  onUseItem?: (itemId: string) => void;
  onPrimeItem?: (itemId: string) => void;
  /**
   * Enter psi-targeting mode for the selected operative. The next enemy click
   * resolves into a `psiAttack` command (see main.ts). Omitted when the unit has
   * no psi skill.
   */
  onPsiAttack?: (kind: PsiKind) => void;
  /** Toggle the selected operative's body stance (stand <-> kneel). */
  onSetStance?: (stance: UnitStance) => void;
  onOpenSoldierDetail?: (unitId: number) => void;
  /** Campaign-level restart; falls back to onReturnToBase when not wired. */
  onNewCampaign?: () => void;
}

export type ToastTone = "info" | "success" | "danger";

const MODES: readonly ShotKind[] = ["snap", "aimed", "auto"];
/** Glyph flagging each fire mode on the action-button face (icon + TU cost, Style Bible item 5). */
const MODE_ICON: Readonly<Record<ShotKind, string>> = {
  snap: "»",
  aimed: "◎",
  auto: "☰",
};
const RESERVES: readonly ReserveMode[] = ["none", "snap", "aimed", "auto"];
/** Icon shown on each reaction-reserve segment (the descriptive name is in its tooltip). */
const RESERVE_ICON: Readonly<Record<ReserveMode, string>> = {
  none: "⊘",
  snap: "»",
  aimed: "◎",
  auto: "☰",
};
/** Tooltip text for each reaction-reserve segment. */
const RESERVE_TITLE: Readonly<Record<ReserveMode, string>> = {
  none: "Reserve: none — spend every TU this turn (no reaction fire held back)",
  snap: "Reserve: snap — hold back TU for a reaction snap shot on the enemy turn",
  aimed: "Reserve: aimed — hold back TU for a reaction aimed shot on the enemy turn",
  auto: "Reserve: auto — hold back TU for a reaction burst on the enemy turn",
};
/** Icon shown on each carried-item chip, by item kind. */
const ITEM_ICON: Readonly<Record<string, string>> = {
  grenade: "✸",
  smoke: "☁",
  proxMine: "◈",
  scanner: "❂",
  stunRod: "⚡",
  medkit: "✚",
};
const STYLE_ID = "blacksite-hud-style";
const LOG_TAIL = 7;
/** Morale at/above this value reads as "Steady"; below PANIC_THRESHOLD reads as "PANIC". */
const MORALE_STEADY_FLOOR = 67;

/** Signed integer-percent string for strategic deltas: `+5%`, `-12%`, `0%`. */
function signedPercent(delta: number): string {
  if (!Number.isFinite(delta)) return "0%";
  const rounded = Math.round(delta);
  const sign = rounded > 0 ? "+" : "";
  return `${sign}${rounded}%`;
}

/** Semantic tone for a signed strategic delta given which sign is the helpful
 *  direction. Zero (or non-finite) is neutral. */
function deltaTone(delta: number, goodWhenPositive: boolean): "good" | "bad" | "neutral" {
  if (!Number.isFinite(delta) || Math.round(delta) === 0) return "neutral";
  return delta > 0 === goodWhenPositive ? "good" : "bad";
}

const CSS = UI_TOKENS + "\n" + UI_BASE + "\n" + UI_COMPONENTS + "\n" + UI_PRIMITIVES + "\n" + `
:root {
  --hud-cyan: var(--ui-cyan);
  --hud-cyan-soft: rgba(103,232,249,.16);
  --hud-amber: var(--ui-amber);
  --hud-green: var(--ui-green);
  --hud-red: var(--ui-red);
  --hud-text: var(--ui-text);
  --hud-muted: var(--ui-muted);
  --hud-panel: var(--ui-panel);
  --hud-border: var(--ui-border);
}
#hud {
  position: absolute;
  inset: 0;
  z-index: 5;
  pointer-events: none;
  color: var(--hud-text);
  font: 14px/1.45 Inter, ui-sans-serif, system-ui, sans-serif;
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
  font: 700 12px/1.2 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .18em;
  text-transform: uppercase;
}
#hud .muted { color: var(--hud-muted); }
#hud .log,
#hud .unit,
#hud .squad { pointer-events: auto; }
#hud button {
  pointer-events: auto;
  min-height: 38px;
  cursor: pointer;
  color: var(--hud-text);
  border: 1px solid var(--ui-border);
  border-radius: 7px;
  background: linear-gradient(180deg, rgba(34,51,65,.92), rgba(16,26,35,.94));
  font: 700 13px/1.1 ui-monospace, "SF Mono", Menlo, monospace;
  letter-spacing: .04em;
  transition: border-color 120ms ease, background 120ms ease, transform 120ms ease;
}
#hud button:hover:not(:disabled) {
  border-color: var(--ui-border-bright);
  background: linear-gradient(180deg, rgba(40,75,94,.97), rgba(20,44,58,.97));
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
  width: 250px;
  padding: 12px 14px 11px;
}
#hud .mission-row { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; }
#hud .mission h1 { margin: 3px 0 0; font-size: 17px; line-height: 1; letter-spacing: .08em; text-transform: uppercase; }
#hud .turn { color: var(--hud-muted); text-align: right; font: 600 13px/1.35 ui-monospace, monospace; }
#hud .turn b { display: block; color: var(--hud-cyan); font-size: 13px; text-transform: uppercase; }
#hud .mission-meta { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
#hud .chip {
  padding: 4px 8px;
  border: 1px solid var(--ui-border);
  border-radius: 999px;
  color: var(--hud-muted);
  background: rgba(0,0,0,.18);
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#hud .chip.live { color: var(--hud-green); border-color: rgba(74,222,128,.3); }
#hud .chip.enemy { color: var(--hud-red); border-color: rgba(251,113,133,.3); }

#hud .objective {
  top: max(14px, env(safe-area-inset-top));
  left: 50%;
  width: min(440px, calc(100vw - 600px));
  padding: 9px 14px;
  transform: translateX(-50%);
}
#hud .objective-head { display: flex; align-items: center; justify-content: space-between; gap: 14px; }
#hud .objective-title { margin-top: 2px; font-size: 13px; font-weight: 760; letter-spacing: .04em; }
#hud .objective-count { color: var(--hud-amber); font: 800 20px/1 ui-monospace, monospace; white-space: nowrap; }
#hud .objective-track { height: 3px; margin-top: 8px; border-radius: 4px; background: rgba(255,255,255,.07); overflow: hidden; }
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
  width: 300px;
  max-height: 240px;
  padding: 12px 14px;
  overflow-y: auto;
}
#hud .log-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 7px; }
#hud .log .line {
  padding: 4px 0;
  color: var(--ui-muted);
  border-top: 1px solid rgba(255,255,255,.035);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font: 500 13px/1.3 ui-monospace, monospace;
}
#hud .log .line.current { color: var(--ui-text); }

/* Operative card — COMPACT STRIP. At-a-glance only: identity + READY, HP|TU side
   by side, weapon+ammo, a morale pip, a cover pip. Static-per-turn stats
   (accuracy/reactions/vision) live in the DETAILS dossier, not here. width 300
   keeps its right edge (14+300=314) left of the viewport's 20% line (320 at the
   1600 test width) so it never intrudes on the battlefield's central 60% column.
   It shares the left rail with .actions (bottom-anchored); the capped max-heights
   guarantee the two never collide. */
#hud .unit {
  left: max(14px, env(safe-area-inset-left));
  top: 214px;
  width: 300px;
  max-height: calc(50vh - 130px);
  padding: 11px 13px;
  overflow-y: auto;
}
#hud .unit-head { display: flex; align-items: center; gap: 7px; }
#hud .rank-pip {
  flex: 0 0 auto;
  padding: 2px 6px;
  border-radius: 4px;
  color: var(--hud-cyan);
  background: var(--hud-cyan-soft);
  border: 1px solid rgba(103,232,249,.25);
  font: 800 11px/1 ui-monospace, monospace;
  letter-spacing: .05em;
  text-transform: uppercase;
}
#hud .unit-name { flex: 1 1 auto; min-width: 0; margin: 0; font-size: 16px; line-height: 1.1; letter-spacing: .02em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* Morale pip: one dot; tone tints it and it only grows/pulses when shaken/panicking. */
#hud .morale-pip { flex: 0 0 auto; width: 11px; height: 11px; border-radius: 50%; background: var(--hud-green); box-shadow: inset 0 0 0 1px rgba(0,0,0,.35); }
#hud .morale-pip.steady { background: var(--hud-green); }
#hud .morale-pip.shaken { width: 14px; height: 14px; background: var(--hud-amber); }
#hud .morale-pip.panic { width: 14px; height: 14px; background: var(--hud-red); animation: panic-pulse 1s ease-in-out infinite; }
/* Cover pip: shield glyph, shown ONLY when the operative is actually in cover. */
#hud .cover-pip { flex: 0 0 auto; font: 700 14px/1 ui-monospace, monospace; color: var(--hud-green); }
#hud .cover-pip.half { color: var(--hud-amber); }
#hud .cover-pip.full { color: var(--hud-green); }
#hud .cover-pip[hidden] { display: none; }
#hud .unit-badge {
  flex: 0 0 auto;
  padding: 3px 7px;
  border-radius: 5px;
  color: var(--hud-cyan);
  background: var(--hud-cyan-soft);
  border: 1px solid rgba(103,232,249,.25);
  font: 800 11px/1 ui-monospace, monospace;
  letter-spacing: .05em;
}
#hud .unit-badge.spent { color: var(--hud-amber); background: rgba(251,191,36,.12); border-color: rgba(251,191,36,.32); }
#hud .details-btn { flex: 0 0 auto; min-height: 24px; min-width: 24px; padding: 0 7px; font-size: 13px; }
/* HP + TU meters, side by side on one line, numerals beside each bar. */
#hud .unit-meters { display: flex; gap: 12px; margin-top: 10px; }
#hud .unit-meters .meter { flex: 1 1 0; min-width: 0; }
#hud .meter-line { display: flex; align-items: baseline; justify-content: space-between; gap: 6px; margin-bottom: 5px; color: var(--hud-muted); font: 700 11px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .meter-line b { color: var(--hud-text); font-weight: 700; letter-spacing: 0; }
#hud .bar { position: relative; height: 5px; border-radius: 999px; background: rgba(255,255,255,.08); overflow: hidden; }
#hud .bar i { display: block; height: 100%; border-radius: inherit; transition: width 180ms ease; }
/* Reaction-reserve segment: amber hatched overlay sitting flush against the spendable TU. */
#hud .tu-reserve {
  position: absolute;
  top: 0;
  height: 100%;
  border-radius: inherit;
  background: repeating-linear-gradient(45deg, rgba(251,191,36,.78) 0 4px, rgba(251,191,36,.18) 4px 8px);
  transition: width 180ms ease, left 180ms ease;
}
#hud .reserve-tag { color: var(--hud-amber); font-weight: 700; letter-spacing: 0; }
#hud .reserve-tag::before { content: "⚡"; margin-right: 1px; }
#hud .unit-weapon { margin-top: 9px; color: var(--hud-muted); font: 600 12px/1.2 ui-monospace, monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* Action bar — ICON-FIRST DENSE TOOLBAR. Zero label columns (they burned whole
   lines), zero clipped text: every control is an icon (+ a short number); names,
   rounds, hit%, and hotkeys live in tooltips. Docks BOTTOM-left at width 300 so its
   right edge (314) stays left of the viewport's 20% line (320 at 1600) and never
   intrudes on the central 60%. The capped max-height keeps its top below .unit. */
#hud .actions {
  left: max(14px, env(safe-area-inset-left));
  bottom: max(14px, env(safe-area-inset-bottom));
  width: 300px;
  max-height: calc(50vh - 130px);
  overflow-y: auto;
  padding: 11px 13px;
}
/* Move/target preview — one short line, never a two-line banner. */
#hud .move-hint {
  min-height: 18px;
  margin-bottom: 9px;
  color: var(--hud-muted);
  font: 600 12px/1.3 ui-monospace, monospace;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
#hud .move-hint b { color: var(--hud-text); font-weight: 750; }
#hud .move-hint .cost { color: var(--hud-green); font-weight: 800; }
#hud .move-hint.target b { color: var(--hud-amber); }
#hud .move-hint.blocked b { color: var(--hud-red); }

/* Fire modes — icon + TU number on the face; name/rounds/hit% in the tooltip. A
   crosshair hit-chance chip is appended only while a target is previewed. */
#hud .modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
#hud .modes button { min-height: 46px; padding: 6px 4px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px; }
#hud .modes .mode-icon { color: var(--hud-cyan); font-size: 17px; line-height: 1; }
#hud .modes button:disabled .mode-icon { color: var(--hud-muted); }
#hud .modes .mode-tu { font: 800 12px/1 ui-monospace, monospace; letter-spacing: .02em; }
#hud .modes button:disabled .mode-tu { color: var(--hud-muted); }
#hud .modes .chance {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 0 6px;
  border-radius: var(--ui-radius-pill);
  border: 1px solid rgba(251,176,46,.4);
  background: rgba(251,176,46,.1);
  color: var(--hud-amber);
  font: 800 11px/1.5 ui-monospace, monospace;
}
#hud .modes .chance .xhair { color: var(--hud-cyan); font-size: 11px; line-height: 1; }
#hud .modes button:disabled .chance { border-color: var(--ui-border); background: rgba(255,255,255,.04); color: var(--hud-muted); }
#hud .modes button:disabled .chance .xhair { color: var(--hud-muted); }

/* Secondary controls strip: magazine · stance · reaction-reserve segmented · psi. */
#hud .action-strip { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#hud .action-strip button { min-height: 34px; }
#hud .mag-btn { display: inline-flex; align-items: center; gap: 5px; padding: 0 9px; }
#hud .mag-btn .mag-icon { color: var(--hud-cyan); font-size: 14px; line-height: 1; }
#hud .mag-btn .mag-count { font: 800 12px/1 ui-monospace, monospace; }
#hud .mag-btn:disabled .mag-icon { color: var(--hud-muted); }
#hud .stance-btn { min-width: 40px; padding: 0 11px; font-size: 15px; line-height: 1; }
#hud .stance-btn .stance-glyph { color: var(--hud-cyan); }
#hud .stance-btn:disabled .stance-glyph { color: var(--hud-muted); }
/* Reaction reserve as one compact segmented control (icons). */
#hud .reserve { display: inline-flex; border: 1px solid var(--ui-border); border-radius: 7px; overflow: hidden; }
#hud .reserve button { min-height: 34px; min-width: 34px; padding: 0 8px; border: none; border-right: 1px solid var(--ui-border); border-radius: 0; font-size: 14px; line-height: 1; }
#hud .reserve button:last-child { border-right: none; }

/* Carried items — icon chips with a count badge; grenades gain a small PRIME sub-button. */
#hud .items-row { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
#hud .items-stack { display: flex; flex-wrap: wrap; gap: 6px; }
#hud .item-line { display: inline-flex; gap: 3px; }
#hud .item-line button { position: relative; min-height: 38px; min-width: 40px; padding: 0 10px; display: inline-flex; align-items: center; justify-content: center; font-size: 17px; line-height: 1; }
#hud .item-line button.prime { min-width: 26px; padding: 0 6px; font: 800 12px/1 ui-monospace, monospace; }
#hud .item-line .item-count {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  display: grid;
  place-items: center;
  border-radius: 999px;
  background: var(--hud-cyan);
  color: #04121a;
  font: 800 10px/1 ui-monospace, monospace;
  pointer-events: none;
}
#hud .item-line button:disabled .item-count { opacity: .4; }
#hud .items-empty { color: var(--hud-muted); font: 600 13px/1.3 ui-monospace, monospace; padding: 4px 2px; }

/* Psionics — two icon sub-buttons (Panic + Mind Control) that ride the action
   strip. Each pairs a glyph with its TU cost; the MC button reads "SPENT" once the
   per-battle hard cap is used. Full names + reasons live in the tooltip. */
#hud .psi-actions { display: inline-flex; gap: 6px; }
#hud .psi-actions button { min-height: 34px; min-width: 40px; padding: 0 9px; display: inline-flex; align-items: center; gap: 4px; }
#hud .psi-actions .psi-glyph { color: var(--hud-cyan); font-size: 15px; line-height: 1; }
#hud .psi-actions .psi-cost { color: var(--hud-muted); font: 700 11px/1 ui-monospace, monospace; letter-spacing: .02em; }
#hud .psi-actions button:disabled .psi-glyph,
#hud .psi-actions button:disabled .psi-cost { color: var(--hud-muted); }
#hud .psi-actions button.active .psi-glyph { color: #effcff; }
#hud .psi-actions.spent .psi-glyph { color: var(--hud-muted); }

/* Strike-team roster docks bottom-RIGHT. width 300 keeps its left edge
   (1600-14-300=1286) right of the viewport's 80% line (1280 at 1600) so it stays
   clear of the battlefield's central 60% column. */
#hud .squad {
  right: max(14px, env(safe-area-inset-right));
  bottom: 75px;
  width: 300px;
  max-height: calc(100vh - 200px);
  padding: 13px;
  overflow-y: auto;
}
#hud .squad-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
#hud .roster { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
#hud .roster button { min-height: 48px; padding: 7px 9px; text-align: left; }
#hud .roster .roster-top { display: flex; justify-content: space-between; align-items: center; gap: 7px; }
#hud .roster .roster-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
#hud .roster .roster-status { color: var(--hud-green); font-size: 12px; }
#hud .roster .roster-status.spent { color: var(--hud-amber); }
#hud .roster .roster-status.kia { color: var(--hud-red); }
#hud .roster .panic-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 1px 5px;
  border-radius: 3px;
  color: #ffe4e6;
  background: rgba(251,113,133,.22);
  border: 1px solid rgba(251,113,133,.5);
  font: 800 12px/1.2 ui-monospace, monospace;
  letter-spacing: .08em;
  animation: panic-pulse 1s ease-in-out infinite;
}
#hud .roster .roster-bars { display: flex; gap: 3px; height: 3px; margin-top: 6px; }
#hud .roster .roster-bars i { display: block; border-radius: 3px; background: var(--hud-cyan); }
#hud .roster .roster-bars i:last-child { background: var(--hud-green); }

#hud .endturn {
  position: absolute;
  right: max(14px, env(safe-area-inset-right));
  bottom: max(14px, env(safe-area-inset-bottom));
  min-width: 168px;
  min-height: 50px;
  padding: 0 20px;
  text-transform: uppercase;
  letter-spacing: .09em;
}
#hud .endturn.ready { animation: endturn-pulse 1.8s ease-in-out infinite; }
@keyframes endturn-pulse { 50% { box-shadow: 0 0 28px rgba(103,232,249,.35); } }
@keyframes panic-pulse { 50% { opacity: .4; } }

/* Combat toasts ride the shared .ui-toast component (top-center console-glass,
   auto-dismiss, semantic left-border tones). The HUD adds a success tone on top
   of the shared info/warning/danger set to preserve its green "objective met"
   confirmations. Element + timer are owned by notify(); the look is shared. */
#hud .ui-toast {
  text-align: center;
  font-family: var(--ui-font-mono);
  font-weight: 750;
  letter-spacing: .04em;
}
#hud .ui-toast[data-tone='success'] { border-left-color: var(--hud-green); }

#hud .banner,
#hud .briefing,
#hud .dossier {
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
#hud .dossier { z-index: 24; background: radial-gradient(circle at center, rgba(10,25,35,.82), rgba(2,5,8,.96)); }
#hud .banner.show,
#hud .briefing.show,
#hud .dossier.show { display: flex; }
#hud .banner-card,
#hud .briefing-card,
#hud .dossier-card {
  position: relative;
  width: min(720px, 100%);
  overflow: hidden;
  padding: clamp(24px, 5vw, 46px);
  border: 1px solid var(--ui-border-console);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%),
    rgba(5,11,17,.98);
  box-shadow: var(--ui-glow-inner), 0 30px 100px rgba(0,0,0,.55);
}
#hud .dossier-card { width: min(560px, 100%); max-height: calc(100vh - 44px); overflow: auto; }
#hud .briefing-card::before,
#hud .dossier-card::before {
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
#hud .briefing-lede { max-width: 590px; margin: 0; color: var(--ui-muted); font-size: 14px; }
#hud .debrief-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0 4px;
}
#hud .debrief-stat {
  padding: 11px 12px;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner);
}
#hud .debrief-stat span {
  display: block;
  color: var(--hud-muted);
  font: 800 12px/1 ui-monospace, monospace;
  letter-spacing: .12em;
  text-transform: uppercase;
}
#hud .debrief-stat b {
  display: block;
  margin-top: 7px;
  color: var(--hud-text);
  font: 850 14px/1.2 ui-monospace, monospace;
  text-transform: uppercase;
}

/* After-action report body — stacked, left-aligned sections inside the banner card. */
#hud .debrief {
  margin: 18px 0 6px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
#hud .debrief .eyebrow { display: block; }
#hud .debrief-section-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
#hud .debrief-count {
  color: var(--hud-muted);
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}

/* Campaign win/lose strip — makes the terminal banner distinct from a regular debrief. */
#hud .debrief-campaign {
  padding: 12px 14px;
  border-radius: var(--ui-radius-sm);
  border: 1px solid var(--ui-border-console);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner);
}
#hud .debrief-campaign.won { border-color: rgba(74,222,128,.45); background: rgba(74,222,128,.07); }
#hud .debrief-campaign.lost { border-color: rgba(251,113,133,.45); background: rgba(251,113,133,.07); }
#hud .debrief-campaign.won .eyebrow { color: var(--hud-green); }
#hud .debrief-campaign.lost .eyebrow { color: var(--hud-red); }
#hud .debrief-campaign-line { margin-top: 5px; color: var(--ui-text); font: 600 13px/1.35 ui-monospace, monospace; }

/* Loot bar — four resource chips, each a glyph + amount + label. */
#hud .debrief-loot-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 7px; margin-top: 8px; }
#hud .loot-chip {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 9px 10px;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-raised);
  box-shadow: var(--ui-glow-inner);
}
#hud .loot-chip.zero { opacity: .38; }
#hud .loot-glyph {
  flex: 0 0 auto;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  border-radius: var(--ui-radius-sm);
  font: 800 15px/1 ui-monospace, monospace;
}
#hud .loot-chip.credits .loot-glyph { color: var(--hud-amber); background: rgba(251,191,36,.14); }
#hud .loot-chip.alloys .loot-glyph { color: #cbd5e1; background: rgba(203,213,225,.12); }
#hud .loot-chip.elerium .loot-glyph { color: var(--hud-green); background: rgba(74,222,128,.14); }
#hud .loot-chip.alienData .loot-glyph { color: var(--hud-cyan); background: rgba(103,232,249,.14); }
#hud .loot-chip b { display: block; font: 850 15px/1 ui-monospace, monospace; }
#hud .loot-chip small {
  display: block;
  margin-top: 4px;
  color: var(--hud-muted);
  font: 700 12px/1 ui-monospace, monospace;
  letter-spacing: .1em;
  text-transform: uppercase;
}

/* Score + strategic meta row. */
#hud .debrief-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
#hud .debrief-meta .rating {
  display: inline-block;
  margin-top: 6px;
  padding: 2px 7px;
  border-radius: 4px;
  font: 800 12px/1.2 ui-monospace, monospace;
  letter-spacing: .08em;
  text-transform: uppercase;
}
#hud .debrief-meta .rating.excellent { color: var(--hud-green); background: rgba(74,222,128,.14); }
#hud .debrief-meta .rating.good { color: var(--hud-cyan); background: rgba(103,232,249,.12); }
#hud .debrief-meta .rating.fair { color: var(--hud-amber); background: rgba(251,191,36,.12); }
#hud .debrief-meta .rating.poor { color: var(--hud-red); background: rgba(251,113,133,.14); }

/* Signed strategic-delta chips. The value colour carries the direction (green =
   good, red = worse, muted = no change); a thin left accent reinforces it. */
#hud .debrief-stat.delta { border-left-width: 3px; }
#hud .debrief-stat.delta.good { border-left-color: rgba(74,222,128,.55); }
#hud .debrief-stat.delta.bad { border-left-color: rgba(251,113,133,.55); }
#hud .debrief-stat.delta.neutral { border-left-color: var(--ui-border-console); }
#hud .debrief-stat.delta.good b { color: var(--hud-green); }
#hud .debrief-stat.delta.bad b { color: var(--hud-red); }
#hud .debrief-stat.delta.neutral b { color: var(--hud-muted); }

/* Objective checklist — one row per mission goal, done/pending marker + label. */
#hud .debrief-objectives { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
#hud .debrief-objectives li {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 9px 12px;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner);
}
#hud .debrief-objectives li.done { border-color: rgba(74,222,128,.28); }
#hud .debrief-objectives .obj-mark { flex: 0 0 auto; font: 800 14px/1 ui-monospace, monospace; }
#hud .debrief-objectives li.done .obj-mark { color: var(--hud-green); }
#hud .debrief-objectives li.pending .obj-mark { color: var(--hud-muted); }
#hud .debrief-objectives .obj-label { color: var(--ui-text); font: 600 13px/1.4 ui-monospace, monospace; }
#hud .debrief-objectives li.pending .obj-label { color: var(--hud-muted); }

/* Roster lists (KIA + survivors). */
#hud .debrief-roster { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px; }
#hud .debrief-roster li {
  padding: 10px 12px;
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  background: var(--ui-panel-glass);
  box-shadow: var(--ui-glow-inner);
}
#hud .debrief-roster li.kia { border-color: rgba(251,113,133,.28); background: rgba(251,113,133,.05); }
#hud .debrief-soldier-line { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
#hud .debrief-soldier-name { font: 750 13px/1.2 ui-monospace, monospace; letter-spacing: .02em; }
#hud .debrief-rank { color: var(--hud-cyan); font: 700 12px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
#hud .debrief-bio { margin-top: 5px; color: var(--hud-muted); font: 500 13px/1.45 ui-monospace, monospace; }
#hud .debrief-tag { margin-top: 6px; font: 800 12px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .debrief-tag.kia { color: var(--hud-red); }
#hud .debrief-tag.wounded { color: var(--hud-amber); }
#hud .debrief-tag.promoted { color: var(--hud-green); }
#hud .debrief-growth { margin-top: 7px; display: flex; flex-wrap: wrap; gap: 5px; }
#hud .debrief-growth span {
  padding: 2px 7px;
  border-radius: 4px;
  color: var(--hud-green);
  background: rgba(74,222,128,.12);
  font: 700 12px/1.2 ui-monospace, monospace;
  letter-spacing: .03em;
}
#hud .debrief-empty {
  padding: 10px 12px;
  border: 1px dashed var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  color: var(--hud-muted);
  font: 600 13px/1.3 ui-monospace, monospace;
}
#hud .briefing-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 26px 0; }
#hud .briefing-step { padding: 13px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(0,0,0,.14); }
#hud .briefing-step b { display: block; margin: 5px 0; font-size: 15px; text-transform: uppercase; }
#hud .briefing-step p { margin: 0; color: var(--hud-muted); font-size: 14px; }
#hud .briefing-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
#hud .briefing-actions span { color: var(--hud-muted); font: 600 12px/1.45 ui-monospace, monospace; }
#hud .briefing-actions button,
#hud .banner button { min-width: 174px; padding: 0 18px; }
#hud .banner-actions { display: flex; gap: 10px; justify-content: center; margin-top: 6px; }
#hud .banner-card { text-align: center; }
#hud .banner.win h1 { color: var(--hud-green); }
#hud .banner.lose h1 { color: var(--hud-red); }
#hud .banner.campaign-win .banner-card { border-color: rgba(74,222,128,.5); box-shadow: 0 30px 120px rgba(74,222,128,.16), 0 30px 100px rgba(0,0,0,.55); }
#hud .banner.campaign-lose .banner-card { border-color: rgba(251,113,133,.55); box-shadow: 0 30px 120px rgba(251,113,133,.16), 0 30px 100px rgba(0,0,0,.55); }

/* Debrief mode — the after-action report is the dominant screen, not a compact
   banner. Widen the card, fill the height, and let the report body scroll while the
   title and the single CONTINUE action stay pinned. */
#hud .banner.debrief-mode { padding: clamp(16px, 3vh, 34px); }
#hud .banner.debrief-mode .banner-card {
  width: min(940px, 100%);
  max-height: calc(100vh - clamp(32px, 6vh, 68px));
  padding: clamp(20px, 3.4vw, 38px);
  display: flex;
  flex-direction: column;
  text-align: left;
}
#hud .banner.debrief-mode .banner-card > .eyebrow { text-align: left; }
#hud .banner.debrief-mode h1 { margin: 6px 0 8px; font-size: clamp(28px, 4.4vw, 44px); text-align: left; }
#hud .banner.debrief-mode .briefing-lede { max-width: none; text-align: left; }
/* The report body is the scrollable region; title above and actions below are fixed. */
#hud .banner.debrief-mode .banner-report {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}
#hud .banner.debrief-mode .banner-actions { margin-top: 16px; flex: 0 0 auto; justify-content: flex-end; }

/* Soldier dossier (details overlay). */
#hud .dossier h2 { margin: 4px 0 0; font-size: 26px; line-height: 1; letter-spacing: .03em; }
#hud .dossier .rank { margin-top: 6px; color: var(--hud-cyan); font: 700 13px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
#hud .dossier-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin: 18px 0; }
#hud .dossier-section { margin-top: 14px; }
#hud .dossier-section > .eyebrow { margin-bottom: 7px; }
#hud .dossier ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
#hud .dossier li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 9px; border: 1px solid rgba(255,255,255,.06); border-radius: 6px; background: rgba(0,0,0,.18); font: 600 13px/1.3 ui-monospace, monospace; }
#hud .dossier li small { color: var(--hud-muted); }
#hud .dossier-actions { display: flex; justify-content: flex-end; margin-top: 18px; }
#hud .dossier-actions button { min-width: 130px; }

@media (max-width: 1120px) {
  #hud .objective, #hud .log { display: none; }
  /* Keep the action controls bottom-left (never centered) and tighten the rail. */
  #hud .actions { width: 288px; }
  #hud .unit { width: 288px; }
  #hud .squad { width: 288px; }
}
@media (max-width: 820px) {
  #hud .mission { width: 226px; padding: 11px 12px; }
  #hud .mission h1 { font-size: 14px; }
  #hud .mission-meta .chip:last-child { display: none; }
  #hud .tools button { min-width: 38px; width: 38px; padding: 0; }
  #hud .squad { display: none; }
  #hud .unit {
    top: auto;
    right: max(10px, env(safe-area-inset-right));
    bottom: max(10px, env(safe-area-inset-bottom));
    width: auto;
    max-height: calc(100vh - 40px);
    padding: 11px 152px 11px 12px;
  }
  #hud .unit-name { font-size: 15px; }
  #hud .unit-weapon { display: none; }
  #hud .actions {
    left: max(10px, env(safe-area-inset-left));
    right: max(10px, env(safe-area-inset-right));
    bottom: 146px;
    width: auto;
    max-height: none;
    padding: 10px;
  }
  #hud .action-strip,
  #hud .items-row { display: none; }
  #hud .modes { margin-top: 7px; }
  #hud .modes button { min-height: 48px; }
  #hud .endturn { right: 20px; bottom: 36px; min-width: 124px; min-height: 46px; font-size: 12px; }
  #hud .briefing-grid { grid-template-columns: 1fr; }
  #hud .briefing-step { padding: 10px 12px; }
  #hud .briefing-actions { align-items: stretch; flex-direction: column; }
  #hud .briefing-actions button { width: 100%; }
  #hud .debrief-loot-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  #hud .dossier-stats { grid-template-columns: repeat(2, 1fr); }
}
@media (max-height: 660px) {
  #hud .log, #hud .squad { display: none; }
  #hud .unit { padding-top: 9px; padding-bottom: 9px; }
  #hud .unit-weapon { display: none; }
  #hud .briefing-card { padding-top: 24px; padding-bottom: 24px; }
  #hud .briefing-grid { margin: 16px 0; }
}
/* Respect prefers-reduced-motion: kill the ambient pulses (end-turn ready glow,
   panic throb) and collapse the hover/transition tweens. Combat feedback (toast
   appear/disappear) still functions, just instantly. */
@media (prefers-reduced-motion: reduce) {
  #hud .endturn.ready,
  #hud .morale-pip.panic,
  #hud .roster .panic-tag { animation: none !important; }
  #hud button,
  #hud .bar i,
  #hud .tu-reserve { transition: none !important; }
}
`;

// ---------------------------------------------------------------------------
// Pure helpers (exported for vitest). TU math mirrors src/sim/battle.ts exactly
// so the HUD's disabled-state and the sim's rejection reasons always agree.
// ---------------------------------------------------------------------------

/** A consumable-item action the HUD can raise. */
export type ItemActionKind = "throw" | "use" | "prime";

/**
 * TU cost of an item action. Throw/Use charge the full `tuPercent`; priming a
 * grenade costs half (mirrors `executePrimeItem` in src/sim/battle.ts).
 */
export function itemActionTuCost(
  maxTu: number,
  tuPercent: number,
  action: ItemActionKind,
): number {
  const factor = action === "prime" ? 0.5 : 1;
  return Math.ceil((maxTu * tuPercent * factor) / 100);
}

/**
 * TU a unit holds back for its reaction-reserve mode (mirrors the controller's
 * `reservedTu`). Returns 0 for "none" or when the reserved mode is absent.
 */
export function reservedTuForReserve(
  maxTu: number,
  reserve: ReserveMode,
  weapon: Weapon | undefined,
): number {
  if (reserve === "none") return 0;
  const mode = weapon?.modes.find((candidate) => candidate.kind === reserve);
  return mode ? Math.ceil((maxTu * mode.tuPercent) / 100) : 0;
}

export type MoraleTone = "steady" | "shaken" | "panic";

export interface MoraleRead {
  tone: MoraleTone;
  /** Short text label — always shown alongside the numeric value (never colour alone). */
  label: string;
}

/**
 * Maps a 0..100 morale value to its tone + label. At/below the panic threshold
 * the unit is PANIC; below the steady floor it is Shaken; otherwise Steady.
 * A missing morale (units that opt out of the system) reads as Steady.
 */
export function moraleState(morale: number | undefined): MoraleRead {
  const value = morale ?? MORALE.MAX;
  if (value <= MORALE.PANIC_THRESHOLD) return { tone: "panic", label: "PANIC" };
  if (value < MORALE_STEADY_FLOOR) return { tone: "shaken", label: "Shaken" };
  return { tone: "steady", label: "Steady" };
}

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
  private readonly rankPip: HTMLSpanElement;
  private readonly weaponEl: HTMLDivElement;
  private readonly unitBadge: HTMLSpanElement;
  private readonly tuFill: HTMLElement;
  private readonly tuReserve: HTMLElement;
  private readonly tuText: HTMLElement;
  private readonly reserveTag: HTMLSpanElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  /** Morale as a single colour pip; tooltip carries value + state. It only grows/
   *  pulses when the operative is shaken or panicking. */
  private readonly moralePip: HTMLSpanElement;
  /** Cover shield glyph — shown ONLY when the operative is actually in cover. */
  private readonly coverPip: HTMLSpanElement;
  private readonly detailsButton: HTMLButtonElement;
  /** Single-line move/target hint (replaces the old two-line context banner). */
  private readonly contextHint: HTMLDivElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly modeButtons = new Map<ShotKind, HTMLButtonElement>();
  private readonly reserveButtons = new Map<ReserveMode, HTMLButtonElement>();
  private readonly itemsRow: HTMLDivElement;
  private readonly itemsStack: HTMLDivElement;
  private readonly stanceButton: HTMLButtonElement;
  private readonly psiRow: HTMLDivElement;
  private readonly psiPanicButton: HTMLButtonElement;
  private readonly psiMcButton: HTMLButtonElement;
  private readonly rosterEl: HTMLDivElement;
  private readonly logEl: HTMLElement;
  private readonly endTurn: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly abortButton: HTMLButtonElement;
  /** The live toast node (null between notifications). Fresh element per notify so
   *  the shared .ui-toast enter/exit animation replays; removed by its own timer. */
  private toastEl: HTMLDivElement | null = null;
  private readonly banner: HTMLDivElement;
  private readonly bannerEye: HTMLDivElement;
  private readonly bannerTitle: HTMLHeadingElement;
  private readonly bannerCopy: HTMLParagraphElement;
  private readonly bannerReport: HTMLDivElement;
  private readonly bannerReturnBtn: HTMLButtonElement;
  private readonly bannerNewCampaignBtn: HTMLButtonElement;
  private readonly briefing: HTMLDivElement;
  private briefingTitle!: HTMLHeadingElement;
  private briefingLede!: HTMLParagraphElement;
  private readonly dossier: HTMLDivElement;
  private readonly dossierName: HTMLHeadingElement;
  private readonly dossierRank: HTMLDivElement;
  private readonly dossierStats: HTMLDivElement;
  private readonly dossierWeapon: HTMLDivElement;
  private readonly dossierItems: HTMLUListElement;
  private readonly dossierCareerSection: HTMLDivElement;
  private readonly dossierCareer: HTMLDivElement;

  private activeMode: ShotKind = "snap";
  /** Armed psi-targeting kind (null = not targeting). Drives the active sub-button. */
  private activePsi: PsiKind | null = null;
  private toastTimer: number | null = null;
  private abortConfirmTimer: number | null = null;
  private detailsOpen = false;
  private disposed = false;
  /** Last update() args, cached so the dossier can re-render on toggle without a controller round-trip. */
  private lastState: BattleState | null = null;
  private lastSelected: Unit | null = null;
  private lastRuntime: HudRuntime | null = null;

  private readonly onKeydown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    // ESC dismisses the dossier first; stopImmediatePropagation keeps the
    // controller's ESC (deselect / briefing) from also firing while it is open.
    if (this.detailsOpen) {
      this.closeDossier();
      e.stopImmediatePropagation();
      e.preventDefault();
    }
  };

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
    ironman.title = "Ironman mode — a single auto-save, no save-scumming";
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
    this.muteButton.setAttribute("aria-label", "Toggle audio");
    this.muteButton.setAttribute("aria-pressed", "false");
    this.muteButton.addEventListener("click", () => {
      const muted = this.cb.onToggleMute();
      this.setMuted(muted);
    });
    this.abortButton = el("button");
    this.abortButton.textContent = "ABORT";
    this.abortButton.title = "Abort operation and return to Earth Command";
    this.abortButton.setAttribute("aria-label", "Abort operation");
    this.abortButton.addEventListener("click", () => this.requestAbort());
    tools.append(help, this.muteButton, this.abortButton);
    this.root.appendChild(tools);

    this.logEl = el("section", "panel log");
    this.root.appendChild(this.logEl);

    const unit = el("section", "panel unit");

    // Head row: rank pip · name · morale pip · cover pip · READY badge · details.
    const head = el("div", "unit-head");
    this.rankPip = el("span", "rank-pip");
    this.rankPip.textContent = "OP";
    this.nameEl = el("h2", "unit-name");
    this.moralePip = el("span", "morale-pip steady");
    this.coverPip = el("span", "cover-pip");
    this.coverPip.textContent = "⛨";
    this.coverPip.hidden = true;
    this.unitBadge = el("span", "unit-badge");
    this.detailsButton = el("button", "details-btn");
    this.detailsButton.textContent = "i";
    this.detailsButton.title = "Open operative dossier — accuracy, reactions, vision & career (ESC closes)";
    this.detailsButton.setAttribute("aria-label", "Open operative dossier");
    this.detailsButton.addEventListener("click", () => this.toggleDossier());
    head.append(
      this.rankPip,
      this.nameEl,
      this.moralePip,
      this.coverPip,
      this.unitBadge,
      this.detailsButton,
    );
    unit.appendChild(head);

    // Meters row: HP and TU side by side, numerals beside each bar.
    const meters = el("div", "unit-meters");
    const hpMeter = el("div", "meter");
    const hpLine = el("div", "meter-line");
    hpLine.append(document.createTextNode("HP"));
    this.hpText = el("b");
    hpLine.appendChild(this.hpText);
    const hpBar = el("div", "bar");
    this.hpFill = el("i");
    hpBar.appendChild(this.hpFill);
    hpMeter.append(hpLine, hpBar);

    const tuMeter = el("div", "meter");
    const tuLine = el("div", "meter-line");
    tuLine.append(document.createTextNode("TU"));
    const tuRight = el("span");
    this.tuText = el("b");
    this.reserveTag = el("span", "reserve-tag");
    tuRight.append(this.tuText, document.createTextNode(" "), this.reserveTag);
    tuLine.appendChild(tuRight);
    const tuBar = el("div", "bar");
    this.tuFill = el("i");
    this.tuFill.style.background = "linear-gradient(90deg,#22d3ee,#67e8f9)";
    this.tuReserve = el("i", "tu-reserve");
    tuBar.append(this.tuFill, this.tuReserve);
    tuMeter.append(tuLine, tuBar);

    meters.append(hpMeter, tuMeter);
    unit.appendChild(meters);

    // Weapon + ammo count (one quiet line).
    this.weaponEl = el("div", "unit-weapon");
    unit.appendChild(this.weaponEl);

    this.root.appendChild(unit);

    const actions = el("section", "panel actions");

    // Move/target preview — one short line (built in updateContext).
    this.contextHint = el("div", "move-hint");
    actions.appendChild(this.contextHint);

    // Fire modes — icon + TU number on the face (built in updateModeButtons).
    const modes = el("div", "modes");
    for (const kind of MODES) {
      const button = el("button");
      button.dataset.kind = kind;
      button.addEventListener("click", () => this.cb.onSelectMode(kind));
      this.modeButtons.set(kind, button);
      modes.appendChild(button);
    }
    actions.appendChild(modes);

    // Secondary controls strip: magazine · stance · reaction reserve · psionics.
    const strip = el("div", "action-strip");

    // Magazine — ammo icon + count; click reloads, TU + hotkey live in the tooltip.
    this.reloadButton = el("button", "mag-btn");
    this.reloadButton.addEventListener("click", () => this.cb.onReload());
    strip.appendChild(this.reloadButton);

    // Stance — icon toggle (glyph reflects stand/kneel; detail + TU in the tooltip).
    this.stanceButton = el("button", "stance-btn");
    this.stanceButton.addEventListener("click", () => {
      const sel = this.lastSelected;
      if (!sel) return;
      const current: UnitStance = sel.stance ?? "stand";
      this.cb.onSetStance?.(current === "stand" ? "kneel" : "stand");
    });
    strip.appendChild(this.stanceButton);

    // Reaction reserve — one compact segmented control of icon buttons; each icon's
    // name + effect lives in its tooltip so no label column is needed.
    const reserve = el("div", "reserve");
    for (const mode of RESERVES) {
      const button = el("button");
      button.dataset.reserve = mode;
      button.textContent = RESERVE_ICON[mode];
      button.title = RESERVE_TITLE[mode];
      button.setAttribute("aria-label", RESERVE_TITLE[mode]);
      button.addEventListener("click", () => this.cb.onSetReserve(mode));
      this.reserveButtons.set(mode, button);
      reserve.appendChild(button);
    }
    strip.appendChild(reserve);

    // Psionics — two icon sub-buttons (Panic + Mind Control). The whole group is
    // hidden unless the selected operative has psi skill; the armed/spent state is
    // never colour-only (MC reads "SPENT" and the reason is in the tooltip). TU
    // costs + availability arrive via runtime.psi (controller owns the tuning).
    this.psiRow = el("div", "psi-actions");
    this.psiPanicButton = el("button");
    this.psiPanicButton.dataset.kind = "panic";
    this.psiPanicButton.addEventListener("click", () => this.cb.onPsiAttack?.("panic"));
    this.psiMcButton = el("button");
    this.psiMcButton.dataset.kind = "mindControl";
    this.psiMcButton.addEventListener("click", () => this.cb.onPsiAttack?.("mindControl"));
    this.psiRow.append(this.psiPanicButton, this.psiMcButton);
    strip.appendChild(this.psiRow);

    actions.appendChild(strip);

    // Carried items — icon chips with a count badge (built in updateItemButtons).
    this.itemsRow = el("div", "items-row");
    this.itemsStack = el("div", "items-stack");
    this.itemsRow.appendChild(this.itemsStack);
    actions.appendChild(this.itemsRow);
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

    this.endTurn = el("button", "endturn ui-cta");
    this.endTurn.textContent = "End turn [Enter]";
    this.endTurn.addEventListener("click", () => this.cb.onEndTurn());
    this.root.appendChild(this.endTurn);


    this.banner = el("div", "banner");
    const bannerCard = el("div", "banner-card");
    this.bannerEye = el("div", "eyebrow");
    this.bannerEye.textContent = "Operation complete";
    this.bannerTitle = el("h1");
    this.bannerCopy = el("p", "briefing-lede");
    this.bannerCopy.textContent = "Mission report transmitted to base command.";
    this.bannerReport = el("div", "banner-report");
    this.bannerReport.hidden = true;
    const bannerActions = el("div", "banner-actions");
    this.bannerReturnBtn = el("button");
    this.bannerReturnBtn.textContent = "Continue";
    this.bannerReturnBtn.title = "Dismiss the after-action report and return to base command";
    this.bannerReturnBtn.addEventListener("click", () => this.cb.onReturnToBase());
    this.bannerNewCampaignBtn = el("button");
    this.bannerNewCampaignBtn.textContent = "New Campaign";
    this.bannerNewCampaignBtn.title = "Start a fresh campaign from the geoscape";
    this.bannerNewCampaignBtn.addEventListener("click", () =>
      (this.cb.onNewCampaign ?? this.cb.onReturnToBase)(),
    );
    bannerActions.append(this.bannerReturnBtn, this.bannerNewCampaignBtn);
    bannerCard.append(
      this.bannerEye,
      this.bannerTitle,
      this.bannerCopy,
      this.bannerReport,
      bannerActions,
    );
    this.banner.appendChild(bannerCard);
    this.root.appendChild(this.banner);

    this.briefing = this.buildBriefing();
    this.root.appendChild(this.briefing);

    this.dossier = el("div", "dossier");
    this.dossierName = el("h2");
    this.dossierRank = el("div", "rank");
    this.dossierStats = el("div", "dossier-stats");
    this.dossierWeapon = el("div");
    const dossierItemsSection = el("div", "dossier-section");
    const itemsEye = el("div", "eyebrow");
    itemsEye.textContent = "Carried items";
    this.dossierItems = el("ul");
    dossierItemsSection.append(itemsEye, this.dossierItems);
    this.dossierCareerSection = el("div", "dossier-section");
    const careerEye = el("div", "eyebrow");
    careerEye.textContent = "Career";
    this.dossierCareer = el("div", "dossier-stats");
    this.dossierCareerSection.append(careerEye, this.dossierCareer);
    const dossierActions = el("div", "dossier-actions");
    const dossierClose = el("button");
    dossierClose.textContent = "Close [ESC]";
    dossierClose.addEventListener("click", () => this.closeDossier());
    dossierActions.appendChild(dossierClose);
    this.dossier.append(
      this.buildDossierCard([
        this.dossierName,
        this.dossierRank,
        this.dossierStats,
        this.dossierWeapon,
        dossierItemsSection,
        this.dossierCareerSection,
        dossierActions,
      ]),
    );
    this.root.appendChild(this.dossier);

    window.addEventListener("keydown", this.onKeydown);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.root);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener("keydown", this.onKeydown);
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    if (this.abortConfirmTimer !== null) window.clearTimeout(this.abortConfirmTimer);
    this.root.remove();
  }

  setMode(kind: ShotKind): void {
    this.activeMode = kind;
    for (const [mode, button] of this.modeButtons) {
      button.classList.toggle("active", mode === kind);
    }
  }

  /** Arm/disarm psi-targeting mode; the chosen sub-button highlights on next render. */
  setPsiTargeting(kind: PsiKind | null): void {
    this.activePsi = kind;
  }

  setMuted(muted: boolean): void {
    this.muteButton.classList.toggle("active", muted);
    this.muteButton.textContent = muted ? "MUTE" : "SFX";
    this.muteButton.setAttribute("aria-pressed", String(muted));
    this.muteButton.setAttribute("aria-label", muted ? "Unmute audio" : "Mute audio");
  }

  toggleBriefing(force?: boolean): void {
    const show = force ?? !this.briefing.classList.contains("show");
    this.briefing.classList.toggle("show", show);
  }

  isBriefingOpen(): boolean {
    return this.briefing.classList.contains("show");
  }

  isDossierOpen(): boolean {
    return this.detailsOpen;
  }

  notify(message: string, tone: ToastTone = "info"): void {
    if (this.toastTimer !== null) window.clearTimeout(this.toastTimer);
    // A fresh element per call replays the shared .ui-toast enter/exit animation
    // (the CSS is not `.show`-gated, so reusing one node would fire once and stick).
    if (this.toastEl) this.toastEl.remove();
    const toast = el("div", "ui-toast");
    toast.setAttribute("role", "status");
    toast.dataset.tone = tone; // info | success | danger — drives the left-border accent
    toast.textContent = message;
    this.toastEl = toast;
    this.root.appendChild(toast);
    // CSS drives the fade-out (~3.6s). This timer just reaps the node afterwards.
    this.toastTimer = window.setTimeout(() => {
      if (this.toastEl === toast) {
        toast.remove();
        this.toastEl = null;
      }
      this.toastTimer = null;
    }, 4000);
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

  private toggleDossier(): void {
    if (this.detailsOpen) this.closeDossier();
    else this.openDossier();
  }

  private openDossier(): void {
    this.detailsOpen = true;
    if (this.lastSelected) this.cb.onOpenSoldierDetail?.(this.lastSelected.id);
    this.renderDossier(this.lastSelected, this.lastState, this.lastRuntime);
  }

  private closeDossier(): void {
    this.detailsOpen = false;
    this.dossier.classList.remove("show");
  }

  update(
    state: BattleState,
    selected: Unit | null,
    hover: HudHover | null,
    runtime: HudRuntime,
  ): void {
    this.lastState = state;
    this.lastSelected = selected;
    this.lastRuntime = runtime;

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
    this.themeChip.title = "Mission terrain — shapes cover, lighting, and tile types";
    this.themeChip.classList.toggle("enemy", enemyTurn);
    this.themeChip.classList.toggle("live", !enemyTurn);
    this.seedChip.textContent = `Seed ${runtime.seed}`;
    this.seedChip.title = `Deterministic battle seed (${runtime.seed}) — same seed reproduces this map`;
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
    this.updateStanceButton(state, selected, runtime);
    this.updatePsiButtons(selected, runtime);
    this.updateReserveButtons(selected, runtime);
    this.updateItemButtons(state, selected, runtime);
    this.renderRoster(players, selected, runtime);
    this.renderLog(state);
    this.updateBanner(state, runtime);
    this.renderDossier(selected, state, runtime);
    this.setMuted(runtime.muted);
    this.abortButton.disabled = runtime.busy || state.status !== "playing";
    if (this.abortButton.disabled) this.clearAbortConfirm();

    const allSpent = livingPlayers.every((unit) => unit.tu <= 0);
    this.endTurn.disabled = runtime.busy || enemyTurn || state.status !== "playing";
    this.endTurn.classList.toggle("ready", allSpent && !this.endTurn.disabled);
    this.endTurn.textContent = runtime.busy ? "Resolving..." : "End turn [Enter]";
  }

  private updateUnit(state: BattleState, selected: Unit | null): void {
    this.detailsButton.disabled = !selected;
    if (!selected) {
      this.rankPip.textContent = "OP";
      this.rankPip.title = "";
      this.nameEl.textContent = "No operative";
      this.nameEl.title = "";
      this.weaponEl.textContent = "Select a squad member";
      this.weaponEl.title = "";
      this.unitBadge.textContent = "--";
      this.unitBadge.className = "unit-badge";
      this.tuFill.style.width = "0%";
      this.tuReserve.style.width = "0%";
      this.hpFill.style.width = "0%";
      this.tuText.textContent = "--";
      this.reserveTag.textContent = "";
      this.hpText.textContent = "--";
      this.moralePip.className = "morale-pip steady";
      this.moralePip.title = "";
      this.coverPip.hidden = true;
      return;
    }

    // Rank pip: an abbreviated role tag (full role in the tooltip).
    const role = titleCase(selected.templateId);
    this.rankPip.textContent = selected.templateId.slice(0, 3).toUpperCase();
    this.rankPip.title = role;
    this.nameEl.textContent = selected.name;
    this.nameEl.title = `${selected.name} · ${role}`;

    const weapon = state.weapons[selected.weaponId];
    this.weaponEl.textContent = weapon
      ? `${weapon.name} · ${selected.ammo}/${weapon.magazineSize}`
      : selected.weaponId;
    this.weaponEl.title = weapon
      ? `${weapon.name} — ${selected.ammo}/${weapon.magazineSize} rounds loaded`
      : selected.weaponId;

    const ready = selected.tu > 0;
    this.unitBadge.textContent = ready ? "READY" : "SPENT";
    this.unitBadge.className = ready ? "unit-badge" : "unit-badge spent";
    this.unitBadge.title = ready ? "Operative has time units left" : "Operative has spent its turn";

    // TU bar: spendable cyan fill + amber hatched reaction-reserve segment.
    const maxTu = selected.stats.timeUnits;
    const reserve = reservedTuForReserve(maxTu, selected.reserve, weapon);
    const free = Math.max(0, selected.tu - reserve);
    const freePct = percent(free, maxTu);
    const reserveShown = Math.max(0, Math.min(reserve, selected.tu));
    this.tuFill.style.width = `${freePct}%`;
    this.tuReserve.style.left = `${freePct}%`;
    this.tuReserve.style.width = `${percent(reserveShown, maxTu)}%`;
    this.tuText.textContent = `${selected.tu}/${maxTu}`;
    if (reserve > 0) {
      this.reserveTag.textContent = `${reserve}`;
      this.reserveTag.title = `${reserve} TU held back for ${selected.reserve} reaction fire`;
    } else {
      this.reserveTag.textContent = "";
      this.reserveTag.title = "";
    }

    const hpPct = percent(selected.hp, selected.stats.health);
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background =
      hpPct >= 60 ? "#4ade80" : hpPct >= 30 ? "#fbbf24" : "#fb7185";
    this.hpText.textContent = `${selected.hp}/${selected.stats.health}`;

    // Morale pip: one colour dot; value + state live in the tooltip. It only grows/
    // pulses when the operative is shaken or panicking (see CSS).
    const moraleValue = selected.morale ?? MORALE.MAX;
    const read = moraleState(selected.morale);
    this.moralePip.className = `morale-pip ${read.tone}`;
    this.moralePip.title = `Morale ${moraleValue}/100 — ${read.label}`;

    this.renderCoverPip(state, selected);
  }

  /**
   * Cover shield pip for the unit head. Cover is measured against the nearest
   * hostile the squad can see; the pip appears ONLY when the operative actually
   * holds half or full cover (hidden when exposed or no hostile is visible).
   */
  private renderCoverPip(state: BattleState, selected: Unit): void {
    // Directional cover: only the tile sitting between the operative and the
    // nearest visible shooter protects them (see sim coverDefenseFor).
    const visEnemies = visibleEnemyIds(state, "player");
    let nearest: Unit | null = null;
    let nearestDist = Infinity;
    for (const candidate of state.units) {
      if (!candidate.alive || candidate.faction === "player") continue;
      if (!visEnemies.has(candidate.id)) continue;
      const dist = Math.max(
        Math.abs(candidate.pos.x - selected.pos.x),
        Math.abs(candidate.pos.y - selected.pos.y),
      );
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = candidate;
      }
    }

    if (!nearest) {
      this.coverPip.hidden = true;
      return;
    }
    const cover = coverDefenseFor(state.grid, selected.pos, nearest.pos);
    if (cover === 0) {
      this.coverPip.hidden = true;
      return;
    }
    const read = this.coverReadout(cover);
    this.coverPip.hidden = false;
    this.coverPip.className = `cover-pip ${read.cls}`;
    this.coverPip.title = `In ${read.label.toLowerCase()} cover vs ${nearest.name}`;
  }

  /** Maps a directional cover value to its label + colour class. */
  private coverReadout(cover: 0 | 1 | 2): { label: string; cls: string } {
    if (cover === 2) return { label: "Full", cls: "full" };
    if (cover === 1) return { label: "Half", cls: "half" };
    return { label: "Exposed", cls: "exposed" };
  }

  private updateStanceButton(
    state: BattleState,
    selected: Unit | null,
    runtime: HudRuntime,
  ): void {
    const stance: UnitStance = selected?.stance ?? "stand";
    // Icon-only face: the glyph reflects the CURRENT stance; the toggle direction,
    // effect, and TU cost live in the tooltip (see the [K] hotkey too).
    const glyph = el("span", "stance-glyph");
    glyph.textContent = stance === "kneel" ? "▄" : "█";
    this.stanceButton.replaceChildren(glyph);
    this.stanceButton.setAttribute(
      "aria-label",
      stance === "kneel" ? "Stand up" : "Kneel",
    );

    const insufficientTu = !!selected && selected.tu < STANCE.TOGGLE_TU;
    this.stanceButton.disabled =
      !selected ||
      runtime.busy ||
      state.activeFaction !== "player" ||
      state.status !== "playing" ||
      insufficientTu;
    // Kneeling reads as a braced/active state.
    this.stanceButton.classList.toggle("active", stance === "kneel");
    this.stanceButton.title = !selected
      ? "Select an operative"
      : state.activeFaction !== "player"
        ? "Not your turn"
        : state.status !== "playing"
          ? "Mission complete"
          : insufficientTu
            ? `Kneel/stand — not enough TU (need ${STANCE.TOGGLE_TU}) [K]`
            : stance === "stand"
              ? `Kneel [K] — boosts accuracy and shrinks your profile, costs ${STANCE.TOGGLE_TU} TU and makes moves costlier`
              : `Stand up [K] — restores full mobility (${STANCE.TOGGLE_TU} TU; kneeling boosts accuracy)`;
  }

  /**
   * Render the Panic + Mind Control sub-buttons. Hidden entirely unless the
   * operative has psi skill; MC is disabled once the per-battle hard cap is
   * spent (and reads "SPENT" + a text reason, never colour alone).
   */
  private updatePsiButtons(selected: Unit | null, runtime: HudRuntime): void {
    const hasPsi = !!selected && (selected.stats.psiSkill ?? 0) > 0;
    if (!hasPsi || !runtime.psi) {
      this.psiRow.style.display = "none";
      return;
    }
    this.psiRow.style.display = "";
    const info = runtime.psi;
    this.psiRow.classList.toggle("spent", info.mcSpent);
    // Icon + TU cost on the face; the action name + effect live in the tooltip.
    this.renderPsiButton(
      this.psiPanicButton,
      "✦",
      `${info.panicTuCost} TU`,
      info.panicAvailable,
      this.activePsi === "panic",
      info.panicAvailable
        ? "Psi-panic — dumps a visible enemy's morale, may break its nerve"
        : "Psi-panic — not enough TU or not your turn",
    );
    this.renderPsiButton(
      this.psiMcButton,
      "☯",
      info.mcSpent ? "used" : `${info.mcTuCost} TU`,
      info.mcAvailable,
      this.activePsi === "mindControl",
      info.mcSpent
        ? "Mind control — hard cap reached (1 per battle)"
        : info.mcAvailable
          ? "Mind control — seize an enemy for one round (1 per battle)"
          : "Mind control — not enough TU or not your turn",
    );
  }

  private renderPsiButton(
    button: HTMLButtonElement,
    glyph: string,
    cost: string,
    enabled: boolean,
    active: boolean,
    title: string,
  ): void {
    const g = el("span", "psi-glyph");
    g.textContent = glyph;
    const c = el("span", "psi-cost");
    c.textContent = cost;
    button.replaceChildren(g, c);
    button.disabled = !enabled;
    button.classList.toggle("active", active);
    button.title = title;
  }

  /**
   * Single-line move/target hint. Replaces the old two-line "MOVE PREVIEW / Advance
   * to movement limit / 57 TU" banner with one terse line, tone-classed so the verb
   * carries the state (move = neutral, target = amber, blocked = red).
   */
  private updateContext(hover: HudHover | null, selected: Unit | null): void {
    const hint = this.contextHint;
    if (!selected) {
      hint.className = "move-hint";
      hint.replaceChildren(document.createTextNode("Select an operative"));
      hint.title = "Use the roster or click a blue unit.";
      return;
    }
    if (!hover) {
      hint.className = "move-hint";
      hint.replaceChildren(document.createTextNode("Click to move · hover to fire"));
      hint.title = "Click a green path to move. Hover a hostile to preview fire odds.";
      return;
    }

    if (hover.kind === "move" && hover.moveCost !== undefined) {
      const after = hover.tuAfter ?? 0;
      hint.className = "move-hint move";
      hint.replaceChildren(
        Object.assign(el("b"), { textContent: "Move" }),
        document.createTextNode(" — "),
        Object.assign(el("span", "cost"), { textContent: `${hover.moveCost} TU` }),
        document.createTextNode(
          hover.reachable === false ? ` · to limit, ${after} left` : ` · ${after} left`,
        ),
      );
      hint.title = hover.label;
      return;
    }

    const tone = hover.kind === "target" ? "target" : hover.kind === "blocked" ? "blocked" : "";
    hint.className = `move-hint${tone ? ` ${tone}` : ""}`;
    hint.replaceChildren(
      Object.assign(el("b"), {
        textContent: hover.kind === "target" ? "Target" : hover.kind === "blocked" ? "Blocked" : "",
      }),
      document.createTextNode(hover.kind === "target" ? `: ${hover.label}` : hover.label),
    );
    hint.title = hover.detail ?? hover.label;
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
      const preview = hover?.previews?.[kind];
      const hotkey = kind === "snap" ? "1" : kind === "aimed" ? "2" : "3";

      // Button face: fire-mode ICON + TU number only. Name, rounds, and hit% live in
      // the tooltip; the crosshair hit-chance chip is appended ONLY while a target is
      // previewed — the one moment those odds change THIS action's decision.
      const icon = el("span", "mode-icon");
      icon.textContent = MODE_ICON[kind];
      const tu = el("span", "mode-tu");
      tu.textContent = costValue === null ? "N/A" : `${costValue} TU`;
      const face: HTMLElement[] = [icon, tu];
      if (preview) {
        const odds = el("span", "chance");
        const xhair = el("span", "xhair");
        xhair.textContent = "⌖";
        const oddsValue = el("span");
        oddsValue.textContent = preview.possible ? ratioToPercent(preview.hitChance) : "✕";
        odds.append(xhair, oddsValue);
        face.push(odds);
      }
      button.replaceChildren(...face);
      button.disabled =
        !mode ||
        !selected ||
        runtime.busy ||
        state.activeFaction !== "player" ||
        (costValue !== null && selected.tu < costValue) ||
        (mode !== undefined && selected.ammo < mode.shots);
      button.classList.toggle("active", kind === this.activeMode && !!mode);

      // Tooltip carries name, rounds, hit%, and the hotkey.
      const rounds = mode ? `${mode.shots} rd${mode.shots === 1 ? "" : "s"}` : "";
      const hitText = preview
        ? preview.possible
          ? ` · ${ratioToPercent(preview.hitChance)} hit`
          : " · blocked"
        : "";
      button.title = preview?.reason ??
        (mode && selected && selected.ammo < mode.shots
          ? `${titleCase(kind)} fire [${hotkey}] — not enough ammo`
          : mode && costValue !== null
            ? `${titleCase(kind)} fire [${hotkey}] — ${costValue} TU · ${rounds}${hitText}`
            : `${titleCase(kind)} fire [${hotkey}] — unavailable`);
    }
  }

  private updateReloadButton(state: BattleState, selected: Unit | null, runtime: HudRuntime): void {
    const weapon = selected ? state.weapons[selected.weaponId] : undefined;
    const cost = selected && weapon ? reloadTuCost(selected, weapon.reloadTuPercent) : 0;
    const full = !!selected && !!weapon && selected.ammo >= weapon.magazineSize;
    // Face: magazine icon + ammo count only; TU cost + hotkey live in the tooltip.
    const magIcon = el("span", "mag-icon");
    magIcon.textContent = "⦿";
    const magCount = el("span", "mag-count");
    magCount.textContent = selected && weapon ? `${selected.ammo}/${weapon.magazineSize}` : "--";
    this.reloadButton.replaceChildren(magIcon, magCount);
    this.reloadButton.setAttribute("aria-label", "Reload weapon");
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
          ? `Magazine full (${selected.ammo}/${weapon.magazineSize})`
          : selected.tu < cost
            ? `Reload [L] — not enough TU (need ${cost})`
            : `Reload [L] — ${selected.ammo}/${weapon.magazineSize}, costs ${cost} TU`;
  }

  private updateReserveButtons(selected: Unit | null, runtime: HudRuntime): void {
    for (const [mode, button] of this.reserveButtons) {
      button.disabled = !selected || runtime.busy;
      button.classList.toggle("active", !!selected && selected.reserve === mode);
    }
  }

  private updateItemButtons(
    state: BattleState,
    selected: Unit | null,
    runtime: HudRuntime,
  ): void {
    const items = selected?.items ?? [];
    if (!selected || items.length === 0) {
      this.itemsRow.style.display = "none";
      this.itemsStack.replaceChildren();
      return;
    }
    this.itemsRow.style.display = "";

    const maxTu = selected.stats.timeUnits;
    const playerActing =
      !runtime.busy &&
      state.activeFaction === "player" &&
      state.status === "playing";
    const lines: HTMLElement[] = [];

    for (const inst of items) {
      const def = state.items?.[inst.itemId];
      if (!def) continue;
      const line = this.buildItemLine(inst, def, maxTu, selected, playerActing);
      lines.push(line);
    }

    if (lines.length === 0) {
      const empty = el("div", "items-empty");
      empty.textContent = "No usable items";
      this.itemsStack.replaceChildren(empty);
    } else {
      this.itemsStack.replaceChildren(...lines);
    }
  }

  private buildItemLine(
    inst: ItemInstance,
    def: Item,
    maxTu: number,
    selected: Unit,
    playerActing: boolean,
  ): HTMLElement {
    const isGrenade = def.kind === "grenade";
    const isSmoke = def.kind === "smoke";
    const isProxMine = def.kind === "proxMine";
    const isScanner = def.kind === "scanner";
    const isStunRod = def.kind === "stunRod";
    const isThrowable = isGrenade || isSmoke || isProxMine;
    const action: ItemActionKind = isThrowable ? "throw" : "use";
    // The stun rod is a melee capture tool, not a heal — read its verb as "Stun".
    const verb = isThrowable ? "Throw" : isStunRod ? "Stun" : "Use";
    const cost = itemActionTuCost(maxTu, def.tuPercent, action);
    const outOfUses = inst.uses <= 0;
    const cantAfford = selected.tu < cost;
    const primed = isGrenade && !!inst.primed;

    const line = el("div", "item-line");
    const glyph = ITEM_ICON[def.kind] ?? "▪";

    // Chip face: item icon only + a count badge. The verb, effect, charges, and TU
    // cost live in the tooltip so long labels never clip.
    const main = el("button");
    main.textContent = glyph;
    main.setAttribute("aria-label", `${verb} ${def.name}`);
    const chargeNote = isStunRod ? "reusable" : `x${inst.uses}`;
    const primedNote = primed ? ` · primed ${inst.fuseTurns ?? 1}t` : "";
    const effect = isGrenade
      ? `Throw ${def.name} (blast ${def.blastRadius ?? 1}, ${def.throwRange ?? 6} range)`
      : isSmoke
        ? `Throw ${def.name} (smoke cloud ${def.blastRadius ?? 2}, ${def.throwRange ?? 6} range)`
        : isProxMine
          ? `Throw ${def.name} (mine, blast ${def.blastRadius ?? 2}, ${def.throwRange ?? 6} range)`
          : isScanner
            ? `Use ${def.name} (reveals enemies within ${def.scanRadius ?? 8} tiles through walls)`
            : isStunRod
              ? `Stun an adjacent enemy with ${def.name} (+${def.stunPower ?? 0} stun; enough drops it for capture)`
              : `Use ${def.name} on an adjacent ally (heals ${def.healAmount ?? 0})`;
    main.title = `${effect} — ${chargeNote} · ${cost} TU${primedNote}`;
    main.disabled = !playerActing || outOfUses || cantAfford || primed;
    main.addEventListener("click", () => {
      if (isThrowable) this.cb.onThrowItem?.(inst.itemId);
      else this.cb.onUseItem?.(inst.itemId);
    });
    // Count badge (skip the reusable stun rod, which spends no charge).
    if (!isStunRod) {
      const count = el("span", "item-count");
      count.textContent = String(inst.uses);
      main.appendChild(count);
    }
    line.appendChild(main);

    if (isGrenade) {
      const primeCost = itemActionTuCost(maxTu, def.tuPercent, "prime");
      const prime = el("button", "prime");
      prime.textContent = "P";
      prime.setAttribute("aria-label", `Prime ${def.name}`);
      prime.disabled = !playerActing || outOfUses || selected.tu < primeCost || primed;
      prime.title = primed
        ? `Already primed — detonates in ${inst.fuseTurns ?? 1} turn(s)`
        : `Prime ${def.name} for ${primeCost} TU — detonates on the carrier's next turn`;
      prime.addEventListener("click", () => this.cb.onPrimeItem?.(inst.itemId));
      line.appendChild(prime);
    }

    return line;
  }

  private renderRoster(players: Unit[], selected: Unit | null, runtime: HudRuntime): void {
    const panicked = new Set(runtime.panickedUnitIds ?? []);
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
      if (unit.alive && panicked.has(unit.id)) {
        const panic = el("span", "panic-tag");
        panic.textContent = "PANIC";
        panic.title = "Operative is panicking";
        top.appendChild(panic);
      }

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
      this.banner.classList.remove(
        "show",
        "win",
        "lose",
        "campaign",
        "campaign-win",
        "campaign-lose",
        "debrief-mode",
      );
      return;
    }
    const win = state.status === "player_win";
    const debrief = runtime.debrief;
    const campaignStatus = runtime.campaignStatus ?? debrief?.strategicStatus;
    const campaignOver = campaignStatus === "won" || campaignStatus === "lost";
    this.bannerEye.textContent = campaignOver ? "Campaign complete" : "Operation complete";
    this.bannerTitle.textContent =
      campaignStatus === "won"
        ? "Earth Secured"
        : campaignStatus === "lost"
          ? "Earth Lost"
          : win
            ? "Site Secured"
            : "Squad Lost";
    this.bannerCopy.textContent = debrief?.summary ?? "Mission report transmitted to base command.";
    this.bannerReport.hidden = !debrief;
    this.bannerReport.className = "banner-report";
    if (debrief) {
      this.bannerReport.replaceChildren(this.renderDebriefReport(debrief));
    } else {
      this.bannerReport.replaceChildren();
    }
    this.bannerNewCampaignBtn.style.display = campaignOver ? "" : "none";
    this.bannerReturnBtn.classList.toggle("ui-cta", !campaignOver);
    this.bannerNewCampaignBtn.classList.toggle("ui-cta", campaignOver);
    this.banner.classList.add("show");
    // A mission debrief becomes a dominant, full-screen after-action report (wide,
    // scrollable, left-aligned body) rather than a compact centered banner.
    this.banner.classList.toggle("debrief-mode", !!debrief);
    this.banner.classList.toggle("win", win);
    this.banner.classList.toggle("lose", !win);
    this.banner.classList.toggle("campaign", campaignOver);
    this.banner.classList.toggle("campaign-win", campaignStatus === "won");
    this.banner.classList.toggle("campaign-lose", campaignStatus === "lost");
  }

  private renderDossier(
    selected: Unit | null,
    state: BattleState | null,
    runtime: HudRuntime | null,
  ): void {
    if (!this.detailsOpen) {
      this.dossier.classList.remove("show");
      return;
    }
    this.dossier.classList.add("show");
    if (!selected || !state) {
      this.dossierName.textContent = "No operative";
      this.dossierRank.textContent = "";
      this.dossierStats.replaceChildren();
      this.dossierWeapon.textContent = "";
      this.dossierItems.replaceChildren();
      this.dossierCareerSection.style.display = "none";
      return;
    }

    const detail = runtime?.soldierDetail;
    this.dossierName.textContent = selected.name;
    this.dossierRank.textContent = detail?.rank ?? titleCase(selected.templateId);

    const moraleValue = selected.morale ?? MORALE.MAX;
    const moraleRead = moraleState(selected.morale);
    const weapon = state.weapons[selected.weaponId];
    this.dossierStats.replaceChildren(
      this.debriefStat("Time Units", `${selected.tu} / ${selected.stats.timeUnits}`),
      this.debriefStat("Health", `${selected.hp} / ${selected.stats.health}`),
      this.debriefStat("Morale", `${moraleValue} ${moraleRead.label}`),
      this.debriefStat("Accuracy", String(selected.stats.firingAccuracy)),
      this.debriefStat("Reactions", String(selected.stats.reactions)),
      this.debriefStat("Strength", String(selected.stats.strength)),
      this.debriefStat("Bravery", String(selected.stats.bravery ?? MORALE.DEFAULT_BRAVERY)),
      this.debriefStat("Vision", `${selected.sightRange} tiles`),
      this.debriefStat("Reserve", titleCase(selected.reserve)),
    );
    this.dossierWeapon.textContent = weapon
      ? `${weapon.name} - ${selected.ammo}/${weapon.magazineSize} rds - ${weapon.damage} dmg`
      : selected.weaponId;

    const itemRows = (selected.items ?? []).map((inst) => {
      const def = state.items?.[inst.itemId];
      const li = el("li");
      const name = el("span");
      name.textContent = def?.name ?? inst.itemId;
      const small = el("small");
      small.textContent =
        inst.primed
          ? `x${inst.uses} - primed ${inst.fuseTurns ?? 1}t`
          : `x${inst.uses}${def?.kind === "grenade" ? " - blast" : def?.kind === "smoke" ? " - smoke" : def?.kind === "medkit" ? " - heal" : def?.kind === "scanner" ? " - scan" : def?.kind === "proxMine" ? " - mine" : ""}`;
      li.append(name, small);
      return li;
    });
    if (itemRows.length === 0) {
      const li = el("li");
      const span = el("span");
      span.textContent = "No carried items";
      li.appendChild(span);
      itemRows.push(li);
    }
    this.dossierItems.replaceChildren(...itemRows);

    const hasCareer =
      !!detail &&
      (detail.missions !== undefined ||
        detail.survived !== undefined ||
        detail.kills !== undefined);
    if (hasCareer && detail) {
      this.dossierCareerSection.style.display = "";
      this.dossierCareer.replaceChildren(
        this.debriefStat("Missions", String(detail.missions ?? 0)),
        this.debriefStat("Survived", String(detail.survived ?? 0)),
        this.debriefStat("Kills", String(detail.kills ?? 0)),
      );
    } else {
      this.dossierCareerSection.style.display = "none";
    }
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

  /**
   * Builds the cinematic after-action report: campaign strip (if over), loot bar,
   * score/threat/funding meta, then KIA and survivor rosters. Rich fields are
   * optional; when the controller omits them the HUD falls back to legible defaults
   * so the debrief never reads as broken.
   */
  private renderDebriefReport(debrief: HudDebrief): HTMLElement {
    const root = el("div", "debrief");
    const status = debrief.strategicStatus;
    if (status === "won" || status === "lost") {
      root.appendChild(this.renderCampaignStrip(status));
    }
    root.appendChild(this.renderLootRow(debrief.reward));
    if (debrief.captures) root.appendChild(this.renderCapturesSection(debrief.captures));
    root.appendChild(this.renderDebriefMeta(debrief));
    if (debrief.objectives && debrief.objectives.length > 0) {
      root.appendChild(this.renderObjectivesSection(debrief.objectives));
    }
    root.appendChild(this.renderCasualtySection(debrief));
    root.appendChild(this.renderSurvivorSection(debrief));
    return root;
  }

  /** Live-capture readout: how many aliens were taken alive and secured into
   *  containment (by rank/species), plus any lost to full/absent containment. */
  private renderCapturesSection(captures: NonNullable<HudDebrief["captures"]>): HTMLElement {
    const wrap = el("div", "debrief-section");
    const head = el("div", "debrief-section-head");
    const secured = captures.secured.length;
    const total = secured + captures.lostCount;
    const label = el("span", "eyebrow");
    label.textContent = "Live specimens";
    const count = el("span", "debrief-count");
    count.textContent = `${secured}/${total} secured`;
    head.append(label, count);
    wrap.appendChild(head);

    if (secured > 0) {
      const line = el("div", "debrief-campaign-line");
      const names = captures.secured
        .map((c) => `${c.rank.charAt(0).toUpperCase()}${c.rank.slice(1)} (${c.species})`)
        .join(", ");
      line.textContent = `${secured === 1 ? "One alien" : `${secured} aliens`} taken alive: ${names}.`;
      wrap.appendChild(line);
    }
    if (captures.lostCount > 0) {
      const lost = el("div", "debrief-campaign-line");
      lost.style.color = "var(--hud-red)";
      // Distinguish a FULL facility (the player owns one — it's just at capacity)
      // from an ABSENT one (build the facility). Keyed off the intake's real
      // containment flag, not the secured count.
      lost.textContent = captures.hadContainment
        ? `${captures.lostCount} lost — containment full (${captures.held}/${captures.capacity}).`
        : `${captures.lostCount} taken alive but lost — no containment facility. Build Alien Containment to hold captives.`;
      wrap.appendChild(lost);
    }
    return wrap;
  }

  private renderCampaignStrip(status: "won" | "lost"): HTMLElement {
    const strip = el("div", `debrief-campaign ${status}`);
    const head = el("div", "eyebrow");
    head.textContent = status === "won" ? "Campaign victory" : "Campaign defeat";
    const line = el("div", "debrief-campaign-line");
    line.textContent = status === "won"
      ? "Containment achieved — the alien command cell is broken."
      : "Command has collapsed. Earth's defense falls silent.";
    strip.append(head, line);
    return strip;
  }

  private renderLootRow(reward: HudDebrief["reward"]): HTMLElement {
    const wrap = el("div");
    const head = el("div", "eyebrow");
    head.textContent = "Materiel recovered";
    wrap.appendChild(head);
    const row = el("div", "debrief-loot-row");
    row.append(
      this.lootChip("credits", "$", reward.credits, "Credits"),
      this.lootChip("alloys", "◆", reward.alloys, "Alloys"),
      this.lootChip("elerium", "✦", reward.elerium, "Elerium"),
      this.lootChip("alienData", "Σ", reward.alienData, "Alien data"),
    );
    wrap.appendChild(row);
    return wrap;
  }

  private lootChip(kind: string, glyph: string, amount: number, label: string): HTMLElement {
    const chip = el("div", `loot-chip ${kind}${amount === 0 ? " zero" : ""}`);
    const g = el("span", "loot-glyph");
    g.textContent = glyph;
    const txt = el("span");
    const big = el("b");
    big.textContent = `+${amount}`;
    const small = el("small");
    small.textContent = label;
    txt.append(big, small);
    chip.append(g, txt);
    return chip;
  }

  private renderDebriefMeta(debrief: HudDebrief): HTMLElement {
    const grid = el("div", "debrief-meta");
    const hasMissionScore = debrief.missionScore !== undefined;
    const score = hasMissionScore ? (debrief.missionScore as number) : debrief.score;
    const rating = this.missionRating(score, hasMissionScore);
    grid.append(
      this.debriefScoreStat(score, rating, hasMissionScore),
      this.debriefStat("Threat", formatPercent(debrief.threat)),
      this.debriefStat("Funding", formatCredits(debrief.funding)),
    );
    // Signed strategic deltas (controller-derived, additive-optional). Green when the
    // change moves in the helpful direction — panic/threat DOWN, funding UP — red when
    // it worsens, neutral at zero. Aligned in the second grid row under their absolutes.
    if (debrief.panicDelta !== undefined) {
      grid.appendChild(
        this.debriefDeltaStat("Panic Δ", signedPercent(debrief.panicDelta), deltaTone(debrief.panicDelta, false)),
      );
    }
    if (debrief.threatDelta !== undefined) {
      grid.appendChild(
        this.debriefDeltaStat("Threat Δ", signedPercent(debrief.threatDelta), deltaTone(debrief.threatDelta, false)),
      );
    }
    if (debrief.fundingDelta !== undefined) {
      grid.appendChild(
        this.debriefDeltaStat("Funding Δ", formatSignedCredits(debrief.fundingDelta), deltaTone(debrief.fundingDelta, true)),
      );
    }
    return grid;
  }

  /** A signed strategic-delta chip: label + coloured signed value. Tone drives the
   *  value colour (good/bad/neutral) so the direction reads without prose. */
  private debriefDeltaStat(
    label: string,
    value: string,
    tone: "good" | "bad" | "neutral",
  ): HTMLElement {
    const node = el("div", `debrief-stat delta ${tone}`);
    const span = el("span");
    span.textContent = label;
    const strong = el("b");
    strong.textContent = value;
    node.append(span, strong);
    return node;
  }

  /** Mission objective progress: a checklist of the operation's goals, each flagged
   *  done/pending, with a completed count in the section head. */
  private renderObjectivesSection(
    objectives: NonNullable<HudDebrief["objectives"]>,
  ): HTMLElement {
    const section = el("div", "debrief-section");
    const head = el("div", "debrief-section-head");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Objectives";
    const done = objectives.filter((o) => o.done).length;
    const count = el("span", "debrief-count");
    count.textContent = `${done}/${objectives.length} complete`;
    head.append(eyebrow, count);
    section.appendChild(head);

    const list = el("ul", "debrief-objectives");
    for (const obj of objectives) {
      const li = el("li", obj.done ? "done" : "pending");
      const mark = el("span", "obj-mark");
      mark.textContent = obj.done ? "✔" : "○";
      const label = el("span", "obj-label");
      label.textContent = obj.label;
      li.append(mark, label);
      list.appendChild(li);
    }
    section.appendChild(list);
    return section;
  }

  private debriefScoreStat(
    score: number,
    rating: { label: string; cls: string },
    isMission: boolean,
  ): HTMLElement {
    const node = el("div", "debrief-stat");
    const span = el("span");
    span.textContent = isMission ? "Mission score" : "Campaign score";
    const strong = el("b");
    strong.textContent = String(score);
    const rate = el("span", `rating ${rating.cls}`);
    rate.textContent = rating.label;
    node.append(span, strong, rate);
    return node;
  }

  /**
   * Maps a numeric score to its Excellent/Good/Fair/Poor rating. Per-mission scores
   * (a success is worth ~+100..+250, a failure ~-50) use tighter thresholds than the
   * cumulative campaign score, which climbs across many operations.
   */
  private missionRating(score: number, isMission: boolean): { label: string; cls: string } {
    if (isMission) {
      if (score >= 150) return { label: "Excellent", cls: "excellent" };
      if (score >= 100) return { label: "Good", cls: "good" };
      if (score >= 0) return { label: "Fair", cls: "fair" };
      return { label: "Poor", cls: "poor" };
    }
    if (score >= 500) return { label: "Excellent", cls: "excellent" };
    if (score >= 200) return { label: "Good", cls: "good" };
    if (score >= 0) return { label: "Fair", cls: "fair" };
    return { label: "Poor", cls: "poor" };
  }

  private renderCasualtySection(debrief: HudDebrief): HTMLElement {
    const section = el("div", "debrief-section");
    const kia = debrief.kia ?? this.fallbackCasualties(debrief);
    const head = el("div", "debrief-section-head");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Casualties";
    const count = el("span", "debrief-count");
    count.textContent = kia.length === 0 ? "No losses" : `${kia.length} KIA`;
    head.append(eyebrow, count);
    section.appendChild(head);

    if (kia.length === 0) {
      const empty = el("div", "debrief-empty");
      empty.textContent = "All operatives returned safely.";
      section.appendChild(empty);
      return section;
    }

    const list = el("ul", "debrief-roster");
    for (const soldier of kia) list.appendChild(this.renderCasualtyRow(soldier));
    section.appendChild(list);
    return section;
  }

  private renderCasualtyRow(soldier: HudDebriefCasualty): HTMLElement {
    const li = el("li", "kia");
    li.append(this.soldierLine(soldier.name, soldier.rank));
    if (soldier.bio) {
      const bio = el("div", "debrief-bio");
      bio.textContent = soldier.bio;
      li.appendChild(bio);
    }
    const tag = el("div", "debrief-tag kia");
    tag.textContent = "Killed in action";
    li.appendChild(tag);
    return li;
  }

  private renderSurvivorSection(debrief: HudDebrief): HTMLElement {
    const section = el("div", "debrief-section");
    const survivors = debrief.survivors ?? [];
    const total = survivors.length + (debrief.kia?.length ?? debrief.casualties.length);
    const woundedCount = survivors.filter((s) => s.wounded).length;
    const head = el("div", "debrief-section-head");
    const eyebrow = el("div", "eyebrow");
    eyebrow.textContent = "Survivors";
    const count = el("span", "debrief-count");
    count.textContent = total > 0
      ? `${survivors.length} / ${total} returned${woundedCount > 0 ? ` · ${woundedCount} wounded` : ""}`
      : "No squad";
    head.append(eyebrow, count);
    section.appendChild(head);

    if (survivors.length === 0) {
      const empty = el("div", "debrief-empty");
      empty.textContent = "No operatives survived the operation.";
      section.appendChild(empty);
      return section;
    }

    const list = el("ul", "debrief-roster");
    for (const soldier of survivors) list.appendChild(this.renderSurvivorRow(soldier));
    section.appendChild(list);
    return section;
  }

  private renderSurvivorRow(soldier: HudDebriefSurvivor): HTMLElement {
    const li = el("li");
    li.append(this.soldierLine(soldier.name, soldier.rank));

    if (soldier.previousRank && soldier.previousRank !== soldier.rank) {
      const promo = el("div", "debrief-tag promoted");
      promo.textContent = `Promoted: ${this.rankLabel(soldier.previousRank)} → ${this.rankLabel(soldier.rank)}`;
      li.appendChild(promo);
    }

    if (soldier.statGrowth) {
      const parts = this.formatStatGrowth(soldier.statGrowth);
      if (parts.length > 0) {
        const growth = el("div", "debrief-growth");
        for (const part of parts) {
          const chip = el("span");
          chip.textContent = part;
          growth.appendChild(chip);
        }
        li.appendChild(growth);
      }
    }

    if (soldier.wounded) {
      const tag = el("div", "debrief-tag wounded");
      const hours = soldier.woundRecoveryHours ?? 0;
      tag.textContent = hours > 0 ? `Wounded · ${formatDuration(hours)} recovery` : "Wounded";
      li.appendChild(tag);
    }
    return li;
  }

  /** Name + rank header shared by KIA and survivor rows. */
  private soldierLine(name: string, rank: SoldierRank): HTMLElement {
    const line = el("div", "debrief-soldier-line");
    const nameEl = el("span", "debrief-soldier-name");
    nameEl.textContent = name;
    const rankEl = el("span", "debrief-rank");
    rankEl.textContent = this.rankLabel(rank);
    line.append(nameEl, rankEl);
    return line;
  }

  /**
   * When the controller only supplies the legacy `casualties` name/id list, fold it
   * into the rich roster shape so the KIA section still reads as names (not raw ids).
   */
  private fallbackCasualties(debrief: HudDebrief): HudDebriefCasualty[] {
    return debrief.casualties.map((entry, index) => ({
      id: `legacy-${index}`,
      name: entry,
      rank: "rookie",
    }));
  }

  private rankLabel(rank: SoldierRank): string {
    return titleCase(rank);
  }

  /** Formats this-mission stat growth as "+N Stat" chips, ordered by combat impact. */
  private formatStatGrowth(growth: SoldierStatGrowth): string[] {
    const parts: string[] = [];
    if (growth.firingAccuracy) parts.push(`+${growth.firingAccuracy} Accuracy`);
    if (growth.reactions) parts.push(`+${growth.reactions} Reactions`);
    if (growth.health) parts.push(`+${growth.health} Health`);
    if (growth.timeUnits) parts.push(`+${growth.timeUnits} Time Units`);
    return parts;
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
      ["04", "Equip", "Throw frag grenades for blast damage, prime them to arm a fuse, use medkits on adjacent allies to heal, sweep with a motion scanner to reveal nearby enemies, and plant proximity mines to ambush movers."],
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
    keys.textContent =
      "1/2/3 MODE · K KNEEL · R RESERVE · L RELOAD · ENTER END TURN · TAB CYCLE · WASD PAN · Q/E ROTATE · WHEEL ZOOM · H HELP · M MUTE";
    const begin = el("button", "ui-cta");
    begin.textContent = "Deploy squad";
    begin.addEventListener("click", () => this.toggleBriefing(false));
    actions.append(keys, begin);
    card.append(eye, this.briefingTitle, this.briefingLede, grid, actions);
    overlay.appendChild(card);
    return overlay;
  }

  private buildDossierCard(children: HTMLElement[]): HTMLDivElement {
    const card = el("div", "dossier-card");
    const eye = el("div", "eyebrow");
    eye.textContent = "Operative dossier";
    card.append(eye, ...children);
    return card;
  }

  private injectStyle(): void {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
}
