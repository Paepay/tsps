// Run after `yarn build`: node --test tests/equipment-bonus-refresh.test.cjs
// #92: restoring worn gear bypassed the equip path, so the weapon's stats stayed at zero
// (the reported low max hit) until the player re-equipped it. Both restore routes now
// recalculate: a fresh login in Player.onLogin, and every container refresh (dungeon/quest
// gear swaps, deaths, trades) in Equipment.refreshItems.
// Real engine: every plugin loaded, real Players, the save through PlayerSave.fromPlayer /
// applyToPlayer.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { PlayerSave } = require("../dist/game/entity/impl/player/persistence/PlayerSave");

let core, WEAPON;
let next = 18860;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  PM.emitServerStartup({});
  core = PM.getCoreApi();
  WEAPON = core.ItemIdentifiers.DRAGON_SCIMITAR;
});
after(() => PM.emitServerShutdown({}));

function player(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername(`bonus${next}`);
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  t.after(() => p.setRegistered(false));
  return p;
}

const weaponStrength = () => core.ItemDefinition.forId(WEAPON).getBonuses()[10];
const strengthOf = (p) => p.getBonusManager().getOtherBonus()[core.BonusManager.STRENGTH];
const wornWeapon = (p) => p.getEquipment().getItems()[core.Equipment.WEAPON_SLOT]?.getId?.() ?? -1;

function gearWithWeapon(p) {
  const items = p.getEquipment().getItems().map((item) => item.clone());
  items[core.Equipment.WEAPON_SLOT] = new core.Item(WEAPON, 1);
  return items;
}

test("a saved weapon's strength counts again on login without re-equipping it", (t) => {
  const first = player(t);
  first.getEquipment().setItems(gearWithWeapon(first));
  first.getEquipment().refreshItems();
  assert.equal(strengthOf(first), weaponStrength(), "the equipped weapon's stats were counted");

  const saved = PlayerSave.fromPlayer(first);
  const relogged = player(t);
  saved.applyToPlayer(relogged);
  assert.equal(wornWeapon(relogged), WEAPON, "the weapon is still worn after the save is restored");
  assert.equal(strengthOf(relogged), 0, "restoring the save alone does not run the bonus calculation");

  relogged.onLogin();
  assert.equal(strengthOf(relogged), weaponStrength(),
    "login recalculates the worn weapon's stats, so the max hit is not the unarmed one");
  assert.equal(wornWeapon(relogged), WEAPON, "and the weapon is unchanged");
});

test("a gear swap that only refreshes the container recalculates the weapon's stats", (t) => {
  const p = player(t);
  assert.equal(strengthOf(p), 0);

  p.getEquipment().setItems(gearWithWeapon(p));
  p.getEquipment().refreshItems();
  assert.equal(strengthOf(p), weaponStrength(),
    "plugins restoring saved gear with setItems + refreshItems keep the weapon's stats");

  p.getEquipment().setItems(p.getEquipment().getItems().map((item) => item.clone()));
  p.getEquipment().refreshItems();
  assert.equal(strengthOf(p), weaponStrength(), "a refresh without a change keeps them too");

  p.getEquipment().getItems()[core.Equipment.WEAPON_SLOT] = new core.Item(-1, 0);
  p.getEquipment().refreshItems();
  assert.equal(strengthOf(p), 0, "and removing the weapon clears them");
});
