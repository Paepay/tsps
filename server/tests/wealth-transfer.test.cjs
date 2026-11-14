// node --test tests/wealth-transfer.test.cjs
// World Wealth Transfer setting (default on): when off, Ironman-style isolation without the symbol.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const hooks = {};
const custom = {};
let wealthEnabled = true;

const api = {
  core: {
    ItemIdentifiers: { COINS: 995, OLD_SCHOOL_BOND: 13190 },
    ItemOnGroundManager: { registerLocation() {} },
  },
  persistAttribute() {},
  getPluginConfig: (key, fallback) => (key === "WealthTransfer:enabled" ? wealthEnabled : fallback),
  registerCommand() {},
  onCustomEvent: (name, handler) => { custom[name] = handler; },
  emitCustomEvent: (name, payload) => { custom[name]?.(payload); },
  onCanTrade: (handler) => { hooks.onCanTrade = handler; },
  onTradeRequest: (handler) => { hooks.onTradeRequest = handler; },
  onGroundItemPickup: (handler) => { hooks.onGroundItemPickup = handler; },
  onPlayerDeathItemDrop: (handler) => { hooks.onPlayerDeathItemDrop = handler; },
};

require("../plugins/modes/WealthTransfer.plugin").register(api);

function account(name) {
  const messages = [];
  return {
    getUsername: () => name,
    getDisplayName: () => name,
    getAttribute: () => null,
    sendMessage: (text) => messages.push(text),
    messages,
  };
}

function withWealthOff(run) {
  const previous = wealthEnabled;
  wealthEnabled = false;
  try {
    return run();
  } finally {
    wealthEnabled = previous;
  }
}

test("wealth transfer is on by default: trades and GE stay open", () => {
  wealthEnabled = true;
  const player = account("trader");
  const trade = { player, target: account("other"), handled: false, allow: null };
  hooks.onTradeRequest(trade);
  assert.equal(trade.handled, false);
  const open = { player, allow: true, message: null };
  custom["grand-exchange:can-open"](open);
  assert.equal(open.allow, true);
  const offer = { player, itemId: 995, sell: false, quantity: 1, accepted: true };
  custom["ge:offer-confirmed"](offer);
  assert.equal(offer.accepted, true);
});

test("wealth transfer off blocks trades", () => {
  withWealthOff(() => {
    const player = account("trader");
    const request = { player, target: account("other"), handled: false };
    hooks.onTradeRequest(request);
    assert.deepEqual([request.handled, player.messages], [true, ["Wealth transfer is disabled on this world."]]);
    player.messages.length = 0;
    const window = { player, target: account("other"), allow: null };
    hooks.onCanTrade(window);
    assert.deepEqual([window.allow, player.messages], [false, ["Wealth transfer is disabled on this world."]]);
  });
});

test("wealth transfer off blocks all Grand Exchange use, including bonds", () => {
  withWealthOff(() => {
    const player = account("ge");
    const open = { player, allow: true, message: null };
    custom["grand-exchange:can-open"](open);
    assert.deepEqual([open.allow, open.message],
      [false, "The Grand Exchange is unavailable: wealth transfer is disabled on this world."]);
    for (const [itemId, sell, quantity] of [
      [13190, false, 1],
      [995, false, 1],
      [995, true, 1],
    ]) {
      player.messages.length = 0;
      const request = { player, itemId, sell, quantity, accepted: true };
      custom["ge:offer-confirmed"](request);
      assert.equal(request.accepted, false);
      assert.deepEqual(player.messages,
        ["The Grand Exchange is unavailable: wealth transfer is disabled on this world."]);
    }
  });
});

test("wealth transfer off blocks stakes and shop player-stock", () => {
  withWealthOff(() => {
    const player = account("staker");
    const stake = { player, allow: true, message: null };
    custom["duelarena:can-stake"](stake);
    assert.deepEqual([stake.allow, stake.message],
      [false, "You can't stake items: wealth transfer is disabled on this world."]);
    const shop = { player, available: 4, original: 0, limit: 4, message: null };
    custom["shop:buy-limit"](shop);
    assert.deepEqual([shop.limit, shop.message],
      [0, "You can only buy the shop's own stock: wealth transfer is disabled on this world."]);
  });
});

test("wealth transfer off answers wealth:can-transfer for party room, bonds and shared storage", () => {
  withWealthOff(() => {
    const player = account("raider");
    for (const reason of ["partyRoom", "bond", "sharedStorage"]) {
      const request = { player, allow: true, message: null, reason };
      custom["wealth:can-transfer"](request);
      assert.equal(request.allow, false, reason);
      assert.ok(request.message, reason);
    }
  });
});

test("wealth transfer off makes PvP loot the victim's", () => {
  withWealthOff(() => {
    const victim = account("victim");
    const killer = account("killer");
    const ownership = { player: victim, killer, owner: null };
    custom["player-death:loot-owner"](ownership);
    assert.equal(ownership.owner, victim);
  });
});

test("does not set an Ironman mode", () => {
  withWealthOff(() => {
    const player = account("normal");
    assert.equal(player.getAttribute("ironman:mode"), null);
    hooks.onTradeRequest({ player, target: account("other"), handled: false });
    assert.equal(player.getAttribute("ironman:mode"), null);
  });
});
