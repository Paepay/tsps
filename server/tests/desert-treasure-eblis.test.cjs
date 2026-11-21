const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const h = require("./quest-capture-harness.cjs");

const EBLIS_AT = [3230, 9316, 0];
const BY_EBLIS = [3230, 9317, 0];

let I;
let N;
before(async () => {
  await h.setup([[3230, 9317], [3230, 9316]]);
  I = h.core.ItemIdentifiers;
  N = h.core.NpcIdentifiers;
});
after(() => h.teardown());

async function until(f, text, limit = 120) {
  for (let i = 0; i < limit; i++) {
    const line = h.shown(f);
    if (line?.text?.startsWith(text) || (line?.who === "menu" && line.text.includes(text))) return f.tick;
    if (line && line.who !== "menu") await h.continueLine(f);
    else h.tick(f);
  }
  assert.fail(`"${text}" never showed; said: ${JSON.stringify(f.said.slice(-8))}`);
}

async function talkToEblis(t, coins) {
  const f = h.actor(t, { stage: 15, at: BY_EBLIS, questKey: "desert_treasure_i", done: [] });
  if (coins > 0) f.player.getInventory().add(new h.core.Item(I.COINS, coins), false);
  const eblis = h.spawn(f, N.EBLIS, EBLIS_AT);
  await h.talk(f, eblis);
  await until(f, "Yes please");
  return f;
}

test("Eblis sells an ancient staff for 80,000 coins after Desert Treasure I (#50)", async (t) => {
  const f = await talkToEblis(t, 80000);
  await h.choose(f, "Yes please");
  for (let i = 0; i < 20; i++) {
    const line = h.shown(f);
    if (f.player.getInventory().getAmount(I.ANCIENT_STAFF) === 1) break;
    if (!line) h.tick(f); else await h.continueLine(f);
  }
  assert.equal(f.player.getInventory().getAmount(I.ANCIENT_STAFF), 1, "an ancient staff");
  assert.equal(f.player.getInventory().getAmount(I.COINS), 0, "the 80,000 coins are taken");
});

test("Eblis refuses the ancient staff purchase with too few coins (#50)", async (t) => {
  const f = await talkToEblis(t, 79999);
  await h.choose(f, "Yes please");
  await until(f, "Stranger... Do not abuse my generosity...");
  for (let i = 0; i < 20; i++) {
    const line = h.shown(f);
    if (!line) break;
    if (line.who !== "menu") await h.continueLine(f); else break;
  }
  assert.equal(f.player.getInventory().getAmount(I.ANCIENT_STAFF), 0, "no staff");
  assert.equal(f.player.getInventory().getAmount(I.COINS), 79999, "no coins taken");
});
