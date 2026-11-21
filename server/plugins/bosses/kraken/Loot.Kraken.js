"use strict";

/**
 * Where Kraken loot lands (see ../Kraken.plugin.js for behaviour and sources).
 *
 * The Kraken's body sits in deep water, so the default loot tile (its own location)
 * is unreachable. Boss loot goes to a fixed shore tile south of the pool, as with
 * Zulrah and Vorkath moving loot off the boss. Cave krakens also die in the pool,
 * so their loot follows the killer onto the walkway tile.
 */

const Shared = require("./Shared.Kraken");

/**
 * Shore tile south of the boss pool. Chosen because it is verified walkable: the
 * tester stood on it while the boss died at (2278-2282, 10034-10038), and loot
 * placed there is reachable. It is ~18 tiles from the body, so the killer collects
 * after the fight rather than mid-fight.
 */
const LOOT_TILE = [2280, 10031];

function placeLoot(where) {
  if (!where) return;
  const { BOSS, CAVE_KRAKEN } = Shared.ids();
  if (where.npcId === CAVE_KRAKEN) {
    const tile = where.player?.getLocation?.();
    if (tile) where.location = tile.clone();
    return;
  }
  if (where.npcId !== BOSS) return;
  const z = where.npc?.getLocation?.()?.getZ?.() ?? 0;
  const { Location } = Shared.core();
  where.location = new Location(LOOT_TILE[0], LOOT_TILE[1], z);
}

function attach(api) {
  api.onCustomEvent("npc-drops:location", placeLoot);
}

module.exports = { attach, placeLoot, LOOT_TILE };
