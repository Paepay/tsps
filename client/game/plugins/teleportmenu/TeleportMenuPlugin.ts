import { createElement, lazy, type ReactNode } from "react";
import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged, GameStateChanged, PluginMessage } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import type { InputKeyHandler } from "../../InputManager";
import type { OsrsClient } from "../../OsrsClient";
import { send } from "../../../network/serverConnection/connection/send";
import { TeleportMenuConfig } from "./TeleportMenuConfig";
import {
    Handedness,
    TELEPORT_MENU_CHANNEL,
    activationAt,
    commandForKey,
    nextSelection,
    parseTeleportMenuScreen,
    type HandednessValue,
    type TeleportMenuScreen,
} from "./teleportMenuModel";

const TeleportMenuOverlay = lazy(() =>
    import("./TeleportMenuOverlay").then((module) => ({ default: module.TeleportMenuOverlay })),
);

export interface TeleportMenuSnapshot {
    screen: TeleportMenuScreen | null;
    selected: number;
    message: string | null;
    handedness: HandednessValue;
}

/** Draws the region -> destination teleport menu the server sends for the league relics. */
export class TeleportMenuPlugin extends Plugin implements InputKeyHandler {
    static descriptor: PluginDescriptor = {
        name: "Teleport Menu",
        description: "Shows League relic teleports as a keyboard-first region and destination menu.",
        tags: ["league", "teleport", "keyboard", "menu"],
        configKey: "teleportmenuplugin",
    };

    static config = TeleportMenuConfig;

