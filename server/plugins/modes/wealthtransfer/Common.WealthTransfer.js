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
  if (api.getPluginConfig(ENABLED_CONFIG, true) === false) return false;
  // A template (the Level-Up world) can veto every wealth channel on the live world, so a
  // hosted world that received its contract after startup does not keep an open trade window.
  const request = { enabled: true };
  api.emitCustomEvent("wealth:enabled", request);
  return request.enabled !== false;
}

function message(key) {
  return MESSAGES[key] ?? MESSAGES.trade;
}

/**
 * A Discord Developer (the in-game DEVELOPER rank the platform applies from the
 * Developer role) trades on any world, including one with wealth transfer off.
 * The exemption is checked on both parties so a developer can also receive a
 * trade from an ordinary account.
 */
function isDeveloper(player) {
  const rights = player?.getRights?.();
  const developer = api?.core?.PlayerRights?.DEVELOPER;
  return rights != null && developer != null && rights.getId?.() === developer.getId?.();
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
  isDeveloper,
  gateTransfer,
  get api() { return api; },
};
