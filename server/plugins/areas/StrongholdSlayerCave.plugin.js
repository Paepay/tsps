/**
 * The Stronghold Slayer Cave beneath the Tree Gnome Stronghold (https://oldschool.runescape.wiki/w/Stronghold_Slayer_Cave),
 * known as Nieve's cave (docs/stronghold-slayer-cave.md). Since the Diversed Dungeons split on 27 April 2017 it holds only ankou,
 * fire giants, hellhounds, bloodvelds and aberrant spectres. Anyone may enter, but a monster can
 * only be attacked while it is the player's current Slayer assignment (the Wiki's opening
 * paragraph, and the completed-task rule in Tasks.Slayer).
 *
 * The rectangle is the walkable cave reached from the bloodveld room: x 2388-2495, y 9768-9838.
 * The five monster families inside it are the Wiki's full table: 8 ankou, 12 fire giants, 13
 * hellhounds, 12 bloodvelds and 13 aberrant spectres. Brimstail and the Tree Gnome Stronghold's
 * other NPCs are left alone by the name check. The cave is Kandarin on Level-Up worlds: the
 * league area map's Tirannwn pass ends at map row 151 (league-areas.json), above the cave.
 */
const MONSTER_NAMES = new Set([
  'Ankou', 'Fire giant', 'Hellhound', 'Bloodveld', 'Aberrant spectre',
]);
const CAVE = Object.freeze([2388, 2495, 9768, 9838]);
const REFUSAL = 'You can only attack monsters that are part of your Slayer assignment.';
const ON_TASK_EVENT = 'slayer:on-task';

let api = null;

function monsterName(npc) {
  return (npc.getCurrentDefinition?.() ?? npc.getDefinition?.())?.getName?.() ?? '';
}

/** Whether the player's Slayer task (or content counting every Slayer monster) covers this NPC. */
function onTask(player, npc) {
  const request = { player, npc, onTask: false };
  api.emitCustomEvent(ON_TASK_EVENT, request);
  return request.onTask === true;
}

function refuse(player) {
  player.sendMessage(REFUSAL);
}

function createCave(pluginApi) {
  const { Area, Boundary } = pluginApi.core;
  class StrongholdSlayerCave extends Area {
    canAttack(attacker, target) {
      if (!attacker?.isPlayer?.() || !target?.isNpc?.() || !MONSTER_NAMES.has(monsterName(target))) return null;
      const player = attacker.getAsPlayer?.() ?? attacker;
      if (onTask(player, target)) return null;
      // canAttack is also a permission probe (target scans, the dwarf cannon, the agent MCP):
      // only the player's own pending attack is refused aloud, and a monster retaliating is silent.
      const combat = player.getCombat?.();
      if (combat?.getTarget?.() === target && !combat.isAutoRetaliating?.()) refuse(player);
      return false;
    }
  }
  return new StrongholdSlayerCave([new Boundary(...CAVE, 0)]);
}

function registerCave(pluginApi) {
  api = pluginApi;
  pluginApi.registerArea(createCave(pluginApi));
}

module.exports = {
  name: 'StrongholdSlayerCave',
  description: 'Lets only players on the matching Slayer task attack monsters in the Stronghold Slayer Cave.',
  members: true,
  register(pluginApi) {
    registerCave(pluginApi);
  },
  _test: { createCave, refuse, onTask, CAVE, MONSTER_NAMES, REFUSAL },
};
