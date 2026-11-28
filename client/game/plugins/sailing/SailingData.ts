import dataJson from "./data/sailing-highlight-data.json";

/**
 * The Sailing highlight data, generated from server/plugins/skills/sailing/data (see the file's
 * _comment). The client bundle may not import across the client root, so the small subset the
 * overlays need is kept here and client/tests/sailing-highlights.test.ts checks it against the
 * server JSON so it cannot drift.
 */
export type ShipwreckType = {
    readonly key: string;
    readonly name: string;
    readonly active: number;
    readonly sunken: number;
    readonly level: number;
};

type SalvageSpotJson = { x: number; y: number; z: number; rotation: number };
type SalvageSiteJson = { type: string; wrecks: readonly SalvageSpotJson[] };
type SailingPortJson = {
    readonly id: string;
    readonly name: string;
    readonly buoy?: { readonly x: number; readonly y: number; readonly z: number };
    readonly gangplank?: { readonly x: number; readonly y: number; readonly z: number };
    readonly landing?: { readonly x: number; readonly y: number; readonly z: number };
};
export type ChartingRoute = {
    readonly key: string;
    readonly kind: "current_duck" | "weather_troll";
    readonly label: string;
    readonly plane: number;
    readonly points: readonly (readonly [number, number])[];
};

type HighlightDataJson = {
    readonly shipwrecks: Record<string, { name: string; active: number; sunken: number; level: number }>;
    readonly wreckSites: readonly SalvageSiteJson[];
    readonly chartingMarkers: readonly { key: string; id: number; name: string; x: number; y: number; plane: number }[];
    readonly routes: readonly ChartingRoute[];
    readonly ports: readonly SailingPortJson[];
    readonly portTaskBoards: readonly number[];
};
const data = dataJson as unknown as HighlightDataJson;

export const SHIPWRECK_TYPES: readonly ShipwreckType[] = Object.entries(data.shipwrecks).map(
    ([key, type]) => ({ key, name: type.name, active: type.active, sunken: type.sunken, level: type.level }),
);
const shipwreckByKey = new Map(SHIPWRECK_TYPES.map((type) => [type.key, type]));

/** A raised or sunken shipwreck loc, by its object id. */
export type ShipwreckObject = {
    readonly kind: "active" | "sunken";
    readonly type: ShipwreckType;
};
export const SHIPWRECK_BY_OBJECT_ID: ReadonlyMap<number, ShipwreckObject> = new Map(
    SHIPWRECK_TYPES.flatMap((type): [number, ShipwreckObject][] => [
        [type.active, { kind: "active", type }],
        [type.sunken, { kind: "sunken", type }],
    ]),
);

/** Every cache-map wreck spot at sea, with the type whose loc can stand there. */
export type ShipwreckSpot = {
    readonly type: ShipwreckType;
    readonly x: number;
    readonly y: number;
    readonly plane: number;
    readonly rotation: number;
};
export const SHIPWRECK_SPOTS: readonly ShipwreckSpot[] = data.wreckSites.flatMap((site) => {
    const type = shipwreckByKey.get(site.type);
    if (!type) return [];
    return site.wrecks.map((spot) => ({
        type,
        x: spot.x,
        y: spot.y,
        plane: spot.z,
        rotation: spot.rotation,
    }));
});

/** The charting hint locs the server spawns over spyglasses and current-duck starts. */
export const CHARTING_MARKER_IDS: ReadonlyMap<number, string> = new Map(
    data.chartingMarkers.map((marker) => [marker.id, marker.name]),
);

export type ChartingMarkerSpot = {
    readonly key: string;
    readonly id: number;
    readonly x: number;
    readonly y: number;
    readonly plane: number;
};
export const CHARTING_MARKER_SPOTS: readonly ChartingMarkerSpot[] = data.chartingMarkers;

/** A charted route at sea: current-duck paths and the weather trolls' two ends. */
export const CHARTING_ROUTES: readonly ChartingRoute[] = data.routes;

export const SAILING_PORTS: readonly SailingPortJson[] = data.ports;

/** The 23 port task board objects the server's boards respond on. */
export const PORT_TASK_BOARD_IDS: ReadonlySet<number> = new Set(data.portTaskBoards);

/** How far a port's board may stand from its buoy/gangplank/landing, in tiles. */
export const PORT_TASK_BOARD_RADIUS = 20;
