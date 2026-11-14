/**
 * No trading with players when wealth transfer is off. Same hooks as Ironman trading, without
 * the Ironman account wording or symbol.
 */
const Common = require("./Common.WealthTransfer");

function canTrade(event) {
  if (Common.enabled()) return;
  event.allow = false;
  event.player.sendMessage(Common.message("trade"));
}

function tradeRequest(event) {
  if (Common.enabled()) return;
  event.handled = true;
  event.player.sendMessage(Common.message("trade"));
}

module.exports = function attach(api) {
  api.onCanTrade(canTrade);
  api.onTradeRequest(tradeRequest);
};
