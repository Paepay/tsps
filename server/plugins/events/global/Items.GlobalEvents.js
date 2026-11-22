"use strict";

/**
 * Temporary Global Event items (Paepay/tsps#65).
 *
 * A temporary copy is an ordinary item carrying a binding in its metadata:
 *
 *   { kind, eventId, instanceId, account, worldId, catalog }
 *
 * Arsenal loans use the real weapon/tool id with that binding, so every weapon keeps its
 * normal PvM mechanics (scythe sweeps, twisted bow scaling, shadow multiplier). The two
 * purpose-made items (Banker's note (e), Sage's greaves (e)) use dedicated custom ids in the
 * catalog, separate from the league relics they resemble.
 *
 * Every movement path is vetoed here: trade offers, bank deposits, shop sales, alchemy,
 * GE listings, drops, deaths and item-on-item transformations. `valid()` gates use on
 * login and on every action. Purging deliberately ignores the combat lock: an expired
 * event's items must go even if the player is fighting.
 */

const Common = require("./Common.GlobalEvents");

const BINDING_META = "global-event";
const LAST_COMBAT_ATTRIBUTE = "global-events:last-combat";
const COMBAT_LOCK_MS = Number(Common.config().combatLock?.postCombatSeconds ?? 10) * 1000;

const KIND = Object.freeze({ NOTE: "bankers-note", GREAVES: "sages-greaves", ARSENAL: "arsenal" });
const EVENT_FOR_KIND = Object.freeze({
  [KIND.NOTE]: "bankers-note",
  [KIND.GREAVES]: "trickster",
  [KIND.ARSENAL]: "masters-arsenal",
});
const ACTIONS_BLOCKED_WHEN_DISABLED = new Set(["Wear", "Wield", "Use", "Activate", "Check", "Toggle", "Revert"]);
const CUSTOM_ITEM_ID_MIN = 50000;
const CUSTOM_ITEM_ID_MAX = 65022;
const EVENT_ITEMS = Object.freeze([
  { key: "bankersNoteId", label: "Banker's note", relic: "BANKERS_NOTE" },
  { key: "sagesGreavesId", label: "Sage's greaves", relic: "SAGES_GREAVES" },
]);

let api;
let core;
const runWatches = new WeakMap();

function itemsConfig() {
  return Common.config().items ?? {};
}

function noteId() {
  return itemsConfig().bankersNoteId;
}

function greavesId() {
  return itemsConfig().sagesGreavesId;
}

function arsenalRows() {
  return Array.isArray(itemsConfig().arsenal) ? itemsConfig().arsenal : [];
}

function arsenalRow(key) {
  return arsenalRows().find((row) => row.key === key) ?? null;
}

function eventOfKind(kind) {
  return EVENT_FOR_KIND[kind] ?? null;
}

function bindingOf(item) {
  const binding = item?.getMetaValue?.(BINDING_META);
  return binding && typeof binding === "object" ? binding : null;
}

function isTemporary(item) {
  return bindingOf(item) !== null;
}

function isTemporaryId(itemId) {
  return itemId === noteId() || itemId === greavesId()
    || arsenalRows().some((row) => row.itemId === itemId || row.eventItemId === itemId);
}

/**
 * The contract's stable temporary-item id. It is always >= 1,000,000 and is recorded in the
 * binding; the 317 wire protocol still carries a 16-bit item id, so `itemId` stays a real or
 * cache-safe id (see docs/global-events.md).
 */
function eventItemIdOf(kind, catalog = null) {
  if (kind === KIND.NOTE) return Number(itemsConfig().bankersNoteEventItemId);
  if (kind === KIND.GREAVES) return Number(itemsConfig().sagesGreavesEventItemId);
  if (kind === KIND.ARSENAL) return Number(arsenalRow(catalog)?.eventItemId);
  return null;
}

function catalogEventItemIds() {
  return [
    eventItemIdOf(KIND.NOTE),
    eventItemIdOf(KIND.GREAVES),
    ...arsenalRows().map((row) => Number(row.eventItemId)),
  ];
}

