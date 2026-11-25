// Run after `yarn build`: node --test tests/global-events-items.test.cjs
// Paepay/tsps#65: temporary event items are bound to account, world and instance; they cannot
// leave the account; they are purged on expiry/login; claims obey the event, the player's toggle
// and the combat lock; Master's Arsenal loans waive levels and keep charges, ammo and runes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Location } = require("../dist/game/model/Location");

const Common = require("../plugins/events/global/Common.GlobalEvents");
const Items = require("../plugins/events/global/Items.GlobalEvents");

let core;
let store;
const custom = new Map();
const hooks = {};

function on(name, handler) {
  if (!custom.has(name)) custom.set(name, []);
  custom.get(name).push(handler);
}

function emit(name, event) {
  for (const handler of custom.get(name) ?? []) handler(event);
  return event;
}

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PluginManager.getCoreApi();
  require("../plugins/items/ItemDefinitionLoader.plugin").register({ log() {}, onPlayerLogin() {}, registerContentEndpoint() {} });
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
  const api = new Proxy({
    core,
    persistAttribute() {},
    getCombatFactory: () => ({ inCombat: () => false }),
    onPlayerProcess: (handler) => { hooks.process = handler; },
    onPlayerLogin: (handler) => { (hooks.logins ??= []).push(handler); },
    onItemOnItem: (handler) => {
      (hooks.itemOnItems ??= []).push(handler);
      hooks.itemOnItem = (event) => {
        for (const hook of hooks.itemOnItems) hook(event);
        return event.handled === true;
      };
    },
    onItemAction: (handler) => { hooks.itemAction = handler; },
    onItemDropPolicy: (handler) => { hooks.dropPolicy = handler; },
    onCanUseItem: (handler) => { hooks.canUse = handler; },
    onCanEquip: (handler) => { hooks.canEquip = handler; },
    onCanBankItem: (handler) => { hooks.canBank = handler; },
    onShouldKeepItemOnDeath: (handler) => { hooks.keepOnDeath = handler; },
    onPlayerDeathItemDrop: (handler) => { hooks.deathDrop = handler; },
    onCombatHitDamage: (handler) => { hooks.hitDamage = handler; },
    onCustomEvent: on,
    emitCustomEvent: emit,
  }, { get: (target, key) => (key in target ? target[key] : () => {}) });
  Items.attach(api);
  Common.init(api);
});

function activate(eventId, minutes = 30) {
  const startedAt = Date.now();
  return Common.activate(eventId, { actor: "tester", startedAt, endsAt: startedAt + minutes * 60_000 });
}

function player(name = "borrower") {
  const p = new Player(null);
  p.setUsername(name);
  p.setLocation(new Location(3200, 3200, 0));
  p.setRegistered(true);
  const sender = new Proxy({}, { get: () => () => sender });
  p.getPacketSender = () => sender;
  p.getDialogueManager = () => ({ startDialogues() {} });
  return p;
}

/** Put a bound copy in the equipment slot without reusing the inventory object (deleteItem mutates it). */
function equip(p, item, slot = 0) {
  const copy = new core.Item(item.getId(), 1);
  copy.setMetaValue(Items.BINDING_META, Items.bindingOf(item));
  p.getEquipment().set(slot, copy);
  return copy;
}

function held(p, itemId) {
  return p.getInventory().getItems().find((item) => item && item.getId() === itemId) ?? null;
}

function claim(p, kind, catalog = null) {
  return Items.claim(p, kind, catalog);
}

test("event item-on-item handlers leave a real Banker's note to the league relic", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("real-note");
  p.getInventory().adds(core.ItemIdentifiers.BANKERS_NOTE, 1);
  p.getInventory().adds(core.ItemIdentifiers.LOGS, 3);
  const note = held(p, core.ItemIdentifiers.BANKERS_NOTE);
  const logs = held(p, core.ItemIdentifiers.LOGS);
  const event = { player: p, usedItem: note, usedWithItem: logs, handled: false };
  for (const handler of hooks.itemOnItems) {
    const result = handler(event);
    assert.notEqual(result, true, `${handler.name} swallowed the real note`);
    assert.equal(event.handled, false, `${handler.name} marked the real note handled`);
  }
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.BANKERS_NOTE), 1);
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 3);
});

