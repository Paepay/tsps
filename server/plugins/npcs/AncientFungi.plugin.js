"use strict";

/**
 * Ancient Fungi (https://oldschool.runescape.wiki/w/Ancient_Fungi) on Fossil Island.
 * Picking one transforms that NPC into an Ancient Zygomite (7797) that attacks back.
 * The fungi are rooted: npc-spawns-custom.json pins the 27 base spawns to their tiles
 * (the base spawns default to a five-tile wander).
 */
const ANCIENT_ZYGOMITE = 7797;

function pickFungus({ player, npc }) {
  if (!npc || npc.getNpcTransformationId?.() === ANCIENT_ZYGOMITE) return false;
  npc.setNpcTransformationId(ANCIENT_ZYGOMITE);
  npc.setHitpoints(npc.getMaxHitpoints());
  npc.getMovementQueue?.().reset?.();
  npc.getMovementCoordinator?.().setRadius?.(0);
  player.sendMessage("You pick the ancient fungi. It uproots itself and attacks!");
  return true;
}

module.exports = {
  name: "AncientFungi",
  description: "Picking Ancient Fungi turns the spawn into an Ancient Zygomite.",
  members: true,
  _test: { pickFungus, ANCIENT_ZYGOMITE },
  register(api) {
    api.onNpcInteraction("Ancient Fungi", { Pick: pickFungus });
  },
};
