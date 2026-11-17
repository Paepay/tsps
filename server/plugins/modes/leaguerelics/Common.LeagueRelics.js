/**
 * Shared by the LeagueRelics units: the data (league-relics.json, plus leagues.json for each
 * league's name, colour and unlock graphic), a character's league (LeagueMode's `league:profile`),
 * its chosen relics and points, and the catalog lookups.
 */
const fs = require("fs");
const path = require("path");
const WorldCatalog = require("./WorldCatalog.LeagueRelics");
const PassivesCatalog = require("./PassivesCatalog.LeagueRelics");

/** Chosen relics: tier index (0-7) -> slot (1-3). */
const RELICS_ATTRIBUTE = "league:relics";
/** world.json pluginConfig: whether this world's relic system is on (default true, so old worlds keep it). */
const RELICS_CONFIG = "league:relics";
/** world.json pluginConfig: the world's 1-8 tiers of 2-3 canonical relic ids. */
const RELIC_TIERS_CONFIG = "league:relic-tiers";
/** world.json pluginConfig: the world's passive grants for each relic tier, as canonical ids. */
const PASSIVE_TIERS_CONFIG = "league:passive-tiers";

let api = null;
let core = null;
let data = null;
let leagues = null;

/**
 * The world's relic configuration, resolved once while plugins load (the same point at which
 * the league profile and catalog are read). `custom` is the complete validated catalog for
 * the world's base league, or null for the league's own catalog / an invalid configuration.
 */
let world = {
  baseLeague: null,
  relicsEnabled: true,
  status: "default",
  custom: null,
  configuredTiers: null,
  error: null,
  warnings: [],
};

/** The resolved tier-passive catalog and the world's own rows (or its league's defaults). */
let passives = {
  catalog: { entries: [], byId: new Map() },
  world: {
    baseLeague: null,
    status: "default",
    custom: null,
    configuredTiers: null,
    error: null,
    warnings: [],
  },
};

function init(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  const dir = path.join(__dirname, "..", "data");
  data = JSON.parse(fs.readFileSync(path.join(dir, "league-relics.json"), "utf8"));
  leagues = JSON.parse(fs.readFileSync(path.join(dir, "leagues.json"), "utf8")).leagues;
  reloadWorldCatalog();
}

/** The league this world runs, or null for a plain world (LeagueMode reads the same key). */
function worldLeagueType() {
  const relicLeague = Number(api?.getPluginConfig?.("league:relic-league", 0));
  const type = [4, 5, 6].includes(relicLeague)
    ? relicLeague
    : Number(api?.getPluginConfig?.("league:type", 0));
  return data.leagues[type] && leagues[type] ? type : null;
}

