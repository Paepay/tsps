// node --test tests/drakans-medallion-destinations.test.cjs
// Drakan's medallion: the four destinations, their unlock gates and landing tiles (#131, #146).
// The landing tiles are the Wiki's teleport table and RuneLite's teleportation_items.tsv.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const Medallion = require("../plugins/items/DrakansMedallion.plugin");
const SLEPE_UNLOCKED = "drakans-medallion:slepe-unlocked";
const CASTLE_STORY = "quest.the_blood_moon_rises.slepe-story";
const CASTLE_SHRINE = "quest.the_blood_moon_rises.castle-shrine-prayed";

before(async () => {
  await h.setup([[2869, 2982], [3592, 3337], [3808, 9700], [3166, 7711]]);
});
after(() => h.teardown());

function actor(t, options = {}) {
  return h.actor(t, { at: [2869, 2982, 1], done: [], stage: 0, ...options });
}

const labels = (player) => Medallion._test.destinationsFor(player).map((entry) => entry.label);
const landing = (player, label) => {
  const found = Medallion._test.destinationsFor(player).find((entry) => entry.label === label);
  return found && [found.tile.x, found.tile.y, found.tile.z];
};

test("before any unlock the medallion offers only Ver Sinhaza", (t) => {
  const f = actor(t);
  assert.deepEqual(labels(f.player), ["Ver Sinhaza"]);
  assert.deepEqual(landing(f.player, "Ver Sinhaza"), [3649, 3230, 0]);
});

test("Darkmeyer joins once Sins of the Father is complete, at the captured landing (#53, #131)", (t) => {
  const before = actor(t, { questKey: "sins_of_the_father", stage: 137 });
  assert.equal(labels(before.player).includes("Darkmeyer"), false, "not before completion");
  const after = actor(t, { questKey: "sins_of_the_father", stage: 138 });
  assert.deepEqual(labels(after.player), ["Ver Sinhaza", "Darkmeyer"]);
  assert.deepEqual(landing(after.player, "Darkmeyer"), [3592, 3337, 0]);
});

test("Slepe joins after a Slepey tablet, and lands in the Sisterhood Sanctuary (#146)", (t) => {
  const f = actor(t);
  assert.equal(labels(f.player).includes("Slepe"), false);
  f.player.setAttribute(SLEPE_UNLOCKED, true);
  assert.deepEqual(landing(f.player, "Slepe"), [3808, 9700, 1]);
});

test("Castle Drakan needs the castle shrine and the refinery, and lands at 3166,7711 (#146)", (t) => {
  const f = actor(t, {
    questKey: "the_blood_moon_rises",
    stage: 30,
    attributes: { [CASTLE_STORY]: {} },
  });
  assert.equal(labels(f.player).includes("Castle Drakan"), false, "refinery not complete");
  f.player.setAttribute(CASTLE_STORY, { refineryComplete: true });
  assert.equal(labels(f.player).includes("Castle Drakan"), false, "shrine not inspected");
  f.player.setAttribute(CASTLE_SHRINE, true);
  assert.deepEqual(labels(f.player), ["Ver Sinhaza", "Castle Drakan"]);
  assert.deepEqual(landing(f.player, "Castle Drakan"), [3166, 7711, 0]);
  h.quest("the_blood_moon_rises").setStage(f.player, 29);
  assert.equal(labels(f.player).includes("Castle Drakan"), false, "the quest must have reached Slepe");
});

test("with every unlock the menu keeps the cache's worn-option order", (t) => {
  const f = actor(t, {
    questKey: "sins_of_the_father",
    stage: 138,
    attributes: {
      [CASTLE_STORY]: { refineryComplete: true },
      [CASTLE_SHRINE]: true,
      [SLEPE_UNLOCKED]: true,
    },
  });
  h.quest("the_blood_moon_rises").setStage(f.player, 30);
  assert.deepEqual(labels(f.player), ["Ver Sinhaza", "Darkmeyer", "Slepe", "Castle Drakan"]);
});
