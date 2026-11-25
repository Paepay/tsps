import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as ObjectID from "@runelite/api/gameval/ObjectID";
import { ConfigManager } from "@runelite/client/config/ConfigManager";
import { inject } from "@runelite/client/plugins/PluginInjector";
import { ClientState } from "../game/ClientState";
import { RooftopAgilityConfig } from "../game/plugins/rooftopagility/RooftopAgilityConfig";
import { RooftopAgilityPlugin } from "../game/plugins/rooftopagility/RooftopAgilityPlugin";
import {
    ROOFTOP_COURSES,
    ROOFTOP_OBSTACLE_IDS,
    isRooftopObstacle,
    rooftopCourseFor,
} from "../game/plugins/rooftopagility/RooftopObstacles";
import type { SceneLoc } from "../game/scene/SceneGeometry";

const repository = join(process.cwd(), "..");
const serverIdentifiers = readFileSync(
    join(repository, "server/src/main/typescript/elvarg/util/ObjectIdentifiers.ts"),
    "utf8",
);
const idByName = new Map<string, number>();
for (const match of serverIdentifiers.matchAll(/public static ([A-Z0-9_]+) = (\d+);/g)) {
    idByName.set(match[1], Number(match[2]));
}

function objectIdsIn(text: string): number[] {
    return [...text.matchAll(/ObjectIds\.([A-Z0-9_]+)/g)]
        .map((match) => idByName.get(match[1]))
        .filter((id): id is number => id !== undefined);
}

// --- The list comes from the server's rooftop course data ---------------------------------------
const coursesDirectory = join(repository, "server/plugins/skills/agility/courses");
const courseFiles = readdirSync(coursesDirectory).filter((file) => file.endsWith(".js"));
const rooftopFiles = courseFiles.filter((file) => file.includes("Rooftop"));
const otherAgilityFiles = courseFiles.filter((file) => !file.includes("Rooftop"));

const serverCourses = new Map<string, Set<number>>();
for (const file of rooftopFiles) {
    const text = readFileSync(join(coursesDirectory, file), "utf8");
    const name = /name:\s*"([^"]+)"/.exec(text)?.[1];
    assert.ok(name, `${file} names its course`);
    serverCourses.set(name, new Set(objectIdsIn(text)));
}

assert.equal(ROOFTOP_COURSES.length, rooftopFiles.length, "one client course per server rooftop course");
for (const course of ROOFTOP_COURSES) {
    assert.equal(new Set(course.obstacles).size, course.obstacles.length, `${course.name} has no duplicate ids`);
    const expected = serverCourses.get(course.name);
    assert.ok(expected, `${course.name} exists in the server course data`);
    assert.deepEqual(
        [...course.obstacles].sort((a, b) => a - b),
        [...expected].sort((a, b) => a - b),
        `${course.name} matches its server obstacle ids`,
    );
}

const otherAgilityIds = new Set(otherAgilityFiles.flatMap((file) =>
    objectIdsIn(readFileSync(join(coursesDirectory, file), "utf8"))));
for (const id of ROOFTOP_OBSTACLE_IDS) {
    assert.ok(!otherAgilityIds.has(id), `${id} is not another agility course's object`);
}

assert.equal(idByName.get("ROUGH_WALL"), ObjectID.ROOFTOPS_DRAYNOR_WALLCLIMB);
assert.equal(idByName.get("GAP_37"), ObjectID.ROOFTOPS_ARDY_JUMP_4);
assert.ok(isRooftopObstacle(ObjectID.ROOFTOPS_DRAYNOR_WALLCLIMB));
assert.equal(rooftopCourseFor(ObjectID.ROOFTOPS_DRAYNOR_WALLCLIMB), "Draynor Village Rooftop");
assert.ok(!isRooftopObstacle(ObjectID.AGILITYARENA_MONKEYBARS_MIDDLE), "other agility objects are excluded");

