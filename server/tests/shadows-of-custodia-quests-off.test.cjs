// Run after 'yarn build': node --test tests/shadows-of-custodia-quests-off.test.cjs
// A Quests-off world auto-completes Shadows of Custodia. The quest module's object hooks are
// behind the definition-only proxy, so the QuestAutoComplete shim must keep its main Cave
// usable, and it must land on walkable cache tiles (issue 207). The southern crawling shortcut
// is the Agility plugin's, gated on the same auto-completed quest.
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

before(async () => {
  await h.setupQuestsOff([[1295, 3373], [1295, 9768], [1296, 9767], [1295, 3376], [1324, 3364]]);
});
after(() => h.teardown());

const at = (f) => {
  const l = f.player.getLocation();
  return [l.getX(), l.getY(), l.getZ()];
};
const walkable = ([x, y, z]) =>
  h.core.RegionManager.blocked(new h.core.Location(x, y, z), null) === false;

test("the Stalker Den Cave enters and exits on safe cache tiles", async (t) => {
  const f = h.actor(t, { at: [1294, 3374, 0] });
  assert.equal(walkable([1296, 9767, 0]), true, "the den-side landing is walkable, not a wall");
  assert.equal(walkable([1295, 3376, 0]), true, "the Custodia Pass landing is walkable");

  await h.clickObject(f, 56439, [1295, 3373], 1); // Cave: Enter
  assert.deepEqual(at(f), [1296, 9767, 0], "the main entrance lands inside the Stalker Den");

  await h.clickObject(f, 56440, [1295, 9768], 1); // Cave: Exit
  assert.deepEqual(at(f), [1295, 3376, 0], "the exit returns to the Custodia Pass mouth");
});

test("the southern crawling shortcut's quest gate is open on a Quests-off world", async (t) => {
  const f = h.actor(t, { at: [1324, 3363, 0] });
  const request = { player: f.player, key: "shadows_of_custodia", complete: null };
  h.PM.emitCustomEvent("quest:is-complete", request);
  assert.equal(request.complete, true, "QuestAutoComplete answers the shortcut's quest gate");

  const { shortcuts } = require("../plugins/skills/data/agility-shortcuts.json");
  const cave = shortcuts.find((entry) => entry.object === 57278 || entry.object === 57279
    || (Array.isArray(entry.object) && entry.object.includes(57278)));
  assert.ok(cave, "the Stalker Den shortcut is present");
  assert.equal(cave.level, 59);
  assert.equal(cave.requires[0].quest.key, "shadows_of_custodia");
});
