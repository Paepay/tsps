/**
 * Shared by the Wealth Transfer units: whether the world allows player-to-player item movement.
 * On by default. When off, every account is isolated like Ironman for wealth channels, without
 * the Ironman symbol or account type.
 */
const ENABLED_CONFIG = "WealthTransfer:enabled";

const MESSAGES = {
  trade: "Wealth transfer is disabled on this world.",
  pickup: "You can't take items that other players have dropped: wealth transfer is disabled on this world.",
  duelStake: "You can't stake items: wealth transfer is disabled on this world.",
  shopStock: "You can only buy the shop's own stock: wealth transfer is disabled on this world.",
  grandExchange: "The Grand Exchange is unavailable: wealth transfer is disabled on this world.",
  partyRoom: "Wealth transfer is disabled on this world.",
  sharedStorage: "You can't use shared storage: wealth transfer is disabled on this world.",
  bond: "You can't give bonds: wealth transfer is disabled on this world.",
};

let api = null;

function init(pluginApi) {
  api = pluginApi;
}

/** Whether players may receive items another player owned. Default on. */
function enabled() {
  return api.getPluginConfig(ENABLED_CONFIG, true) !== false;
}

function message(key) {
  return MESSAGES[key] ?? MESSAGES.trade;
}

/**
 * Content that moves items between players asks here first
 * (`wealth:can-transfer` { player, allow, message, reason }).
 * `reason` picks the refusal line: trade, pickup, duelStake, shopStock, grandExchange,
 * partyRoom, sharedStorage, bond.
 */
function gateTransfer(request) {
  if (enabled()) return;
  request.allow = false;
  request.message = message(request.reason ?? "trade");
}

module.exports = {
  ENABLED_CONFIG,
  MESSAGES,
  init,
  enabled,
  message,
  gateTransfer,
  get api() { return api; },
};