/** Re-read the world's relic settings; start-up calls this once, tests may call it again. */
function reloadWorldCatalog() {
  const baseLeague = worldLeagueType();
  const relicsEnabled = api?.getPluginConfig?.(RELICS_CONFIG, true) !== false;
  const raw = api?.getPluginConfig?.(RELIC_TIERS_CONFIG, null);
  const catalogs = {};
  for (const type of WorldCatalog.SOURCE_LEAGUES) {
    try {
      catalogs[type] = sourceCatalog(type);
    } catch (error) {
      catalogs[type] = null;
      if (baseLeague === type) api?.log?.(`[league-relics] league ${type}'s catalog is unavailable: ${error.message}`);
    }
  }
  const result = WorldCatalog.buildWorldCatalog({
    raw,
    baseLeague,
    baseTiers: catalogs[baseLeague]?.tiers ?? [],
    catalogs,
  });
  const leagueEffects = Object.fromEntries(WorldCatalog.SOURCE_LEAGUES
    .map((type) => [type, leagues[type]?.passives ?? {}]));
  const passiveResult = PassivesCatalog.buildWorldPassives({
    raw: api?.getPluginConfig?.(PASSIVE_TIERS_CONFIG, null),
    baseLeague,
    baseTiers: catalogs[baseLeague]?.tiers ?? [],
    catalogs,
    leagueEffects,
    relicTierCount: result.status === "custom" ? result.tiers.length : null,
  });
  world = {
    baseLeague,
    relicsEnabled,
    status: !relicsEnabled ? "disabled" : result.status,
    custom: relicsEnabled && result.status === "custom" ? { ...result, custom: true } : null,
    configuredTiers: result.status === "default" ? null : (result.canonicalTiers ?? null),
    error: result.error ?? null,
    warnings: result.warnings ?? [],
  };
  passives = {
    catalog: passiveResult.catalog ?? { entries: [], byId: new Map() },
    world: {
      baseLeague,
      status: !relicsEnabled ? "disabled" : passiveResult.status,
      custom: relicsEnabled && passiveResult.status === "custom"
        ? { ...passiveResult, custom: true }
        : null,
      configuredTiers: passiveResult.status === "default" || passiveResult.status === "invalid"
        ? null : (passiveResult.ids ?? null),
      error: passiveResult.error ?? null,
      warnings: passiveResult.warnings ?? [],
    },
  };
  if (result.status === "invalid" && relicsEnabled) {
    api?.log?.(`[league-relics] ${result.error}; keeping league ${baseLeague}'s own relic catalog`);
  } else if (world.custom) {
    api?.log?.(`[league-relics] world catalog: ${world.custom.tiers.length} tier(s) from leagues `
      + `${[...new Set(world.custom.ids.map((id) => id.split(":")[0]))].join(", ")}`);
  }
  if (passiveResult.status === "invalid" && relicsEnabled) {
    api?.log?.(`[league-passives] ${passiveResult.error}; keeping league ${baseLeague}'s own tier passives`);
  } else if (passives.world.custom) {
    api?.log?.(`[league-passives] world passives: ${passives.world.custom.entries.length} grant(s) across `
      + `${passives.world.custom.tiers.length} tier(s)`);
  }
  return world;
}

/** The league a character is in (its type), or null for a main character. */
function leagueOf(player) {
  if (!api || !player) return null;
  const query = { player, league: null };
  api.emitCustomEvent("league:profile", query);
  // Level-Up worlds reuse relic effects and catalogs without becoming a full
  // seasonal league profile (tasks and league saves stay disabled; tier passives
  // are applied by Passives.LeagueMode when level-up:relic-profile sets active).
  if (query.league === null) api.emitCustomEvent("level-up:relic-profile", query);
  const type = query.league;
  return type !== null && data.leagues[type] && leagues[type] ? Number(type) : null;
}

/**
 * Level-Up owns its relic choices through skill milestones. Its interface reuses this
 * catalog and the same 655 widgets, so the seasonal interface must not also act on them.
 */
function levelUpOwns(player) {
  if (!player || !api) return false;
  const query = { player, active: false };
  api.emitCustomEvent("level-up:relic-profile", query);
  return query.active === true;
}

/** Catalogs built from the cache (data `fromCache`), by league type. */
const cacheCatalogs = new Map();

function slug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function enumEntries(id) {
  return [...core.CacheDefinitions.getEnumValues(id).entries()].sort(([a], [b]) => a - b);
}

/**
 * The current league's catalog as the cache holds it: the league struct's tier enum, each tier's
 * cost, passive struct and relic enum, each relic's name and description (the params the relic
 * interface reads). A relic struct naming an item (Demonic Pacts' `relicItemParam`, 2049) hands
 * it out, and like every item relic is unlocked in a bank (the captured rule, 237/01102).
 */
function catalogFromCache(type) {
  const { params } = data;
  const { CacheDefinitions } = core;
  const leagueParams = CacheDefinitions.getStructParams(league(type).struct);
  const itemParam = cacheLeague(type)?.relicItemParam;
  const tiers = enumEntries(leagueParams.get(params.tiersEnum)).map(([, tierStruct]) => {
    const tierParams = CacheDefinitions.getStructParams(tierStruct);
    const passiveStruct = tierParams.get(params.tierPassive);
    const relics = enumEntries(tierParams.get(params.tierRelics)).map(([, relicStruct]) => {
      const relicParams = CacheDefinitions.getStructParams(relicStruct);
      const name = String(relicParams.get(params.relicName) ?? "");
      const item = itemParam === undefined ? undefined : relicParams.get(itemParam);
      const grants = Number.isInteger(item) && item > 0 ? [item] : [];
      return {
        key: slug(name), name, description: String(relicParams.get(params.relicDescription) ?? ""),
        grants, requiresBank: grants.length > 0, struct: relicStruct,
      };
    });
    return {
      cost: Number(tierParams.get(params.tierCost)) || 0,
      passive: String(CacheDefinitions.getStructParams(passiveStruct)?.get(params.passiveText) ?? ""),
      relics, struct: tierStruct, passiveStruct,
    };
  });
  // Optional `costs` on a fromCache league (custom worlds) replaces the cache's tier points.
  const costs = data.leagues[type]?.costs;
  if (Array.isArray(costs)) {
    tiers.forEach((tier, index) => {
      if (Number.isFinite(costs[index])) tier.cost = Number(costs[index]);
    });
  }
  return { fromCache: true, tiers };
}

