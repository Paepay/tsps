/**
 * Shark lure (https://oldschool.runescape.wiki/w/Shark_lure; item 30900): a fishing enhancer used
 * as bait on shark spots. Its Configure option asks how many lures to use at a time (1, 3 or 5);
 * that many are consumed for each raw shark caught, and the catch is faster and likelier at the
 * cost of Fishing XP. It can be stored in a tackle box (StorageItems' tackle bait list).
 *
 * Wiki (Shark lure, Fishing info table):
 *   lures | success | action length | XP   | Heron
 *   0     | 1x      | 6 ticks       | 110  | 1/82,243
 *   1     | 3x      | 5.5 ticks     | 27.5 | 1/328,972
 *   3     | 4.5x    | 5 ticks       | 22   | 1/411,215
 *   5     | 6x      | 4.5 ticks     | 17.6 | 1/493,458
 * The half ticks are the Wiki's "50% chance to be 1t faster": on the harpoon's 6-tick shark spot,
 * one lure makes 5 or 6 ticks evenly, five make 4 or 5. The Heron rates divide the base by 4, 5
 * and 6 for the three quantities.
 *
 * The configured amount is kept per player (and in the client's shark_lure_use_quantity varbit,
 * 16564). The lure only applies when the player carries at least that many, as the catch must
 * consume the configured amount; with fewer, the catch is an ordinary one and no lure is used.
 */
const ATTR = "fishing:shark-lure-amount";
const VARBIT = 16564;
const PROMPT = "How many lures would you like to use at a time?";
const OPTIONS = [1, 3, 5];
const DEFAULT_AMOUNT = 1;
/** Quantity -> the Wiki's effects. */
const EFFECTS = new Map([
  [1, { success: 3, xp: 27.5, petMultiplier: 4 }],
  [3, { success: 4.5, xp: 22, petMultiplier: 5 }],
  [5, { success: 6, xp: 17.6, petMultiplier: 6 }],
]);

let core = null;
let pluginApi = null;

const isSharkId = (id) => id === core?.ItemIdentifiers?.RAW_SHARK || id === core?.ItemIdentifiers?.BIG_SHARK;
const lureIds = () => [core?.ItemIdentifiers?.SHARK_LURE, core?.ItemIdentifiers?.SHARK_LURE_2].filter((id) => id > 0);

/** The player's configured quantity (1, 3 or 5); 1 until they choose another. */
function amountOf(player) {
  const stored = Number(player?.getAttribute?.(ATTR));
  return OPTIONS.includes(stored) ? stored : DEFAULT_AMOUNT;
}

function setAmount(player, value) {
  const amount = OPTIONS.includes(Number(value)) ? Number(value) : DEFAULT_AMOUNT;
  player?.setAttribute?.(ATTR, amount);
  player?.getPacketSender?.()?.sendVarbit?.(VARBIT, amount);
  return amount;
}

function heldLures(player) {
  const inventory = player?.getInventory?.();
  let held = 0;
  for (const id of lureIds()) held += Number(inventory?.getAmount?.(id) ?? 0);
  if (held === 0 && pluginApi) {
    for (const id of lureIds()) {
      const request = { player, itemId: id, amount: 0 };
      pluginApi.emitCustomEvent("storage:amount", request);
      held += Math.max(0, Number(request.amount) || 0);
    }
  }
  return held;
}

/** The quantity in force: the configured one if enough lures are carried, else none. */
function activeAmount(player, configured = amountOf(player)) {
  return heldLures(player) >= configured ? configured : 0;
}

/** Takes lures from the inventory first, then from an open tackle box. */
function consume(player, amount) {
  let left = Math.max(0, Number(amount) || 0);
  if (left === 0) return 0;
  const inventory = player.getInventory();
  for (const id of lureIds()) {
    if (left === 0) break;
    const held = Number(inventory.getAmount?.(id) ?? 0);
    if (held <= 0) continue;
    const taken = Math.min(held, left);
    inventory.deleteNumber(id, taken);
    left -= taken;
  }
  if (left > 0 && pluginApi) {
    for (const id of lureIds()) {
      if (left === 0) break;
      const request = { player, itemId: id, amount: left, taken: 0 };
      pluginApi.emitCustomEvent("storage:take", request);
      left -= Math.max(0, Number(request.taken) || 0);
    }
  }
  return (Number(amount) || 0) - left;
}

function successMultiplier(amount) {
  return EFFECTS.get(amount)?.success ?? 1;
}

function experienceFor(amount, base) {
  return EFFECTS.get(amount)?.xp ?? base;
}

function petBaseFor(amount, base) {
  if (!(base > 0)) return base;
  return base * (EFFECTS.get(amount)?.petMultiplier ?? 1);
}

/** The next roll's ticks: the Wiki's half-tick chances on the 6-tick shark spot. */
function intervalFor(amount, base, random = Math.random) {
  if (amount === 1) return Math.max(1, random() < 0.5 ? base - 1 : base);
  if (amount === 3) return Math.max(1, base - 1);
  if (amount === 5) return Math.max(1, random() < 0.5 ? base - 2 : base - 1);
  return base;
}

const catchesSharks = (tool) => tool?.fish?.some((fish) => isSharkId(fish.id)) === true;

function configure({ player }) {
  const { DialogueChainBuilder, OptionDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new OptionDialogue(0, {
      executeOption(option) {
        player.getPacketSender().sendInterfaceRemoval();
        setAmount(player, OPTIONS[Number(option) - 1]);
      },
    }, ...OPTIONS.map(String)).setTitle(PROMPT),
  ));
  return true;
}

function attach(api) {
  core = api.core;
  pluginApi = api;
  api.persistAttribute?.(ATTR, DEFAULT_AMOUNT);
  api.onItemAction("Shark lure", { Configure: configure });
  api.onPlayerLogin?.(({ player }) => player.getPacketSender().sendVarbit(VARBIT, amountOf(player)));
  api.onCustomEvent("fishing:catch-chance", (request) => {
    if (!isSharkId(request.itemId)) return;
    const amount = activeAmount(request.player);
    if (amount) request.chance = Math.min(1, request.chance * successMultiplier(amount));
  });
  api.onCustomEvent("fishing:interval", (request) => {
    if (!catchesSharks(request.tool)) return;
    const amount = activeAmount(request.player);
    if (amount) request.ticks = intervalFor(amount, request.ticks);
  });
}

module.exports = {
  attach, configure, setAmount, amountOf, activeAmount, heldLures, consume,
  successMultiplier, experienceFor, petBaseFor, intervalFor, catchesSharks, isSharkId,
  ATTR, VARBIT, PROMPT, OPTIONS, DEFAULT_AMOUNT,
};
