import { strict as assert } from "node:assert";
import { EVENT_CLASSES, NpcSpawned } from "@runelite/api/events";
import { ConfigManager, parseConfigValue, serializeConfigValue } from "@runelite/client/config/ConfigManager";
import { EventBus } from "@runelite/client/eventbus/EventBus";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ClientState } from "../game/ClientState";
import { NpcEcs } from "../game/ecs/NpcEcs";
import { ClientPluginManager } from "../game/plugins/ClientPluginManager";
import { NpcIndicatorsConfig } from "../game/plugins/npcindicators/NpcIndicatorsConfig";
import { NpcIndicatorsPlugin } from "../game/plugins/npcindicators/NpcIndicatorsPlugin";
import { NpcOverlay } from "../game/plugins/npcindicators/NpcOverlay";
import { MenuTargetType } from "../rs/MenuEntry";
import { bindNpcEvents } from "../runelite/impl/NpcEventSource";
import type { SimpleMenuEntry } from "../ui/menu/MenuEngine";
import { GLRenderer } from "../widgets/gl/renderer";

const SHIFT = 81;
const GOBLIN = 655, CHICKEN = 1173, PET = 6720;
const types: Record<number, any> = {
    [GOBLIN]: { name: "Goblin", size: 1, actions: ["Attack", null, null, null, "Examine"], isInteractable: true, isFollower: false, params: new Map() },
    [CHICKEN]: { name: "Chicken", size: 1, actions: ["Attack", null, null, null, "Examine"], isInteractable: true, isFollower: false, params: new Map() },
    [PET]: { name: "Goblin", size: 1, actions: [null, null, null, null, "Examine"], isInteractable: true, isFollower: true, params: new Map() },
};

// --- Core: events from NPC store mutations, server NPCs only ---------------------------------
assert.ok(EVENT_CLASSES.NpcSpawned && EVENT_CLASSES.NpcDespawned && EVENT_CLASSES.NpcChanged);
const npcs = new NpcEcs(16);
const bus = new EventBus();
const seen: string[] = [];
bus.register({
    onNpcSpawned: (e: any) => seen.push(`spawn ${e.getNpc().index}`),
    onNpcDespawned: (e: any) => seen.push(`despawn ${e.getNpc().index}`),
    onNpcChanged: (e: any) => seen.push(`change ${e.getNpc().index} ${e.getOld()}->${e.getNpc().id}`),
});
bindNpcEvents(npcs, (event) => bus.post(event));
const npcAt = (type: number, tileX: number, tileY: number) =>
    npcs.createNpc(50, 50, type, 1, (tileX - 3200) * 128 + 64, (tileY - 3200) * 128 + 64, 0, 0, tileX, tileY);
const statik = npcAt(GOBLIN, 3201, 3201);
npcs.destroyNpc(statik);
assert.deepEqual(seen, [], "client-only (map) NPCs post nothing");
const goblin = npcAt(GOBLIN, 3203, 3203);
npcs.setServerMapping(goblin, 11);
npcs.setNpcTypeId(goblin, CHICKEN);
npcs.setNpcTypeId(goblin, GOBLIN);
assert.deepEqual(seen, ["spawn 11", `change 11 ${GOBLIN}->${CHICKEN}`, `change 11 ${CHICKEN}->${GOBLIN}`]);

// --- Core: alpha colours round-trip, and an alpha of 0x80+ isn't lost -------------------------
const alphaItem = { color: true, alpha: true, default: 0 } as any;
assert.equal(serializeConfigValue(alphaItem, 0xff00ffff), "#ff00ffff");
assert.equal(parseConfigValue(alphaItem, "#1400ffff"), 0x1400ffff);

