import { expect, test } from "@playwright/test";
import { dispatchAreaPatrol } from "../src/campaign/geoscape";
import { createCampaign } from "../src/campaign/storage";

test("interceptor radar footprint remains parallel to the local Earth surface", async ({ page }) => {
  const base = { lat: 48.2, lon: 14.6, region: "Europe" } as const;
  const fresh = createCampaign(base, 113, "veteran");
  const campaign = dispatchAreaPatrol(fresh, { lat: -22, lon: 74, region: "Africa" });
  await page.addInitScript((state) => localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state)), campaign);
  await page.goto("/");
  await expect(page.locator("#base-view")).toBeVisible();
  await page.evaluate(() => {
    (window as unknown as { __baseEnterRoom?: (kind: string) => void }).__baseEnterRoom?.("command");
  });
  await expect(page.locator("#geoscape")).toBeVisible();

  await expect.poll(async () => page.evaluate(() => {
    const probe = (window as unknown as {
      __geoMarkers?: () => { flights: Array<{ radarSurfaceDot?: number; indicatorSurfaceDot?: number }> };
    }).__geoMarkers?.();
    return probe?.flights[0]?.radarSurfaceDot;
  })).toBeDefined();

  const dot = await page.evaluate(() => {
    const probe = (window as unknown as {
      __geoMarkers?: () => { flights: Array<{ radarSurfaceDot?: number }> };
    }).__geoMarkers?.();
    return probe?.flights[0]?.radarSurfaceDot ?? 0;
  });
  expect(dot).toBeGreaterThan(0.999);
  const indicatorDot = await page.evaluate(() => {
    const probe = (window as unknown as {
      __geoMarkers?: () => { flights: Array<{ indicatorSurfaceDot?: number }> };
    }).__geoMarkers?.();
    return probe?.flights[0]?.indicatorSurfaceDot ?? 0;
  });
  expect(indicatorDot).toBeGreaterThan(0.999);
});
