import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { CacheSystem } from "../rs/cache/CacheSystem";
import { getCacheLoaderFactory } from "../rs/cache/loader/CacheLoaderFactory";
import { loadCache, loadCacheInfos, loadCacheList } from "../scripts/cache/load-util";
import salvageJson from "../../server/plugins/skills/sailing/data/sailing-salvage.json";
import chartingJson from "../../server/plugins/skills/sailing/data/charting.json";
import portsJson from "../../server/plugins/skills/sailing/data/sailing-ports.json";
import portTasksJson from "../../server/plugins/skills/sailing/data/port-tasks.json";
import { ClientState } from "../game/ClientState";
import { SailingConfig } from "../game/plugins/sailing/SailingConfig";
import { SailingPlugin } from "../game/plugins/sailing/SailingPlugin";
import {
    CHARTING_MARKER_IDS,
    CHARTING_MARKER_SPOTS,
    CHARTING_ROUTES,
    PORT_TASK_BOARD_IDS,
    SAILING_PORTS,
    SHIPWRECK_BY_OBJECT_ID,
    SHIPWRECK_SPOTS,
    SHIPWRECK_TYPES,
} from "../game/plugins/sailing/SailingData";
import type { SceneLoc } from "../game/scene/SceneGeometry";

// --- Data comes from the server's Sailing content -----------------------------------------------
assert.equal(SailingPlugin.descriptor.enabledByDefault, false, "off until enabled");
assert.equal(SailingPlugin.descriptor.configKey, "sailingplugin");
assert.equal(SailingPlugin.config, SailingConfig);
assert.equal(SailingConfig.group, "sailing");
const registry = readFileSync(join(process.cwd(), "runelite/client/plugins/index.ts"), "utf8");
assert.match(
    registry.slice(registry.indexOf("export const CORE_PLUGINS")),
    /^\s+SailingPlugin,$/m,
    "registered as a core plugin",
);

assert.equal(SHIPWRECK_TYPES.length, 8, "every shipwreck type is listed");
assert.equal(SHIPWRECK_BY_OBJECT_ID.size, 16, "each wreck has a raised and a sunken loc");
assert.ok(SHIPWRECK_BY_OBJECT_ID.get(60464)?.kind === "active");
assert.ok(SHIPWRECK_BY_OBJECT_ID.get(60465)?.kind === "sunken");
assert.ok(SHIPWRECK_SPOTS.length > 100, "the cache-map wreck spots are all present");
assert.ok(SHIPWRECK_SPOTS.every((spot) => spot.plane === 0), "wrecks sit at sea level");
assert.equal(PORT_TASK_BOARD_IDS.size, 23, "all port task board objects");
assert.ok(PORT_TASK_BOARD_IDS.has(60287));
assert.equal(CHARTING_MARKER_IDS.get(59281), "Spyglass");
assert.equal(CHARTING_MARKER_IDS.get(59282), "Current duck");
assert.ok(CHARTING_MARKER_SPOTS.length > 0, "marker spots have real cache-map tiles");
assert.ok(CHARTING_ROUTES.length > 0, "current ducks and weather trolls have routes");
for (const route of CHARTING_ROUTES) {
    assert.ok(route.points.length >= 2, `${route.key} has a route`);
    for (const [x, y] of route.points) {
        assert.ok(Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0);
    }
}

// --- The client copy stays identical to the server's Sailing data --------------------------------
const salvage = salvageJson as unknown as {
    wrecks: Record<string, { name: string; active: number; sunken: number; level: number }>;
    sites: readonly { type: string; wrecks: readonly { x: number; y: number; z: number; rotation: number }[] }[];
};
const charting = chartingJson as unknown as {
    spots: Record<string, {
        marker?: boolean;
        location?: readonly [number, number];
        location2?: readonly [number, number];
        route?: readonly (readonly [number, number])[];
    }>;
};
const ports = portsJson as unknown as {
    id: string;
    name: string;
    buoy?: { x: number; y: number; z: number };
    gangplank?: { x: number; y: number; z: number };
    landing?: { x: number; y: number; z: number };
}[];
const portTasks = portTasksJson as unknown as { boardLocs: readonly number[] };
const byKey = (left: { key: string }, right: { key: string }): number => left.key.localeCompare(right.key);

