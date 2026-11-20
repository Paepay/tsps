const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const MALIGNIUS = [2991, 3269, 0];
const BY_MALIGNIUS = [2991, 3268, 0];

let I;
let N;
before(async () => {
  await h.setup([[2991, 3269], [2991, 3268]]);
  I = h.core.ItemIdentifiers;
  N = h.core.NpcIdentifiers;
});
after(() => h.teardown());

async function until(f, text, limit = 80) {
  for (let i = 0; i < limit; i++) {
    const line = h.shown(f);
    if (line?.text?.startsWith(text) || (line?.who === "menu" && line.text.includes(text))) return f.tick;
    if (line && line.who !== "menu") await h.continueLine(f);
    else h.tick(f);
  }
  assert.fail(`"${text}" never showed; said: ${JSON.stringify(f.said.slice(-6))}`);
}

test("Malignius sells a replacement pair for 40,000 coins after the quest (#56)", async (t) => {
  const f = h.actor(t, { stage: 90, at: BY_MALIGNIUS });
  f.player.getInventory().add(new h.core.Item(I.COINS, 40000), false);
  const malignius = h.spawn(f, N.MALIGNIUS_MORTIFER, MALIGNIUS);
  await h.talk(f, malignius);
  await h.choose(f, "About those enchanted secateurs again...");
  await until(f, "Can I get another set of enchanted secateurs?");
  await h.choose(f, "Can I get another set of enchanted secateurs?");
  await until(f, "Ok, great.");
  await h.choose(f, "Ok, great.");
  await h.continueLine(f);
  assert.equal(f.player.getInventory().getAmount(I.MAGIC_SECATEURS), 1, "a pair of magic secateurs");
  assert.equal(f.player.getInventory().getAmount(I.COINS), 0, "the 40,000 coins are taken");
});
