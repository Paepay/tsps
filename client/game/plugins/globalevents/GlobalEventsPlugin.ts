import { GameState } from "@runelite/api/GameState";
import { PluginMessage, type GameStateChanged } from "@runelite/api/events";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { OverlayPosition } from "@runelite/client/ui/overlay/OverlayPosition";
import { getMousePos } from "../../InputManager";
import type { OsrsClient } from "../../OsrsClient";
import { sendChat } from "../../../network/ServerConnection";
import { subscribePluginMessages } from "../../../network/serverConnection/domain/pluginMessages";
import type { OverlayMenuEntry, WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";

type Rect = { x: number; y: number; w: number; h: number };
type Rgba = [number, number, number, number];

const CHANNEL = "global-events";
/** Blue partyhat: the Events HUD icon, whatever the active event's own item is. */
export const HUD_ITEM_ID = 1042;
const SIZE = 24;
const ICON = 20;
const FLASH_MS = 400;
const BACKGROUND: Rgba = [70 / 255, 61 / 255, 50 / 255, 0.75];
const OUTLINE: Rgba = [56 / 255, 48 / 255, 35 / 255, 1];
const FLASH_A: Rgba = [1, 0.82, 0.5, 1];
const FLASH_B: Rgba = [1, 1, 1, 1];

/**
 * The Global Events HUD icon: one item image for the newest active event, flashing until the
 * player opens ::events (from this icon or typed). Clicking it opens the interface; the server
 * sends `seen` for both routes, so the typed route stops the flashing too.
 */
export class GlobalEventsPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Global Events",
        description: "Shows the Events icon (a blue partyhat) under the special attack orb; click it to open the Events interface",
        tags: ["events", "global", "hud", "overlay", "icon", "partyhat"],
        // On for everyone by default; switch the plugin off to hide the icon.
        enabledByDefault: true,
        configKey: "globaleventsplugin",
    };

    private readonly osrsClient?: OsrsClient;
    private activeKey = "";
    private seenKey = "";
    private iconItemId = -1;
    private iconName = "";
    private activeCount = 0;
    private flashing = false;
    /** Whether this player may open the Events interface; the server tells us per player. */
    private canOpen = false;
    private stopListening?: () => void;
    private iconBounds?: Rect;
    private removeInputFilter?: () => void;
    private removeTouchHandler?: () => void;
    private readonly textures = new Map<number, { tex: any; w: number; h: number }>();

    readonly widgetOverlay: WidgetOverlay;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.widgetOverlay = {
            movable: { name: "GlobalEvents", position: OverlayPosition.BELOW_SPECIAL_ATTACK },
            signature: () => this.signature(),
            draw: (context) => this.draw(context),
            menuEntries: () => this.menuEntries(),
        };
        // A stopped plugin gets no events from the bus, so a player who switches the plugin off
        // and back on mid-session would wait for the server's next push to see the icon. Keep the
        // server's state current while stopped; while running the bus delivers it as usual.
        this.stopListening = subscribePluginMessages(({ channel, data }) => {
            if (!this.isStarted()) this.onPluginMessage(new PluginMessage(channel, data));
        });
    }

    protected async startUp(): Promise<void> {
        // The last state belongs to a session that may have ended while the plugin was off.
        if (!this.isLoggedIn()) this.forget();
        const input = this.osrsClient?.inputManager;
        if (input?.addInputFilter) this.removeInputFilter = input.addInputFilter(this.onInput);
        if (input?.addTouchTapHandler) this.removeTouchHandler = input.addTouchTapHandler(this.onTouchTap);
    }

    protected async shutDown(): Promise<void> {
        this.removeInputFilter?.();
        this.removeTouchHandler?.();
        this.removeInputFilter = undefined;
        this.removeTouchHandler = undefined;
        // Only the click target goes: the server's state is kept (and kept current by the
        // listener above) so switching the plugin back on shows the icon at once.
        this.iconBounds = undefined;
    }

    private forget(): void {
        this.activeKey = "";
        this.seenKey = "";
        this.iconItemId = -1;
        this.iconName = "";
        this.activeCount = 0;
        this.flashing = false;
        this.canOpen = false;
        this.iconBounds = undefined;
    }

    onPluginMessage(event: PluginMessage): void {
        if (event.channel !== CHANNEL) return;
        const data = event.data ?? {};
        if (data.type === "state") {
            // Absent or anything but `true` hides the button (fail closed for older servers).
            this.canOpen = data.canOpen === true;
            this.activeKey = typeof data.activeKey === "string" ? data.activeKey : "";
            this.iconItemId = Number(data.iconItemId) || -1;
            this.iconName = typeof data.iconName === "string" ? data.iconName : "";
            this.activeCount = data.slots && typeof data.slots === "object"
                ? Object.values(data.slots as Record<string, unknown>).filter((slot) => slot !== null && slot !== undefined).length
                : 0;
            this.flashing = this.activeKey.length > 0 && this.activeKey !== this.seenKey;
            if (!this.activeKey.length) this.seenKey = "";
            return;
        }
        if (data.type === "seen") {
            this.seenKey = typeof data.activeKey === "string" ? data.activeKey : this.activeKey;
            this.flashing = false;
        }
    }

    onGameStateChanged(event: GameStateChanged): void {
        // Login sends the world's event state before the client finishes loading (CONNECTING ->
        // LOADING_GAME -> LOGGED_IN), so those transitions must keep it. Only forget the events
        // once the player has actually left the world; a hop or reconnect re-sends them.
        const state = event.getGameState();
        if (state !== GameState.LOGIN_SCREEN && state !== GameState.CONNECTION_LOST
            && state !== GameState.STARTING && state !== GameState.UNKNOWN && state !== GameState.HOPPING) {
            return;
        }
        this.forget();
    }

    private signature(): string {
        const phase = this.flashing ? Math.floor(Date.now() / FLASH_MS) % 2 : 0;
        return `${this.activeKey}:${this.seenKey}:${this.iconItemId}:${this.activeCount}:${phase}:${this.canOpen ? 1 : 0}`;
    }

    private menuEntries(): OverlayMenuEntry[] {
        if (!this.isStarted() || !this.isLoggedIn() || !this.canOpen) return [];
        return [{ option: "Open", target: "Global Events", onClick: () => this.open() }];
    }

    private isLoggedIn(): boolean {
        return this.osrsClient?.isLoggedIn?.() === true;
    }

    private draw(context: WidgetOverlayDrawContext): Rect[] {
        // The button stays on the HUD after login even while no event is running, so the
        // Events interface is always one click away.
        if (!this.isStarted() || !this.isLoggedIn() || !this.canOpen) {
            this.iconBounds = undefined;
            return [];
        }
        const at = context.place(this.widgetOverlay, SIZE, SIZE);
        if (!at) {
            this.iconBounds = undefined;
            return [];
        }
        const rect = { x: at.x, y: at.y, w: SIZE * at.scaleX, h: SIZE * at.scaleY };
        this.iconBounds = rect;
        const glr = context.renderer;
        glr.drawRect(rect.x, rect.y, rect.w, rect.h, BACKGROUND);
        const phase = Math.floor(Date.now() / FLASH_MS) % 2 === 0;
        const outline = this.flashing ? (phase ? FLASH_A : FLASH_B) : OUTLINE;
        const sx = Math.max(1, at.scaleX), sy = Math.max(1, at.scaleY);
        glr.drawRect(rect.x, rect.y, rect.w, sy, outline);
        glr.drawRect(rect.x, rect.y + rect.h - sy, rect.w, sy, outline);
        glr.drawRect(rect.x, rect.y + sy, sx, rect.h - 2 * sy, outline);
        glr.drawRect(rect.x + rect.w - sx, rect.y + sy, sx, rect.h - 2 * sy, outline);

        const icon = this.iconTexture(context, HUD_ITEM_ID);
        if (icon) {
            const fit = Math.min(ICON / icon.w, ICON / icon.h);
            const w = icon.w * fit * at.scaleX;
            const h = icon.h * fit * at.scaleY;
            glr.drawTexture(icon.tex, rect.x + (rect.w - w) / 2, rect.y + (rect.h - h) / 2, w, h);
        }
        return [rect];
    }

    /** One texture per item id; the icon's source is the same 36x32 canvas items draw with. */
    private iconTexture(context: WidgetOverlayDrawContext, itemId: number): { tex: any; w: number; h: number } | undefined {
        const cached = this.textures.get(itemId);
        if (cached) return cached;
        const source = context.itemImage?.(itemId, 1, 1);
        if (!source || typeof document === "undefined") return undefined;
        const tex = context.renderer.createTextureFromCanvas(`global-events:${itemId}`, source);
        if (!tex) return undefined;
        const entry = { tex, w: source.width, h: source.height };
        this.textures.set(itemId, entry);
        return entry;
    }

    private open(): void {
        this.seenKey = this.activeKey;
        this.flashing = false;
        sendChat("::events");
    }

    private onInput = (type: string, event: MouseEvent | KeyboardEvent): boolean => {
        if (type !== "mousePressed") return false;
        const mouse = event as MouseEvent;
        if (mouse.button !== 0 || !this.isStarted() || !this.isLoggedIn() || !this.canOpen || !this.iconBounds) return false;
        const element = this.osrsClient?.inputManager?.element;
        if (!element) return false;
        const [x, y] = getMousePos(element, mouse);
        if (!inside(this.iconBounds, x, y)) return false;
        this.open();
        return true;
    };

    private onTouchTap = (x: number, y: number): boolean => {
        if (!this.isStarted() || !this.isLoggedIn() || !this.canOpen || !this.iconBounds || !inside(this.iconBounds, x, y)) return false;
        this.open();
        return true;
    };
}

function inside(rect: Rect, x: number, y: number): boolean {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}
