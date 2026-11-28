import * as ObjectID from "@runelite/api/gameval/ObjectID";
import type { SceneGeometry, SceneLoc } from "../../scene/SceneGeometry";

/** A rooftop agility course and the obstacle loc ids its server course data uses. */
export type RooftopCourse = {
    readonly name: string;
    readonly obstacles: readonly number[];
};

const course = (name: string, obstacles: readonly number[]): RooftopCourse => ({ name, obstacles });

/**
 * Every obstacle of the ten rooftop courses in server/plugins/skills/agility/courses/*Rooftop*.
 * The ids are the client cache's own ROOFTOPS_* (and Prifddinas) locs; each comment names the
 * server's ObjectIds constant. client/tests/rooftop-agility-plugin.test.ts checks this list
 * against the server course files, so a course change cannot silently drift.
 */
export const ROOFTOP_COURSES: readonly RooftopCourse[] = [
    // AlKharidRooftop
    course("Al Kharid Rooftop", [
        ObjectID.ROOFTOPS_KHARID_WALLCLIMB, // ObjectIds.ROUGH_WALL_2 (11633)
        ObjectID.ROOFTOPS_KHARID_TIGHTROPE_1, // ObjectIds.TIGHTROPE_3 (14398)
        ObjectID.ROOFTOPS_KHARID_ROPE_SWING, // ObjectIds.CABLE (14402)
        ObjectID.ROOFTOPS_KHARID_SLIDE_SIDE, // ObjectIds.ZIP_LINE (14403)
        ObjectID.ROOFTOPS_KHARID_BAMBOO_TREE_TOP, // ObjectIds.TROPICAL_TREE_27 (14404)
        ObjectID.ROOFTOPS_KHARID_WALLCLIMB_2, // ObjectIds.ROOF_TOP_BEAMS (11634)
        ObjectID.ROOFTOPS_KHARID_TIGHTROPE_4, // ObjectIds.TIGHTROPE_4 (14409)
        ObjectID.ROOFTOPS_KHARID_LEAPDOWN, // ObjectIds.GAP_4 (14399)
    ]),
    // ArdougneRooftop
    course("Ardougne Rooftop", [
        ObjectID.ROOFTOPS_ARDY_WALLCLIMB, // ObjectIds.WOODEN_BEAMS (15608)
        ObjectID.ROOFTOPS_ARDY_JUMP, // ObjectIds.GAP_34 (15609)
        ObjectID.ROOFTOPS_ARDY_PLANK, // ObjectIds.PLANK_12 (26635)
        ObjectID.ROOFTOPS_ARDY_JUMP_2, // ObjectIds.GAP_35 (15610)
        ObjectID.ROOFTOPS_ARDY_JUMP_3, // ObjectIds.GAP_36 (15611)
        ObjectID.ROOFTOPS_ARDY_WALLCROSSING, // ObjectIds.STEEP_ROOF (28912)
        ObjectID.ROOFTOPS_ARDY_JUMP_4, // ObjectIds.GAP_37 (15612)
    ]),
    // CanifisRooftop
    course("Canifis Rooftop", [
        ObjectID.ROOFTOPS_CANIFIS_START_TREE, // ObjectIds.TALL_TREE_2 (14843)
        ObjectID.ROOFTOPS_CANIFIS_JUMP, // ObjectIds.GAP_9 (14844)
        ObjectID.ROOFTOPS_CANIFIS_JUMP_2, // ObjectIds.GAP_10 (14845)
        ObjectID.ROOFTOPS_CANIFIS_JUMP_5, // ObjectIds.GAP_13 (14848)
        ObjectID.ROOFTOPS_CANIFIS_JUMP_3, // ObjectIds.GAP_11 (14846)
        ObjectID.ROOFTOPS_CANIFIS_POLEVAULT, // ObjectIds.POLE_VAULT (14894)
        ObjectID.ROOFTOPS_CANIFIS_JUMP_4, // ObjectIds.GAP_12 (14847)
        ObjectID.ROOFTOPS_CANIFIS_LEAPDOWN, // ObjectIds.GAP_14 (14897)
    ]),
    // DraynorRooftop
    course("Draynor Village Rooftop", [
        ObjectID.ROOFTOPS_DRAYNOR_WALLCLIMB, // ObjectIds.ROUGH_WALL (11404)
        ObjectID.ROOFTOPS_DRAYNOR_TIGHTROPE_1, // ObjectIds.TIGHTROPE (11405)
        ObjectID.ROOFTOPS_DRAYNOR_TIGHTROPE_2, // ObjectIds.TIGHTROPE_2 (11406)
        ObjectID.ROOFTOPS_DRAYNOR_WALLCROSSING, // ObjectIds.NARROW_WALL (11430)
        ObjectID.ROOFTOPS_DRAYNOR_WALLSCRAMBLE, // ObjectIds.WALL_13 (11630)
        ObjectID.ROOFTOPS_DRAYNOR_LEAPDOWN, // ObjectIds.GAP_3 (11631)
        ObjectID.ROOFTOPS_DRAYNOR_CRATE, // ObjectIds.CRATE_120 (11632)
    ]),
    // FaladorRooftop
    course("Falador Rooftop", [
        ObjectID.ROOFTOPS_FALADOR_WALLCLIMB, // ObjectIds.ROUGH_WALL_4 (14898)
        ObjectID.ROOFTOPS_FALADOR_TIGHTROPE_1, // ObjectIds.TIGHTROPE_6 (14899)
        ObjectID.ROOFTOPS_FALADOR_HANDHOLDS_START, // ObjectIds.HAND_HOLDS_4 (14901)
        ObjectID.ROOFTOPS_FALADOR_GAP_1, // ObjectIds.GAP_15 (14903)
        ObjectID.ROOFTOPS_FALADOR_GAP_2, // ObjectIds.GAP_16 (14904)
        ObjectID.ROOFTOPS_FALADOR_TIGHTROPE_2, // ObjectIds.TIGHTROPE_7 (14905)
        ObjectID.ROOFTOPS_FALADOR_TIGHTROPE_3, // ObjectIds.TIGHTROPE_8 (14911)
        ObjectID.ROOFTOPS_FALADOR_GAP_3, // ObjectIds.GAP_26 (14919)
        ObjectID.ROOFTOPS_FALADOR_LEDGE_1, // ObjectIds.LEDGE_7 (14920)
        ObjectID.ROOFTOPS_FALADOR_LEDGE_2, // ObjectIds.LEDGE_13 (14921)
        ObjectID.ROOFTOPS_FALADOR_LEDGE_3A, // ObjectIds.LEDGE_14 (14922)
        ObjectID.ROOFTOPS_FALADOR_LEDGE_3B, // ObjectIds.LEDGE_15 (14923)
        ObjectID.ROOFTOPS_FALADOR_LEDGE_4, // ObjectIds.LEDGE_16 (14924)
        ObjectID.ROOFTOPS_FALADOR_EDGE, // ObjectIds.EDGE_2 (14925)
    ]),
    // PollnivneachRooftop
    course("Pollnivneach Rooftop", [
        ObjectID.ROOFTOPS_POLLNIVNEACH_BASKET, // ObjectIds.BASKET_4 (14935)
        ObjectID.ROOFTOPS_POLLNIVNEACH_MARKETSTALL, // ObjectIds.MARKET_STALL_13 (14936)
        ObjectID.ROOFTOPS_POLLNIVNEACH_HANGINGBANNER, // ObjectIds.BANNER_13 (14937)
        ObjectID.ROOFTOPS_POLLNIVNEACH_GAP, // ObjectIds.GAP_30 (14938)
        ObjectID.ROOFTOPS_POLLNIVNEACH_TREE, // ObjectIds.TREE_53 (14939)
        ObjectID.ROOFTOPS_POLLNIVNEACH_WALLCLIMB, // ObjectIds.ROUGH_WALL_5 (14940)
        ObjectID.ROOFTOPS_POLLNIVNEACH_MONKEYBARS_START, // ObjectIds.MONKEYBARS (14941)
        ObjectID.ROOFTOPS_POLLNIVNEACH_TREETOP, // ObjectIds.TREE_126 (14944)
        ObjectID.ROOFTOPS_POLLNIVNEACH_LINE, // ObjectIds.DRYING_LINE (14945)
    ]),
    // PrifddinasRooftop
    course("Prifddinas Agility Course", [
        ObjectID.PRIF_AGILITY_START_LADDER, // ObjectIds.LADDER_392 (36221)
        ObjectID.PRIF_AGILITY_TIGHTROPE_START1, // ObjectIds.TIGHTROPE_15 (36225)
        ObjectID.PRIF_AGILITY_CHIMNEY_JUMP, // ObjectIds.CHIMNEY_5 (36227)
        ObjectID.PRIF_AGILITY_ROOF_JUMP, // ObjectIds.ROOF_EDGE (36228)
        ObjectID.PRIF_AGILITY_DARK_HOLE_ACTIVE, // ObjectIds.DARK_HOLE_8 (36229)
        ObjectID.PRIF_AGILITY_TREE_LADDER_LONG, // ObjectIds.LADDER_393 (36231)
        ObjectID.PRIF_AGILITY_ROPE_BRIDGE1, // ObjectIds.ROPE_BRIDGE_17 (36233)
        ObjectID.PRIF_AGILITY_TIGHTROPE1, // ObjectIds.TIGHTROPE_16 (36234)
        ObjectID.PRIF_AGILITY_ROPE_BRIDGE2, // ObjectIds.ROPE_BRIDGE_18 (36235)
        ObjectID.PRIF_AGILITY_TIGHTROPE2, // ObjectIds.TIGHTROPE_17 (36236)
        ObjectID.PRIF_AGILITY_TIGHTROPE3, // ObjectIds.TIGHTROPE_18 (36237)
        ObjectID.PRIF_AGILITY_DARK_HOLE_END, // ObjectIds.DARK_HOLE_9 (36238)
        ObjectID.PRIF_AGILITY_TREE_LADDER_SHORT, // ObjectIds.LADDER_394 (36232)
    ]),
    // RellekkaRooftop
    course("Rellekka Rooftop", [
        ObjectID.ROOFTOPS_RELLEKKA_WALLCLIMB, // ObjectIds.ROUGH_WALL_6 (14946)
        ObjectID.ROOFTOPS_RELLEKKA_GAP_1, // ObjectIds.GAP_31 (14947)
        ObjectID.ROOFTOPS_RELLEKKA_TIGHTROPE_1, // ObjectIds.TIGHTROPE_10 (14987)
        ObjectID.ROOFTOPS_RELLEKKA_GAP_2, // ObjectIds.GAP_32 (14990)
        ObjectID.ROOFTOPS_RELLEKKA_GAP_3, // ObjectIds.GAP_33 (14991)
        ObjectID.ROOFTOPS_RELLEKKA_TIGHTROPE_3, // ObjectIds.TIGHTROPE_11 (14992)
        ObjectID.ROOFTOPS_RELLEKKA_DROPOFF, // ObjectIds.PILE_OF_FISH (14994)
    ]),
    // SeersRooftop
    course("Seers' Village Rooftop", [
        ObjectID.ROOFTOPS_SEERS_WALLCLIMB, // ObjectIds.WALL_15 (14927)
        ObjectID.ROOFTOPS_SEERS_JUMP, // ObjectIds.GAP_27 (14928)
        ObjectID.ROOFTOPS_SEERS_TIGHTROPE, // ObjectIds.TIGHTROPE_9 (14932)
        ObjectID.ROOFTOPS_SEERS_JUMP_1, // ObjectIds.GAP_28 (14929)
        ObjectID.ROOFTOPS_SEERS_JUMP_2, // ObjectIds.GAP_29 (14930)
        ObjectID.ROOFTOPS_SEERS_LEAPDOWN, // ObjectIds.EDGE_3 (14931)
    ]),
    // VarrockRooftop
    course("Varrock Rooftop", [
        ObjectID.ROOFTOPS_VARROCK_WALLCLIMB, // ObjectIds.ROUGH_WALL_3 (14412)
        ObjectID.ROOFTOPS_VARROCK_CLOTHESLINE, // ObjectIds.CLOTHES_LINE (14413)
        ObjectID.ROOFTOPS_VARROCK_LEAPTORUINS, // ObjectIds.GAP_5 (14414)
        ObjectID.ROOFTOPS_VARROCK_WALLSWING, // ObjectIds.WALL_14 (14832)
        ObjectID.ROOFTOPS_VARROCK_WALLSCRAMBLE, // ObjectIds.GAP_6 (14833)
        ObjectID.ROOFTOPS_VARROCK_LEAPTOBALCONY, // ObjectIds.GAP_7 (14834)
        ObjectID.ROOFTOPS_VARROCK_LEAPDOWN, // ObjectIds.GAP_8 (14835)
        ObjectID.ROOFTOPS_VARROCK_STEPUPROOF, // ObjectIds.LEDGE (14836)
        ObjectID.ROOFTOPS_VARROCK_FINISH, // ObjectIds.EDGE (14841)
    ]),
];

