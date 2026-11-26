// Run after `yarn build`: node --test tests/tormented-remains.test.cjs
// Tormented demon remains (issue 192). The cache gives the smouldering pile of flesh "Eat-from"
// and the heart and gland "Crush" on the ground instead of Take; the Wiki gives their effects,
// the messages, the ten-minute floor life and the telegrab refusal. These use every plugin
// loaded, real Players and the real ground-item interaction event.
process.env.DISABLE_PLAYER_BOTS = "1";
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const Remains = require("../plugins/bosses/tormenteddemons/Remains.TormentedDemons");

const FLESH = 29585, HEART = 29583, GLAND = 29587;
const FLESH_MESSAGE = "Even as the flesh burns your throat, you feel your wounds begin to mend.";
const HEART_MESSAGE = "You crush the heart. Dark energy swirls around you...";
const GLAND_MESSAGE = "You crush the gland, releasing its unholy blessing.";

let core, next = 9600;
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  core.RegionManager.init();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function actor(t, hitpoints = 99) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("remains" + p.getIndex());
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  core.RegionManager.loadMapFiles(3222, 3218);
  p.setLocation(new core.Location(3222, 3218, 0));
  p.needsPlacement = false;
  const conn = new ClientConnection(channel);
  conn.player = p;
  t.after(() => {
    PM.emitPlayerLogout({ player: p, username: p.getUsername() });
    core.TaskManager.cancelTasks(p);
    core.TaskManager.cancelTasks(p.getIndex());
    p.setRegistered(false);
  });
  const skills = p.getSkillManager();
  for (const skill of [core.Skill.ATTACK, core.Skill.STRENGTH, core.Skill.DEFENCE, core.Skill.RANGED,
    core.Skill.MAGIC, core.Skill.PRAYER, core.Skill.HITPOINTS]) {
    skills.setMaxLevels(skill, 99, false);
    skills.setCurrentLevels(skill, 99, false);
  }
  skills.setCurrentLevels(core.Skill.HITPOINTS, hitpoints, false);
  const messages = [];
  t.mock.method(p.getPacketSender(), "sendMessage", (message) => { messages.push(message); return p.getPacketSender(); });
  return { p, conn, messages };
}

function drop(f, itemId) {
  return core.ItemOnGroundManager.registerLocation(
    f.p, new core.Item(itemId, 1), f.p.getLocation().clone(), f.p.getPrivateArea(),
    { despawnDelay: Remains._test.REMAINS_DESPAWN_TICKS });
}

function use(f, groundItem) {
  const event = {
    player: f.p,
    groundItem,
    groundItemId: groundItem.getItem().getId(),
    clickType: 3,
    location: { x: groundItem.getPosition().getX(), y: groundItem.getPosition().getY(), z: groundItem.getPosition().getZ() },
    handled: false,
  };
  return { event, handled: PM.emitGroundItemInteraction(event) };
}

const exists = (groundItem) => core.World.getItems().includes(groundItem) && !groundItem.isPendingRemoval();
const hp = (f) => f.p.getSkillManager().getCurrentLevel(core.Skill.HITPOINTS);
const level = (f, skill) => f.p.getSkillManager().getCurrentLevel(skill);
const tick = (n = 1) => { for (let i = 0; i < n; i++) core.TaskManager.process(); };

test("Eat-from heals four bites, says the Wiki's line and removes the pile", (t) => {
  const f = actor(t, 40);
  const pile = drop(f, FLESH);
  for (let bite = 1; bite <= 3; bite++) {
    const result = use(f, pile);
    assert.equal(result.handled, true, "the interaction is handled");
    assert.equal(exists(pile), true, "a bite is left");
    assert.equal(hp(f), 40 + bite * 18);
    assert.equal(pile.getItem().getMetaValue(Remains._test.FLESH_BITES_META), 4 - bite);
  }
  assert.equal(f.messages.length, 3);
  assert.ok(f.messages.every((message) => message === FLESH_MESSAGE));

  use(f, pile);
  assert.equal(exists(pile), false, "the fourth bite removes it");
  assert.equal(hp(f), 112);
  assert.deepEqual(f.messages, [FLESH_MESSAGE, FLESH_MESSAGE, FLESH_MESSAGE, FLESH_MESSAGE]);
});

test("at the overheal cap Eat-from is handled but uses no bite", (t) => {
  const f = actor(t, 117);
  const pile = drop(f, FLESH);
  const result = use(f, pile);
  assert.equal(result.handled, true);
  assert.equal(exists(pile), true);
  assert.equal(hp(f), 117);
  assert.equal(pile.getItem().getMetaValue(Remains._test.FLESH_BITES_META), undefined);
  assert.deepEqual(f.messages, []);
});

