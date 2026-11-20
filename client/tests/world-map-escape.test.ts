import { strict as assert } from "node:assert";

import { hasOpenModal } from "../game/widgets/input/widgetKeyboardInput";

const manager = (parents: Array<[number, { group: number; type: number }]>) =>
    ({ interfaceParents: new Map(parents) }) as any;

assert.equal(hasOpenModal(manager([[(161 << 16) | 18, { group: 595, type: 1 }]])), true,
    "the world map overlay holds Escape even though it is a type-1 floater");
assert.equal(hasOpenModal(manager([[1, { group: 12, type: 0 }]])), true, "ordinary modals still count");
assert.equal(hasOpenModal(manager([[(161 << 16) | 3, { group: 161, type: 1 }]])), false,
    "an ordinary type-1 overlay is not a modal");

console.log("world-map-escape.test.ts: all tests passed");
