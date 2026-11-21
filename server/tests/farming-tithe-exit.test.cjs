// #52: the Tithe Farm door: its own tile is inside the area, and leaving moves the player out.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { ClientConnection } = require("../dist/net/NetworkBuilder");
const ROOT = path.resolve(__dirname, "..");
let core, Patches, Tithe, Data;

before(async () => {
    await CachePipeline.initialize(ROOT);
    PluginManager.loadFromDirectory(path.join(ROOT, "plugins"));
    core = PluginManager.getCoreApi();
    core.RegionManager.init();
    core.RegionManager.loadMapFiles(1800, 3500);
    Patches = require("../plugins/skills/farming/Patches.Farming");
    Tithe = require("../plugins/skills/farming/Tithe.Farming");
    Data = require("../plugins/skills/farming/Data.Farming");
    Data.initializeFarmingData();
});

function channel() {
    return { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true,
        close() {}, onData() {}, onError() {}, onClose() {} };
}

function actor(t, at) {
    const transport = channel();
    const player = new Player(new PlayerSession(transport));
    player.setUsername("titheexit" + Math.floor(Math.random() * 1e6));
    player.setIndex(500 + Math.floor(Math.random() * 400));
    player.setRegistered(true);
    player.setLocation(new core.Location(...at));
    player.needsPlacement = false;
    player.getSkillManager().setMaxLevels(core.Skill.FARMING, 99);
    const connection = new ClientConnection(transport);
    connection.player = player;
    const seeds = Data.itemId("Golovanova seed");
    player.getInventory().add(new core.Item(seeds, 10), false);
    const messages = [];
    t.mock.method(player.getPacketSender(), "sendMessage", (text) => { messages.push(String(text)); return player.getPacketSender(); });
    return { player, connection, messages, seeds };
}

const door = () => ({ getId: () => core.ObjectIdentifiers.FARM_DOOR, getLocation: () => new core.Location(1805, 3501, 0) });

async function leave(f) {
    const menu = f.player.getDialogueManager().getCurrent();
    assert.ok(menu, "the leave menu opened");
    assert.equal(menu.getOptions()[0], "Leave and discard this batch");
    await f.connection.dispatch([{ type: "dialogue_continue", widgetId: core.OptionDialogue.OPTIONS_WIDGET_ID, childIndex: 1 }]);
    f.connection.processTurnPackets();
    const at = f.player.getLocation();
    assert.deepEqual([at.getX(), at.getY()], [1804, 3501], "outside the doors");
    assert.equal(f.player.getInventory().getAmount(f.seeds), 0, "the batch is discarded");
}

test("the door's leave choice moves the player outside the farm and keeps the seeds out", async (t) => {
    const f = actor(t, [1806, 3501, 0]);
    Tithe.titheLogin({ player: f.player });
    assert.ok(f.player.getArea(), "in the farm");
    Tithe.titheObject({ player: f.player, object: door() });
    await leave(f);
});

test("standing on the door tile still offers to leave, not the prep room's seed message", async (t) => {
    const f = actor(t, [1805, 3501, 0]);
    Tithe.titheLogin({ player: f.player });
    Tithe.titheObject({ player: f.player, object: door() });
    assert.ok(!f.messages.includes("Take some seeds from the table first."), "the door tile is inside the farm");
    await leave(f);
});
