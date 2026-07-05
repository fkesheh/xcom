/**
 * Per-soldier backpack capacity model (pure, deterministic, no I/O).
 *
 * FROZEN CONTRACT MODULE — round 13. Owned by neither implementation track: both
 * campaign/storage.ts (loadout assignment gate) and the sim/game layers consume it
 * read-only. Do NOT add logic here as part of a track; treat every export as
 * immutable contract.
 *
 * A soldier's hand slot is the assigned weapon (campaign.soldierLoadouts) and is
 * NOT counted here. The backpack holds consumable items only (CampaignSoldier.
 * loadoutItems, a flat string[] of item ids). Capacity is slot-based: the sum of
 * item sizes must not exceed {@link BACKPACK_SLOTS}. Most items occupy 1 slot;
 * bulky items occupy 2 (see {@link ITEM_SIZE}).
 */

/** Total backpack slots per soldier. */
export const BACKPACK_SLOTS = 4;

/**
 * Slot footprint per item id. Anything not listed defaults to {@link DEFAULT_ITEM_SIZE}.
 * Current consumables (grenade/medkit/smoke/scanner/proxMine/stunRod) are all 1;
 * bulky future items (rockets, heavy clips) are 2 — matching the "rifles take 2"
 * X-COM flavor for any large item that ever enters a backpack.
 */
export const ITEM_SIZE: Readonly<Record<string, number>> = {
  grenade: 1,
  medkit: 1,
  smoke: 1,
  scanner: 1,
  proxMine: 1,
  stunRod: 1,
  rocket: 2,
  heavyClip: 2,
};

export const DEFAULT_ITEM_SIZE = 1;

/** Slot footprint of a single item id (>= 1). */
export function itemSize(itemId: string): number {
  const size = ITEM_SIZE[itemId] ?? DEFAULT_ITEM_SIZE;
  return size >= 1 ? size : DEFAULT_ITEM_SIZE;
}

/** Total slots consumed by a backpack's current contents. */
export function backpackUsedSlots(itemIds: readonly string[]): number {
  let used = 0;
  for (const id of itemIds) used += itemSize(id);
  return used;
}

/** Free slots remaining in a backpack (never negative). */
export function backpackRemainingSlots(itemIds: readonly string[]): number {
  return Math.max(0, BACKPACK_SLOTS - backpackUsedSlots(itemIds));
}

/**
 * Whether one more `itemId` fits in a backpack currently holding `itemIds`.
 * True iff the item's size does not exceed the remaining slots.
 */
export function canAddToBackpack(itemIds: readonly string[], itemId: string): boolean {
  return itemSize(itemId) <= backpackRemainingSlots(itemIds);
}