/** Fail the plugin load rather than grant two event items that claim the same contract id. */
function validateEventItemIds() {
  const start = Number(itemsConfig().eventItemIdStart ?? 1_000_000);
  const ids = catalogEventItemIds();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < start) {
      throw new Error(`GlobalEvents: every temporary item needs an eventItemId >= ${start}`);
    }
  }
  if (new Set(ids).size !== ids.length) {
    throw new Error("GlobalEvents: eventItemId values must be unique");
  }
  return ids;
}

/**
 * The event's two purpose-made items must be their own custom items. Reusing a league relic id
 * makes this plugin intercept the relic's item-on-item use and report the event copy as expired.
 */
function validateItemIds(items = itemsConfig()) {
  const ids = [];
  for (const { key, label, relic } of EVENT_ITEMS) {
    const id = items[key];
    if (id === core.ItemIdentifiers[relic]) {
      throw new Error(`GlobalEvents: ${label} must not reuse the league relic id ${id}; use a dedicated custom item`);
    }
    if (!Number.isInteger(id) || id < CUSTOM_ITEM_ID_MIN || id > CUSTOM_ITEM_ID_MAX) {
      throw new Error(`GlobalEvents: ${label} must use a dedicated custom item id in ${CUSTOM_ITEM_ID_MIN}..${CUSTOM_ITEM_ID_MAX}, not ${String(id)}`);
    }
    ids.push([label, id]);
  }
  if (ids[0][1] === ids[1][1]) {
    throw new Error("GlobalEvents: Banker's note and Sage's greaves need distinct item ids");
  }
  const arsenalIds = new Set((Array.isArray(items.arsenal) ? items.arsenal : [])
    .map((row) => row?.itemId)
    .filter(Number.isInteger));
  for (const [label, id] of ids) {
    if (arsenalIds.has(id)) {
      throw new Error(`GlobalEvents: ${label} must not reuse a Master's Arsenal loan id ${id}`);
    }
  }
  return ids.map(([, id]) => id);
}

function bind(item, player, eventId, kind, extra = {}) {
  const eventItemId = eventItemIdOf(kind, extra.catalog ?? null);
  item.setMetaValue(BINDING_META, {
    kind,
    eventId,
    eventItemId,
    instanceId: Common.instanceOf(eventId),
    account: Common.accountOf(player),
    worldId: Common.worldId(),
    ...extra,
  });
  if (kind === KIND.ARSENAL) {
    // The real weapon stays a real weapon; only this copy is barred from leaving the account.
    item.setMetaValue(core.Item.UNTRADEABLE_META, true);
    item.setMetaValue(core.Item.UNBANKABLE_META, true);
  }
  return item;
}

/** Whether this exact copy still belongs here and its event instance is live. */
function valid(player, item) {
  const binding = bindingOf(item);
  if (!binding) return false;
  // A bound copy always carries one of the configured item ids. An old copy left behind by a
  // catalog change (such as the Banker's note id migration) is stale and is purged on login.
  if (!isTemporaryId(item.getId?.())) return false;
  if (binding.account !== Common.accountOf(player)) return false;
  if (binding.worldId !== Common.worldId()) return false;
  return Common.liveInstance(binding.eventId, binding.instanceId) !== null;
}

/** Validity plus the player's Enable Effects choice; powers use this, cleanup does not. */
function usable(player, item) {
  return valid(player, item) && Common.effectsEnabled(player, bindingOf(item).eventId);
}

function temporaryIn(container, predicate = () => true) {
  return (container?.getItems?.() ?? []).filter((item) => item && item.getId() > 0 && isTemporary(item) && predicate(item));
}

function allContainers(player) {
  return [player.getInventory(), player.getEquipment(), ...(player.getBanks?.() ?? [])].filter(Boolean);
}

function holdsKind(player, kind) {
  const predicate = (item) => bindingOf(item)?.kind === kind;
  return allContainers(player).some((container) => temporaryIn(container, predicate).length > 0);
}

function equippedArsenal(player) {
  return temporaryIn(player.getEquipment(), (item) => bindingOf(item)?.kind === KIND.ARSENAL)
    .find((item) => usable(player, item)) ?? null;
}

/** True while the player wears a valid, enabled Master's Arsenal loan. */
function hasArsenalLoan(player) {
  return equippedArsenal(player) !== null;
}

