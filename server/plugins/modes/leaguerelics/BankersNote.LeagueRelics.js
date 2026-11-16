/**
 * Banker's Note (https://oldschool.runescape.wiki/w/Banker's_Note_(Trailblazer_Reloaded_League)),
 * Trailblazer Reloaded's tier 3 and Raging Echoes' tier 6 relic: an item used on the banker's
 * note becomes banknotes, or a note becomes its items. Activate repeats every item used on it, in
 * the direction that item was last used (Wiki: an item must be used on it first). The cache's options:
 * - Note-Quantity and Un-note-Quantity set how many each use notes or unnotes (ours: all by
 *   default; the Wiki says only that it can be set).
 * - Toggle switches Activate between noting and unnoting that item (ours: the Wiki does not say
 *   what Toggle does).
 * Noting and unnoting stop at the inventory's room (and a stack's limit). Not here: Guardians of the Rift's essence rule (its
 * guardian essence has no note in this cache).
 */
const Common = require("./Common.LeagueRelics");
// Preset copies (PvP presets on a league world) carry no meta into notes or back: only plain copies convert.
const { plainAmount, takePlain, PRESET_TEXT } = require("../../items/PoweredStaff");

const STATE_ATTRIBUTE = "league:bankers-note";
/** note/unnote's answer when only preset copies are held. */
const PRESET_ONLY = -2;
/** A stack's limit (the client's 32-bit amount). */
const MAX_STACK = 2147483647;

let core;
let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function stateOf(player) {
  const saved = player.getAttribute(STATE_ATTRIBUTE);
  const stored = saved && typeof saved === "object" ? saved : {};
  const items = {};
  if (stored.items && typeof stored.items === "object" && !Array.isArray(stored.items)) {
    for (const [rawId, rawMode] of Object.entries(stored.items)) {
      const itemId = Number(rawId);
      if (Number.isInteger(itemId) && itemId >= 0) items[itemId] = rawMode === "unnote" ? "unnote" : "note";
    }
  }
  // Saves from before every item was remembered only kept the last one.
  if (Number.isInteger(stored.itemId) && items[stored.itemId] === undefined) {
    items[stored.itemId] = stored.mode === "unnote" ? "unnote" : "note";
  }
  return {
    itemId: Number.isInteger(stored.itemId) ? stored.itemId : null,
    mode: stored.mode === "unnote" ? "unnote" : "note",
    noteQuantity: Number.isFinite(stored.noteQuantity) ? stored.noteQuantity : null,
    unnoteQuantity: Number.isFinite(stored.unnoteQuantity) ? stored.unnoteQuantity : null,
    items,
  };
}

function save(player, changes) {
  player.setAttribute(STATE_ATTRIBUTE, { ...stateOf(player), ...changes });
}

/** Remembers the item and the direction it was used on the note. */
function remember(player, itemId, mode) {
  const state = stateOf(player);
  save(player, { itemId, mode, items: { ...state.items, [itemId]: mode } });
}

function isNote(itemId) {
  return core.ItemDefinition.forId(itemId)?.isNoted?.() === true;
}

/** The unnoted item for a note, or the item itself. */
function base(itemId) {
  return isNote(itemId) ? core.ItemDefinition.forId(itemId).getNoteId() : itemId;
}

function name(itemId) {
  return core.ItemDefinition.forId(itemId)?.getName?.() ?? "items";
}

/** How many of `itemId` the inventory takes, counting a slot that `freed` frees first. */
function room(inventory, itemId, count, freed) {
  if (core.ItemDefinition.forId(itemId)?.isStackable?.() === true) {
    if (!inventory.contains(itemId) && inventory.getFreeSlots() <= 0) {
      // A new stack in the slot the conversion frees: up to a stack's limit (getAddableAmount, asked
      // before the deletion, would see no room).
      return freed ? Math.min(count, MAX_STACK) : 0;
    }
    return Math.min(count, inventory.getAddableAmount(new core.Item(itemId, count)));
  }
  return Math.min(count, inventory.getFreeSlots() + (freed ? 1 : 0));
}

/** Notes up to `limit` of the item, as many as the inventory holds; the count noted (-1: none held). */
function note(player, itemId, limit) {
  const inventory = player.getInventory();
  const noted = Common.noted(itemId);
  if (noted === itemId || isNote(itemId)) return 0;
  const plain = plainAmount(inventory, itemId);
  if (plain <= 0 && inventory.getAmount(itemId) > 0) return PRESET_ONLY;
  const wanted = Math.min(plain, limit ?? Infinity);
  if (wanted <= 0) return -1;
  // The unnoted items leave their slots first, so the note's stack has one.
  const count = room(inventory, noted, wanted, true);
  if (count <= 0) return 0;
  takePlain(inventory, itemId, count);
  inventory.adds(noted, count);
  return count;
}

