// node --test tests/kuradal-multinpc.test.cjs
// Duradel's world spawn (13654) is a multinpc: after While Guthix Sleeps it must resolve to
// Kuradal for that player, because only she hands out Duradel's notes (#145).
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");
const Fellowship = require("../plugins/quests/wgs/Fellowship.WhileGuthixSleeps");

const DURADEL_SPAWN = 13654;
const DURADEL = 13622;
const KURADAL = 13623;
const WGS_MASTER_VARBIT = 10782;

before(async () => {
  await h.setup([[2869, 2982]]);
});
after(() => h.teardown());

function spawn() {
  return h.core.NPC.create(DURADEL_SPAWN, new h.core.Location(2869, 2982, 1));
}

test("after While Guthix Sleeps the Shilo spawn resolves to Kuradal for that player", (t) => {
  const f = h.actor(t, { at: [2869, 2982, 1], done: [], questKey: "while_guthix_sleeps", stage: 900 });
  h.PM.emitPlayerLogin({ player: f.player, username: f.player.getUsername() });
  assert.equal(f.player.getPacketSender().getVarbit(WGS_MASTER_VARBIT), 2);
  const npc = spawn();
  assert.equal(npc.getContentId(f.player), KURADAL);
  assert.equal(npc.getCurrentDefinition(f.player).getName(), "Kuradal");
  assert.equal(npc.getCurrentDefinition(f.player).getActions()[0], "Talk-to");
});

test("before the quest the same spawn stays Duradel", (t) => {
  const f = h.actor(t, { at: [2869, 2982, 1], done: [], questKey: "while_guthix_sleeps", stage: 100 });
  // Quests-off worlds auto-complete at login, so check the pre-quest transform through the
  // shared visibility sync rather than by running the login hooks.
  Fellowship.syncVisibility(f.player.getPacketSender(), 100);
  assert.equal(f.player.getPacketSender().getVarbit(WGS_MASTER_VARBIT), 0);
  assert.equal(spawn().getContentId(f.player), DURADEL);
});
