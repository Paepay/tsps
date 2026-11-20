/**
 * What the relics' teleport items share: a paged destination menu, the teleport itself (the
 * standard animation, or the league's area-teleport cast for an item that asks for it; the
 * Wilderness limit of the item, and only to areas the league character has unlocked), the item's
 * last destination, and the destinations listed by league area that Demonic Pacts' items share
 * (`areaTeleports`, in the browser client's two-stage teleport menu).
 *
 * Areas: `league:area-at` { player, x, y } -> area (null when open) and `league:areas` { player } ->
 * unlocked, from the league's area unlocks; with nobody answering, every area is open. The cast:
 * `league:teleport-cast` { player } -> cast, from the same; with nobody answering, the standard
 * teleport.
 */
const Common = require("./Common.LeagueRelics");
const { startHomeTeleport, castOf } = require("../../combat/HomeTeleportSequence");

/** "Ignores Wilderness teleport restrictions" (Wiki): no level stops it. */
const ANY_WILDERNESS_LEVEL = 60;
/** The browser client's teleport menu, with at most twelve shortcuts on a page. */
const TELEPORT_MENU_CHANNEL = "teleport-menu";
const MENU_PAGE_SIZE = 12;
/** The server's menu for each player: { id, key, title, regions, stage, regionIndex, page, regionPage, back }. */
const teleportMenus = new WeakMap();
const menuApis = new WeakSet();
let nextMenuId = 1;

function lastAttribute(key) {
  return `league:last-destination:${key}`;
}

/** The area ids the league character has unlocked, or null when nobody answers (everything open). */
function unlockedAreas(player) {
  const areas = { player, unlocked: null };
  Common.api.emitCustomEvent("league:areas", areas);
  // A seasonal character identifies its league. A Level-Up character answers with league null and
  // an empty list, which must fall through to its own region profile instead of locking every area.
  if (areas.league !== null && Array.isArray(areas.unlocked)) return areas.unlocked;
  // Level-Up uses the same region map and its own progression, without a seasonal league profile.
  const levelUp = { player, active: false, unlocked: [] };
  Common.api.emitCustomEvent("level-up:area-profile", levelUp);
  return levelUp.active === true && Array.isArray(levelUp.unlocked) ? levelUp.unlocked.map(Number) : null;
}

/** Whether the tile is in an area the league character has unlocked (or no area at all). */
function areaOpen(player, location) {
  const at = { player, x: location.getX(), y: location.getY(), area: null };
  Common.api.emitCustomEvent("league:area-at", at);
  if (at.area === null || at.area === undefined) return true;
  const unlocked = unlockedAreas(player);
  return unlocked === null || unlocked.includes(at.area);
}

/** Whether league area `area` (an id) is unlocked; true with nobody answering. */
function areaUnlocked(player, area) {
  const unlocked = unlockedAreas(player);
  return unlocked === null || unlocked.includes(area);
}

/** Enough open floor to walk from (tiles): not a pocket behind a counter. */
const LANDING_REACH = 30;
const LANDING_RADIUS = 4;
/** Cardinal steps in RegionManager.canMoveIsBlocked's directions: north, west, east, south. */
const STEPS = [[1, 0, 1], [3, -1, 0], [4, 1, 0], [6, 0, -1]];

/** How many tiles can be walked to from `tile`, up to `limit` (walls and solid locs block). */
function reach(tile, limit) {
  const { RegionManager, Location } = Common.core;
  const seen = new Set([`${tile.getX()},${tile.getY()}`]);
  const queue = [tile];
  while (queue.length > 0 && seen.size < limit) {
    const at = queue.shift();
    for (const [direction, dx, dy] of STEPS) {
      const key = `${at.getX() + dx},${at.getY() + dy}`;
      if (seen.has(key) || !RegionManager.canMoveIsBlocked(at, direction, null)) continue;
      seen.add(key);
      queue.push(new Location(at.getX() + dx, at.getY() + dy, at.getZ()));
    }
  }
  return seen.size;
}

/**
 * Where to land for `location`: preserve an open destination, including small rooms. For a blocked
 * destination, use the nearest open tile
 * within 4 from which 30 tiles can be walked (a STASH unit, a clue's loc, a bank booth: not the
 * banker's side of the counter), else the open tile that reaches furthest.
 */
