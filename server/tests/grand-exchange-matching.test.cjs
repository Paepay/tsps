// node --test tests/grand-exchange-matching.test.cjs
// Player-to-player Grand Exchange order book matching.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("os");
const path = require("path");
const { test, beforeEach, afterEach } = require("node:test");

const Matching = require("../plugins/interface/grandexchange/Matching.GrandExchange");

const bookFile = path.join(os.tmpdir(), `ge-book-${process.pid}-${Date.now()}.json`);
const pluginConfig = {};
const players = new Map();
const saves = [];

function account(name) {
  const slots = {};
  const messages = [];
  const player = {
    getUsername: () => name,
    getPacketSender: () => ({
      sendMessage: (text) => messages.push(text),
      sendInterfaceScript: () => player.getPacketSender(),
      sendVarbit: () => player.getPacketSender(),
    }),
    sendMessage: (text) => messages.push(text),
    messages,
    slots,
  };
  players.set(name.toLowerCase(), player);
  return player;
}

beforeEach(() => {
  for (const key of Object.keys(pluginConfig)) delete pluginConfig[key];
  pluginConfig[Matching.SIMULATED_DATA_CONFIG] = false;
  players.clear();
  saves.length = 0;
  try { fs.unlinkSync(bookFile); } catch { /* missing is fine */ }
  Matching.configure({
    api: {
      getPluginConfig: (key, fallback) => (Object.prototype.hasOwnProperty.call(pluginConfig, key)
        ? pluginConfig[key]
        : fallback),
      core: {
        World: {
          getPlayerByName: (name) => players.get(String(name).toLowerCase()),
          getPlayers: () => players.values(),
        },
        GameConstants: { WORLD_PROFILE: "main" },
      },
    },
    file: bookFile,
    completedOffers: (player) => player.slots,
    saveOffers: (player) => saves.push(player.getUsername()),
    recordHistory: () => true,
    unNote: (id) => id,
    itemName: (id) => `Item ${id}`,
    refreshOffer: () => {},
  });
});

afterEach(() => {
  try { fs.unlinkSync(bookFile); } catch { /* ignore */ }
});

function openOffer(player, { slot = 0, itemId = 4151, sell, price, quantity }) {
  const offer = {
    slot, itemId, sell, price, quantity,
    total: sell ? quantity * price : quantity * price,
    finished: false, placedAt: Date.now(),
  };
  player.slots[slot] = offer;
  assert.equal(Matching.place(player, offer), true);
  return player.slots[slot];
}

test("simulated data toggle selects player or simulated matching", () => {
  pluginConfig[Matching.SIMULATED_DATA_CONFIG] = true;
  assert.equal(Matching.isPlayerMatching(), false);
  assert.equal(Matching.simulatedDataEnabled(), true);
  pluginConfig[Matching.SIMULATED_DATA_CONFIG] = false;
  assert.equal(Matching.isPlayerMatching(), true);
  delete pluginConfig[Matching.SIMULATED_DATA_CONFIG];
  pluginConfig[Matching.MATCHING_CONFIG] = Matching.MATCHING_PLAYER;
  assert.equal(Matching.isPlayerMatching(), true, "legacy matching=player still works");
  pluginConfig[Matching.MATCHING_CONFIG] = Matching.MATCHING_SIMULATED;
  assert.equal(Matching.isPlayerMatching(), false);
});

test("a buy lifts the lowest resting ask at the ask price", () => {
  const seller = account("seller");
  const buyer = account("buyer");
  openOffer(seller, { sell: true, price: 100, quantity: 5 });
  openOffer(seller, { slot: 1, sell: true, price: 90, quantity: 5 });
  const buy = openOffer(buyer, { sell: false, price: 100, quantity: 5 });
  assert.equal(buy.finished, true);
  assert.equal(buy.filled, 5);
  assert.equal(buy.traded, 5 * 90, "matched the cheaper ask");
  assert.equal(seller.slots[1].finished, true);
  assert.equal(seller.slots[1].traded, 5 * 90);
  assert.equal(seller.slots[0].finished, false, "higher ask untouched");
  assert.equal(Matching.bookOffers().length, 1);
});

