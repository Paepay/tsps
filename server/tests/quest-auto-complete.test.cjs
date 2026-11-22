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
  const hooks = {
    login: [], logout: [], custom: new Map(), canShop: [], npcDialogueVariant: [], npcDialogueCondition: [],
    objectInteraction: new Map(), itemAction: [], npcInteraction: new Map(), itemOnNpc: [], itemOnObject: [], objectRoute: [],
    mapSquareChange: [], objectHandlers: [], zones: [],
  };
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
    onNpcDialogueCondition: (handler) => hooks.npcDialogueCondition.push(handler),
    onNpcInteraction: (name, actions) => hooks.npcInteraction.set(name, actions),
    onItemOnNpc: (handler) => hooks.itemOnNpc.push(handler),
    onItemOnObject: (handler) => hooks.itemOnObject.push(handler),
    onObjectRoute: (handler) => hooks.objectRoute.push(handler),
    onPlayerMapSquareChange: (handler) => hooks.mapSquareChange.push(handler),
    onPlayerLogout: (handler) => hooks.logout.push(handler),
    onObjectInteraction: (name, actions) => {
      if (typeof name === 'function') hooks.objectHandlers.push(name);
      else hooks.objectInteraction.set(name, actions);
    },
    onZoneEnter: (box, handler) => hooks.zones.push({ box, handler, enter: true }),
    onZoneExit: (box, handler) => hooks.zones.push({ box, handler, enter: false }),
    onItemAction: (handler) => hooks.itemAction.push(handler),
  };
  return { api, hooks, emitted };
}

function fakePlayer(bot = false) {
  const attributes = new Map();
  const varbits = new Map();
  const varps = new Map();
  const sent = [];
  let forceMovement = null;
  let position = { x: 2720, y: 2765, z: 0 };
  const location = { getX: () => position.x, getY: () => position.y, getZ: () => position.z };
  const sender = {
    sendConfig: (id, value) => { varps.set(id, value); sent.push(['config', id, value]); return sender; },
    sendVarbit: (id, value) => { varbits.set(id, value); sent.push(['varbit', id, value]); return sender; },
    sendSound: (id, volume, delay) => { sent.push(['sound', id, volume, delay]); return sender; },
    sendSoundEffect: (id, loops, delay, volume) => { sent.push(['sound', id, loops, delay, volume]); return sender; },
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
    getArea: () => null,
    getBanks: () => [],
    getEquipment: () => ({ getItems: () => [] }),
    sendMessage: (message) => sent.push(['message', message]),
    isRegistered: () => true,
    getCombat: () => ({ reset() {} }),
    getForceMovement: () => forceMovement,
    setForceMovement: (movement) => { forceMovement = movement; },
    getMovementQueue: () => ({ reset() {} }),
    performGraphic: (graphic) => sent.push(['graphic', graphic]),
    moveTo: (next) => {
      position = { x: next.getX(), y: next.getY(), z: next.getZ() };
    },
  };
}

