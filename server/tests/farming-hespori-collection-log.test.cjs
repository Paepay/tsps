// Real cache, player, Hespori and its drop table; the collection log reads the same drops list.
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
process.env.DISABLE_PLAYER_BOTS = '1';
require('../dist/Server').Server.installProductionPathResolver();
const { PluginManager: PM } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
const { PlayerSession } = require('../dist/net/PlayerSession');
let core, Data, Patches, Hespori, patch;
before(async () => {
  await require('../dist/game/cache/CachePipeline').CachePipeline.initialize(path.resolve(__dirname, '..'));
  PM.loadFromDirectory(path.resolve(__dirname, '../plugins'));
  core = PM.getCoreApi();
  core.RegionManager.init(); core.RegionManager.loadMapFiles(1246, 10085);
  Data = require('../plugins/skills/farming/Data.Farming');
  Patches = require('../plugins/skills/farming/Patches.Farming');
  Hespori = require('../plugins/skills/farming/Hespori.Farming');
  PM.emitServerStartup({});
  patch = Data.CACHE.patches.find((entry) => entry.type === 'HESPORI');
});

test('the loot the collection log sees is the final Hespori loot, one guaranteed anima seed (#55)', () => {
  const player = new Player(new PlayerSession({ kind: 'test', remoteAddress: '127.0.0.1', isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} }));
  player.setIndex(1901); player.setUsername('hesporilog'); player.setRegistered(true);
  player.setAttribute('bot-skip-persistence', true);
  player.setLocation(new core.Location(1246, 10085, 0));
  player.sendMessage = () => {};
  const state = Patches.stateFor(player, patch);
  Object.assign(state, { crop: 'HESPORI', status: 'grown', stage: 3, nextAt: Number.MAX_SAFE_INTEGER });

  const boss = core.NPC.create(core.NpcIdentifiers.HESPORI, new core.Location(1246, 10085, 0));
  const anima = ['Attas seed', 'Iasor seed', 'Kronos seed'].map((name) => Data.itemId(name));
  // The table rolled a Kronos seed and a herb; the plugin replaces the anima with one guaranteed roll.
  const drops = [
    { itemId: anima[2], amount: 1 },
    { itemId: Data.itemId('Ranarr weed'), amount: 4 },
  ];
  const event = { player, npc: boss, npcId: boss.getId(), drops, handled: false };
  Hespori.hesporiLoot(event);

  const animaDrops = drops.filter((drop) => anima.includes(drop.itemId));
  assert.equal(animaDrops.length, 1, 'exactly one anima seed in the list the log reads');
  assert.ok(animaDrops[0].amount >= 1 && animaDrops[0].amount <= 2, 'one or two seeds');
  assert.equal(drops.filter((drop) => drop.itemId === Data.itemId('Ranarr weed')).length, 1, 'the main roll survives');
});
