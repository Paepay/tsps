/**
 * World-level wealth transfer. On by default. When off, players cannot receive items another
 * player owned: no trades, drop trades, PvP loot, party-chest donations, shared raid storage,
 * bond hand-offs, shop player-stock, or Grand Exchange — Ironman-style isolation without the
 * Ironman symbol or account type.
 */
const Common = require("./wealthtransfer/Common.WealthTransfer");

module.exports = {
  name: "WealthTransfer",
  description: "World setting for player-to-player item movement. Keep this plugin on; use its Wealth transfer option to allow or block trades, drops, PvP loot, shared storage and the Grand Exchange without making accounts Ironmen.",
  config: {
    [Common.ENABLED_CONFIG]: {
      type: "boolean",
      label: "Wealth transfer",
      default: true,
      help: "When off, players cannot gain items another player owned: no trades, drop trades, PvP loot, party room donations, shared raid storage, bond gifts, shop player-stock or Grand Exchange. Does not make accounts Ironmen or show the Ironman symbol.",
    },
  },
  register(api) {
    Common.init(api);
    api.onCustomEvent("wealth:can-transfer", Common.gateTransfer);
    require("./wealthtransfer/Trading.WealthTransfer")(api);
    require("./wealthtransfer/Loot.WealthTransfer")(api);
    require("./wealthtransfer/Shops.WealthTransfer")(api);
    require("./wealthtransfer/Duelling.WealthTransfer")(api);
    require("./wealthtransfer/GrandExchange.WealthTransfer")(api);
  },
};
