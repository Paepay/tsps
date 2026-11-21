// Run after `yarn build`: node --test tests/museum-guard-gate.test.cjs
//
// Varrock Museum's cleaning-area gate (24536 at 3261,3446) and the guard (1910) beside it.
// Wiki (Transcript:Museum guard): before The Dig Site the guard refuses entry; after it,
// the first gate click of a session asks whether the player wants to go in, and the Yes,
// I will go in answer lets them through. The 2019 QoL change asks only once per session.
// Real engine: every plugin, the quest's own completion stage, and clicks sent through the
// engine's object/NPC listeners, so routing, dialogue, forced movement and close tasks run.
process.env.DISABLE_PLAYER_BOTS = '1';
const assert = require('node:assert/strict');
const path = require('node:path');
const { after, before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
const { ObjectActionPacketListener } = require('../dist/net/packet/impl/ObjectActionPacketListener');
const { NPCOptionPacketListener } = require('../dist/net/packet/impl/NPCOptionPacketListener');
const QuestRuntime = require('../plugins/quests/QuestRuntime');

const GUARD = 1910;
const GATE = 24536;
const GATE_AT = [3261, 3446, 0];
const HALL = [3261, 3447];
const CLEANING = [3259, 3445];
const REFUSED = `You're not permitted in this area.`;
const WELCOME = 'Welcome! Would you like to go into the Dig Site archaeology cleaning area?';

let core;
let next = 4700;
const players = [];

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  PluginManager.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PluginManager.getCoreApi();
  core.ObjectDefinition.init();
  core.RegionManager.init();
  core.RegionManager.loadMapFiles(GATE_AT[0], GATE_AT[1]);
  PluginManager.emitServerStartup({});
});

after(() => PluginManager.emitServerShutdown({}));

function actor(t, { complete = false, at = HALL } = {}) {
  const channel = {
    kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true,
    close() {}, onData() {}, onError() {}, onClose() {},
  };
  const player = new Player(new PlayerSession(channel));
  player.setIndex(next++);
  player.setUsername('museumGate' + player.getIndex());
  player.setRegistered(true);
  player.setLocation(new core.Location(at[0], at[1], 0));
  player.needsPlacement = false;
  players.push(player);
  const quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === 'the_dig_site');
  assert.ok(quest, 'The Dig Site is registered');
  if (complete) quest.setStage(player, 9);
  t.after(() => {
    player.setRegistered(false);
    core.TaskManager.cancelTasks(player.getIndex());
    core.TaskManager.cancelTasks(player);
  });
  return player;
}

function tick(count = 1) {
  for (let i = 0; i < count; i++) {
    for (const player of players) {
      player.getMovementQueue().process();
      core.TaskManager.processWalkTo(player.getIndex());
    }
    core.TaskManager.process();
  }
}

function until(condition, limit = 12) {
  for (let i = 0; i < limit && !condition(); i++) tick();
  return condition();
}

const at = (player) => [player.getLocation().getX(), player.getLocation().getY()];
const gateClosed = () => core.MapObjects.get(GATE, new core.Location(...GATE_AT), null) != null;
const clickGate = (player) => new ObjectActionPacketListener().executeAction(player, GATE, ...GATE_AT.slice(0, 2), 1);
const currentText = (player) => player.getDialogueManager().getCurrent()?.getText?.();

/** Continues the guard's lines until the menu; returns its options. */
function menu(player) {
  for (let i = 0; i < 20; i++) {
    const pending = core.MultiChatboxPrompt.getPending(player);
    if (pending) return pending.options;
    const current = player.getDialogueManager().getCurrent();
    if (current instanceof core.OptionDialogue) return current.getOptions();
    if (!player.getDialogueManager().isActive()) return null;
    player.getDialogueManager().advance();
  }
  return null;
}

function choose(player, option) {
  const options = menu(player);
  assert.ok(options, 'the guard menu opened');
  const index = options.indexOf(option);
  assert.ok(index >= 0, `${option} in ${JSON.stringify(options)}`);
  if (core.MultiChatboxPrompt.getPending(player)) {
    core.MultiChatboxPrompt.handleInterfaceActionClick({
      player, buttonId: core.MultiChatboxPrompt.OPTIONS_WIDGET_ID,
      groupId: 219, slot: index + 1,
    });
  } else {
    player.getDialogueManager().handleOption(index + 1);
  }
}

test('before The Dig Site the gate stays shut and the guard refuses entry', (t) => {
  const player = actor(t);
  tick(2);
  assert.ok(gateClosed(), 'the map closed gate is in place');
  clickGate(player);
  tick(3);
  assert.equal(currentText(player), REFUSED);
  assert.ok(gateClosed(), 'the gate did not open');
  assert.deepEqual(at(player), HALL, 'the player was not let through');
});

test('the first gate click after the quest asks, and Yes lets the player inside', (t) => {
  const player = actor(t, { complete: true });
  clickGate(player);
  tick(3);
  assert.equal(currentText(player), WELCOME);
  choose(player, `Yes, I'll go in!`);
  assert.ok(until(() => at(player).join() === CLEANING.join()), `the player ends inside, at ${at(player)}`);
  assert.ok(until(gateClosed), 'the gate is closed again');
});

test('No thanks consumes the session prompt; the next Open crosses without asking', (t) => {
  const player = actor(t, { complete: true });
  clickGate(player);
  tick(3);
  assert.equal(currentText(player), WELCOME);
  choose(player, `No thanks, I'll take a look around out here.`);
  for (let i = 0; i < 4 && player.getDialogueManager().isActive(); i++) {
    player.getDialogueManager().advance();
  }
  tick(2);
  assert.deepEqual(at(player), HALL);

  clickGate(player);
  assert.ok(until(() => at(player)[1] === CLEANING[1]), `the player crosses, at ${at(player)}`);
  assert.equal(player.getDialogueManager().isActive(), false, 'the guard did not ask again');
  assert.ok(until(gateClosed), 'the gate is closed again');
});

test('a player in the cleaning area can open the gate and cross back to the hall', (t) => {
  const player = actor(t, { complete: true });
  clickGate(player);
  tick(3);
  choose(player, `No thanks, I'll take a look around out here.`);
  tick(2);
  player.setLocation(new core.Location(3261, 3445, 0));
  clickGate(player);
  assert.ok(until(() => at(player).join() === HALL.join()), `the player ends in the hall, at ${at(player)}`);
  assert.ok(until(gateClosed), 'the gate is closed again');
});

test('Talk-to before the quest plays the museum gate refusal, not a free-to-play line', (t) => {
  const guard = PluginManager.spawnNpc({ id: GUARD, x: 3262, y: 3446, z: 0, wanderRadius: 0 }, 'MuseumGateTest');
  const player = actor(t, { at: [3263, 3446] });
  const definition = guard.getCurrentDefinition(player);
  const talk = definition.getActions().findIndex((action) => action === 'Talk-to') + 1;
  assert.ok(talk > 0, 'the guard has Talk-to');
  new NPCOptionPacketListener().executeOption(player, guard.getIndex(), talk);
  tick(3);
  assert.equal(currentText(player), REFUSED);
});