/**
 * No event affects PvP. A borrowed Best-in-Slot weapon keeps its PvM behaviour but deals no
 * player-versus-player damage, matching the contract's `pvp: false` loadout.
 */
function suppressPvpDamage(event) {
  if (!event || event.target?.isPlayer?.() !== true) return;
  const player = event.attacker?.getAsPlayer?.() ?? (event.attacker?.isPlayer?.() ? event.attacker : null);
  if (!player) return;
  // Suppress for any live loan, including one the player has opted out of: an event item must
  // never become a PvP advantage just because its PvM powers were switched off.
  const loan = temporaryIn(player.getEquipment?.(), (item) =>
    bindingOf(item)?.kind === KIND.ARSENAL && valid(player, item))[0];
  if (!loan) return;
  event.damage?.setDamage?.(0);
}

/** The bound, enabled Arsenal copy this player is wielding, if any. */
function equippedLoanOf(player, itemId = null) {
  return temporaryIn(player?.getEquipment?.(), (item) =>
    bindingOf(item)?.kind === KIND.ARSENAL && (itemId === null || item.getId() === itemId) && usable(player, item))[0] ?? null;
}

/** The bound, enabled Arsenal copy this player is carrying or wielding. */
function loanOf(player, itemId = null) {
  return allContainers(player).flatMap((container) => temporaryIn(container, (item) =>
    bindingOf(item)?.kind === KIND.ARSENAL && (itemId === null || item.getId() === itemId) && usable(player, item)))[0] ?? null;
}

/* ----------------------------------------------------------- combat lock --- */

function noteCombatTick(player) {
  if (!player || !api.getCombatFactory().inCombat(player)) return;
  player.setAttribute(LAST_COMBAT_ATTRIBUTE, Date.now());
}

function inCombatLock(player) {
  if (api.getCombatFactory().inCombat(player)) return true;
  const last = Number(player.getAttribute(LAST_COMBAT_ATTRIBUTE)) || 0;
  return Date.now() - last < COMBAT_LOCK_MS;
}

function refuseCombat(player) {
  player.sendMessage(Common.message("combatLock"));
  return true;
}

/* --------------------------------------------------------------- removal --- */

function removeFrom(container, item) {
  if (!container) return false;
  const slot = container.getItems().indexOf(item);
  if (slot < 0) return false;
  container.deleteItem(item, slot);
  container.refreshItems?.();
  return true;
}

function removeItem(player, item) {
  const inventory = player.getInventory();
  const equipment = player.getEquipment();
  if (removeFrom(inventory, item)) return true;
  for (const bank of player.getBanks?.() ?? []) {
    if (removeFrom(bank, item)) return true;
  }
  if (removeFrom(equipment, item)) {
    core.BonusManager.update(player);
    player.getUpdateFlag()?.flag?.(core.Flag.APPEARANCE);
    return true;
  }
  return false;
}

/**
 * Remove every copy that fails `keep`, from anything that can hold items. `announce` sends
 * one line when anything went. Never consults the combat lock: expiry must work mid-fight.
 */
function purge(player, keep, announce = true) {
  let removed = 0;
  for (const container of allContainers(player)) {
    for (const item of temporaryIn(container)) {
      if (keep(player, item)) continue;
      if (removeFrom(container, item)) removed++;
    }
  }
  if (removed > 0 && player.getEquipment && !player.getEquipment().getItems().some((held) => held?.getId?.() === 0)) {
    // Equipment refresh already happened through removeFrom; no extra work.
  }
  if (removed > 0 && announce) player.sendMessage(Common.message("expired"));
  return removed;
}

function purgeInvalid(player) {
  return purge(player, (owner, item) => valid(owner, item));
}

function purgeEvent(category, slot) {
  if (!slot) return 0;
  let removed = 0;
  for (const player of api.core.World.getPlayers()) {
    const playerRemoved = purge(player, (owner, item) => {
      const binding = bindingOf(item);
      return binding?.eventId !== slot.eventId || binding?.instanceId !== slot.instanceId;
    }, false);
    if (playerRemoved > 0) player.sendMessage(Common.message("expired"));
    removed += playerRemoved;
  }
  return removed;
}

