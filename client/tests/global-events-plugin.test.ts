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

const context: any = {
    place: () => ({ x: 10, y: 20, scaleX: 1, scaleY: 1 }),
    renderer: { drawRect() {}, drawTexture() {} },
};

// The Events interface is Developer-only in game. Until the server says this player can open it
// (and for every state that omits or denies it) the button is neither drawn nor clickable.
assert.deepEqual(overlay.draw(context), [], "no icon before the server has sent any state");
plugin.onPluginMessage(new PluginMessage("global-events", { type: "state", activeKey: "", slots: {} }));
assert.deepEqual(overlay.draw(context), [], "a state without canOpen hides the icon");
assert.deepEqual(overlay.menuEntries(), [], "no Open menu entry without canOpen");
plugin.onPluginMessage(new PluginMessage("global-events", { type: "state", canOpen: false, activeKey: "", slots: {} }));
assert.deepEqual(overlay.draw(context), [], "canOpen=false hides the icon");
assert.equal((plugin as any).iconBounds, undefined, "a hidden icon has no hit box to click");
let opened = 0;
(plugin as any).osrsClient = { isLoggedIn: () => true, inputManager: { element: {} } };
(plugin as any).open = () => { opened++; };
assert.equal((plugin as any).onTouchTap(15, 25), false, "tapping where the icon would be does nothing");
assert.equal(opened, 0);

// The server sends state once on login; the client is still CONNECTING/LOADING_GAME at that
// point, so those transitions must not discard it (Paepay/tsps#65 follow-up).
plugin.onPluginMessage(new PluginMessage("global-events", {
    type: "state",
    canOpen: true,
    activeKey: "instance-1",
    iconItemId: 4151,
    iconName: "Berserker",
    slots: { combat: { eventId: "berserker" }, skilling: null, utility: null },
}));
assert.equal((plugin as any).activeKey, "instance-1");
assert.equal((plugin as any).iconItemId, 4151);
assert.equal((plugin as any).activeCount, 1);
assert.equal((plugin as any).flashing, true);
assert.equal((plugin as any).canOpen, true);

for (const state of [GameState.LOGGING_IN, GameState.LOADING, GameState.LOGGED_IN]) {
    plugin.onGameStateChanged(new GameStateChanged(state));
    assert.equal((plugin as any).activeKey, "instance-1", `state survives ${GameState[state]}`);
    assert.equal((plugin as any).canOpen, true, `the permission survives ${GameState[state]}`);
}

// The icon draws the item box, not just the state.
let placedOverlay: unknown;
const placing: any = {
    place: (overlayToPlace: unknown) => {
        placedOverlay = overlayToPlace;
        return { x: 10, y: 20, scaleX: 1, scaleY: 1 };
    },
    renderer: { drawRect() {}, drawTexture() {} },
};
assert.deepEqual(overlay.draw(placing), [{ x: 10, y: 20, w: 24, h: 24 }]);
assert.equal(placedOverlay, overlay);
assert.deepEqual(overlay.menuEntries().map((entry: any) => entry.option), ["Open"]);
assert.equal((plugin as any).onTouchTap(15, 25), true, "a developer can tap the icon");
assert.equal(opened, 1);

// Opening the interface stops the flash, and leaving the world clears the icon and the permission.
plugin.onPluginMessage(new PluginMessage("global-events", { type: "seen", activeKey: "instance-1" }));
assert.equal((plugin as any).flashing, false);
plugin.onGameStateChanged(new GameStateChanged(GameState.LOGIN_SCREEN));
assert.equal((plugin as any).activeKey, "");
assert.equal((plugin as any).iconItemId, -1);
assert.equal((plugin as any).canOpen, false, "the next account must not inherit the permission");
loggedIn = false;
assert.deepEqual(overlay.draw(placing), []);
loggedIn = true;

// A developer's button stays on the HUD after login even with no event running, so the Events
// interface is always one click away.
const idle = new GlobalEventsPlugin({ isLoggedIn: () => true } as any);
const idleOverlay = (idle as any).widgetOverlay;
idle.onPluginMessage(new PluginMessage("global-events", { type: "state", canOpen: true, activeKey: "", slots: {} }));
assert.deepEqual(idleOverlay.draw(placing), [{ x: 10, y: 20, w: 24, h: 24 }]);
assert.notEqual(idleOverlay.signature(), "");
assert.deepEqual(idleOverlay.menuEntries().map((entry: any) => entry.option), ["Open"]);

console.log("global-events-plugin: ok");
