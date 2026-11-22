/**
 * Passive crystal shards from chopping in Prifddinas
 * (https://oldschool.runescape.wiki/w/Crystal_shard): one 1/40 roll for every log received,
 * including a log burned by the infernal axe; Gwenith does not count.
 *
 * The bounds are Prifddinas's own 128x128 music-map area. In the generated
 * data/definitions/music-areas.json, area 26 (Architects of Prifddinas and the city's other
 * tracks) covers exactly x 3200-3327, y 6016-6143 on plane 0; Gwenith is area 170 at
 * x 2260, y 3400.
 */
const PRIFDDINAS = Object.freeze({ minX: 3200, maxX: 3327, minY: 6016, maxY: 6143, z: 0 });
const SHARD_CHANCE = 1 / 40;

let core = null;
let itemOnGroundManager = null;

function isInPrifddinas(location) {
  return location?.getZ?.() === PRIFDDINAS.z
    && location.getX() >= PRIFDDINAS.minX && location.getX() <= PRIFDDINAS.maxX
    && location.getY() >= PRIFDDINAS.minY && location.getY() <= PRIFDDINAS.maxY;
}

/** Each received log rolls separately; the remainder of a shard stack goes to the floor. */
function rollShard(event) {
  const { player, location } = event;
  const logs = Math.max(0, Math.floor(Number(event.logAmount) || 0));
  if (!player || logs === 0 || !isInPrifddinas(location) || !core.WorldDefinition.isMembersWorld()) return;

  let shards = 0;
  for (let log = 0; log < logs; log++) {
    if (Math.random() < SHARD_CHANCE) shards++;
  }
  if (shards === 0) return;

  const shardId = core.ItemIdentifiers.CRYSTAL_SHARD;
  const inventory = player.getInventory();
  const fits = Math.min(inventory.getAddableAmount(new core.Item(shardId, shards)), shards);
  if (fits > 0) inventory.add(new core.Item(shardId, fits), true);
  if (fits < shards) itemOnGroundManager.registers(player, new core.Item(shardId, shards - fits));
  player.sendMessage(shards === 1 ? 'You receive a crystal shard.' : 'You receive ' + shards + ' crystal shards.');
}

function attach(api) {
  core = api.core;
  itemOnGroundManager = api.getItemOnGroundManager();
  api.onCustomEvent('woodcutting:success', rollShard);
}

module.exports = { attach, isInPrifddinas, PRIFDDINAS, SHARD_CHANCE };