function withInventory(player) {
  const amounts = new Map();
  let freeSlots = 28;
  const inventory = {
    getAmount: (itemId) => amounts.get(itemId) ?? 0,
    contains: (itemId) => (amounts.get(itemId) ?? 0) > 0,
    adds: (itemId, amount = 1) => {
      if (!amounts.has(itemId)) freeSlots--;
      amounts.set(itemId, (amounts.get(itemId) ?? 0) + amount);
      return true;
    },
    deleteNumber: (itemId, amount = 1) => {
      const held = amounts.get(itemId) ?? 0;
      const taken = Math.min(held, amount);
      if (held > 0 && held === taken) freeSlots++;
      amounts.set(itemId, held - taken);
      return taken;
    },
    getFreeSlots: () => freeSlots,
    isFull: () => freeSlots <= 0,
    getItems: () => [...amounts].filter(([, amount]) => amount > 0)
      .map(([id, amount]) => ({ getId: () => id, getAmount: () => amount })),
  };
  player.getInventory = () => inventory;
  return inventory;
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
  assert.ok(hooks.login.length >= 1, 'login hooks complete the quests and restore Quests-off state');
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
  const expectedPoints = registered.reduce((sum, quest) => sum + (Number(quest.questPoints) || 0), 0);
  assert.equal(registered.filter((quest) => quest.isComplete(reloaded)).length, registered.length,
    'the migrated save reloads with every quest complete');
  assert.equal(reloaded.getAttribute(QuestRuntime.QUEST_POINTS_ATTRIBUTE), expectedPoints,
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

test('a Quests-off world offers and sells Eblis his ancient staff after Desert Treasure I', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const { ItemIdentifiers: I, NpcIdentifiers: N } = api.core;
  const npcId = N.EBLIS;

  const funded = fakePlayer();
  const inventory = withInventory(funded);
  inventory.adds(I.COINS, 80000);
  for (const handler of hooks.login) handler({ player: funded });

  const offer = hooks.npcDialogueVariant
    .map((handler) => handler({ player: funded, npcId }))
    .find(Boolean);
  assert.deepEqual(offer, { page: 'Desert Treasure I', variant: 'post-quest-eblis' },
    'Eblis keeps his post-quest transcript instead of falling back to generic dialogue');

  const purchase = {
    player: funded,
    npcId,
    stepId: 'nLCVju',
    text: 'If the player has enough gold to purchase it:',
  };
  const answer = hooks.npcDialogueCondition
    .map((handler) => handler(purchase))
    .find((result) => typeof result === 'boolean');
  assert.equal(answer, true, 'the 80,000-coin branch is selected');
  for (const handler of hooks.custom.get('npc-dialogue:condition') ?? []) handler(purchase);
  assert.equal(inventory.getAmount(I.COINS), 0, 'the price is taken');
  assert.equal(inventory.getAmount(I.ANCIENT_STAFF), 1, 'the staff is handed over');
  assert.ok(funded.sent.some(([, message]) => message === 'Eblis hands you an ancient staff.'));

  const short = fakePlayer();
  const shortInventory = withInventory(short);
  shortInventory.adds(I.COINS, 79999);
  for (const handler of hooks.login) handler({ player: short });
  const refused = {
    player: short,
    npcId,
    stepId: 'nLCVju',
    text: 'If the player has enough gold to purchase it:',
  };
  assert.equal(hooks.npcDialogueCondition
    .map((handler) => handler(refused))
    .find((result) => typeof result === 'boolean'), false);
  for (const handler of hooks.custom.get('npc-dialogue:condition') ?? []) handler(refused);
  assert.equal(shortInventory.getAmount(I.COINS), 79999, 'a short balance is not taken');
  assert.equal(shortInventory.getAmount(I.ANCIENT_STAFF), 0, 'a short balance gets no staff');
});

test('a Quests-off world lets Sir Prysin sell back Darklight after Shadow of the Storm', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const { ItemIdentifiers: I, NpcIdentifiers: N } = api.core;
  const player = fakePlayer();
  const inventory = withInventory(player);
  inventory.adds(I.COINS, 500);
  for (const handler of hooks.login) handler({ player });

  const purchase = {
    player,
    npcId: N.SIR_PRYSIN,
    stepId: 'kKVgcF',
    text: 'If the player has at least 500 coins.',
  };
  assert.equal(hooks.npcDialogueCondition
    .map((handler) => handler(purchase))
    .find((result) => typeof result === 'boolean'), true, 'the 500-coin branch is selected');

  const action = { player, npcId: N.SIR_PRYSIN, stepId: 'p5BVZ5', handled: false };
  for (const handler of hooks.custom.get('npc-dialogue:action') ?? []) handler(action);
  assert.equal(action.handled, true);
  assert.equal(inventory.getAmount(I.COINS), 0, 'the price is taken');
  assert.equal(inventory.getAmount(I.DARKLIGHT), 1, 'Shadow of the Storm means the reissued sword is Darklight');
  assert.equal(inventory.getAmount(I.SILVERLIGHT), 0, 'the old Silverlight is not handed out instead');

  const short = fakePlayer();
  const shortInventory = withInventory(short);
  shortInventory.adds(I.COINS, 499);
  for (const handler of hooks.login) handler({ player: short });
  assert.equal(hooks.npcDialogueCondition
    .map((handler) => handler({ ...purchase, player: short }))
    .find((result) => typeof result === 'boolean'), false);
  const refused = { player: short, npcId: N.SIR_PRYSIN, stepId: 'p5BVZ5', handled: false };
  for (const handler of hooks.custom.get('npc-dialogue:action') ?? []) handler(refused);
  assert.equal(shortInventory.getAmount(I.COINS), 499, 'a short balance is not taken');
  assert.equal(shortInventory.getAmount(I.DARKLIGHT), 0, 'a short balance gets no sword');
});

