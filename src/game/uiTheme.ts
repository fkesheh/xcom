/**
 * uiTheme.ts — frozen DOM design system (Layer 1 shared vocabulary).
 *
 * All three in-process screens — the tactical HUD (`hud.ts`), the base command
 * center (`baseView.ts`), and the strategic geoscape (`geoscape.ts`) — render DOM
 * panels over a three.js canvas. Historically each injected its OWN `<style>` tag
 * with hardcoded hex, tiny px font sizes, and no shared affordances, so the three
 * screens read as three different apps and all shared the same UX failures:
 * unreadable text, low-contrast gray-on-dark, near-invisible hover/focus, and 3D
 * objects (facilities, the globe) that gave no sign they were clickable.
 *
 * This module is the single source of truth. Each screen prepends {@link UI_TOKENS}
 * (the `:root` design tokens) and {@link UI_BASE} (cross-screen affordances) to its
 * own CSS string, then references the tokens in its per-screen rules:
 *
 *   import { UI_TOKENS, UI_BASE } from "./uiTheme";
 *   const CSS = `${UI_TOKENS}\n${UI_BASE}\n${HUD_THEME}`;
 *
 * The tokens + base layer are FROZEN — screens consume them, never redefine them.
 * Redefining `:root { --ui-* }` in a screen is a contract violation; a screen
 * assigns to `--ui-*` only inside an explicit override scope (e.g. a contrast media
 * query) when it has a documented reason.
 *
 * Palette intent: the dark "underground command" mood already established by the 3D
 * `BASE_PALETTE` (rock / steel / concrete + per-facility emissive accents), lifted
 * to readable contrast. Accent colors map 1:1 to the facility accents so a DOM chip
 * and its 3D facility glow read as the same thing.
 */

/**
 * Design tokens as a `:root` CSS custom-property block. Injected once per screen;
 * `:root` declarations are idempotent so multiple `<style>` tags carrying the same
 * block are harmless. Every DOM color / size in every screen traces to one of these.
 *
 * Contrast: `--ui-muted` (#9fb6c8) clears ~7:1 on the panel surface — the old
 * secondaries (#86a0b5 / #9db5c5 / #7190a4) sat at 3.9–5.6:1, with the geoscape's
 * #7190a4 actually FAILING WCAG AA for body text. `--ui-dim` is for captions only.
 */