test("event items use dedicated custom ids and never shadow the league relics", () => {
  assert.equal(Items.noteId(), 50006);
  assert.equal(Items.greavesId(), 50007);
  assert.notEqual(Items.noteId(), core.ItemIdentifiers.BANKERS_NOTE);
  assert.notEqual(Items.greavesId(), core.ItemIdentifiers.SAGES_GREAVES);
  assert.equal(Items.isTemporaryId(core.ItemIdentifiers.BANKERS_NOTE), false);
  assert.equal(Items.isTemporaryId(core.ItemIdentifiers.SAGES_GREAVES), false);

  const note = core.ItemDefinition.forId(Items.noteId());
  assert.equal(note.getName(), "Banker's note (e)");
  assert.equal(note.isNoted(), false);
  assert.equal(note.getNoteId(), -1);
  const greaves = core.ItemDefinition.forId(Items.greavesId());
  assert.equal(greaves.getName(), "Sage's greaves (e)");
  assert.equal(greaves.getEquipmentType().getSlot(), core.Equipment.FEET_SLOT);
  assert.equal(core.ItemDefinition.forId(core.ItemIdentifiers.BANKERS_NOTE).getName(), "Banker's note");
  assert.equal(core.ItemDefinition.forId(core.ItemIdentifiers.SAGES_GREAVES).getName(), "Sage's greaves");

  assert.deepEqual(
    Items.testing.validateItemIds({ bankersNoteId: Items.noteId(), sagesGreavesId: Items.greavesId(), arsenal: Items.arsenalRows() }),
    [50006, 50007],
  );
  assert.deepEqual(
    [Common.definition("bankers-note").iconItemId, Common.definition("trickster").iconItemId],
    [Items.noteId(), Items.greavesId()],
    "the catalog icons are the dedicated event items",
  );
});

test("a bound copy left on a real item id is migrated back to that item, not deleted", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("legacy-note");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const live = held(p, Items.noteId());
  const legacy = new core.Item(core.ItemIdentifiers.BANKERS_NOTE, 1);
  legacy.setMetaValue(Items.BINDING_META, Items.bindingOf(live));
  p.getInventory().add(legacy, true);
  assert.equal(Items.valid(p, legacy), false, "the old id is no longer an event item");
  assert.equal(Items.purgeInvalid(p), 0, "a real relic must not be deleted as an expired event item");
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.BANKERS_NOTE), 1);
  const carried = held(p, core.ItemIdentifiers.BANKERS_NOTE);
  assert.equal(Items.bindingOf(carried), null, "the stale event binding is stripped");
  assert.equal(Items.isTemporary(carried), false);
  assert.equal(p.getInventory().getAmount(Items.noteId()), 1, "the live copy stays");
});

test("item-on-item on a legacy real note migrates it and leaves it to the league relic", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("legacy-note-use");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const live = held(p, Items.noteId());
  const legacy = new core.Item(core.ItemIdentifiers.BANKERS_NOTE, 1);
  legacy.setMetaValue(Items.BINDING_META, Items.bindingOf(live));
  p.getInventory().add(legacy, true);
  p.getInventory().adds(core.ItemIdentifiers.LOGS, 2);
  const remains = held(p, core.ItemIdentifiers.LOGS);
  const event = { player: p, usedItem: legacy, usedWithItem: remains, handled: false };
  for (const handler of hooks.itemOnItems) handler(event);
  assert.equal(event.handled, false, "the event does not swallow the real relic's use");
  assert.equal(Items.bindingOf(legacy), null, "the stale binding is stripped, not expired");
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.BANKERS_NOTE), 1);
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 2);
});

test("load validation names a league-relic collision instead of shadowing it", () => {
  assert.throws(
    () => Items.testing.validateItemIds({ bankersNoteId: core.ItemIdentifiers.BANKERS_NOTE, sagesGreavesId: 50007, arsenal: [] }),
    /Banker's note must not reuse the league relic id 28767/,
  );
  assert.throws(
    () => Items.testing.validateItemIds({ bankersNoteId: 50006, sagesGreavesId: core.ItemIdentifiers.SAGES_GREAVES, arsenal: [] }),
    /Sage's greaves must not reuse the league relic id 50001/,
  );
  assert.throws(
    () => Items.testing.validateItemIds({ bankersNoteId: 50006, sagesGreavesId: 50006, arsenal: [] }),
    /need distinct item ids/,
  );
  assert.throws(
    () => Items.testing.validateItemIds({ bankersNoteId: 28768, sagesGreavesId: 50007, arsenal: [] }),
    /dedicated custom item id in 50000..65022/,
  );
});

