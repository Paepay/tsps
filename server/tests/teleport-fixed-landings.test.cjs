// Run after `yarn build`: node --test tests/teleport-fixed-landings.test.cjs
// The Watchtower and Ape Atoll teleports keep their one landing tile (docs/teleport-tablets.md): around them the 5x5
// square holds tiles outside the tower top's walls and the Temple of Marimbo's upstairs room on Ape Atoll, which only
// the cache's clipping shows (the tablet-destination test loads none, so every tile looked open).
const assert = require('node:assert/strict');
const path = require('node:path');
const { before, test } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { CacheDefinitions } = require('../dist/game/cache/CacheDefinitions');
const { RegionManager } = require('../dist/game/collision/RegionManager');
const { Location } = require('../dist/game/model/Location');
const { TeleportHandler } = require('../dist/game/model/teleportation/TeleportHandler');
const SpellTeleports = require('../plugins/combat/SpellTeleports.plugin');

let core, useTablet;
const castHandlers = [];
const casts = [];
const teleports = [];
before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, '..'));
  core = PluginManager.getCoreApi();
  RegionManager.init();
  for (const [x, y] of [[2549, 3112], [2798, 2799], [3212, 3424]]) RegionManager.loadMapFiles(x, y);
  SpellTeleports.register({
    core, persistAttribute: () => {}, onPlayerLogin: () => {}, onInterfaceActionClick: () => {}, onCustomEvent: () => {},
    onItemAction: (handler) => { useTablet = handler; },
    onSpellCast: (handler) => castHandlers.push(handler),
    emitCustomEvent: (name, request) => { if (name === 'quest:is-complete') request.complete = true; },
  });
  TeleportHandler.checkReqs = () => true;
  core.SpellTeleports.handleSelf = (player, name, destination) => { casts.push(destination); return true; };
  TeleportHandler.teleport = (player, destination) => teleports.push(destination);
});

function player() {
  const attributes = new Map();
  return {
    sendMessage() {}, getAttribute: (k) => attributes.get(k), setAttribute: (k, v) => attributes.set(k, v),
    getSpellbook: () => core.MagicSpellbook.NORMAL,
    getPacketSender: () => ({ sendVarbit() {} }),
    getInventory: () => ({ contains: () => true, getAmount: () => 1, deleteNumber() {}, getAddableAmount: (i) => i.getAmount() }),
  };
}

function cast(name) {
  casts.length = 0;
  for (const handler of castHandlers) handler({ player: player(), spellName: name, opId: 1, handled: false });
  return casts.at(-1);
}

const at = (tile) => tile && [tile.getX(), tile.getY(), tile.getZ()];

test('Watchtower and Ape Atoll Teleport land on their own tile, every cast', () => {
  for (let i = 0; i < 300; i++) {
    assert.deepEqual(at(cast('Watchtower Teleport')), [2549, 3112, 2], 'the tower top');
    assert.deepEqual(at(cast('Ape Atoll Teleport')), [2798, 2799, 1], 'the safe upstairs room next to Hafuba');
  }
});

test('Ape Atoll lands in the safe upstairs room next to Hafuba, with the stairs reachable', () => {
  // Hafuba's spawn (npc-spawns.json) is 2797,2798 on plane 1; the Wiki puts the spell next to her.
  const landing = new Location(2798, 2799, 1);
  assert.equal(RegionManager.blocked(landing, null), false, 'the landing tile is walkable');
  assert.ok(landing.getX() === 2798 && landing.getY() === 2799 && landing.getZ() === 1);
  // The upper room's exits are the Climb-down staircases (4755 at 2795,2795 and 2799,2795). A bounded
  // flood from the landing must reach a standing tile beside one of them; it must not be a sealed room.
  const seen = new Set(['2798,2799']);
  const queue = [[2798, 2799]];
  while (queue.length) {
    const [x, y] = queue.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 2780 || nx > 2820 || ny < 2780 || ny > 2820) continue;
      const key = `${nx},${ny}`;
      if (seen.has(key) || RegionManager.blocked(new Location(nx, ny, 1), null)) continue;
      seen.add(key);
      queue.push([nx, ny]);
    }
  }
  assert.ok(seen.has('2794,2795'), 'the tile beside the west Climb-down staircase is reachable');
  assert.ok(seen.size > 30, 'the landing opens onto the upstairs floor, not a sealed pocket');
});

test("the Watchtower tablet's Break lands on the same tile", () => {
  let id = -1;
  for (let item = 0; item < CacheDefinitions.getCounts().items && id < 0; item++) {
    const def = CacheDefinitions.getItem(item);
    if (def?.name?.toLowerCase() === 'watchtower teleport' && def.noteTemplate < 0 && def.placeholderTemplate < 0) id = item;
  }
  assert.ok(id > 0);
  for (let i = 0; i < 100; i++) {
    teleports.length = 0;
    useTablet({ player: player(), itemId: id, option: 'break', handled: false });
    assert.deepEqual(at(teleports[0]), [2549, 3112, 2]);
  }
});

test('other standard teleports still land in their 5x5 square', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(at(cast('Varrock Teleport')).join(','));
  assert.ok(seen.size > 1, 'Varrock spreads over its square');
});
