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
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
  const api = new Proxy({
    core,
    persistAttribute() {},
    getCombatFactory: () => ({ inCombat: () => false }),
    onPlayerProcess: (handler) => { hooks.process = handler; },
    onPlayerLogin: (handler) => { (hooks.logins ??= []).push(handler); },
    onItemOnItem: (handler) => { hooks.itemOnItem = handler; },
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
