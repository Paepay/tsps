import { CLIENT_TOKEN } from "../runelite/client/plugins/PluginInjector";
import { strict as assert } from "node:assert";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ConfigStorage } from "@runelite/client/config/ConfigStorage";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { RuneLiteConfig, SidebarMode } from "@runelite/client/config/RuneLiteConfig";
import { EventBus } from "@runelite/client/eventbus/EventBus";
import { ConfigPlugin } from "@runelite/client/plugins/config/ConfigPlugin";
import { PluginManager } from "@runelite/client/plugins/PluginManager";
import { ClientToolbar } from "@runelite/client/ui/ClientToolbar";
import { NavigationButton } from "@runelite/client/ui/NavigationButton";
import { PluginListPanel } from "@runelite/client/ui/plugin/PluginListPanel";
import { GroundItemsPlugin } from "../game/plugins/grounditems/GroundItemsPlugin";
import { MenuSwapperPlugin } from "../game/plugins/menuswapper/MenuSwapperPlugin";
import { NotesPlugin } from "../game/plugins/notes/NotesPlugin";
import { SidebarPanel } from "../game/sidebar/SidebarPanel";
import { sidebarShortcut, togglePanel } from "../game/sidebar/sidebarShortcuts";
import { SidebarStore } from "../game/sidebar/SidebarStore";
import {
    comparePlugins,
    getPinnedPlugins,
    setPluginPinned,
} from "@runelite/client/ui/plugin/pinnedPlugins";
import { imageIcon } from "@runelite/client/ui/runeliteImages";
import type { SidebarPersistedState } from "../game/sidebar/types";

