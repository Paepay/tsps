import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import type { WidgetLoaded } from "@runelite/api/events";
import type { OsrsClient } from "../../OsrsClient";
import type { WidgetNode } from "../../../widgets/WidgetNode";
import { markWidgetInteractionDirty } from "../../../widgets/WidgetInteraction";
import type { WidgetOverlay, WidgetOverlayDrawContext } from "../ClientPluginManager";

const SKILLS_TAB = 320;
const SKILL_UIDS = Array.from({ length: 24 }, (_, index) => (SKILLS_TAB << 16) | (index + 1));
const LEAGUE_PANEL = 656;
const MASTERIES_BUTTON = (LEAGUE_PANEL << 16) | 32;
const GREY: [number, number, number, number] = [0.12, 0.12, 0.12, 0.72];
const EDGE: [number, number, number, number] = [0.04, 0.04, 0.04, 0.9];

type Rect = { x: number; y: number; w: number; h: number };

/** Grey out the Skills tab entries the Level-Up server reports as locked. */
export class LevelUpLocksOverlay implements WidgetOverlay {
    /** Draw after each skill cell, before its tooltip, so hover XP stays above the grey. */
    readonly drawAfterWidget = SKILL_UIDS;

    constructor(private readonly plugin: LevelUpLocksPlugin) {}

    private rects(triggerWidgetUid?: number): Rect[] {
        const client = this.plugin.getClient();
        const locked = client.levelUpLockedSkills;
        if (!Array.isArray(locked) || locked.length === 0) return [];
        const manager: any = client.widgetManager;
        if (!manager?.getWidgetByUid) return [];
        const result: Rect[] = [];
        for (const child of locked) {
            const uid = (SKILLS_TAB << 16) | child;
            if (triggerWidgetUid !== undefined && triggerWidgetUid !== uid) continue;
            const widget: any = manager.getWidgetByUid(uid);
            if (!widget || manager.isEffectivelyHidden?.(widget.uid)) continue;
            const x = Number(widget._absX), y = Number(widget._absY);
            const w = Number(widget._absWidth), h = Number(widget._absHeight);
            if (![x, y, w, h].every(Number.isFinite) || w <= 0 || h <= 0) continue;
            result.push({ x, y, w, h });
        }
        return result;
    }

    signature(): string {
        return this.rects().map((r) => `${r.x}:${r.y}:${r.w}:${r.h}`).join("|");
    }

    draw(context: WidgetOverlayDrawContext): Rect[] {
        const rects = this.rects(context.triggerWidgetUid);
        const renderer: any = context.renderer;
        for (const r of rects) {
            renderer.drawRect(r.x, r.y, r.w, r.h, GREY);
            renderer.drawRect(r.x, r.y, r.w, 1, EDGE);
            renderer.drawRect(r.x, r.y + r.h - 1, r.w, 1, EDGE);
            renderer.drawRect(r.x, r.y, 1, r.h, EDGE);
            renderer.drawRect(r.x + r.w - 1, r.y, 1, r.h, EDGE);
        }
        return rects;
    }
}

/** Level-Up's locked Skills tab overlay; inert on every other world (the list is empty). */
export class LevelUpLocksPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Level-Up Skill Locks",
        description: "Greys out locked skills on a Level-Up world until they are unlocked.",
        tags: ["skills", "overlay"],
        enabledByDefault: true,
        configKey: "leveluplocksplugin",
    };

    private readonly client: OsrsClient;
    readonly widgetOverlay: WidgetOverlay;

    constructor(client?: OsrsClient) {
        super();
        this.client = client ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.widgetOverlay = new LevelUpLocksOverlay(this);
    }

    /** The cache labels 656:32 for Demonic Pacts; Level-Up uses the same button for masteries. */
    onWidgetLoaded(event: WidgetLoaded): void {
        if (!this.client.levelUpWorldActive || event.getGroupId() !== LEAGUE_PANEL) return;
        const widget = this.client.widgetManager?.getWidgetByUid(MASTERIES_BUTTON) as WidgetNode | undefined;
        if (!widget) return;
        const actions = (widget.actions ??= []);
        if (actions[0] === "View Masteries") return;
        actions[0] = "View Masteries";
        markWidgetInteractionDirty(widget);
    }

    getClient(): OsrsClient { return this.client; }
}
