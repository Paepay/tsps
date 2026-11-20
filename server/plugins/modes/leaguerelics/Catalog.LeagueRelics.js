/**
 * The relic catalog the client draws. The cache's relic interface reads its league struct's tier
 * enum, tier structs and relic structs, but the cache only carries the current league's, so this
 * answers LeagueMode's `league:content-rows` with a league's own structs and enums (sent as
 * structOverrides / enumOverrides at login and before the interface opens). A league the cache
 * carries (data `fromCache`) needs none unless the world configured a mixed catalog, which always
 * needs overrides, or its data sets `costs` (custom worlds), which override the cache's tier-cost
 * params. Icons are the relic's own source league's sprites, which the cache still carries by name
 * (league_5_relics_tli,3 ...), at the index that source's cache gave.
 */
const Common = require("./Common.LeagueRelics");
const WorldCatalog = require("./WorldCatalog.LeagueRelics");

/** Relic source/icon -> its six icon params, resolved once. */
const iconCache = new Map();

function relicSource(relic, type) {
  return relic?.sourceLeague ?? type;
}

function iconCacheKey(relic, type) {
  return Number.isInteger(relic?.struct)
    ? `struct:${relic.struct}`
    : `sprite:${relicSource(relic, type)}:${relic?.icon}`;
}

/** Each relic's six icon params: its source league's sprite name, the param's suffix and index, or its cache struct's params. */
function iconParams(relic, type) {
  const key = iconCacheKey(relic, type);
  if (iconCache.has(key)) return iconCache.get(key);
  const { CacheDefinitions } = Common.core;
  const params = {};
  if (Number.isInteger(relic?.struct)) {
    const source = CacheDefinitions.getStructParams(relic.struct);
    for (const param of Object.keys(Common.data.params.icons)) {
      const value = source?.get(Number(param));
      if (value !== undefined) params[param] = value;
    }
  } else {
    const source = relicSource(relic, type);
    const iconSprite = Common.sourceCatalog(source)?.iconSprite;
    for (const [param, suffix] of Object.entries(Common.data.params.icons)) {
      if (!iconSprite || !Number.isInteger(relic?.icon)) continue;
      const sprite = CacheDefinitions.getSpriteId(`${iconSprite}${suffix},${relic.icon}`);
      if (sprite !== null) params[param] = sprite;
    }
  }
  iconCache.set(key, params);
  return params;
}

/** A relic's icon information for the website: its source sprite, index and the six cache param ids. */
function iconDetails(relic, type) {
  const source = relicSource(relic, type);
  return {
    sprite: Number.isInteger(relic?.struct) ? null : Common.sourceCatalog(source)?.iconSprite ?? null,
    index: Number.isInteger(relic?.icon) ? relic.icon : null,
    params: { ...iconParams(relic, type) },
  };
}

/** structId -> params the client reads for it; a cache struct's listed params are replaced, the rest still come from the cache. */
function structRows(type) {
  const { params } = Common.data;
  const id = Common.ids(type);
  const rows = [{ structId: Common.league(type).struct, params: { [params.tiersEnum]: id.tiersEnum } }];
  Common.catalog(type).tiers.forEach((tier, tierIndex) => {
    rows.push({ structId: id.tierStruct(tierIndex), params: {
      [params.tierCost]: tier.cost,
      [params.tierRelics]: id.relicsEnum(tierIndex),
      [params.tierPassive]: id.passiveStruct(tierIndex),
    } });
    rows.push({ structId: id.passiveStruct(tierIndex), params: {
      [params.passiveText]: Common.passiveTierText(type, tierIndex),
    } });
    tier.relics.forEach((relic, slotIndex) => {
      const relicParams = {
        [params.relicName]: relic.name,
        [params.relicDescription]: relic.description,
        [params.relicTier]: tierIndex,
        [params.relicHasItem]: relic.grants?.length ? 1 : 0,
        ...iconParams(relic, type),
      };
      rows.push({ structId: id.relicStruct(tierIndex, slotIndex + 1), params: relicParams });
    });
  });
  return rows;
}

