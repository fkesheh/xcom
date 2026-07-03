// TDD red-phase tests for UFO type profiling (scout / harvester / terror / battleship).
// The campaign layer will roll a deterministic `ufoType` per spawned contact and
// derive strength / speed / lifetime from UFO_TYPE_PROFILES. These assertions encode
// that contract; they FAIL until the feature is implemented.
import { describe, expect, it } from "vitest";

import {
  advanceGeoscape,
  createUfoContact,
  GEOSCAPE_SCAN_HOURS,
  startInterceptionEncounter,
  UFO_TYPE_PROFILES,
  ufoTypeInfo,
} from "../src/campaign/geoscape";
import { createCampaign } from "../src/campaign/storage";
import type { CampaignState, MissionType, UfoType } from "../src/campaign/types";

const BASE = { lat: 2, lon: 14.2, region: "Africa" } as const;
const SEED = 12345;

function freshCampaign(): CampaignState {
  return createCampaign(BASE, SEED);
}

const UFO_TYPES: readonly UfoType[] = ["scout", "harvester", "terror", "battleship"];
const MISSION_TYPES: readonly MissionType[] = ["crashSite", "terror", "landedUfo", "baseDefense"];

describe("UFO type profiling", () => {
  it("always rolls a valid ufoType on every spawned contact, including ground assaults", () => {
    for (const missionType of MISSION_TYPES) {
      const contact = createUfoContact(freshCampaign(), 18, missionType);
      expect(contact.ufoType).toBeDefined();
      expect(UFO_TYPES).toContain(contact.ufoType);
    }
    // The default (2-arg) spawn — a tracked crashSite — also carries a ufoType.
    expect(UFO_TYPES).toContain(createUfoContact(freshCampaign(), 18).ufoType);
  });

  it("exposes the exact spec constants for UFO_TYPE_PROFILES", () => {
    // Speeds re-tuned to the original's spirit: bigger hulls cruise FASTER, so a
    // starting Raptor (0.9 deg/h) is outrun by terror ships and battleships.
    expect(UFO_TYPE_PROFILES.scout).toEqual({
      strength: 1,
      speed: 0.7,
      lifetimeHours: 30,
      infiltrationMult: 0.5,
      panicMult: 0.5,
    });
    expect(UFO_TYPE_PROFILES.harvester).toEqual({
      strength: 3,
      speed: 0.55,
      lifetimeHours: 44,
      infiltrationMult: 1.0,
      panicMult: 1.0,
    });
    expect(UFO_TYPE_PROFILES.terror).toEqual({
      strength: 5,
      speed: 1.0,
      lifetimeHours: 66,
      infiltrationMult: 1.6,
      panicMult: 1.6,
    });
    expect(UFO_TYPE_PROFILES.battleship).toEqual({
      strength: 8,
      speed: 1.35,
      lifetimeHours: 96,
      infiltrationMult: 2.2,
      panicMult: 2.2,
    });
  });

  it("derives contact stats from the rolled ufoType profile (strength / speed / lifetime)", () => {
    // Scan many (seed, hour) spawns until every ufoType has been observed, asserting
    // each contact's stats match its profile exactly.
    const seen = new Set<UfoType>();
    for (let seed = 1; seed <= 40 && seen.size < 4; seed += 1) {
      for (let hour = 1; hour <= 200 && seen.size < 4; hour += 1) {
        const contact = createUfoContact(createCampaign(BASE, seed), hour);
        const ufoType = contact.ufoType!;
        seen.add(ufoType);
        const profile = UFO_TYPE_PROFILES[ufoType];
        // missionType no longer drives strength — the profile does, for every contact.
        expect(contact.strength).toBe(profile.strength);
        // crashSite contacts are tracked: they carry the profile speed + lifetime.
        expect(contact.speed).toBe(profile.speed);
        expect(contact.expiresAtHour).toBe(hour + profile.lifetimeHours);
      }
    }
    expect(seen.size).toBe(4);

    // Same seed + hour rolls the same ufoType regardless of mission, so strength is
    // identical across all four mission types (missionType no longer affects strength).
    const strengths = new Set(
      MISSION_TYPES.map((missionType) => createUfoContact(freshCampaign(), 18, missionType).strength),
    );
    expect(strengths.size).toBe(1);
  });

  it("is deterministic: identical inputs yield byte-identical ufoType / strength / speed / expiry", () => {
    const a = createUfoContact(freshCampaign(), 18);
    const b = createUfoContact(freshCampaign(), 18);
    expect(b.ufoType).toBe(a.ufoType);
    expect(b.strength).toBe(a.strength);
    expect(b.speed).toBe(a.speed);
    expect(b.expiresAtHour).toBe(a.expiresAtHour);

    // advanceGeoscape spawns the same ufoType for the same campaign + elapsed hours.
    const runA = advanceGeoscape(freshCampaign(), 18);
    const runB = advanceGeoscape(freshCampaign(), 18);
    expect(runA.ufoContact?.ufoType).toBeDefined();
    expect(runB.ufoContact?.ufoType).toBe(runA.ufoContact?.ufoType);
  });

  it("surfaces all four ufoTypes across many seeds and hours of geoscape ticks", () => {
    const found = new Set<UfoType>();
    for (let seed = 1; seed <= 12; seed += 1) {
      let state = createCampaign(BASE, seed);
      const seenHours = new Set<number>();
      for (let i = 0; i < 400 && state.strategic.status === "active"; i += 1) {
        state = advanceGeoscape(state, GEOSCAPE_SCAN_HOURS);
        const contact = state.ufoContact;
        if (contact && !seenHours.has(contact.detectedAtHour)) {
          seenHours.add(contact.detectedAtHour);
          if (contact.ufoType) found.add(contact.ufoType);
        }
      }
    }
    expect(found.has("scout")).toBe(true);
    expect(found.has("harvester")).toBe(true);
    expect(found.has("terror")).toBe(true);
    expect(found.has("battleship")).toBe(true);
  });

  it("rolls scout > harvester > terror > battleship in frequency (weighted buckets)", () => {
    const counts: Record<UfoType, number> = { scout: 0, harvester: 0, terror: 0, battleship: 0 };
    // Large (seed, hour) grid so the bucket ordering is statistically stable.
    for (let seed = 1; seed <= 10; seed += 1) {
      const campaign = createCampaign(BASE, seed);
      for (let hour = 1; hour <= 1000; hour += 1) {
        counts[createUfoContact(campaign, hour).ufoType!] += 1;
      }
    }
    expect(counts.scout).toBeGreaterThan(counts.harvester);
    expect(counts.harvester).toBeGreaterThan(counts.terror);
    expect(counts.terror).toBeGreaterThan(counts.battleship);
  });

  it("ranks battleship strongest / fastest-cruise / longest-lived; harvester is the slow hauler", () => {
    const { scout, harvester, terror, battleship } = UFO_TYPE_PROFILES;
    expect(battleship.strength).toBeGreaterThan(terror.strength);
    expect(terror.strength).toBeGreaterThan(harvester.strength);
    expect(harvester.strength).toBeGreaterThan(scout.strength);

    // Bigger combat hulls cruise faster; the harvester is the slowest hauler and a
    // scout, though fragile, still outpaces it. Battleship + terror outrun a Raptor (0.9).
    expect(battleship.speed).toBeGreaterThan(terror.speed);
    expect(terror.speed).toBeGreaterThan(scout.speed);
    expect(scout.speed).toBeGreaterThan(harvester.speed);
    expect(harvester.speed).toBeLessThan(0.9);
    expect(terror.speed).toBeGreaterThan(0.9);
    expect(battleship.speed).toBeGreaterThan(0.9);

    expect(battleship.lifetimeHours).toBeGreaterThan(terror.lifetimeHours);
    expect(terror.lifetimeHours).toBeGreaterThan(harvester.lifetimeHours);
    expect(harvester.lifetimeHours).toBeGreaterThan(scout.lifetimeHours);
  });

  it.each([
    ["scout", { label: "Scout", icon: "◈", color: 0x67e8f9, threat: "Low" }],
    ["harvester", { label: "Harvester", icon: "◆", color: 0xfbbf24, threat: "Moderate" }],
    ["terror", { label: "Terror Ship", icon: "▲", color: 0xf97316, threat: "High" }],
    ["battleship", { label: "Battleship", icon: "⬢", color: 0xef4444, threat: "Critical" }],
  ] as const)("ufoTypeInfo(%s) returns the exact spec metadata", (ufoType, expected) => {
    expect(ufoTypeInfo(ufoType)).toEqual(expected);
  });

  it("ufoTypeInfo(undefined) returns a sensible non-empty default", () => {
    const info = ufoTypeInfo(undefined);
    expect(info.label.length).toBeGreaterThan(0);
    expect(info.threat.length).toBeGreaterThan(0);
  });

  it("scales interception encounter HP from the contact strength (20 + strength * 10)", () => {
    const campaign = freshCampaign();
    const contact = createUfoContact(campaign, 18);
    // Strength must match the rolled ufoType's profile (missionType no longer drives it).
    expect(contact.strength).toBe(UFO_TYPE_PROFILES[contact.ufoType!].strength);

    const started = startInterceptionEncounter({ ...campaign, ufoContact: contact });
    expect(started.interception).toBeDefined();
    expect(started.interception!.ufoHpMax).toBe(20 + contact.strength * 10);
  });
});
