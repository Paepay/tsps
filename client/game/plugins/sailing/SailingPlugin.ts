import { GameState } from "@runelite/api/GameState";
import type { ConfigChanged } from "@runelite/api/events";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { Plugin, type PluginDescriptor } from "@runelite/client/plugins/Plugin";
import { CLIENT_TOKEN, inject } from "@runelite/client/plugins/PluginInjector";
import { toRuneLiteGameState } from "../../../runelite/impl/GameStateMapping";
import { ClientState } from "../../ClientState";
import type { OsrsClient } from "../../OsrsClient";
import type { SceneLoc } from "../../scene/SceneGeometry";
import { SailingConfig } from "./SailingConfig";
import { SailingOverlay } from "./SailingOverlay";
import {
    CHARTING_MARKER_IDS,
    CHARTING_MARKER_SPOTS,
    CHARTING_ROUTES,
    PORT_TASK_BOARD_IDS,
    PORT_TASK_BOARD_RADIUS,
    SAILING_PORTS,
    SHIPWRECK_BY_OBJECT_ID,
    SHIPWRECK_SPOTS,
    type ChartingRoute,
} from "./SailingData";

const GROUP = SailingConfig.group;
const SCENE_SIZE = 104;
/** How far a route may start from the player before it is left out, in tiles. */
const ROUTE_RANGE = 128;
/** How far a port may be before its board is searched for, in tiles. */
const PORT_RANGE = 64;

export type SailingHighlightKind = "shipwreck" | "sunken" | "charting" | "board";
export type SailingHighlight = { loc: SceneLoc; kind: SailingHighlightKind };

/**
 * Highlights the Sailing content the server actually places: raised shipwrecks (and optionally
 * their sunken forms), the spyglass/current-duck charting markers, the charted routes at sea and
 * the port task boards. Every id and coordinate comes from server/plugins/skills/sailing/data; the
 * cache is only used to resolve the locs the client already has in its scene.
 */
export class SailingPlugin extends Plugin {
    static descriptor: PluginDescriptor = {
        name: "Sailing Highlights",
        description: "Highlight shipwrecks, charting markers/routes and port task boards.",
        tags: ["sailing", "shipwreck", "charting", "overlay"],
        enabledByDefault: false,
        configKey: "sailingplugin",
    };

    static config = SailingConfig;

    private readonly configManager = inject(ConfigManager);
    readonly config = this.configManager.getConfig(SailingConfig);
    private readonly osrsClient: OsrsClient;
    /** Highlighted locs in the loaded scene, rebuilt every game tick. */
    objects: SailingHighlight[] = [];
    /** Charted routes near the player, rebuilt every game tick. */
    routes: ChartingRoute[] = [];
    readonly widgetOverlay: SailingOverlay;

    constructor(osrsClient?: OsrsClient) {
        super();
        this.osrsClient = osrsClient ?? inject<OsrsClient>(CLIENT_TOKEN);
        this.widgetOverlay = new SailingOverlay(this);
    }

    protected async startUp(): Promise<void> {
        this.rebuild();
    }