// --- Config and plugin --------------------------------------------------------------------------
assert.equal(RooftopAgilityPlugin.descriptor.enabledByDefault, false, "off until enabled");
assert.equal(RooftopAgilityPlugin.descriptor.configKey, "rooftopagilityplugin");
assert.equal(RooftopAgilityPlugin.config, RooftopAgilityConfig);
assert.equal(RooftopAgilityConfig.group, "rooftopagility");
assert.equal(RooftopAgilityConfig.items.clickboxColor.default, 0xff00e5ff, "cyan border");
assert.equal(RooftopAgilityConfig.items.fillColor.default, 0x4000e5ff, "translucent cyan fill");

const config = inject(ConfigManager);
config.setConfigValue(RooftopAgilityConfig, "showClickboxes", true);
ClientState.baseX = 3200;
ClientState.baseY = 3200;
ClientState.plane = 0;

const rooftop: SceneLoc = {
    id: ObjectID.ROOFTOPS_DRAYNOR_WALLCLIMB,
    tileX: 3205,
    tileY: 3205,
    plane: 0,
    shape: 10,
    rotation: 0,
};
const unrelated: SceneLoc = {
    id: ObjectID.AGILITYARENA_MONKEYBARS_MIDDLE,
    tileX: 3206,
    tileY: 3205,
    plane: 0,
    shape: 10,
    rotation: 0,
};
const otherPlane: SceneLoc = {
    id: ObjectID.ROOFTOPS_DRAYNOR_TIGHTROPE_1,
    tileX: 3207,
    tileY: 3205,
    plane: 1,
    shape: 10,
    rotation: 0,
};
const scene = new Map<string, SceneLoc[]>();
for (const loc of [rooftop, unrelated, otherPlane]) {
    const key = `${loc.tileX},${loc.tileY},${loc.plane}`;
    scene.set(key, [...(scene.get(key) ?? []), loc]);
}

const client: any = {
    gameState: 30,
    controlledPlayerServerId: 1,
    playerEcs: {
        getIndexForServerId: () => 0,
        getX: () => 3200 * 128 + 64,
        getY: () => 3200 * 128 + 64,
        getLevel: () => 0,
    },
    sceneGeometry: {
        locsAtTile: (x: number, y: number, plane: number) => scene.get(`${x},${y},${plane}`) ?? [],
        tileHeight: () => 0,
        worldToScreen: (x: number, height: number, y: number) => [x * 10, y * 10 + height * 10],
        locModelPoints: (loc: SceneLoc) => [[
            [loc.tileX, 0, loc.tileY],
            [loc.tileX + 1, 0, loc.tileY],
            [loc.tileX + 1, -1, loc.tileY + 1],
            [loc.tileX, -1, loc.tileY + 1],
        ]],
    },
};

async function main(): Promise<void> {
    const plugin = new RooftopAgilityPlugin(client);
    await plugin.start();
    plugin.onGameTick();
    assert.equal(plugin.objects.length, 1, "only the rooftop obstacle on the player's plane");
    assert.equal(plugin.objects[0], rooftop);

    assert.ok(plugin.widgetOverlay.signature() !== "", "a loaded obstacle has a draw signature");
    const strokes: number[][] = [];
    const fills: number[][] = [];
    const rects = plugin.widgetOverlay.draw({
        renderer: {
            drawPolyline: (_points: unknown, _width: unknown, color: number[]) => strokes.push(color),
            drawPolygon: (_points: unknown, color: number[]) => fills.push(color),
        },
    } as any);
    assert.equal(strokes.length, 1);
    assert.equal(fills.length, 1);
    assert.deepEqual(strokes[0].map((value) => Math.round(value * 255)), [0, 229, 255, 255]);
    assert.deepEqual(fills[0].map((value) => Math.round(value * 255)), [0, 229, 255, 64]);
    assert.equal(rects.length, 1, "the overlay reports the covered screen rect");

    config.setConfigValue(RooftopAgilityConfig, "showClickboxes", false);
    plugin.rebuild();
    assert.equal(plugin.objects.length, 0, "the config toggle removes the overlay");
    assert.equal(plugin.widgetOverlay.signature(), "");
    config.setConfigValue(RooftopAgilityConfig, "showClickboxes", true);

    await plugin.stop();
    assert.equal(plugin.objects.length, 0, "shutdown forgets the scene");
}

main()
    .then(() => console.log("rooftop agility plugin tests passed"))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
