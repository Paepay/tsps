// A single finger on a widget the mouse can drag must start that drag, whether or not the
// widget carries an item. The Beekeeper's hive parts (interface 420, components 10-13/15/17/19/21)
// are model widgets the cache flags as drop targets with a drag parent (flags 0x120000) and
// scripts 3056/3060 give them an onDragComplete; they have no item id. The old touch gate
// required itemId >= 0, so pressing a part fell through to camera orbit (issue #128).
import assert from "node:assert/strict";

import { TouchGestureRecognizer } from "../game/input/TouchGestureRecognizer";
import { resolveTouchWidgetDrag } from "../game/widgets/input/widgetTouchScrollInput";

const group = (id: number) => (id << 16) | 0;

const managerFor = (widgets: any[]) => {
    const byUid = new Map(widgets.map((widget) => [widget.uid, widget]));
    return {
        getWidgetByUid: (uid: number) => byUid.get(uid),
        getWidgetFlags: (widget: any) => widget?.flags ?? 0,
        isEffectivelyHidden: (uid: number) => {
            const widget = byUid.get(uid);
            return widget?.hidden === true || widget?.isHidden === true;
        },
    } as any;
};

const types = (intents: Array<{ type: string }>) => intents.map((intent) => intent.type);

const beekeeperRoot = { uid: group(420), type: 0, flags: 0, parentUid: -1 };
const hivePart = {
    uid: group(420) | 10,
    type: 6,
    itemId: -1,
    flags: 0x120000, // FLAG_DRAG_ON (bit 20) + drag parent depth 1 (bits 17-19)
    parentUid: group(420),
    eventHandlers: { onDragComplete: { scriptId: 3062, intArgs: [] } },
};
const manager = managerFor([beekeeperRoot, hivePart]);

assert.equal(
    resolveTouchWidgetDrag([beekeeperRoot, hivePart], manager),
    true,
    "the Beekeeper's model parts drag without an item id",
);

{
    const recognizer = new TouchGestureRecognizer();
    const drag = resolveTouchWidgetDrag([beekeeperRoot, hivePart], manager);
    assert.deepEqual(types(recognizer.fingerDown(100, 100, 0, false, drag)), ["move", "widgetPress"]);
    const moved = recognizer.fingerMove(160, 100, 200);
    assert.deepEqual(types(moved), ["move"], "dragging the part does not orbit the camera");
    assert.deepEqual(types(recognizer.fingerUp(160, 100, 300)), ["move", "widgetRelease"]);
}

{
    const hiddenPart = { ...hivePart, uid: group(420) | 11, hidden: true };
    assert.equal(
        resolveTouchWidgetDrag([beekeeperRoot, hivePart, hiddenPart], managerFor([beekeeperRoot, hivePart, hiddenPart])),
        true,
    );
}

{
    const label = { uid: group(420) | 14, type: 4, itemId: -1, flags: 0, parentUid: group(420) };
    assert.equal(resolveTouchWidgetDrag([beekeeperRoot, label], managerFor([beekeeperRoot, label])), false);
}

{
    const scriptDraggable = { uid: group(420) | 12, type: 6, itemId: -1, flags: 0, parentUid: group(420), isDraggable: true };
    assert.equal(resolveTouchWidgetDrag([beekeeperRoot, scriptDraggable], managerFor([beekeeperRoot, scriptDraggable])), true);
}

{
    const bank = { uid: group(149), type: 0, height: 100, scrollHeight: 400, parentUid: -1, onScroll: [36, 2, 1, 32] };
    const bankItem = { uid: group(149) | 3, type: 5, itemId: 995, flags: 0x120000, parentUid: group(149) };
    assert.equal(resolveTouchWidgetDrag([bank, bankItem], managerFor([bank, bankItem])), "afterHold");

    const loadout = { uid: group(679), type: 0, height: 200, scrollHeight: 0, parentUid: -1 };
    const loadoutItem = { uid: group(679) | 11, type: 5, itemId: 385, flags: 0x120000, parentUid: group(679) };
    assert.equal(resolveTouchWidgetDrag([loadout, loadoutItem], managerFor([loadout, loadoutItem])), true);
}

console.log("Touch widget drag without item test passed");
