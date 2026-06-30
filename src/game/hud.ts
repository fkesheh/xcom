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
const RESERVES: readonly ReserveMode[] = ["none", "snap", "aimed", "auto"];
const STYLE_ID = "blacksite-hud-style";
const LOG_TAIL = 7;
/** Morale at/above this value reads as "Steady"; below PANIC_THRESHOLD reads as "PANIC". */
const MORALE_STEADY_FLOOR = 67;

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
#hud .meter-right { display: inline-flex; align-items: baseline; gap: 8px; }
#hud .bar { position: relative; height: 7px; margin-top: 6px; border-radius: 7px; background: rgba(255,255,255,.07); overflow: hidden; }
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
#hud .reserve-tag::before { content: "⚡ "; }
/* Morale bar: tone drives the fill colour but the numeric value + label always accompany it. */
#hud .morale-bar i { background: linear-gradient(90deg, #4ade80, #22d3ee); }
#hud .morale-bar.shaken i { background: linear-gradient(90deg, #fbbf24, #f59e0b); }
#hud .morale-bar.panic i { background: linear-gradient(90deg, #fb7185, #ef4444); }
#hud .morale-tag { font-weight: 700; letter-spacing: 0; }
#hud .morale-tag.steady { color: var(--hud-green); }
#hud .morale-tag.shaken { color: var(--hud-amber); }
#hud .morale-tag.panic { color: var(--hud-red); animation: panic-pulse 1s ease-in-out infinite; }
#hud .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin-top: 12px; }
#hud .stat { padding: 7px; border: 1px solid rgba(255,255,255,.06); border-radius: 6px; background: rgba(0,0,0,.13); }
#hud .stat span { display: block; color: var(--hud-muted); font: 700 9px/1 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .stat b { display: block; margin-top: 4px; font: 750 12px/1 ui-monospace, monospace; }
#hud .details-btn { min-height: 28px; min-width: 96px; margin-top: 10px; padding: 0 12px; font-size: 9px; text-transform: uppercase; }

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
#hud .reload-row,
#hud .items-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
#hud .reserve-row > span,
#hud .reload-row > span,
#hud .items-row > span { width: 76px; color: var(--hud-muted); font: 700 8px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .reserve { display: grid; grid-template-columns: repeat(4, 1fr); gap: 5px; flex: 1; }
#hud .reserve button { min-height: 30px; padding: 4px; font-size: 8px; text-transform: uppercase; }
#hud .reload-row button { flex: 1; min-height: 32px; padding: 4px 8px; font-size: 9px; text-transform: uppercase; }
/* Carried-items action grid. Each line is one item: primary action + optional grenade prime. */
#hud .items-stack { flex: 1; display: flex; flex-direction: column; gap: 5px; }
#hud .item-line { display: flex; gap: 5px; }
#hud .item-line button { flex: 1; min-height: 34px; padding: 5px 8px; display: flex; align-items: center; justify-content: space-between; gap: 8px; font-size: 9px; text-align: left; text-transform: none; letter-spacing: .02em; }
#hud .item-line button.prime { flex: 0 0 auto; min-width: 78px; justify-content: center; text-transform: uppercase; }
#hud .item-line .item-label { display: flex; flex-direction: column; gap: 1px; overflow: hidden; }
#hud .item-line .item-label b { font-size: 10px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .item-line .item-label small { color: var(--hud-muted); font-size: 9px; }
#hud .item-line .item-verb { color: var(--hud-cyan); font-size: 9px; text-transform: uppercase; }
#hud .item-line button:disabled .item-verb { color: var(--hud-muted); }
#hud .items-empty { color: var(--hud-muted); font: 600 9px/1.3 ui-monospace, monospace; padding: 4px 2px; }

