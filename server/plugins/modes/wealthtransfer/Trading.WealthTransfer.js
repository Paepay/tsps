/**
 * No trading with players when wealth transfer is off. Same hooks as Ironman trading, without
 * the Ironman account wording or symbol.
 */
const Common = require("./Common.WealthTransfer");

/** A Discord Developer trades on any world, either as the requester or the target. */
function exempt(event) {
  return Common.isDeveloper(event.player) || Common.isDeveloper(event.target);
}

function canTrade(event) {
  if (Common.enabled() || exempt(event)) return;
  event.allow = false;
  event.player.sendMessage(Common.message("trade"));
}

function tradeRequest(event) {
  if (Common.enabled() || exempt(event)) return;
  event.handled = true;
  event.player.sendMessage(Common.message("trade"));
}

module.exports = function attach(api) {
  api.onCanTrade(canTrade);
  api.onTradeRequest(tradeRequest);
};