assert.deepEqual(
    SHIPWRECK_TYPES.map(({ key, name, active, sunken, level }) => ({ key, name, active, sunken, level })).sort(byKey),
    Object.entries(salvage.wrecks)
        .map(([key, type]) => ({ key, name: type.name, active: type.active, sunken: type.sunken, level: type.level }))
        .sort(byKey),
    "the client shipwreck types match the server's",
);
assert.deepEqual(
    SHIPWRECK_SPOTS.map((spot) => ({ type: spot.type.key, x: spot.x, y: spot.y, plane: spot.plane, rotation: spot.rotation })),
    salvage.sites.flatMap((site) => site.wrecks.map((wreck) => ({ type: site.type, x: wreck.x, y: wreck.y, plane: wreck.z, rotation: wreck.rotation }))),
    "the client wreck spots match every cache-map placement",
);

const markerName = (id: number): string => id === 59281 ? "Spyglass" : "Current duck";
const routeLabel = (key: string, prefix: string): string => key
    .slice(prefix.length)
    .split("_")
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
const serverMarkers: unknown[] = [];
const serverRoutes: unknown[] = [];
for (const [key, spot] of Object.entries(charting.spots)) {
    const id = key.startsWith("spyglass_") ? 59281 : key.startsWith("current_duck_") ? 59282 : undefined;
    if (spot.marker && spot.location && id !== undefined) {
        serverMarkers.push({ key, id, name: markerName(id), x: spot.location[0], y: spot.location[1], plane: 0 });
    }
    if (key.startsWith("current_duck_") && spot.route && spot.route.length > 1) {
        serverRoutes.push({ key, kind: "current_duck", label: routeLabel(key, "current_duck_"), plane: 0, points: spot.route });
    } else if (key.startsWith("weather_troll_") && spot.location && spot.location2) {
        serverRoutes.push({ key, kind: "weather_troll", label: routeLabel(key, "weather_troll_"), plane: 0, points: [spot.location, spot.location2] });
    }
}
assert.deepEqual(CHARTING_MARKER_SPOTS, serverMarkers, "the client charting markers match the server's spawns");
assert.deepEqual(CHARTING_ROUTES, serverRoutes, "the client charting routes match the server data");
assert.deepEqual(
    SAILING_PORTS.map(({ id, name, buoy, gangplank, landing }) => ({ id, name, buoy, gangplank, landing })),
    ports.map(({ id, name, buoy, gangplank, landing }) => ({ id, name, buoy, gangplank, landing })),
    "the client ports match the server's dock data",
);
assert.deepEqual(
    [...PORT_TASK_BOARD_IDS].sort((a, b) => a - b),
    [...portTasks.boardLocs].sort((a, b) => a - b),
    "the client port task boards match the server's",
);

// --- Every id resolves in the cache ---------------------------------------------------------------
const info = loadCacheList(loadCacheInfos()).latest;
const cache = loadCache(info);
const factory: any = getCacheLoaderFactory(info, CacheSystem.fromFiles(info, cache.files));
const locTypes = factory.getLocTypeLoader();
for (const id of [...SHIPWRECK_BY_OBJECT_ID.keys(), ...PORT_TASK_BOARD_IDS, ...CHARTING_MARKER_IDS.keys()]) {
    const loc = locTypes.load(id);
    assert.ok(loc && typeof loc.name === "string" && loc.name.length > 0, `${id} is a cache loc with a name`);
}

// --- Plugin scan and overlay ---------------------------------------------------------------------
ClientState.baseX = 1000;
ClientState.baseY = 2930;
ClientState.plane = 0;

