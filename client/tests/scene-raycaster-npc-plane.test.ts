import assert from "node:assert/strict";

// PicoGL expects a browser global when SceneRaycaster imports WebGLMapSquare.
(globalThis as any).self = globalThis;
const { SceneRaycaster } = require("../game/scene/SceneRaycaster");
const { Ray } = require("../game/math/Raycast");

// Slayer Tower issue #149: the same tile exists on several floors. The client may only
// pick the NPC on the player's raw client plane, never the one directly below it.
const levels: Record<number, number> = { 1: 2, 2: 1, 3: 1 };
const npcEcs = {
    queryByMap: () => [1, 2, 3],
    isActive: () => true,
    isLinked: () => true,
    getMapId: () => 7,
    getWorldViewId: () => -1,
    getWorldX: () => 10 * 128 + 64,
    getWorldY: () => 10 * 128 + 64,
    getSize: () => 1,
    getNpcTypeId: (id: number) => 100 + id,
    getLevel: (id: number) => levels[id],
    getServerId: (id: number) => 40 + id,
};
const npcTypeLoader = { load: (id: number) => ({ id, modelIds: [1] }) };
const raycaster = new SceneRaycaster({}, { npcEcs, npcTypeLoader });
raycaster.sampleHeightAt = () => 0;

const pick = (plane?: number) => {
    const hits: any[] = [];
    raycaster.collectNpcHitsForMap(
        { id: 7, mapX: 0, mapY: 0 },
        new Ray([10.5, -10, 10.5], [0, 1, 0]),
        100,
        hits,
        plane,
    );
    return hits.map((hit) => hit.npcServerId).sort((a, b) => a - b);
};

assert.deepEqual(pick(2), [41], "the top floor only picks the top-floor NPC");
assert.deepEqual(pick(1), [42, 43], "the floor below picks its two NPCs");
assert.deepEqual(pick(), [41, 42, 43], "unfiltered edit-mode picking still sees every plane");
console.log("Scene raycaster NPC plane regression passed");