test('a Quests-off world lets Attract and the lantern reach the WGS chasm', (t) => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  const played = [];
  const startTranscript = QuestRuntime.startTranscript;
  QuestRuntime.startTranscript = (owner, player, npcId, page, variant) => {
    played.push([npcId, page, variant]);
    return true;
  };
  t.after(() => { QuestRuntime.startTranscript = startTranscript; });

  QuestAutoComplete.register(api);
  const { ItemIdentifiers: I, NpcIdentifiers: N, Location } = api.core;
  const player = fakePlayer();
  withInventory(player).adds(I.SAPPHIRE_LANTERN_3, 1);
  for (const handler of hooks.login) handler({ player });

  const creature = {
    getId: () => N.LIGHT_CREATURE_4,
    getLocation: () => new Location(3228, 9525, 2),
  };
  player.moveTo(new Location(3229, 9527, 2));
  const attract = hooks.npcInteraction.get('Light creature')?.Attract;
  assert.ok(attract, 'the light creature keeps its Attract option');
  const click = { player, npcId: N.LIGHT_CREATURE_4, npc: creature, handled: false };
  assert.equal(attract(click), true, 'the option handler claims the click');
  assert.deepEqual(played.at(-1), [N.LIGHT_CREATURE_4, 'While Guthix Sleeps', 'into-the-chasm-attracting-a-light-creature'],
    'Attract opens the across/into-the-chasm menu');

  const use = {
    player, itemId: I.SAPPHIRE_LANTERN_3, npcId: N.LIGHT_CREATURE_4, target: creature, handled: false,
  };
  for (const handler of hooks.itemOnNpc) handler(use);
  assert.equal(use.handled, true, 'the lit sapphire lantern is accepted');
  assert.deepEqual(played.at(-1), [N.LIGHT_CREATURE_4, 'While Guthix Sleeps', 'into-the-chasm-attracting-a-light-creature'],
    'the lantern opens the same crossing menu');

  for (const handler of hooks.custom.get('wgs:enter-temple') ?? []) handler({ player });
  assert.deepEqual([player.position.x, player.position.y, player.position.z], [4061, 4466, 0],
    'the chasm opening reaches the post-quest temple');
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

test('auto-completed quests hand over their reward item and skip XP lamps', () => {
  const player = fakePlayer();
  const inventory = withInventory(player);
  player.getSkillManager = () => ({ addExperiences() {} });
  QuestRuntime.applyAutoReward(player, {
    key: 'demo_reward', rewardItemId: 995,
    onReward: (who, quest, options) => {
      assert.equal(options.experience, false, 'completion XP and honouring lamps are withheld');
      who.getInventory().adds(995, 10);
    },
  });
  assert.equal(inventory.getAmount(995), 11, 'the handler and the completion item are both given');
  QuestRuntime.applyAutoReward(player, { key: 'demo_lamp', rewardItemId: 23516 });
  assert.equal(inventory.getAmount(23516), 0, 'a lamp completion item is not handed out');
  QuestRuntime.applyAutoReward(player, { key: 'a_night_at_the_theatre', rewardItemId: 995 });
  assert.equal(inventory.getAmount(995), 11, 'the theatre lamp quest is skipped entirely');
});

test('auto-completed quests also hand over the items their completion gave outside onReward', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const { ItemIdentifiers: I } = api.core;
  const player = fakePlayer();
  const inventory = withInventory(player);
  player.getSkillManager = () => ({ addExperiences() {} });
  for (const handler of hooks.login) handler({ player });

  assert.equal(inventory.getAmount(I.SOUL_BEARER), 1, "Bear Your Soul's repaired soul bearer");
  assert.equal(inventory.getAmount(I.FOSSIL_ISLAND_NOTE_BOOK), 1, "Bone Voyage's note book");
  for (const robe of [I.GHOSTLY_ROBE, I.GHOSTLY_GLOVES, I.GHOSTLY_BOOTS, I.GHOSTLY_ROBE_2, I.GHOSTLY_HOOD, I.GHOSTLY_CLOAK]) {
    assert.equal(inventory.getAmount(robe), 1, `Curse of the Empty Lord's robe ${robe}`);
  }
  assert.equal(inventory.getAmount(I.DARKLIGHT), 1, 'Demon Slayer is Darklight once Shadow of the Storm is complete');
  assert.equal(inventory.getAmount(I.SILVERLIGHT), 0, 'the old sword is not handed out instead');
  assert.equal(inventory.getAmount(I.RING_OF_SHADOWS_UNCHARGED_), 1, "Desert Treasure II's ring");
  assert.equal(inventory.getAmount(I.CRYPT_MAP), 1, "His Faithful Servants' crypt map");
  assert.equal(inventory.getAmount(I.COWBELL_AMULET), 1, "The Ides of Milk's cowbell amulet");
  assert.equal(inventory.getAmount(I.SACRAMENTS_OF_ENT_FOLK), 1, "Vale Totems' notebook");
});

