import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import type { SceneLoc } from "../../scene/SceneGeometry";
import { RooftopAgilityConfig } from "./RooftopAgilityConfig";
import { RooftopAgilityOverlay } from "./RooftopAgilityOverlay";
import { isRooftopObstacle } from "./RooftopObstacles";

const GROUP = RooftopAgilityConfig.group;
/** Tiles on a scene side (RuneLite's Constants.SCENE_SIZE). */
const SCENE_SIZE = 104;

/**
 * Highlights the clickboxes of the ten rooftop agility courses' obstacles in blue/cyan, so each
 * next obstacle is easy to see and click. Off by default; the plugin list toggles it and the
 * config group controls the colours and border.
 */
export class RooftopAgilityPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Rooftop Agility Clickboxes",
        description: "Draw blue/cyan clickboxes around rooftop agility course obstacles.",
        tags: ["agility", "rooftop", "overlay", "clickbox"],
        enabledByDefault: false,
        configKey: "rooftopagilityplugin",
    };

    static config = RooftopAgilityConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(RooftopAgilityConfig);
    private readonly osrsClient: OsrsClient;
    /** Rooftop obstacle locs in the loaded scene, rebuilt every game tick. */
    objects: SceneLoc[] = [];
    readonly widgetOverlay: RooftopAgilityOverlay;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.widgetOverlay = new RooftopAgilityOverlay(this);
    }

    protected async startUp(): Promise<void> {
        this.rebuild();
    }

    protected async shutDown(): Promise<void> {
        this.objects = [];
    }

    onGameTick(): void {
        this.rebuild();
    }

    onConfigChanged(event: ConfigChanged): void {
        if (event.getGroup() === GROUP) this.rebuild();
    }

    getClient(): OsrsClient {
        return this.osrsClient;
    }

    isLoggedIn(): boolean {
        return toRuneLiteGameState((this.osrsClient as any)?.gameState) === GameState.LOGGED_IN;
    }

    playerPlane(): number {
        const client: any = this.osrsClient;
        const players = client.playerEcs;
        const index = players?.getIndexForServerId?.(client.controlledPlayerServerId);
        return index === undefined ? ClientState.plane | 0 : players.getLevel(index) | 0;
    }

    /** Finds the rooftop obstacle locs on the player's plane in the loaded scene. */
    rebuild(): void {
        const objects: SceneLoc[] = [];
        const geometry = this.osrsClient.sceneGeometry;
        if (this.isStarted() && geometry && this.isLoggedIn() && this.config.showClickboxes()) {
            const plane = this.playerPlane();
            for (let x = ClientState.baseX; x < ClientState.baseX + SCENE_SIZE; x++) {
                for (let y = ClientState.baseY; y < ClientState.baseY + SCENE_SIZE; y++) {
                    for (const loc of geometry.locsAtTile(x, y, plane)) {
                        if (isRooftopObstacle(loc.id)) objects.push(loc);
                    }
                }
            }
        }
        this.objects = objects;
    }
}
