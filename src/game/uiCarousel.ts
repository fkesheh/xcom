/**
 * uiCarousel.ts — a framework-free, console-glass styled carousel.
 *
 * The base command center historically rendered research, manufacturing, and the
 * barracks roster as scrolling lists of cards. In the narrow (~340px) base sidebar
 * those cards clipped their own text horizontally ("Adds one plasm…", "Service
 * Rif…", "NEED RESOURC…"). This component replaces those lists with a one-item-at-
 * a-time carousel: each item gets the FULL width of the panel to show its complete
 * detail (name, description, costs, status, action button, or a full soldier
 * dossier), with prev/next arrows, position dots, keyboard arrows, and a compact
 * strip of every item below for direct jumps.
 *
 * It is deliberately self-contained: it injects its own `<style>` once, has its own
 * local {@link el} helper (it must NOT import baseView's), and references only the
 * shared design tokens from {@link ./uiTheme} so it reads as the same console-glass
 * material as every other panel. Callers own each item's `render()` — this module
 * only owns the framing (arrows, dots, strip, keyboard) and lifecycle.
 */

const CAROUSEL_STYLE_ID = "blacksite-carousel-style";

/** Local element helper — intentionally NOT imported from baseView (contract §1). */
function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/**
 * One carousel entry. `render()` builds the FULL detail panel for the item and is
 * called lazily each time the item becomes the active slide, so callers can wire
 * fresh event listeners against live state on every show. `stripLabel` +
 * `stripStatus` drive the compact jump strip below the slide.
 */
export interface CarouselItem {
  id: string;
  stripLabel: string;
  stripStatus?: "active" | "ready" | "locked" | "done";
  render: () => HTMLElement;
}

export interface CarouselOptions {
  items: CarouselItem[];
  initialIndex?: number;
  ariaLabel?: string;
  onIndexChange?: (index: number) => void;
}

export interface CarouselHandle {
  root: HTMLElement;
  setIndex(i: number): void;
  getIndex(): number;
  destroy(): void;
}

/** Status-dot tint per strip status. One accent per class (Style Bible rule 3). */
const STRIP_STATUS_LABEL: Record<NonNullable<CarouselItem["stripStatus"]>, string> = {
  active: "In progress",
  ready: "Ready",
  locked: "Locked",
  done: "Done",
};

