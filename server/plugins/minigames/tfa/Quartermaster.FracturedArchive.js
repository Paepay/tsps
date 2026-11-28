"use strict";

/**
 * The Quartermaster (16761) in the hub after the second boss: "Resupply" opens Alliance
 * Supplies, the cache's omnishop row tfa_midraid_supplies_shop. Its stock costs Supply Credits
 * (omnishop_currency_tfa_supply_points, no item), kept in tfa_supply_points (16381, 7 bits).
 *
 * From the cache: the stock and prices (Saradomin brew(4) and Super restore(4) 3, Prayer
 * potion(4), Manta ray, Halibut, Ranging potion(2) and Super combat potion(2) 2, Giant krill
 * and Prayer potion(2) 1, the Alliance log free) and the buy amounts 1/2/3/5. The
 * tfa_midraid_supplies_shop_failure row adds Leftovers.
 * Estimates (a spectator has no credits and sees no shop): credits earned per completed
 * challenge, the failure row opening once anyone in the party has died, and the dialogue.
 *
 * Stock: the shop scripts draw "N in stock" from the omnishop shop inventory (1030) with
 * inv_total, not from any DB column, so the server has to send that inventory. The starting
 * counts are the Wiki's (and Leftovers, whose stock the Wiki leaves unknown, is free and ample).
 * One raid shares one stock: a party member's purchase lowers it for everyone, and the shop
 * refuses a row at zero.
 */

const Shared = require("./Shared.FracturedArchive");
const Raid = require("./RaidState.FracturedArchive");

const SHOP = "tfa_midraid_supplies_shop";
const SHOP_FAILURE = "tfa_midraid_supplies_shop_failure";
const CURRENCY = "omnishop_currency_tfa_supply_points";
const ATTR_CREDITS = "fractured-archive:supply-credits";
const CREDITS_PER_CHALLENGE = 10;
const MAX_CREDITS = 127;

/** The Wiki's Number in stock column, by object id. */
const INITIAL_STOCK = {
  6685: 6, // Saradomin brew(4)
  3024: 4, // Super restore(4)
  2434: 4, // Prayer potion(4)
  391: 10, // Manta ray
  32336: 5, // Halibut
  32312: 10, // Giant krill
  141: 1, // Prayer potion(2)
  171: 1, // Ranging potion(2)
  12699: 1, // Super combat potion(2)
  34729: 1, // Alliance log (view-only, shows "Currently unavailable")
  34730: 100, // Leftovers (Wiki: unknown)
};
const OUT_OF_STOCK = "There is none of that item left in stock.";

/** The raid's shared stock, item id -> count. A raid keeps it until it ends. */
function stockOf(raid) {
  if (!(raid.supplies instanceof Map)) raid.supplies = new Map();
  return raid.supplies;
}

function initialStock(itemId) {
  return INITIAL_STOCK[itemId] ?? 0;
}

const shopRows = new Map();

/** A shop's stock rows in the cache's order, with each row's object id and inventory id. */
function shopStock(shopName) {
  if (shopRows.has(shopName)) return shopRows.get(shopName);
  const definitions = Shared.core().CacheDefinitions;
  const rowId = definitions.getDbRowId(shopName);
  const row = definitions.getDbRow(rowId);
  if (!row) return null;
  const stockColumn = definitions.getDbColumn(row.tableId, "omnishop_shop_stock");
  const inventoryColumn = definitions.getDbColumn(row.tableId, "omnishop_shop_inv");
  const stock = row.column(stockColumn).map(Number).map((stockRowId) => {
    const stockRow = definitions.getDbRow(stockRowId);
    const objectColumn = definitions.getDbColumn(stockRow.tableId, "omnishop_stock_obj");
    return { row: stockRowId, itemId: Number(stockRow.column(objectColumn)[0]) };
  });
  const result = { rowId, inventoryId: Number(row.column(inventoryColumn)[0]), stock };
  shopRows.set(shopName, result);
  return result;
}