test("a claimed Banker's note is bound to the account, world and event instance", () => {
  Common.testing.reset();
  const started = activate("bankers-note");
  const p = player();
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());
  assert.ok(note, "the note is in the inventory");
  const binding = Items.bindingOf(note);
  assert.deepEqual(
    { kind: binding.kind, eventId: binding.eventId, instanceId: binding.instanceId, account: binding.account },
    { kind: Items.KIND.NOTE, eventId: "bankers-note", instanceId: started.slot.instanceId, account: "borrower" },
  );
  assert.equal(binding.worldId, Common.worldId());
  assert.equal(binding.eventItemId, 1000001, "the binding records the 1,000,000+ contract id");
  assert.equal(Items.valid(p, note), true);
  assert.equal(Items.usable(p, note), true);
  assert.equal(claim(p, Items.KIND.NOTE), false, "only one copy can be held");
});

test("every temporary item has a unique eventItemId in the reserved 1,000,000+ range", () => {
  const ids = Items.catalogEventItemIds();
  assert.equal(new Set(ids).size, ids.length, "event item ids are unique");
  for (const id of ids) assert.ok(Number.isInteger(id) && id >= 1_000_000, String(id));
});

test("claims require the event, the player's Enable Effects choice and no combat lock", () => {
  Common.testing.reset();
  const p = player("claim-gates");
  assert.equal(claim(p, Items.KIND.NOTE), false, "no event is active");
  activate("bankers-note");
  Common.setEffectsEnabled(p, "bankers-note", false);
  assert.equal(claim(p, Items.KIND.NOTE), false, "opted out");
  assert.equal(held(p, Items.noteId()), null);
  Common.setEffectsEnabled(p, "bankers-note", true);
  p.setAttribute("global-events:last-combat", Date.now());
  assert.equal(claim(p, Items.KIND.NOTE), false, "the post-combat lock");
  p.setAttribute("global-events:last-combat", 0);
  assert.equal(claim(p, Items.KIND.NOTE), true);
});

test("temporary copies cannot be banked, traded, sold, alched, listed, dropped or kept through death", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("vetoes");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());

  const bank = { player: p, item: note, allow: true, quiet: true };
  hooks.canBank(bank);
  assert.equal(bank.allow, false);

  const trade = { item: note, allowed: true };
  emit("trade:item-eligibility", trade);
  assert.equal(trade.allowed, false);

  const shop = { player: p, itemId: note.getId(), sellable: true };
  emit("shop:can-sell", shop);
  assert.equal(shop.sellable, false);

  const alchemy = { player: p, itemId: note.getId(), allowed: true, coins: 100 };
  emit("magic:alchemy-policy", alchemy);
  assert.deepEqual([alchemy.allowed, alchemy.coins], [false, 0]);

  const ge = { player: p, itemId: note.getId(), sell: true, accepted: true };
  emit("ge:offer-confirmed", ge);
  assert.equal(ge.accepted, false);

  const drop = { player: p, item: note, dropToGround: true, handled: false };
  hooks.dropPolicy(drop);
  assert.deepEqual([drop.dropToGround, drop.handled], [false, true], "a drop asks for confirmation instead");

  const keep = { item: note, keep: false };
  hooks.keepOnDeath(keep);
  assert.equal(keep.keep, true);

  const death = { item: note, suppressDefaultDrop: false, kept: false };
  hooks.deathDrop(death);
  assert.deepEqual([death.suppressDefaultDrop, death.kept], [true, true]);

  const transform = { player: p, usedItem: note, usedWithItem: { getId: () => core.ItemIdentifiers.LOGS }, handled: false };
  hooks.itemOnItem(transform);
  assert.equal(transform.handled, true);

  const use = { player: p, itemId: note.getId(), action: "action", allow: true };
  hooks.canUse(use);
  assert.equal(use.allow, true, "a valid copy may be used");
});

