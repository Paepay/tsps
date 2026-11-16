/**
 * Shops whose stock never changes (leagues.json `shopStock`): a league character's purchase leaves
 * the shop's own stock as it was, and what they sell to a shop is paid for but never added to it.
 * It answers the shop's `shop:keep-stock` both ways (`selling` on a sale), so only stock a main
 * character sold it goes when bought (ShopManager.takeStock); a main character, or a league without
 * `shopStock.keep`, buys and sells as on any world.
 *
 * Enabled for Trailblazer Reloaded (Wiki: stocks never decrease / restock after every transaction),
 * Raging Echoes and Demonic Pacts (Leagues VI news: most shop stock will not deplete; captures
 * 237/01098+, sales leave stock unchanged). Level-Up reuses Trailblazer Reloaded's catalog and the
 * same keep via `level-up:relic-profile` (not a league save). Buy quantity still follows the shown
 * stock (1 left → one a click; 250 → Buy-50), so Fire Sale can buy forever at that cap.
 */
const Common = require("./Common.LeagueMode");

let api = null;

/** League type for a keep-stock world: a league save, or Level-Up's relic catalog type. */
function keepType(player) {
  const type = Common.leagueOf(player);
  if (type !== null) return type;
  if (!player || !api) return null;
  const query = { player, league: null, active: false };
  api.emitCustomEvent("level-up:relic-profile", query);
  const typeFromLevelUp = Number(query.league);
  return query.active === true && Common.league(typeFromLevelUp) ? typeFromLevelUp : null;
}

function keepStock(request) {
  if (request.keep) return;
  const type = keepType(request.player);
  if (type !== null && Common.league(type)?.shopStock?.keep === true) request.keep = true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  api.onCustomEvent("shop:keep-stock", keepStock);
};
