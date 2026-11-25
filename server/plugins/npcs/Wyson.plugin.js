/**
 * Wyson the gardener's woad leaf sale (Wiki transcript "Wyson the gardener"): 15 coins buys
 * one leaf, 20 coins buys two. The transcript's coin conditions decide which branch plays;
 * its "receive" actions take the coins and hand over the leaves.
 *
 * His mole-part trade (Wiki "Wyson the gardener", Mole parts): with a mole claw or skin in the
 * inventory he opens with the trade, and with an immaculate mole skin he adds the extra-nests
 * line. Each claw or skin becomes one nest, each immaculate skin five; every nest is a Wyson seed
 * nest (72%), a ring nest (20%) or an empty nest (8%). As live, the trade happens when the
 * player's "Okay, I will trade the mole parts." is continued, the parts come out, the nests fill
 * the first free slots and the chat closes (rsprox capture local 1000323, tick 13641).
 */
const PAGE = "Wyson the gardener";
const MOLE_PARTS_VARIANT = "standard-dialogue-talking-to-wyson-with-mole-parts-in-inventory";
const IMMACULATE_VARIANT = "standard-dialogue-talking-to-wyson-with-immaculate-mole-skin-in-inventory";
/** The two variants' "Wyson exchanges mole parts for nests/nest boxes." action ids. */
const TRADE_STEPS = new Set(["T0rsOq", "XwNH58"]);
const IMMACULATE_NESTS = 5;
/** Receive action id -> { price, leaves }. */
const SALES = new Map([
  ["bywQsQ", { price: 15, leaves: 1 }],
  ["F6m-S9", { price: 20, leaves: 2 }],
]);
/** Condition text -> coins needed (negative: the player has fewer than that). */
const COIN_CONDITIONS = new Map([
  ["If the player has at least 15 coins:", 15],
  ["If the player doesn't have 15 coins:", -15],
  ["If the player has at least 20 coins:", 20],
  ["If the player doesn't have 20 coins:", -20],
]);
const NOT_ENOUGH_COINS_LINE = "I don't have enough coins to buy the leaves. I'll come back later.";
const NO_ROOM_MESSAGE = "You don't have enough inventory space.";
const MEMBERS_WORLD_MESSAGE = "To use this item please login to a members' world.";

const { makeBox } = require("../items/nest-boxes");

function isWyson(core, event) {
  return event.npcId === core.NpcIdentifiers.WYSON_THE_GARDENER
    && event.pages?.some(({ page }) => page === PAGE);
}

function moleParts(core) {
  const ids = core.ItemIdentifiers;
  return {
    parts: new Set([ids.MOLE_CLAW, ids.MOLE_CLAW_2, ids.MOLE_SKIN, ids.MOLE_SKIN_2]),
    immaculate: new Set([ids.IMMACULATE_MOLE_SKIN, ids.IMMACULATE_MOLE_SKIN_2]),
    noted: new Set([ids.MOLE_CLAW_2, ids.MOLE_SKIN_2, ids.IMMACULATE_MOLE_SKIN_2]),
  };
}

function selectVariant(core, event) {
  if (event.npcId !== core.NpcIdentifiers.WYSON_THE_GARDENER || !core.WorldDefinition.isMembersWorld()) return null;
  const inventory = event.player.getInventory();
  const { parts, immaculate } = moleParts(core);
  for (const id of immaculate) if (inventory.getAmount(id) > 0) return { page: PAGE, variant: IMMACULATE_VARIANT };
  for (const id of parts) if (inventory.getAmount(id) > 0) return { page: PAGE, variant: MOLE_PARTS_VARIANT };
  return null;
}

/** Wiki: 8% empty, 72% seeds, 20% ring, per nest. */
function rollNest(core) {
  const ids = core.ItemIdentifiers;
  const roll = Math.random() * 100;
  if (roll < 72) return ids.BIRD_NEST_12;
  return roll < 92 ? ids.BIRD_NEST_5 : ids.BIRD_NEST_6;
}