/** The effects entry describing a cache-read league (Demonic Pacts' `demonicPacts`), or null. */
function cacheLeague(type) {
  return Object.values(data.effects).find((entry) => entry?.cacheLeague === true && [].concat(entry.league).includes(Number(type))) ?? null;
}

/** A league's own tiers and relics: the data's, or the cache's own for a league marked `fromCache`. */
function sourceCatalog(type) {
  const row = data.leagues[type];
  if (!row) return null;
  if (!row.fromCache) return row;
  if (!cacheCatalogs.has(type)) cacheCatalogs.set(type, catalogFromCache(type));
  return cacheCatalogs.get(type);
}

/** The catalog the world plays with: its configured mixed catalog, else the league's own. */
function catalog(type) {
  if (world.custom && Number(type) === world.baseLeague) return world.custom;
  return sourceCatalog(type);
}

function isCustomCatalog(type) {
  return world.custom !== null && Number(type) === world.baseLeague;
}

/** The world's relic catalog configuration for the public catalog endpoint. */
function worldCatalogState() {
  const tiers = world.baseLeague === null ? null : catalog(world.baseLeague)?.tiers ?? null;
  return {
    league: world.baseLeague,
    relicsEnabled: world.relicsEnabled,
    status: world.status,
    custom: world.custom !== null,
    tiers: tiers === null ? null : tiers.map((tier) => tier.relics.map((relic) => canonicalIdOf(relic, world.baseLeague))),
    configuredTiers: world.configuredTiers,
    error: world.error,
    warnings: [...world.warnings],
    passives: passivesWorldState(),
  };
}

/** The complete passive catalog (every individual grant from every supported league). */
function passiveCatalog() {
  return passives.catalog.entries;
}

/** The world's passive configuration for the public catalog endpoint. */
function passivesWorldState() {
  return {
    league: passives.world.baseLeague,
    status: passives.world.status,
    custom: passives.world.custom !== null,
    tiers: passives.world.custom?.ids ?? passives.world.configuredTiers,
    configuredTiers: passives.world.configuredTiers,
    error: passives.world.error,
    warnings: [...passives.world.warnings],
  };
}

/** The passives configured for a tier, or the source league's own entries at that original tier. */
function passiveTierEntries(type, tierIndex) {
  if (passives.world.custom) return passives.world.custom.tiers[tierIndex] ?? [];
  return passives.catalog.entries.filter((passive) => passive.sourceLeague === Number(type)
    && passive.originalTier === tierIndex + 1);
}

/** The passive text the client shows for a tier: world rows when configured, else the league's. */
function passiveTierText(type, tierIndex) {
  if (!passives.world.custom) return catalog(type)?.tiers[tierIndex]?.passive ?? "";
  const entries = passives.world.custom.tiers[tierIndex] ?? [];
  if (entries.length === 0) return "There are no passive unlocks for this tier.";
  return entries.map((passive) => `- ${passive.description}`).join("<br><br>");
}

/**
 * The passive grants active for a character: the world's rows up to the highest tier reached, or
 * the source league's own grants at their original tiers. Relics off disables all of them.
 */
function activePassives(player, type = leagueOf(player)) {
  if (!relicsEnabled() || type === null) return [];
  const reached = highestTier(player) + 1;
  if (reached <= 0) return [];
  if (passives.world.custom) {
    return passives.world.custom.entries.filter((passive) => passive.grantTier <= reached);
  }
  return passives.catalog.entries.filter((passive) => passive.compatible
    && passive.sourceLeague === Number(type) && passive.originalTier <= reached);
}

