// Run after `yarn build`: node --test tests/quest-auto-complete.test.cjs
// A world with the Quests plugin off still counts every implemented quest as complete: the
// definitions (varps/varbits) and saved stages are loaded without any of their gameplay hooks.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');

const { Server } = require('../dist/Server');
Server.installProductionPathResolver();
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSave } = require('../dist/game/entity/impl/player/persistence/PlayerSave');
const QuestRuntime = require('../plugins/quests/QuestRuntime');
const Quests = require('../plugins/quests/Quests.plugin.js');
const QuestAutoComplete = require('../plugins/quests/QuestAutoComplete.plugin.js');

before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname, '..'));
});

function coreWithQuestSwitch(enabled, saves, { members = true } = {}) {
  const core = PluginManager.getCoreApi();
  const overridden = Object.create(core);
  Object.defineProperty(overridden, 'PluginManager', {
    value: { getPluginSwitch: (name) => name === 'Quests' ? enabled : undefined },
  });
  Object.defineProperty(overridden, 'WorldDefinition', { value: { isMembersWorld: () => members } });
  if (saves) {
    Object.defineProperty(overridden, 'GameConstants', {
      value: { PLAYER_PERSISTENCE: { requestSave: (player, reason) => saves.push({ player, reason }) } },
    });
  }
  return overridden;
}

function recordingApi(core, { template = null } = {}) {
  const hooks = { login: [], custom: new Map(), canShop: [], npcDialogueVariant: [], objectInteraction: new Map(), itemAction: [] };
  const emitted = [];
  const api = {
    core,
    log: () => {},
    getPluginConfig: (key, fallback) => key === 'template:id' ? (template ?? fallback) : fallback,
    persistAttribute: (key, value) => PlayerSave.persistAttribute(key, value),
    onPlayerLogin: (handler) => hooks.login.push(handler),
    onCustomEvent: (name, handler) => hooks.custom.set(name, [...(hooks.custom.get(name) ?? []), handler]),
    emitCustomEvent: (name, event) => {
      emitted.push({ name, event });
      for (const handler of hooks.custom.get(name) ?? []) handler(event);
    },
    onCanShop: (handler) => hooks.canShop.push(handler),
    onNpcDialogueVariant: (handler) => hooks.npcDialogueVariant.push(handler),
    onObjectInteraction: (name, actions) => hooks.objectInteraction.set(name, actions),
    onItemAction: (handler) => hooks.itemAction.push(handler),
  };
  return { api, hooks, emitted };
}

function fakePlayer(bot = false) {
  const attributes = new Map();
  const varbits = new Map();
  const varps = new Map();
  const sent = [];
  let position = { x: 2720, y: 2765, z: 0 };
  const location = { getX: () => position.x, getY: () => position.y, getZ: () => position.z };
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
    get position() { return position; },
    isPlayerBot: () => bot,
    getPacketSender: () => sender,
    getAttribute: (key) => attributes.get(key),
    setAttribute: (key, value) => attributes.set(key, value),
    getLocation: () => location,
    sendMessage: (message) => sent.push(['message', message]),
    moveTo: (next) => {
      position = { x: next.getX(), y: next.getY(), z: next.getZ() };
    },
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
  const saves = [];
  const { api, hooks, emitted } = recordingApi(coreWithQuestSwitch(false, saves));
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
  assert.deepEqual(saves.map(({ player: saved, reason }) => [saved, reason]), [[player, 'quest-auto-complete']],
    'the completed stages are saved immediately');
  for (const handler of hooks.custom.get('player:bootstrap-complete') ?? []) handler({ player });
  assert.equal(saves.length, 1, 'the bootstrap does not save an already migrated account again');
  assert.ok(emitted.some(({ name, event }) => name === 'quest:list-remount' && event.player === player),
    'the bootstrap rebuilds a quest list that mounted before the completed varps');

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
  assert.equal(expectedPoints, 337, 'the implemented quest catalogue is worth 337 quest points');
});

test('an older saved character is migrated and stays complete after a save and reload', () => {
  const saves = [];
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false, saves));
  QuestAutoComplete.register(api);

  const makePlayer = (username) => {
    const player = new Player(null);
    player.setUsername(username);
    player.getSession = () => ({ sendClientPacket: () => true, write() {} });
    return player;
  };

  const before = makePlayer('quest-autocomplete-old');
  before.setAttribute('quest.cooks_assistant.stage', 0);
  before.setAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE, 0);
  const oldSave = PlayerSave.fromPlayer(before);
  const loggedIn = makePlayer('quest-autocomplete-old');
  oldSave.applyToPlayer(loggedIn);

  for (const handler of hooks.login) handler({ player: loggedIn });
  assert.equal(saves.length, 1, 'logging in with an old save requests a migration save');
  assert.equal(loggedIn.getAttribute('quest.cooks_assistant.stage'), 2, 'an incomplete saved stage is raised');

  const migrated = PlayerSave.fromPlayer(loggedIn);
  const reloaded = makePlayer('quest-autocomplete-old');
  migrated.applyToPlayer(reloaded);
  const registered = QuestRuntime.getRegisteredQuests();
  assert.equal(registered.filter((quest) => quest.isComplete(reloaded)).length, registered.length,
    'the migrated save reloads with every quest complete');
  assert.equal(reloaded.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE), 337,
    'the migrated save keeps the full quest point total');
});

