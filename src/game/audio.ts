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

/** Persistent background ambience bed, one per strategic screen. */
export type AmbienceType = "geoscape" | "base" | "tactical";

const MASTER_VOLUME = 0.25;
/** Master gain of the ambience bus (each bed's layers scale under this). */
const AMBIENCE_VOLUME = 0.5;
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

/**
 * Spacing (ms) until the next accent blip for a bed type, with jitter so the
 * radar pings / industrial clanks never settle into a metronomic loop. Tactical
 * has no accents (its bed is fully continuous), so it returns infinity.
 */
function blipIntervalMs(type: AmbienceType): number {
  if (type === "tactical") return Number.POSITIVE_INFINITY;
  const base = type === "geoscape" ? 4200 : 5600;
  return Math.max(1600, base + (Math.random() - 0.5) * 2800);
}

export class Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private muted = false;

  // Ambience bed state — one persistent layered bed at a time. The bed is a
  // small graph of oscillators + filtered noise into a dedicated gain on the
  // master bus, so muting silences it with everything else.
  private ambienceType: AmbienceType | null = null;
  private ambienceGain: GainNode | null = null;
  private ambienceSources: AudioScheduledSourceNode[] = [];
  private ambienceNodes: AudioNode[] = [];
  private ambienceBlipTimer: ReturnType<typeof setTimeout> | null = null;

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
  // Procedural ambience (persistent layered beds, no audio files)
  // -------------------------------------------------------------------------

  /**
   * Start (or switch to) a layered background ambience bed for the given screen.
   * Each bed is a small graph of low oscillators + filtered noise routed through
   * a dedicated gain into the master bus, so {@link setMuted} silences it with
   * everything else. Switching crossfades the old bed out and the new one in;
   * calling with the already-active type is a no-op. Safe before the context is
   * running — the bed is built suspended and simply waits for {@link resume}.
   */
  startAmbience(type: AmbienceType): void {
    if (this.ambienceType === type && this.ambienceGain) return;
    this.ambienceType = type;
    const audio = this.ensure();
    if (!audio) return;
    try {
      this.setAmbienceBed(audio.ctx, audio.master, type);
    } catch {
      // Ambience is best-effort; never throw into the caller.
    }
  }

  /** Stop the active ambience bed (fades it out and tears down its node graph). */
  stopAmbience(): void {
    this.ambienceType = null;
    if (this.ambienceBlipTimer !== null) {
      clearTimeout(this.ambienceBlipTimer);
      this.ambienceBlipTimer = null;
    }
    const ctx = this.ctx;
    if (ctx) this.retireAmbienceBed(ctx);
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

  // -------------------------------------------------------------------------
  // Ambience internals
  // -------------------------------------------------------------------------

  /**
   * Fade the current bed out, stop its sources just after the fade, then
   * disconnect on a wall-clock timer so cleanup is reliable even while the
   * context is suspended (audio-clock stops would not fire until resume).
   * Leaves {@link ambienceType} untouched so a fresh bed of the same type can
   * be rebuilt immediately.
   */
  private retireAmbienceBed(ctx: AudioContext): void {
    const gain = this.ambienceGain;
    const sources = this.ambienceSources;
    const nodes = this.ambienceNodes;
    this.ambienceGain = null;
    this.ambienceSources = [];
    this.ambienceNodes = [];
    if (!gain) return;

    const t = ctx.currentTime;
    const fadeEnd = t + 0.25;
    try {
      gain.gain.cancelScheduledValues(t);
      gain.gain.setValueAtTime(Math.max(EPS, gain.gain.value), t);
      gain.gain.exponentialRampToValueAtTime(EPS, fadeEnd);
    } catch {
      // Envelope scheduling is best-effort.
    }
    for (const src of sources) {
      try {
        src.stop(fadeEnd + 0.03);
      } catch {
        // Already stopped — the deferred disconnect below still cleans up.
      }
    }
    // Each retire captures its own node list, so a late timer can never touch a
    // newer bed's nodes.
    setTimeout(() => {
      for (const node of nodes) {
        try {
          node.disconnect();
        } catch {
          // disconnect() is idempotent; ignore double-disconnects.
        }
      }
    }, 330);
  }

  /**
   * Build a fresh ambience bed for `type` into the master bus: a dedicated gain
   * (faded in) feeding the layered oscillators/noise. Retires any prior bed
   * first, so the two crossfade. Nothing here allocates per frame — the bed is a
   * fixed node graph; only the occasional accent blips (see {@link scheduleBlip})
   * create short-lived voices, scheduled on a timer.
   */
  private setAmbienceBed(ctx: AudioContext, master: GainNode, type: AmbienceType): void {
    this.retireAmbienceBed(ctx);
    if (this.ambienceBlipTimer !== null) {
      clearTimeout(this.ambienceBlipTimer);
      this.ambienceBlipTimer = null;
    }

    const gain = ctx.createGain();
    const t = ctx.currentTime;
    try {
      gain.gain.setValueAtTime(EPS, t);
      gain.gain.linearRampToValueAtTime(AMBIENCE_VOLUME, t + 0.4);
    } catch {
      // Best-effort fade-in.
    }
    gain.connect(master);

    const sources: AudioScheduledSourceNode[] = [];
    const nodes: AudioNode[] = [gain];
    this.buildBedLayers(ctx, gain, type, sources, nodes);
    for (const src of sources) {
      try {
        src.start();
      } catch {
        // A source that fails to start simply contributes nothing.
      }
    }

    this.ambienceGain = gain;
    this.ambienceSources = sources;
    this.ambienceNodes = nodes;
    this.scheduleBlip();
  }

  /**
   * Create + connect the persistent oscillator/noise layers for one bed into
   * `out`. Sources are pushed to `sources` (started/stopped by the caller) and
   * every node to `nodes` (disconnected on teardown); nothing is started here.
   */
  private buildBedLayers(
    ctx: AudioContext,
    out: AudioNode,
    type: AmbienceType,
    sources: AudioScheduledSourceNode[],
    nodes: AudioNode[],
  ): void {
    if (type === "geoscape") {
      // Deep-space hum: a low sine + sub-octave with a slow LFO swelling the hum.
      const hum = ctx.createOscillator();
      hum.type = "sine";
      hum.frequency.value = 80;
      const humGain = ctx.createGain();
      humGain.gain.value = 0.16;
      hum.connect(humGain).connect(out);

      const sub = ctx.createOscillator();
      sub.type = "sine";
      sub.frequency.value = 40;
      const subGain = ctx.createGain();
      subGain.gain.value = 0.1;
      sub.connect(subGain).connect(out);

      const lfo = ctx.createOscillator();
      lfo.type = "sine";
      lfo.frequency.value = 0.07;
      const lfoDepth = ctx.createGain();
      lfoDepth.gain.value = 0.07;
      lfo.connect(lfoDepth).connect(humGain.gain);

      sources.push(hum, sub, lfo);
      nodes.push(humGain, subGain, lfoDepth);
      return;
    }

    if (type === "base") {
      // Mechanical drone: a low sawtooth through a resonant low-pass, plus a
      // filtered noise machinery hum.
      const drone = ctx.createOscillator();
      drone.type = "sawtooth";
      drone.frequency.value = 58;
      const droneFilter = ctx.createBiquadFilter();
      droneFilter.type = "lowpass";
      droneFilter.frequency.value = 180;
      droneFilter.Q.value = 4;
      const droneGain = ctx.createGain();
      droneGain.gain.value = 0.1;
      drone.connect(droneFilter).connect(droneGain).connect(out);

      const noise = this.loopingNoise(ctx);
      const noiseFilter = ctx.createBiquadFilter();
      noiseFilter.type = "bandpass";
      noiseFilter.frequency.value = 220;
      noiseFilter.Q.value = 1.4;
      const noiseGain = ctx.createGain();
      noiseGain.gain.value = 0.08;
      noise.connect(noiseFilter).connect(noiseGain).connect(out);

      sources.push(drone, noise);
      nodes.push(droneFilter, droneGain, noiseFilter, noiseGain);
      return;
    }

    // tactical: a wind bed (filtered noise with a gusting low-pass sweep) plus a
    // distant low rumble.
    const wind = this.loopingNoise(ctx);
    const windFilter = ctx.createBiquadFilter();
    windFilter.type = "lowpass";
    windFilter.frequency.value = 600;
    windFilter.Q.value = 0.7;
    const windGain = ctx.createGain();
    windGain.gain.value = 0.12;

    const gust = ctx.createOscillator();
    gust.type = "sine";
    gust.frequency.value = 0.12;
    const gustDepth = ctx.createGain();
    gustDepth.gain.value = 300;
    gust.connect(gustDepth).connect(windFilter.frequency);

    wind.connect(windFilter).connect(windGain).connect(out);

    const rumble = ctx.createOscillator();
    rumble.type = "triangle";
    rumble.frequency.value = 45;
    const rumbleGain = ctx.createGain();
    rumbleGain.gain.value = 0.14;
    rumble.connect(rumbleGain).connect(out);

    sources.push(wind, gust, rumble);
    nodes.push(windFilter, windGain, gustDepth, rumbleGain);
  }

  /** A looping white-noise source, for continuous wind/machinery beds. */
  private loopingNoise(ctx: AudioContext): AudioBufferSourceNode {
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise(ctx);
    src.loop = true;
    return src;
  }

  /**
   * Arm the next accent blip (radar ping / industrial clank). Re-armed on each
   * fire so the bed keeps breathing; tactical has no accents and never arms.
   */
  private scheduleBlip(): void {
    const type = this.ambienceType;
    if (!type || type === "tactical") return;
    this.ambienceBlipTimer = setTimeout(() => {
      this.ambienceBlipTimer = null;
      this.fireBlip();
    }, blipIntervalMs(type));
  }

  /** Play one accent (if audible) and re-arm the scheduler. */
  private fireBlip(): void {
    const type = this.ambienceType;
    if (!type) return;
    this.scheduleBlip();
    if (this.muted) return;
    const ctx = this.ctx;
    const out = this.ambienceGain;
    if (!ctx || !out || ctx.state !== "running") return;
    try {
      this.playBlip(ctx, out, type);
    } catch {
      // A blip glitch must never break the scheduler.
    }
  }

  /** One short accent voice appropriate to the bed type. */
  private playBlip(ctx: AudioContext, out: AudioNode, type: AmbienceType): void {
    if (type === "geoscape") {
      // Radar blip: a bright two-step sine sweep.
      this.tone(ctx, out, { type: "sine", f0: 1400, f1: 1900, dur: 0.09, peak: 0.16, attack: 0.002 });
      this.tone(ctx, out, { type: "sine", f0: 2100, dur: 0.05, peak: 0.07, when: 0.18 });
    } else {
      // base: a faint metallic clank (bandpassed noise tick + low thump).
      this.noiseBurst(ctx, out, { filterType: "bandpass", f0: 1500, q: 6, dur: 0.08, peak: 0.18, attack: 0.001 });
      this.tone(ctx, out, { type: "square", f0: 320, f1: 170, dur: 0.05, peak: 0.06 });
    }
  }
}
