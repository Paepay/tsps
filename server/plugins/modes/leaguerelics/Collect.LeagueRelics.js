/**
 * The Leagues Tutor's Collect-items for every league: the player asks "Do I have any League items
 * to collect?" (chatquiz1); on Continue the item box names the Tutor and the items go into the
 * inventory. What is owed: each item the character's relics hand out (the Reloaded pick's too)
 * that it owns none of, carried, worn or banked; as many as the inventory takes. Ours
 * (unrecorded): the lines when nothing is owed and when the inventory is too full for the rest.
 */
const Common = require("./Common.LeagueRelics");
const Unlock = require("./Unlock.LeagueRelics");

/** The relics the character holds: one a chosen tier, and Reloaded's extra pick. */
function heldRelics(player, type) {
  const held = Object.entries(Common.chosen(player)).map(([tier, slot]) => Common.relic(type, Number(tier), slot));
  const extra = Common.reloadedPick(player, type);
  if (extra) held.push(extra);
  return held.filter(Boolean);
}

/** Carried, worn or banked; a bank placeholder (amount 0) isn't owning it. */
function owns(player, itemId) {
  return Common.core.Bank.owns(player, itemId);
}

/** The relic items the character owns none of, each once. */
function owed(player, type) {
  const ids = heldRelics(player, type).flatMap((relic) => Unlock.grantedItems(relic));
  // Trailblazer Reloaded tier 3 passive: the Crystal of memories (cache name Crystal of Echoes).
  const crystal = Common.data.effects.crystalOfMemories;
  if (crystal && [].concat(crystal.league).includes(type) && Common.highestTier(player) + 1 >= crystal.fromTier) {
    const id = Common.core.ItemIdentifiers[crystal.item];
    if (Number.isInteger(id)) ids.push(id);
  }
  return [...new Set(ids)].filter((id) => !owns(player, id));
}

/** The tutor speaking: the interaction's NPC, else the one the player is still facing, else the league's cache entry. */
function tutorNpcId(player, type, npcId) {
  if (Number.isInteger(npcId) && npcId > 0) return npcId;
  const contentId = player.getInteractingMobile?.()?.getContentId?.(player);
  if (Number.isInteger(contentId) && contentId > 0) return contentId;
  const { CacheDefinitions } = Common.core;
  const cacheName = Common.cacheLeague(type)?.tutor?.npc ?? "league_tutor_league";
  return CacheDefinitions.getNpcId(cacheName) ?? CacheDefinitions.getNpcId("league_tutor_league") ?? 0;
}

/** Hands over what fits, then the recorded item box, or ours when nothing is owed. */
function handOver(player, type, npcId) {
  const items = owed(player, type);
  const { DialogueChainBuilder, NpcDialogue, StatementDialogue, ItemStatementDialogue } = Common.core;
  const manager = player.getDialogueManager();
  if (items.length === 0) {
    manager.startDialogues(new DialogueChainBuilder().add(new NpcDialogue(0, tutorNpcId(player, type, npcId), Common.message("collectNothing", {}, type))));
    return;
  }
  const inventory = player.getInventory();
  const given = [];
  for (const id of items) {
    if (inventory.getFreeSlots() < 1) break;
    inventory.adds(id, 1);
    given.push(id);
  }
  if (given.length === 0) {
    manager.startDialogues(new DialogueChainBuilder().add(new StatementDialogue(0, Common.message("collectFull", {}, type))));
    return;
  }
  manager.startDialogues(new DialogueChainBuilder().add(new ItemStatementDialogue(0, given[0], Common.message("collectReceived", {}, type))));
  if (given.length < items.length) player.sendMessage(Common.message("collectFull", {}, type));
}

/** Collect-items: the recorded question, then the items on Continue. */
function collectItems({ player, npcId }) {
  const type = Common.leagueOf(player);
  if (type === null) return false;
  const { DialogueChainBuilder, PlayerDialogue, ActionDialogue, CacheDefinitions } = Common.core;
  const chathead = CacheDefinitions.getSeqId("chatquiz1") ?? undefined;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder()
    .add(new PlayerDialogue(0, Common.message("collectAsk", {}, type), chathead))
    .add(new ActionDialogue(1, { execute: () => handOver(player, type, npcId) })));
  return true;
}

module.exports = function attach(api) {
  api.onNpcInteraction("Leagues Tutor", { "Collect-items": collectItems });
};

Object.assign(module.exports, { owed });