export const UI_TOKENS = `
:root {
  /* --- Type scale (px; the app is px-based). Nothing renders under the xs floor. --- */
  --ui-text-xs: 12px;        /* floor — smallest legal text (the old 8–9px is banned) */
  --ui-text-sm: 13px;        /* secondary labels, chip text, button labels */
  --ui-text-base: 14px;      /* body / default */
  --ui-text-md: 15px;        /* emphasized body */
  --ui-text-lg: 17px;        /* card / panel titles */
  --ui-text-xl: 20px;        /* section heads */
  --ui-text-2xl: 26px;       /* panel H1 */
  --ui-text-3xl: 34px;       /* overlay H1 */
  --ui-text-display: clamp(30px, 5vw, 52px);
  --ui-leading-tight: 1.2;
  --ui-leading: 1.45;
  --ui-leading-loose: 1.6;
  --ui-font-ui: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  --ui-font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;

  /* --- Palette (harmonized with 3D BASE_PALETTE). All DOM color traces here. --- */
  --ui-text: #eaf6ff;        /* primary text — bright, high contrast on dark */
  --ui-text-strong: #ffffff;
  --ui-muted: #9fb6c8;       /* secondary text — ~7:1 on panel bg */
  --ui-dim: #7e95a6;         /* tertiary — captions/meta only, never body */
  --ui-cyan: #67e8f9;        /* accent / interactive highlight (= 3D command accent) */
  --ui-amber: #fbbf24;       /* warning / fuel-low (= reactor glow) */
  --ui-green: #4ade80;       /* success / online (= hangar glow) */
  --ui-teal: #38e1d6;        /* info (= lab glow) */
  --ui-purple: #c060ff;      /* radar / psi (= radar glow) */
  --ui-red: #fb7185;         /* danger / hostile (= 3D danger) */

  /* --- Surfaces --- */
  --ui-panel: rgba(8, 16, 24, 0.82);        /* translucent: the 3D scene reads through */
  --ui-panel-raised: rgba(14, 24, 34, 0.9);
  --ui-panel-solid: rgba(6, 12, 18, 0.95);  /* modals / overlays */
  --ui-bg-deep: #050a0f;
  --ui-border: rgba(132, 165, 188, 0.32);
  --ui-border-strong: rgba(103, 232, 249, 0.55);
  --ui-border-bright: rgba(103, 232, 249, 0.92);

  /* --- Track 2 console-glass surface (Style Bible Layer 1). Packages reference
     these instead of hardcoding the brief's hex so the material is tuned in ONE
     place. --ui-panel-glass is the exact "console panel glass" fill from the brief;
     --ui-border-console is the 1px #1d3a4a-family panel edge. --- */
  --ui-panel-glass: rgba(10, 20, 32, 0.82);
  --ui-border-console: #1d3a4a;
  --ui-glow-inner: inset 0 0 0 1px rgba(56, 232, 210, 0.06), inset 0 1px 0 rgba(127, 184, 216, 0.08);

  /* --- Spacing scale --- */
  --ui-sp-1: 4px;
  --ui-sp-2: 8px;
  --ui-sp-3: 12px;
  --ui-sp-4: 16px;
  --ui-sp-5: 20px;
  --ui-sp-6: 24px;
  --ui-sp-8: 32px;

  /* --- Radii --- */
  --ui-radius-sm: 6px;
  --ui-radius: 8px;
  --ui-radius-lg: 12px;
  --ui-radius-pill: 999px;

  /* --- Shadows --- */
  --ui-shadow-sm: 0 2px 8px rgba(0, 0, 0, 0.45);
  --ui-shadow: 0 6px 22px rgba(0, 0, 0, 0.55);
  --ui-shadow-glow: 0 0 0 1px var(--ui-border-strong), 0 8px 24px rgba(0, 0, 0, 0.6);

  /* --- Z-index --- */
  --ui-z-panel: 5;
  --ui-z-sticky: 20;
  --ui-z-overlay: 50;
  --ui-z-toast: 60;
  --ui-z-modal: 80;

  /* --- Motion --- */
  --ui-fast: 120ms;
  --ui-mid: 200ms;
  --ui-ease: cubic-bezier(0.2, 0.7, 0.2, 1);
}
`;

/**
 * Cross-screen DOM UX base layer. These are NEW affordances the per-screen CSS
 * historically lacked; per-screen rules still own their layout and the specific
 * values (migrated onto the tokens above). Scoped to the three screen roots so it
 * never leaks to the new-game screen or anything outside the in-process views.
 *
 * What it guarantees everywhere: pointer cursor on every interactive thing,
 * visible keyboard focus rings, a readable themed scrollbar, reduced-motion + a
 * contrast-boost media query, and an opt-in primary-action (`.ui-cta`) treatment.
 */
