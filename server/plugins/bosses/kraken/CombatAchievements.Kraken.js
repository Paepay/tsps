"use strict";

/**
 * The Kraken's Combat Achievement "Unnecessary Optimisation" (cache task struct 3309):
 * "Kill the Kraken after killing all four tentacles."
 *
 * The four Enormous Tentacles are separate NPCs belonging to the boss fight, and killing the
 * Kraken kills whichever are left (Respawn.Kraken.js), so only the tentacles of the boss that
 * is up can count. Each boss NPC carries the tentacles each player killed while it was up: when
 * that boss dies, a player who killed all four and took part in the kill finishes the task.
 * Keying by the boss NPC itself starts every respawn clean without a timer or an attribute.
 */

const Shared = require("./Shared.Kraken");

const TASK = "Unnecessary Optimisation";
const TENTACLES_REQUIRED = 4;

/** boss NPC -> Map(player -> Set(tentacle NPC)): the tentacles that player killed while it was up. */
const tentacleKills = new WeakMap();

const isPlayer = (entity) => entity?.isPlayer?.() === true;

/** The living Kraken in `area` (the open world is the null area), or null. */
function bossIn(area) {
  let npcs = null;
  try {
    npcs = Shared.core().World.getNpcs();
  } catch {
    return null;
  }
  for (const npc of npcs ?? []) {
    if (npc?.isNpc?.() !== true || npc.getId?.() !== Shared.ids().BOSS) continue;
    if (!Shared.alive(npc) || npc.getPrivateArea?.() !== area) continue;
    return npc;
  }
  return null;
}

function countKill(player, boss, tentacle) {
  let byPlayer = tentacleKills.get(boss);
  if (!byPlayer) { byPlayer = new Map(); tentacleKills.set(boss, byPlayer); }
  let tentacles = byPlayer.get(player);
  if (!tentacles) { tentacles = new Set(); byPlayer.set(player, tentacles); }
  tentacles.add(tentacle);
}

/** A tentacle's death counts only while its boss is up and a player landed the blow. */
function tentacleDied({ npc, killer }) {
  if (!isPlayer(killer) || npc?.getId?.() !== Shared.ids().TENTACLE) return;
  const boss = bossIn(npc.getPrivateArea?.() ?? null);
  if (boss) countKill(killer, boss, npc);
}

/** The boss died: every player who killed all four tentacles and took part in its death. */
function bossDied(event) {
  const { npc, killer, damagers } = event ?? {};
  if (npc?.getId?.() !== Shared.ids().BOSS) return;
  const byPlayer = tentacleKills.get(npc);
  tentacleKills.delete(npc);
  if (!byPlayer?.size) return;
  const participants = new Set([...(Array.isArray(damagers) ? damagers : []), killer].filter(isPlayer));
  for (const player of participants) {
    if ((byPlayer.get(player)?.size ?? 0) < TENTACLES_REQUIRED) continue;
    Shared.api().emitCustomEvent("combat-achievements:complete", { player, task: TASK });
  }
}

function attach(api) {
  api.onNpcDeath(tentacleDied);
  api.onNpcDeath(bossDied);
}

module.exports = { attach, tentacleDied, bossDied, TASK, TENTACLES_REQUIRED };
