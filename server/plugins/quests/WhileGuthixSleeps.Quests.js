/**
 * While Guthix Sleeps' post-quest travel and rewards when Quests is off.
 *
 * QuestAutoComplete marks While Guthix Sleeps complete, but the quest module's hooks live behind
 * a definition-only proxy. The light creatures therefore still drift (the Tears of Guthix
 * minigame spawns them) while Attract and the lit sapphire lantern do nothing. The chasm module
 * already knows the post-quest route: its menu crosses to Juna's side or descends to the temple
 * floor, and its map change brings back the light creature that returns players to the surface.
 * Reusing it keeps the TD entrance, the return trip and the quest scenery in step with the normal
 * Quests world instead of duplicating the route here.
 *
 * The Wiki rewards are the same shared unit as the quest: Kuradal's notes and the tormented
 * synapse recipes gate on stage 900, which is the auto-completed value, so they must not be
 * stranded behind the definition-only proxy either (issues 186/205).
 */
const QuestRuntime = require("./QuestRuntime");
const Fellowship = require("./wgs/Fellowship.WhileGuthixSleeps");

const PAGE = "While Guthix Sleeps";
const TEMPLE_ENTRY = [4061, 4466, 0];
const TEMPLE_EXIT_HOLE = 53637;

const ATTRIBUTES = [];

function replaceScenery(api, player, id, tile, type = 10, face = 0) {
  const { GameObject, Location, MapObjects, ObjectManager } = api.core;
  const area = player.getPrivateArea();
  if (!area) throw new Error("Quest scenery must belong to a private area");
  let old = ObjectManager.objectsAt(new Location(...tile))
    .find((object) => object.getPrivateArea() === area && object.getType() === type);
  if (!old) {
    const placed = (MapObjects.mapObjects.get(MapObjects.getHash(...tile)) || [])
      .find((object) => object.getType() === type);
    if (placed) old = new GameObject(placed.getId(), placed.getLocation(), type, placed.getFace(), area);
  }
  if (old) ObjectManager.deregister(old, true);
  const object = new GameObject(id, new Location(...tile), type, face, area);
  ObjectManager.register(object, true);
  return object;
}

module.exports = function attachWhileGuthixSleepsQuests(api) {
  const quest = QuestRuntime.getRegisteredQuests().find((entry) => entry.key === "while_guthix_sleeps");
  if (!quest) return false;

  const stage = (player) => quest.getStage(player);
  const advance = (player, value) => {
    if (stage(player) < value) quest.setStage(player, value);
  };
  const held = (player, itemId) => player.getInventory().contains(itemId);
  const give = (player, itemId, amount = 1) => {
    if (held(player, itemId)) return true;
    if (!player.getInventory().getFreeSlots()) {
      player.sendMessage("You need a free inventory space.");
      return false;
    }
    player.getInventory().adds(itemId, amount);
    return true;
  };
  const val = (player, key) => Number(player.getAttribute(key)) || 0;
  const play = (player, npcId, variant) => {
    QuestRuntime.startTranscript(api, player, npcId, PAGE, variant);
  };
  const context = {
    api, stage, advance, held, give, val, play,
    replace: (player, id, tile, type, face) => replaceScenery(api, player, id, tile, type, face),
    ATTRIBUTES,
  };

  require("./wgs/Chasm.WhileGuthixSleeps")(context);
  require("./wgs/Rewards.WhileGuthixSleeps")(context);

  // The fellowship's login sync is what turns Duradel's multinpc into Kuradal. Without it
  // auto-complete leaves the old master in place, so the notes cannot be obtained at all
  // (issue 186).
  const syncVisibility = ({ player }) => {
    if (player) Fellowship.syncVisibility(player.getPacketSender(), stage(player));
  };
  api.onPlayerLogin(syncVisibility);
  api.onPlayerMapSquareChange(syncVisibility);

  // The post-quest temple has no puzzle instance: the opening drops straight into its entrance,
  // and the crawl-through hole returns to the chasm floor.
  api.onCustomEvent("wgs:enter-temple", ({ player }) => {
    if (!player || stage(player) < 760) return;
    const previous = player.getArea();
    if (previous) previous.leave(player, false);
    player.moveTo(new api.core.Location(...TEMPLE_ENTRY));
    player.getPacketSender().sendVarbit(10815, 0);
  });
  api.onObjectInteraction("Hole", {
    "Crawl-through": (event) => {
      const id = event.definition?.id ?? event.objectId;
      if (id !== TEMPLE_EXIT_HOLE || stage(event.player) < 760) return;
      api.emitCustomEvent("wgs:return-chasm", { player: event.player });
      return true;
    },
  });

  for (const key of ATTRIBUTES) api.persistAttribute(key);
  return true;
};
