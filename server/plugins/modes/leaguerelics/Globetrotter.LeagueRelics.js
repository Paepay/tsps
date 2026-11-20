/**
 * Globetrotter (https://oldschool.runescape.wiki/w/Globetrotter), Trailblazer Reloaded's tier 2
 * relic: the Globetrotter pendant's Nexus teleports to the spellbooks' teleport spells (the four
 * books', and the house when the character has one), its Jewellery to the ornate jewellery box's
 * destinations, both in unlocked areas, no higher than level 20 Wilderness (30 for a dragonstone
 * piece's destination, its last destination included: Wiki, 6 December 2023); Last-destination
 * repeats the last. No runes, charges or cooldown.
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const KEY = "globetrotter-pendant";
const WILDERNESS_LEVEL = 20;
const BOOKS = [["SpellTeleports", null], ["LunarSpells", "Lunar"], ["ArceuusSpells", "Arceuus"]];
/** The Nexus groups teleports by where they land, in the same order as the league area data. */
const AREA_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 11, 20, 21];

let effect;

function active(player) {
  return Common.effectActive(player, effect);
}

function title(name) {
  return name.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** The tile's base league area, independent of a character's unlocked areas. */
function areaAt(location) {
  const query = { base: true, x: location.getX(), y: location.getY(), area: null, name: null };
  Common.api.emitCustomEvent("league:area-at", query);
  const area = Number.isInteger(query.area) ? query.area : null;
  return { area, name: area === null ? "Other" : (query.name || "Other") };
}

/** Known league areas first, in data order; an unknown area next, and tiles outside every area last. */
function compareAreas(a, b) {
  const left = AREA_ORDER.indexOf(a.area);
  const right = AREA_ORDER.indexOf(b.area);
  if (left >= 0 && right >= 0) return left - right;
  if (left >= 0) return -1;
  if (right >= 0) return 1;
  if (a.area === null && b.area !== null) return 1;
  if (b.area === null && a.area !== null) return -1;
  if (a.area !== null && b.area !== null) return a.area - b.area || a.name.localeCompare(b.name);
  return 0;
}

/** The Nexus menu: destinations grouped by where they land, not by the spellbook they came from. */
function nexusRegions(player) {
  const spells = [];
  for (const [unit, fallback] of BOOKS) {
    const destinations = Common.core[unit]?.getTeleportDestinations?.() ?? [];
    for (const spell of destinations) {
      if (!spell.destination || spell.name === "teleport to house") continue;
      const book = fallback ?? (spell.spellbook === Common.core.MagicSpellbook?.ANCIENT ? "Ancient" : "Standard");
      spells.push({ label: title(spell.name), book, location: spell.destination });
    }
  }
  const owns = { player, owns: false };
  Common.api.emitCustomEvent("construction:owns-house", owns);
  const house = { player, option: "inside", destination: null, onArrival: null };
  if (owns.owns === true) Common.api.emitCustomEvent("construction:house-tablet", house);
  if (house.destination) {
    spells.push({ label: "Teleport To House", book: "Standard", location: house.destination, onArrival: house.onArrival, remember: false });
  }

  const regions = new Map();
  for (const spell of spells) {
    const area = areaAt(spell.location);
    const key = area.area === null ? "other" : area.area;
    if (!regions.has(key)) regions.set(key, { area: area.area, name: area.name, destinations: [] });
    regions.get(key).destinations.push(spell);
  }

  const unlocked = Teleports.unlockedAreas(player);
  return [...regions.values()]
    .sort(compareAreas)
    .map((region) => {
      const counts = new Map();
      for (const spell of region.destinations) counts.set(spell.label, (counts.get(spell.label) ?? 0) + 1);
      region.destinations.sort((a, b) => a.label.localeCompare(b.label) || a.book.localeCompare(b.book));
      const locked = region.area !== null && unlocked !== null && !unlocked.includes(region.area);
      return {
        label: region.name,
        destinationTitle: region.name,
        locked,
        ...(locked ? { reason: Common.message("areaLocked") } : {}),
        destinations: region.destinations.map((spell) => ({
          label: counts.get(spell.label) > 1 ? `${spell.label} (${spell.book})` : spell.label,
          choose: () => Teleports.go(player, KEY, spell, { wildernessLevel: WILDERNESS_LEVEL, onArrival: spell.onArrival }),
        })),
      };
    });
}

function nexus(player) {
  Teleports.openMenu(player, {
    key: KEY,
    title: Common.message("nexusTitle"),
    regions: nexusRegions(player),
  });
}

function jewellery(player) {
  const list = Teleports.ask("construction:jewellery-box-destinations", { player });
  Teleports.openDestinations(player, {
    key: KEY,
    title: Common.message("jewelleryTitle"),
    destinations: list.map((destination) => ({
      label: destination.label,
      choose: () => Teleports.go(player, KEY, destination, { wildernessLevel: WILDERNESS_LEVEL }),
    })),
  });
}

/** An option's handler for the relic's owner; anyone else's click goes on to the game's own (false). */
function only(fn) {
  return (event) => {
    if (!active(event.player)) return false;
    event.handled = true;
    fn(event.player);
  };
}

module.exports = function attach(api) {
  effect = Common.data.effects.globetrotter;
  Teleports.attachMenu(api);
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Nexus: only(nexus),
    Jewellery: only(jewellery),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
  });
};
