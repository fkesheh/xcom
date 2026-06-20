import { advanceGeoscape, createUfoContact, formatCampaignClock } from "/Users/fkeskeh/xcom/src/campaign/geoscape.ts";
import { createCampaign } from "/Users/fkeskeh/xcom/src/campaign/storage.ts";

const BASE = { lat: 2, lon: 14.2, region: "Africa" };
const c0 = createCampaign(BASE, 12345);

// Determinism: advance in fractional steps vs one lump — same final clock + state
const frac = advanceGeoscape(advanceGeoscape(advanceGeoscape(c0, 0.5), 0.5), 0.5);
const lump = advanceGeoscape(c0, 1.5);
console.log("frac clock:", frac.clock.elapsedHours, "lump clock:", lump.clock.elapsedHours);
console.log("clock equal:", frac.clock.elapsedHours === lump.clock.elapsedHours);
console.log("format 1.5h:", formatCampaignClock(lump.clock));

// Determinism of UFO flight
const detected = createUfoContact(c0, 10, "crashSite");
console.log("contact heading/speed:", detected.heading, detected.speed, "status:", detected.status);

// Check spawn check crossing with fractional: does elapsedHours>=lastContactHour+interval work fractionally?
// contactInterval default (no radar-2) = 18. Park at lastContactHour=0, advance to 17.9 -> no spawn; 18.0 -> spawn
const parked = { ...c0, clock: { ...c0.clock, elapsedHours: 0, lastContactHour: 0, lastFundingHour: 0 }, ufoContact: undefined };
const noSpawn = advanceGeoscape(parked, 17.9);
console.log("after 17.9h spawn?", noSpawn.ufoContact ? "YES(id="+noSpawn.ufoContact.id+")" : "no", "elapsed:", noSpawn.clock.elapsedHours);
const spawn = advanceGeoscape(parked, 18.0);
console.log("after 18.0h spawn?", spawn.ufoContact ? "YES(id="+spawn.ufoContact.id+")" : "no", "elapsed:", spawn.clock.elapsedHours);

// Funding crossing exactly: lastFundingHour 0 + 720
console.log("format 720h:", formatCampaignClock({day:31,hour:0,elapsedHours:720,lastContactHour:0,lastFundingHour:0}));