/* ---------------------------------------------------------------- claims --- */

/**
 * Create a bound copy. `inventory.add(item, true)` (rather than `adds(id, amount)`) is
 * deliberate: the binding is on the Item instance, and adds() would create a new one.
 */
function grant(player, itemId, kind, catalog = null, amount = 1) {
  const inventory = player.getInventory();
  const item = new core.Item(itemId, amount);
  if (inventory.getAddableAmount(item) < amount || inventory.getFreeSlots() <= 0) {
    player.sendMessage(Common.message("noRoom"));
    return null;
  }
  bind(item, player, eventOfKind(kind), kind, catalog ? { catalog } : {});
  inventory.add(item, true);
  // Charged weapons arrive ready to use; the same event PvP load-outs ask.
  if (kind === KIND.ARSENAL) api.emitCustomEvent("item:fill-charges", { player, item, handled: false });
  return item;
}

function claimNote(player) {
  if (holdsKind(player, KIND.NOTE)) {
    player.sendMessage(Common.message("claimOnce"));
    return false;
  }
  return grant(player, noteId(), KIND.NOTE) !== null;
}

function claimGreaves(player) {
  if (holdsKind(player, KIND.GREAVES)) {
    player.sendMessage(Common.message("claimOnce"));
    return false;
  }
  return grant(player, greavesId(), KIND.GREAVES) !== null;
}

function claimArsenal(player, catalogKey) {
  const row = arsenalRow(catalogKey);
  if (!row) {
    player.sendMessage(Common.message("claimArsenal"));
    return false;
  }
  // One loan at a time: the previous copy goes before the new one arrives.
  const held = allContainers(player).flatMap((container) =>
    temporaryIn(container, (item) => bindingOf(item)?.kind === KIND.ARSENAL));
  for (const item of held) removeItem(player, item);
  return grant(player, row.itemId, KIND.ARSENAL, row.key) !== null;
}

/**
 * Claim through the Events UI only. The caller must have the owning event active and the
 * player's Enable Effects on; this re-checks both plus the combat lock.
 */
function claim(player, kind, catalogKey = null) {
  const eventId = eventOfKind(kind);
  if (!Common.activeByEventId(eventId)) {
    player.sendMessage(Common.message("claimNotActive"));
    return false;
  }
  if (!Common.effectsEnabled(player, eventId)) {
    player.sendMessage(Common.message("claimDisabled"));
    return false;
  }
  if (inCombatLock(player)) {
    refuseCombat(player);
    return false;
  }
  if (kind === KIND.NOTE) return claimNote(player);
  if (kind === KIND.GREAVES) return claimGreaves(player);
  if (kind === KIND.ARSENAL) return claimArsenal(player, catalogKey);
  return false;
}

/* ------------------------------------------------------------- Banker's note --- */

function definitionOf(itemId) {
  return core.ItemDefinition.forId(itemId);
}

function baseOf(itemId) {
  const definition = definitionOf(itemId);
  return definition?.isNoted?.() ? definition.getNoteId() : itemId;
}

function notedOf(itemId) {
  const definition = definitionOf(baseOf(itemId));
  const note = definition?.getNoteId?.() ?? -1;
  return note > 0 ? note : null;
}

function noteOnItem(event) {
  const { player, usedItem, usedWithItem } = event;
  const note = usedItem?.getId?.() === noteId() ? usedItem : usedWithItem?.getId?.() === noteId() ? usedWithItem : null;
  if (!note) return false;
  // Only the bound event copy is ours. A real Banker's note (or any plain item using this id)
  // must fall through to the league relic handler.
  const binding = bindingOf(note);
  if (!binding || binding.kind !== KIND.NOTE) return false;
  if (!usable(player, note)) {
    player.sendMessage(Common.message("disabled"));
    event.handled = true;
    return true;
  }
  const other = usedItem === note ? usedWithItem : usedItem;
  const itemId = other?.getId?.();
  if (!itemId || itemId <= 0 || isTemporaryId(itemId)) {
    event.handled = true;
    return true;
  }
  event.handled = true;
  convert(player, itemId);
  return true;
}

