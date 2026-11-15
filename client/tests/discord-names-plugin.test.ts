import { strict as assert } from "node:assert";
import { GameState } from "@runelite/api/GameState";
import { ConfigChanged, GameStateChanged, PluginMessage } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { DiscordNamesConfig } from "../game/plugins/discordnames/DiscordNamesConfig";
import {
    DISCORD_NAMES_CHANNEL,
    DiscordNamesPlugin,
} from "../game/plugins/discordnames/DiscordNamesPlugin";
import {
    formatDiscordChatName,
    leadingChatIcons,
    normalizePlayerName,
    stripChatIcons,
    wrapWithColorTag,
} from "../game/plugins/discordnames/discordNameText";

assert.equal(DiscordNamesPlugin.descriptor.name, "Discord Names");
assert.equal(DiscordNamesPlugin.descriptor.enabledByDefault, true);
assert.equal(DiscordNamesPlugin.descriptor.configKey, "discordnamesplugin");
assert.equal(DiscordNamesConfig.group, "discordnames");
assert.equal(DiscordNamesConfig.items.brackets.default, true);

assert.equal(stripChatIcons("<img=1><img=0>Zezima"), "Zezima");
assert.equal(leadingChatIcons("<img=1>Zezima"), "<img=1>");
assert.equal(normalizePlayerName("Cool_Name"), normalizePlayerName("cool name"));
assert.equal(wrapWithColorTag("Pat", 0x5865f2), "<col=5865f2>Pat</col>");

assert.equal(
    formatDiscordChatName("Zezima", "Patrick", { brackets: true }),
    "[Patrick] Zezima",
);
assert.equal(
    formatDiscordChatName("<img=1>Zezima", "Patrick", { brackets: true }),
    "<img=1>[Patrick] Zezima",
);
assert.equal(
    formatDiscordChatName("Zezima", "Patrick", { brackets: false }),
    "Patrick Zezima",
);
assert.equal(
    formatDiscordChatName("Zezima", "Zezima", { brackets: true }),
    "[Zezima] Zezima",
    "identical Discord and in-game names still show the Discord label",
);
assert.equal(
    formatDiscordChatName("Zezima", "Patrick", { brackets: true, colour: 0xff0000 }),
    "<col=ff0000>[Patrick]</col> Zezima",
);

const plugin = new DiscordNamesPlugin();
let refreshes = 0;
plugin.refreshChat = () => refreshes++;

assert.equal(plugin.formatChatPlayerName("Zezima"), undefined, "stopped plugin leaves the name");
assert.equal(plugin.discordNameFor("Zezima"), undefined);

plugin.onPluginMessage(
    new PluginMessage(DISCORD_NAMES_CHANNEL, {
        type: "snapshot",
        entries: [
            { name: "Zezima", discordName: "Patrick" },
            { name: "Gnome Child", discordName: "Ash" },
        ],
    }),
);
assert.equal(plugin.discordNameFor("Zezima"), "Patrick");
assert.equal(plugin.discordNameFor("gnome_child"), "Ash");

void plugin.start();
assert.equal(refreshes, 1);
assert.equal(plugin.formatChatPlayerName("Zezima"), "[Patrick] Zezima");
assert.equal(plugin.formatChatPlayerName("<img=1>Zezima"), "<img=1>[Patrick] Zezima");

const vm: any = {
    intStack: [0, 1],
    intStackSize: 2,
    stringStack: ["", "Zezima", "Hello", ""],
    stringStackSize: 4,
};
plugin.onScriptCallback({ eventName: "chatMessageBuilding", vm });
assert.equal(vm.stringStack[1], "[Patrick] Zezima");

plugin.onPluginMessage(
    new PluginMessage(DISCORD_NAMES_CHANNEL, { type: "set", name: "Bob", discordName: "Bobby" }),
);
assert.equal(plugin.formatChatPlayerName("Bob"), "[Bobby] Bob");

plugin.onPluginMessage(new PluginMessage(DISCORD_NAMES_CHANNEL, { type: "clear", name: "Bob" }));
assert.equal(plugin.formatChatPlayerName("Bob"), undefined);

const config = inject(ConfigManager);
config.setConfigValue(DiscordNamesConfig, "brackets", false);
plugin.onConfigChanged(new ConfigChanged("discordnames", "brackets", undefined, undefined));
assert.equal(plugin.formatChatPlayerName("Zezima"), "Patrick Zezima");
assert.ok(refreshes >= 2);

plugin.onGameStateChanged(new GameStateChanged(GameState.LOGIN_SCREEN));
assert.equal(plugin.discordNameFor("Zezima"), undefined, "logout clears the map");

void plugin.stop();
assert.equal(plugin.formatChatPlayerName("Zezima"), undefined, "stopped plugin leaves the name");

console.log("Discord Names plugin tests passed");