class MemoryStorage implements ConfigStorage {
    private readonly values = new Map<string, string>();
    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
    removeItem(key: string): void {
        this.values.delete(key);
    }
    key(index: number): string | null {
        return [...this.values.keys()][index] ?? null;
    }
    get length(): number {
        return this.values.size;
    }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const button = (tooltip: string, priority: number): NavigationButton =>
    NavigationButton.builder().tooltip(tooltip).priority(priority).build();

async function main(): Promise<void> {
    // ClientToolbar: RuneLite's order (priority, then tooltip), each button once.
    const toolbar = new ClientToolbar();
    let changes = 0;
    toolbar.subscribe(() => changes++);
    const notes = button("Notes", 7);
    const config = button("Configuration", 0);
    const xp = button("XP Tracker", 7);
    toolbar.addNavigation(notes);
    toolbar.addNavigation(xp);
    toolbar.addNavigation(config);
    toolbar.addNavigation(notes);
    assert.deepEqual(
        toolbar.getNavigations().map((b) => b.tooltip),
        ["Configuration", "Notes", "XP Tracker"],
    );
    assert.equal(changes, 3, "adding a button twice changes nothing");
    assert.equal(
        toolbar.getNavigations(),
        toolbar.getNavigations(),
        "the same array until it changes",
    );
    const opened: string[] = [];
    toolbar.onOpenPanel((b) => opened.push(b.tooltip));
    toolbar.removeNavigation(xp);
    toolbar.openPanel(xp);
    toolbar.openPanel(notes);
    assert.deepEqual(opened, ["Notes"], "only a button that's in the toolbar opens");
    const selectedPanel = new SidebarStore();
    const offOpen = toolbar.onOpenPanel((b) => selectedPanel.select(b.tooltip));
    toolbar.openPanel(notes);
    toolbar.openPanel(notes);
    assert.equal(selectedPanel.getState().selected, "Notes", "programmatic opening selects an already-open panel rather than toggling it closed");
    offOpen();

    // Plugins add their button while enabled and remove it when turned off.
    const configManager = new ConfigManager(undefined, new MemoryStorage());
    const pluginManager = new PluginManager(new EventBus(), configManager);
    const pluginToolbar = pluginManager.getInjector().get<ClientToolbar>(ClientToolbar);
    pluginManager.getInjector().provide(CLIENT_TOKEN, {});
    pluginManager.loadCorePlugins([
        ConfigPlugin,
        NotesPlugin,
        MenuSwapperPlugin,
        GroundItemsPlugin,
    ]);
    await settle();
    const tooltips = (): string[] => pluginToolbar.getNavigations().map((b) => b.tooltip);
    assert.deepEqual(
        tooltips(),
        ["Configuration", "Menu Entry Swapper"],
        "Notes is off by default",
    );
    await pluginManager.setPluginEnabled(NotesPlugin, true);
    assert.deepEqual(tooltips(), ["Configuration", "Menu Entry Swapper", "Notes"]);
    await pluginManager.setPluginEnabled(MenuSwapperPlugin, false);
    assert.deepEqual(tooltips(), ["Configuration", "Notes"]);

    // The hub: the client's own row first, listed plugins with a switch, a cog only with settings.
    const hub = renderToStaticMarkup(
        createElement(PluginListPanel, { pluginManager, configManager }),
    );
    assert.ok(hub.indexOf("PaeScape.Online") < hub.indexOf("Ground Items"), "client settings row first");
    assert.ok(!hub.includes(">Configuration<"), "the hidden Configuration plugin isn't listed");
    assert.ok(hub.includes('aria-label="Ground Items settings"'), "a cog where there are settings");
    assert.ok(!hub.includes('aria-label="Menu Entry Swapper settings"'), "no cog without settings");
    assert.ok(hub.includes('aria-checked="false" aria-label="Enable Menu Entry Swapper"'));
    assert.ok(hub.includes('aria-checked="true" aria-label="Disable Notes"'));
    // RuneLite's rows: the description only in the tooltip, a pin star, image cog and switch.
    assert.ok(!hub.includes("rl-plugin-item-desc"), "no inline description");
    assert.ok(hub.includes('title="Ground Items:\n'), "the description is in the name's tooltip");
    assert.ok(hub.includes('aria-label="Pin Ground Items"'), "every plugin row has a pin star");
    assert.ok(!hub.includes('aria-label="Pin PaeScape.Online"'), "the client row isn't pinnable");
    assert.ok(hub.includes("/runelite/switcher_on.png") && hub.includes("/runelite/search.png"));

    // Pins: saved in runelite.pinnedPlugins, pinned plugins listed first.
    assert.deepEqual([...getPinnedPlugins(configManager)], []);
    setPluginPinned(configManager, "Notes", true);
    setPluginPinned(configManager, "Ground Items", true);
    setPluginPinned(configManager, "Ground Items", false);
    assert.equal(configManager.getConfiguration("runelite", "pinnedPlugins"), "Notes");
    const pinnedHub = renderToStaticMarkup(
        createElement(PluginListPanel, { pluginManager, configManager }),
    );
    assert.ok(pinnedHub.indexOf(">Notes<") < pinnedHub.indexOf(">Ground Items<"), "pinned first");
    assert.ok(pinnedHub.includes('aria-pressed="true" aria-label="Unpin Notes"'));
    const order = (needle: string, pinned: string[], names: string[]): string[] =>
        names
            .map((name) => ({ name, pinned: pinned.includes(name) }))
            .sort((a, b) => comparePlugins(a, b, needle))
            .map((plugin) => plugin.name);
    assert.deepEqual(order("", [], ["XP Tracker", "Camera", "Notes"]), [
        "Camera",
        "Notes",
        "XP Tracker",
    ]);
    assert.deepEqual(order("", ["XP Tracker"], ["Camera", "XP Tracker"]), ["XP Tracker", "Camera"]);
    assert.deepEqual(
        order("item", [], ["Inventory Tags", "Ground Items", "Item Prices"]),
        ["Ground Items", "Item Prices", "Inventory Tags"],
        "name words starting with the search, then other matches",
    );

    // Reset puts a group back to its defaults; panels dock beside the game, as RuneLite's.
    const runeLiteConfig = configManager.getConfig(RuneLiteConfig);
    assert.equal(runeLiteConfig.sidebarMode(), SidebarMode.Docked);
    configManager.setConfigValue(RuneLiteConfig, "sidebarMode", SidebarMode.Overlay);
    assert.equal(configManager.getConfiguration("runelite", "sidebarMode"), "Overlay");
    assert.equal(runeLiteConfig.sidebarMode(), SidebarMode.Overlay);
    configManager.setDefaultConfiguration(RuneLiteConfig, true);
    assert.equal(runeLiteConfig.sidebarMode(), SidebarMode.Docked);

    // A panel is the plugin's content only: no header or close button.
    const panelButton = NavigationButton.builder()
        .tooltip("Notes")
        .icon(imageIcon("/runelite/notes_icon.png"))
        .panel(() => createElement("p", null, "body"))
        .build();
    const panel = renderToStaticMarkup(createElement(SidebarPanel, { button: panelButton }));
    assert.ok(panel.includes('aria-label="Notes"') && panel.includes("<p>body</p>"));
    assert.ok(!panel.includes("header") && !panel.includes("Close"), "no header or close button");
    const Icon = panelButton.icon!;
    const icon = renderToStaticMarkup(createElement(Icon, { label: "Notes" }));
    assert.ok(icon.includes("<img") && !icon.includes("<svg"), "an image, not line art");
    assert.ok(icon.includes('width="16"') && icon.includes('alt="Notes"'));

    // SidebarStore: a rail click opens, a second click closes, and the open panel is remembered.
    let saved: SidebarPersistedState | undefined = {
        open: true,
        selectedId: "plugin_hub",
        collapsed: false,
    };
    const persistence = {
        load: () => saved,
        save: (state: SidebarPersistedState) => (saved = state),
    };
    const store = new SidebarStore(persistence);
    assert.equal(store.getState().selected, "plugin_hub", "an old saved id just matches no button");
    store.toggle("Notes");
    assert.deepEqual(saved, { open: true, selectedId: "Notes", collapsed: false });
    store.toggle("Notes");
    assert.equal(store.getState().selected, null);
    assert.deepEqual(
        saved,
        { open: false, selectedId: "Notes", collapsed: false },
        "a closed panel is remembered for Ctrl+F12",
    );
    const reloaded = new SidebarStore({
        load: () => ({ open: false, selectedId: "Notes", collapsed: false }),
        save() {},
    });
    assert.equal(reloaded.getState().selected, null);
    assert.equal(reloaded.getLastSelected(), "Notes");

    // Hiding the whole sidebar (Ctrl+F11): saved, and the open panel comes back with it.
    store.select("Notes");
    store.toggleCollapsed();
    assert.deepEqual(store.getState(), { selected: "Notes", collapsed: true });
    assert.deepEqual(saved, { open: true, selectedId: "Notes", collapsed: true });
    store.toggleCollapsed();
    assert.deepEqual(store.getState(), { selected: "Notes", collapsed: false });
    // Saves from before the sidebar could be hidden have no flag: shown.
    const legacy = { open: true, selectedId: "Notes" } as unknown as SidebarPersistedState;
    assert.equal(new SidebarStore({ load: () => legacy, save() {} }).getState().collapsed, false);

    // Ctrl+F12: close the open panel; reopen the last one, or the first panel if it's gone.
    const keys = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false };
    assert.equal(sidebarShortcut({ ...keys, key: "F11" }), "toggleSidebar");
    assert.equal(sidebarShortcut({ ...keys, key: "F12" }), "togglePanel");
    assert.equal(sidebarShortcut({ ...keys, key: "F12", shiftKey: true }), null);
    assert.equal(sidebarShortcut({ ...keys, key: "F11", ctrlKey: false }), null);
    const withPanel = (tooltip: string): NavigationButton =>
        NavigationButton.builder()
            .tooltip(tooltip)
            .panel(() => null)
            .build();
    const panels = [withPanel("Configuration"), withPanel("Notes")];
    togglePanel(store, panels);
    assert.equal(store.getState().selected, null);
    togglePanel(store, panels);
    assert.equal(store.getState().selected, "Notes");
    store.select(null);
    togglePanel(store, [withPanel("Configuration")]);
    assert.equal(store.getState().selected, "Configuration", "the last panel's plugin is off");
    store.toggleCollapsed();
    togglePanel(store, panels);
    assert.deepEqual(
        store.getState(),
        { selected: "Configuration", collapsed: false },
        "on a hidden sidebar, Ctrl+F12 shows it with its panel",
    );

    console.log("runelite-client-toolbar.test.ts: all tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
