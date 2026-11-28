"use strict";

/**
 * Desert Bandit Camp (issue #229).
 *
 * Wiki (Bandit Camp (Kharidian Desert)): the camp is multi-combat. Wiki (Bandit (Bandit Camp)):
 * "aggressive = Only when wearing an item associated with Saradomin or Zamorak", and a player
 * wearing one is attacked on sight. The cache's bandits are definition-passive, so the area
 * supplies both rules. If both god types are worn, the Wiki treats the player as Saradominist,
 * which does not change aggression.
 *
 * The bounds are the Wiki's multi-combat polygon for the camp, decomposed into the rectangles
 * Boundary supports. Spawn evidence (npc-spawns.json): 690-694 are inside the camp; 695 also has
 * five far-east spawns at x 3272-3302 that stay outside this area.
 */
const GodWars = require("../bosses/godwars/Common.GodWars");

const BANDIT_IDS = new Set([690, 691, 692, 693, 694, 695]);
/** The Wiki multi-combat polygon, as [minX, maxX, minY, maxY] rows on plane 0. */
const CAMP_ROWS = Object.freeze([
  [3174, 3187, 2952, 2952],
  [3173, 3187, 2953, 2953],
  [3173, 3188, 2954, 2954],
  [3172, 3188, 2955, 2955],
  [3171, 3189, 2956, 2956],
  [3163, 3189, 2957, 2957],
  [3149, 3190, 2958, 2959],
  [3149, 3191, 2960, 2961],
  [3150, 3192, 2962, 2962],
  [3151, 3192, 2963, 2963],
  [3152, 3193, 2964, 2964],
  [3153, 3193, 2965, 2965],
  [3152, 3194, 2966, 2966],
  [3139, 3143, 2967, 2967],
  [3150, 3194, 2967, 2967],
  [3138, 3195, 2968, 2969],
  [3138, 3196, 2970, 2970],
  [3139, 3196, 2971, 2971],
  [3140, 3197, 2972, 2972],
  [3141, 3197, 2973, 2973],
  [3143, 3198, 2974, 2974],
  [3144, 3198, 2975, 2975],
  [3145, 3197, 2976, 2976],
  [3147, 3197, 2977, 2977],
  [3148, 3196, 2978, 2978],
  [3149, 3196, 2979, 2979],
  [3149, 3195, 2980, 2981],
  [3147, 3195, 2982, 2982],
  [3146, 3195, 2983, 2983],
  [3145, 3195, 2984, 2984],
  [3144, 3195, 2985, 2986],
  [3143, 3195, 2987, 2988],
  [3142, 3195, 2989, 2992],
  [3143, 3195, 2993, 2993],
  [3142, 3195, 2994, 2995],
  [3141, 3195, 2996, 2996],
  [3140, 3194, 2997, 2998],
  [3140, 3193, 2999, 2999],
  [3140, 3192, 3000, 3000],
  [3139, 3192, 3001, 3001],
  [3138, 3191, 3002, 3002],
  [3137, 3191, 3003, 3003],
  [3137, 3180, 3004, 3004],
  [3137, 3177, 3005, 3005],
]);
const GOD_FACTIONS = new Set(["saradomin", "zamorak"]);

let core = null;
let CampArea = null;

/** Whether the player wears any Saradominist or Zamorakian item. */
function wearsGodItem(player) {
  for (const item of player.getEquipment?.()?.getItems?.() ?? []) {
    if (!item || item.getId() <= 0) continue;
    const id = item.getId();
    const name = core.ItemDefinition.forId(id)?.getName?.() ?? "";
    for (const faction of GodWars.factions) {
      if (GOD_FACTIONS.has(faction.key) && GodWars.isGodItem(faction, id, name)) return true;
    }
  }
  return false;
}

function campArea() {
  if (CampArea) return CampArea;
  const { Area, Boundary } = core;
  CampArea = class BanditCamp extends Area {
    constructor() {
      super(CAMP_ROWS.map(([minX, maxX, minY, maxY]) => new Boundary(minX, maxX, minY, maxY, 0)));
    }

    getName() {
      return "Bandit Camp";
    }

    isMulti() {
      return true;
    }

    /** The Wiki's rule: bandits attack only players wearing Saradomin or Zamorak equipment. */
    npcAggression(player, npc) {
      if (!BANDIT_IDS.has(npc.getId?.())) return null;
      return wearsGodItem(player);
    }
  };
  return CampArea;
}

module.exports = {
  name: "BanditCamp",
  description: "The Kharidian Desert Bandit Camp: multi-combat, with its bandits aggressive only to players wearing Saradominist or Zamorakian equipment.",
  members: true,
  _test: { BANDIT_IDS, CAMP_ROWS, wearsGodItem, campArea },
  register(api) {
    core = api.core;
    api.registerArea(new (campArea())());
  },
};
