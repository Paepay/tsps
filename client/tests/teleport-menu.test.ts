import { strict as assert } from "node:assert";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ConfigChanged } from "@runelite/api/events";
import { PluginMessage } from "@runelite/api/events/PluginMessage";
import { InputManager } from "../game/InputManager";
import { TeleportMenuConfig } from "../game/plugins/teleportmenu/TeleportMenuConfig";
import { TeleportMenuPlugin } from "../game/plugins/teleportmenu/TeleportMenuPlugin";
import { TeleportMenuOverlay } from "../game/plugins/teleportmenu/TeleportMenuOverlay";
import {
    Handedness,
    LEFT_HANDED_CODES,
    LEFT_HANDED_LABELS,
    MENU_SHORTCUT_COUNT,
    RIGHT_HANDED_CODES,
    RIGHT_HANDED_LABELS,
    activationAt,
    commandForKey,
    isTextEntryElement,
    isTypingContext,
    nextSelection,
    parseTeleportMenuScreen,
    shortcutForCode,
    shortcutLabels,
    type TeleportMenuEntry,
    type TeleportMenuScreen,
} from "../game/plugins/teleportmenu/teleportMenuModel";

const windowKeys = new Set<(event: KeyboardEvent) => void>();
const windowPointers = new Set<(event: MouseEvent | TouchEvent) => void>();
(globalThis as { window?: unknown }).window = {
    addEventListener(type: string, listener: EventListener) {
        if (type === "keydown" && typeof listener === "function") {
            windowKeys.add(listener as (event: KeyboardEvent) => void);
        } else if ((type === "mousedown" || type === "touchstart") && typeof listener === "function") {
            windowPointers.add(listener as (event: MouseEvent | TouchEvent) => void);
        }
    },
    removeEventListener(type: string, listener: EventListener) {
        if (type === "keydown" && typeof listener === "function") {
            windowKeys.delete(listener as (event: KeyboardEvent) => void);
        } else if ((type === "mousedown" || type === "touchstart") && typeof listener === "function") {
            windowPointers.delete(listener as (event: MouseEvent | TouchEvent) => void);
        }
    },
};

assert.deepEqual([...RIGHT_HANDED_CODES], [..."asdfqwerzxcv"].map((key) => {
    const names: Record<string, string> = {
        a: "KeyA", s: "KeyS", d: "KeyD", f: "KeyF", q: "KeyQ", w: "KeyW",
        e: "KeyE", r: "KeyR", z: "KeyZ", x: "KeyX", c: "KeyC", v: "KeyV",
    };
    return names[key];
}));
assert.deepEqual([...LEFT_HANDED_CODES], ["Semicolon", "KeyL", "KeyK", "KeyJ", "KeyP", "KeyO", "KeyI", "KeyU", "Period", "KeyM", "Comma", "KeyN"]);
assert.deepEqual([...RIGHT_HANDED_LABELS], [..."ASDFQWERZXCV"]);
assert.deepEqual([...LEFT_HANDED_LABELS], [...";LKJPOIU.M,N"]);
assert.equal(RIGHT_HANDED_CODES.length, MENU_SHORTCUT_COUNT);
assert.equal(LEFT_HANDED_CODES.length, MENU_SHORTCUT_COUNT);
assert.deepEqual([...shortcutLabels(Handedness.LEFT)], [...";LKJPOIU.M,N"]);

const entries: TeleportMenuEntry[] = [
    { index: 0, label: "First", locked: false },
    { index: 1, label: "Second", locked: true, reason: "Unlock Asgarnia first." },
    { index: 2, label: "Third", locked: false },
];
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyA", entries)?.entry.label, "First");
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyS", entries)?.entry.label, "Second");
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyD", entries)?.entry.label, "Third");
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyF", entries), undefined, "past the visible entries");
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyA", entries)?.position, 0);
assert.equal(shortcutForCode(Handedness.LEFT, "Semicolon", entries)?.entry.label, "First");
assert.equal(shortcutForCode(Handedness.LEFT, "Period", entries), undefined, "only three entries here");
assert.equal(shortcutForCode(Handedness.LEFT, "Semicolon", entries)?.label, ";");
assert.equal(shortcutForCode(Handedness.RIGHT, "Semicolon", entries), undefined, "the other hand's keys do nothing");

function screen(overrides: Partial<TeleportMenuScreen> = {}): TeleportMenuScreen {
    return {
        session: 7,
        stage: "regions",
        title: "Select a region",
        page: 0,
        pages: 1,
        total: entries.length,
        canBack: false,
        entries,
        ...overrides,
    };
}

// The destination screen reuses a,s,d,... from its first visible entry: shortcuts reset each stage.
const destination = screen({ stage: "destinations", title: "Asgarnia", canBack: true, entries: [
    { index: 9, label: "Falador", locked: false },
    { index: 10, label: "Taverley", locked: false },
] });
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyA", destination.entries)?.entry.index, 9);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyS", destination.entries)?.entry.index, 10);