function enumRows(type) {
  const id = Common.ids(type);
  const tiers = Common.catalog(type).tiers;
  const rows = [{
    enumId: id.tiersEnum, valueType: "J", defaultValue: -1,
    entries: tiers.map((_tier, tierIndex) => [tierIndex, id.tierStruct(tierIndex)]),
  }];
  tiers.forEach((tier, tierIndex) => rows.push({
    enumId: id.relicsEnum(tierIndex), valueType: "J", defaultValue: -1,
    entries: tier.relics.map((_relic, slotIndex) => [slotIndex + 1, id.relicStruct(tierIndex, slotIndex + 1)]),
  }));
  return rows;
}

function datasets(type) {
  return [
    { key: "structOverrides", rows: structRows(type) },
    { key: "enumOverrides", rows: enumRows(type) },
  ];
}

/** `league:content-rows` { league, structs, enums }: this league's rows, unless the cache already has them. */
function content(query) {
  const type = query?.league;
  const catalog = Common.catalog(type);
  if (!catalog) return;
  if (!catalog.fromCache || Common.isCustomCatalog(type)) {
    query.structs.push(...structRows(type));
    query.enums.push(...enumRows(type));
    return;
  }
  const costs = Common.data.leagues[type]?.costs;
  if (!Array.isArray(costs)) return;
  const { tierCost } = Common.data.params;
  catalog.tiers.forEach((tier, index) => {
    if (!Number.isFinite(costs[index]) || tier.struct === undefined) return;
    query.structs.push({ structId: tier.struct, params: { [tierCost]: Number(costs[index]) } });
  });
}

/** The public relic catalog: every source relic, its stable id and icon, and this world's configuration. */
function relicCatalog() {
  const ambiguous = Common.ambiguousRelicIds();
  const league = (type) => {
    const row = Common.league(type);
    return {
      type,
      key: row?.key ?? null,
      name: row?.name ?? null,
      shortName: row?.shortName ?? null,
      colour: row?.colour ?? null,
      iconSprite: Common.sourceCatalog(type)?.iconSprite ?? null,
    };
  };
  return {
    schemaVersion: 2,
    canonicalIdFormat: "<leagueType>:<relicKey>",
    limits: {
      minTiers: 1,
      maxTiers: 8,
      minChoicesPerTier: 2,
      maxChoicesPerTier: 3,
    },
    leagues: [4, 5, 6].map(league),
    relics: Common.allRelicEntries().map((entry) => {
      const incompatibleReason = ambiguous.has(entry.id)
        ? "its source catalog repeats this relic key"
        : WorldCatalog.incompatibleReason(entry.relic);
      return {
        id: entry.id,
        key: entry.relic.key,
        name: entry.relic.name,
        description: entry.relic.description,
        sourceLeague: entry.sourceLeague,
        originalTier: entry.originalTier + 1,
        grants: [...(entry.relic.grants ?? [])],
        requiresBank: entry.relic.requiresBank === true,
        compatible: incompatibleReason === null,
        incompatibleReason,
        icon: iconDetails(entry.relic, entry.sourceLeague),
      };
    }),
    passiveLimits: {
      minTiers: WorldCatalog.MIN_TIERS,
      maxTiers: WorldCatalog.MAX_TIERS,
      choicesPerTier: null,
    },
    passives: Common.passiveCatalog().map((passive) => ({
      id: passive.id,
      key: passive.key,
      name: passive.name,
      description: passive.description,
      sourceText: passive.sourceText,
      sourceLeague: passive.sourceLeague,
      originalTier: passive.originalTier,
      effect: { ...passive.effect },
      implementation: { ...passive.implementation },
      compatible: passive.compatible,
      incompatibleReason: passive.incompatibleReason,
    })),
    world: Common.worldCatalogState(),
  };
}

/** The individual passive catalog for the world editor, with each grant's implementation status. */
function passiveCatalog() {
  const relic = relicCatalog();
  return {
    schemaVersion: 1,
    canonicalIdFormat: relic.canonicalIdFormat,
    limits: relic.passiveLimits,
    leagues: relic.leagues,
    passives: relic.passives,
    world: relic.world.passives,
  };
}

module.exports = function attach(api) {
  api.onCustomEvent("league:content-rows", content);
  api.registerContentEndpoint("relic-catalog", relicCatalog);
  api.registerContentEndpoint("league-passives", passiveCatalog);
};

module.exports.datasets = datasets;
module.exports.structRows = structRows;
module.exports.enumRows = enumRows;
module.exports.relicCatalog = relicCatalog;
module.exports.passiveCatalog = passiveCatalog;
module.exports.iconDetails = iconDetails;
