const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const CRACK = [3627, 3329, 0];
const NEAR_CRACK = [3627, 3327, 0];

let I, O;
before(async () => {
  await h.setup([[3627, 3327], [3627, 3329], [3627, 3331], [3592, 3336], [3627, 3332]]);
  I = h.core.ItemIdentifiers;
  O = h.core.ObjectIdentifiers;
});
after(() => h.teardown());

test("the Meyerditch crack still leads into Darkmeyer after Sins of the Father (#53)", async (t) => {
  const f = h.actor(t, { stage: 138, at: NEAR_CRACK, questKey: "sins_of_the_father", done: [] });
  // The crack is an object below the player; clicking Enter squeezes through.
  await h.dispatch(f, { type: "object_option", id: 39170, x: CRACK[0], y: CRACK[1], clickType: 1 });
  h.ticks(f, 4);
  assert.deepEqual([f.player.getLocation().getX(), f.player.getLocation().getY()], [3627, 3332]);
});

test("Drakan's medallion offers Darkmeyer once the quest is complete (#53)", async (t) => {
  const f = h.actor(t, { stage: 138, at: NEAR_CRACK, questKey: "sins_of_the_father", done: [] });
  f.player.getInventory().add(new h.core.Item(I.DRAKANS_MEDALLION, 1), false);
  const destination = { label: "Darkmeyer", tile: { x: 3592, y: 3337, z: 0 } };
  const Medallion = require("../plugins/items/DrakansMedallion.plugin");
  assert.ok(Medallion._test.destinationsFor(f.player).some((entry) => entry.label === "Darkmeyer"), "the medallion menu offers it");
  const event = { player: f.player, destinations: [] };
  h.PM.emitCustomEvent("drakan-medallion:destinations", event);
  const found = event.destinations.find((entry) => entry.label === destination.label);
  assert.ok(found, `Darkmeyer in ${JSON.stringify(event.destinations)}`);
  assert.deepEqual([found.tile.x, found.tile.y, found.tile.z], [destination.tile.x, destination.tile.y, destination.tile.z]);
});
