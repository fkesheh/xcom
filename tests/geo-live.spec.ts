/** Capture the geoscape with a tracked UFO (patrol planes flying) + time flowing (night). */
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createCampaign } from "../src/campaign/storage";
import { createUfoContact } from "../src/campaign/geoscape";
import type { ActiveFlight, BaseLocation, CampaignState } from "../src/campaign/types";

const SHOTS = path.resolve(process.cwd(), "tests", "smoke-shots");
const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

test("capture geoscape with UFO + planes + night", async ({ page }) => {
  let c = createCampaign(BASE, 3, "veteran");
  c = { ...c, ufoContact: createUfoContact(c, 0) };
  // Seed an in-flight interceptor patrol (base -> UFO contact) so the geoscape
  // shows a plane actually flying toward the UFO. Flights are only spawned at
  // runtime by manageActiveFlights during time-flow; the screenshot is a static
  // capture, so the flight is seeded directly with progress mid-route.
  const contact = c.ufoContact!;
  const flight: ActiveFlight = {
    id: `patrol:int-1:${contact.id}`,
    craftId: "int-1",
    kind: "interceptor",
    fromLat: c.base.lat,
    fromLon: c.base.lon,
    toLat: contact.lat,
    toLon: contact.lon,
    progress: 0.4,
    speedDegPerHour: 4,
    startedAtHour: c.clock.elapsedHours,
  };
  c = { ...c, activeFlights: [flight] };
  await page.addInitScript((state: CampaignState) => {
    window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
  }, c);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator("#base-view").waitFor();
  await page.waitForTimeout(500);
  // Go to geoscape (boot lands on base with a saved campaign). The geoscape is now
  // the Command Center room; the floating "Earth" button is gone, so enter the room
  // via the deterministic __baseEnterRoom test hook.
  await page.evaluate(() => {
    (window as unknown as { __baseEnterRoom?: (kind: string) => void }).__baseEnterRoom?.("command");
  });
  await page.locator("#geoscape").waitFor();
  // The tall left column of stacked cards is gone: no scrollable card body, no
  // objective/contact/interceptor/reports cards stacked over the globe.
  await expect(page.locator("#geoscape .geo-left-body")).toHaveCount(0);
  await expect(page.locator("#geoscape .geo-left-cards")).toHaveCount(0);
  // The left edge is now a compact stat cluster + a rail of small floating chips.
  await expect(page.locator("#geoscape .geo-chip-rail")).toBeVisible();
  const chipRail = page.locator("#geoscape .geo-chip-rail");
  await expect(chipRail.locator(".geo-chip-label", { hasText: "Objective" })).toBeVisible();
  await expect(chipRail.locator(".geo-chip-label", { hasText: "Contact" })).toBeVisible();
  await expect(chipRail.locator(".geo-chip-label", { hasText: "Fleet" })).toBeVisible();
  await expect(chipRail.locator(".geo-chip-label", { hasText: "Reports" })).toBeVisible();
  // Each chip opens a console-glass modal with the full detail; Esc closes it.
  await chipRail.locator(".geo-chip", { hasText: "Objective" }).click();
  await expect(page.locator("#geoscape .geo-modal")).toBeVisible();
  await expect(page.locator("#geoscape .geo-modal-title")).toHaveText(/objective/i);
  await page.keyboard.press("Escape");
  await expect(page.locator("#geoscape .geo-modal")).toHaveCount(0);
  // Let time flow for ~3s so planes patrol + night creeps.
  await page.waitForTimeout(3500);
  await page.locator("#geoscape canvas").first().screenshot({ path: path.join(SHOTS, "geo-live.png") });
});