// --- Core: polygon primitives emit triangles into the solid batch -----------------------------
{
    const glr: any = Object.create(GLRenderer.prototype);
    glr.solidBatchData = new Float32Array(4096);
    glr.solidBatchFloatCount = 0;
    glr.flushTextureBatch = () => {};
    glr.flushSolidBatch = () => {};
    glr.drawPolygon([[0, 0], [10, 0], [10, 10], [0, 10]], [1, 0, 0, 1]);
    assert.equal(glr.solidBatchFloatCount, 2 * 3 * 6, "a quad is a two-triangle fan");
    glr.solidBatchFloatCount = 0;
    glr.drawPolyline([[0, 0], [10, 0], [10, 10]], 2, [1, 0, 0, 1], true);
    assert.equal(glr.solidBatchFloatCount, 3 * 2 * 3 * 6, "three closed segments, two triangles each");
    assert.deepEqual([...glr.solidBatchData.slice(0, 2)], [-1, 1], "segment widened by half the width");
    glr.solidBatchFloatCount = 0;
    glr.drawPolygon([[0, 0], [1, 1], [2, 0]], [1, 0, 0, 0]);
    assert.equal(glr.solidBatchFloatCount, 0, "transparent: nothing");
}

// --- Core: plugin NPC outlines are collected ------------------------------------------------------
{
    const manager = new ClientPluginManager();
    manager.add({ npcOutlines: () => [{ ecsId: 1, serverId: 2, color: 0xff, alpha: 1, width: 2 }] } as any);
    assert.equal(manager.npcOutlines().length, 1);
}

// --- The plugin ------------------------------------------------------------------------------------
const client: any = {
    gameState: 30,
    npcEcs: npcs,
    npcTypeLoader: { load: (id: number) => types[id] },
    varManager: {},
    controlledPlayerServerId: 1,
    playerEcs: { getIndexForServerId: () => 0, getX: () => 3200 * 128, getY: () => 3200 * 128, getLevel: () => 0 },
    sceneGeometry: {
        tileHeight: () => 0,
        worldToScreen: (x: number, h: number, y: number) => [x * 10, y * 10 + h * 10],
        npcModelPoints: () => [[3203, -1, 3203], [3204, -1, 3203], [3204, 0, 3204], [3203.5, -0.5, 3203.5]],
        npcHeight: () => 100,
    },
    minimapGeometry: { drawnAt: 0, plane: 0, scale: 1, worldToMinimap: (x: number, y: number) => [x, y] },
};

