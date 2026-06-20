/**
 * Procedurally-synthesized sound effects (WebAudio).
 *
 * Presentation-only: this never touches the sim and never imports three.js.
 * Every sound is generated from oscillators + a white-noise buffer shaped by
 * biquad filters and gain envelopes — there are no audio files. The
 * {@link AudioContext} is created lazily (browsers block audio before a user
 * gesture), so the controller must call {@link Sfx.resume} on the first
 * pointerdown. Every public method is a graceful no-op when muted, when the
 * context cannot be created, or before it is running, and node creation is
 * wrapped so an audio failure never throws into the game loop.
 */

import type { Faction } from "../sim/types";

/** Weapon flavour for {@link Sfx.shoot} (maps from a unit's weaponId). */
export type ShootKind = "rifle" | "pistol" | "plasma";

const MASTER_VOLUME = 0.25;
/** Floor for exponential ramps (the API forbids ramping to exactly 0). */
const EPS = 0.0001;

interface ToneSpec {
  type: OscillatorType;
  /** Start frequency (Hz). */
  f0: number;
  /** Optional end frequency for an exponential pitch glide. */
  f1?: number;
  /** Duration in seconds. */
  dur: number;
  /** Peak gain before the master bus (0..1). */
  peak: number;
  /** Start offset from "now" in seconds (for sequenced chimes). */
  when?: number;
  /** Attack ramp length; keep > 0 to avoid clicks. */
  attack?: number;
  /** Optional band-shaping filter on the oscillator. */
  filter?: { type: BiquadFilterType; f0: number; f1?: number; q?: number };
}

interface NoiseSpec {
  filterType: BiquadFilterType;
  f0: number;
  f1?: number;
  q?: number;
  dur: number;
  peak: number;
  when?: number;
  attack?: number;
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  // -------------------------------------------------------------------------
  // Lifecycle / mute
  // -------------------------------------------------------------------------