    protected async shutDown(): Promise<void> {
        this.objects = [];
        this.routes = [];
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

    private playerIndex(): number | undefined {
        const client: any = this.osrsClient;
        return client.playerEcs?.getIndexForServerId?.(client.controlledPlayerServerId);
    }

    playerTile(): { x: number; y: number; plane: number } | undefined {
        const index = this.playerIndex();
        if (index === undefined) return undefined;
        const players = (this.osrsClient as any).playerEcs;
        return {
            x: players.getX(index) >> 7,
            y: players.getY(index) >> 7,
            plane: players.getLevel(index) | 0,
        };
    }

    rebuild(): void {
        const objects: SailingHighlight[] = [];
        const routes: ChartingRoute[] = [];
        const geometry = this.osrsClient.sceneGeometry;
        if (!this.isStarted() || !geometry || !this.isLoggedIn()) {
            this.objects = objects;
            this.routes = routes;
            return;
        }

        const baseX = ClientState.baseX | 0;
        const baseY = ClientState.baseY | 0;
        const inScene = (x: number, y: number): boolean =>
            x >= baseX && x < baseX + SCENE_SIZE && y >= baseY && y < baseY + SCENE_SIZE;
        const seen = new Set<string>();
        const add = (loc: SceneLoc, kind: SailingHighlightKind): void => {
            const key = `${loc.id},${loc.tileX},${loc.tileY},${loc.plane},${loc.shape},${loc.rotation}`;
            if (seen.has(key)) return;
            seen.add(key);
            objects.push({ loc, kind });
        };

        if (this.config.showShipwrecks() || this.config.showSunkenShipwrecks()) {
            for (const spot of SHIPWRECK_SPOTS) {
                if (!inScene(spot.x, spot.y)) continue;
                const origins = new Set<string>([`${spot.x},${spot.y}`]);
                for (const id of [spot.type.active, spot.type.sunken]) {
                    const [x, y] = this.locOrigin(spot.x, spot.y, spot.rotation, id);
                    origins.add(`${x},${y}`);
                }
                for (const origin of origins) {
                    const [x, y] = origin.split(",").map(Number);
                    for (const loc of geometry.locsAtTile(x, y, spot.plane)) {
                        const wreck = SHIPWRECK_BY_OBJECT_ID.get(loc.id);
                        if (!wreck || wreck.type.key !== spot.type.key) continue;
                        if (wreck.kind === "active" && this.config.showShipwrecks()) add(loc, "shipwreck");
                        if (wreck.kind === "sunken" && this.config.showSunkenShipwrecks()) add(loc, "sunken");
                    }
                }
            }
        }

        if (this.config.showChartingMarkers()) {
            for (const spot of CHARTING_MARKER_SPOTS) {
                if (!inScene(spot.x, spot.y)) continue;
                const [x, y] = this.locOrigin(spot.x, spot.y, 0, spot.id);
                for (const loc of geometry.locsAtTile(x, y, spot.plane)) {
                    if (CHARTING_MARKER_IDS.has(loc.id)) add(loc, "charting");
                }
            }
        }

        const player = this.playerTile();
        if (this.config.showPortTaskBoards() && player) {
            for (const port of SAILING_PORTS) {
                const focused = [port.buoy, port.gangplank, port.landing].filter(
                    (tile): tile is { x: number; y: number; z: number } => !!tile,
                );
                if (!focused.some((tile) => near(tile.x, tile.y, player.x, player.y, PORT_RANGE))) continue;
                const minX = Math.max(baseX, Math.min(...focused.map((tile) => tile.x)) - PORT_TASK_BOARD_RADIUS);
                const maxX = Math.min(baseX + SCENE_SIZE - 1, Math.max(...focused.map((tile) => tile.x)) + PORT_TASK_BOARD_RADIUS);
                const minY = Math.max(baseY, Math.min(...focused.map((tile) => tile.y)) - PORT_TASK_BOARD_RADIUS);
                const maxY = Math.min(baseY + SCENE_SIZE - 1, Math.max(...focused.map((tile) => tile.y)) + PORT_TASK_BOARD_RADIUS);
                for (let x = minX; x <= maxX; x++) {
                    for (let y = minY; y <= maxY; y++) {
                        for (const loc of geometry.locsAtTile(x, y, 0)) {
                            if (PORT_TASK_BOARD_IDS.has(loc.id)) add(loc, "board");
                        }
                    }
                }
            }
        }

        if (this.config.showChartingRoutes() && player) {
            for (const route of CHARTING_ROUTES) {
                if (route.points.some(([x, y]) => near(x, y, player.x, player.y, ROUTE_RANGE))) routes.push(route);
            }
        }

        this.objects = objects;
        this.routes = routes;
    }

    /** The tile SdMapDataLoader registers a multi-tile loc at (SceneBuilder.addLoc's centre). */
    private locOrigin(tileX: number, tileY: number, rotation: number, id: number): [number, number] {
        let sizeX = 1, sizeY = 1;
        try {
            const type = (this.osrsClient as any).locTypeLoader?.load(id);
            sizeX = Math.max(1, Number(type?.sizeX ?? 1));
            sizeY = Math.max(1, Number(type?.sizeY ?? 1));
        } catch {
            // A missing type falls back to a single tile; the direct spot is still checked.
        }
        if (rotation === 1 || rotation === 3) [sizeX, sizeY] = [sizeY, sizeX];
        return [tileX + (sizeX >> 1), tileY + (sizeY >> 1)];
    }
}

function near(x: number, y: number, px: number, py: number, range: number): boolean {
    return Math.max(Math.abs(x - px), Math.abs(y - py)) <= range;
}