test('a Level-Up Quests-off world restores the quest-owned shops and Ape gate, and hands out Chivalry and Piety', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const player = fakePlayer();
  for (const handler of hooks.login) handler({ player });

  // quest-shops.json gates the Proselyte armoury on The Slug Menace; the completion hooks answer it.
  Object.defineProperty(api.core, 'ShopDefinition', {
    configurable: true,
    value: { forId: () => ({ getName: () => 'Proselyte Temple Knight Armoury' }) },
  });
  const shop = { player, shopId: 1, allow: true };
  for (const handler of hooks.canShop) handler(shop);
  assert.equal(shop.allow, true, 'The Slug Menace counts complete, so Sir Tiffy sells Proselyte armour');

  const sirTiffy = hooks.npcDialogueVariant
    .map((handler) => handler({ player, npcId: api.core.NpcIdentifiers.SIR_TIFFY_CASHIEN }))
    .find(Boolean);
  assert.deepEqual(sirTiffy, { page: 'Sir Tiffy Cashien', variant: 'after-slug-menace' });

  const gate = hooks.objectInteraction.get('Bamboo Gate');
  assert.ok(gate?.Open, 'the Bamboo Gate has its Open handler');
  gate.Open({ player });
  assert.deepEqual([player.position.x, player.position.y, player.position.z], [2720, 2767, 0]);

  const bypass = hooks.custom.get('prayer:unlocks-bypass')?.[0];
  assert.ok(bypass, 'a prayer unlock bypass is attached');
  const chivalry = { prayer: api.core.PrayerData.CHIVALRY, bypass: false };
  const piety = { prayer: api.core.PrayerData.PIETY, bypass: false };
  const other = { prayer: api.core.PrayerData.THICK_SKIN, bypass: false };
  bypass(chivalry);
  bypass(piety);
  bypass(other);
  assert.equal(chivalry.bypass, true);
  assert.equal(piety.bypass, true);
  assert.equal(other.bypass, false, 'only the Knight Waves prayers are handed out');
});

test('every Quests-off world leaves Chivalry and Piety unlocked with the auto-completed quests', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'standard' });
  QuestAutoComplete.register(api);
  const bypass = hooks.custom.get('prayer:unlocks-bypass')?.[0];
  assert.ok(bypass);
  for (const prayer of [api.core.PrayerData.CHIVALRY, api.core.PrayerData.PIETY]) {
    const request = { prayer, bypass: false };
    bypass(request);
    assert.equal(request.bypass, true);
  }
  const other = { prayer: api.core.PrayerData.THICK_SKIN, bypass: false };
  bypass(other);
  assert.equal(other.bypass, false, 'only the Knight Waves prayers are handed out');
});

test('a Quests-off world registers the royal seed pod teleport', () => {
  const landed = [];
  const core = coreWithQuestSwitch(false);
  Object.defineProperty(core, 'TeleportHandler', {
    value: {
      checkReqs: () => true,
      confirm: (player, location, go) => go(),
      teleport: (player, location, type, warning, onArrival) => {
        landed.push([location.getX(), location.getY(), location.getZ()]);
        onArrival?.();
      },
    },
  });
  const { api, hooks } = recordingApi(core, { template: 'standard' });
  QuestAutoComplete.register(api);
  const player = fakePlayer();
  const event = { player, itemId: api.core.ItemIdentifiers.ROYAL_SEED_POD, option: 'Commune', handled: false };
  assert.ok(hooks.itemAction.some((handler) => (handler(event), event.handled === true)),
    'the pod is answered without the Monkey Madness II plugin');
  assert.deepEqual(landed, [[2465, 3496, 0]]);
  assert.ok(player.sent.some(([, message]) => message === 'The Royal seed pod teleports you to the Grand Tree.'));
});

test('the completion hook skips player bots', () => {
  const player = fakePlayer(true);
  QuestRuntime.completeAllQuests(player);
  assert.equal(player.sent.length, 0, 'a bot has no client to send quest progress to');
});
