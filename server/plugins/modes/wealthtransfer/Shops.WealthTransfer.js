/**
 * Shops sell only their own stock when wealth transfer is off — never what players sold in
 * (same as Ironman shop stock).
 */
const Common = require("./Common.WealthTransfer");

function buyLimit(request) {
  if (Common.enabled()) return;
  const own = Math.min(request.available, request.original);
  if (own < request.limit) {
    request.limit = own;
    request.message = Common.message("shopStock");
  }
}

module.exports = function attach(api) {
  api.onCustomEvent("shop:buy-limit", buyLimit);
};