/** Note an un-noted stack or un-note a noted one, all of what is carried and fits. */
function convert(player, itemId) {
  const inventory = player.getInventory();
  const base = baseOf(itemId);
  const note = notedOf(base);
  if (!note) {
    player.sendMessage("That item can't be noted.");
    return 0;
  }
  const held = inventory.getAmount(itemId);
  if (held <= 0) return 0;
  if (itemId === base) {
    const stack = new core.Item(note, held);
    if (!inventory.contains(note) && inventory.getAddableAmount(stack) < held) {
      inventory.full();
      return 0;
    }
    inventory.deleteNumber(base, held);
    inventory.adds(note, held);
    inventory.refreshItems();
    return held;
  }
  let count = held;
  if (definitionOf(base)?.isStackable?.() !== true) {
    count = Math.min(count, inventory.getFreeSlots() + 1);
  }
  if (count <= 0) {
    inventory.full();
    return 0;
  }
  inventory.deleteNumber(note, count);
  inventory.adds(base, count);
  inventory.refreshItems();
  return count;
}

/* ------------------------------------------------------ Sage's greaves running --- */

function runWatch(player) {
  let watch = runWatches.get(player);
  if (!watch) {
    watch = { last: null, ticks: 0 };
    runWatches.set(player, watch);
  }
  return watch;
}

function wearsGreaves(player) {
  return temporaryIn(player.getEquipment(), (item) => bindingOf(item)?.kind === KIND.GREAVES)
    .some((item) => usable(player, item));
}

/** One processed tick of the borrowed greaves: the same shape as the league relic's run XP. */
function greavesTick({ player }) {
  noteCombatTick(player);
  const watch = runWatch(player);
  const here = player.getLocation();
  const config = Common.definition("trickster")?.config ?? {};
  const moved = watch.last && watch.last.getZ() === here.getZ()
    && Math.max(Math.abs(here.getX() - watch.last.getX()), Math.abs(here.getY() - watch.last.getY()))
      === Number(config.runStepTiles ?? 2);
  watch.last = here.clone();
  // Movement counts even while the item is off; only a wearing, enabled owner is paid.
  if (!moved || !wearsGreaves(player)) return;
  if (++watch.ticks < Number(config.runXpTicks ?? 10)) return;
  watch.ticks = 0;
  const level = player.getSkillManager().getMaxLevel(core.Skill.AGILITY);
  const [numerator, denominator] = config.runXpLevelFraction ?? [2, 3];
  player.getSkillManager().addExperiences(core.Skill.AGILITY,
    Number(config.runXpBase ?? 10) + Math.floor((level * numerator) / denominator));
}

/* -------------------------------------------------------------- deletion --- */

function confirmDelete(player, item) {
  if (inCombatLock(player)) {
    refuseCombat(player);
    return;
  }
  const name = definitionOf(item.getId())?.getName?.() ?? "item";
  const { DialogueChainBuilder, OptionDialogue } = core;
  player.getDialogueManager().startDialogues(new DialogueChainBuilder().add(
    new OptionDialogue(0, {
      executeOption(option) {
        player.getPacketSender().sendInterfaceRemoval();
        if (Number(option) !== 1) return;
        if (inCombatLock(player)) {
          refuseCombat(player);
          return;
        }
        if (removeItem(player, item)) {
          player.sendMessage(`You delete the borrowed ${name}.`);
          api.emitCustomEvent("global-events:item-deleted", { player, item });
        }
      },
    }, `Yes, delete my ${name}.`, "No, keep it.").setTitle(Common.message("deleteTitle")),
  ));
}

function itemAction(event) {
  const { player, item, option } = event;
  if (!isTemporary(item)) return false;
  if (!valid(player, item)) {
    removeItem(player, item);
    player.sendMessage(Common.message("expired"));
    event.handled = true;
    return true;
  }
  if (option === "Delete" || option === "Drop" || option === "Destroy") {
    confirmDelete(player, item);
    event.handled = true;
    return true;
  }
  if (ACTIONS_BLOCKED_WHEN_DISABLED.has(option) && !usable(player, item)) {
    player.sendMessage(Common.message("disabled"));
    event.handled = true;
    return true;
  }
  return false;
}

