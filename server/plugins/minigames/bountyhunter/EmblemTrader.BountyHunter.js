"use strict";

/**
 * The Emblem Trader (OSRS Wiki: Emblem Trader and its transcript).
 *
 * Talk-to plays the imported transcript (NpcDialogues); this unit picks the Daimon's Crater
 * version for the crater's trader, answers its conditions, fills in the target band, sets the
 * band (varbit bh_combat_band, read by target matching), and gives the PK skull. Rewards opens
 * the Bounty Hunter Store in the crater (the transcript's "trade for rewards" branch) and refuses
 * outside it; Skull goes straight to the skull branch. The Revenant Caves trader buys ancient
 * artefacts for coins; using an esoteric emblem on any trader sells it for its points.
 */

const Points = require("./Points.BountyHunter");
const Emblems = require("./Emblems.BountyHunter");

const BAND_ATTRIBUTE = "bounty-hunter:combat-band";
const VARBIT_COMBAT_BAND = "bh_combat_band"; // 5, 10 or 15 levels
const BANDS = [5, 10, 15];

const CRATER_VARIANT = "standard-dialogue-within-daimon-s-crater";
const RIGHT_CLICK_REWARDS_VARIANT = "standard-dialogue-right-click-rewards";
const TRADE_OPTION = "Let's trade for rewards.";
const SKULL_OPTION = "Can I have a PK skull, please?";
const EXTEND_SKULL_OPTION = "Can you make my PK skull last longer?";
const BAND_LINE = "You may be assigned Targets up to [value] levels stronger than you.";
const SKULL_MESSAGES = new Set(["You are now skulled.", "Your PK skull will now last for the full 20 minutes."]);

const PK_SKULL_SECONDS = 20 * 60;
/** Ancient artefacts (plain and noted) and their coin prices at the Revenant Caves trader (Wiki). */
const ARTEFACTS = Object.freeze([
  ["ANCIENT_EMBLEM", "ANCIENT_EMBLEM_2", 500_000],
  ["ANCIENT_TOTEM", "ANCIENT_TOTEM_2", 1_000_000],
  ["ANCIENT_STATUETTE", "ANCIENT_STATUETTE_2", 2_000_000],
  ["ANCIENT_MEDALLION", "ANCIENT_MEDALLION_2", 4_000_000],
  ["ANCIENT_EFFIGY", "ANCIENT_EFFIGY_2", 8_000_000],
  ["ANCIENT_RELIC", "ANCIENT_RELIC_2", 16_000_000],
]);

let core;
let pluginApi;
let TRADER_IDS;
let CRATER_TRADER;
let REVENANT_CAVE_TRADER;
/** Item id -> its coin price, both plain and noted. */
let artefactPrices;

function band(player) {
  const value = Number(player.getAttribute(BAND_ATTRIBUTE));
  return BANDS.includes(value) ? value : BANDS[0];
}

function syncBand({ player }) {
  player.getPacketSender().sendVarbit(core.CacheDefinitions.getVarbitId(VARBIT_COMBAT_BAND), band(player));
}

function fullSkullTicks() {
  return Math.ceil(core.Misc.getTicks(PK_SKULL_SECONDS));
}

/** The steps of the transcript option with this text, searching every nested menu. */
function findOption(steps, text) {
  for (const step of steps ?? []) {
    for (const option of step.options ?? []) {
      if (option.text === text) return option.steps ?? [];
      const nested = findOption(option.steps, text);
      if (nested) return nested;
    }
    const nested = findOption(step.steps, text);
    if (nested) return nested;
  }
  return null;
}

/** Plays one option's branch of the crater transcript, as if the player had picked it. */
function playOption(player, npc, npcId, text) {
  pluginApi.emitCustomEvent("npc-dialogue:start", {
    player, npc, npcId, variant: CRATER_VARIANT, handled: false, select: (steps) => findOption(steps, text),
  });
}

function selectVariant({ npcId }) {
  return npcId === CRATER_TRADER ? CRATER_VARIANT : null;
}

function answerCondition({ player, npcId, text }) {
  if (!TRADER_IDS.includes(npcId)) return null;
  const answers = {
    "If the player is not skulled": !player.isSkulled(),
    "If the player is skulled": player.isSkulled(),
    "If the skull can be extended": player.getSkullTimer() < fullSkullTicks(),
    "If the skull can not be extended": player.getSkullTimer() >= fullSkullTicks(),
    "If the player is not on a Deadman Mode world": true,
    "If the player is on a Deadman Mode world": false,
  };
  const key = String(text).replace(/:\s*$/, "");
  return Object.hasOwn(answers, key) ? answers[key] : null;
}

