/**
 * Reaction fire (the classic "Reactions x TU% initiative" interrupt).
 *
 * After the active mover takes a step or action, the reducer calls
 * {@link triggerReactions}. Any living enemy that can see the mover, can afford
 * a snap shot, and out-rolls the mover on reaction initiative gets to fire an
 * interrupting snap shot at the mover's current tile.
 *
 * Purity: no DOM / three.js. Randomness flows only through combat.resolveShot
 * (i.e. state.rng). This module mutates unit TU/facing and the mover's HP via
 * resolveShot, and returns the events the reducer should replay.
 */

import type { BattleState, GameEvent, Unit } from "./types";
import { canSee, dir8Towards, lineOfFire } from "./los";
import { findMode, resolveShot, tuCostForMode } from "./combat";

/** Reaction initiative: reactions stat scaled by the current TU fraction. */
export function reactionScore(unit: Unit): number {
  const maxTu = unit.stats.timeUnits;
  if (maxTu <= 0) return 0;
  return unit.stats.reactions * (unit.tu / maxTu);
}

/**
 * Resolve any reaction fire provoked by `mover`'s latest action. Eligible
 * reactors are living units of the opposite faction that can afford a snap
 * shot, can see the mover, and strictly out-score the mover on initiative
 * (ties favour the active mover). The highest-scoring eligible reactor fires
 * first; a reactor may fire again while it still qualifies. Total reaction
 * shots are capped to avoid loops. If a reaction kills the mover, a "died"
 * event is emitted and processing stops.
 */
export function triggerReactions(state: BattleState, mover: Unit): GameEvent[] {
  const events: GameEvent[] = [];
  const moverScore = reactionScore(mover);

  const candidates = state.units.filter(
    (u) => u.faction !== mover.faction,
  );
  const maxShots = candidates.length * 2;
  let shotsFired = 0;

  while (mover.alive && shotsFired < maxShots) {
    const eligible = candidates.filter((reactor) => {
      if (!reactor.alive) return false;
      const weapon = state.weapons[reactor.weaponId];
      if (!weapon) return false;
      const snap = findMode(weapon, "snap");
      if (!snap) return false;
      if (reactor.ammo < snap.shots) return false;
      if (reactor.tu < tuCostForMode(reactor, snap)) return false;
      if (!canSee(state.grid, reactor, mover.pos)) return false;
      return reactionScore(reactor) > moverScore;
    });
    if (eligible.length === 0) break;

    eligible.sort((a, b) => {
      const diff = reactionScore(b) - reactionScore(a);
      if (diff !== 0) return diff;
      return a.id - b.id; // deterministic tie-break
    });

    const reactor = eligible[0]!;
    const weapon = state.weapons[reactor.weaponId]!;
    const snap = findMode(weapon, "snap")!;

    // Face the mover (free) and pay for the snap shot.
    reactor.facing = dir8Towards(reactor.pos, mover.pos);
    reactor.tu -= tuCostForMode(reactor, snap);
    reactor.ammo = Math.max(0, reactor.ammo - snap.shots);

    // The reactor already canSee the mover, so this is normally the direct tile.
    const origin = lineOfFire(state.grid, reactor.pos, mover.pos).origin;
    const result = resolveShot(state, reactor, mover.pos, "snap");
    shotsFired++;

    events.push({
      type: "shot",
      shooterId: reactor.id,
      targetId: result.targetId,
      targetPos: { x: mover.pos.x, y: mover.pos.y },
      originPos: origin,
      mode: "snap",
      rounds: result.rounds,
      tuLeft: reactor.tu,
      reaction: true,
    });

    if (!mover.alive) {
      events.push({ type: "died", unitId: mover.id });
      break;
    }
  }

  return events;
}
