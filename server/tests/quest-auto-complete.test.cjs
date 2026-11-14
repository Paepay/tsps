// Run after `yarn build`: node --test tests/quest-auto-complete.test.cjs
// A world with the Quests plugin off still counts every implemented quest as complete: the
// definitions (varps/varbits) and saved stages are loaded without any of their gameplay hooks.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const QuestRuntime = require('../plugins/quests/QuestRuntime');
const Quests = require('../plugins/quests/Quests.plugin.js');
const QuestAutoComplete = require('../plugins/quests/QuestAutoComplete.plugin.js');

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname, '..'));
});

function coreWithQuestSwitch(enabled) {
  const core = PluginManager.getCoreApi();
  const overridden = Object.create(core);
  Object.defineProperty(overridden, 'PluginManager', {
    value: { getPluginSwitch: (name) => name === 'Quests' ? enabled : undefined },
  });
  return overridden;
}

function recordingApi(core) {
  const hooks = { login: [], custom: new Map() };
  const api = {
    core,
    log: () => {},
    persistAttribute: () => {},
    onPlayerLogin: (handler) => hooks.login.push(handler),
    onCustomEvent: (name, handler) => hooks.custom.set(name, [...(hooks.custom.get(name) ?? []), handler]),
  };
  return { api, hooks };
}

function fakePlayer(bot = false) {
  const attributes = new Map();
  const varbits = new Map();
  const varps = new Map();
  const sent = [];
  const sender = {
    sendConfig: (id, value) => { varps.set(id, value); sent.push(['config', id, value]); return sender; },
    sendVarbit: (id, value) => { varbits.set(id, value); sent.push(['varbit', id, value]); return sender; },
    sendInterfaceFlagsRange: (...args) => { sent.push(['flags', ...args]); return sender; },
    getVarbit: (id) => varbits.get(id) ?? 0,
    getVarp: (id) => varps.get(id) ?? 0,
  };
  return {
    attributes,
    sent,
    isPlayerBot: () => bot,
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
  };
}

test('only an explicit Quests off switch activates the completion hooks', () => {
  const check = QuestAutoComplete._test.shouldAutoComplete;
  assert.equal(check(recordingApi(coreWithQuestSwitch(false)).api), true);
  assert.equal(check(recordingApi(coreWithQuestSwitch(true)).api), false);
  assert.equal(check(recordingApi(coreWithQuestSwitch(undefined)).api), false);
});

test('getPluginSwitch normalizes names and leaves an unset switch undefined', () => {
  const original = PluginManager.loadPluginSwitches;
  PluginManager.loadPluginSwitches = () => ({ switches: new Map([['quests', false]]) });
  try {
    assert.equal(PluginManager.getPluginSwitch('Quests'), false);
    assert.equal(PluginManager.getPluginSwitch('quests'), false);
    assert.equal(PluginManager.getPluginSwitch('Missing'), undefined);
  } finally {
    PluginManager.loadPluginSwitches = original;
  }
});

test('a Quests-off world registers every definition and completes it at login', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false));
  QuestAutoComplete.register(api);

  const registered = QuestRuntime.getRegisteredQuests();
  assert.equal(registered.length, Quests.QUESTS.length, 'every implemented quest definition is registered');
  assert.equal(registered.filter((quest) => quest.completionValue === undefined).length, 0,
    'every quest declares its completion stage');
  assert.equal(registered.filter((quest) => quest.varbitId === undefined && !Number.isInteger(quest.varpId)).length, 0,
    'every quest has a varp or varbit the client can read');
  assert.equal(hooks.login.length, 1, 'one login hook completes the quests');
  assert.ok(hooks.custom.has('player:bootstrap-complete'), 'the bootstrap resends the completed varps');
  assert.ok(hooks.custom.has('quest:is-complete'), 'quest queries answer from the completed stages');
  assert.ok(hooks.custom.has('quest:get-stage'), 'stage queries answer from the completed stages');

  const player = fakePlayer();
  const preserved = registered[0];
  const higherStage = Number(preserved.completionValue ?? 2) + 3;
  player.setAttribute('quest.' + preserved.key + '.stage', higherStage);
  player.setAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE, 400);

  for (const handler of hooks.login) handler({ player });
  for (const handler of hooks.custom.get('player:bootstrap-complete') ?? []) handler({ player });

  for (const quest of registered) {
    assert.ok(quest.isComplete(player), quest.key + ' is complete');
  }
  assert.equal(player.getAttribute('quest.' + preserved.key + '.stage'), higherStage,
    'a stage beyond the completion value is kept');
  assert.equal(player.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE), 400,
    'saved quest points beyond the catalogue total are kept');

  const sent = player.sent.filter(([kind]) => kind === 'config' || kind === 'varbit');
  assert.ok(sent.length >= registered.length, 'every quest varp/varbit is sent');
  assert.ok(player.sent.some(([kind, id]) => kind === 'config' && id === QuestRuntime.QUEST_POINTS_VARP),
    'the quest points varp is sent');

  const expectedPoints = registered.reduce((sum, quest) => sum + (Number(quest.questPoints) || 0), 0);
  assert.equal(expectedPoints, 335, 'the implemented quest catalogue is worth 335 quest points');
});

test('the completion hook skips player bots', () => {
  const player = fakePlayer(true);
  QuestRuntime.completeAllQuests(player);
  assert.equal(player.sent.length, 0, 'a bot has no client to send quest progress to');
});
