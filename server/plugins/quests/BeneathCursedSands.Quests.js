/**
 * Beneath Cursed Sands' Necropolis rubble when Quests is off.
 *
 * QuestAutoComplete loads the quest definition but deliberately leaves its gameplay hooks
 * unregistered. The first rubble (44003 at 3348,2759) is the only way from Sophanem into the
 * Tombs of Amascut camp, so Quests-off worlds need the post-quest crossing too. This mirrors
 * the captured 227/00101.txt crossing: exact-move 839 over 60 cycles, sound 2454, and busy
 * varbit 12393 for the two-tick movement.
 */
const RUBBLE = 44003;
const RUBBLE_Y = 2759;
const RUBBLE_WEST = 3347;
const RUBBLE_EAST = 3349;
const CROSS_TICKS = 2;
const CROSS_CYCLES = 60;
const CROSS_ANIMATION = 839;
const CROSS_SOUND = 2454;
const BUSY_VARBIT = 12393;

let api;

function climbRubble(event) {
  if (event.objectId !== RUBBLE || !event.player) return false;
  const player = event.player;
  const at = player.getLocation();
  const fromX = at.getX() > (RUBBLE_WEST + RUBBLE_EAST) / 2 ? RUBBLE_EAST : RUBBLE_WEST;
  const from = new api.core.Location(fromX, RUBBLE_Y, 0);
  if (at.getX() !== fromX || at.getY() !== RUBBLE_Y || at.getZ() !== 0) player.moveTo(from);

  const sender = player.getPacketSender();
  const { ForceMovement, ForceMovementTask, TaskManager } = api.core;
  let busyCleared = false;
  class RubbleCrossing extends ForceMovementTask {
    stop() {
      super.stop();
      if (busyCleared) return;
      busyCleared = true;
      sender.sendVarbit(BUSY_VARBIT, 0);
    }
  }

  const west = fromX === RUBBLE_EAST;
  sender.sendVarbit(BUSY_VARBIT, 1);
  TaskManager.submit(new RubbleCrossing(player, CROSS_TICKS,
    new ForceMovement(from.clone(), new api.core.Location(west ? -2 : 2, 0, 0), 0,
      CROSS_CYCLES, west ? 3 : 1, CROSS_ANIMATION)));
  sender.sendSoundEffect(CROSS_SOUND, 3, 4, 1);
  return true;
}

module.exports = function attachBeneathCursedSandsQuests(pluginApi) {
  api = pluginApi;
  api.onObjectInteraction((event) => {
    if (!event.handled && climbRubble(event)) event.handled = true;
  });
};

module.exports.RUBBLE = RUBBLE;
module.exports.climbRubble = climbRubble;