test('a Quests-off Duke Horacio hands over the anti-dragon shield', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const { ItemIdentifiers: I, NpcIdentifiers: N } = api.core;
  const player = fakePlayer();
  const inventory = withInventory(player);
  for (const handler of hooks.login) handler({ player });

  const action = { player, npcId: N.DUKE_HORACIO, stepId: 'KoKING', handled: false };
  for (const handler of hooks.custom.get('npc-dialogue:action') ?? []) handler(action);
  assert.equal(action.handled, true);
  assert.equal(inventory.getAmount(I.ANTI_DRAGON_SHIELD), 1, 'the shield is given once');

  const again = { player, npcId: N.DUKE_HORACIO, stepId: 'KoKING', handled: false };
  for (const handler of hooks.custom.get('npc-dialogue:action') ?? []) handler(again);
  assert.equal(inventory.getAmount(I.ANTI_DRAGON_SHIELD), 1, 'talking again does not duplicate it');
});

test('a Quests-off world opens Cam Torum through both ends of its entrance', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const player = fakePlayer();
  const interactions = ['Pass-through'];
  const definition = { getInteractions: () => interactions };
  const click = (x, y, z) => {
    const event = {
      player, objectId: api.core.ObjectIdentifiers.ENTRANCE_15, clickType: 1, definition, handled: false,
      location: { getX: () => x, getY: () => y, getZ: () => z },
    };
    for (const handler of hooks.objectHandlers) handler(event);
    return event;
  };
  assert.equal(click(1435, 3129, 0).handled, true);
  assert.deepEqual([player.position.x, player.position.y, player.position.z], [1439, 9509, 1]);
  assert.equal(click(1439, 9507, 1).handled, true);
  assert.deepEqual([player.position.x, player.position.y, player.position.z], [1435, 3128, 0]);
});

test('a Quests-off world crosses the Necropolis rubble into the TOA camp', () => {
  const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
  QuestAutoComplete.register(api);
  const player = fakePlayer();
  player.moveTo(new api.core.Location(3349, 2759, 0));
  const submit = api.core.TaskManager.submit;
  api.core.TaskManager.submit = (task) => task.execute();
  try {
    const event = { player, objectId: 44003, clickType: 1, definition: { getInteractions: () => ['Climb-over'] },
      handled: false, location: new api.core.Location(3348, 2759, 0) };
    for (const handler of hooks.objectHandlers) handler(event);
    assert.equal(event.handled, true);
    assert.deepEqual([player.position.x, player.position.y], [3347, 2759]);
    assert.deepEqual(player.sent.filter(([kind, id]) => kind === 'varbit' && id === 12393),
      [['varbit', 12393, 1], ['varbit', 12393, 0]], 'busy is set and cleared');
    assert.ok(player.sent.some(([kind, id, loops, delay]) => kind === 'sound' && id === 2454 && loops === 3 && delay === 4),
      'the captured crossing sound plays');
  } finally {
    api.core.TaskManager.submit = submit;
  }
});

test('a Quests-off world activates the Crypt of Tonali lift and its Strange Tiles', () => {
  const submit = PluginManager.getCoreApi().TaskManager.submit;
  PluginManager.getCoreApi().TaskManager.submit = (task) => task.execute();
  try {
    const { api, hooks } = recordingApi(coreWithQuestSwitch(false), { template: 'level_up' });
    QuestAutoComplete.register(api);
    const player = fakePlayer();
    for (const handler of hooks.login) handler({ player });
    const varbit = player.sent.find(([kind, id]) => kind === 'varbit' && id === 16694);
    assert.deepEqual(varbit, ['varbit', 16694, 1], 'the lift shows its Use option');
    assert.equal(player.getAttribute('the-final-dawn:lift-activated'), 1);

    player.moveTo(new api.core.Location(1332, 9382, 0));
    const zone = hooks.zones.find(({ box, enter }) => enter && box.minX === 1332 && box.minY === 9382);
    assert.ok(zone, 'the crypt tile has its zone handler');
    zone.handler({ player });
    assert.deepEqual([player.position.x, player.position.y, player.position.z], [1328, 9379, 1]);
    assert.ok(player.sent.some(([kind]) => kind === 'graphic'), 'the tile plays its teleport graphic');
  } finally {
    PluginManager.getCoreApi().TaskManager.submit = submit;
  }
});

test('the completion hook skips player bots', () => {
  const player = fakePlayer(true);
  QuestRuntime.completeAllQuests(player);
  assert.equal(player.sent.length, 0, 'a bot has no client to send quest progress to');
});
