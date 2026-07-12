import { test, expect } from "@playwright/test";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignState, UfoContact } from "../src/campaign/types";

test("5x UFO and interceptor motion stays continuous across strategic ticks", async ({ page }) => {
  const base = { lat: 48.2, lon: 14.6, region: "Europe" } as const;
  const fresh = createCampaign(base, 91, "veteran");
  const contact: UfoContact = {
    id: "ufo-smooth-probe", status: "tracked", missionType: "crashSite", ufoType: "scout",
    lat: 48.2, lon: 28, region: "Europe", detectedAtHour: 0, expiresAtHour: 100,
    missionSeed: 91, strength: 1, heading: 90, speed: 28.2,
  };
  const campaign: CampaignState = { ...fresh, ufoContact: contact };
  await page.addInitScript((state) => localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state)), campaign);
  await page.goto("/");
  await expect(page.locator("#base-view")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __baseEnterRoom?: (kind: string) => void }).__baseEnterRoom?.("command"));
  await expect(page.locator("#geoscape")).toBeVisible();
  await page.getByRole("button", { name: /^intercept$/i }).click();
  await expect(page.locator('#geoscape .geo-speed-btn[data-speed="5"]')).toHaveAttribute("aria-pressed", "true");
  const samples = await page.evaluate(async () => {
    const rows: Array<{ t: number; fx: number; fy: number; ux: number; uy: number; display: number; elapsed: number }> = [];
    const start = performance.now();
    while (performance.now() - start < 1800) {
      const probe = (window as unknown as { __geoMarkers?: () => {
        displayHours: number; elapsedHours: number;
        flights: Array<{ x: number; y: number }>; ufo: { x: number; y: number } | null;
      } }).__geoMarkers?.();
      if (probe?.flights[0] && probe.ufo) rows.push({
        t: performance.now() - start, fx: probe.flights[0].x, fy: probe.flights[0].y,
        ux: probe.ufo.x, uy: probe.ufo.y, display: probe.displayHours, elapsed: probe.elapsedHours,
      });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return rows;
  });
  const deltas = samples.slice(1).map((sample, i) => ({
    t: sample.t,
    flight: Math.hypot(sample.fx - samples[i]!.fx, sample.fy - samples[i]!.fy),
    ufo: Math.hypot(sample.ux - samples[i]!.ux, sample.uy - samples[i]!.uy),
    tick: sample.elapsed !== samples[i]!.elapsed,
  }));
  expect(samples.length).toBeGreaterThan(20);
  const tickDeltas = deltas.filter((delta) => delta.tick);
  const frameDeltas = deltas.filter((delta) => !delta.tick);
  expect(tickDeltas.length).toBeGreaterThan(2);
  const max = (values: number[]) => Math.max(...values);
  expect(max(tickDeltas.map((delta) => delta.flight))).toBeLessThanOrEqual(
    max(frameDeltas.map((delta) => delta.flight)) * 1.5,
  );
  expect(max(tickDeltas.map((delta) => delta.ufo))).toBeLessThanOrEqual(
    max(frameDeltas.map((delta) => delta.ufo)) * 1.5,
  );
});