function tradeMoleParts(core, event) {
  if (!TRADE_STEPS.has(event.stepId) || !isWyson(core, event)) return;
  event.handled = true;
  // Membership may change while the dialogue is open.
  if (!core.WorldDefinition.isMembersWorld()) {
    event.player.sendMessage(MEMBERS_WORLD_MESSAGE);
    event.end = true;
    return;
  }
  const inventory = event.player.getInventory();
  const { parts, immaculate, noted } = moleParts(core);
  const items = inventory.getItems();
  const partStacks = [];
  const boxes = new Map();
  const loose = [];
  items.forEach((item, slot) => {
    const id = item?.getId?.() ?? -1;
    const amount = item?.getAmount?.() ?? 1;
    const isImmaculate = immaculate.has(id);
    if (!isImmaculate && !parts.has(id)) return;
    partStacks.push({ slot, amount });
    const count = (isImmaculate ? IMMACULATE_NESTS : 1) * (noted.has(id) ? amount : 1);
    const boxed = noted.has(id);
    for (let n = 0; n < count; n++) {
      const nest = rollNest(core);
      if (boxed) boxes.set(nest, (boxes.get(nest) ?? 0) + 1);
      else loose.push(nest);
    }
  });
  // The parts' slots all free once they are taken. Noted parts pay in nest boxes (one per nest
  // kind from the trade), so reserve those slots first and let the loose nests fill the rest.
  const freeAfter = inventory.getFreeSlots() + partStacks.length;
  while (loose.length > Math.max(0, freeAfter - boxes.size)) {
    const nest = loose.pop();
    boxes.set(nest, (boxes.get(nest) ?? 0) + 1);
  }
  if (boxes.size > freeAfter) {
    event.player.sendMessage(NO_ROOM_MESSAGE);
    return;
  }
  for (const { slot, amount } of partStacks) inventory.deleteAtSlot(slot, amount, false);
  for (const [nest, count] of boxes) inventory.add(makeBox(core, nest, count), false);
  for (const nest of loose) inventory.add(new core.Item(nest, 1), false);
  inventory.refreshItems();
}

function dialogueCondition(core, event) {
  const threshold = COIN_CONDITIONS.get(event.text);
  if (threshold === undefined || !isWyson(core, event)) return null;
  const amount = event.player.getInventory().getAmount(core.ItemIdentifiers.COINS);
  return threshold > 0 ? amount >= threshold : amount < -threshold;
}

function sellWoad(core, event) {
  const sale = SALES.get(event.stepId);
  if (event.action !== "receive" || sale === undefined || !isWyson(core, event)) return;

  const inventory = event.player.getInventory();
  const coins = core.ItemIdentifiers.COINS;
  const leaf = core.ItemIdentifiers.WOAD_LEAF;
  event.handled = true;
  // The coins could have gone between the condition and this step.
  if (inventory.getAmount(coins) < sale.price) {
    event.steps = [{ player: NOT_ENOUGH_COINS_LINE }, { type: "end" }];
    return;
  }

  const leavesBefore = inventory.getAmount(leaf);
  inventory.deleteNumber(coins, sale.price);
  inventory.adds(leaf, sale.leaves);
  const given = inventory.getAmount(leaf) - leavesBefore;
  if (given !== sale.leaves) {
    if (given > 0) inventory.deleteNumber(leaf, given);
    inventory.adds(coins, sale.price);
    event.player.sendMessage(NO_ROOM_MESSAGE);
    event.end = true;
  }
}

module.exports = {
  name: "Wyson",
  description: "Wyson the gardener sells woad leaves through his dialogue (15 coins for one leaf, 20 coins for two) and trades mole claws and skins for bird nests.",
  register(api) {
    api.onNpcDialogueVariant(selectVariant.bind(null, api.core));
    api.onNpcDialogueCondition(dialogueCondition.bind(null, api.core));
    api.onCustomEvent("npc-dialogue:action", sellWoad.bind(null, api.core));
    api.onCustomEvent("npc-dialogue:action", tradeMoleParts.bind(null, api.core));
  },
};
