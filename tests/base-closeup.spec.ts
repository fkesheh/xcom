/** Throwaway: capture the base 3D canvas alone (no DOM panels) to judge its graphics. */
import path from "node:path";
import { test } from "@playwright/test";
import { createCampaign } from "../src/campaign/storage";
import type { BaseLocation, CampaignState } from "../src/campaign/types";

const SHOTS = path.resolve(process.cwd(), "tests", "smoke-shots");
const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

test("capture base 3D canvas close-up (fresh)", async ({ page }) => {
  const c: CampaignState = createCampaign(BASE, 7, "veteran");
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(1200);
  // Pure 3D render, no DOM panels:
  await page.locator("#base-view canvas").first().screenshot({ path: path.join(SHOTS, "base-3d-canvas.png") });
  await page.screenshot({ path: path.join(SHOTS, "base-3d-full.png") });
});
