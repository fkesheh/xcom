/**
 * uiFormat.ts — pure, dependency-free number formatters shared by every DOM screen.
 *
 * Layer 1 foundation (see uiTheme.ts for the CSS half). Historically each screen
 * interpolated raw floats straight into the DOM, producing bugs like
 * "43.93333333333321h until airborne" (the HUD/geoscape/base repair timers) and
 * inconsistent credit/percent rendering. This module is the single source of truth
 * for turning a number into player-facing text.
 *
 * DETERMINISM CONTRACT: every function here is a pure function of its numeric input.
 * No `toLocaleString` (locale differs across CI/dev machines), no `Date`, no `Math`
 * randomness — the same number always yields the same string on every machine. Tests
 * assert exact strings, so these outputs are effectively frozen: change them only by
 * changing the tests in lockstep.
 */

/**
 * Format a duration in hours as a compact human string.
 *
 * - Rounds to whole hours (kills the `.93333h` float noise).
 * - Negative / NaN / non-finite inputs clamp to `"0h"`.
 * - Under 24h: `"44h"`, `"0h"`, `"23h"`.
 * - 24h and over: `"1d"`, `"1d 20h"`, `"3d"` (hours part omitted when zero).
 *
 * @example formatHours(43.9333) // "44h"
 * @example formatHours(44)      // "1d 20h"
 * @example formatHours(-5)      // "0h"
 */
export function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours <= 0) return "0h";
  const total = Math.round(hours);
  if (total <= 0) return "0h";
  const days = Math.floor(total / 24);
  const rem = total % 24;
  if (days > 0 && rem > 0) return `${days}d ${rem}h`;
  if (days > 0) return `${days}d`;
  return `${rem}h`;
}

/**
 * Alias of {@link formatHours}, named for call sites that read a "duration" rather
 * than a clock offset (e.g. the HUD's former private `formatDuration`). Identical
 * contract and output.
 */
export const formatDuration = formatHours;

/**
 * Format an already-computed percentage (0–100 scale) as an integer percent string.
 *
 * CONTRACT: the argument is a PERCENT, not a 0–1 ratio. `formatPercent(72)` → `"72%"`.
 * To go from a 0–1 ratio use {@link ratioToPercent}. Output is always an integer
 * with a `%` suffix; NaN/non-finite clamps to `"0%"`. Values are rounded, not floored.
 *
 * @example formatPercent(72)     // "72%"
 * @example formatPercent(72.6)   // "73%"
 * @example formatPercent(0)      // "0%"
 */
export function formatPercent(pct: number): string {
  if (!Number.isFinite(pct)) return "0%";
  return `${Math.round(pct)}%`;
}

/**
 * Format a 0–1 ratio as an integer percent string. `ratioToPercent(0.723)` → `"72%"`.
 * Thin wrapper over {@link formatPercent} so call sites pick the contract that matches
 * their data instead of multiplying by 100 inline.
 *
 * @example ratioToPercent(0.723) // "72%"
 * @example ratioToPercent(1)     // "100%"
 */
export function ratioToPercent(ratio: number): string {
  if (!Number.isFinite(ratio)) return "0%";
  return formatPercent(ratio * 100);
}

/**
 * Group an integer's digits with thousands separators, deterministically (hand-rolled;
 * NOT `toLocaleString`). Handles the sign separately so `-12400` → `"-12,400"`.
 * Fractional inputs are rounded to the nearest integer first.
 */
export function groupThousands(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  let out = "";
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ",";
    out += digits[i];
  }
  return sign + out;
}

/**
 * Format a craft/UFO cruise speed given in REAL-WORLD km/h for the DOM. Speeds are
 * modelled internally as great-circle degrees per hour; call sites convert with
 * `degPerHourToKmh` (campaign layer) before formatting, so the player reads a
 * grounded number ("4,023 km/h") instead of an abstract "36.2°/h". Thousands are
 * grouped deterministically (no locale); NaN / non-finite / negative clamps to
 * `"0 km/h"`.
 *
 * @example formatSpeed(4023)  // "4,023 km/h"
 * @example formatSpeed(2736)  // "2,736 km/h"
 * @example formatSpeed(0)     // "0 km/h"
 */
export function formatSpeed(kmh: number): string {
  const v = Number.isFinite(kmh) && kmh > 0 ? kmh : 0;
  return `${groupThousands(v)} km/h`;
}

/**
 * Format a credit amount with thousands separators and a `c` suffix.
 * Deterministic across machines (no locale). `formatCredits(12400)` → `"12,400c"`.
 * Negative values keep their sign: `formatCredits(-800)` → `"-800c"`.
 *
 * @example formatCredits(12400)  // "12,400c"
 * @example formatCredits(950)    // "950c"
 */
export function formatCredits(credits: number): string {
  return `${groupThousands(credits)}c`;
}

/**
 * Format a signed credit net for funding reports: an explicit `+` on non-negative
 * values, thousands-separated, `c` suffix. Replaces geoscape's inline `fmtNet`.
 *
 * - `formatSignedCredits(2100)`  → `"+2,100c"`
 * - `formatSignedCredits(-800)`  → `"-800c"`
 * - `formatSignedCredits(0)`     → `"+0c"`
 */
export function formatSignedCredits(credits: number): string {
  const rounded = Number.isFinite(credits) ? Math.round(credits) : 0;
  const sign = rounded >= 0 ? "+" : "";
  return `${sign}${groupThousands(rounded)}c`;
}
