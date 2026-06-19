/**
 * Deterministic, seedable PRNG (mulberry32).
 *
 * The entire simulation draws randomness from a single Rng instance owned by
 * the BattleState and advanced in a fixed order. This guarantees that
 * `same seed + same ordered commands => identical outcome`, which gives us
 * free save/load, replays, and reproducible tests.
 *
 * Rule for the rest of the sim: NEVER call Math.random(). Always go through
 * the Rng passed in via the BattleState.
 */
export class Rng {
  /** Internal 32-bit state. Serialize this for saves. */
  private s: number;

  constructor(seed: number) {
    // Force to uint32 so construction is stable across platforms.
    this.s = seed >>> 0;
  }

  /** Raw next 32-bit unsigned integer. */
  nextUint32(): number {
    let a = (this.s + 0x6d2b79f5) | 0;
    this.s = a >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Float in [0, 1). */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Float in [min, max). */
  uniform(min: number, max: number): number {
    return min + this.nextFloat() * (max - min);
  }

  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number {
    if (maxExclusive <= 0) return 0;
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  /** Integer in [minInclusive, maxInclusive]. */
  range(minInclusive: number, maxInclusive: number): number {
    if (maxInclusive < minInclusive) return minInclusive;
    return minInclusive + this.int(maxInclusive - minInclusive + 1);
  }

  /** True with the given probability expressed as a percentage in [0, 100]. */
  chancePercent(percent: number): boolean {
    return this.nextFloat() * 100 < percent;
  }

  /** True with the given probability expressed as a fraction in [0, 1]. */
  chance(probability: number): boolean {
    return this.nextFloat() < probability;
  }

  /** Pick a uniformly random element, or undefined for an empty array. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[this.int(items.length)];
  }

  /** In-place Fisher-Yates shuffle (deterministic). Returns the same array. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /** Snapshot the internal state for saving. */
  get state(): number {
    return this.s;
  }

  /** Restore a previously saved state. */
  set state(value: number) {
    this.s = value >>> 0;
  }

  /** A copy with identical state (useful for "preview" rolls that must not advance the real stream). */
  clone(): Rng {
    const r = new Rng(0);
    r.s = this.s;
    return r;
  }
}