// More than twelve options page cleanly, and each page's first key is position zero again.
const fifteen: TeleportMenuEntry[] = Array.from({ length: 15 }, (_, index) => ({ index, label: `Entry ${index + 1}`, locked: false }));
const pageOne = fifteen.slice(0, 12);
const pageTwo = fifteen.slice(12);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyA", pageOne)?.entry.index, 0);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyV", pageOne)?.entry.index, 11);
assert.equal(shortcutForCode(Handedness.LEFT, "Period", pageOne)?.position, 8);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyA", pageTwo)?.entry.index, 12);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyD", pageTwo)?.entry.index, 14);
assert.equal(shortcutForCode(Handedness.RIGHT, "KeyV", pageTwo), undefined);
const seen = [...pageOne, ...pageTwo].map((entry) => entry.index);
assert.equal(new Set(seen).size, 15, "no entry repeats or is lost across pages");

assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "Escape", 0), { type: "close" });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "Backspace", 0), { type: "consume" }, "no Back on regions");
assert.deepEqual(commandForKey(Handedness.RIGHT, destination, "Backspace", 0), { type: "back" });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "ArrowDown", 0), { type: "move", delta: 1 });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "PageDown", 0), { type: "page", delta: 1 });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "Enter", 1), { type: "activate", position: 1 });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "KeyD", 0), { type: "activate", position: 2 });
assert.deepEqual(commandForKey(Handedness.RIGHT, screen(), "Space", 0), { type: "consume" });
assert.equal(nextSelection(0, 3, -1), 0, "clamped at the top");
assert.equal(nextSelection(2, 3, 1), 2, "clamped at the bottom");
assert.equal(nextSelection(1, 3, 1), 2);

assert.deepEqual(activationAt(screen(), 1), { kind: "locked", message: "Unlock Asgarnia first." });
assert.deepEqual(activationAt(screen(), 2), { kind: "send", data: { type: "region", session: 7, index: 2 } });
assert.deepEqual(activationAt(destination, 0), { kind: "send", data: { type: "destination", session: 7, index: 9 } });

assert.equal(isTextEntryElement({ tagName: "INPUT" } as unknown as Element), true);
assert.equal(isTextEntryElement({ tagName: "DIV" } as unknown as Element), false);
assert.equal(isTypingContext({ meslayerMode: 1 }), true, "chat");
assert.equal(isTypingContext({ textInputActive: true }), true, "a widget input");
assert.equal(isTypingContext({ activeElement: { tagName: "TEXTAREA" } as unknown as Element }), true);
assert.equal(isTypingContext({ meslayerMode: 0, textInputActive: false, activeElement: null }), false);

const parsed = parseTeleportMenuScreen({ type: "screen", ...screen() });
assert.ok(parsed);
assert.equal(parsed?.entries.length, 3);
assert.equal(parseTeleportMenuScreen({ type: "screen", ...screen(), session: -1 }), undefined, "bad session");
assert.equal(parseTeleportMenuScreen({ type: "screen", ...screen(), entries: new Array(13).fill(entries[0]) }), undefined, "shortcut overflow");

