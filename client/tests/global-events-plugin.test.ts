import { strict as assert } from "node:assert";
import { GameState } from "@runelite/api/GameState";
import { GameStateChanged, PluginMessage } from "@runelite/api/events";
import { OverlayPosition } from "@runelite/client/ui/overlay/OverlayPosition";
import { GlobalEventsPlugin, HUD_ITEM_ID } from "../game/plugins/globalevents/GlobalEventsPlugin";

let loggedIn = true;
const client: any = { isLoggedIn: () => loggedIn };
const plugin = new GlobalEventsPlugin(client);

// OverlayRenderer.placeOverlay() ignores an overlay without `movable`, so the icon would never
// draw without it.
const overlay = (plugin as any).widgetOverlay;
assert.ok(overlay.movable, "the HUD icon must be a movable overlay");
assert.equal(overlay.movable.name, "GlobalEvents");
assert.equal(overlay.movable.position, OverlayPosition.BELOW_SPECIAL_ATTACK,
    "the icon sits just under the special-attack orb");
assert.equal(HUD_ITEM_ID, 1042, "the HUD icon is a blue partyhat, not the event's item");

// The server sends state once on login; the client is still CONNECTING/LOADING_GAME at that
// point, so those transitions must not discard it (Paepay/tsps#65 follow-up).
plugin.onPluginMessage(new PluginMessage("global-events", {
    type: "state",
    activeKey: "instance-1",
    iconItemId: 4151,
    iconName: "Berserker",
    slots: { combat: { eventId: "berserker" }, skilling: null, utility: null },
}));
assert.equal((plugin as any).activeKey, "instance-1");
assert.equal((plugin as any).iconItemId, 4151);
assert.equal((plugin as any).activeCount, 1);
assert.equal((plugin as any).flashing, true);

for (const state of [GameState.LOGGING_IN, GameState.LOADING, GameState.LOGGED_IN]) {
    plugin.onGameStateChanged(new GameStateChanged(state));
    assert.equal((plugin as any).activeKey, "instance-1", `state survives ${GameState[state]}`);
}

// The icon draws the item box, not just the state.
let placedOverlay: unknown;
const context: any = {
    place: (overlayToPlace: unknown) => {
        placedOverlay = overlayToPlace;
        return { x: 10, y: 20, scaleX: 1, scaleY: 1 };
    },
    renderer: { drawRect() {}, drawTexture() {} },
};
assert.deepEqual(overlay.draw(context), [{ x: 10, y: 20, w: 24, h: 24 }]);
assert.equal(placedOverlay, overlay);

// Opening the interface stops the flash, and leaving the world clears the icon.
plugin.onPluginMessage(new PluginMessage("global-events", { type: "seen", activeKey: "instance-1" }));
assert.equal((plugin as any).flashing, false);
plugin.onGameStateChanged(new GameStateChanged(GameState.LOGIN_SCREEN));
assert.equal((plugin as any).activeKey, "");
assert.equal((plugin as any).iconItemId, -1);
loggedIn = false;
assert.deepEqual(overlay.draw(context), []);
loggedIn = true;

// The button stays on the HUD after login even with no event running, so the Events
// interface is always one click away.
const idle = new GlobalEventsPlugin({ isLoggedIn: () => true } as any);
const idleOverlay = (idle as any).widgetOverlay;
assert.deepEqual(idleOverlay.draw(context), [{ x: 10, y: 20, w: 24, h: 24 }]);
assert.notEqual(idleOverlay.signature(), "");
assert.deepEqual(idleOverlay.menuEntries().map((entry: any) => entry.option), ["Open"]);

console.log("global-events-plugin: ok");