    private readonly config = inject(ConfigManager).getConfig(TeleportMenuConfig);
    private readonly osrsClient: OsrsClient;
    private readonly listeners = new Set<() => void>();
    private screen: TeleportMenuScreen | null = null;
    private selected = 0;
    private message: string | null = null;
    private snapshot: TeleportMenuSnapshot = {
        screen: null,
        selected: 0,
        message: null,
        handedness: Handedness.RIGHT,
    };
    private removeKeyHandler?: () => void;
    private windowKeyListener?: (event: KeyboardEvent) => void;
    private windowPointerListener?: (event: MouseEvent | TouchEvent) => void;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
    }

    readonly subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    };

    readonly getSnapshot = (): TeleportMenuSnapshot => this.snapshot;

    protected async startUp(): Promise<void> {
        const input = this.osrsClient?.inputManager;
        this.removeKeyHandler = input?.addPreRemapKeyHandler?.(this) ?? input?.addKeyHandler(this);
    }

    protected async shutDown(): Promise<void> {
        this.removeKeyHandler?.();
        this.removeKeyHandler = undefined;
        this.removeWindowKeyListener();
        this.screen = null;
        this.selected = 0;
        this.message = null;
        this.notify();
    }

    onPluginMessage(event: PluginMessage): void {
        if (event.channel !== TELEPORT_MENU_CHANNEL) return;
        const data = event.data as Record<string, unknown>;
        if (data?.type === "screen") {
            const screen = parseTeleportMenuScreen(data);
            if (!screen) return;
            this.screen = screen;
            this.selected = 0;
            this.message = null;
            this.listenForWindowInput();
            this.notify();
            return;
        }
        if (data?.type === "close") {
            if (!this.screen) return;
            if (typeof data.session === "number" && data.session !== this.screen.session) return;
            this.screen = null;
            this.selected = 0;
            this.message = null;
            this.removeWindowKeyListener();
            this.notify();
            return;
        }
        if (data?.type === "error") {
            if (!this.screen) return;
            if (typeof data.session === "number" && data.session !== this.screen.session) return;
            this.message = typeof data.message === "string" && data.message.length > 0
                ? data.message
                : "That teleport is unavailable.";
            this.notify();
        }
    }

    onGameStateChanged(event: GameStateChanged): void {
        const state = event.getGameState();
        if (
            state === GameState.LOGIN_SCREEN || state === GameState.CONNECTION_LOST
            || state === GameState.STARTING || state === GameState.UNKNOWN || state === GameState.HOPPING
        ) {
            if (!this.screen) return;
            this.screen = null;
            this.selected = 0;
            this.message = null;
            this.removeWindowKeyListener();
            this.notify();
        }
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() === TeleportMenuConfig.group && this.screen) this.notify();
    }

    onKeyDown(event: KeyboardEvent): boolean {
        if (!this.screen) return false;
        // Browser and OS shortcuts stay the browser's. Everything else belongs to the open menu,
        // including keys the game would otherwise treat as chat, camera or hotkey input.
        if (event.ctrlKey || event.altKey || event.metaKey) return false;
        // A held key must not send the same region or destination repeatedly.
        if (event.repeat) return true;

        const command = commandForKey(this.handedness(), this.screen, event.code, this.selected);
        if (command.type === "close") this.close();
        else if (command.type === "back") this.back();
        else if (command.type === "move") this.moveSelection(command.delta);
        else if (command.type === "page") this.requestPage(this.screen.page + command.delta);
        else if (command.type === "activate") this.activatePosition(command.position);
        // "consume": the menu owns the keyboard while it is open, so game hotkeys do not fire behind it.
        return true;
    }

    setSelected(position: number): void {
        if (!this.screen || !Number.isInteger(position) || position < 0 || position >= this.screen.entries.length) return;
        if (position === this.selected) return;
        this.selected = position;
        this.notify();
    }

    activatePosition(position: number): void {
        if (!this.screen) return;
        const activation = activationAt(this.screen, position);
        if (!activation) return;
        if (activation.kind === "locked") {
            this.message = activation.message;
            this.notify();
            return;
        }
        this.selected = position;
        this.message = null;
        this.send(activation.data);
        this.notify();
    }

    requestPage(page: number): void {
        if (!this.screen) return;
        if (!Number.isInteger(page) || page < 0 || page >= this.screen.pages) return;
        this.send({ type: "page", session: this.screen.session, page });
    }

    back(): void {
        if (!this.screen?.canBack) return;
        this.message = null;
        this.send({ type: "back", session: this.screen.session });
    }

    close(): void {
        this.removeWindowKeyListener();
        if (!this.screen) return;
        this.send({ type: "close", session: this.screen.session });
        this.screen = null;
        this.selected = 0;
        this.message = null;
        this.notify();
    }

    renderHud(osrsClient: OsrsClient): ReactNode {
        return createElement(TeleportMenuOverlay, { osrsClient, plugin: this });
    }

    private handedness(): HandednessValue {
        return this.config.handedness();
    }

    private moveSelection(delta: number): void {
        if (!this.screen || this.screen.entries.length === 0) return;
        const next = nextSelection(this.selected, this.screen.entries.length, delta);
        if (next === this.selected) return;
        this.selected = next;
        this.notify();
    }

    /**
     * A modal menu owns the keyboard wherever focus currently is. Capture at the window so keys
     * reach the menu before camera remapping or the game's canvas listener, and stop them from
     * reaching either. A click or touch outside the panel is a movement or combat input: close the
     * menu and let that input continue to the world instead of blocking it with a backdrop.
     */
    private listenForWindowInput(): void {
        if (this.windowKeyListener || typeof window === "undefined" || !window.addEventListener) return;
        const keyListener = (event: KeyboardEvent): void => {
            if (!this.screen || !this.onKeyDown(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation?.();
        };
        const pointerListener = (event: MouseEvent | TouchEvent): void => {
            if (!this.screen) return;
            const target = event.target as Element | null;
            if (target && typeof target.closest === "function" && target.closest(".teleport-menu")) return;
            this.close();
        };
        this.windowKeyListener = keyListener;
        this.windowPointerListener = pointerListener;
        window.addEventListener("keydown", keyListener, true);
        window.addEventListener("mousedown", pointerListener, true);
        window.addEventListener("touchstart", pointerListener, true);
    }

    private removeWindowKeyListener(): void {
        if (typeof window !== "undefined" && window.removeEventListener) {
            if (this.windowKeyListener) window.removeEventListener("keydown", this.windowKeyListener, true);
            if (this.windowPointerListener) {
                window.removeEventListener("mousedown", this.windowPointerListener, true);
                window.removeEventListener("touchstart", this.windowPointerListener, true);
            }
        }
        this.windowKeyListener = undefined;
        this.windowPointerListener = undefined;
    }

    private send(data: Record<string, unknown>): void {
        send({ type: "plugin_message", payload: { channel: TELEPORT_MENU_CHANNEL, data } });
    }

    private notify(): void {
        this.snapshot = {
            screen: this.screen,
            selected: this.selected,
            message: this.message,
            handedness: this.handedness(),
        };
        for (const listener of this.listeners) listener();
    }
}