/* Stance toggle (actions panel) — mirrors the reload-row layout. */
#hud .stance-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
#hud .stance-row > span { width: 76px; color: var(--hud-muted); font: 700 8px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .stance-row button { flex: 1; min-height: 32px; padding: 4px 8px; font-size: 9px; text-transform: uppercase; }
#hud .stance-row .stance-glyph { color: var(--hud-cyan); margin-right: 5px; }
#hud .stance-row .stance-tu { color: var(--hud-cyan); }
#hud .stance-row button:disabled .stance-glyph,
#hud .stance-row button:disabled .stance-tu { color: var(--hud-muted); }

/* Psionics row (actions panel) — mirrors stance-row layout but holds two
   sub-buttons (Panic + Mind Control). Each pairs a glyph with its label and TU
   cost so state is never conveyed by colour alone; the MC button reads "SPENT"
   once the per-battle hard cap is used. */
#hud .psi-row { display: flex; align-items: center; gap: 8px; margin-top: 10px; }
#hud .psi-row > span { width: 76px; color: var(--hud-muted); font: 700 8px/1.2 ui-monospace, monospace; letter-spacing: .08em; text-transform: uppercase; }
#hud .psi-actions { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); gap: 5px; }
#hud .psi-actions button {
  min-height: 38px;
  padding: 5px 6px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  font-size: 9px;
  text-transform: uppercase;
}
#hud .psi-actions .psi-glyph { color: var(--hud-cyan); font-size: 12px; line-height: 1; }
#hud .psi-actions .psi-cost { color: var(--hud-muted); font-size: 8px; letter-spacing: .04em; text-transform: none; }
#hud .psi-actions button:disabled .psi-glyph,
#hud .psi-actions button:disabled .psi-cost { color: var(--hud-muted); }
/* Armed psi-targeting mode reads as an active state on the chosen sub-button. */
#hud .psi-actions button.active .psi-glyph { color: #effcff; }

/* Stance + cover readout (unit panel). The cover tone tints the value but a
   text label (Full / Half / Exposed) always accompanies the colour. */
#hud .status-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 7px; margin-top: 12px; }
#hud .status-row .stance-glyph { color: var(--hud-cyan); margin-right: 4px; }
#hud .cover-tag { font-weight: 750; letter-spacing: 0; }
#hud .cover-tag.full { color: var(--hud-green); }
#hud .cover-tag.half { color: var(--hud-amber); }
#hud .cover-tag.exposed { color: var(--hud-red); }
#hud .cover-tag.none { color: var(--hud-muted); }

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
#hud .roster .panic-tag {
  display: inline-block;
  margin-left: 5px;
  padding: 1px 4px;
  border-radius: 3px;
  color: #ffe4e6;
  background: rgba(251,113,133,.22);
  border: 1px solid rgba(251,113,133,.5);
  font: 800 9px/1.2 ui-monospace, monospace;
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
@keyframes panic-pulse { 50% { opacity: .4; } }

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
  border: 1px solid rgba(103,232,249,.28);
  border-radius: 14px;
  background:
    linear-gradient(135deg, rgba(19,42,55,.96), rgba(5,11,17,.98) 62%),
    rgba(5,11,17,.98);
  box-shadow: 0 30px 100px rgba(0,0,0,.55);
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
#hud .briefing-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 26px 0; }
#hud .briefing-step { padding: 13px; border: 1px solid rgba(255,255,255,.08); border-radius: 8px; background: rgba(0,0,0,.14); }
#hud .briefing-step b { display: block; margin: 5px 0; font-size: 13px; text-transform: uppercase; }
#hud .briefing-step p { margin: 0; color: var(--hud-muted); font-size: 10px; }
#hud .briefing-actions { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
#hud .briefing-actions span { color: var(--hud-muted); font: 600 9px/1.45 ui-monospace, monospace; }
#hud .briefing-actions button,
#hud .banner button { min-width: 174px; padding: 0 18px; border-color: var(--hud-cyan); }
#hud .banner-actions { display: flex; gap: 10px; justify-content: center; margin-top: 6px; }
#hud .banner-card { text-align: center; }
#hud .banner.win h1 { color: var(--hud-green); }
#hud .banner.lose h1 { color: var(--hud-red); }
#hud .banner.campaign-win .banner-card { border-color: rgba(74,222,128,.5); box-shadow: 0 30px 120px rgba(74,222,128,.16), 0 30px 100px rgba(0,0,0,.55); }
#hud .banner.campaign-lose .banner-card { border-color: rgba(251,113,133,.55); box-shadow: 0 30px 120px rgba(251,113,133,.16), 0 30px 100px rgba(0,0,0,.55); }