function landing(location) {
  const { RegionManager, Location } = Common.core;
  if (!RegionManager?.blocked || !RegionManager.canMoveIsBlocked) return location;
  // A small room is a valid destination; a larger component across its walls may be outside.
  if (!RegionManager.blocked(location, null)) return location;
  let best = null;
  for (let radius = 0; radius <= LANDING_RADIUS; radius++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dy = -radius; dy <= radius; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
        const tile = radius === 0 ? location : new Location(location.getX() + dx, location.getY() + dy, location.getZ());
        if (RegionManager.blocked(tile, null)) continue;
        const tiles = reach(tile, LANDING_REACH);
        if (tiles >= LANDING_REACH) return tile;
        if (!best || tiles > best.tiles) best = { tile, tiles };
      }
    }
  }
  return best?.tile ?? location;
}

/** The league's area-teleport cast for the character (`league:teleport-cast`), or null. */
function leagueCast(player) {
  const query = { player, cast: null };
  Common.api.emitCustomEvent("league:teleport-cast", query);
  return query.cast ?? null;
}

/**
 * Teleports to `destination` { label, location, wildernessLevel?, remember? } for item `key`,
 * remembering it as the item's last destination on arrival (not with `remember: false`, a
 * destination that needs its own arrival, the house). `onArrival` runs after. With `cast` true, the
 * league's area-teleport cast plays (interrupted as a home teleport is) where the league has one; a
 * cast definition ({ steps, lockTick, landTick }, an item's own recorded cast) plays instead.
 * Content may ask first (TeleportHandler.confirm: the boat-at-sea warning): `onStart` runs as the
 * teleport starts (`item`, an id the player must still carry then, used up), not when it is only
 * asked. True once the checks pass, whether or not it was asked and refused: no caller acts on it
 * as an arrival.
 */
function go(player, key, destination, { wildernessLevel = ANY_WILDERNESS_LEVEL, onArrival = null, cast = false, onStart = null, item = undefined } = {}) {
  const { TeleportHandler, TeleportType } = Common.core;
  const location = landing(destination.location);
  if (!areaOpen(player, location)) {
    player.sendMessage(Common.message("areaLocked"));
    return false;
  }
  const limit = destination.wildernessLevel ?? wildernessLevel;
  if (!TeleportHandler.checkReqs(player, location, limit)) return false;
  const arrived = () => {
    if (destination.remember !== false) {
      player.setAttribute(lastAttribute(key), {
        label: destination.label, x: location.getX(), y: location.getY(), z: location.getZ(), wildernessLevel: limit,
      });
    }
    onArrival?.();
  };
  const definition = cast === true ? leagueCast(player) : cast || null;
  TeleportHandler.confirm(player, location, () => {
    onStart?.();
    if (definition) startHomeTeleport(Common.core, player, location, arrived, castOf(definition));
    else TeleportHandler.teleport(player, location, TeleportType.NORMAL, false, arrived);
  }, limit, { item });
  return true;
}

/**
 * An item's own cast from its data ({ tick, landTick, animation, graphic }, seq and spotanim by
 * gameval name): the animation and graphic on `tick`, locked from it, the move on `landTick`.
 */
function itemCast(spec) {
  const { CacheDefinitions } = Common.core;
  return {
    steps: [{ tick: spec.tick, animation: CacheDefinitions.getSeqId(spec.animation), graphic: CacheDefinitions.getSpotanimId(spec.graphic) }],
    lockTick: spec.tick, landTick: spec.landTick,
  };
}

/** The item's last destination, or a message when there is none yet. */
function goLast(player, key) {
  const last = player.getAttribute(lastAttribute(key));
  if (!last || !Number.isInteger(last.x)) {
    player.sendMessage(Common.message("noLastDestination"));
    return false;
  }
  const location = new Common.core.Location(last.x, last.y, last.z ?? 0);
  return go(player, key, { label: last.label, location, wildernessLevel: last.wildernessLevel });
}

/**
 * The browser client's teleport menu. The server owns the two-stage region -> destination tree,
 * sends only the current page (twelve entries, so a shortcut always fits), and validates every
 * index and session. The relic's existing `go` remains the only teleport path.
 */
function menuPageCount(length) {
  return Math.max(1, Math.ceil(length / MENU_PAGE_SIZE));
}

function sendMenuPacket(player, packet) {
  const encode = Common.api?.encodePluginMessage ?? Common.api?.core?.encodePluginMessage;
  if (typeof encode !== "function") return;
  try {
    player.getSession?.()?.sendClientPacket(encode(TELEPORT_MENU_CHANNEL, packet));
  } catch (error) {
    Common.api?.log?.(`[league-teleports] could not send the teleport menu: ${error.message}`);
  }
}

