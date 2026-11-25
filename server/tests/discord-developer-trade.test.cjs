// node --test tests/discord-developer-trade.test.cjs
//
// Issue #206: Discord Developers (the in-game DEVELOPER rank the platform applies
// from the Developer role) trade on any world. The world-wide wealth-transfer
// block and the Ironman trade refusal must both let a Developer through, on
// either side of the trade, while ordinary accounts stay blocked.
const assert = require("node:assert/strict");
const { test } = require("node:test");

const RIGHTS = {
  NONE: { getId: () => 0 },
  DEVELOPER: { getId: () => 4 },
};

function player(name, rightsId = 0, ironmanMode = null) {
  const attributes = { "ironman:mode": ironmanMode };
  return {
    name,
    messages: [],
    getUsername: () => name,
    getDisplayName: () => name,
    getRights: () => ({ getId: () => rightsId }),
    getAttribute: (key) => attributes[key] ?? null,
    getAppearance: () => ({ getPronouns: () => 0 }),
    sendMessage(text) { this.messages.push(text); },
  };
}

function apiFor({ wealthEnabled }) {
  const hooks = { canTrade: [], tradeRequest: [] };
  const api = {
    core: { PlayerRights: RIGHTS, ItemIdentifiers: { COINS: 995, OLD_SCHOOL_BOND: 13190 }, ItemOnGroundManager: { registerLocation() {} } },
    getPluginConfig: (key, fallback) => (key === "WealthTransfer:enabled" ? wealthEnabled : fallback),
    persistAttribute() {},
    registerCommand() {},
    onCustomEvent() {},
    emitCustomEvent() {},
    onCanTrade: (handler) => hooks.canTrade.push(handler),
    onTradeRequest: (handler) => hooks.tradeRequest.push(handler),
    onGroundItemPickup() {},
    onPlayerDeathItemDrop() {},
  };
  return { api, hooks };
}

function loadWealth(wealthEnabled) {
  const { api, hooks } = apiFor({ wealthEnabled });
  require("../plugins/modes/wealthtransfer/Common.WealthTransfer").init(api);
  require("../plugins/modes/wealthtransfer/Trading.WealthTransfer")(api);
  return hooks;
}

function loadIronman() {
  const { api, hooks } = apiFor({ wealthEnabled: true });
  require("../plugins/modes/ironman/Common.Ironman").init(api);
  require("../plugins/modes/ironman/Trading.Ironman")(api);
  return hooks;
}

function trade(hooks, requester, target) {
  const request = { player: requester, target, handled: false };
  hooks.tradeRequest[0](request);
  const window = { player: requester, target, allow: null };
  hooks.canTrade[0](window);
  return { request, window };
}

test("wealth transfer off still refuses ordinary accounts", () => {
  const hooks = loadWealth(false);
  const requester = player("ordinary");
  const { request, window } = trade(hooks, requester, player("other"));
  assert.equal(request.handled, true);
  assert.equal(window.allow, false);
  assert.deepEqual(requester.messages, [
    "Wealth transfer is disabled on this world.",
    "Wealth transfer is disabled on this world.",
  ]);
});

test("a Discord Developer trades on a wealth-transfer-off world as requester or target", () => {
  const hooks = loadWealth(false);
  for (const [requester, target] of [
    [player("dev", 4), player("ordinary")],
    [player("ordinary"), player("dev", 4)],
  ]) {
    const { request, window } = trade(hooks, requester, target);
    assert.equal(request.handled, false, "the Developer's trade request is not consumed");
    assert.equal(window.allow, null, "the Developer's trade window is not refused");
    assert.deepEqual([...requester.messages, ...target.messages], []);
  }
});

test("Ironman trade refusal lifts for a Discord Developer on either side", () => {
  const hooks = loadIronman();
  const ordinaryIron = player("iron", 0, "ironman");
  const blocked = trade(hooks, player("ordinary"), ordinaryIron);
  assert.equal(blocked.request.handled, true, "an ordinary account still cannot trade an Ironman");
  assert.equal(blocked.window.allow, false);

  const groupIron = player("gim", 0, "group");
  const blockedGroup = trade(hooks, player("ordinary"), groupIron);
  assert.equal(blockedGroup.request.handled, true, "an ordinary account still cannot trade a Group Ironman");
  assert.equal(blockedGroup.window.allow, false);

  const devIron = player("dev", 4, "ironman");
  const asRequester = trade(hooks, devIron, player("ordinary"));
  assert.deepEqual([asRequester.request.handled, asRequester.window.allow], [false, null]);
  const asTarget = trade(hooks, player("ordinary"), devIron);
  assert.deepEqual([asTarget.request.handled, asTarget.window.allow], [false, null]);

  const devGroup = trade(hooks, player("dev", 4, "group"), player("ordinary"));
  assert.deepEqual([devGroup.request.handled, devGroup.window.allow], [false, null]);
});
