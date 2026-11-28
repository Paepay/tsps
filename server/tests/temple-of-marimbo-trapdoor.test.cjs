// Run after 'yarn build': node --test tests/temple-of-marimbo-trapdoor.test.cjs
// Quests-off world: Monkey Madness I's handlers are not loaded, so the shared Doors/Ladders
// plugins must open the Temple of Marimbo trapdoor in place (issue 226) and climb down to the
// rope 6416 tiles north (issues 218/233). Real plugins, cache, map and click packets.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

before(async () => {
  await h.setupQuestsOff([[2807, 2785], [2808, 9201]], {
    pluginFiles: ["objects/Doors.plugin.js", "objects/Ladders.plugin.js"],
  });
});
after(() => h.teardown());

const at = (f) => {
  const l = f.player.getLocation();
  return [l.getX(), l.getY(), l.getZ()];
};
const objectAt = (id, [x, y, z]) => h.core.MapObjects.get(id, new h.core.Location(x, y, z), null);

test("Temple of Marimbo trapdoor opens in place and Climb-down reaches the rope", async (t) => {
  const f = h.actor(t, { at: [2806, 2785, 0] });
  assert.ok(objectAt(4879, [2807, 2785, 0]), "the closed trapdoor is in the cache map");
  await h.clickObject(f, 4879, [2807, 2785], 1); // Open
  assert.ok(objectAt(4880, [2807, 2785, 0]), "the open trapdoor stays on the closed tile");
  assert.equal(objectAt(4880, [2808, 2785, 0]), null, "it does not swing one tile east out of the building");
  assert.equal(objectAt(4879, [2807, 2785, 0]), null, "the closed leaf is replaced");
  await h.clickObject(f, 4880, [2807, 2785], 1); // Climb-down
  for (let i = 0; i < 15 && at(f)[1] !== 9200; i++) h.tick(f);
  assert.deepEqual(at(f), [2808, 9200, 0], "Climb-down lands beside the climbing rope");
});

test("Climb on the rope returns to the surface beside the trapdoor", async (t) => {
  const f = h.actor(t, { at: [2808, 9200, 0] });
  await h.clickObject(f, 4881, [2808, 9201], 1); // Climb (ambiguous)
  assert.equal(h.shown(f)?.who, "menu", "the rope asks which way");
  await h.choose(f, "Climb up");
  for (let i = 0; i < 15 && at(f)[1] !== 2784; i++) h.tick(f);
  assert.deepEqual(at(f), [2807, 2784, 0], "Climb-up lands beside the trapdoor");
});