function menuLocked(entry) {
  return entry?.locked === true;
}

function menuReason(entry) {
  return typeof entry?.reason === "string" && entry.reason.length > 0
    ? entry.reason
    : "That teleport is unavailable.";
}

function selectedRegion(state) {
  return state.stage === "destinations" && Number.isInteger(state.regionIndex)
    ? state.regions[state.regionIndex]
    : null;
}

/** The page the client should draw for the menu's current stage. */
function sendMenuScreen(player, state) {
  const region = selectedRegion(state);
  const list = region ? region.destinations : state.regions;
  const pages = menuPageCount(list.length);
  state.page = Math.max(0, Math.min(pages - 1, Number.isInteger(state.page) ? state.page : 0));
  const start = state.page * MENU_PAGE_SIZE;
  const entries = list.slice(start, start + MENU_PAGE_SIZE).map((entry, offset) => {
    const locked = menuLocked(entry);
    return {
      index: start + offset,
      label: String(entry.label ?? "Teleport"),
      locked,
      ...(locked ? { reason: menuReason(entry) } : {}),
    };
  });
  sendMenuPacket(player, {
    type: "screen",
    session: state.id,
    stage: state.stage,
    title: region ? (region.destinationTitle ?? region.label) : state.title,
    page: state.page,
    pages,
    total: list.length,
    canBack: region !== null && state.back === true,
    ...(region ? { region: { index: state.regionIndex, name: region.label } } : {}),
    entries,
  });
}

function menuError(player, state, message) {
  sendMenuPacket(player, { type: "error", session: state.id, message });
}

/**
 * Opens a menu with `regions` [{ label, locked?, reason?, destinationTitle?, destinations:
 * [{ label, locked?, reason?, choose }] }]. `regionIndex` opens one region's destination list
 * directly (an item's own submenu); Back returns to the regions unless `back` is false.
 */
function openMenu(player, spec, { regionIndex = null, back = true } = {}) {
  const source = Array.isArray(spec?.regions) ? spec.regions : [];
  const regions = [];
  const sourceToMenu = new Map();
  source.forEach((region, index) => {
    if (!region || !Array.isArray(region.destinations) || region.destinations.length === 0) return;
    sourceToMenu.set(index, regions.length);
    regions.push(region);
  });
  if (regions.length === 0) {
    player.sendMessage(Common.message("noDestinations"));
    return false;
  }
  const direct = Number.isInteger(regionIndex);
  const menuRegionIndex = direct ? sourceToMenu.get(regionIndex) : null;
  if (direct && menuRegionIndex === undefined) {
    player.sendMessage(Common.message("noDestinations"));
    return false;
  }
  const id = nextMenuId++;
  if (nextMenuId > 2_147_483_647) nextMenuId = 1;
  const state = {
    id,
    key: typeof spec.key === "string" ? spec.key : null,
    title: typeof spec.title === "string" ? spec.title : "Teleport",
    regions,
    stage: direct ? "destinations" : "regions",
    regionIndex: direct ? menuRegionIndex : null,
    page: 0,
    regionPage: 0,
    back: back === true,
  };
  teleportMenus.set(player, state);
  sendMenuScreen(player, state);
  return true;
}

/** A list of exact destinations with no region stage (an item option that already names its list). */
function openDestinations(player, { key = null, title, destinations: list, back = false }) {
  return openMenu(player, {
    key,
    title,
    regions: [{ label: title, destinationTitle: title, destinations: Array.isArray(list) ? list : [] }],
  }, { regionIndex: 0, back });
}

function requestMenuPage(player, state, page) {
  const list = selectedRegion(state)?.destinations ?? state.regions;
  const pages = menuPageCount(list.length);
  if (!Number.isInteger(page) || page < 0 || page >= pages) {
    menuError(player, state, "That page is not available.");
    return;
  }
  state.page = page;
  sendMenuScreen(player, state);
}

function requestMenuRegion(player, state, index) {
  if (state.stage !== "regions" || !Number.isInteger(index) || !state.regions[index]) {
    menuError(player, state, "That region is not available.");
    return;
  }
  const region = state.regions[index];
  if (menuLocked(region)) {
    menuError(player, state, menuReason(region));
    return;
  }
  state.regionPage = state.page;
  state.stage = "destinations";
  state.regionIndex = index;
  state.page = 0;
  sendMenuScreen(player, state);
}

