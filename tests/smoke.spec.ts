/**
 * Browser smoke test: loads the real built app (served by `vite preview`) and
 * exercises every major screen, capturing a screenshot of each and asserting
 * that ZERO uncaught exceptions / console.error messages occur.
 *
 * Seed campaign states are built in Node by importing the pure logic modules
 * (`src/campaign/*`) and injected into the page via `page.addInitScript` so the
 * boot path in `src/game/main.ts` reads them out of localStorage.
 */
import path from "node:path";
import { test, expect, type Page } from "@playwright/test";

import { createCampaign } from "../src/campaign/storage";
import {
  createUfoContact,
  interceptUfo,
  startInterceptionEncounter,
} from "../src/campaign/geoscape";
import type {
  BaseLocation,
  CampaignState,
  DifficultyLevel,
  InterceptionEncounter,
  UfoContact,
} from "../src/campaign/types";

const SHOTS_DIR = path.resolve(process.cwd(), "tests", "smoke-shots");

const BASE: BaseLocation = { lat: 48.2, lon: 14.6, region: "Europe" };

/**
 * Enter a base facility room deterministically. DOM room-entry is gone in the new
 * base IA (the base is a bare 3D overview + a single per-room panel), so rooms are
 * reached in tests via the `window.__baseEnterRoom(kind)` hook the base view exposes
 * — the deterministic equivalent of clicking a facility mesh. `command` mounts the
 * geoscape (it IS the Command Center room).
 */
async function enterRoom(page: Page, kind: string): Promise<void> {
  await page.evaluate((k) => {
    (window as unknown as { __baseEnterRoom?: (roomKind: string) => void }).__baseEnterRoom?.(k);
  }, kind);
}

/**
 * The geoscape left column is now a rail of floating chips; the live-contact card
 * (status, briefing, "Launch Operation" CTA) lives inside a console-glass modal
 * opened by the Contact chip. Click it and wait for the card to mount so tests can
 * assert against the contact detail the way they used to against the inline column.
 */
async function openContactModal(page: Page): Promise<void> {
  const contactChip = page.locator("#geoscape .geo-chip", {
    has: page.locator(".geo-chip-label", { hasText: /^Contact$/ }),
  });
  await contactChip.first().click();
  await expect(page.locator("#geoscape .geo-modal .geo-contact")).toBeVisible();
}

/**
 * Build a campaign whose UFO contact is a launchable crash site. `interceptUfo`
 * auto-resolves based on the interceptor/UFO score forecast, so we search seeds
 * until the contact is actually forced down (status "crashed").
 */
function crashedCampaign(difficulty: DifficultyLevel = "veteran"): CampaignState {
  for (let seed = 1; seed <= 8192; seed++) {
    const fresh = createCampaign(BASE, seed, difficulty);
    const tracked = { ...fresh, ufoContact: createUfoContact(fresh, 0) };
    const resolved = interceptUfo(tracked);
    // Require a land crash so the geoscape offers a "Launch Operation" CTA (an
    // ocean crash is unrecoverable and never launchable).
    if (resolved.ufoContact?.status === "crashed" && !resolved.ufoContact.overOcean) return resolved;
  }
  throw new Error("Unable to build a crashed-contact campaign for smoke test");
}

/**
 * Build a campaign whose UFO contact already has an interception encounter past
 * THE ZOOM (phase "engagement", rangeKm inside weapons reach). Air-combat
 * redesign v1: pursuit runs on the globe in real km and never fires a shot;
 * only at rangeKm<=ENGAGEMENT_RANGE_KM does the encounter enter the cinematic
 * dogfight. main.ts's showGeoscape() resumes straight into PlaneCombatView for
 * a saved/mid-session encounter already in that phase (see main.ts), so this
 * fixture drives spec c) end-to-end without depending on a live in-globe
 * threshold crossing.
 */
function dogfightCampaign(difficulty: DifficultyLevel = "veteran"): CampaignState {
  const fresh = createCampaign(BASE, 123, difficulty);
  const tracked = { ...fresh, ufoContact: createUfoContact(fresh, 0) };
  const encountering = startInterceptionEncounter(tracked);
  const contact = encountering.ufoContact;
  if (!contact) throw new Error("Unable to seed a UFO contact for the dogfight smoke test");
  const interception: InterceptionEncounter = {
    contactId: contact.id,
    phase: "engagement",
    rangeKm: 40,
    closingSpeedKmH: 0,
    ufoHp: 30,
    ufoHpMax: 30,
    interceptorHp: 100,
    interceptorHpMax: 100,
    ammo: { stingray: 5, cannon: 40 },
    lockBeatsLeft: 0,
    overkillMargin: 0,
    roundsElapsed: 0,
    ufoAgility: 0.9,
    log: [],
  };
  return { ...encountering, interception };
}

