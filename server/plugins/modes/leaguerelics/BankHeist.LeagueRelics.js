/**
 * Bank Heist (https://oldschool.runescape.wiki/w/Bank_Heist_(Raging_Echoes_League)), Raging Echoes'
 * tier 3 relic: the Banker's briefcase teleports to any bank, bank chest or deposit box (every one
 * in the cache's map, plugins/modes/data/league-bank-heist.json, generated), in unlocked areas,
 * from any Wilderness level; Last-destination repeats the last.
 *
 * The cache gives the banks no names: each is named after the nearest place a teleport knows (a
 * fairy ring, jewellery or spell destination, within 40 tiles; else a fairy ring's region, within
 * 150, with the bank's tile; else its kind and tile; ours), and the menu lists those in
 * unlocked areas, grouped by the league's area when the area unlocks answer (banks outside every
 * area as Other), else in alphabetical runs (ours). Not here: the
 * Wiki's quest gates on some banks (Sophanem, Keldagrim and others): the league's areas decide.
 */
const Common = require("./Common.LeagueRelics");
const Teleports = require("./Teleports.LeagueRelics");
const DATA = require("../data/league-bank-heist.json");

const KEY = "bankers-briefcase";
/** How far a place's name reaches (tiles): near enough not to name another town's bank. */
const NAME_REACH = 40;
const KINDS = { bank: "bank", "bank chest": "bank chest", "deposit box": "deposit box" };

let effect;
let named = null;

function active(player) {
  return Common.effectActive(player, effect);
}

/** How far a fairy ring's region name reaches when no place is near (tiles). */
const REGION_REACH = 150;
/** The fairy rings' catch-all regions, which name no one place. */
const VAGUE_REGIONS = new Set(["islands", "dungeons", "other realms"]);

/** Every named place the teleports know, as { name, x, y, z }, and the fairy rings' regions. */
function places(player) {
  const list = [];
  const regions = [];
  const add = (name, location, into = list) => {
    if (name && location) into.push({ name, x: location.getX(), y: location.getY(), z: location.getZ() });
  };
  for (const ring of Teleports.ask("fairy-rings:destinations")) {
    const [region, place] = ring.name.includes(":") ? ring.name.split(":").map((part) => part.trim()) : [null, ring.name.trim()];
    add(place, ring.location);
    if (region && !VAGUE_REGIONS.has(region.toLowerCase())) add(region, ring.location, regions);
  }
  for (const destination of Teleports.ask("construction:jewellery-box-destinations", { player })) add(destination.label, destination.location);
  for (const unit of ["SpellTeleports", "LunarSpells", "ArceuusSpells"]) {
    for (const spell of Common.core[unit]?.getTeleportDestinations?.() ?? []) {
      if (spell.destination && spell.name !== "teleport to house") {
        add(spell.name.replace(/ teleport$/i, "").replace(/^teleport to /i, "").replace(/\b\w/g, (letter) => letter.toUpperCase()), spell.destination);
      }
    }
  }
  return { list, regions };
}

/** The nearest of `candidates` within `reach` of the bank, or null. */
function nearest(candidates, bank, reach) {
  // Any plane; an underground bank (6,400 tiles north on the map) is named after the surface above it.
  const surfaceY = bank.y >= 9000 ? bank.y - 6400 : bank.y;
  let best = null;
  for (const place of candidates) {
    const distance = Math.hypot(place.x - bank.x, Math.min(Math.abs(place.y - bank.y), Math.abs(place.y - surfaceY)));
    if (distance <= reach && (!best || distance < best.distance)) best = { place, distance };
  }
  return best?.place ?? null;
}

/** The banks, named once (the places named are the same for everyone). */
function banks(player) {
  if (named) return named;
  const { Location } = Common.core;
  const known = places(player);
  // Named only once the teleports answer (a fairy ring at least), so a half-built list isn't kept.
  const final = known.list.length > 0;
  const counts = new Map();
  named = DATA.banks.map((bank) => {
    const place = nearest(known.list, bank, NAME_REACH);
    const region = place ? null : nearest(known.regions, bank, REGION_REACH);
    const kind = KINDS[bank.kind];
    const base = place ? `${place.name} ${kind}` : region ? `${region.name} ${kind} (${bank.x}, ${bank.y})`
      : `${kind[0].toUpperCase()}${kind.slice(1)} (${bank.x}, ${bank.y})`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return { label: base, location: new Location(bank.x, bank.y, bank.z), count };
  }).map((bank) => ({ label: counts.get(bank.label) > 1 ? `${bank.label} ${bank.count}` : bank.label, location: bank.location }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const list = named;
  if (!final) named = null;
  return list;
}

/** The league area's name of a tile, or null. */
function areaName(player, location) {
  const at = { player, x: location.getX(), y: location.getY(), area: null, name: null };
  Common.api.emitCustomEvent("league:area-at", at);
  return at.area ? at.name ?? String(at.area) : null;
}

/** [group label, banks]: by league area (Other for banks outside every area), else alphabetical runs of about a menu page each. */
function groups(player, list) {
  const byArea = new Map();
  let anyArea = false;
  for (const bank of list) {
    const name = areaName(player, bank.location);
    if (name) anyArea = true;
    const key = name ?? "Other";
    if (!byArea.has(key)) byArea.set(key, []);
    byArea.get(key).push(bank);
  }
  if (anyArea) return [...byArea].sort(([a], [b]) => (a === "Other") - (b === "Other") || a.localeCompare(b));
  const runs = [];
  const size = Math.ceil(list.length / 8);
  const word = (bank) => bank.label.split(/[ (]/)[0];
  for (let start = 0; start < list.length; start += size) {
    const run = list.slice(start, start + size);
    const [first, last] = [word(run[0]), word(run.at(-1))];
    runs.push([first === last ? first : `${first} to ${last}`, run]);
  }
  return runs;
}

function teleport(player) {
  const list = banks(player).filter((bank) => Teleports.areaOpen(player, bank.location));
  Teleports.openMenu(player, {
    key: KEY,
    title: Common.message("bankHeistTitle"),
    regions: groups(player, list).map(([label, run]) => ({
      label,
      destinationTitle: Common.message("bankHeistTitle"),
      destinations: run.map((bank) => ({
        label: bank.label,
        choose: () => Teleports.go(player, KEY, bank),
      })),
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
  effect = Common.data.effects.bankHeist;
  Teleports.attachMenu(api);
  api.persistAttribute(Teleports.lastAttribute(KEY), null);
  api.onItemAction(effect.toolName, {
    Teleport: only(teleport),
    "Last-destination": only((player) => Teleports.goLast(player, KEY)),
  });
};

module.exports._test = { banks, groups, reset: () => { named = null; } };
