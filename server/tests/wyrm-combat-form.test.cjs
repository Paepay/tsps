// Wyrm combat forms (#73): the crawling idle NPC and the upright attacking NPC are separate
// cache ids, and the attack/death sequences are rigged for the attacking one. Playing them on
// the crawling model stretches it apart. The spawn definition names its combat form
// (npc-combat-defs.json `combatForm`) and the NPC swaps to it while fighting, then back.
//
// Run after `yarn build`: node --test tests/wyrm-combat-form.test.cjs
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, test } = require("node:test");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { NpcDefinitionLoader } = require("../dist/game/definition/loader/impl/NpcDefinitionLoader");
const { NpcDefinition } = require("../dist/game/definition/NpcDefinition");
const { PluginManager } = require("../dist/plugins/PluginManager");
const core = PluginManager.getCoreApi();

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  new NpcDefinitionLoader().load();
});

test("idle wyrms name their attacking form; attacking forms name none", () => {
  for (const [idle, attacking] of [[8610, 8611], [10398, 10399], [12584, 12585]]) {
    assert.equal(NpcDefinition.forId(idle).getCombatForm(), attacking, `${idle} -> ${attacking}`);
    assert.equal(NpcDefinition.forId(attacking).getCombatForm(), -1, `${attacking} has no form`);
  }
  // An unrelated monster is untouched.
  assert.equal(NpcDefinition.forId(core.NpcIdentifiers.GOBLIN).getCombatForm(), -1);
});

test("a shadow wyrm swaps to the attacking form in combat and reverts afterwards", (t) => {
  t.mock.method(core.World, "markNpcCombatActive", () => {});
  const npc = core.NPC.create(10398, new core.Location(3234, 3213, 0));
  assert.equal(npc.getNpcTransformationId(), -1);
  assert.equal(npc.getCurrentDefinition().getAttackAnim(), 8270);
  assert.equal(npc.getCurrentDefinition().getDeathAnim(), 8272);

  // Entering combat: the attacking cache id, whose model the sequences are rigged for.
  npc.updateCombatForm(true);
  assert.equal(npc.getNpcTransformationId(), 10399);
  assert.equal(npc.getCurrentDefinition().getAttackAnim(), 8270);
  assert.equal(npc.getCurrentDefinition().getDeathAnim(), 8272);

  // The fight is over: back to the crawling idle form.
  npc.updateCombatForm(false);
  assert.equal(npc.getNpcTransformationId(), -1);
  assert.equal(npc.getId(), 10398);
});

test("the fight state drives the form when no explicit state is given", (t) => {
  t.mock.method(core.World, "markNpcCombatActive", () => {});
  const npc = core.NPC.create(8610, new core.Location(3234, 3213, 0));
  const combat = npc.getCombat();

  t.mock.method(combat, "getAttacker", () => ({ isPlayer: () => true }));
  npc.updateCombatForm();
  assert.equal(npc.getNpcTransformationId(), 8611);

  t.mock.method(combat, "getAttacker", () => null);
  t.mock.method(combat, "getTarget", () => null);
  npc.updateCombatForm();
  assert.equal(npc.getNpcTransformationId(), -1);
});

test("a monster without a combat form is never transformed", (t) => {
  t.mock.method(core.World, "markNpcCombatActive", () => {});
  const npc = core.NPC.create(core.NpcIdentifiers.GOBLIN, new core.Location(3234, 3213, 0));
  npc.updateCombatForm(true);
  assert.equal(npc.getNpcTransformationId(), -1);
});


test("a dying wyrm keeps the attacking form until it leaves the world", (t) => {
  t.mock.method(core.World, "markNpcCombatActive", () => {});
  const npc = core.NPC.create(10398, new core.Location(3234, 3213, 0));
  npc.updateCombatForm(true);
  assert.equal(npc.getNpcTransformationId(), 10399);

  // Once dying, process() stops reverting it under the death animation.
  npc.setDying(true);
  npc.updateCombatForm(false);
  assert.equal(npc.getNpcTransformationId(), 10399);

  // NPCDeathTask.remove resets it as the NPC leaves the world.
  npc.setDying(false);
  npc.setNpcTransformationId(-1);
  assert.equal(npc.getNpcTransformationId(), -1);
});

test("the attacking form keeps the idle form's combat numbers", () => {
  for (const [idle, form] of [[8610, 8611], [10398, 10399], [12584, 12585]]) {
    const crawling = NpcDefinition.forId(idle), attacking = NpcDefinition.forId(form);
    assert.equal(attacking.getHitpoints(), crawling.getHitpoints(), `${form} hitpoints`);
    assert.equal(attacking.getCombatLevel(), crawling.getCombatLevel(), `${form} level`);
    assert.equal(attacking.getSize(), crawling.getSize(), `${form} size`);
    assert.deepEqual(attacking.getStats(), crawling.getStats(), `${form} stats`);
    assert.equal(attacking.getMaxHit(), crawling.getMaxHit(), `${form} max hit`);
  }
});