function injectStyle(): void {
  if (document.getElementById(CAROUSEL_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = CAROUSEL_STYLE_ID;
  style.textContent = CAROUSEL_CSS;
  document.head.appendChild(style);
}

/**
 * Create a carousel over `items`. Exactly one item's `render()` panel is mounted at
 * a time. Returns a handle to drive it programmatically and to dispose it (the
 * keyboard listener is scoped to the returned root and removed in `destroy()`).
 */
export function createCarousel(opts: CarouselOptions): CarouselHandle {
  injectStyle();
  const items = opts.items;
  const count = items.length;
  let index = clampIndex(opts.initialIndex ?? 0, count);

  const root = el("div", "bs-carousel");
  root.setAttribute("role", "region");
  if (opts.ariaLabel) root.setAttribute("aria-label", opts.ariaLabel);
  root.tabIndex = 0;

  // --- Empty state: no framing, just a quiet message. ---
  if (count === 0) {
    const empty = el("div", "bs-carousel__empty");
    empty.textContent = "Nothing to show.";
    root.appendChild(empty);
    return {
      root,
      setIndex: () => {},
      getIndex: () => 0,
      destroy: () => root.remove(),
    };
  }

  // --- Top navigation row: prev · dots · next. ---
  const nav = el("div", "bs-carousel__nav");
  const prevBtn = el("button", "bs-carousel__arrow");
  prevBtn.type = "button";
  prevBtn.setAttribute("aria-label", "Previous");
  prevBtn.textContent = "‹";
  const dots = el("div", "bs-carousel__dots");
  const nextBtn = el("button", "bs-carousel__arrow");
  nextBtn.type = "button";
  nextBtn.setAttribute("aria-label", "Next");
  nextBtn.textContent = "›";
  const dotBtns: HTMLButtonElement[] = [];
  for (let i = 0; i < count; i++) {
    const dot = el("button", "bs-carousel__dot");
    dot.type = "button";
    dot.setAttribute("aria-label", `Go to item ${i + 1} of ${count}`);
    dot.addEventListener("click", () => setIndex(i));
    dotBtns.push(dot);
    dots.appendChild(dot);
  }
  nav.append(prevBtn, dots, nextBtn);

  // --- The single visible slide. ---
  const viewport = el("div", "bs-carousel__viewport");

  // --- The compact jump strip: every item as a labelled cell + status dot. ---
  const strip = el("div", "bs-carousel__strip");
  const stripCells: HTMLButtonElement[] = [];
  for (let i = 0; i < count; i++) {
    const item = items[i]!;
    const cell = el("button", "bs-carousel__cell");
    cell.type = "button";
    const status = item.stripStatus;
    if (status) {
      const dot = el("span", `bs-carousel__cell-dot bs-carousel__cell-dot--${status}`);
      dot.title = STRIP_STATUS_LABEL[status];
      cell.appendChild(dot);
    }
    const label = el("span", "bs-carousel__cell-label");
    label.textContent = item.stripLabel;
    cell.appendChild(label);
    cell.setAttribute("aria-label", `${item.stripLabel}${status ? ` — ${STRIP_STATUS_LABEL[status]}` : ""}`);
    cell.addEventListener("click", () => setIndex(i));
    stripCells.push(cell);
    strip.appendChild(cell);
  }

  root.append(nav, viewport, strip);

  prevBtn.addEventListener("click", () => setIndex(index - 1));
  nextBtn.addEventListener("click", () => setIndex(index + 1));

  // Keyboard arrows, scoped to root. Ignore when the focused control is a text
  // input, textarea, or select so arrow keys still edit those natively.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const target = event.target as HTMLElement | null;
    const tag = target?.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    event.preventDefault();
    setIndex(index + (event.key === "ArrowRight" ? 1 : -1));
  };
  root.addEventListener("keydown", onKeyDown);

  function renderSlide(): void {
    const item = items[index]!;
    const panel = el("div", "bs-carousel__slide");
    panel.appendChild(item.render());
    viewport.replaceChildren(panel);
  }

  function syncChrome(): void {
    for (let i = 0; i < count; i++) {
      const active = i === index;
      dotBtns[i]!.classList.toggle("is-active", active);
      dotBtns[i]!.setAttribute("aria-current", active ? "true" : "false");
      stripCells[i]!.classList.toggle("is-active", active);
      stripCells[i]!.setAttribute("aria-current", active ? "true" : "false");
    }
    // A single item needs no arrows.
    const solo = count <= 1;
    prevBtn.disabled = solo;
    nextBtn.disabled = solo;
    nav.classList.toggle("is-solo", solo);
  }

  function setIndex(i: number): void {
    const next = clampIndex(i, count);
    const changed = next !== index;
    index = next;
    renderSlide();
    syncChrome();
    // Keep the active strip cell in view.
    stripCells[index]?.scrollIntoView({ block: "nearest", inline: "nearest" });
    if (changed) opts.onIndexChange?.(index);
  }

  renderSlide();
  syncChrome();

  return {
    root,
    setIndex,
    getIndex: () => index,
    destroy: () => {
      root.removeEventListener("keydown", onKeyDown);
      root.replaceChildren();
      root.remove();
    },
  };
}

/** Wrap-around clamp: -1 → last, count → 0. Keeps navigation cyclic. */
function clampIndex(i: number, count: number): number {
  if (count <= 0) return 0;
  return ((i % count) + count) % count;
}

const CAROUSEL_CSS = `
.bs-carousel {
  display: flex;
  flex-direction: column;
  gap: var(--ui-sp-3);
  min-width: 0;
  outline: none;
}
.bs-carousel:focus-visible {
  outline: 2px solid var(--ui-cyan);
  outline-offset: 3px;
  border-radius: var(--ui-radius-sm);
}
.bs-carousel__empty {
  padding: var(--ui-sp-4);
  color: var(--ui-muted);
  font-family: var(--ui-font-ui);
  font-size: var(--ui-text-sm);
  text-align: center;
}

/* --- nav row: arrows flanking position dots --- */
.bs-carousel__nav {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--ui-sp-3);
}
.bs-carousel__nav.is-solo { visibility: hidden; height: 0; margin: -6px 0; }
/* The three controls below use !important on layout/appearance because a host
   screen (e.g. #base-view button {...}) styles bare <button>s with an ID selector
   that would otherwise out-specify this component's single-class rules and balloon
   the dots/arrows. The widget must look identical wherever it is mounted. */
.bs-carousel__arrow {
  flex: 0 0 auto;
  display: inline-flex !important;
  align-items: center;
  justify-content: center;
  width: 34px !important;
  height: 34px !important;
  min-height: 34px !important;
  padding: 0 !important;
  font-family: var(--ui-font-mono);
  font-size: 22px !important;
  line-height: 1;
  letter-spacing: 0 !important;
  text-transform: none !important;
  color: var(--ui-cyan) !important;
  background: var(--ui-panel-raised) !important;
  border: 1px solid var(--ui-border-strong) !important;
  border-radius: var(--ui-radius-sm) !important;
  cursor: pointer;
  transition: color var(--ui-fast) var(--ui-ease),
              background var(--ui-fast) var(--ui-ease),
              border-color var(--ui-fast) var(--ui-ease);
}
.bs-carousel__arrow:hover:not(:disabled) {
  color: var(--ui-bg-deep) !important;
  background: var(--ui-cyan) !important;
  border-color: var(--ui-border-bright) !important;
}
.bs-carousel__arrow:disabled { opacity: 0.35; cursor: not-allowed; }
.bs-carousel__dots {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--ui-sp-2);
  min-width: 0;
}
.bs-carousel__dot {
  width: 9px !important;
  height: 9px !important;
  min-height: 0 !important;
  padding: 0 !important;
  border: 0 !important;
  border-radius: var(--ui-radius-pill) !important;
  background: rgba(159, 182, 200, 0.35) !important;
  cursor: pointer;
  transition: background var(--ui-fast) var(--ui-ease), transform var(--ui-fast) var(--ui-ease);
}
.bs-carousel__dot:hover { background: rgba(103, 232, 249, 0.6) !important; }
.bs-carousel__dot.is-active {
  background: var(--ui-cyan) !important;
  transform: scale(1.35);
  box-shadow: 0 0 6px rgba(103, 232, 249, 0.7);
}

/* --- the single visible slide --- */
.bs-carousel__viewport { min-width: 0; }
.bs-carousel__slide {
  min-width: 0;
  animation: bs-carousel-fade var(--ui-mid) var(--ui-ease);
}
@keyframes bs-carousel-fade {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* --- compact jump strip: one cell per item ---
   Wraps within the panel width rather than scrolling horizontally: in a narrow
   (~340px) sidebar a single-row filmstrip pushed later cells far past the viewport
   edge (they were never visible without scrolling, and read as clipped). Wrapping
   keeps every label on-screen and inside the panel box. */
.bs-carousel__strip {
  display: flex;
  flex-wrap: wrap;
  gap: var(--ui-sp-2);
  padding-bottom: var(--ui-sp-1);
  min-width: 0;
}
.bs-carousel__cell {
  flex: 0 0 auto;
  display: inline-flex !important;
  align-items: center;
  gap: var(--ui-sp-2);
  min-height: 28px !important;
  padding: var(--ui-sp-1) var(--ui-sp-3) !important;
  font-family: var(--ui-font-mono);
  font-size: var(--ui-text-xs) !important;
  font-weight: 700;
  letter-spacing: 0.02em !important;
  text-transform: none !important;
  color: var(--ui-muted) !important;
  background: var(--ui-panel-raised) !important;
  border: 1px solid var(--ui-border) !important;
  border-radius: var(--ui-radius-pill) !important;
  cursor: pointer;
  transition: color var(--ui-fast) var(--ui-ease),
              border-color var(--ui-fast) var(--ui-ease),
              background var(--ui-fast) var(--ui-ease);
}
.bs-carousel__cell:hover { border-color: var(--ui-border-strong) !important; color: var(--ui-text) !important; }
.bs-carousel__cell.is-active {
  color: var(--ui-text-strong) !important;
  border-color: var(--ui-border-bright) !important;
  background: rgba(14, 52, 67, 0.9) !important;
}
.bs-carousel__cell-label {
  white-space: nowrap;
  /* The strip is a horizontally-scrollable filmstrip, so cells size to their full
     label — no internal ellipsis truncation (which clipped longer project/weapon
     names like "Powered assault armor" against a fixed cell width). */
}
.bs-carousel__cell-dot {
  flex: 0 0 auto;
  width: 7px;
  height: 7px;
  border-radius: var(--ui-radius-pill);
  background: var(--ui-muted);
}
.bs-carousel__cell-dot--active { background: var(--ui-amber); box-shadow: 0 0 5px rgba(251, 191, 36, 0.7); }
.bs-carousel__cell-dot--ready { background: var(--ui-cyan); }
.bs-carousel__cell-dot--locked { background: rgba(159, 182, 200, 0.45); }
.bs-carousel__cell-dot--done { background: var(--ui-green); }
`;