function requestMenuDestination(player, state, index) {
  const region = selectedRegion(state);
  if (!region || !Number.isInteger(index) || !region.destinations[index]) {
    menuError(player, state, "That teleport is not available.");
    return;
  }
  const destination = region.destinations[index];
  if (menuLocked(destination)) {
    menuError(player, state, menuReason(destination));
    return;
  }
  if (typeof destination.choose !== "function") {
    menuError(player, state, "That teleport is not available.");
    return;
  }
  if (destination.choose() === false) {
    menuError(player, state, "That teleport could not be completed. See chat for details.");
    return;
  }
  teleportMenus.delete(player);
  sendMenuPacket(player, { type: "close", session: state.id });
}

function receiveMenuMessage(event) {
  if (event?.channel !== TELEPORT_MENU_CHANNEL) return;
  // Every teleport relic attaches the shared handler to its own plugin API.
  if (event.handled) return;
  event.handled = true;
  const { player } = event;
  const data = event.data && typeof event.data === "object" && !Array.isArray(event.data) ? event.data : {};
  const state = teleportMenus.get(player);
  if (data.type === "close") {
    const session = Number.isInteger(data.session) ? data.session : state?.id ?? 0;
    if (!state || data.session === state.id) {
      teleportMenus.delete(player);
      sendMenuPacket(player, { type: "close", session });
    }
    return;
  }
  if (!state || !Number.isInteger(data.session) || data.session !== state.id) {
    if (state) sendMenuScreen(player, state);
    return;
  }
  if (data.type === "region") requestMenuRegion(player, state, data.index);
  else if (data.type === "destination") requestMenuDestination(player, state, data.index);
  else if (data.type === "page") requestMenuPage(player, state, data.page);
  else if (data.type === "back") {
    if (state.stage !== "destinations" || state.back !== true) {
      menuError(player, state, "There is no previous menu.");
      return;
    }
    state.stage = "regions";
    state.regionIndex = null;
    state.page = state.regionPage;
    sendMenuScreen(player, state);
  } else {
    menuError(player, state, "That menu action is not available.");
  }
}

/** The menu's plugin-message handler, once per api (every teleport relic attaches it). */
function attachMenu(api) {
  if (menuApis.has(api)) return;
  menuApis.add(api);
  api.onCustomEvent("network:plugin-message", receiveMenuMessage);
  api.onCustomEvent("interface:opened", closeMenuForInterface);
  api.onPlayerLogout(forgetMenu);
}

function forgetMenu({ player }) {
  teleportMenus.delete(player);
}

/** Another interface taking the screen ends the menu, so its keys and clicks do not keep it open. */
function closeMenuForInterface({ player }) {
  const state = teleportMenus.get(player);
  if (!state) return;
  teleportMenus.delete(player);
  sendMenuPacket(player, { type: "close", session: state.id });
}

/** Asks an owner for a list (`{ ...request, list: [] }`) and returns it. */
function ask(name, request = {}) {
  const query = { ...request, list: [] };
  Common.api.emitCustomEvent(name, query);
  return query.list;
}