/** Unnotes up to `limit` of the note, as many as the inventory holds; the count unnoted (-1: none held). */
function unnote(player, noteId, limit) {
  const inventory = player.getInventory();
  const itemId = base(noteId);
  if (itemId === noteId) return 0;
  const held = plainAmount(inventory, noteId);
  if (held <= 0 && inventory.getAmount(noteId) > 0) return PRESET_ONLY;
  const wanted = Math.min(held, limit ?? Infinity);
  if (wanted <= 0) return -1;
  // The note's slot comes free only when the whole stack goes.
  let count = room(inventory, itemId, wanted, true);
  if (count < held) count = room(inventory, itemId, count, false);
  if (count <= 0) return 0;
  takePlain(inventory, noteId, count);
  inventory.adds(itemId, count);
  return count;
}

/** Notes or unnotes the item (its own form says which), remembering it for Activate. */
function convert(player, itemId, mode = isNote(itemId) ? "unnote" : "note", rememberItem = true) {
  const state = stateOf(player);
  const done = mode === "note" ? note(player, base(itemId), state.noteQuantity) : unnote(player, Common.noted(base(itemId)), state.unnoteQuantity);
  if (rememberItem) remember(player, base(itemId), mode);
  if (done === PRESET_ONLY) {
    player.sendMessage(PRESET_TEXT);
    return 0;
  }
  if (done > 0) player.sendMessage(Common.message(mode === "note" ? "bankersNoteNoted" : "bankersNoteUnnoted", { amount: done, item: name(base(itemId)) }));
  else if (done < 0) player.sendMessage(Common.message("bankersNoteNothing"));
  else player.getInventory().full();
  return Math.max(0, done);
}

function noteId() {
  return core.ItemIdentifiers.BANKERS_NOTE;
}

function useOn(event) {
  const { player, usedItem, usedWithItem } = event;
  const other = usedItem?.getId?.() === noteId() ? usedWithItem : usedWithItem?.getId?.() === noteId() ? usedItem : null;
  if (!other || !active(player)) return false;
  event.handled = true;
  const itemId = other.getId();
  if (Common.noted(base(itemId)) === base(itemId)) {
    player.sendMessage(Common.message("bankersNoteCannot"));
    return;
  }
  convert(player, itemId);
}

function activate({ player }) {
  if (!active(player)) return false;
  const state = stateOf(player);
  const remembered = Object.entries(state.items)
    .map(([rawId, mode]) => [Number(rawId), mode])
    .filter(([itemId]) => Number.isInteger(itemId) && itemId >= 0);
  if (remembered.length === 0) {
    player.sendMessage(Common.message("bankersNoteFirst"));
    return;
  }
  const inventory = player.getInventory();
  let converted = false;
  for (const [itemId, mode] of remembered) {
    // Preset-only stacks must reach convert for its own refusal message.
    if (inventory.getAmount(itemId) <= 0 && inventory.getAmount(Common.noted(itemId)) <= 0) continue;
    converted = true;
    convert(player, itemId, mode, false);
  }
  if (!converted) player.sendMessage(Common.message("bankersNoteNothing"));
}

function askQuantity(key, prompt) {
  return ({ player }) => {
    if (!active(player)) return false;
    player.setEnteredAmountAction({
      execute: (amount) => {
        const quantity = Math.floor(Number(amount));
        if (Number.isSafeInteger(quantity) && quantity > 0) save(player, { [key]: quantity });
      },
    });
    player.getPacketSender().sendEnterAmountPrompt(prompt);
  };
}

function toggle({ player }) {
  if (!active(player)) return false;
  const state = stateOf(player);
  const mode = state.mode === "note" ? "unnote" : "note";
  const items = Object.fromEntries(Object.entries(state.items).map(([itemId]) => [itemId, mode]));
  save(player, { mode, items });
  player.sendMessage(Common.message(mode === "note" ? "bankersNoteToggleNote" : "bankersNoteToggleUnnote"));
}

module.exports = function attach(api) {
  core = api.core;
  effect = Common.data.effects.bankersNote;
  api.persistAttribute(STATE_ATTRIBUTE, {});
  api.onItemOnItem(useOn);
  api.onItemAction(effect.toolName, {
    Activate: activate,
    "Note-Quantity": askQuantity("noteQuantity", "How many would you like to note each time?"),
    "Un-note-Quantity": askQuantity("unnoteQuantity", "How many would you like to unnote each time?"),
    Toggle: toggle,
  });
};

module.exports.STATE_ATTRIBUTE = STATE_ATTRIBUTE;