test("a sell hits the highest resting bid at the bid price", () => {
  const buyer = account("buyer");
  const seller = account("seller");
  openOffer(buyer, { sell: false, price: 80, quantity: 3 });
  openOffer(buyer, { slot: 1, sell: false, price: 100, quantity: 3 });
  const sell = openOffer(seller, { sell: true, price: 90, quantity: 3 });
  assert.equal(sell.finished, true);
  assert.equal(sell.traded, 3 * 100, "matched the higher bid");
  assert.equal(buyer.slots[1].finished, true);
  assert.equal(buyer.slots[0].finished, false);
});

test("partial fills leave both offers open with progress", () => {
  const seller = account("seller");
  const buyer = account("buyer");
  openOffer(seller, { sell: true, price: 50, quantity: 10 });
  const buy = openOffer(buyer, { sell: false, price: 50, quantity: 4 });
  assert.equal(buy.finished, true);
  assert.equal(buy.filled, 4);
  assert.equal(seller.slots[0].finished, false);
  assert.equal(seller.slots[0].filled, 4);
  assert.equal(seller.slots[0].remaining, 6);
  assert.equal(Matching.findBookOffer("seller", 0).remaining, 6);
});

test("prices that do not cross leave both offers resting", () => {
  const seller = account("seller");
  const buyer = account("buyer");
  openOffer(seller, { sell: true, price: 200, quantity: 1 });
  const buy = openOffer(buyer, { sell: false, price: 100, quantity: 1 });
  assert.equal(buy.finished, false);
  assert.equal(buy.filled, 0);
  assert.equal(Matching.bookOffers().length, 2);
});

test("abort removes the offer from the book and keeps partial progress", () => {
  const seller = account("seller");
  const buyer = account("buyer");
  openOffer(seller, { sell: true, price: 10, quantity: 10 });
  openOffer(buyer, { sell: false, price: 10, quantity: 3 });
  const offer = seller.slots[0];
  Matching.abort(seller, offer);
  assert.equal(offer.filled, 3);
  assert.equal(offer.remaining, 7);
  assert.equal(Matching.findBookOffer("seller", 0), null);
});

test("login sync applies a fill that completed while the owner was offline", () => {
  const seller = account("seller");
  openOffer(seller, { sell: true, price: 25, quantity: 2 });
  players.delete("seller");
  const buyer = account("buyer");
  openOffer(buyer, { sell: false, price: 25, quantity: 2 });
  assert.equal(Matching.findBookOffer("seller", 0), null);
  assert.equal(Matching.settledOffers().length, 1, "offline finish waits in settled");
  const sellerBack = account("seller");
  sellerBack.slots[0] = {
    slot: 0, itemId: 4151, sell: true, price: 25, quantity: 2, total: 50,
    finished: false, filled: 0, remaining: 2, traded: 0,
    matching: Matching.MATCHING_PLAYER, placedAt: Date.now(),
  };
  Matching.syncPlayer(sellerBack);
  assert.equal(sellerBack.slots[0].finished, true);
  assert.equal(sellerBack.slots[0].filled, 2);
  assert.equal(sellerBack.slots[0].traded, 50);
  assert.equal(Matching.settledOffers().length, 0);
});

test("login sync applies partial progress still resting in the book", () => {
  Matching.setBookOffersForTest([{
    id: "1", account: "seller", slot: 0, itemId: 4151, sell: true, price: 25,
    quantity: 5, remaining: 2, filled: 3, traded: 75, total: 125, placedAt: 1,
  }]);
  const seller = account("seller");
  seller.slots[0] = {
    slot: 0, itemId: 4151, sell: true, price: 25, quantity: 5, total: 125,
    finished: false, filled: 0, remaining: 5, traded: 0,
    matching: Matching.MATCHING_PLAYER, placedAt: 1,
  };
  Matching.syncPlayer(seller);
  assert.deepEqual(
    [seller.slots[0].filled, seller.slots[0].remaining, seller.slots[0].traded],
    [3, 2, 75],
  );
});