let scene = new Map<string, SceneLoc[]>();
function setScene(locs: SceneLoc[]): void {
    scene = new Map();
    for (const loc of locs) {
        const key = `${loc.tileX},${loc.tileY},${loc.plane}`;
        scene.set(key, [...(scene.get(key) ?? []), loc]);
    }
}

function loc(id: number, tileX: number, tileY: number, plane = 0): SceneLoc {
    return { id, tileX, tileY, plane, shape: 10, rotation: 0 };
}

let player = { x: 1029, y: 2957, plane: 0 };
const client: any = {
    gameState: 30,
    controlledPlayerServerId: 1,
    playerEcs: {
        getIndexForServerId: () => 0,
        getX: () => player.x * 128 + 64,
        getY: () => player.y * 128 + 64,
        getLevel: () => player.plane,
    },
    sceneGeometry: {
        locsAtTile: (x: number, y: number, plane: number) => scene.get(`${x},${y},${plane}`) ?? [],
        tileHeight: () => 0,
        worldToScreen: (x: number, height: number, y: number) => [x * 10, y * 10 + height * 10],
        locModelPoints: (value: SceneLoc) => [[
            [value.tileX, 0, value.tileY],
            [value.tileX + 1, 0, value.tileY],
            [value.tileX + 1, -1, value.tileY + 1],
            [value.tileX, -1, value.tileY + 1],
        ]],
    },
};

const config = inject(ConfigManager);
config.setConfigValue(SailingConfig, "showShipwrecks", true);
config.setConfigValue(SailingConfig, "showSunkenShipwrecks", false);
config.setConfigValue(SailingConfig, "showChartingMarkers", true);
config.setConfigValue(SailingConfig, "showChartingRoutes", true);
config.setConfigValue(SailingConfig, "showPortTaskBoards", true);

const plugin = new SailingPlugin(client);
const main = async (): Promise<void> => {
    await plugin.start();

    // A raised wreck is highlighted; its sunken form stays hidden until the option is on.
    setScene([loc(60478, 1029, 2957), loc(60479, 1034, 2966)]);
    plugin.rebuild();
    assert.deepEqual(plugin.objects.map((object) => object.kind), ["shipwreck"]);
    assert.equal(plugin.objects[0].loc.id, 60478);
    config.setConfigValue(SailingConfig, "showSunkenShipwrecks", true);
    plugin.rebuild();
    assert.deepEqual(plugin.objects.map((object) => object.kind).sort(), ["shipwreck", "sunken"]);
    config.setConfigValue(SailingConfig, "showSunkenShipwrecks", false);

    // Charting markers and nearby routes.
    ClientState.baseX = 3070;
    ClientState.baseY = 3150;
    player = { x: 3100, y: 3180, plane: 0 };
    setScene([loc(59281, 3104, 3181)]);
    plugin.rebuild();
    assert.deepEqual(plugin.objects.map((object) => object.kind), ["charting"]);
    assert.ok(plugin.routes.some((route) => route.key === "current_duck_fairy_ring"), "the nearby duck route is drawn");

    // Port task boards around a nearby port.
    ClientState.baseX = 3010;
    ClientState.baseY = 3170;
    player = { x: 3030, y: 3198, plane: 0 };
    setScene([loc(60287, 3030, 3198)]);
    plugin.rebuild();
    assert.deepEqual(plugin.objects.map((object) => object.kind), ["board"]);

    // Overlay draws the clickboxes and route lines.
    const strokes: unknown[] = [];
    const fills: unknown[] = [];
    const signature = plugin.widgetOverlay.signature();
    assert.notEqual(signature, "");
    const rects = plugin.widgetOverlay.draw({
        renderer: {
            drawPolyline: (points: unknown) => strokes.push(points),
            drawPolygon: (points: unknown) => fills.push(points),
        },
    } as any);
    assert.ok(strokes.length >= 1);
    assert.ok(fills.length >= 1);
    assert.equal(rects.length, 1);

    await plugin.stop();
    assert.equal(plugin.objects.length, 0);
    assert.equal(plugin.routes.length, 0);
};

main()
    .then(() => console.log("sailing highlights tests passed"))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