/** The active grants of one effect type, for the effect handlers and audit-friendly queries. */
function activePassiveValues(player, effectType, type = leagueOf(player)) {
  return activePassives(player, type).filter((passive) => passive.effect.type === effectType);
}

/** A relic's source-qualified id. A source catalog's relics belong to the league it came from. */
function canonicalIdOf(relic, fallbackLeague) {
  return relic?.canonicalId ?? WorldCatalog.canonicalId(relic?.sourceLeague ?? fallbackLeague, relic?.key);
}

function relicsEnabled() {
  return world.relicsEnabled;
}

/** Every source catalog that is currently readable, by league type. */
function sourceCatalogs() {
  const catalogs = {};
  for (const type of WorldCatalog.SOURCE_LEAGUES) {
    try {
      catalogs[type] = sourceCatalog(type);
    } catch {
      catalogs[type] = null;
    }
  }
  return catalogs;
}

/** Every relic from every source league, once per canonical id, for the public catalog endpoint. */
function allRelicEntries() {
  return [...WorldCatalog.sourceEntries(sourceCatalogs()).byId.values()];
}

/** Canonical ids a source catalog itself repeats; these cannot be configured unambiguously. */
function ambiguousRelicIds() {
  return WorldCatalog.sourceEntries(sourceCatalogs()).ambiguous;
}

/** The struct ids the relic interface's scripts take for a relic and its tier's passive. */
function structIds(type, tier, slot) {
  const tierRow = catalog(type)?.tiers[tier];
  if (tierRow?.struct !== undefined) {
    return { relicStruct: tierRow.relics[slot - 1]?.struct, passiveStruct: tierRow.passiveStruct };
  }
  const id = ids(type);
  return { relicStruct: id.relicStruct(tier, slot), passiveStruct: id.passiveStruct(tier) };
}

function league(type) {
  return leagues[type] ?? null;
}

function relic(type, tier, slot) {
  return catalog(type)?.tiers[tier]?.relics[slot - 1] ?? null;
}

/** A catalog relic by its platform id (the slug of its name), or null. */
function relicBySlug(type, id) {
  const wanted = slug(id);
  return catalog(type)?.tiers.flatMap((tier) => tier.relics).find((entry) => slug(entry.name) === wanted) ?? null;
}