async function main(): Promise<void> {
    const config = inject(ConfigManager);
    const set = (key: string, value: unknown) => config.setConfigValue(NpcIndicatorsConfig, key as any, value);
    set("npcToHighlight", "Goblin");
    const plugin = new NpcIndicatorsPlugin(client);
    const pluginBus = new EventBus();
    pluginBus.register(plugin);
    bindNpcEvents(npcs, (event) => pluginBus.post(event));
    await plugin.start();
    assert.ok(plugin.highlightedNpcs.has(goblin), "rebuild finds loaded NPCs by name");

    // #223: a moving tagged NPC changes the overlay signature every frame. The widget layer uses
    // coverage() to repaint only what moved, so it must be finite and follow the NPC.
    set("drawNames", true);
    assert.equal(new NpcOverlay(plugin).coverage(), undefined,
        "text coverage waits for the draw's font loader");
    set("drawNames", false);
    const overlay = plugin.widgetOverlay as NpcOverlay;
    const renderer = new Proxy({}, { get: () => () => {} });
    const font = { measure: (text: string) => text.length * 7, maxAscent: 12, maxDescent: 4 };
    const fontLoader = () => font as any;
    const plainRects = overlay.coverage()!;
    assert.ok(plainRects.length > 0, "the hull and minimap dot report coverage");
    assert.ok(plainRects.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.w >= 0 && r.h >= 0));
    overlay.draw({ renderer, fontLoader } as any);
    set("drawNames", true);
    const namedRects = overlay.coverage()!;
    assert.ok(namedRects.length > plainRects.length, "the name adds its measured rect");
    assert.ok(namedRects.every((r) => Number.isFinite(r.x) && Number.isFinite(r.y) && r.w > 0 && r.h > 0));
    const beforeMove = overlay.signature();
    const beforeBounds = namedRects.map((r) => [r.x, r.y, r.w, r.h].join(",")).join("|");
    npcs.setXY(goblin, 448 + 128, 448);
    assert.notEqual(overlay.signature(), beforeMove, "the signature tracks the NPC");
    // The widget layer calls signature() before coverage(), so this is the next draw's frame.
    const movedRects = overlay.coverage()!;
    assert.notEqual(movedRects.map((r) => [r.x, r.y, r.w, r.h].join(",")).join("|"), beforeBounds,
        "coverage follows the moved NPC");
    set("drawNames", false);

    const chicken = npcAt(CHICKEN, 3205, 3205);
    npcs.setServerMapping(chicken, 12);
    assert.ok(!plugin.highlightedNpcs.has(chicken), "not on the list");

    // Overlay: hull by default, a minimap dot each; nothing for unlisted NPCs.
    client.minimapGeometry.drawnAt = performance.now();
    const sig = plugin.widgetOverlay.signature();
    assert.notEqual(sig, "");
    const frame = JSON.parse(sig);
    assert.equal(frame[0].length, 1, "one hull");
    assert.equal(frame[2].length, 1, "one minimap dot");
    assert.equal(plugin.widgetOverlay.drawBelowWidgets, true, "under the widgets, as ABOVE_SCENE");

    // Shift + right-click Examine: Tag options above Examine.
    const menuFor = (index: number, name: string): SimpleMenuEntry[] => [
        { option: "Attack", target: `<col=ffff00>${name}<col=00ff00>  (level-2)`, targetType: MenuTargetType.NPC, npcServerId: index },
        { option: "Examine", target: `<col=ffff00>${name}<col=00ff00>  (level-2)`, targetType: MenuTargetType.NPC, npcServerId: index },
        { option: "Cancel", target: "" },
    ];
    const world = { surface: "world", menu: true } as const;
    ClientState.setKeybindState(SHIFT, false);
    assert.deepEqual(plugin.transformMenuEntries(menuFor(12, "Chicken"), world).map((e) => e.option),
        ["Attack", "Examine", "Cancel"], "no Shift: no tag options");
    ClientState.setKeybindState(SHIFT, true);
    let menu = plugin.transformMenuEntries(menuFor(11, "Goblin"), world);
    assert.deepEqual(menu.map((e) => e.option), ["Attack", "Tag", "Un-tag-All", "Tag color", "Tag style", "Examine", "Cancel"]);
    assert.deepEqual(menu[3].subEntries!.map((e) => e.option),
        ["<col=ff0000>Set color", "<col=00ff00>Set color", "<col=0000ff>Set color", "<col=ffff00>Set color", "<col=ff00ff>Set color", "Pick color"]);
    assert.deepEqual(menu[4].subEntries!.map((e) => e.option),
        ["Hull", "Tile", "True tile", "South-west tile", "South-west true tile", "Outline"]);
    menu = plugin.transformMenuEntries(menuFor(12, "Chicken"), world);
    assert.deepEqual(menu.map((e) => e.option), ["Attack", "Tag", "Tag-All", "Examine", "Cancel"]);

    // Tag the chicken by index; colour and style are per NPC id.
    menu[1].onClick!();
    assert.ok(plugin.npcTags.has(12) && plugin.highlightedNpcs.has(chicken));
    menu = plugin.transformMenuEntries(menuFor(12, "Chicken"), world);
    assert.equal(menu[1].option, "Un-tag");
    menu[3].subEntries![0].onClick!();
    assert.equal(config.getConfiguration("npcindicators", `highlightcolor_${CHICKEN}`), "#ff0000");
    assert.equal(plugin.highlightedNpcs.get(chicken)!.color, 0xff0000);
    menu = plugin.transformMenuEntries(menuFor(12, "Chicken"), world);
    assert.equal(menu[3].subEntries![0].option, "<col=ff0000>Set color", "colours in use come first");
    assert.equal(menu[3].subEntries!.at(-1)!.option, "Reset");
    menu[4].subEntries!.find((e) => e.option === "Outline")!.onClick!();
    assert.equal(config.getConfiguration("npcindicators", `tagstyle_${CHICKEN}`), "outline");
    assert.deepEqual(plugin.npcOutlines().map((o) => o.serverId), [12], "only the outline-styled NPC");
    assert.equal(plugin.highlightedNpcs.get(chicken)!.flags.hull, false, "a tag style replaces the global styles");

    // Tag-All edits the list; Un-tag-All removes the name.
    menu = plugin.transformMenuEntries(menuFor(12, "Chicken"), world);
    menu.find((e) => e.option === "Tag-All")!.onClick!();
    assert.equal(config.getConfiguration("npcindicators", "npcToHighlight"), "Goblin,Chicken");
    plugin.rebuild(); // ConfigChanged, as the client's bus delivers it
    menu = plugin.transformMenuEntries(menuFor(12, "Chicken"), world);
    menu.find((e) => e.option === "Un-tag-All")!.onClick!();
    assert.equal(config.getConfiguration("npcindicators", "npcToHighlight"), "Goblin");
    plugin.rebuild();
    assert.ok(plugin.highlightedNpcs.has(chicken), "still tagged by index");
    ClientState.setKeybindState(SHIFT, false);

    // Menu recolouring of highlighted NPCs.
    set("highlightMenuStyle", "NAME");
    menu = plugin.transformMenuEntries(menuFor(11, "Goblin"), world);
    assert.equal(menu[0].target, "<col=00ffff>Goblin<col=00ff00>  (level-2)");

    // Dead NPCs: not drawn, menu in the dead colour.
    plugin.onHealthBar({ type: "npc", serverId: 11, bar: { id: 0, health: 0, health2: 0 } });
    assert.ok(plugin.isDying(goblin));
    assert.ok(!plugin.shouldDraw(plugin.highlightedNpcs.get(goblin)!));
    set("deadNpcMenuColor", 0xff808080);
    menu = plugin.transformMenuEntries(menuFor(11, "Goblin"), world);
    assert.equal(menu[0].target, "<col=808080>Goblin  (level-2)");
    set("ignoreDeadNpcs", false);
    assert.ok(plugin.shouldDraw(plugin.highlightedNpcs.get(goblin)!));
    set("ignoreDeadNpcs", true);

    // Pets are ignored by default.
    const pet = npcAt(PET, 3207, 3207);
    npcs.setServerMapping(pet, 13);
    assert.ok(plugin.highlightedNpcs.has(pet), "a pet named Goblin matches");
    assert.ok(!plugin.shouldDraw(plugin.highlightedNpcs.get(pet)!), "but isn't drawn");

    // Changed and despawned NPCs (spawned while the plugin listens).
    const changer = npcAt(GOBLIN, 3202, 3208);
    npcs.setServerMapping(changer, 14);
    assert.ok(plugin.highlightedNpcs.has(changer));
    npcs.setNpcTypeId(changer, CHICKEN);
    assert.ok(!plugin.highlightedNpcs.has(changer), "no longer a goblin");
    npcs.setNpcTypeId(changer, GOBLIN);
    assert.ok(plugin.highlightedNpcs.has(changer));
    npcs.destroyNpc(changer);
    assert.ok(!plugin.highlightedNpcs.has(changer));

    // Logged out: nothing drawn. Shutdown forgets tags (they are not saved).
    client.gameState = 10;
    assert.equal(plugin.widgetOverlay.signature(), "");
    assert.deepEqual(plugin.npcOutlines(), []);
    client.gameState = 30;
    await plugin.stop();
    assert.equal(plugin.npcTags.size, 0);
    assert.equal(plugin.transformMenuEntries(menuFor(12, "Chicken"), world).length, 3);
    void NpcSpawned;
}

main()
    .then(() => console.log("npc indicators plugin tests passed"))
    .catch((err) => {
        console.error(err);
        process.exit(1);
    });