test("the Banker's note notes and un-notes carried items", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("noter");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());
  p.getInventory().adds(core.ItemIdentifiers.LOGS, 3);
  assert.equal(Items.convert(p, core.ItemIdentifiers.LOGS), 3);
  const notedLogs = core.ItemDefinition.forId(core.ItemIdentifiers.LOGS).getNoteId();
  assert.equal(p.getInventory().getAmount(notedLogs), 3);
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 0);
  assert.equal(Items.convert(p, notedLogs), 3, "and back again");
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 3);
  assert.equal(Items.convert(p, Items.noteId()), 0, "a temporary item cannot be noted");
  assert.ok(note);
});

test("the event Banker's note notes and un-notes through item-on-item", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("event-noter");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());
  p.getInventory().adds(core.ItemIdentifiers.LOGS, 3);
  const logs = held(p, core.ItemIdentifiers.LOGS);
  const notedLogs = core.ItemDefinition.forId(core.ItemIdentifiers.LOGS).getNoteId();

  const noteEvent = { player: p, usedItem: note, usedWithItem: logs, handled: false };
  assert.equal(hooks.itemOnItem(noteEvent), true, "the event copy notes the logs");
  assert.equal(noteEvent.handled, true);
  assert.equal(p.getInventory().getAmount(notedLogs), 3);
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 0);

  const unnoteEvent = { player: p, usedItem: note, usedWithItem: held(p, notedLogs), handled: false };
  assert.equal(hooks.itemOnItem(unnoteEvent), true, "and un-notes them again");
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.LOGS), 3);
  assert.equal(p.getInventory().getAmount(notedLogs), 0);
});

test("expiry removes every bound copy from the inventory, equipment and bank, even mid-combat", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("expiry");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());
  // A second copy kept somewhere else by a stale save: the bank is scanned too.
  const clone = new core.Item(Items.noteId(), 1);
  clone.setMetaValue(Items.BINDING_META, Items.bindingOf(note));
  p.getBank(0).add(clone, false);
  p.setAttribute("global-events:last-combat", Date.now());
  const getPlayers = core.World.getPlayers;
  core.World.getPlayers = () => [p];
  try {
    assert.equal(Common.end("utility"), true, "the event's end purges its items");
  } finally {
    core.World.getPlayers = getPlayers;
  }
  assert.equal(p.getInventory().getAmount(Items.noteId()), 0);
  assert.equal(p.getBank(0).getAmount(Items.noteId()), 0);
});

test("an offline expiry is purged on the next login", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("offline");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  Common.testing.setState({ version: 1, revision: 1, slots: { combat: null, skilling: null, utility: null } });
  for (const login of hooks.logins ?? []) login({ player: p });
  assert.equal(p.getInventory().getAmount(Items.noteId()), 0);
});

test("a login before the first platform sync keeps a live loan", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("early");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  assert.equal(Common.stateKnown(), false, "no authoritative world state yet");
  for (const login of hooks.logins ?? []) login({ player: p });
  assert.equal(p.getInventory().getAmount(Items.noteId()), 1, "do not purge on an unknown state");
  Common.testing.setState({ version: 1, revision: 1, slots: { combat: null, skilling: null, utility: null } });
  for (const login of hooks.logins ?? []) login({ player: p });
  assert.equal(p.getInventory().getAmount(Items.noteId()), 0, "once the platform says no, it goes");
});

test("turning the note's event off stops its powers, keeps the item and blocks a reclaim", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("toggle");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());
  Common.setEffectsEnabled(p, "bankers-note", false);
  assert.equal(Items.valid(p, note), true, "the item is not destroyed");
  assert.equal(Items.usable(p, note), false, "but its powers stop");
  assert.equal(claim(p, Items.KIND.NOTE), false, "and it cannot be reclaimed");
  const use = { player: p, itemId: Items.noteId(), action: "action", allow: true };
  hooks.canUse(use);
  assert.equal(use.allow, false);
  Common.setEffectsEnabled(p, "bankers-note", true);
  assert.equal(Items.usable(p, note), true);
});