function chosen(player) {
  const value = player.getAttribute(RELICS_ATTRIBUTE);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function points(player) {
  const query = { player, points: 0, tasks: 0 };
  api.emitCustomEvent("league:points", query);
  return query.points | 0;
}

/** The highest tier index chosen, or -1. */
function highestTier(player) {
  if (!relicsEnabled()) return -1;
  return Object.keys(chosen(player)).reduce((highest, tier) => Math.max(highest, Number(tier)), -1);
}

/** The relics the character picked, with the league each relic came from. */
function pickedRelics(player, type, picks = chosen(player)) {
  const catalogRows = catalog(type)?.tiers;
  if (!Array.isArray(catalogRows)) return [];
  const picked = [];
  for (const [tierValue, slotValue] of Object.entries(picks)) {
    const tier = Number(tierValue);
    const slot = Number(slotValue);
    if (!Number.isInteger(tier) || !Number.isInteger(slot)) continue;
    const relic = catalogRows[tier]?.relics[slot - 1];
    if (!relic) continue;
    picked.push({ tier, slot, relic, sourceLeague: relic.sourceLeague ?? type });
  }
  return picked;
}

/** Whether an effect's key (or an alias) names the relic. */
function namesEffect(effect, key) {
  return key === effect?.key || (effect?.aliases ?? []).includes(key);
}

/** The source league a relic definition came from (a source catalog's own league by default). */
function sourceLeagueOf(relic, fallbackLeague = null) {
  return relic?.sourceLeague ?? fallbackLeague;
}

/** The character's picks plus Reloaded's extra pick, each with the league its definition came from. */
function heldRelicEntries(player, type = leagueOf(player), picks = chosen(player)) {
  if (!relicsEnabled() || type === null) return [];
  const entries = pickedRelics(player, type, picks);
  const extra = reloadedPick(player, type, picks);
  if (extra) {
    const attribute = player.getAttribute(RELOADED_ATTRIBUTE);
    entries.push({
      tier: Number(attribute?.tier),
      slot: Number(attribute?.slot),
      relic: extra,
      sourceLeague: sourceLeagueOf(extra, type),
    });
  }
  return entries;
}

/** Whether the character chose relic `key`; a source league may be required to tell same-key relics apart. */
function hasRelic(player, key, sourceLeague = null) {
  const wanted = sourceLeague === null || sourceLeague === undefined ? null : Number(sourceLeague);
  return heldRelicEntries(player).some((entry) => entry.relic.key === key
    && (wanted === null || entry.sourceLeague === wanted));
}

/** The extra pick Reloaded gives (Raging Echoes' tier 4): { tier, slot } saved beside the tiers' picks. */
const RELOADED_ATTRIBUTE = "league:relics-extra";

/**
 * The character's Reloaded pick, if it holds one from a league the effect supports, else null.
 * In a world catalog its place is the configured tier, so the extra pick may come from any
 * configured tier below it; in a league's own catalog it keeps that league's rule.
 */
function reloadedHolder(player, type, picks = chosen(player)) {
  const effect = data.effects.reloaded;
  if (!effect || type === null) return null;
  const sources = [].concat(effect.league).map(Number);
  return pickedRelics(player, type, picks)
    .find((entry) => entry.relic.key === effect.key && sources.includes(entry.sourceLeague)) ?? null;
}

/** The configured tier holding Reloaded, or -1. */
function reloadedTier(player, type, picks = chosen(player)) {
  return reloadedHolder(player, type, picks)?.tier ?? -1;
}

/** The tiers Reloaded's extra pick may come from: the source league's rule, or the tiers below it. */
function reloadedTiers(effect, type, tier = null) {
  if (isCustomCatalog(type)) {
    return tier === null || tier < 0 ? [] : Array.from({ length: tier }, (_value, index) => index);
  }
  return effect.leagueTiers?.[type] ?? effect.tiers ?? [];
}

/** The relic of the extra pick, while the character holds Reloaded itself; else null. */
function reloadedPick(player, type = leagueOf(player), picks = chosen(player)) {
  const effect = data.effects.reloaded;
  const holder = reloadedHolder(player, type, picks);
  const extra = player.getAttribute(RELOADED_ATTRIBUTE);
  if (!effect || !holder || !extra || !reloadedTiers(effect, type, holder.tier).includes(extra.tier)) return null;
  return relic(type, extra.tier, extra.slot);
}

/**
 * The source leagues of the relics the character holds that implement an effect, restricted to
 * the leagues the effect names. A world catalog may place a relic far from its source league, so
 * this is the relic's own source, never the world's base league. One relic key can exist in more
 * than one league, so callers that need a league-specific rule use `effectSource` (base league
 * first, else the first held source) or `effectSources` (every held source).
 */
function effectSources(player, effect, type = null, picks = null) {
  if (!relicsEnabled() || player?.isPlayer?.() !== true) return [];
  const league = type ?? leagueOf(player);
  if (league === null) return [];
  const held = picks ?? chosen(player);
  const allowed = [].concat(effect?.league ?? []).map(Number);
  const sources = new Set();
  for (const entry of heldRelicEntries(player, league, held)) {
    if (allowed.includes(entry.sourceLeague) && namesEffect(effect, entry.relic.key)) sources.add(entry.sourceLeague);
  }
  return [...sources];
}

function effectActive(player, effect) {
  return effectSources(player, effect).length > 0;
}

/** The league whose variant of an effect applies, or null; the base league wins when both are held. */
function effectSource(player, effect) {
  const type = leagueOf(player);
  const sources = effectSources(player, effect, type);
  if (sources.length === 0) return null;
  return sources.includes(type) ? type : sources[0];
}

/** Virtual struct and enum ids for a league's catalog: the client reads them as if from the cache. */
function ids(type) {
  const base = data.virtualIdBase + Number(type) * 1000;
  return {
    tiersEnum: base,
    tierStruct: (tier) => base + 10 + tier,
    passiveStruct: (tier) => base + 20 + tier,
    relicsEnum: (tier) => base + 30 + tier,
    relicStruct: (tier, slot) => base + 100 + tier * 3 + (slot - 1),
  };
}

/** True while a relic builds a hit derived from another (a splash), so relics that scale hits leave it alone. */
let buildingDerivedHit = false;

/** Runs `build` (which constructs a PendingHit) as a derived hit; see `isBuildingDerivedHit`. */
function derivedHit(build) {
  buildingDerivedHit = true;
  try {
    return build();
  } finally {
    buildingDerivedHit = false;
  }
}

function isBuildingDerivedHit() {
  return buildingDerivedHit;
}

/** The attacker's max hit as combat computes it for a hit (the formulas, the ranged modifiers, a spell's bounds). */
function maxHitFor(attacker, target, combatType) {
  const { CombatType, DamageFormulas, PluginManager } = core;
  if (combatType === CombatType.MAGIC) return DamageFormulas.sourceHitBounds(attacker, combatType, target).maximum;
  const max = DamageFormulas.sourceMaxHit(attacker, combatType);
  return combatType === CombatType.RANGED ? PluginManager.modifyRangedMaxHit(attacker, target, max) : max;
}

/** Whether the bank would take this item (a free slot, or a stack of it already). */
function bankHasRoom(player, itemId) {
  const container = player.getBank(core.Bank.getTabForItem(player, itemId));
  return container.getFreeSlots() > 0 || container.contains(itemId);
}

/** Puts a gathered item straight in the bank when it has room; false leaves it with the player. */
function bank(player, itemId, amount) {
  if (amount <= 0 || !bankHasRoom(player, itemId)) return false;
  player.getBank(core.Bank.getTabForItem(player, itemId)).add(new core.Item(itemId, amount), true);
  return true;
}

/** The item's noted form, or the item itself when it has none. */
function noted(itemId) {
  const definition = core.ItemDefinition.forId(itemId);
  // A note's own link leads back to the item: a note is already noted.
  if (definition?.isNoted?.()) return itemId;
  const note = definition?.getNoteId?.() ?? -1;
  return note > 0 ? note : itemId;
}

/** Whether more than one of the item can sit in one slot: it stacks, or it has a note. */
function multipliable(itemId) {
  return noted(itemId) !== itemId || core.ItemDefinition.forId(itemId)?.isStackable?.() === true;
}

/**
 * Pickpocket loot multiplied `times` and noted (league relics): coins come as coin pouches, so each
 * copy is another pouch; a clue, and an item that neither stacks nor notes, stay as they are (Wiki:
 * Dodgy Deals, "unstackable/unnotable items are not multiplied").
 */
function multipliedLoot(loot, times) {
  const out = [];
  for (const entry of loot) {
    if (entry.clue || !multipliable(entry.id)) {
      out.push(entry);
    } else if (entry.id === core.ItemIdentifiers.COINS) {
      for (let copy = 0; copy < times; copy++) out.push({ ...entry });
    } else {
      out.push({ ...entry, id: noted(entry.id), amount: entry.amount * times });
    }
  }
  return out;
}

/** A potion or an unfinished one, by its name ("Attack potion(3)", "Guam potion (unf)"). */
function isPotion(itemId) {
  const name = core.ItemDefinition.forId(itemId)?.getName?.() ?? "";
  return /\(\d\)$/.test(name) || /\(unf\)$/i.test(name) || /^vial of water$/i.test(name);
}

/** Whether a potion recipe's secondary (its ingredient that is not a potion or a vial) stacks: the production relics leave those alone (Wiki). */
function hasStackableSecondary(recipe) {
  return (recipe?.ingredients ?? []).some(({ id }) => !isPotion(id) && core.ItemDefinition.forId(id)?.isStackable?.() === true);
}

/**
 * A production relic's answer to `skills:actions-per-cycle`: the loop's kind in the relic's
 * `batch` list for that skill makes up to `maxActions` at once (a capped kind, `capped`), else
 * nothing changes. A potion with a stackable secondary is made one at a time.
 */
function batchActions(effect, request) {
  const skill = Object.keys(effect.batch).find((name) => core.Skill[name] === request.skill);
  if (!skill || !effect.batch[skill].includes(request.kind)) return null;
  if (request.kind === "mix" && hasStackableSecondary(request.recipe)) return null;
  return effect.capped?.[request.kind] ?? effect.maxActions;
}

/** Owners whose run is being watched: their last tile and the run ticks counted, one watch each. */
const runWatchers = new WeakMap();

/** The owner's watch for the effect, kept across stops so the tick count survives taking the item off. */
function runWatch(player, effect) {
  let watch = runWatchers.get(player);
  if (!watch || watch.effect !== effect) {
    watch = { effect, itemId: core.ItemIdentifiers[effect.tool], last: null, ticks: 0, looping: false };
    runWatchers.set(player, watch);
  }
  return watch;
}

function wearsRunXpItem(player, watch) {
  return Number.isInteger(watch.itemId) && player.getEquipment()?.contains(watch.itemId) === true;
}

/**
 * One tick of a run-XP item's effect (Sage's greaves, Searing boots): a tick in which the player
 * moved `runStepTiles` tiles on one floor while wearing the item counts, and every `runXpTicks`th
 * pays `runXpBase + floor(Agility level x fraction)` Agility XP, before the league's rates. The
 * base level and the count kept across stops are ours ("roughly every 10 ticks").
 */
function runXpTick(player, effect) {
  const watch = runWatch(player, effect);
  const here = player.getLocation();
  const moved = watch.last && watch.last.getZ() === here.getZ()
    && Math.max(Math.abs(here.getX() - watch.last.getX()), Math.abs(here.getY() - watch.last.getY())) === effect.runStepTiles;
  watch.last = here.clone();
  if (!moved || !effectActive(player, effect) || !wearsRunXpItem(player, watch)) return false;
  if (++watch.ticks < effect.runXpTicks) return false;
  watch.ticks = 0;
  const level = player.getSkillManager().getMaxLevel(core.Skill.AGILITY);
  player.getSkillManager().addExperiences(core.Skill.AGILITY,
    effect.runXpBase + Math.floor((level * effect.runXpLevelFraction[0]) / effect.runXpLevelFraction[1]));
  return true;
}

/** Starts a tick task for the wearer (once) and stops it once the relic or the item no longer applies. */
function watchRunXp(player, effect) {
  if (player?.isPlayer?.() !== true || !effectActive(player, effect)) return false;
  const watch = runWatch(player, effect);
  if (watch.looping || !wearsRunXpItem(player, watch)) return false;
  watch.looping = true;
  const next = () => core.TaskManager.submit(new core.CountdownTask(player, 1, () => {
    if (!player.isRegistered?.() || !effectActive(player, effect) || !wearsRunXpItem(player, watch)) {
      watch.looping = false;
      watch.last = null;
      return;
    }
    runXpTick(player, effect);
    next();
  }));
  next();
  return true;
}

/** Restores special attack energy and redraws the bar. */
function restoreSpecial(player, percent) {
  player.incrementSpecialPercentage(percent);
  core.CombatSpecial.updateBar(player);
}

/** A message's text; a cache-read league's own wording (its entry's `messages`) wins for its characters. */
function message(key, values = {}, type = null) {
  const own = type === null ? undefined : cacheLeague(type)?.messages?.[key];
  return (own ?? data.messages[key].text).replace(/\{(\w+)\}/g, (match, name) => values[name] ?? match);
}

module.exports = {
  init, reloadWorldCatalog, leagueOf, levelUpOwns, catalog, sourceCatalog, sourceCatalogs, isCustomCatalog, worldCatalogState,
  passiveCatalog, passivesWorldState, passiveTierEntries, passiveTierText, activePassives, activePassiveValues,
  allRelicEntries, ambiguousRelicIds, relicBySlug,
  canonicalIdOf, relicsEnabled, league, relic, chosen, points, highestTier, hasRelic, effectActive, effectSource, effectSources,
  heldRelicEntries, sourceLeagueOf, pickedRelics, reloadedPick,
  reloadedHolder, reloadedTier, RELOADED_ATTRIBUTE, RELICS_CONFIG, RELIC_TIERS_CONFIG, PASSIVE_TIERS_CONFIG,
  reloadedTiers, cacheLeague, slug, ids, message,
  maxHitFor, restoreSpecial, bankHasRoom, bank, noted, multipliable,
  multipliedLoot, isPotion, hasStackableSecondary, batchActions, watchRunXp, runXpTick, derivedHit, isBuildingDerivedHit,
  RELICS_ATTRIBUTE, structIds,
  get data() { return data; },
  get api() { return api; },
  get core() { return core; },
};