function dropPolicy(event) {
  if (!isTemporary(event.item)) return;
  event.dropToGround = false;
  event.handled = true;
  confirmDelete(event.player, event.item);
}

/* ------------------------------------------------------------------ hooks --- */

function onCanUseItem(event) {
  if (event.action !== "action") return;
  if (!isTemporaryId(event.itemId)) return;
  const item = event.player.getInventory().getItems().find((held) => held?.getId?.() === event.itemId && isTemporary(held));
  if (!item) return;
  if (!valid(event.player, item)) {
    event.allow = false;
    removeItem(event.player, item);
    return;
  }
  // A valid copy whose event the player switched off keeps its item but loses its powers.
  if (!usable(event.player, item)) event.allow = false;
}

function onCanEquip(event) {
  const { player, item } = event;
  if (!isTemporary(item)) return;
  if (!valid(player, item)) {
    event.allow = false;
    removeItem(player, item);
    player.sendMessage(Common.message("expired"));
    return;
  }
  if (!usable(player, item)) {
    event.allow = false;
    player.sendMessage(Common.message("disabled"));
  }
}

/**
 * Master's Arsenal loans skip the item's own equipment level and combat gates, as the event
 * contract says. Quest, resource and activity checks stay where they are. Only a bound, live,
 * enabled copy qualifies, so a real item with the same id still needs its levels.
 */
function onEquipmentRequirement(event) {
  if (!event?.player || !isTemporary(event.item)) return;
  if (bindingOf(event.item)?.kind !== KIND.ARSENAL) return;
  if (!usable(event.player, event.item)) return;
  event.waived = true;
}

function canBank(event) {
  if (!isTemporary(event.item)) return;
  event.allow = false;
  if (!event.quiet) event.player.sendMessage("Temporary event items can't be banked.");
}

function canTradeItem(request) {
  if (!isTemporary(request.item)) return;
  request.allowed = false;
}

function canSell(request) {
  if (request.sellable !== true) return;
  const held = temporaryIn(request.player?.getInventory?.()).find((item) => item.getId() === request.itemId);
  if (held) request.sellable = false;
}

function alchemy(policy) {
  if (policy.allowed !== true) return;
  const held = temporaryIn(policy.player?.getInventory?.()).find((item) => item.getId() === policy.itemId);
  if (held) {
    policy.allowed = false;
    policy.coins = 0;
  }
}

function geOffer(confirmation) {
  if (confirmation.sell !== true) return;
  const held = allContainers(confirmation.player).some((container) =>
    temporaryIn(container, (item) => item.getId() === confirmation.itemId).length > 0);
  if (held) {
    confirmation.accepted = false;
    confirmation.player.sendMessage("Temporary event items can't be sold on the Grand Exchange.");
  }
}

function blockTransform(event) {
  if (event.handled) return true;
  if (isTemporary(event.usedItem) || isTemporary(event.usedWithItem)) {
    event.handled = true;
    event.player.sendMessage("Temporary event items can't be transformed.");
    return true;
  }
  return false;
}

function keepOnDeath(event) {
  if (isTemporary(event.item)) event.keep = true;
}

function suppressDeathDrop(event) {
  if (!isTemporary(event.item)) return;
  event.suppressDefaultDrop = true;
  event.kept = true;
}

/** "combat:consume-charge" / "skilling:consume-charge": spare a bound Arsenal copy's charge. */
function skipCharge(event) {
  if (!event || event.skip === true) return;
  const equipped = equippedLoanOf(event.player, event.itemId);
  if (equipped) {
    event.skip = true;
    return;
  }
  // Skilling tools may be carried rather than wielded, and name the item itself.
  const item = event.item ?? null;
  if (item && bindingOf(item)?.kind === KIND.ARSENAL && usable(event.player, item)) event.skip = true;
}

/** "ranged:ammo-saving": a borrowed bow keeps its wielder's ammunition. */
function saveAmmo(event) {
  if (!event || !(event.amount > 0)) return;
  const weapon = equippedLoanOf(event.player);
  if (weapon) event.saved = Math.max(Number(event.saved) || 0, event.amount);
}

/** "magic:rune-saving": a cast made with a borrowed weapon keeps every rune it would spend. */
function saveRunes(event) {
  if (!event || event.saved === true) return;
  if (equippedLoanOf(event.player)) event.saved = true;
}