/* Soldier dossier (details overlay). */
#hud .dossier h2 { margin: 4px 0 0; font-size: 26px; line-height: 1; letter-spacing: .03em; }
#hud .dossier .rank { margin-top: 6px; color: var(--hud-cyan); font: 700 11px/1 ui-monospace, monospace; letter-spacing: .1em; text-transform: uppercase; }
#hud .dossier-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 7px; margin: 18px 0; }
#hud .dossier-section { margin-top: 14px; }
#hud .dossier-section > .eyebrow { margin-bottom: 7px; }
#hud .dossier ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 5px; }
#hud .dossier li { display: flex; justify-content: space-between; gap: 10px; padding: 6px 9px; border: 1px solid rgba(255,255,255,.06); border-radius: 6px; background: rgba(0,0,0,.18); font: 600 10px/1.3 ui-monospace, monospace; }
#hud .dossier li small { color: var(--hud-muted); }
#hud .dossier-actions { display: flex; justify-content: flex-end; margin-top: 18px; }
#hud .dossier-actions button { min-width: 130px; }

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
  #hud .reload-row,
  #hud .items-row,
  #hud .stance-row,
  #hud .psi-row { display: none; }
  #hud .modes { margin-top: 7px; }
  #hud .modes button { min-height: 48px; }
  #hud .endturn { right: 20px; bottom: 36px; min-width: 104px; min-height: 46px; font-size: 9px; }
  #hud .briefing-grid { grid-template-columns: 1fr; }
  #hud .briefing-step { padding: 10px 12px; }
  #hud .briefing-actions { align-items: stretch; flex-direction: column; }
  #hud .briefing-actions button { width: 100%; }
  #hud .dossier-stats { grid-template-columns: repeat(2, 1fr); }
}
@media (max-height: 660px) {
  #hud .log, #hud .squad { display: none; }
  #hud .unit { padding-top: 10px; padding-bottom: 10px; }
  #hud .stats,
  #hud .status-row { display: none; }
  #hud .briefing-card { padding-top: 24px; padding-bottom: 24px; }
  #hud .briefing-grid { margin: 16px 0; }
}
/* Respect prefers-reduced-motion: kill the ambient pulses (end-turn ready glow,
   panic throb) and collapse the hover/transition tweens. Combat feedback (toast
   appear/disappear) still functions, just instantly. */