/** NPC spawns with this name, one per tile (data/definitions/npc-spawns.json). */
function spawnsNamed(name) {
  const spawns = require("../../../data/definitions/npc-spawns.json");
  const all = Array.isArray(spawns) ? spawns : spawns.spawns ?? Object.values(spawns);
  const seen = new Set();
  return all.filter((spawn) => {
    if (spawn?.name !== name) return false;
    const key = `${spawn.x},${spawn.y},${spawn.level ?? 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The worn options' submenus (cache params): the first entry at 661 + op, later ones at 2066 + op + 8 * n. */
const WORN_OPTION_CLICK = 2;
const WORN_SUBOP_FIRST = 661;
const WORN_SUBOP_BASE = 2066;
const WORN_SUBOP_STEP = 8;

/** The submenu entry an item click came from (the cache's subops carried, its params worn), or null. */
function subOption(event) {
  if (!Number.isInteger(event.subOpId) || event.subOpId <= 0) return null;
  const { CacheDefinitions, Equipment } = Common.core;
  const definition = CacheDefinitions.getItem(event.itemId);
  const sub = event.subOpId - 1;
  if (event.interfaceId === Equipment.INVENTORY_INTERFACE_ID) {
    const op = event.clickType - WORN_OPTION_CLICK;
    const params = definition?.params;
    if (op < 0 || !params?.get) return null;
    if (sub === 0) return params.get(WORN_SUBOP_FIRST + op) ?? params.get(WORN_SUBOP_BASE + op) ?? null;
    return params.get(WORN_SUBOP_BASE + op + WORN_SUBOP_STEP * sub) ?? null;
  }
  return definition?.subops?.[event.clickType - 1]?.[sub] ?? null;
}

/**
 * A Demonic Pacts item's destinations by league area (data `areas`: [{ name, region?, area,
 * destinations: [{ name, label?, x, y, z, level?, quest? }] }], `name` the item's submenu entry,
 * `region` the area's name on the menu and `label` the destination's where live's differs, `area`
 * the league's area id), in the browser menu: Teleport lists the areas under `title` (or its area
 * submenu, the cache's subops,
 * goes straight to one), an area lists its destinations under `areaTitle(name)` with Back, and
 * Last-destination repeats the last. An area not unlocked, or a destination the character can't
 * take, is locked with its reason, and picking it gives the refusal. A destination needs its area
 * unlocked (and its tile's: `areaOpen`) and its `quest` completed (`quest:is-complete` by name;
 * unanswered, no bar); its Agility `level` is the shortcut's own, not the teleport's (Wiki:
 * "teleporting to a shortcut does not require you to have the Agility level to use it"). Any
 * Wilderness level, with the league's area-teleport cast, or the item's own `cast` (a cast
 * definition), and with `lastVarp` the varp sent the destination's packed tile as the cast starts.
 */
function areaTeleports({ key, title, areaTitle = (name) => name, areas, cast = true, lastVarp = null }) {
  const byName = new Map(areas.flatMap((area) => area.destinations.map((destination) => [destination.name, { area, destination }])));
  const regionName = (area) => area.region ?? area.name;

  function refusal(player, area, destination) {
    if (!areaUnlocked(player, area.area)) return Common.message("areaLocked");
    if (destination?.quest !== undefined) {
      const query = { player, name: destination.quest, complete: null };
      Common.api.emitCustomEvent("quest:is-complete", query);
      if (query.complete === false) return Common.message("questNeeded", { quest: destination.quest });
    }
    return null;
  }

  function choose(player, area, destination) {
    const refused = refusal(player, area, destination);
    if (refused) {
      player.sendMessage(refused);
      return false;
    }
    const location = new Common.core.Location(destination.x, destination.y, destination.z ?? 0);
    // The varp holds the tile as live packs one: plane << 28 | x << 14 | y.
    const remember = () => lastVarp !== null
      && player.getPacketSender().sendConfig(lastVarp, ((location.getZ() << 28) | (location.getX() << 14) | location.getY()) >>> 0);
    return go(player, key, { label: destination.name, location }, { cast, onStart: remember });
  }

  function menuSpec(player) {
    return {
      key,
      title,
      regions: areas.map((area) => {
        const regionRefusal = refusal(player, area, null);
        return {
          label: regionName(area),
          destinationTitle: areaTitle(regionName(area)),
          locked: regionRefusal !== null,
          ...(regionRefusal !== null ? { reason: regionRefusal } : {}),
          destinations: area.destinations.map((destination) => {
            const reason = refusal(player, area, destination);
            return {
              label: destination.label ?? destination.name,
              locked: reason !== null,
              ...(reason !== null ? { reason } : {}),
              choose: () => choose(player, area, destination),
            };
          }),
        };
      }),
    };
  }

  function teleport(event) {
    const picked = subOption(event);
    const area = picked === null ? null : areas.find((entry) => entry.name === picked);
    if (area) {
      const refused = refusal(event.player, area, null);
      if (refused) {
        event.player.sendMessage(refused);
        return false;
      }
      return openMenu(event.player, menuSpec(event.player), { regionIndex: areas.indexOf(area), back: true });
    }
    return openMenu(event.player, menuSpec(event.player));
  }

  function last(event) {
    const { player } = event;
    const saved = player.getAttribute(lastAttribute(key));
    const found = saved ? byName.get(saved.label) : undefined;
    if (!found) {
      player.sendMessage(Common.message("noLastDestination"));
      return false;
    }
    return choose(player, found.area, found.destination);
  }

  return { teleport, last, choose };
}

module.exports = {
  unlockedAreas, areaOpen, areaUnlocked, landing, reach, go, goLast, itemCast, openMenu, openDestinations, attachMenu, ask, spawnsNamed, lastAttribute, subOption, areaTeleports,
  TELEPORT_MENU_CHANNEL, MENU_PAGE_SIZE,
  ANY_WILDERNESS_LEVEL,
};