/** Sends the shop inventory the client reads "N in stock" from, after starting any row it lacks. */
function sendStock(player, shopName) {
  const raid = Raid.raidOf(player);
  const shop = shopStock(shopName);
  if (!raid || !shop || !(shop.inventoryId > 0)) return;
  const held = stockOf(raid);
  for (const entry of shop.stock) {
    if (!held.has(entry.itemId)) held.set(entry.itemId, initialStock(entry.itemId));
  }
  player.getPacketSender().sendInventory(shop.inventoryId, Math.max(1, shop.stock.length),
    shop.stock.map(({ itemId }) => ({ id: itemId, amount: held.get(itemId) })));
}

/** Every party member looking at this shop sees the purchase. */
function refreshViewers(shopName, raid) {
  const shop = shopStock(shopName);
  const main = Shared.core().CacheDefinitions.getInterfaceId("omnishop_main");
  if (!shop) return;
  for (const member of raid.players) {
    if (member.getInterfaceId?.() !== main) continue;
    if (member.getAttribute?.("omnishop:shop") !== shop.rowId) continue;
    sendStock(member, shopName);
  }
}

function credits(player) {
  return Number(player.getAttribute(ATTR_CREDITS)) || 0;
}

function setCredits(player, value) {
  const amount = Math.max(0, Math.min(MAX_CREDITS, value));
  player.setAttribute(ATTR_CREDITS, amount);
  player.getPacketSender().sendVarbit(Shared.named("varbit", "tfa_supply_points"), amount);
}

function onRoomComplete({ room, players }) {
  if (room === "HUB" || room === "VAULT") return;
  for (const player of players) setCredits(player, credits(player) + CREDITS_PER_CHALLENGE);
}

function resupply({ player }) {
  const raid = Raid.raidOf(player);
  if (!raid) return false;
  const shop = raid.deathCount > 0 ? SHOP_FAILURE : SHOP;
  Shared.api().emitCustomEvent("omnishop:open", { player, shop });
  // sendInventory rides a script packet, so it follows the shop-open packet.
  if (player.getInterfaceId?.() === Shared.core().CacheDefinitions.getInterfaceId("omnishop_main")) {
    sendStock(player, shop);
  }
  return true;
}

function talk({ player }) {
  if (!Raid.raidOf(player)) return false;
  Shared.mesbox(player, "The Quartermaster trades supplies for the Supply Credits your party has earned in the Archive.");
  return true;
}

function onCurrency(request) {
  if ((request.shop !== SHOP && request.shop !== SHOP_FAILURE) || request.currency !== Shared.named("dbrow", CURRENCY)) return;
  request.balance = credits(request.player);
  request.set = (value) => setCredits(request.player, value);
}

/** Omnishop asks before each unit is paid for, so a sold-out row costs nothing. */
function onCanBuy(request) {
  if ((request.shop !== SHOP && request.shop !== SHOP_FAILURE) || request.cancel) return;
  const raid = Raid.raidOf(request.player);
  if (!raid) return;
  const held = stockOf(raid);
  const count = held.has(request.itemId) ? held.get(request.itemId) : initialStock(request.itemId);
  if (count > 0) return;
  request.cancel = true;
  request.player.sendMessage(OUT_OF_STOCK);
}

/** A paid-for unit lowers the raid's stock; the buyer and every party member in the shop see it. */
function onPurchase(request) {
  if (request.shop !== SHOP && request.shop !== SHOP_FAILURE) return;
  const raid = Raid.raidOf(request.player);
  if (!raid) return;
  const held = stockOf(raid);
  const count = held.has(request.itemId) ? held.get(request.itemId) : initialStock(request.itemId);
  if (count > 0) held.set(request.itemId, count - 1);
  refreshViewers(request.shop, raid);
}

/** Credits belong to one raid: gone when a player leaves or the raid ends. */
function onLeave({ player }) {
  setCredits(player, 0);
}

module.exports = function registerQuartermaster(api) {
  Shared.bind(api);
  api.onNpcInteraction("Quartermaster", { Resupply: resupply, "Talk-to": talk });
  api.onCustomEvent("fractured-archive:room-complete", onRoomComplete);
  api.onCustomEvent("omnishop:currency", onCurrency);
  api.onCustomEvent("omnishop:can-buy", onCanBuy);
  api.onCustomEvent("omnishop:purchase", onPurchase);
  api.onCustomEvent("fractured-archive:left", onLeave);
  api.onPlayerLogin(onLeave);
};