// ---------------------------------------------------------------------------
// Zero-error gate: every console.error / pageerror is collected and asserted
// empty at the end of each test. A single entry fails the test verbatim.
// ---------------------------------------------------------------------------

const collectedErrors: string[] = [];

test.beforeEach(async ({ page }) => {
  collectedErrors.length = 0;
  page.on("console", (msg) => {
    if (msg.type() === "error") {
      collectedErrors.push(`[console.error] ${msg.text()}`);
    }
  });
  page.on("pageerror", (err) => {
    collectedErrors.push(`[pageerror] ${err.toString()}\n${err.stack ?? ""}`);
  });
});

test.afterEach(async () => {
  if (collectedErrors.length > 0) {
    throw new Error(
      `Expected zero console/page errors, got ${collectedErrors.length}:\n` +
        collectedErrors.join("\n---\n"),
    );
  }
});

// ---------------------------------------------------------------------------

test.describe("Blacksite boot smoke", () => {
  test.beforeEach(async ({ page }) => {
    // Wait for dynamic-import chunks (three.js views) to finish loading.
    page.on("load", async () => { await page.waitForLoadState("networkidle").catch(() => {}); });
  });
  test("a) new-game geoscape renders the difficulty selector", async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.clear();
    });
    await page.goto("/");

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();
    // Difficulty radiogroup is only present on the new-game geoscape.
    await expect(page.locator(".geo-difficulty")).toBeVisible();
    await expect(page.getByText(/Select difficulty/i)).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "01-newgame.png") });
  });

  test("b) base screen renders the market + launchable mission card", async ({ page }) => {
    const campaign = crashedCampaign();
    await page.addInitScript((state: CampaignState) => {
      // NOTE: addInitScript serializes this fn to a string and runs it in the
      // page, so it cannot close over module-scope vars — the key is inlined.
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await expect(page.locator("#base-view canvas")).toBeVisible();

    // The market now lives inside the Hangar room. The DOM room-nav sidebar is gone
    // (bare 3D overview + per-room panel), so reach the room via the __baseEnterRoom
    // test hook, then assert the market panel (with Buy buttons) is visible.
    await enterRoom(page, "hangar");
    await expect(page.locator("#base-view .market-card")).toBeVisible();
    await page.locator("#base-view .market-card").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(SHOTS_DIR, "02-base.png") });

    // Mission launch moved off the base onto the geoscape live-contact card, which
    // now lives inside the Contact modal (opened from the left-edge chip rail). Enter
    // the Command Center, open the Contact modal, and assert the "Launch Operation"
    // CTA is enabled for the crashed land contact.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    await openContactModal(page);
    await expect(
      page.getByRole("button", { name: /launch operation/i }),
    ).toBeEnabled();
  });

  test("c) geoscape zoom routes an engaged encounter into the dogfight screen", async ({ page }) => {
    const campaign = dogfightCampaign();
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    // Boot with a saved campaign always lands on the base view; the Command
    // Center room mounts the geoscape (pursuit-on-globe, real km) UNLESS the
    // saved encounter is already past THE ZOOM (phase "engagement"), in which
    // case it resumes straight into the cinematic dogfight screen instead.
    await expect(page.locator("#base-view")).toBeVisible();
    await enterRoom(page, "command");

    await expect(page.locator("#plane-combat")).toBeVisible();
    await page.getByRole("button", { name: /evasive break/i }).click();
    await expect(page.locator(".pc-range-num")).toContainText("54");
    await expect(page.getByRole("button", { name: /countermeasures · 2 beats/i })).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS_DIR, "03-interception.png") });
  });

  test("d) tactical screen mounts after launch (end-turn + item best-effort)", async ({
    page,
  }) => {
    const base = crashedCampaign();
    // Non-blocking deployment now flies the Skyranger across real game-time (no
    // fixed animation). Park the crash a short hop from the base so the transport
    // reaches the site within a couple of accelerated ticks and the DEPLOY chip
    // appears promptly — keeping this smoke test fast and deterministic.
    const campaign: CampaignState = base.ufoContact
      ? { ...base, ufoContact: { ...base.ufoContact, lat: 46.5, lon: 14.6, region: "Europe" } }
      : base;
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    // Start from the base screen.
    await expect(page.locator("#base-view")).toBeVisible();

    // Mission launch lives on the geoscape live-contact card, now inside the Contact
    // modal: enter the Command Center, open the Contact modal, then launch.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    await openContactModal(page);
    const launch = page.getByRole("button", { name: /launch operation/i });
    await expect(launch).toBeEnabled();
    // Launch the recovery operation. This no longer locks the globe: it starts a
    // tracked Skyranger deployment flight and keeps time live. Entering the battle
    // stays a player click on the arrival DEPLOY chip (never automatic).
    await launch.click();

    // Close the modal so the left-edge chip rail (and the arrival DEPLOY chip) is
    // reachable, then flow time so the Skyranger covers its short leg to the site.
    await page.keyboard.press("Escape");
    const fast = page.locator('.geo-speed-btn[data-speed="30"]');
    if ((await fast.count()) > 0) await fast.first().click().catch(() => {});

    // On arrival a pulsing left-edge "DEPLOY — begin assault" chip appears; clicking
    // it is the ONLY path into the ground battle. (Replaces the old Deploy/Wait choice.)
    const deployChip = page
      .locator('button:has-text("begin assault"), [role="button"]:has-text("begin assault")')
      .first();
    await deployChip.waitFor({ state: "visible", timeout: 30_000 });
    // The chip rail rebuilds every accelerated tick, so pause time first — otherwise
    // the chip element detaches mid-click. The arrived flag is persisted, so the chip
    // stays docked while paused. The chip also pulses (infinite CSS animation), which
    // never satisfies Playwright's "stable" actionability gate, so force the click.
    await page.locator('.geo-speed-btn[data-speed="0"]').first().click().catch(() => {});
    await expect(deployChip).toBeVisible();
    await deployChip.click({ force: true, timeout: 5_000 });

    await expect(page.locator("#hud")).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#app canvas")).toBeVisible();

    // Dismiss the opening briefing overlay so the battlefield is visible.
    const deployBtn = page.locator("#hud .briefing.show button", {
      hasText: /deploy squad/i,
    });
    if ((await deployBtn.count()) > 0) {
      await deployBtn.first().click();
      await page.waitForTimeout(500);
    }

    await page.screenshot({ path: path.join(SHOTS_DIR, "04-tactical.png") });

    // Best-effort: enter an item targeting mode (grenade throw / medkit use).
    // Attempted on the fresh player turn (unit selected, full TU) — the most
    // reliable moment; after the enemy turn the HUD can still be `busy`.
    const itemAction = page
      .locator("#hud .item-line button:not([disabled])")
      .first();
    try {
      await itemAction.waitFor({ state: "visible", timeout: 2_000 });
      await itemAction.click({ timeout: 3_000 });
      await page.waitForTimeout(500);
      await page.screenshot({
        path: path.join(SHOTS_DIR, "06-tactical-itemmode.png"),
      });
    } catch {
      console.log(
        "[smoke] no usable item action button found — skipping item-mode screenshot",
      );
    }

    // Best-effort: end the player's turn and capture the enemy-turn state.
    const endTurn = page.locator("#hud .endturn");
    await expect(endTurn).toBeVisible();
    try {
      await endTurn.click({ timeout: 5_000 });
      // Let the enemy turn animate/resolve before the next capture.
      await page.waitForTimeout(2_500);
    } catch (err) {
      console.log("[smoke] end-turn click skipped:", String(err));
    }
    await page.screenshot({
      path: path.join(SHOTS_DIR, "05-tactical-endturn.png"),
    });
  });

  test("E) airborne (tracked) UFO shows intercept guidance, not a launchable mission", async ({
    page,
  }) => {
    // Tracked = airborne UFO that has NOT been shot down yet. The base must route
    // the player to intercept first, never offer a launchable crash-site mission.
    const fresh = createCampaign(BASE, 42, "veteran");
    const tracked: CampaignState = {
      ...fresh,
      ufoContact: createUfoContact(fresh, 0),
    };
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, tracked);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await expect(page.locator("#base-view canvas")).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "07-base-airborne.png") });

    // Airborne intercept guidance moved onto the geoscape (Command Center room): the
    // live-contact card reads "Airborne — intercept", offers an Intercept affordance,
    // and NEVER a launchable recovery CTA (that appears only once the UFO is down on
    // land). Enter the Command Center to verify.
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();
    // The live-contact card now lives in the Contact modal (left-edge chip rail).
    await openContactModal(page);
    const contact = page.locator("#geoscape .geo-modal .geo-contact");
    await expect(contact).toBeVisible();
    const contactText = ((await contact.textContent()) ?? "").replace(/\s+/g, " ").trim();
    console.log("[smoke E] geoscape contact card text:", contactText);
    await expect(contact.getByText(/airborne/i).first()).toBeVisible();

    // The tracked UFO must offer an Intercept affordance (routing the player to
    // scramble a fighter), never a launchable recovery.
    const intercept = page.getByRole("button", { name: /intercept/i }).first();
    await expect(intercept).toBeVisible();
    console.log(
      "[smoke E] intercept button label:",
      ((await intercept.textContent()) ?? "").replace(/\s+/g, " ").trim(),
    );

    // No "Launch Operation" CTA may exist for an airborne UFO.
    await expect(page.getByRole("button", { name: /launch operation/i })).toHaveCount(0);
  });

  test("F) geoscape renders the Pause/1x/5x/30x time-speed controls", async ({
    page,
  }) => {
    // A contact-free campaign boots to the base, then enters the Command Center room
    // (a clean geoscape, no interception overlay) so the time-speed controls show.
    const campaign = createCampaign(BASE, 7, "veteran");
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");

    await expect(page.locator("#base-view")).toBeVisible();
    await enterRoom(page, "command");

    await expect(page.locator("#geoscape")).toBeVisible();
    await expect(page.locator("#geoscape canvas")).toBeVisible();

    await page.screenshot({ path: path.join(SHOTS_DIR, "08-geoscape-time.png") });

    // Time-speed control group with the Pause / 1x / 5x / 30x buttons.
    const speedGroup = page.locator("#geoscape .geo-speed");
    await expect(speedGroup).toBeVisible();
    const speedBtns = page.locator("#geoscape .geo-speed-btn");
    await expect(speedBtns).toHaveCount(4);
    const labels = await speedBtns.allTextContents();
    console.log(
      "[smoke F] time-speed button labels:",
      labels.map((t) => t.replace(/\s+/g, " ").trim()),
    );

    // Pause + each speed button must render (campaign is active, so they're enabled).
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='0']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='1']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='5']")).toBeVisible();
    await expect(page.locator("#geoscape .geo-speed-btn[data-speed='30']")).toBeVisible();
  });

  test("G) intercept pursuit auto-flows, has no chase popup, and truly freezes on pause", async ({ page }) => {
    const fresh = createCampaign(BASE, 91, "veteran");
    const contact: UfoContact = {
      id: "ufo-auto-pursuit",
      status: "tracked",
      missionType: "crashSite",
      ufoType: "scout",
      lat: 48.2,
      lon: 28,
      region: "Europe",
      detectedAtHour: 0,
      expiresAtHour: 100,
      missionSeed: 91,
      strength: 1,
      heading: 90,
      speed: 28.2,
    };
    const campaign: CampaignState = { ...fresh, ufoContact: contact };
    await page.addInitScript((state: CampaignState) => {
      window.localStorage.setItem("blacksite.campaign.v1", JSON.stringify(state));
    }, campaign);
    await page.goto("/");
    await expect(page.locator("#base-view")).toBeVisible();
    await enterRoom(page, "command");
    await expect(page.locator("#geoscape")).toBeVisible();

    await page.getByRole("button", { name: /^intercept$/i }).click();
    await expect(page.locator("#geoscape .geo-intercept")).toHaveCount(0);
    await expect(page.locator('#geoscape .geo-speed-btn[data-speed="5"]')).toHaveAttribute("aria-pressed", "true");

    const marker = async () => page.evaluate(() => {
      const probe = (window as unknown as {
        __geoMarkers?: () => { flights: Array<{ id: string; x: number; y: number }>; ufo: { x: number; y: number } | null };
      }).__geoMarkers?.();
      return probe;
    });
    await expect.poll(async () => (await marker())?.flights.length ?? 0).toBeGreaterThan(0);
    const before = await marker();
    await page.waitForTimeout(180);
    const moving = await marker();
    expect(moving?.flights[0]?.x).not.toBe(before?.flights[0]?.x);

    await page.locator('#geoscape .geo-speed-btn[data-speed="0"]').click();
    const paused = await marker();
    await page.waitForTimeout(500);
    const still = await marker();
    expect(still?.flights[0]?.x).toBeCloseTo(paused?.flights[0]?.x ?? 0, 3);
    expect(still?.ufo?.x).toBeCloseTo(paused?.ufo?.x ?? 0, 3);

    // Resume without touching a chase dialog; the model itself carries the fighter
    // through the 100km threshold and opens the dogfight.
    await page.locator('#geoscape .geo-speed-btn[data-speed="5"]').click();
    await expect(page.locator("#plane-combat")).toBeVisible({ timeout: 12_000 });
  });
});