  /** Unlock/resume the AudioContext. Call from the first user gesture. */
  async resume(): Promise<void> {
    const audio = this.ensure();
    if (!audio) return;
    try {
      if (audio.ctx.state === "suspended") await audio.ctx.resume();
    } catch {
      // Resuming can reject if the gesture was not trusted; stay silent.
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!this.ctx || !this.master) return;
    try {
      const t = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      // Glide so toggling does not click and in-flight sounds fade out.
      this.master.gain.setTargetAtTime(muted ? 0 : MASTER_VOLUME, t, 0.01);
    } catch {
      // Ignore — muting is best-effort.
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  /** Flip mute and return the new state. */
  toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  // -------------------------------------------------------------------------
  // Public sounds
  // -------------------------------------------------------------------------

  /** Gunfire: rifle = filtered-noise crack; plasma = pitched sci-fi zap. */
  shoot(kind: ShootKind): void {
    this.play((ctx, out) => {
      if (kind === "plasma") {
        // Bright saw swept down hard through a closing low-pass = "pew".
        this.tone(ctx, out, {
          type: "sawtooth",
          f0: 1500,
          f1: 260,
          dur: 0.2,
          peak: 0.6,
          filter: { type: "lowpass", f0: 3200, f1: 700, q: 6 },
        });
        this.tone(ctx, out, { type: "square", f0: 760, f1: 130, dur: 0.16, peak: 0.22 });
      } else if (kind === "pistol") {
        this.noiseBurst(ctx, out, {
          filterType: "highpass",
          f0: 2200,
          q: 0.8,
          dur: 0.055,
          peak: 0.72,
          attack: 0.001,
        });
        this.tone(ctx, out, { type: "square", f0: 190, f1: 85, dur: 0.055, peak: 0.28 });
      } else {
        // Sharp high-passed noise crack + a short low body thump.
        this.noiseBurst(ctx, out, {
          filterType: "highpass",
          f0: 1700,
          q: 0.7,
          dur: 0.09,
          peak: 0.9,
          attack: 0.001,
        });
        this.tone(ctx, out, { type: "triangle", f0: 220, f1: 70, dur: 0.07, peak: 0.45 });
      }
    });
  }

  /** Round result: hit = solid thud/clang; miss = airy ricochet/whiz. */
  impact(hit: boolean): void {
    this.play((ctx, out) => {
      if (hit) {
        this.tone(ctx, out, { type: "triangle", f0: 190, f1: 60, dur: 0.16, peak: 0.85 });
        this.noiseBurst(ctx, out, { filterType: "bandpass", f0: 2200, q: 1.2, dur: 0.07, peak: 0.4 });
      } else {
        this.noiseBurst(ctx, out, {
          filterType: "bandpass",
          f0: 2800,
          f1: 800,
          q: 9,
          dur: 0.24,
          peak: 0.3,
          attack: 0.01,
        });
      }
    });
  }

  /** A unit collapses: descending tone + sub-rumble. */
  death(): void {
    this.play((ctx, out) => {
      this.tone(ctx, out, {
        type: "sawtooth",
        f0: 340,
        f1: 55,
        dur: 0.55,
        peak: 0.6,
        filter: { type: "lowpass", f0: 1800, f1: 300, q: 2 },
      });
      this.tone(ctx, out, { type: "sine", f0: 170, f1: 40, dur: 0.6, peak: 0.4 });
    });
  }

  /** Soft footstep tick (intentionally quiet; caller may throttle). */
  move(): void {
    this.play((ctx, out) => {
      this.noiseBurst(ctx, out, {
        filterType: "lowpass",
        f0: 320,
        dur: 0.05,
        peak: 0.18,
        attack: 0.002,
      });
    });
  }

  /** Turn change: player = bright rising chime; enemy = dark descending one. */
  turn(faction: Faction): void {
    this.play((ctx, out) => {
      if (faction === "player") {
        this.tone(ctx, out, { type: "triangle", f0: 660, dur: 0.12, peak: 0.4 });
        this.tone(ctx, out, { type: "triangle", f0: 990, dur: 0.18, peak: 0.4, when: 0.11 });
      } else {
        this.tone(ctx, out, { type: "sine", f0: 240, dur: 0.16, peak: 0.42 });
        this.tone(ctx, out, { type: "sine", f0: 160, dur: 0.24, peak: 0.42, when: 0.14 });
      }
    });
  }

  /** Subtle UI blip for selection. */
  select(): void {
    this.play((ctx, out) => {
      this.tone(ctx, out, { type: "sine", f0: 880, f1: 1180, dur: 0.06, peak: 0.22 });
    });
  }

  /** Grenade / HE detonation: noise crash swept down + a low sub-thump. */
  explosion(): void {
    this.play((ctx, out) => {
      this.noiseBurst(ctx, out, {
        filterType: "lowpass",
        f0: 1800,
        f1: 220,
        q: 0.6,
        dur: 0.55,
        peak: 0.95,
        attack: 0.002,
      });
      this.tone(ctx, out, { type: "sine", f0: 120, f1: 38, dur: 0.6, peak: 0.85 });
      this.tone(ctx, out, { type: "triangle", f0: 90, f1: 30, dur: 0.5, peak: 0.5, when: 0.01 });
    });
  }

  /** Medkit use: a soft two-step rising chime (positive healing cue). */
  heal(): void {
    this.play((ctx, out) => {
      this.tone(ctx, out, {
        type: "sine",
        f0: 520,
        f1: 700,
        dur: 0.16,
        peak: 0.3,
        attack: 0.01,
      });
      this.tone(ctx, out, {
        type: "sine",
        f0: 780,
        f1: 1040,
        dur: 0.2,
        peak: 0.28,
        when: 0.12,
        attack: 0.01,
      });
      this.tone(ctx, out, { type: "triangle", f0: 1300, dur: 0.12, peak: 0.16, when: 0.26 });
    });
  }

  /** Panic alarm: a sharp two-tone warbling blip (unit lost control). */
  panic(): void {
    this.play((ctx, out) => {
      this.tone(ctx, out, { type: "square", f0: 880, f1: 1320, dur: 0.09, peak: 0.3 });
      this.tone(ctx, out, { type: "square", f0: 880, f1: 1320, dur: 0.09, peak: 0.3, when: 0.16 });
      this.tone(ctx, out, {
        type: "sawtooth",
        f0: 440,
        f1: 220,
        dur: 0.22,
        peak: 0.18,
        when: 0.08,
        filter: { type: "lowpass", f0: 2000, q: 2 },
      });
    });
  }

  // -------------------------------------------------------------------------
  // Context + node plumbing (all defensive)
  // -------------------------------------------------------------------------

  /** Lazily create the context + master bus. Returns null if unavailable. */
  private ensure(): { ctx: AudioContext; master: GainNode } | null {
    if (this.ctx && this.master) return { ctx: this.ctx, master: this.master };
    try {
      const Ctor: typeof AudioContext | undefined =
        typeof AudioContext !== "undefined"
          ? AudioContext
          : (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = this.muted ? 0 : MASTER_VOLUME;
      master.connect(ctx.destination);
      this.ctx = ctx;
      this.master = master;
      return { ctx, master };
    } catch {
      return null;
    }
  }

  /** Run `build` against the master bus, but only when audible. Never throws. */
  private play(build: (ctx: AudioContext, out: AudioNode) => void): void {
    if (this.muted) return;
    const audio = this.ensure();
    if (!audio) return;
    // Skip scheduling into a suspended context (autoplay still blocked).
    if (audio.ctx.state !== "running") return;
    try {
      build(audio.ctx, audio.master);
    } catch {
      // An audio glitch must never break the render/command loop.
    }
  }

  /** A reusable 1s mono white-noise buffer, regenerated if the rate changes. */
  private getNoise(ctx: AudioContext): AudioBuffer {
    if (this.noiseBuffer && this.noiseBuffer.sampleRate === ctx.sampleRate) {
      return this.noiseBuffer;
    }
    const length = Math.max(1, Math.floor(ctx.sampleRate));
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  /** Oscillator voice with optional pitch glide, band filter and AD envelope. */
  private tone(ctx: AudioContext, out: AudioNode, o: ToneSpec): void {
    const t0 = ctx.currentTime + (o.when ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 > 0) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);

    let head: AudioNode = osc;
    if (o.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = o.filter.type;
      filter.frequency.setValueAtTime(o.filter.f0, t0);
      if (o.filter.f1 !== undefined && o.filter.f1 > 0) {
        filter.frequency.exponentialRampToValueAtTime(o.filter.f1, t0 + o.dur);
      }
      if (o.filter.q !== undefined) filter.Q.value = o.filter.q;
      osc.connect(filter);
      head = filter;
    }

    const gain = ctx.createGain();
    const attack = o.attack ?? 0.005;
    gain.gain.setValueAtTime(EPS, t0);
    gain.gain.linearRampToValueAtTime(o.peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, t0 + o.dur);

    head.connect(gain).connect(out);
    osc.start(t0);
    osc.stop(t0 + o.dur + 0.05);
  }

  /** Filtered white-noise burst with an AD envelope. */
  private noiseBurst(ctx: AudioContext, out: AudioNode, o: NoiseSpec): void {
    const t0 = ctx.currentTime + (o.when ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);

    const filter = ctx.createBiquadFilter();
    filter.type = o.filterType;
    filter.frequency.setValueAtTime(o.f0, t0);
    if (o.f1 !== undefined && o.f1 > 0) filter.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
    if (o.q !== undefined) filter.Q.value = o.q;

    const gain = ctx.createGain();
    const attack = o.attack ?? 0.002;
    gain.gain.setValueAtTime(EPS, t0);
    gain.gain.linearRampToValueAtTime(o.peak, t0 + attack);
    gain.gain.exponentialRampToValueAtTime(EPS, t0 + o.dur);

    src.connect(filter).connect(gain).connect(out);
    src.start(t0);
    src.stop(t0 + o.dur + 0.05);
  }
}
