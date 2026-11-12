/**
 * Which area a map square (64 x 64 tiles, the cache's map archive) belongs to, built once per
 * league from the data's rectangles and squares over the cache's own map list
 * (CacheMaps.getRegionIds). The rules (data `regionRules`): the lowest-numbered area that names a
 * square owns it, a league's overrides reassign squares, an unnamed underground square (map y >=
 * 100) follows its surface square, and a square nobody names is open to everyone.
 */
const Common = require("./Common.LeagueAreaUnlocks");

const UNDERGROUND_ROWS = 100;

/** league type -> map square id -> area id. */
const byLeague = new Map();

function squareId(mapX, mapY) {
  return ((mapX & 0xff) << 8) | (mapY & 0xff);
}

function squareOf(x, y) {
  return squareId(x >> 6, y >> 6);
}

function claim(index, mapX, mapY, area, cacheSquares) {
  const id = squareId(mapX, mapY);
  if (cacheSquares.has(id)) index.set(id, area);
}

function claimRect(index, [minX, minY, maxX, maxY], area, cacheSquares) {
  for (let mapX = minX; mapX <= maxX; mapX++) {
    for (let mapY = minY; mapY <= maxY; mapY++) claim(index, mapX, mapY, area, cacheSquares);
  }
}

function build(type) {
  const cacheSquares = new Set(Common.core.CacheMaps.getRegionIds());
  const index = new Map();
  const ids = [...Common.areas.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const area = Common.area(id);
    const own = new Map();
    for (const [mapX, mapY] of area.squares) claim(own, mapX, mapY, id, cacheSquares);
    for (const rect of area.rects) claimRect(own, rect, id, cacheSquares);
    for (const [square, owner] of own) if (!index.has(square)) index.set(square, owner);
  }
  for (const override of Common.league(type)?.overrides ?? []) {
    const own = new Map();
    claimRect(own, override.rect, override.area, cacheSquares);
    for (const [square, owner] of own) index.set(square, owner);
  }
  for (const square of cacheSquares) {
    const mapY = square & 0xff;
    if (mapY < UNDERGROUND_ROWS || index.has(square)) continue;
    const surface = squareId(square >> 8, mapY - UNDERGROUND_ROWS);
    if (index.has(surface)) index.set(square, index.get(surface));
  }
  byLeague.set(type, index);
  return index;
}

function indexFor(type) {
  return byLeague.get(type) ?? build(type);
}

/** The area id owning the tile, or null when it is open to everyone. */
function areaAt(type, x, y) {
  return indexFor(type).get(squareOf(x, y)) ?? null;
}

/** Whether the character may stand on the tile: open ground, or an area it unlocked in a league that offers it. */
function isOpen(type, player, x, y) {
  const area = areaAt(type, x, y);
  if (area === null) return true;
  return Common.league(type).areas.includes(area) && Common.unlocked(player).includes(area);
}

function isOpenAt(type, player, location) {
  return isOpen(type, player, location.getX(), location.getY());
}

/** Level-Up uses the same region map without impersonating a seasonal league. */
function levelUpAreas(player) {
  const query = { player, active: false, unlocked: [] };
  Common.api.emitCustomEvent("level-up:area-profile", query);
  return query.active === true ? query.unlocked.map(Number) : null;
}

function isOpenForPlayer(type, player, x, y) {
  const unlocked = levelUpAreas(player);
  if (unlocked) {
    const owner = areaAt(null, x, y);
    return owner === null || unlocked.includes(owner);
  }
  return type !== null && isOpen(type, player, x, y);
}

function isOpenAtForPlayer(type, player, location) {
  return isOpenForPlayer(type, player, location.getX(), location.getY());
}

module.exports = { areaAt, isOpen, isOpenAt, levelUpAreas, isOpenForPlayer, isOpenAtForPlayer, squareId, squareOf, indexFor };
