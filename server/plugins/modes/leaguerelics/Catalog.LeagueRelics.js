/**
 * The relic catalog the client draws. The cache's relic interface reads its league struct's tier
 * enum, tier structs and relic structs, but the cache only carries the current league's, so this
 * answers LeagueMode's `league:content-rows` with a league's own structs and enums (sent as
 * structOverrides / enumOverrides at login and before the interface opens). A league the cache
 * carries (data `fromCache`) needs none, unless its data sets `costs` (custom worlds), which
 * override only the tier-cost params on the cache's own tier structs. Icons are the cache's
 * current relics', per tier and slot.
 */
const Common = require("./Common.LeagueRelics");

/** structId -> params the client reads for it; a cache struct's listed params are replaced, the rest still come from the cache. */
function structRows(type) {
  const { params, iconStructs } = Common.data;
  const iconParams = params.iconParams;
  const { CacheDefinitions } = Common.core;
  const id = Common.ids(type);
  const rows = [{ structId: Common.league(type).struct, params: { [params.tiersEnum]: id.tiersEnum } }];
  Common.catalog(type).tiers.forEach((tier, tierIndex) => {
    rows.push({ structId: id.tierStruct(tierIndex), params: {
      [params.tierCost]: tier.cost,
      [params.tierRelics]: id.relicsEnum(tierIndex),
      [params.tierPassive]: id.passiveStruct(tierIndex),
    } });
    rows.push({ structId: id.passiveStruct(tierIndex), params: { [params.passiveText]: tier.passive } });
    tier.relics.forEach((relic, slotIndex) => {
      const iconSource = CacheDefinitions.getStructParams(iconStructs[tierIndex][slotIndex]);
      const relicParams = {
        [params.relicName]: relic.name,
        [params.relicDescription]: relic.description,
        [params.relicTier]: tierIndex,
        [params.relicHasItem]: relic.grants?.length ? 1 : 0,
      };
      for (const param of iconParams) {
        const value = iconSource.get(param);
        if (value !== undefined) relicParams[param] = value;
      }
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
  if (!catalog.fromCache) {
    query.structs.push(...structRows(type));
    query.enums.push(...enumRows(type));
    return;
  }
  // A fromCache league with `costs` still needs those points on the client (cache param 877).
  const costs = Common.data.leagues[type]?.costs;
  if (!Array.isArray(costs)) return;
  const { tierCost } = Common.data.params;
  catalog.tiers.forEach((tier, index) => {
    if (!Number.isFinite(costs[index]) || tier.struct === undefined) return;
    query.structs.push({ structId: tier.struct, params: { [tierCost]: Number(costs[index]) } });
  });
}

module.exports = function attach(api) {
  api.onCustomEvent("league:content-rows", content);
};

module.exports.datasets = datasets;
module.exports.structRows = structRows;
module.exports.enumRows = enumRows;