export const UI_BASE = `
/* --- Screen roots inherit readable defaults (the old floor was an 8px OS default). --- */
#hud, #base-view, #geoscape, #plane-combat {
  color: var(--ui-text);
  font-family: var(--ui-font-ui);
  font-size: var(--ui-text-base);
  line-height: var(--ui-leading);
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* --- Interactive things look interactive. Pointer cursor on every button plus the
   rows/toggles the screens mark as clickable (facility list rows, globe, deploy
   toggles, option rows, tech-tree nodes). Add [data-clickable] to any 3D-driven
   control surface you want to feel pressable. --- */
#hud button, #base-view button, #geoscape button, #plane-combat button,
[data-clickable], .facility-row, .room-card, .geo-diff-option, .deploy-toggle,
.soldier-row, .item-btn, .tech-node { cursor: pointer; }
#hud button[disabled], #base-view button[disabled], #geoscape button[disabled],
#plane-combat button[disabled] {
  cursor: not-allowed;
}

/* --- Visible keyboard focus everywhere. The old CSS only ringed buttons; list rows,
   toggles and option cards were unreachable-looking from the keyboard. --- */
#hud button:focus-visible,
#base-view button:focus-visible,
#geoscape button:focus-visible,
#plane-combat button:focus-visible,
#hud [tabindex]:focus-visible,
#base-view [tabindex]:focus-visible,
#geoscape [tabindex]:focus-visible,
#plane-combat [tabindex]:focus-visible,
.geo-diff-option:focus-visible, .deploy-toggle:focus-visible, .room-card:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 2px;
  border-radius: var(--ui-radius-sm);
}

/* --- A themed scrollbar that matches the dark surfaces instead of the OS default. --- */
#hud ::-webkit-scrollbar,
#base-view ::-webkit-scrollbar,
#geoscape ::-webkit-scrollbar,
#plane-combat ::-webkit-scrollbar { width: 10px; height: 10px; }
#hud ::-webkit-scrollbar-thumb,
#base-view ::-webkit-scrollbar-thumb,
#geoscape ::-webkit-scrollbar-thumb,
#plane-combat ::-webkit-scrollbar-thumb {
  background: rgba(132, 165, 188, 0.38);
  border-radius: var(--ui-radius-pill);
}
#hud ::-webkit-scrollbar-thumb:hover,
#base-view ::-webkit-scrollbar-thumb:hover,
#geoscape ::-webkit-scrollbar-thumb:hover,
#plane-combat ::-webkit-scrollbar-thumb:hover { background: rgba(103, 232, 249, 0.5); }
#hud ::-webkit-scrollbar-track,
#base-view ::-webkit-scrollbar-track,
#geoscape ::-webkit-scrollbar-track,
#plane-combat ::-webkit-scrollbar-track { background: transparent; }
#hud, #base-view, #geoscape, #plane-combat { scrollbar-width: thin; scrollbar-color: rgba(132,165,188,0.4) transparent; }

/* --- Respect reduced motion across all screens. --- */
@media (prefers-reduced-motion: reduce) {
  #hud *, #base-view *, #geoscape *, #plane-combat * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

/* --- Honor "increase contrast": brighten secondary text + thicken borders. --- */
@media (prefers-contrast: more) {
  #hud, #base-view, #geoscape, #plane-combat {
    --ui-muted: #c8d8e6;
    --ui-dim: #a4b6c5;
    --ui-border: rgba(190, 210, 228, 0.6);
  }
}
`;

/**
 * Optional shared component classes. Screens add these class names to markup to
 * opt into the common treatments, so a primary action / eyebrow / chip looks the
 * same on every screen without each restyling from scratch. The `ui-` prefix
 * avoids collision with existing presentational classes (`.eyebrow`, `.chip`, …).
 */
export const UI_COMPONENTS = `
/* .ui-cta — the ONE primary action on a screen (launch mission, intercept, deploy,
   end turn). Big, bright, unmissable: the answer to "what do I do next?". */
#hud .ui-cta, #base-view .ui-cta, #geoscape .ui-cta, #plane-combat .ui-cta {
  min-height: 46px;
  padding: 0 22px;
  font-family: var(--ui-font-mono);
  font-weight: 800;
  font-size: var(--ui-text-md);
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--ui-bg-deep);
  background: linear-gradient(180deg, var(--ui-cyan), #2bc5e0);
  border: 1px solid var(--ui-border-bright);
  border-radius: var(--ui-radius);
  box-shadow: var(--ui-shadow-glow);
  transition: transform var(--ui-fast) var(--ui-ease), filter var(--ui-fast) var(--ui-ease);
}
#hud .ui-cta:hover:not(:disabled),
#base-view .ui-cta:hover:not(:disabled),
#geoscape .ui-cta:hover:not(:disabled),
#plane-combat .ui-cta:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
#hud .ui-cta:active:not(:disabled),
#base-view .ui-cta:active:not(:disabled),
#geoscape .ui-cta:active:not(:disabled),
#plane-combat .ui-cta:active:not(:disabled) { transform: translateY(1px); }
#hud .ui-cta:disabled, #base-view .ui-cta:disabled, #geoscape .ui-cta:disabled,
#plane-combat .ui-cta:disabled {
  filter: grayscale(0.85); opacity: 0.5; box-shadow: none;
}

/* .ui-eyebrow — the small uppercase label that sits above a title. Replaces the
   ad-hoc 8–9px labels that were unreadable. */
#hud .ui-eyebrow, #base-view .ui-eyebrow, #geoscape .ui-eyebrow, #plane-combat .ui-eyebrow {
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ui-cyan);
}

/* .ui-section-title — a panel heading, consistent weight + tracking. */
#hud .ui-section-title, #base-view .ui-section-title, #geoscape .ui-section-title,
#plane-combat .ui-section-title {
  font-size: var(--ui-text-lg);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--ui-text-strong);
}
`;

