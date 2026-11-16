/**
 * Culinaromancer's Chest in the Lumbridge Castle cellar (Wiki: Chest (Culinaromancer's)).
 *
 * The cache parent loc sits against the east wall, so its access edge has no standable tile;
 * clicks are routed to the floor west of it. Bank / Buy-food / Buy-items and the shop's
 * full-stock price coefficients live here so they still work when the Quests plugin is off
 * (QuestAutoComplete marks Recipe for Disaster complete, but RFD's own hooks never register).
 */
const QuestRuntime = require("../quests/QuestRuntime");

/** Cache parent loc; the client shows transform 12309 after RFD varbit 1850 >= 3. */
const CHEST_PARENT = 12308;
/** Floor west of the chest's map tile (3219,9623): the only walkable operate side. */
const CHEST_SIDE = Object.freeze({ x: 3218, y: 9623, z: 0 });
const STAGE_ATTR = "quest.recipe_for_disaster.stage";
const FLAGS_ATTR = "recipe-for-disaster:rescues";
const STAGE_OPENING_COMPLETE = 4;
const STAGE_COMPLETE = 5;
const ALL_RESCUES = 255;
const CHEST_SHOP = "Culinaromancer's Chest";
const CHEST_ITEM_VARIANTS = ["Full", "Elite Diary", ...Array.from({ length: 9 }, (_, count) => `${count} Subquest${count === 1 ? "" : "s"}`)];
const CHEST_FOOD_VARIANTS = ["food, full", "food, full, diary", ...Array.from({ length: 9 }, (_, count) => `food, ${count} Subquest${count === 1 ? "" : "s"}`)];
const CHEST_SHOP_NAMES = new Set([...CHEST_ITEM_VARIANTS, ...CHEST_FOOD_VARIANTS].map((variant) => `${CHEST_SHOP} (${variant})`));

let api;

function isChest(objectId) {
  return objectId === CHEST_PARENT;
}

function rfdQuest() {
  return QuestRuntime.getRegisteredQuests().find((quest) => quest.key === "recipe_for_disaster") ?? null;
}

function stage(player) {
  const quest = rfdQuest();
  if (quest) return Number(quest.getStage(player)) || 0;
  return Number(player.getAttribute(STAGE_ATTR)) || 0;
}

function flags(player) {
  return Number(player.getAttribute(FLAGS_ATTR)) || 0;
}

function isComplete(player) {
  const quest = rfdQuest();
  if (quest) return quest.isComplete(player);
  return stage(player) >= STAGE_COMPLETE;
}

function chestDiscount(player) {
  if (!isComplete(player)) return false;
  const request = { player, diary: "lumbridge", tier: "elite", claimed: false };
  api.emitCustomEvent("diary:is-reward-claimed", request);
  return request.claimed === true;
}

function chestShopName(player, food) {
  const variants = food ? CHEST_FOOD_VARIANTS : CHEST_ITEM_VARIANTS;
  if (isComplete(player)) return `${CHEST_SHOP} (${variants[chestDiscount(player) ? 1 : 0]})`;
  const rescued = (flags(player) & ALL_RESCUES).toString(2).replaceAll("0", "").length;
  return `${CHEST_SHOP} (${variants[rescued + 2]})`;
}

/** The chest sits against the cellar's east wall; operate from the floor beside it. */
function routeChest(event) {
  if (!isChest(event.objectId)) return;
  event.destination = { ...CHEST_SIDE };
}

function priceChest(event) {
  if (!event.player || event.currency !== "COINS" || !CHEST_SHOP_NAMES.has(event.shopName) || event.price <= 0) return;
  const stock = api.core.ShopDefinition.forId(event.shopId)?.getOriginalStock().find((item) => item.id === event.itemId);
  const base = stock?.price > 0 ? stock.price : api.core.ItemDefinition.forId(event.itemId).getValue();
  if (event.price !== base) return;
  event.price = Math.floor(base * (chestDiscount(event.player) ? 104 : 130) / 100);
}

function buybackChest(event) {
  if (event.currency !== "COINS" || !CHEST_SHOP_NAMES.has(event.shopName) || event.price <= 0) return;
  event.price = Math.floor(event.buyPrice * 40 / 100);
}

function handleChest(event) {
  if (!isChest(event.objectId)) return false;
  const option = event.definition?.getActions?.()?.[event.clickType - 1];
  if (option === "Bank") {
    event.handled = true;
    event.player.getBank(event.player.getCurrentBankTab()).open();
    return true;
  }
  if (option !== "Buy-food" && option !== "Buy-items") return false;
  event.handled = true;
  const player = event.player;
  if (stage(player) < STAGE_OPENING_COMPLETE) {
    player.sendMessage("You must help the Cook prepare the banquet before using this shop.");
    return true;
  }
  const name = chestShopName(player, option === "Buy-food");
  const shop = api.core.ShopDefinition.all().find((definition) => definition.getName() === name);
  if (!shop || !api.core.ShopManager.open(player, shop.getId())) {
    player.sendMessage("This shop is currently unavailable.");
  }
  return true;
}

module.exports = {
  name: "CulinaromancersChest",
  description: "Culinaromancer's Chest: bank and food/item shops in the Lumbridge cellar, including when Quests is off.",
  members: true,
  _test: { routeChest, handleChest, priceChest, buybackChest, CHEST_PARENT, CHEST_SIDE, CHEST_SHOP_NAMES },
  register(pluginApi) {
    api = pluginApi;
    pluginApi.onObjectRoute(routeChest);
    pluginApi.onObjectInteraction(handleChest);
    pluginApi.onCustomEvent("shop:buy-price", priceChest);
    pluginApi.onCustomEvent("shop:sell-price", buybackChest);
  },
};
