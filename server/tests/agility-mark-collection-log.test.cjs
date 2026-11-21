// Run after `yarn build`: node --test tests/agility-mark-collection-log.test.cjs
// A Mark of Grace is credited to the collection log when the lap spawns it, not when it is taken.
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");

require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Location } = require("../dist/game/model/Location");
const { ItemOnGroundManager } = require("../dist/game/entity/impl/grounditem/ItemOnGroundManager");
const { COURSES } = require("../plugins/skills/agility/courses/Courses.Agility");

const MARK = 11849;
const COURSE = COURSES.find((course) => course.key === "draynor");
let core;
let Agility;
let next = 2600;
let deny = false;
let spawnAmount = 0;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  core = PM.getCoreApi();
  core.RegionManager.init();
  require("../plugins/achievements/CollectionLog.plugin").register(PM.createApi("CollectionLog"));
  Agility = require("../plugins/skills/Agility.plugin");
  Agility.register(PM.createApi("Agility"));
  const policy = PM.createApi("MarkCollectionPolicy");
  policy.onCustomEvent("ground-items:take", (request) => {
    if (deny) request.allow = false;
  });
  policy.onCustomEvent("agility:mark", (spawn) => {
    if (spawnAmount > 0) spawn.items = [[MARK, spawnAmount]];
  });
});

function player() {
  const p = new Player(null);
  p.setIndex(next++);
  p.setUsername(`markclog${next}`);
  p.setRegistered(true);
  p.setLocation(new Location(...COURSE.marks.tiles[0]));
  p.getSkillManager().setCurrentLevels(core.Skill.AGILITY, 10, false).setMaxLevels(core.Skill.AGILITY, 10, false);
  p.getPacketSender = () => new Proxy({ sendItemContainer: () => {}, sendMessage: () => {} },
    { get: (target, key) => target[key] ?? (() => {}) });
  return p;
}

function roll(p) {
  const random = Math.random;
  Math.random = () => 0;
  try {
    return Agility.rollMarkOfGrace(p, COURSE);
  } finally {
    Math.random = random;
  }
}

function floorMarks(p) {
  return ItemOnGroundManager.ownedBy(p.getUsername()).filter((item) => item.getItem().getId() === MARK);
}

function credited(p) {
  return (p.getAttribute("clog.items") ?? {})[MARK] ?? 0;
}

test("a spawned course mark is credited before pickup, and takes no second credit", (t) => {
  const p = player();
  t.after(() => floorMarks(p).forEach((mark) => ItemOnGroundManager.deregister(mark)));
  assert.deepEqual(roll(p), [[MARK, 1]]);
  assert.equal(credited(p), 1, "the drop itself fills the slot");
  const [mark] = floorMarks(p);
  assert.ok(mark, "the mark is on the course");
  p.setLocation(mark.getPosition().clone());
  assert.equal(ItemOnGroundManager.transferToInventory(p, mark), 1);
  assert.equal(credited(p), 1, "the successful pickup does not count it again");
});

test("content that increases the spawn credits the amount actually dropped", (t) => {
  const p = player();
  t.after(() => floorMarks(p).forEach((mark) => ItemOnGroundManager.deregister(mark)));
  spawnAmount = 3;
  try {
    assert.deepEqual(roll(p), [[MARK, 3]]);
    assert.equal(credited(p), 3);
  } finally {
    spawnAmount = 0;
  }
});

test("a refused pickup leaves the spawn's log credit intact", (t) => {
  const p = player();
  t.after(() => floorMarks(p).forEach((mark) => ItemOnGroundManager.deregister(mark)));
  roll(p);
  const [mark] = floorMarks(p);
  p.setLocation(mark.getPosition().clone());
  deny = true;
  try {
    assert.equal(ItemOnGroundManager.transferToInventory(p, mark), 0);
    assert.equal(credited(p), 1);
    assert.equal(floorMarks(p).length, 1, "the mark is still on the floor");
  } finally {
    deny = false;
  }
});

test("a lap that spawns no mark adds no collection-log slot", () => {
  const p = player();
  const random = Math.random;
  Math.random = () => 0.99;
  try {
    assert.deepEqual(Agility.rollMarkOfGrace(p, COURSE), []);
  } finally {
    Math.random = random;
  }
  assert.equal(credited(p), 0);
});