/** A loaded-scene box that holds one copy of a rooftop course's obstacle spawns. */
export type RooftopArea = {
    readonly course: string;
    readonly minX: number;
    readonly maxX: number;
    readonly minY: number;
    readonly maxY: number;
};

const area = (course: string, minX: number, minY: number, maxX: number, maxY: number): RooftopArea =>
    ({ course, minX, minY, maxX, maxY });

/**
 * Where the ten courses' obstacle locs stand in the cache's map, padded for the client's
 * multi-tile loc origins. The courses span planes 0-3 (a roof segment is often a plane above the
 * one before it), and Ardougne, Prifddinas and Varrock also have a second copy used by instances.
 * Built from `server/scripts/dump-loc.ts` placements; `rooftop-agility-cache.test.ts` checks every
 * course id is present in the cache inside its boxes.
 */
export const ROOFTOP_AREAS: readonly RooftopArea[] = [
    area("Al Kharid Rooftop", 3261, 3155, 3326, 3203),
    area("Ardougne Rooftop", 2645, 3288, 2681, 3326),
    area("Ardougne Rooftop", 3349, 5912, 3385, 5950),
    area("Canifis Rooftop", 3470, 3468, 3518, 3512),
    area("Draynor Village Rooftop", 3080, 3247, 3111, 3287),
    area("Falador Rooftop", 3003, 3324, 3058, 3369),
    area("Pollnivneach Rooftop", 3341, 2954, 3375, 3008),
    area("Prifddinas Agility Course", 2235, 3382, 2302, 3440),
    area("Prifddinas Agility Course", 3250, 6098, 3302, 6192),
    area("Rellekka Rooftop", 2613, 3646, 2662, 3685),
    area("Seers' Village Rooftop", 2692, 3453, 2737, 3500),
    area("Varrock Rooftop", 3183, 3389, 3248, 3424),
    area("Varrock Rooftop", 3887, 4861, 3948, 4896),
];

