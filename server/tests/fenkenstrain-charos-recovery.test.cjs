// Run after `yarn build`: node --test tests/fenkenstrain-charos-recovery.test.cjs
// Wiki (Ring of Charos): a lost ring can be recovered by pickpocketing Dr Fenkenstrain,
// and once activated it is always recovered activated. Wiki (Dr Fenkenstrain transcript):
// "You steal the Ring of Charos from Fenkenstrain." / "What do you think you're doing?"
const assert = require("node:assert/strict");
const path = require("node:path");
const { before, after, test } = require("node:test");
process.env.DISABLE_PLAYER_BOTS = "1";
require("../dist/Server").Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager: PM } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { PlayerSession } = require("../dist/net/PlayerSession");
const { questNamed } = require("../plugins/quests/QuestRuntime");

const FENKENSTRAIN = 1269;
const RING = 4202;
const RING_A = 6465;
const ACTIVATED = "garden-of-tranquillity:charos-activated";
let core, next = 9570;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  PM.loadFromDirectory(path.resolve(__dirname, "../plugins"));
  core = PM.getCoreApi();
  PM.emitServerStartup({});
});
after(() => PM.emitServerShutdown({}));

function player(t) {
  const channel = { kind: "test", remoteAddress: "127.0.0.1", isOpen: () => true, send: () => true, close() {}, onData() {}, onError() {}, onClose() {} };
  const p = new Player(new PlayerSession(channel));
  p.setIndex(next++);
  p.setUsername("charos-recovery" + next);
  p.setRegistered(true);
  p.setAttribute("bot-skip-persistence", true);
  t.after(() => p.setRegistered(false));
  assert.equal(questNamed("Creature of Fenkenstrain").complete(p), true);
  for (const id of [RING, RING_A]) p.getInventory().deleteNumber(id, p.getInventory().getAmount(id));
  return p;
}

function pickpocket(p) {
  return PM.emitNpcInteraction({
    player: p,
    npc: {},
    npcId: FENKENSTRAIN,
    definition: { getName: () => "Dr Fenkenstrain", getActions: () => ["Talk-to", "Pickpocket"] },
    clickType: 2,
    handled: false,
  });
}

test("post-quest pickpocketing recovers the Ring of Charos", (t) => {
  const p = player(t);
  assert.equal(pickpocket(p), true);
  assert.equal(p.getInventory().getAmount(RING), 1);
  assert.equal(p.getInventory().getAmount(RING_A), 0);
});

test("recovery gives the activated ring after activation", (t) => {
  const p = player(t);
  p.setAttribute(ACTIVATED, 1);
  assert.equal(pickpocket(p), true);
  assert.equal(p.getInventory().getAmount(RING_A), 1);
  assert.equal(p.getInventory().getAmount(RING), 0);
});

test("an activated Garden save also recovers the activated ring", (t) => {
  const p = player(t);
  questNamed("Garden of Tranquillity").setStage(p, 40);
  assert.equal(pickpocket(p), true);
  assert.equal(p.getInventory().getAmount(RING_A), 1);
});

test("an existing ring in the bank or equipment is not duplicated", (t) => {
  const banked = player(t);
  banked.getBank(0).add(new core.Item(RING, 1), false);
  assert.equal(pickpocket(banked), true);
  assert.equal(banked.getInventory().getAmount(RING), 0);
  assert.equal(banked.getBank(0).getAmount(RING), 1);

  const worn = player(t);
  worn.getEquipment().setItem(core.Equipment.RING_SLOT, new core.Item(RING_A, 1));
  assert.equal(pickpocket(worn), true);
  assert.equal(worn.getInventory().getAmount(RING_A), 0);
  assert.equal(worn.getEquipment().get(core.Equipment.RING_SLOT).getId(), RING_A);
});
