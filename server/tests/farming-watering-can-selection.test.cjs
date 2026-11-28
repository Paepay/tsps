const assert = require('node:assert/strict');
const { test, before } = require('node:test');
require('../dist/Server').Server.installProductionPathResolver();
const { CachePipeline } = require('../dist/game/cache/CachePipeline');
const { PluginManager } = require('../dist/plugins/PluginManager');
const { Player } = require('../dist/game/entity/impl/player/Player');
let core, Data, Model, Patches, Tithe, hooks;
before(async () => {
    await CachePipeline.initialize(require('node:path').resolve(__dirname, '..'));
    core = PluginManager.getCoreApi();
    require('../plugins/skills/farming/Core.Farming').init({ core });
    Data = require('../plugins/skills/farming/Data.Farming');
    Model = require('../plugins/skills/farming/Model.Farming');
    Patches = require('../plugins/skills/farming/Patches.Farming');
    Tithe = require('../plugins/skills/farming/Tithe.Farming');
    Data.initializeFarmingData();
    hooks = {};
    Patches.attach(new Proxy({}, { get: (_, name) => (...args) => {
        if (name === 'onItemOnItem' || name === 'onItemOnObject') hooks[name] = args[0];
    } }));
});
function prepare(t, charges = 8) {
    const player = new Player(null), bits = new Map();
    const sender = new Proxy({}, { get: (_, name) => name === 'getVarbit' ? id => bits.get(id) ?? 0
        : name === 'sendVarbit' ? (id, value) => { bits.set(id, value); return sender; } : () => sender });
    player.getPacketSender = () => sender; player.sendMessage = () => {}; player.performAnimation = () => {};
    player.getClickDelay = () => ({ elapsedTime: () => true, reset() {} });
    player.getSkillManager().setCurrentLevel(core.Skill.FARMING, 99, false);
    t.mock.method(core.MapObjects, 'get', () => null);
    const id = Data.itemId(`Watering can(${charges})`), inventory = player.getInventory();
    inventory.add(new core.Item(id), false).add(new core.Item(id), false);
    return { player, inventory, id, first: inventory.forSlot(0), selected: inventory.forSlot(1) };
}
test('seedling watering spends the selected can in either item-use orientation', t => {
    for (const reverse of [false, true]) {
        const f = prepare(t), crop = Data.CROPS.get('OAK');
        f.inventory.add(new core.Item(crop.seedling), false);
        hooks.onItemOnItem({ player: f.player,
            usedItemId: reverse ? f.id : crop.seedling, usedItemSlot: reverse ? 1 : 2,
            usedWithItemId: reverse ? crop.seedling : f.id, usedWithItemSlot: reverse ? 2 : 1 });
        assert.equal(f.first.getId(), f.id);
        assert.equal(f.selected.getId(), Data.itemId('Watering can(7)'));
        assert.equal(f.inventory.forSlot(2).getId(), crop.wateredSeedling);
    }
});
test('using the final selected dose empties only that can', t => {
    const f = prepare(t, 1);
    assert.equal(Patches.water(f.player, f.id, 1), true);
    assert.equal(f.first.getId(), f.id);
    assert.equal(f.selected.getId(), Data.itemId('Watering can'));
});
test('item-on-patch watering forwards the selected inventory slot', t => {
    const f = prepare(t), patch = Data.CACHE.patches.find(p => p.type === 'ALLOTMENT');
    f.player.moveTo(new core.Location(patch.x, patch.y, patch.z));
    const farm = Patches.farmFor(f.player), crop = Data.CROPS.get('POTATO');
    const state = { ...Model.emptyPatch(Date.now(), farm), crop: crop.key,
        nextAt: Date.now() + crop.minutes * Model.MINUTE, protected: true };
    farm.patches[Data.patchKey(patch)] = state;
    hooks.onItemOnObject({ player: f.player, itemId: f.id, itemSlot: 1,
        object: { getId: () => patch.id }, location: { x: patch.x, y: patch.y, z: patch.z } });
    assert.equal(state.watered, true);
    assert.equal(f.first.getId(), f.id);
    assert.equal(f.selected.getId(), Data.itemId('Watering can(7)'));
});
test('Tithe plot item use spends the selected can', t => {
    const f = prepare(t);
    t.mock.method(core.ObjectManager, 'register', () => {});
    t.mock.method(core.ObjectManager, 'deregister', () => {});
    const seed = Data.itemId('Golovanova seed');
    f.inventory.add(new core.Item(seed), false).add(new core.Item(Data.itemId('Seed dibber')), false);
    f.player.moveTo(new core.Location(1806, 3501, 0));
    Tithe.titheLogin({ player: f.player });
    try {
        const plot = Data.CACHE.scenery.find(p => p.id === core.ObjectIdentifiers.TITHE_PATCH && p.y >= 3485);
        const location = { x: plot.x, y: plot.y, z: plot.z };
        Tithe.titheItem({ player: f.player, itemId: seed, itemSlot: 2, location });
        assert.equal(f.inventory.getAmount(seed), 0);
        Tithe.titheItem({ player: f.player, itemId: f.id, itemSlot: 1, location });
        assert.equal(f.first.getId(), f.id);
        assert.equal(f.selected.getId(), Data.itemId('Watering can(7)'));
    } finally { Tithe.titheLogout({ player: f.player }); }
});
test('a missing or mismatched selected slot never consumes an earlier matching can', t => {
    for (const mismatch of [false, true]) {
        const f = prepare(t);
        if (mismatch) f.selected.setId(Data.itemId('Spade'));
        else f.inventory.deleteAtSlot(1);
        assert.equal(Patches.water(f.player, f.id, 1), false);
        assert.equal(f.first.getId(), f.id);
    }
});
test('automatic watering without an item slot retains its existing can search', t => {
  const f = prepare(t);
  assert.equal(Patches.water(f.player), true);
  assert.equal(f.first.getId(), Data.itemId('Watering can(7)'));
  assert.equal(f.selected.getId(), f.id);
});

test('an empty can at a water source fills every carried can in one action (#216)', t => {
  const f = prepare(t);
  const empty = Data.itemId('Watering can');
  f.first.setId(empty);
  f.selected.setId(empty);
  const gricoller = Data.itemId("Gricoller's can");
  f.inventory.add(new core.Item(gricoller), false);
  f.inventory.forSlot(2).setMetaValue('farming:water', 0);
  t.mock.method(core.ObjectDefinition, 'forPlayer', () => ({ getName: () => 'Well' }));
  hooks.onItemOnObject({ player: f.player, itemId: empty, itemSlot: 0,
    object: { getId: () => 999999 }, location: { x: 2500, y: 2500, z: 0 } });
  assert.equal(f.inventory.forSlot(0).getId(), Data.itemId('Watering can(8)'));
  assert.equal(f.inventory.forSlot(1).getId(), Data.itemId('Watering can(8)'),
    'the second carried can fills too');
  assert.equal(f.inventory.forSlot(2).getMetaValue('farming:water'), 1000,
    "a carried Gricoller's can fills as well");
});