const COURSE_BY_OBSTACLE = new Map<number, string>();
for (const rooftopCourse of ROOFTOP_COURSES) {
    for (const id of rooftopCourse.obstacles) COURSE_BY_OBSTACLE.set(id, rooftopCourse.name);
}

/** Every obstacle loc id the ten rooftop courses use. */
export const ROOFTOP_OBSTACLE_IDS: ReadonlySet<number> = new Set(COURSE_BY_OBSTACLE.keys());

/** Whether a loaded loc is one of the rooftop courses' obstacles. */
export function isRooftopObstacle(id: number): boolean {
    return COURSE_BY_OBSTACLE.has(id);
}

/**
 * Every rooftop obstacle loc in the loaded scene. Rooftop courses stack obstacles on planes 0-3,
 * so all four are scanned inside the cache-derived course boxes rather than only the player's
 * plane: a single-plane scan hides every gap, ledge or rope on another level. Tiles outside the
 * course boxes (the rest of the 104x104 scene) are skipped, keeping the per-tick cost low.
 */
export function collectRooftopObstacles(
    geometry: Pick<SceneGeometry, "locsAtTile">,
    baseX: number,
    baseY: number,
    sceneSize = 104,
): SceneLoc[] {
    const objects: SceneLoc[] = [];
    const seen = new Set<string>();
    for (const courseArea of ROOFTOP_AREAS) {
        const minX = Math.max(courseArea.minX, baseX);
        const maxX = Math.min(courseArea.maxX, baseX + sceneSize - 1);
        const minY = Math.max(courseArea.minY, baseY);
        const maxY = Math.min(courseArea.maxY, baseY + sceneSize - 1);
        if (minX > maxX || minY > maxY) continue;
        for (let plane = 0; plane < 4; plane++) {
            for (let x = minX; x <= maxX; x++) {
                for (let y = minY; y <= maxY; y++) {
                    for (const loc of geometry.locsAtTile(x, y, plane)) {
                        if (!isRooftopObstacle(loc.id)) continue;
                        const key = `${loc.id},${loc.tileX},${loc.tileY},${loc.plane},${loc.shape},${loc.rotation}`;
                        if (seen.has(key)) continue;
                        seen.add(key);
                        objects.push(loc);
                    }
                }
            }
        }
    }
    return objects;
}

/** The rooftop course an obstacle belongs to, if any. */
export function rooftopCourseFor(id: number): string | undefined {
    return COURSE_BY_OBSTACLE.get(id);
}