/** The Arsenal catalog keys this player currently holds a bound copy of. */
function heldArsenalKeys(player) {
  return new Set(allContainers(player).flatMap((container) =>
    temporaryIn(container, (item) => bindingOf(item)?.kind === KIND.ARSENAL)
      .map((item) => bindingOf(item)?.catalog)
      .filter(Boolean)));
}

/** The claimable rows for this player: the note, the greaves, and every Arsenal loan. */
function claimables(player) {
  const rows = [];
  if (Common.activeByEventId("bankers-note")) {
    rows.push({ key: "note", kind: KIND.NOTE, name: "Banker's note (e)", eventId: "bankers-note", iconItemId: noteId(), held: holdsKind(player, KIND.NOTE) });
  }
  if (Common.activeByEventId("trickster")) {
    rows.push({ key: "greaves", kind: KIND.GREAVES, name: "Sage's greaves (e)", eventId: "trickster", iconItemId: greavesId(), held: holdsKind(player, KIND.GREAVES) });
  }
  if (Common.activeByEventId("masters-arsenal")) {
    const held = heldArsenalKeys(player);
    for (const row of arsenalRows()) {
      rows.push({ key: row.key, kind: KIND.ARSENAL, name: row.name, eventId: "masters-arsenal", catalog: row.key, itemId: row.itemId, iconItemId: row.itemId, held: held.has(row.key) });
    }
  }
  return rows;
}

function login({ player }) {
  purgeInvalid(player);
}

function ended({ category, slot }) {
  purgeEvent(category, slot);
}

function attach(pluginApi) {
  api = pluginApi;
  core = api.core;
  validateEventItemIds();
  validateItemIds();
  Common.setClaimablesProvider(claimables);
  api.persistAttribute(LAST_COMBAT_ATTRIBUTE, 0);
  api.onPlayerProcess(greavesTick);
  api.onPlayerLogin(login);
  api.onItemOnItem(noteOnItem);
  api.onItemOnItem(blockTransform);
  api.onItemAction(itemAction);
  api.onItemDropPolicy(dropPolicy);
  api.onCanUseItem(onCanUseItem);
  api.onCanEquip(onCanEquip);
  api.onCustomEvent("equipment:requirement", onEquipmentRequirement);
  api.onCombatHitDamage(suppressPvpDamage);
  api.onCanBankItem(canBank);
  api.onCustomEvent("trade:item-eligibility", canTradeItem);
  api.onCustomEvent("shop:can-sell", canSell);
  api.onCustomEvent("magic:alchemy-policy", alchemy);
  api.onCustomEvent("ge:offer-confirmed", geOffer);
  api.onShouldKeepItemOnDeath(keepOnDeath);
  api.onPlayerDeathItemDrop(suppressDeathDrop);
  // A borrowed weapon or tool never spends a charge, an arrow or a rune. Each copy is bound,
  // so a real item of the same id in the same account keeps paying its own way.
  api.onCustomEvent("combat:consume-charge", skipCharge);
  api.onCustomEvent("skilling:consume-charge", skipCharge);
  api.onCustomEvent("ranged:ammo-saving", saveAmmo);
  api.onCustomEvent("magic:rune-saving", saveRunes);
  api.onCustomEvent("global-events:ended", ended);
  api.onCustomEvent("global-events:preference-changed", ({ player }) => purgeInvalid(player));
}

module.exports = {
  attach,
  BINDING_META,
  KIND,
  noteId,
  greavesId,
  arsenalRows,
  arsenalRow,
  eventItemIdOf,
  catalogEventItemIds,
  validateItemIds,
  bindingOf,
  isTemporary,
  isTemporaryId,
  valid,
  usable,
  onEquipmentRequirement,
  hasArsenalLoan,
  equippedArsenal,
  equippedLoanOf,
  loanOf,
  claimables,
  holdsKind,
  inCombatLock,
  claim,
  convert,
  removeItem,
  purgeInvalid,
  purgeEvent,
  testing: { bindingOf, isTemporary, valid, usable, claim, convert, removeItem, validateItemIds },
};
