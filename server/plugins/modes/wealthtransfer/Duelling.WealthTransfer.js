/**
 * No staking when wealth transfer is off. Free duels stay allowed.
 */
const Common = require("./Common.WealthTransfer");

function canStake(request) {
  if (Common.enabled()) return;
  request.allow = false;
  request.message = Common.message("duelStake");
}

module.exports = function attach(api) {
  api.onCustomEvent("duelarena:can-stake", canStake);
};