test("Master's Arsenal loans bind the real weapon and keep charges, ammo and runes", () => {
  Common.testing.reset();
  activate("masters-arsenal");
  const p = player("arsenal");
  assert.equal(claim(p, Items.KIND.ARSENAL, "scythe"), true);
  const scythe = held(p, 22325);
  assert.ok(scythe);
  assert.equal(Items.bindingOf(scythe).catalog, "scythe");
  assert.equal(scythe.getMetaValue(core.Item.UNTRADEABLE_META), true);
  assert.equal(scythe.getMetaValue(core.Item.UNBANKABLE_META), true);

  const skilling = { player: p, item: scythe, skip: false };
  emit("skilling:consume-charge", skilling);
  assert.equal(skilling.skip, true, "a carried tool keeps its charges");

  equip(p, scythe);
  const combat = { player: p, itemId: 22325, skip: false };
  emit("combat:consume-charge", combat);
  assert.equal(combat.skip, true, "a wielded weapon keeps its charges");

  const ammo = { player: p, itemId: core.ItemIdentifiers.RUNE_ARROW, amount: 5, saved: 0 };
  emit("ranged:ammo-saving", ammo);
  assert.equal(ammo.saved, 5);

  const runes = { player: p, saved: false };
  emit("magic:rune-saving", runes);
  assert.equal(runes.saved, true);

  const rows = Items.claimables(p);
  assert.equal(rows.find((row) => row.catalog === "scythe").held, true);
  assert.equal(rows.find((row) => row.catalog === "twisted-bow").held, false);
});

test("claiming another Arsenal item removes the previous loan", () => {
  Common.testing.reset();
  activate("masters-arsenal");
  const p = player("swap");
  assert.equal(claim(p, Items.KIND.ARSENAL, "scythe"), true);
  assert.equal(claim(p, Items.KIND.ARSENAL, "twisted-bow"), true);
  assert.equal(p.getInventory().getAmount(22325), 0, "the old loan is gone");
  assert.equal(p.getInventory().getAmount(20997), 1);
});

test("a bound Arsenal loan waives its equipment levels, but a real copy and an opted-out loan do not", () => {
  Common.testing.reset();
  activate("masters-arsenal");
  const p = player("levels");
  assert.equal(claim(p, Items.KIND.ARSENAL, "scythe"), true);
  const scythe = held(p, 22325);

  const copy = new core.Item(22325, 1);
  copy.setMetaValue(Items.BINDING_META, Items.bindingOf(scythe));
  const loan = { player: p, item: copy, waived: false };
  emit("equipment:requirement", loan);
  assert.equal(loan.waived, true, "the borrowed copy can be worn without Scythe levels");

  const real = { player: p, item: new core.Item(22325, 1), waived: false };
  emit("equipment:requirement", real);
  assert.equal(real.waived, false, "a real Scythe still needs its own levels");

  Common.setEffectsEnabled(p, "masters-arsenal", false);
  const optedOut = { player: p, item: copy, waived: false };
  emit("equipment:requirement", optedOut);
  assert.equal(optedOut.waived, false, "an opted-out loan loses the waiver too");
});

test("a borrowed Arsenal weapon deals no PvP damage but keeps its PvM damage", () => {
  Common.testing.reset();
  activate("masters-arsenal");
  const p = player("pvp-arsenal");
  assert.equal(claim(p, Items.KIND.ARSENAL, "scythe"), true);
  equip(p, held(p, 22325));

  const damage = () => {
    const hit = { value: 30, getDamage() { return hit.value; }, setDamage(value) { hit.value = value; } };
    return hit;
  };
  const pvp = damage();
  hooks.hitDamage({ attacker: p, target: { isPlayer: () => true, isNpc: () => false }, damage: pvp });
  assert.equal(pvp.value, 0, "PvP damage is disabled for a loan");

  const pvm = damage();
  hooks.hitDamage({ attacker: p, target: { isPlayer: () => false, isNpc: () => true }, damage: pvm });
  assert.equal(pvm.value, 30, "PvM damage is untouched");

  const unarmed = player("pvp-normal");
  const normal = damage();
  hooks.hitDamage({ attacker: unarmed, target: { isPlayer: () => true, isNpc: () => false }, damage: normal });
  assert.equal(normal.value, 30, "an ordinary weapon is untouched");
});