function bandLine(request) {
  if (!TRADER_IDS.includes(request.npcId) || request.text !== BAND_LINE) return;
  const { player, npc, npcId } = request;
  request.text = BAND_LINE.replace("[value]", band(player));
  // The transcript's own menu cannot show the current band ("[value]"), so this one replaces it.
  request.after = () => pluginApi.sendMultiChatboxPrompt(player, `Current maximum: ${band(player)} levels higher`,
    ...BANDS.flatMap((levels) => [`Set maximum to ${levels} levels higher`, () => setBand(player, npc, npcId, levels)]));
}

function setBand(player, npc, npcId, levels) {
  player.setAttribute(BAND_ATTRIBUTE, levels);
  syncBand({ player });
  playOption(player, npc, npcId, `Set maximum to ${levels} levels higher`);
}

function skull(message) {
  if (!TRADER_IDS.includes(message.npcId) || message.kind !== "message" || !SKULL_MESSAGES.has(message.text)) return;
  const { player } = message;
  player.setSkullType(core.SkullType.WHITE_SKULL);
  player.setSkullTimer(fullSkullTicks());
  player.getUpdateFlag().flag(core.Flag.APPEARANCE);
  message.box = { statement: true };
}

function rewards({ player, npc, npcId }) {
  if (npcId === CRATER_TRADER) {
    playOption(player, npc, npcId, TRADE_OPTION);
  } else {
    pluginApi.emitCustomEvent("npc-dialogue:start", { player, npc, npcId, variant: RIGHT_CLICK_REWARDS_VARIANT, handled: false });
  }
}

function skullOption({ player, npc, npcId }) {
  playOption(player, npc, npcId, player.isSkulled() ? EXTEND_SKULL_OPTION : SKULL_OPTION);
}

// Best guess: the transcript only has the Deadman archaic-emblem sale; this follows its wording.
function sellEmblem(event) {
  const { player, itemId, slot, npcId } = event;
  const tier = Emblems.tierOfItem(itemId);
  if (tier <= 0 || event.definition?.getName?.() !== "Emblem Trader") return;
  event.handled = true;
  pluginApi.sendMultiChatboxPrompt(player, "Sell your esoteric emblem?",
    "Yes.", () => completeSale(player, npcId, itemId, slot, tier),
    "No.", () => player.getPacketSender().sendInterfaceRemoval());
}

function completeSale(player, npcId, itemId, slot, tier) {
  if (player.getInventory().get(slot)?.getId() !== itemId) return;
  const points = Emblems.POINT_VALUES[tier - 1];
  Emblems.setTier(player, slot, 0);
  Points.addPoints(player, points);
  player.getDialogueManager().startDialogues(new core.DialogueChainBuilder()
    .add(new core.ItemStatementDialogue(0, itemId, `The trader awards you ${points} points.`))
    .add(new core.NpcDialogue(1, npcId, "Thank you. My master in the north will be very pleased.")));
}

/** The Revenant Caves trader buys ancient artefacts, plain or noted, for coins. */
function sellArtefact(event) {
  const price = artefactPrices.get(event.itemId);
  if (price === undefined || event.npcId !== REVENANT_CAVE_TRADER) return;
  const { player, itemId, slot } = event;
  const inventory = player.getInventory();
  const held = inventory.get(slot);
  if (held?.getId?.() !== itemId || held.getAmount() <= 0) return;
  event.handled = true;
  if (held.getAmount() > 1) inventory.setItem(slot, new core.Item(itemId, held.getAmount() - 1));
  else inventory.setItem(slot, new core.Item(-1, 0));
  inventory.addItem(new core.Item(core.ItemIdentifiers.COINS, price));
  inventory.refreshItems();
  const name = core.ItemDefinition.forId(itemId)?.getName?.() ?? "ancient artefact";
  player.sendMessage(`You sell the ${name} to the Emblem Trader for ${price.toLocaleString("en-US")} coins.`);
}

module.exports = function attachBountyHunterEmblemTrader(api) {
  core = api.core;
  pluginApi = api;
  const Npcs = core.NpcIdentifiers;
  CRATER_TRADER = Npcs.EMBLEM_TRADER_2;
  TRADER_IDS = [Npcs.EMBLEM_TRADER, Npcs.EMBLEM_TRADER_2, Npcs.EMBLEM_TRADER_3];
  REVENANT_CAVE_TRADER = Npcs.EMBLEM_TRADER;
  artefactPrices = new Map(ARTEFACTS.flatMap(([plain, noted, price]) =>
    [[core.ItemIdentifiers[plain], price], [core.ItemIdentifiers[noted], price]]));
  api.persistAttribute(BAND_ATTRIBUTE, BANDS[0]);
  api.onPlayerLogin(syncBand);
  api.onNpcDialogueVariant(selectVariant);
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:line", bandLine);
  api.onCustomEvent("npc-dialogue:action", skull);
  api.onNpcInteraction("Emblem Trader", { Rewards: rewards, Skull: skullOption });
  api.onItemOnNpc(sellArtefact);
  api.onItemOnNpc(sellEmblem);
};
Object.assign(module.exports, { band, findOption, answerCondition, sellArtefact });
