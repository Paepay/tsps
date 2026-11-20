/**
 * Fairy's Flight (https://oldschool.runescape.wiki/w/Fairy's_Flight_(Raging_Echoes_League)),
 * Trailblazer Reloaded's tier 2 and Raging Echoes' tier 3 relic: the fairy mushroom teleports to
 * any fairy ring (by its code), spirit tree (those the character could travel to by tree) or tool
 * leprechaun, in unlocked areas, from the Wilderness too except to a spirit tree (Wiki, Fairy
 * mushroom); Last-destination repeats the last. The cache's options: Teleport and
 * Last-destination carried; Fairy-Ring, Spirit-tree, Tool-leprechauns and Last-destination worn.
 * Not here: the Tree Gnome Village autocompletion (the quests' own completion, not a relic's).
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");

const KEY = "fairy-mushroom";
/** Spirit trees keep their own Wilderness rule (Wiki: "except spirit tree locations"). */
const SPIRIT_TREE_WILDERNESS_LEVEL = 20;
/** The same region order as the Nexus and the Level-Up region map. */
const AREA_ORDER = [1, 2, 3, 4, 5, 6, 7, 8, 11, 20, 21];

let effect;
let leprechauns = null;

function active(player) {
  return Common.effectActive(player, effect);
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

/** Destinations grouped by the base region they land in, in the shared region order. */
function regionGroups(player, destinations) {
  const regions = new Map();
  for (const destination of destinations) {
    const at = areaAt(destination.location);
    const key = at.area === null ? "other" : at.area;
    if (!regions.has(key)) regions.set(key, { area: at.area, name: at.name, destinations: [] });
    regions.get(key).destinations.push(destination);
  }
  const unlocked = Teleports.unlockedAreas(player);
  return [...regions.values()]
    .sort(compareAreas)
    .map((region) => {
      const counts = new Map();
      for (const destination of region.destinations) {
        counts.set(destination.label, (counts.get(destination.label) ?? 0) + 1);
      }
      region.destinations.sort((a, b) => a.label.localeCompare(b.label) || a.kind.localeCompare(b.kind));
      const locked = region.area !== null && unlocked !== null && !unlocked.includes(region.area);
      return {
        label: region.name,
        destinationTitle: region.name,
        locked,
        ...(locked ? { reason: Common.message("areaLocked") } : {}),
        destinations: region.destinations.map((destination) => ({
          label: counts.get(destination.label) > 1
            ? `${destination.label} (${destination.kind})`
            : destination.label,
          choose: destination.choose,
        })),
      };
    });
}

function ringDestinations(player) {
  return Teleports.ask("fairy-rings:destinations").map((ring) => {
    const label = `${ring.code} ${ring.name}`.trim();
    return {
      kind: "fairy ring",
      label,
      location: ring.location,
      choose: () => Teleports.go(player, KEY, { label, location: ring.location }),
    };
  });
}

function treeDestinations(player) {
  return Teleports.ask("spirit-trees:destinations", { player }).map((tree) => ({
    kind: "spirit tree",
    label: tree.name,
    location: tree.location,
    choose: () => Teleports.go(player, KEY, {
      label: tree.name, location: tree.location, wildernessLevel: SPIRIT_TREE_WILDERNESS_LEVEL,
    }),
  }));
}

/** The tool leprechauns, each named after the nearest fairy ring (ours: they have no names of their own). */
function leprechaunList() {
  if (leprechauns) return leprechauns;
  const { Location } = Common.core;
  const ringList = Teleports.ask("fairy-rings:destinations");
  leprechauns = Teleports.spawnsNamed("Tool Leprechaun").map((spawn) => {
    const location = new Location(spawn.x, spawn.y, spawn.level ?? 0);
    const nearest = ringList.reduce((best, ring) => {
      const distance = Math.hypot(ring.location.getX() - spawn.x, ring.location.getY() - spawn.y);
      return !best || distance < best.distance ? { ring, distance } : best;
    }, null);
    const place = nearest?.ring.name.split(":").pop().trim() || `${spawn.x}, ${spawn.y}`;
    return { label: Common.message("leprechaunNear", { place }), location };
  }).sort((a, b) => a.label.localeCompare(b.label));
  return leprechauns;
}

function leprechaunDestinations(player) {
  return leprechaunList().map((destination) => ({
    kind: "tool leprechaun",
    label: destination.label,
    location: destination.location,
    choose: () => Teleports.go(player, KEY, destination),
  }));
}

function open(player, title, destinations) {
  Teleports.openMenu(player, { key: KEY, title, regions: regionGroups(player, destinations) });
}

function rings(player) {
  open(player, Common.message("fairyRingsTitle"), ringDestinations(player));
}

function trees(player) {
  open(player, Common.message("spiritTreesTitle"), treeDestinations(player));
}

function tools(player) {
  open(player, Common.message("leprechaunsTitle"), leprechaunDestinations(player));
}

function teleport({ player }) {
  if (!active(player)) return;
  open(player, Common.message("fairyMushroomTitle"), [
    ...ringDestinations(player),
    ...treeDestinations(player),
    ...leprechaunDestinations(player),
  ]);
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
  effect = Common.data.effects.fairysFlight;
  Teleports.attachMenu(api);
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Teleport: only((player) => teleport({ player })),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
    "Fairy-Ring": only(rings),
    "Spirit-tree": only(trees),
    "Tool-leprechauns": only(tools),
  });
};