test("Sage's greaves are temporary and pay run XP while worn", () => {
  Common.testing.reset();
  activate("trickster");
  const p = player("greaves");
  assert.equal(claim(p, Items.KIND.GREAVES), true);
  const greaves = held(p, Items.greavesId());
  assert.ok(greaves);
  equip(p, greaves);
  const before = p.getSkillManager().getExperience(core.Skill.AGILITY);
  for (let tick = 0; tick < 11; tick++) {
    p.setLocation(new Location(3200 + tick * 2, 3200, 0));
    hooks.process({ player: p });
  }
  assert.ok(p.getSkillManager().getExperience(core.Skill.AGILITY) > before, "ten run ticks pay Agility XP");
});

test("the event leaves a real Sage's greaves alone", () => {
  Common.testing.reset();
  activate("trickster");
  const p = player("real-greaves");
  p.getInventory().adds(core.ItemIdentifiers.SAGES_GREAVES, 1);
  const greaves = held(p, core.ItemIdentifiers.SAGES_GREAVES);
  const event = { player: p, usedItem: greaves, usedWithItem: new core.Item(core.ItemIdentifiers.LOGS, 1), handled: false };
  for (const handler of hooks.itemOnItems) {
    handler(event);
    assert.equal(event.handled, false, `${handler.name} swallowed the real greaves`);
  }
  assert.equal(Items.isTemporary(greaves), false);
  assert.equal(Items.isTemporaryId(greaves.getId()), false);

  Common.testing.setState({ version: 1, revision: 1, slots: { combat: null, skilling: null, utility: null } });
  assert.equal(Items.purgeInvalid(p), 0, "expiry only purges bound event copies");
  assert.equal(p.getInventory().getAmount(core.ItemIdentifiers.SAGES_GREAVES), 1);
});

test("the Events UI lists the dedicated event item names and icons", () => {
  const now = Date.now();
  const slot = (eventId) => ({ eventId, instanceId: `${eventId}-ui-test`, activatedBy: "tester", startedAt: now, endsAt: now + 60_000 });
  Common.testing.setState({ version: 1, revision: 2, slots: { combat: null, skilling: slot("trickster"), utility: slot("bankers-note") } });
  const rows = Items.claimables(player("rows"));
  const note = rows.find((row) => row.kind === Items.KIND.NOTE);
  const greaves = rows.find((row) => row.kind === Items.KIND.GREAVES);
  assert.deepEqual([note.name, note.iconItemId], ["Banker's note (e)", 50006]);
  assert.deepEqual([greaves.name, greaves.iconItemId], ["Sage's greaves (e)", 50007]);
});
test("the looting bag, POH costume storage and group storage refuse a temporary copy", () => {
  Common.testing.reset();
  activate("bankers-note");
  const p = player("containers");
  assert.equal(claim(p, Items.KIND.NOTE), true);
  const note = held(p, Items.noteId());

  const LootingBag = require("../plugins/items/LootingBag.plugin");
  assert.equal(LootingBag._test.canStore(note), false, "an untradeable loan cannot enter the bag");

  require("../plugins/skills/construction/Core.Construction").init(PluginManager.createApi("GlobalEventsItemsTest"));
  const Storage = require("../plugins/skills/construction/Storage.Construction");
  const furniture = { hotspotKey: "CAPE_RACK", storage: {} };
  const house = { owner: p, save: { rooms: [[{ furnitureByLocation: { 1: furniture } }]] } };
  p.getPrivateArea = () => house;
  const slot = p.getInventory().getSlotForItemId(note.getId());
  assert.ok(slot >= 0);
  assert.equal(
    Storage.depositHouseItem(p, house, furniture, slot),
    false,
    "a bound temporary item is not a costume-room set piece",
  );
  assert.equal(p.getInventory().getAmount(note.getId()), 1, "the refused deposit leaves the loan in place");

  const GroupStorage = require("../plugins/interface/groupstorage/Items.GroupStorage");
  GroupStorage.init({ core });
  assert.equal(
    GroupStorage.refusal(note, true),
    GroupStorage.MESSAGE.NOT_STORABLE,
    "tradeable-only group storage refuses an untradeable, bound loan",
  );
});
