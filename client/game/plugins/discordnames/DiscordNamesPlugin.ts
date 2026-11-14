import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged, GameStateChanged, PluginMessage } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { markChatTransmit } from "../../TransmitCycles";
import type { ClientPlugin, ScriptCallbackEvent } from "../ClientPluginManager";
import { DiscordNamesConfig } from "./DiscordNamesConfig";
import {
    formatDiscordChatName,
    normalizePlayerName,
    stripChatIcons,
} from "./discordNameText";

export const DISCORD_NAMES_CHANNEL = "discord-names";

/**
 * Shows each player's Discord name (as in the PaeScape Discord server) before
 * their in-game name in the chatbox. Names arrive from the world on the
 * "discord-names" plugin channel after PaeScape ticket login.
 */
export class DiscordNamesPlugin extends Plugin implements ClientPlugin {
    static descriptor: PluginDescriptor = {
        name: "Discord Names",
        description: "Show Discord names before in-game names in chat",
        tags: ["chat", "discord", "paescape"],
        enabledByDefault: true,
        configKey: "discordnamesplugin",
    };

    static config = DiscordNamesConfig;

    private readonly config = inject(ConfigManager).getConfig(DiscordNamesConfig);
    /** In-game name (normalized) -> Discord display name. */
    private readonly names = new Map<string, string>();
    /** Rebuilds the chatbox after the map or settings change. */
    refreshChat: () => void = markChatTransmit;

    protected async startUp(): Promise<void> {
        this.refreshChat();
    }

    protected async shutDown(): Promise<void> {
        this.refreshChat();
    }

    onGameStateChanged(event: GameStateChanged): void {
        const state = event.getGameState();
        if (
            state === GameState.LOGIN_SCREEN ||
            state === GameState.CONNECTION_LOST ||
            state === GameState.HOPPING ||
            state === GameState.STARTING
        ) {
            this.names.clear();
        }
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() !== DiscordNamesConfig.group) return;
        this.refreshChat();
    }

    onPluginMessage(event: PluginMessage): void {
        if (event.channel !== DISCORD_NAMES_CHANNEL) return;
        const data = event.data as {
            type?: unknown;
            name?: unknown;
            discordName?: unknown;
            entries?: unknown;
        };
        switch (data.type) {
            case "snapshot": {
                this.names.clear();
                if (!Array.isArray(data.entries)) break;
                for (const entry of data.entries) {
                    if (!entry || typeof entry !== "object") continue;
                    const name = (entry as { name?: unknown }).name;
                    const discordName = (entry as { discordName?: unknown }).discordName;
                    this.setName(name, discordName);
                }
                if (this.isStarted()) this.refreshChat();
                break;
            }
            case "set":
                this.setName(data.name, data.discordName);
                if (this.isStarted()) this.refreshChat();
                break;
            case "clear":
                this.clearName(data.name);
                if (this.isStarted()) this.refreshChat();
                break;
            default:
                break;
        }
    }

    /**
     * Local chatbox input line (CHAT_PLAYERNAME): put the Discord name before
     * the in-game name when we know it.
     */
    formatChatPlayerName(name: string): string | undefined {
        if (!this.isStarted()) return undefined;
        return this.formatName(name);
    }

    onScriptCallback({ eventName, vm }: ScriptCallbackEvent): void {
        if (eventName !== "chatMessageBuilding" || !this.isStarted()) return;
        // ints: [splitpmbox, uid]; strings: [channel, name, message, timestamp]
        if (vm.stringStackSize < 4) return;
        // Prefer the name already on the stack; look up Discord by the bare name.
        // Game messages leave the name empty; unmapped names are left alone.
        const nameIndex = vm.stringStackSize - 3;
        const name = String(vm.stringStack[nameIndex] ?? "");
        if (!name) return;
        const formatted = this.formatName(name);
        if (formatted === undefined) return;
        vm.stringStack[nameIndex] = formatted;
    }

    /** Look up a Discord name for an in-game (possibly icon-prefixed) chat name. */
    discordNameFor(name: string): string | undefined {
        return this.names.get(normalizePlayerName(name));
    }

    private formatName(name: string): string | undefined {
        const discordName = this.discordNameFor(name);
        if (!discordName) return undefined;
        return formatDiscordChatName(name, discordName, {
            brackets: this.config.brackets() !== false,
            colour: typeof this.config.colour() === "number" ? (this.config.colour() as number) : undefined,
        });
    }

    private setName(name: unknown, discordName: unknown): void {
        if (typeof name !== "string" || !name.trim()) return;
        if (typeof discordName !== "string" || !discordName.trim()) {
            this.clearName(name);
            return;
        }
        this.names.set(normalizePlayerName(name), discordName.replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 32));
    }

    private clearName(name: unknown): void {
        if (typeof name !== "string" || !name.trim()) return;
        this.names.delete(normalizePlayerName(name));
        // Display-name changes: also drop the bare username form if icons were present.
        this.names.delete(normalizePlayerName(stripChatIcons(name)));
    }
}