test("Crush on the heart gives every combat boost, says the line and keeps them held", (t) => {
  const f = actor(t);
  const heart = drop(f, HEART);
  const result = use(f, heart);
  assert.equal(result.handled, true);
  assert.equal(exists(heart), false);
  assert.deepEqual(f.messages, [HEART_MESSAGE]);
  assert.equal(level(f, core.Skill.ATTACK), 119);
  assert.equal(level(f, core.Skill.STRENGTH), 119);
  assert.equal(level(f, core.Skill.DEFENCE), 119);
  assert.equal(level(f, core.Skill.RANGED), 113);
  assert.equal(level(f, core.Skill.MAGIC), 110);

  const held = new Set();
  PM.emitCustomEvent("stats:boost-held", { player: f.p, held });
  for (const skill of [core.Skill.ATTACK, core.Skill.STRENGTH, core.Skill.DEFENCE, core.Skill.RANGED, core.Skill.MAGIC]) {
    assert.ok(held.has(skill.getIndex()), "the heart holds " + skill.name);
  }

  f.p.setAttribute(Remains._test.HEART_UNTIL_ATTRIBUTE, Date.now() - 1);
  const expired = new Set();
  PM.emitCustomEvent("stats:boost-held", { player: f.p, held: expired });
  assert.equal(expired.size, 0, "after two minutes the ordinary decay resumes");
});

test("Crush on the gland restores Prayer over about 49 seconds and says the line", (t) => {
  const f = actor(t);
  f.p.getSkillManager().setCurrentLevels(core.Skill.PRAYER, 10, false);
  const gland = drop(f, GLAND);
  const result = use(f, gland);
  assert.equal(result.handled, true);
  assert.equal(exists(gland), false);
  assert.deepEqual(f.messages, [GLAND_MESSAGE]);

  tick(7);
  assert.equal(level(f, core.Skill.PRAYER), 10, "the first pulse is eight ticks on");
  tick(1);
  const first = level(f, core.Skill.PRAYER);
  assert.ok(first >= 20 && first <= 25, "a 10-15 point pulse");
  tick(72);
  assert.equal(level(f, core.Skill.PRAYER), 99, "ten pulses, never over the maximum");
});

test("teleporting away ends the gland's blessing", (t) => {
  const f = actor(t);
  f.p.getSkillManager().setCurrentLevels(core.Skill.PRAYER, 10, false);
  const gland = drop(f, GLAND);
  use(f, gland);
  tick(8);
  const beforeTeleport = level(f, core.Skill.PRAYER);
  assert.ok(beforeTeleport >= 20 && beforeTeleport <= 25);
  PM.emitCustomEvent("teleport:landed", { player: f.p, from: f.p.getLocation().clone(), fromInstance: false, to: f.p.getLocation().clone() });
  tick(80);
  assert.equal(level(f, core.Skill.PRAYER), beforeTeleport);
});

test("the remains last ten minutes, pause on logout and cannot be taken or telegrabbed", (t) => {
  const f = actor(t);
  const dropEvent = { player: f.p, npc: null, npcId: 13599, drops: [{ itemId: FLESH, amount: 1 }, { itemId: 590, amount: 1 }] };
  PM.emitCustomEvent("npc-drops:generated", dropEvent);
  assert.equal(dropEvent.drops[0].ground.despawnDelay, Remains._test.REMAINS_DESPAWN_TICKS);
  assert.equal(dropEvent.drops[1].ground, undefined, "other drops keep their own lifetime");

  const pile = drop(f, FLESH);
  PM.emitPlayerLogout({ player: f.p, username: f.p.getUsername() });
  assert.equal(pile.isAgingPaused(), true);
  PM.emitPlayerLogin({ player: f.p, username: f.p.getUsername() });
  assert.equal(pile.isAgingPaused(), false);

  const grab = { player: f.p, groundItem: pile, allow: true };
  PM.emitCustomEvent("magic:can-telekinetic-grab", grab);
  assert.equal(grab.allow, false);
  const take = { player: f.p, groundItem: pile, source: "pickup", itemId: FLESH, amount: 1, discard: 0, allow: true, error: null };
  PM.emitCustomEvent("ground-items:take", take);
  assert.equal(take.allow, false);
  assert.equal(take.amount, 0);
  assert.equal(exists(pile), true);
});