@media (prefers-reduced-motion: reduce) {
  #hud .endturn.ready,
  #hud .morale-tag.panic,
  #hud .roster .panic-tag { animation: none !important; }
  #hud button,
  #hud .bar i,
  #hud .tu-reserve,
  #hud .toast { transition: none !important; }
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
  private readonly weaponEl: HTMLDivElement;
  private readonly unitBadge: HTMLDivElement;
  private readonly tuFill: HTMLElement;
  private readonly tuReserve: HTMLElement;
  private readonly tuText: HTMLElement;
  private readonly reserveTag: HTMLSpanElement;
  private readonly hpFill: HTMLElement;
  private readonly hpText: HTMLElement;
  private readonly moraleBar: HTMLDivElement;
  private readonly moraleFill: HTMLElement;
  private readonly moraleText: HTMLElement;
  private readonly moraleTag: HTMLSpanElement;
  private readonly accuracyEl: HTMLElement;
  private readonly reactionsEl: HTMLElement;
  private readonly visionEl: HTMLElement;
  private readonly detailsButton: HTMLButtonElement;
  private readonly contextEyebrow: HTMLDivElement;
  private readonly contextTitle: HTMLHeadingElement;
  private readonly contextDetail: HTMLDivElement;
  private readonly reloadButton: HTMLButtonElement;
  private readonly modeButtons = new Map<ShotKind, HTMLButtonElement>();
  private readonly reserveButtons = new Map<ReserveMode, HTMLButtonElement>();
  private readonly itemsRow: HTMLDivElement;
  private readonly itemsStack: HTMLDivElement;
  private readonly stanceButton: HTMLButtonElement;
  private readonly stanceValue: HTMLElement;
  private readonly coverValue: HTMLElement;
  private readonly psiRow: HTMLDivElement;
  private readonly psiPanicButton: HTMLButtonElement;
  private readonly psiMcButton: HTMLButtonElement;
  private readonly rosterEl: HTMLDivElement;
  private readonly logEl: HTMLElement;
  private readonly endTurn: HTMLButtonElement;
  private readonly muteButton: HTMLButtonElement;
  private readonly abortButton: HTMLButtonElement;
  private readonly toast: HTMLDivElement;
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
    const tuRight = el("span", "meter-right");
    this.tuText = el("b");
    this.reserveTag = el("span", "reserve-tag");
    tuRight.append(this.tuText, this.reserveTag);
    tuHead.appendChild(tuRight);
    const tuBar = el("div", "bar");
    this.tuFill = el("i");
    this.tuFill.style.background = "linear-gradient(90deg,#22d3ee,#67e8f9)";
    this.tuReserve = el("i", "tu-reserve");
    tuBar.append(this.tuFill, this.tuReserve);

    const hpHead = el("div", "meter-head");
    hpHead.append(document.createTextNode("Vital signs"));
    this.hpText = el("b");
    hpHead.appendChild(this.hpText);
    const hpBar = el("div", "bar");
    this.hpFill = el("i");
    hpBar.appendChild(this.hpFill);

    const moraleHead = el("div", "meter-head");
    moraleHead.append(document.createTextNode("Morale"));
    const moraleRight = el("span", "meter-right");
    this.moraleText = el("b");
    this.moraleTag = el("span", "morale-tag");
    moraleRight.append(this.moraleText, this.moraleTag);
    moraleHead.appendChild(moraleRight);
    this.moraleBar = el("div", "bar morale-bar");
    this.moraleFill = el("i");
    this.moraleBar.appendChild(this.moraleFill);
    unit.append(tuHead, tuBar, hpHead, hpBar, moraleHead, this.moraleBar);

    const stats = el("div", "stats");
    this.accuracyEl = this.makeStat(stats, "Accuracy");
    this.reactionsEl = this.makeStat(stats, "Reactions");
    this.visionEl = this.makeStat(stats, "Vision");
    unit.appendChild(stats);

    // Stance + directional-cover readout. Two stat-style cells in a 2-up row;
    // cover colour always carries a Full/Half/Exposed text label.
    const statusRow = el("div", "status-row");
    const stanceCell = el("div", "stat");
    const stanceCellLabel = el("span");
    stanceCellLabel.textContent = "Stance";
    this.stanceValue = el("b");
    stanceCell.append(stanceCellLabel, this.stanceValue);
    const coverCell = el("div", "stat");
    const coverCellLabel = el("span");
    coverCellLabel.textContent = "Cover";
    this.coverValue = el("b", "cover-tag none");
    this.coverValue.textContent = "—";
    coverCell.append(coverCellLabel, this.coverValue);
    statusRow.append(stanceCell, coverCell);
    unit.appendChild(statusRow);

    this.detailsButton = el("button", "details-btn");
    this.detailsButton.textContent = "Details";
    this.detailsButton.title = "Open operative dossier (ESC closes)";
    this.detailsButton.addEventListener("click", () => this.toggleDossier());
    unit.appendChild(this.detailsButton);
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

    const stanceRow = el("div", "stance-row");
    const stanceLabel = el("span");
    stanceLabel.textContent = "Stance";
    this.stanceButton = el("button");
    this.stanceButton.addEventListener("click", () => {
      const sel = this.lastSelected;
      if (!sel) return;
      const current: UnitStance = sel.stance ?? "stand";
      this.cb.onSetStance?.(current === "stand" ? "kneel" : "stand");
    });
    stanceRow.append(stanceLabel, this.stanceButton);
    actions.appendChild(stanceRow);

    // Psionics row: hidden unless the selected operative has psi skill. Each
    // sub-button pairs a glyph with its label + TU cost so the armed/spent state
    // is never conveyed by colour alone; MC reads "SPENT" once the per-battle
    // hard cap is used. TU costs + availability arrive via runtime.psi (computed
    // by the controller, which owns the PSI tuning constants).
    this.psiRow = el("div", "psi-row");
    const psiLabel = el("span");
    psiLabel.textContent = "Psionics";
    const psiActions = el("div", "psi-actions");
    this.psiPanicButton = el("button");
    this.psiPanicButton.dataset.kind = "panic";
    this.psiPanicButton.title = "Psi-panic a visible enemy (dumps morale, may break nerve)";
    this.psiPanicButton.addEventListener("click", () => this.cb.onPsiAttack?.("panic"));
    this.psiMcButton = el("button");
    this.psiMcButton.dataset.kind = "mindControl";
    this.psiMcButton.title = "Seize an enemy for one round. Hard-capped at one use per battle.";
    this.psiMcButton.addEventListener("click", () => this.cb.onPsiAttack?.("mindControl"));
    psiActions.append(this.psiPanicButton, this.psiMcButton);
    this.psiRow.append(psiLabel, psiActions);
    actions.appendChild(this.psiRow);

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

    this.itemsRow = el("div", "items-row");
    const itemsLabel = el("span");
    itemsLabel.textContent = "Items";
    this.itemsStack = el("div", "items-stack");
    this.itemsRow.append(itemsLabel, this.itemsStack);
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

    this.endTurn = el("button", "endturn");
    this.endTurn.textContent = "End turn [Enter]";
    this.endTurn.addEventListener("click", () => this.cb.onEndTurn());
    this.root.appendChild(this.endTurn);

    this.toast = el("div", "toast");
    this.root.appendChild(this.toast);

    this.banner = el("div", "banner");
    const bannerCard = el("div", "banner-card");
    this.bannerEye = el("div", "eyebrow");
    this.bannerEye.textContent = "Operation complete";
    this.bannerTitle = el("h1");
    this.bannerCopy = el("p", "briefing-lede");
    this.bannerCopy.textContent = "Mission report transmitted to base command.";
    this.bannerReport = el("div", "debrief-grid");
    this.bannerReport.hidden = true;
    const bannerActions = el("div", "banner-actions");
    this.bannerReturnBtn = el("button");
    this.bannerReturnBtn.textContent = "Return to Base";
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
      this.nameEl.textContent = "No operative";
      this.weaponEl.textContent = "Select a squad member";
      this.unitBadge.textContent = "--";
      this.tuFill.style.width = "0%";
      this.tuReserve.style.width = "0%";
      this.hpFill.style.width = "0%";
      this.tuText.textContent = "--";
      this.reserveTag.textContent = "";
      this.hpText.textContent = "--";
      this.moraleFill.style.width = "0%";
      this.moraleText.textContent = "--";
      this.moraleTag.textContent = "";
      this.moraleBar.className = "bar morale-bar";
      this.accuracyEl.textContent = "--";
      this.reactionsEl.textContent = "--";
      this.visionEl.textContent = "--";
      this.stanceValue.textContent = "--";
      this.coverValue.textContent = "—";
      this.coverValue.className = "cover-tag none";
      return;
    }

    this.nameEl.textContent = selected.name;
    const weapon = state.weapons[selected.weaponId];
    this.weaponEl.textContent = weapon
      ? `${weapon.name} - Ammo ${selected.ammo}/${weapon.magazineSize}`
      : selected.weaponId;
    this.unitBadge.textContent = selected.tu > 0 ? "READY" : "SPENT";

    // TU bar: spendable cyan fill + amber hatched reaction-reserve segment.
    const maxTu = selected.stats.timeUnits;
    const reserve = reservedTuForReserve(maxTu, selected.reserve, weapon);
    const free = Math.max(0, selected.tu - reserve);
    const freePct = percent(free, maxTu);
    const reserveShown = Math.max(0, Math.min(reserve, selected.tu));
    this.tuFill.style.width = `${freePct}%`;
    this.tuReserve.style.left = `${freePct}%`;
    this.tuReserve.style.width = `${percent(reserveShown, maxTu)}%`;
    this.tuText.textContent = `${selected.tu} / ${maxTu}`;
    if (reserve > 0) {
      this.reserveTag.textContent = `${reserve} RXN`;
      this.reserveTag.title = `${reserve} TU held back for ${selected.reserve} reaction fire`;
    } else {
      this.reserveTag.textContent = "";
    }

    const hpPct = percent(selected.hp, selected.stats.health);
    this.hpFill.style.width = `${hpPct}%`;
    this.hpFill.style.background =
      hpPct >= 60 ? "#4ade80" : hpPct >= 30 ? "#fbbf24" : "#fb7185";
    this.hpText.textContent = `${selected.hp} / ${selected.stats.health}`;

    // Morale bar: tone tints the fill but numeric value + label always accompany it.
    const moraleValue = selected.morale ?? MORALE.MAX;
    const read = moraleState(selected.morale);
    this.moraleFill.style.width = `${percent(moraleValue, MORALE.MAX)}%`;
    this.moraleBar.className = `bar morale-bar ${read.tone}`;
    this.moraleText.textContent = `${moraleValue}`;
    this.moraleTag.textContent = read.label;
    this.moraleTag.className = `morale-tag ${read.tone}`;
    this.moraleTag.title = `Morale ${moraleValue}/100 - ${read.label}`;

    this.accuracyEl.textContent = String(selected.stats.firingAccuracy);
    this.reactionsEl.textContent = String(selected.stats.reactions);
    this.visionEl.textContent = `${selected.sightRange} tiles`;

    this.renderStanceReadout(state, selected);
  }

  /**
   * Stance indicator + directional-cover status for the unit panel. Cover is
   * measured against the nearest hostile the squad can see; when none is
   * visible it reads as "—". Colour is always paired with a text label.
   */
  private renderStanceReadout(state: BattleState, selected: Unit): void {
    const stance: UnitStance = selected.stance ?? "stand";
    const stanceGlyph = el("span", "stance-glyph");
    stanceGlyph.textContent = stance === "kneel" ? "▄" : "█";
    this.stanceValue.replaceChildren(
      stanceGlyph,
      document.createTextNode(stance === "kneel" ? "Kneeling" : "Standing"),
    );
    this.stanceValue.title = stance === "kneel"
      ? "Kneeling: +accuracy, smaller profile, costlier moves"
      : "Standing: full mobility";

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
      this.coverValue.textContent = "—";
      this.coverValue.className = "cover-tag none";
      this.coverValue.title = "No visible hostile — cover not engaged";
      return;
    }

    const cover = coverDefenseFor(state.grid, selected.pos, nearest.pos);
    const read = this.coverReadout(cover);
    this.coverValue.textContent = read.label;
    this.coverValue.className = `cover-tag ${read.cls}`;
    this.coverValue.title = `Directional cover vs ${nearest.name}: ${read.label.toLowerCase()}`;
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
    const glyph = el("span", "stance-glyph");
    glyph.textContent = stance === "kneel" ? "▄" : "█";
    const tu = el("span", "stance-tu");
    tu.textContent = `${STANCE.TOGGLE_TU} TU`;
    this.stanceButton.replaceChildren(
      glyph,
      document.createTextNode(stance === "kneel" ? "Kneel" : "Stand"),
      document.createTextNode(" · "),
      tu,
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
            ? `Not enough TU (need ${STANCE.TOGGLE_TU})`
            : stance === "stand"
              ? "Kneel: boosts accuracy and shrinks your profile, but costs 4 TU and makes moves costlier"
              : "Stand up: restores full mobility (kneeling boosts accuracy)";
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
    this.renderPsiButton(
      this.psiPanicButton,
      "✦",
      "Panic",
      `${info.panicTuCost} TU`,
      info.panicAvailable,
      this.activePsi === "panic",
      info.panicAvailable
        ? "Psi-panic: dumps morale, may break the target's nerve"
        : "Not enough TU or not your turn",
    );
    this.renderPsiButton(
      this.psiMcButton,
      "☯",
      info.mcSpent ? "MC Spent" : "Mind Control",
      info.mcSpent ? "1 / battle used" : `${info.mcTuCost} TU`,
      info.mcAvailable,
      this.activePsi === "mindControl",
      info.mcSpent
        ? "Mind control hard cap reached (1 per battle)"
        : info.mcAvailable
          ? "Seize an enemy for one round (1 per battle)"
          : "Not enough TU or not your turn",
    );
  }

  private renderPsiButton(
    button: HTMLButtonElement,
    glyph: string,
    label: string,
    cost: string,
    enabled: boolean,
    active: boolean,
    title: string,
  ): void {
    const g = el("span", "psi-glyph");
    g.textContent = glyph;
    const l = el("span");
    l.textContent = label;
    const c = el("span", "psi-cost");
    c.textContent = cost;
    button.replaceChildren(g, l, c);
    button.disabled = !enabled;
    button.classList.toggle("active", active);
    button.title = title;
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
    const isThrowable = isGrenade || isSmoke || isProxMine;
    const action: ItemActionKind = isThrowable ? "throw" : "use";
    const verb = isThrowable ? "Throw" : "Use";
    const cost = itemActionTuCost(maxTu, def.tuPercent, action);
    const outOfUses = inst.uses <= 0;
    const cantAfford = selected.tu < cost;
    const primed = isGrenade && !!inst.primed;

    const line = el("div", "item-line");

    const main = el("button");
    main.title = isGrenade
      ? `Throw ${def.name} (blast ${def.blastRadius ?? 1}, ${def.throwRange ?? 6} range) - ${cost} TU`
      : isSmoke
        ? `Throw ${def.name} (smoke cloud ${def.blastRadius ?? 2}, ${def.throwRange ?? 6} range) - ${cost} TU`
        : isProxMine
          ? `Throw ${def.name} (mine, blast ${def.blastRadius ?? 2}, ${def.throwRange ?? 6} range) - ${cost} TU`
          : isScanner
            ? `Use ${def.name} (reveals enemies within ${def.scanRadius ?? 8} tiles through walls) - ${cost} TU`
            : `Use ${def.name} on an adjacent ally (heals ${def.healAmount ?? 0}) - ${cost} TU`;
    const label = el("span", "item-label");
    const name = el("b");
    name.textContent = def.name;
    const meta = el("small");
    const charge = `x${inst.uses} - ${cost} TU`;
    meta.textContent = primed ? `${charge} - primed ${inst.fuseTurns ?? 1}t` : charge;
    label.append(name, meta);
    const verbSpan = el("span", "item-verb");
    verbSpan.textContent = verb;
    main.append(label, verbSpan);
    main.disabled = !playerActing || outOfUses || cantAfford || primed;
    main.addEventListener("click", () => {
      if (isThrowable) this.cb.onThrowItem?.(inst.itemId);
      else this.cb.onUseItem?.(inst.itemId);
    });
    line.appendChild(main);

    if (isGrenade) {
      const primeCost = itemActionTuCost(maxTu, def.tuPercent, "prime");
      const prime = el("button", "prime");
      prime.textContent = `Prime ${primeCost}TU`;
      prime.disabled = !playerActing || outOfUses || selected.tu < primeCost || primed;
      prime.title = primed
        ? `Already primed - detonates in ${inst.fuseTurns ?? 1} turn(s)`
        : `Prime ${def.name} for ${primeCost} TU - detonates on the carrier's next turn`;
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
    this.bannerNewCampaignBtn.style.display = campaignOver ? "" : "none";
    this.banner.classList.add("show");
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
    const begin = el("button");
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