/**
 * Track 2 reusable primitives (console-glass panel, stat chip, button tiers, toast).
 * Screens append this the same way they append {@link UI_COMPONENTS}:
 *
 *   import { UI_TOKENS, UI_BASE, UI_COMPONENTS, UI_PRIMITIVES } from "./uiTheme";
 *   const CSS = `${UI_TOKENS}\n${UI_BASE}\n${UI_COMPONENTS}\n${UI_PRIMITIVES}`;
 *
 * Every value traces to a token above — packages never hardcode the brief's hex.
 * All selectors are scoped to the four screen roots so nothing leaks. These are
 * CSS-only: screens add the class names and own their element creation + lifecycle
 * (toast timers, panel content). No JS is exported here on purpose.
 */
export const UI_PRIMITIVES = `
/* ============================================================================
   .ui-panel — the console-glass material every rebuilt panel sits on.
   rgba(10,20,32,0.82) surface · 1px #1d3a4a border · 6px radius · subtle inner
   glow · cheap optional backdrop blur. Pair .ui-panel-header (fixed) with
   .ui-panel-body (scrollable, themed thin scrollbar via UI_BASE) to build the
   fixed-header / scroll-body column the base sidebar rebuilds on.
   ========================================================================== */
#hud .ui-panel, #base-view .ui-panel, #geoscape .ui-panel, #plane-combat .ui-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--ui-panel-glass);
  border: 1px solid var(--ui-border-console);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow-sm);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: var(--ui-text);
}
#hud .ui-panel-header, #base-view .ui-panel-header,
#geoscape .ui-panel-header, #plane-combat .ui-panel-header {
  flex: 0 0 auto;
  padding: var(--ui-sp-4);
  border-bottom: 1px solid var(--ui-border-console);
}
/* Scrollable region: overflow-y auto with the themed thin scrollbar already
   defined in UI_BASE. min-height:0 lets it actually shrink inside a flex column
   so content scrolls instead of clipping (the base-sidebar bug). */
#hud .ui-panel-body, #base-view .ui-panel-body,
#geoscape .ui-panel-body, #plane-combat .ui-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding: var(--ui-sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-4);
}

/* ============================================================================
   .ui-chip — compact stat chip (icon + label + value). Semantic modifiers tint
   only the accent (border/icon/value); text stays readable. Used by the geoscape
   stat strip and the base topbar so both read as one system.
   ========================================================================== */
#hud .ui-chip, #base-view .ui-chip, #geoscape .ui-chip, #plane-combat .ui-chip {
  display: inline-flex;
  align-items: center;
  gap: var(--ui-sp-2);
  min-height: 26px;
  padding: var(--ui-sp-1) var(--ui-sp-3);
  background: var(--ui-panel-raised);
  border: 1px solid var(--ui-border);
  border-radius: var(--ui-radius-sm);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  line-height: 1;
  white-space: nowrap;
  color: var(--ui-text);
}
#hud .ui-chip__icon, #base-view .ui-chip__icon, #geoscape .ui-chip__icon, #plane-combat .ui-chip__icon {
  display: inline-flex;
  color: var(--ui-muted);
}
#hud .ui-chip__label, #base-view .ui-chip__label, #geoscape .ui-chip__label, #plane-combat .ui-chip__label {
  color: var(--ui-muted);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: var(--ui-text-xs);
}
#hud .ui-chip__value, #base-view .ui-chip__value, #geoscape .ui-chip__value, #plane-combat .ui-chip__value {
  color: var(--ui-text-strong);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
/* Semantic modifiers — one accent color per class (Style Bible rule 3). */
#hud .ui-chip--info, #base-view .ui-chip--info, #geoscape .ui-chip--info, #plane-combat .ui-chip--info {
  border-color: rgba(127, 184, 216, 0.5);
}
#hud .ui-chip--info .ui-chip__icon, #base-view .ui-chip--info .ui-chip__icon,
#geoscape .ui-chip--info .ui-chip__icon, #plane-combat .ui-chip--info .ui-chip__icon,
#hud .ui-chip--info .ui-chip__value, #base-view .ui-chip--info .ui-chip__value,
#geoscape .ui-chip--info .ui-chip__value, #plane-combat .ui-chip--info .ui-chip__value {
  color: var(--ui-cyan);
}
#hud .ui-chip--accent, #base-view .ui-chip--accent, #geoscape .ui-chip--accent, #plane-combat .ui-chip--accent {
  border-color: rgba(56, 225, 214, 0.55);
}
#hud .ui-chip--accent .ui-chip__icon, #base-view .ui-chip--accent .ui-chip__icon,
#geoscape .ui-chip--accent .ui-chip__icon, #plane-combat .ui-chip--accent .ui-chip__icon,
#hud .ui-chip--accent .ui-chip__value, #base-view .ui-chip--accent .ui-chip__value,
#geoscape .ui-chip--accent .ui-chip__value, #plane-combat .ui-chip--accent .ui-chip__value {
  color: var(--ui-teal);
}
#hud .ui-chip--warn, #base-view .ui-chip--warn, #geoscape .ui-chip--warn, #plane-combat .ui-chip--warn {
  border-color: rgba(251, 191, 36, 0.55); /* = --ui-amber #fbbf24 */
}
#hud .ui-chip--warn .ui-chip__icon, #base-view .ui-chip--warn .ui-chip__icon,
#geoscape .ui-chip--warn .ui-chip__icon, #plane-combat .ui-chip--warn .ui-chip__icon,
#hud .ui-chip--warn .ui-chip__value, #base-view .ui-chip--warn .ui-chip__value,
#geoscape .ui-chip--warn .ui-chip__value, #plane-combat .ui-chip--warn .ui-chip__value {
  color: var(--ui-amber);
}
#hud .ui-chip--danger, #base-view .ui-chip--danger, #geoscape .ui-chip--danger, #plane-combat .ui-chip--danger {
  border-color: rgba(251, 113, 133, 0.55);
}
#hud .ui-chip--danger .ui-chip__icon, #base-view .ui-chip--danger .ui-chip__icon,
#geoscape .ui-chip--danger .ui-chip__icon, #plane-combat .ui-chip--danger .ui-chip__icon,
#hud .ui-chip--danger .ui-chip__value, #base-view .ui-chip--danger .ui-chip__value,
#geoscape .ui-chip--danger .ui-chip__value, #plane-combat .ui-chip--danger .ui-chip__value {
  color: var(--ui-red);
}

/* ============================================================================
   Button tiers (Style Bible item 4). .ui-cta stays the ONE primary (above).
   .ui-btn = secondary outline, teal fill on hover.
   .ui-btn--danger = amber/red outline. Disabled = 40% opacity + no hover.
   Focus ring is inherited from UI_BASE :focus-visible rules.
   ========================================================================== */
#hud .ui-btn, #base-view .ui-btn, #geoscape .ui-btn, #plane-combat .ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--ui-sp-2);
  min-height: 34px;
  padding: 0 var(--ui-sp-4);
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-sm);
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--ui-cyan);
  background: transparent;
  border: 1px solid var(--ui-border-strong);
  border-radius: var(--ui-radius-sm);
  transition: color var(--ui-fast) var(--ui-ease),
              background var(--ui-fast) var(--ui-ease),
              border-color var(--ui-fast) var(--ui-ease);
}
#hud .ui-btn:hover:not(:disabled), #base-view .ui-btn:hover:not(:disabled),
#geoscape .ui-btn:hover:not(:disabled), #plane-combat .ui-btn:hover:not(:disabled) {
  color: var(--ui-bg-deep);
  background: var(--ui-cyan);
  border-color: var(--ui-border-bright);
}
#hud .ui-btn--danger, #base-view .ui-btn--danger, #geoscape .ui-btn--danger, #plane-combat .ui-btn--danger {
  color: var(--ui-amber);
  border-color: rgba(251, 191, 36, 0.6); /* = --ui-amber #fbbf24 */
}
#hud .ui-btn--danger:hover:not(:disabled), #base-view .ui-btn--danger:hover:not(:disabled),
#geoscape .ui-btn--danger:hover:not(:disabled), #plane-combat .ui-btn--danger:hover:not(:disabled) {
  color: var(--ui-bg-deep);
  background: var(--ui-red);
  border-color: var(--ui-red);
}
#hud .ui-btn:disabled, #base-view .ui-btn:disabled, #geoscape .ui-btn:disabled, #plane-combat .ui-btn:disabled,
#hud .ui-btn--danger:disabled, #base-view .ui-btn--danger:disabled,
#geoscape .ui-btn--danger:disabled, #plane-combat .ui-btn--danger:disabled {
  opacity: 0.4;
  color: var(--ui-muted);
  background: transparent;
  border-color: var(--ui-border);
}

/* ============================================================================
   .ui-toast — single toast treatment (Style Bible item 6). Top-center, fixed,
   auto-dismiss animation, semantic tones via [data-tone]. Screens keep their own
   element + timer wiring; this is only the look. reducedMotion is covered by the
   UI_BASE media query (it neutralizes the enter/exit animation duration).
   ========================================================================== */
#hud .ui-toast, #base-view .ui-toast, #geoscape .ui-toast, #plane-combat .ui-toast {
  position: fixed;
  top: var(--ui-sp-5);
  left: 50%;
  transform: translateX(-50%);
  z-index: var(--ui-z-toast);
  display: inline-flex;
  align-items: center;
  gap: var(--ui-sp-3);
  max-width: min(560px, 92vw);
  padding: var(--ui-sp-3) var(--ui-sp-5);
  background: var(--ui-panel-glass);
  border: 1px solid var(--ui-border-console);
  border-left: 3px solid var(--ui-cyan);
  border-radius: var(--ui-radius-sm);
  box-shadow: var(--ui-glow-inner), var(--ui-shadow);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  color: var(--ui-text);
  font-family: var(--ui-font-ui);
  font-size: var(--ui-text-base);
  line-height: var(--ui-leading);
  animation: ui-toast-in var(--ui-mid) var(--ui-ease),
             ui-toast-out var(--ui-mid) var(--ui-ease) forwards 3.6s;
}
#hud .ui-toast[data-tone='info'], #base-view .ui-toast[data-tone='info'],
#geoscape .ui-toast[data-tone='info'], #plane-combat .ui-toast[data-tone='info'] {
  border-left-color: var(--ui-cyan);
}
#hud .ui-toast[data-tone='warning'], #base-view .ui-toast[data-tone='warning'],
#geoscape .ui-toast[data-tone='warning'], #plane-combat .ui-toast[data-tone='warning'] {
  border-left-color: var(--ui-amber);
}
#hud .ui-toast[data-tone='danger'], #base-view .ui-toast[data-tone='danger'],
#geoscape .ui-toast[data-tone='danger'], #plane-combat .ui-toast[data-tone='danger'] {
  border-left-color: var(--ui-red);
}
@keyframes ui-toast-in {
  from { opacity: 0; transform: translateX(-50%) translateY(-8px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@keyframes ui-toast-out {
  from { opacity: 1; transform: translateX(-50%) translateY(0); }
  to   { opacity: 0; transform: translateX(-50%) translateY(-8px); }
}
`;
