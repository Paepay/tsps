/**
 * Which area a map square (64 x 64 tiles, the cache's map archive) belongs to, built once per
 * league from the data's rectangles and squares over the cache's own map list
 * (CacheMaps.getRegionIds). The rules (data `regionRules`): the lowest-numbered area that names a
 * square owns it; a league's overrides reassign whole squares and outrank tile assignments; an
 * unnamed underground square (map y >= 100) follows its surface square; and a square nobody names
 * is open to everyone. Sourced tile outlines refine only mixed squares; explicit underground
 * ownership wins over the legacy surface-offset approximation. `tileOverrides` (world-tile rects)
 * are PaeScape's exact editor export for eight areas and win over both square and polygon maps.
 */
const Common = require("./Common.LeagueAreaUnlocks");

const UNDERGROUND_ROWS = 100;

/** league type -> map square id -> area id. */
const byLeague = new Map();
/** league type -> map square ids its `overrides` set explicitly (including open squares). */
const leagueOverrideSquares = new Map();
/** map square id -> flattened tile overrides that can cover it, built once. */
let tileOverridesBySquare = null;
/** Sparse tile detail, only for mixed squares; league overrides still take precedence. */
const tilesByLeague = new Map();

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

function loadTileOverrides() {
  const list = [];
  for (const entry of Common.data.tileOverrides ?? []) {
    for (const rect of entry.rects ?? (entry.rect ? [entry.rect] : [])) {
      const [minX, minY, maxX, maxY] = rect;
      list.push({ minX, minY, maxX, maxY, area: entry.area });
    }
  }
  // Fail closed on hand-edited overlaps: the editor's export is conflict-free, but a stale file
  // must not silently make the winner depend on array order.
  for (let left = 0; left < list.length; left++) {
    for (let right = left + 1; right < list.length; right++) {
      const a = list[left];
      const b = list[right];
      if (a.area === b.area) continue;
      if (a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY) {
        throw new Error(`league areas: tile overrides disagree at ${Math.max(a.minX, b.minX)},${Math.max(a.minY, b.minY)} (areas ${a.area} and ${b.area})`);
      }
    }
  }
  // Bucket by map square so a walk step checks only the few rects near it.
  const bySquare = new Map();
  for (const entry of list) {
    for (let mapX = entry.minX >> 6; mapX <= entry.maxX >> 6; mapX++) {
      for (let mapY = entry.minY >> 6; mapY <= entry.maxY >> 6; mapY++) {
        const id = squareId(mapX, mapY);
        const bucket = bySquare.get(id);
        if (bucket) bucket.push(entry);
        else bySquare.set(id, [entry]);
      }
    }
  }
  tileOverridesBySquare = bySquare;
  return list;
}

function tileOverrideAt(x, y) {
  if (!tileOverridesBySquare) loadTileOverrides();
  const entries = tileOverridesBySquare.get(squareOf(x, y));
  if (!entries) return undefined;
  for (const entry of entries) {
    if (x >= entry.minX && x <= entry.maxX && y >= entry.minY && y <= entry.maxY) return entry.area;
  }
  return undefined;
}

function build(type) {
  const cacheSquares = new Set(Common.core.CacheMaps.getRegionIds());
  const index = new Map();
  const tiles = new Map();
  const ids = [...Common.areas.keys()].sort((a, b) => a - b);
  for (const id of ids) {
    const area = Common.area(id);
    const own = new Map();
    for (const [mapX, mapY] of area.squares) claim(own, mapX, mapY, id, cacheSquares);
    for (const rect of area.rects) claimRect(own, rect, id, cacheSquares);
    for (const [square, owner] of own) if (!index.has(square)) index.set(square, owner);
    for (const polygon of area.tilePolygons) {
      for (const [mapX, mapY] of polygon.squares) {
        const square = squareId(mapX, mapY);
        if (!cacheSquares.has(square)) continue;
        if (!tiles.has(square)) tiles.set(square, []);
        tiles.get(square).push({ area: id, outline: polygon.outline });
      }
    }
  }
  const overridden = new Set();
  for (const override of Common.league(type)?.overrides ?? []) {
    const own = new Map();
    claimRect(own, override.rect, override.area, cacheSquares);
    for (const [square, owner] of own) {
      index.set(square, owner);
      overridden.add(square);
      tiles.delete(square);
    }
  }
  leagueOverrideSquares.set(type, overridden);
  for (const square of cacheSquares) {
    const mapY = square & 0xff;
    if (mapY < UNDERGROUND_ROWS || index.has(square)) continue;
    const surface = squareId(square >> 8, mapY - UNDERGROUND_ROWS);
    if (index.has(surface)) {
      index.set(square, index.get(surface));
      if (overridden.has(surface)) overridden.add(square);
    }
  }
  byLeague.set(type, index);
  tilesByLeague.set(type, tiles);
  return index;
}

function indexFor(type) {
  return byLeague.get(type) ?? build(type);
}

/** Wiki vertices are tile grid lines; classify each tile by its centre with the crossing rule. */
function contains(outline, x, y) {
  x += 0.5;
  y += 0.5;
  let inside = false;
  for (let i = 0, j = outline.length - 1; i < outline.length; j = i++) {
    const [ax, ay] = outline[j], [bx, by] = outline[i];
    if ((ay > y) !== (by > y) && x < (bx - ax) * (y - ay) / (by - ay) + ax) inside = !inside;
  }
  return inside;
}

/** The area id owning the tile, or null when it is open to everyone. */
function areaAt(type, x, y) {
  const index = indexFor(type);
  const square = squareOf(x, y);
  // A league's explicit square override (including `null` for open) is a league rule and wins
  // over the shared exact-tile map.
  if (leagueOverrideSquares.get(type)?.has(square)) return index.get(square) ?? null;
  // PaeScape's exact editor export wins where it names a tile.
  const tile = tileOverrideAt(x, y);
  if (tile !== undefined) return tile;
  // Sourced outlines refine mixed squares the editor export does not cover.
  for (const polygon of tilesByLeague.get(type).get(square) ?? []) {
    if (contains(polygon.outline, x, y)) return polygon.area;
  }
  return index.get(square) ?? null;
}

/** Whether a same-square move needs the tile-level check; no scan of unrelated players/areas. */
function hasTileDetail(type, x, y) {
  indexFor(type);
  const square = squareOf(x, y);
  if (tilesByLeague.get(type).has(square)) return true;
  if (!tileOverridesBySquare) loadTileOverrides();
  return tileOverridesBySquare.has(square);
}

/** Whether the character may stand on the tile: open ground, or an area it unlocked in a league that offers it. */
function isOpen(type, player, x, y) {
  if (!Common.regionLocked()) return true;
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

module.exports = { areaAt, isOpen, isOpenAt, levelUpAreas, isOpenForPlayer, isOpenAtForPlayer, squareId, squareOf, indexFor, hasTileDetail };
