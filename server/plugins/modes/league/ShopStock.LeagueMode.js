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

/** The Slayer Equipment shop's elemental shields on league and Level-Up worlds (issue #69). */
const EQUIPMENT_SHOP = "Slayer Equipment (shop)";
const SHIELDS = [
  { id: 2890, amount: 50, restockTicks: 100 },
  { id: 9731, amount: 50, restockTicks: 100 },
];

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

/** A league world, including the Level-Up template that reuses the league catalog. */
function leagueWorld() {
  if (Common.worldLeague() !== null) return true;
  return /^level[-_]up$/i.test(String(api?.getPluginConfig?.("template:id", "") ?? ""));
}

/**
 * Adds the elemental shields to the Slayer Equipment shop's own stock. The shops.json row is
 * generated, so the definition is cloned at runtime instead of edited there. Running twice is
 * harmless: a shield already in the stock is left alone.
 */
function addShieldsToShop() {
  if (!api || !leagueWorld()) return false;
  const { ShopDefinition, ShopManager } = api.core;
  const shop = ShopDefinition.all().find((entry) => entry.getName() === EQUIPMENT_SHOP);
  if (!shop) return false;
  const stocked = new Set(shop.getOriginalStock().map((row) => row.id));
  const extra = SHIELDS.filter((row) => !stocked.has(row.id));
  if (extra.length === 0) return false;
  const definition = new ShopDefinition(
    shop.getId(),
    shop.getName(),
    shop.getCurrency(),
    [...shop.getOriginalStock(), ...extra],
    shop.getDefaultRestockTicks(),
    shop.getDefaultDestockTicks(),
    shop.getSoldItemDestockTicks(),
    shop.getSource(),
    shop.getSalesPolicy()
  );
  ShopManager.registerShop(definition);
  return true;
}

module.exports = function attach(pluginApi) {
  api = pluginApi;
  api.onCustomEvent("shop:keep-stock", keepStock);
  api.onServerStartup?.(addShieldsToShop);
  api.onCustomEvent("paescape:world-config", () => {
    if (typeof queueMicrotask === "function") queueMicrotask(addShieldsToShop);
    else addShieldsToShop();
  });
};

module.exports.addShieldsToShop = addShieldsToShop;
module.exports.leagueWorld = leagueWorld;
module.exports.EQUIPMENT_SHOP = EQUIPMENT_SHOP;
module.exports.SHIELDS = SHIELDS;
