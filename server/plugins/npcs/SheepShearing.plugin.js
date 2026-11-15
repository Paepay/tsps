/**
 * Shearing sheep and alpacas (Wiki: Sheep, Alpaca).
 *
 * Shear (or shears used on the animal) needs shears in the inventory, gives one wool two
 * ticks after the animation, and transforms the animal to its sheared form until wool
 * grows back (50 ticks; 100 in Zanaris, where a quarter of attempts fail). "The Thing"
 * (Fred's penguin sheep) stays on Sheep Shearer.
 *
 * Lives outside the Quests plugin so shearing still works when Quests is switched off.
 */
const SHEAR_ANIMATION_ID = 893;
const SHEAR_SOUND = 761;
const SHEAR_SOUND_DELAY = 10;
const SHEAR_DELAY_TICKS = 2;
const WOOL_REGROW_TICKS = 50;
const ZANARIS_WOOL_REGROW_TICKS = 100;
const ZANARIS_ESCAPE_CHANCE = 0.25;

let core;
let SHEARED_BY_ID;
let SHEARED_IDS;
let ZANARIS_SHEARED_BY_ID;
let ZANARIS_SHEARED_ID;
let THING_NPC_ID;
let SHEARS_ITEM_ID;
let WOOL_ITEM_ID;

const shorn = new WeakSet();

function buildMaps(NpcIdentifiers) {
  SHEARED_BY_ID = new Map([
    [NpcIdentifiers.SHEEP_18, NpcIdentifiers.SHEEP_2],
    [NpcIdentifiers.SHEEP_19, NpcIdentifiers.SHEEP_4],
    [NpcIdentifiers.SHEEP_20, NpcIdentifiers.SHEEP_9],
    [NpcIdentifiers.SHEEP_21, NpcIdentifiers.SHEEP_10],
    [NpcIdentifiers.SHEEP_BALD_BLACK_HEAD, NpcIdentifiers.SHEEP_11],
    [NpcIdentifiers.SHEEP_3, NpcIdentifiers.SHEEP_12],
    [NpcIdentifiers.SHEEP_BALD_WHITE_HEAD, NpcIdentifiers.SHEEP_13],
    [NpcIdentifiers.SHEEP_5, NpcIdentifiers.SHEEP_14],
    [NpcIdentifiers.SHEEP_6, NpcIdentifiers.SHEEP_15],
    [NpcIdentifiers.SHEEP_7, NpcIdentifiers.SHEEP_16],
    [NpcIdentifiers.SHEEP_8, NpcIdentifiers.SHEEP_17],
    [NpcIdentifiers.ALPACA, NpcIdentifiers.ALPACA_2],
    [NpcIdentifiers.ALPACA_3, NpcIdentifiers.ALPACA_4],
  ]);
  SHEARED_IDS = new Set(SHEARED_BY_ID.values());
  ZANARIS_SHEARED_BY_ID = new Map([
    [NpcIdentifiers.SHEEP_25, NpcIdentifiers.SHEEP_27],
    [NpcIdentifiers.SHEEP_26, NpcIdentifiers.SHEEP_27],
  ]);
  ZANARIS_SHEARED_ID = NpcIdentifiers.SHEEP_27;
  THING_NPC_ID = NpcIdentifiers.SHEEP;
}

function hasShears(player) {
  return player.getInventory().getAmount(SHEARS_ITEM_ID) > 0;
}

function alreadyShorn(player, npc) {
  player.sendMessage("This sheep has already been shorn.");
  npc.forceChat("Baa!");
}

function finishShearing(player, npc, unshearedId, zanaris) {
  if (!player.isRegistered() || !npc.isRegistered()) {
    shorn.delete(npc);
    return;
  }
  if (zanaris && Math.random() < ZANARIS_ESCAPE_CHANCE) {
    shorn.delete(npc);
    player.sendMessage("The sheep manages to get away from you!");
    return;
  }
  if (player.getInventory().isFull()) {
    shorn.delete(npc);
    player.sendMessage("You don't have enough inventory space to hold the wool.");
    return;
  }
  player.getInventory().adds(WOOL_ITEM_ID, 1);
  player.sendMessage("You get some wool.");
  const shearedId = zanaris
    ? ZANARIS_SHEARED_BY_ID.get(unshearedId)
    : SHEARED_BY_ID.get(unshearedId);
  npc.setNpcTransformationId(shearedId ?? -1);
  const regrow = zanaris ? ZANARIS_WOOL_REGROW_TICKS : WOOL_REGROW_TICKS;
  core.TaskManager.submit(new core.CountdownTask(npc, regrow, () => {
    shorn.delete(npc);
    if (npc.isRegistered()) npc.setNpcTransformationId(-1);
  }));
}

function shearAnimal(player, npc, unshearedId, zanaris = false) {
  if (!npc) return;
  if (shorn.has(npc)) {
    alreadyShorn(player, npc);
    return;
  }
  if (!hasShears(player)) {
    player.sendMessage("You need a set of shears to do this.");
    return;
  }
  if (player.getInventory().isFull()) {
    player.sendMessage("You don't have enough inventory space to hold the wool.");
    return;
  }
  shorn.add(npc);
  player.performAnimation(new core.Animation(SHEAR_ANIMATION_ID));
  player.getPacketSender().sendSound(SHEAR_SOUND, 1, SHEAR_SOUND_DELAY);
  core.TaskManager.submit(new core.CountdownTask(npc, SHEAR_DELAY_TICKS, () => {
    finishShearing(player, npc, unshearedId, zanaris);
  }));
}

/** Left-click Shear on a sheep or alpaca. Returns false for The Thing so Sheep Shearer can own it. */
function shearOption(event) {
  if (event.npcId === THING_NPC_ID) return false;
  if (ZANARIS_SHEARED_BY_ID.has(event.npcId)) {
    shearAnimal(event.player, event.npc, event.npcId, true);
    return;
  }
  if (!SHEARED_BY_ID.has(event.npcId)) return false;
  shearAnimal(event.player, event.npc, event.npcId, false);
}

function shearsOnNpc(event) {
  if (event.itemId !== SHEARS_ITEM_ID) return;
  const npcId = event.npcId ?? event.target?.getId?.();
  const npc = event.npc ?? event.target;
  if (npcId === THING_NPC_ID) return;
  if (SHEARED_BY_ID.has(npcId) || ZANARIS_SHEARED_BY_ID.has(npcId)) {
    shearAnimal(event.player, npc, npcId, ZANARIS_SHEARED_BY_ID.has(npcId));
    event.handled = true;
    return;
  }
  if ((SHEARED_IDS.has(npcId) || npcId === ZANARIS_SHEARED_ID) && npc) {
    alreadyShorn(event.player, npc);
    event.handled = true;
  }
}

module.exports = {
  name: "SheepShearing",
  description: "Shearing sheep and alpacas for wool with a pair of shears.",
  register(api) {
    core = api.core;
    buildMaps(core.NpcIdentifiers);
    SHEARS_ITEM_ID = core.ItemIdentifiers.SHEARS;
    WOOL_ITEM_ID = core.ItemIdentifiers.WOOL;
    api.onNpcInteraction("Sheep", { Shear: shearOption });
    api.onNpcInteraction("Alpaca", { Shear: shearOption });
    api.onItemOnNpc(shearsOnNpc);
  },
};
