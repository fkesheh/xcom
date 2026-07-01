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
#hud, #base-view, #geoscape {
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
#hud button, #base-view button, #geoscape button,
[data-clickable], .facility-row, .room-card, .geo-diff-option, .deploy-toggle,
.soldier-row, .item-btn, .tech-node { cursor: pointer; }
#hud button[disabled], #base-view button[disabled], #geoscape button[disabled] {
  cursor: not-allowed;
}

/* --- Visible keyboard focus everywhere. The old CSS only ringed buttons; list rows,
   toggles and option cards were unreachable-looking from the keyboard. --- */
#hud button:focus-visible,
#base-view button:focus-visible,
#geoscape button:focus-visible,
#hud [tabindex]:focus-visible,
#base-view [tabindex]:focus-visible,
#geoscape [tabindex]:focus-visible,
.geo-diff-option:focus-visible, .deploy-toggle:focus-visible, .room-card:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 2px;
  border-radius: var(--ui-radius-sm);
}

/* --- A themed scrollbar that matches the dark surfaces instead of the OS default. --- */
#hud ::-webkit-scrollbar,
#base-view ::-webkit-scrollbar,
#geoscape ::-webkit-scrollbar { width: 10px; height: 10px; }
#hud ::-webkit-scrollbar-thumb,
#base-view ::-webkit-scrollbar-thumb,
#geoscape ::-webkit-scrollbar-thumb {
  background: rgba(132, 165, 188, 0.38);
  border-radius: var(--ui-radius-pill);
}
#hud ::-webkit-scrollbar-thumb:hover,
#base-view ::-webkit-scrollbar-thumb:hover,
#geoscape ::-webkit-scrollbar-thumb:hover { background: rgba(103, 232, 249, 0.5); }
#hud ::-webkit-scrollbar-track,
#base-view ::-webkit-scrollbar-track,
#geoscape ::-webkit-scrollbar-track { background: transparent; }
#hud, #base-view, #geoscape { scrollbar-width: thin; scrollbar-color: rgba(132,165,188,0.4) transparent; }

/* --- Respect reduced motion across all screens. --- */
@media (prefers-reduced-motion: reduce) {
  #hud *, #base-view *, #geoscape * {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}

/* --- Honor "increase contrast": brighten secondary text + thicken borders. --- */
@media (prefers-contrast: more) {
  #hud, #base-view, #geoscape {
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
#hud .ui-cta, #base-view .ui-cta, #geoscape .ui-cta {
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
#geoscape .ui-cta:hover:not(:disabled) { filter: brightness(1.12); transform: translateY(-1px); }
#hud .ui-cta:active:not(:disabled),
#base-view .ui-cta:active:not(:disabled),
#geoscape .ui-cta:active:not(:disabled) { transform: translateY(1px); }
#hud .ui-cta:disabled, #base-view .ui-cta:disabled, #geoscape .ui-cta:disabled {
  filter: grayscale(0.85); opacity: 0.5; box-shadow: none;
}

/* .ui-eyebrow — the small uppercase label that sits above a title. Replaces the
   ad-hoc 8–9px labels that were unreadable. */
#hud .ui-eyebrow, #base-view .ui-eyebrow, #geoscape .ui-eyebrow {
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs);
  font-weight: 700;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  color: var(--ui-cyan);
}

/* .ui-section-title — a panel heading, consistent weight + tracking. */
#hud .ui-section-title, #base-view .ui-section-title, #geoscape .ui-section-title {
  font-size: var(--ui-text-lg);
  font-weight: 700;
  letter-spacing: 0.02em;
  color: var(--ui-text-strong);
}
`;
