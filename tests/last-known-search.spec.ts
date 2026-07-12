import { expect, test } from "@playwright/test";
import { createUfoContact } from "../src/campaign/geoscape";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignState } from "../src/campaign/types";

test("lost contact offers a physical interceptor search to its last-known position", async ({ page }) => {
  const base = { lat: 48.2, lon: 14.6, region: "Europe" } as const;
  const fresh = createCampaign(base, 73, "veteran");
  const source = createUfoContact(fresh, 0, "crashSite");
  const campaign: CampaignState = {
    ...fresh,
    lostUfoContact: {
      ...source,
      status: "escaped",
      lat: 44,
      lon: 30,
      lastKnownLat: 45,
      lastKnownLon: 25,
      lostAtHour: 0,
      expiresAtHour: 8,
    },
  };
  await page.addInitScript((state) => localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state)), campaign);
  await page.goto("/");
  await expect(page.locator("#base-view")).toBeVisible();
  await page.evaluate(() => (window as unknown as { __baseEnterRoom?: (kind: string) => void }).__baseEnterRoom?.("command"));
  await expect(page.locator("#geoscape")).toBeVisible();

  const contactChip = page.locator("#geoscape .geo-chip", {
    has: page.locator(".geo-chip-label", { hasText: /^Contact$/ }),
  });
  await contactChip.click();
  await expect(page.locator("#geoscape .geo-modal .geo-contact-status")).toHaveText(
    "Contact lost — search last known position",
  );
  await page.getByRole("button", { name: "Search last known position", exact: true }).click();

  await expect.poll(async () => page.evaluate(() => {
    const probe = (window as unknown as { __geoMarkers?: () => { flights: unknown[] } }).__geoMarkers?.();
    return probe?.flights.length ?? 0;
  })).toBeGreaterThan(0);
});