// The plugin's keyboard loop: arrows move, Enter reports a locked reason, Escape closes.
const client: any = {
    inputManager: new InputManager(),
    varManager: { getVarcInt: () => 0 },
    isWidgetTextInputActive: () => false,
    isOnLoginScreen: () => false,
};
const plugin = new TeleportMenuPlugin(client);
void (plugin as any).startUp();
plugin.onPluginMessage(new PluginMessage("teleport-menu", { type: "screen", ...screen() }));
assert.equal(plugin.getSnapshot().screen?.title, "Select a region");
assert.equal(windowKeys.size, 1, "the open menu captures keys even when the canvas lacks focus");
let prevented = false;
let stopped = false;
for (const listener of windowKeys) {
    listener({
        code: "KeyS",
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        repeat: false,
        preventDefault: () => { prevented = true; },
        stopPropagation: () => { stopped = true; },
    } as KeyboardEvent);
}
assert.equal(plugin.getSnapshot().message, "Unlock Asgarnia first.", "a window shortcut reaches the menu");
assert.equal(prevented, true, "the menu prevents the shortcut's browser default");
assert.equal(stopped, true, "the menu stops the shortcut reaching the canvas");
assert.equal(plugin.onKeyDown({ code: "ArrowDown", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent), true);
assert.equal(plugin.getSnapshot().selected, 1);
plugin.onKeyDown({ code: "Enter", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent);
assert.equal(plugin.getSnapshot().message, "Unlock Asgarnia first.");
assert.equal(plugin.getSnapshot().screen?.title, "Select a region", "a locked option keeps the menu open");
plugin.onKeyDown({ code: "Enter", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent);
assert.equal(plugin.getSnapshot().message, "Unlock Asgarnia first.");

const html = renderToStaticMarkup(createElement(TeleportMenuOverlay, { osrsClient: client, plugin }));
assert.match(html, /Select a region/);
assert.match(html, /teleport-menu-key[^>]*>A</, "right-handed first shortcut");
assert.match(html, /Unlock Asgarnia first\./, "locked reason is visible");
assert.match(html, /is-locked/);

// WASD camera drops arrows and rewrites letters before ordinary key handlers. The menu registers
// before that remap, so its physical shortcuts and navigation still arrive unchanged.
client.inputManager.keyRemapper = {
    isChatInputBlocked: () => false,
    remapKeyDown: () => null,
    remapKeyUp: () => null,
};
plugin.setSelected(0);
client.inputManager.onKeyDown({ code: "ArrowDown", key: "ArrowDown", keyCode: 40, repeat: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} } as KeyboardEvent);
assert.equal(plugin.getSnapshot().selected, 1, "the menu receives arrows before WASD camera drops them");
client.inputManager.onKeyDown({ code: "KeyS", key: "s", keyCode: 83, repeat: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} } as KeyboardEvent);
assert.equal(plugin.getSnapshot().message, "Unlock Asgarnia first.", "the physical shortcut reaches the menu before remapping");
plugin.onPluginMessage(new PluginMessage("teleport-menu", { type: "screen", ...screen() }));

// The open menu owns every game key, even when the game still reports a chat or widget text input.
client.varManager.getVarcInt = () => 1;
client.isWidgetTextInputActive = () => true;
assert.equal(plugin.onKeyDown({ code: "KeyS", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent), true);
assert.equal(plugin.getSnapshot().message, "Unlock Asgarnia first.", "a shortcut still acts while text input is reported");
assert.equal(plugin.onKeyDown({ code: "ArrowDown", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent), true);
assert.equal(plugin.getSnapshot().selected, 1, "navigation still acts while text input is reported");
assert.equal(plugin.onKeyDown({ code: "KeyY", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent), true, "an unmapped key is consumed");
assert.equal(plugin.getSnapshot().selected, 1, "an unmapped key has no game action");
client.varManager.getVarcInt = () => 0;
client.isWidgetTextInputActive = () => false;
plugin.onPluginMessage(new PluginMessage("teleport-menu", { type: "screen", ...screen() }));

// A movement or combat click reaches the world and closes the menu; clicking inside the panel does not.
assert.equal(windowPointers.size, 1, "the window closes the menu on world input");
for (const listener of windowPointers) {
    listener({ target: { closest: () => ({}) } } as unknown as MouseEvent);
}
assert.equal(plugin.getSnapshot().screen?.title, "Select a region", "a click inside the panel leaves the menu open");
for (const listener of windowPointers) {
    listener({ target: { closest: () => null } } as unknown as MouseEvent);
}
assert.equal(plugin.getSnapshot().screen, null, "a movement or combat click closes the menu");
assert.equal(windowKeys.size, 0, "the key listener goes away with the menu");
assert.equal(windowPointers.size, 0, "the pointer listener goes away with the menu");

// Handedness changes immediately, and changing the setting redraws with the other key labels.
const config = inject(ConfigManager);
config.setConfigValue(TeleportMenuConfig, "handedness", Handedness.LEFT);
plugin.onPluginMessage(new PluginMessage("teleport-menu", { type: "screen", ...screen() }));
plugin.onConfigChanged(new ConfigChanged(TeleportMenuConfig.group, "handedness", "RIGHT", "LEFT"));
assert.equal(plugin.getSnapshot().handedness, Handedness.LEFT);
plugin.onPluginMessage(new PluginMessage("teleport-menu", { type: "screen", ...screen({
    entries: [{ index: 0, label: "Left-handed lock", locked: true, reason: "Left-handed reason." }],
}) }));
const leftHtml = renderToStaticMarkup(createElement(TeleportMenuOverlay, { osrsClient: client, plugin }));
assert.match(leftHtml, /teleport-menu-key[^>]*>;</, "left-handed first shortcut");
client.inputManager.onKeyDown({ code: "Semicolon", key: ";", keyCode: 186, repeat: false, ctrlKey: false, altKey: false, metaKey: false, preventDefault() {} } as KeyboardEvent);
assert.equal(plugin.getSnapshot().message, "Left-handed reason.", "semicolon works without Shift");
assert.equal(plugin.onKeyDown({ code: "Escape", ctrlKey: false, altKey: false, metaKey: false } as KeyboardEvent), true);
assert.equal(plugin.getSnapshot().screen, null);
assert.equal(windowKeys.size, 0, "the window listener goes away with the menu");
assert.equal(windowPointers.size, 0, "the pointer listener goes away with the menu");
config.setConfigValue(TeleportMenuConfig, "handedness", Handedness.RIGHT);

console.log("teleport menu test passed");
