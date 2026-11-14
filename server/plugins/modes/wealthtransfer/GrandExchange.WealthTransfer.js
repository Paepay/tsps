/**
 * No Grand Exchange when wealth transfer is off: the interface stays closed and every offer is
 * refused (stricter than Ironman's bond-only rule — no GE functions at all).
 */
const Common = require("./Common.WealthTransfer");

function canOpen(request) {
  if (Common.enabled()) return;
  request.allow = false;
  request.message = Common.message("grandExchange");
}

function offerConfirmed(request) {
  if (Common.enabled()) return;
  request.accepted = false;
  request.player.sendMessage(Common.message("grandExchange"));
}

module.exports = function attach(api) {
  api.onCustomEvent("grand-exchange:can-open", canOpen);
  api.onCustomEvent("ge:offer-confirmed", offerConfirmed);
};
