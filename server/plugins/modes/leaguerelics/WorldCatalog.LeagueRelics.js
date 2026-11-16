/**
 * The world-configured relic catalog (issue #53): a world names 1-8 tiers of 2 or 3 relics
 * drawn from any of the relic leagues. This unit is pure: it validates the saved
 * `league:relic-tiers` value against the complete source catalogs and returns either one
 * complete catalog or an error. A world never receives a partial catalog.
 *
 * A relic's stable id is source-qualified, `<league type>:<catalog key>`, because several
 * keys exist in more than one league (`fairys-flight`, `bankers-note`, `equilibrium`,
 * `guardian`). The source is part of the identity: a website or save can never mistake
 * Trailblazer Reloaded's Fairy's Flight for Raging Echoes' by the key alone.
 */

const MIN_TIERS = 1;
const MAX_TIERS = 8;
const MIN_CHOICES = 2;
const MAX_CHOICES = 3;
const SOURCE_LEAGUES = [4, 5, 6];
// The website stores `league-4:key`; the runtime's canonical form is `4:key`.
// Accept both so a platform payload cannot be dropped merely because it kept
// the shared contract's league- prefix.
const RELIC_ID = /^(?:league-)?([1-9]\d*):([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const RELIC_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function canonicalId(sourceLeague, key) {
  return `${Number(sourceLeague)}:${key}`;
}

/** `{ sourceLeague, key }` for a canonical id, or null when it is not one. */
function parseCanonicalId(value) {
  if (typeof value !== "string") return null;
  const match = RELIC_ID.exec(value.trim().toLowerCase());
  if (!match) return null;
  return { sourceLeague: Number(match[1]), key: match[2] };
}

/**
 * The saved value: absent means "the league's own catalog"; otherwise an array of tiers,
 * each an array of canonical ids. A JSON string is accepted because the world config page's
 * json field and older snapshots can carry one.
 */
function normalizeTierConfig(raw) {
  let value = raw;
  if (value === undefined || value === null) return { configured: false, tiers: null };
  if (typeof value === "string") {
    if (!value.trim()) return { configured: false, tiers: null };
    try {
      value = JSON.parse(value);
    } catch {
      return { configured: true, tiers: null, error: "league:relic-tiers is not valid JSON" };
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.tiers)) {
    value = value.tiers;
  }
  if (!Array.isArray(value)) {
    return { configured: true, tiers: null, error: "league:relic-tiers must be an array of tiers" };
  }
  return { configured: true, tiers: value };
}

/** A relic source catalog item has the fields the catalog rows and effect lookups need. */
function incompatibleReason(relic) {
  if (!relic || typeof relic !== "object") return "the relic definition is missing";
  if (typeof relic.key !== "string" || !RELIC_KEY.test(relic.key)) return "its key is not a slug";
  if (typeof relic.name !== "string" || !relic.name.trim()) return "its name is missing";
  if (typeof relic.description !== "string") return "its description is missing";
  if (!Array.isArray(relic.grants)) return "its granted items are missing";
  if (relic.requiresBank !== undefined && typeof relic.requiresBank !== "boolean") return "requiresBank is not true or false";
  if (relic.icon !== undefined && !Number.isInteger(relic.icon)) return "its icon index is not a whole number";
  if (relic.struct !== undefined && !Number.isInteger(relic.struct)) return "its cache struct is not a whole number";
  if (relic.icon === undefined && relic.struct === undefined) return "it has neither an icon nor a cache struct";
  return null;
}

/**
 * Every source relic by canonical id, plus the ids a source itself repeats. `catalogs` maps
 * a league type to its source catalog (4 and 5 from league-relics.json, 6 from the cache).
 */
function sourceEntries(catalogs) {
  const byId = new Map();
  const ambiguous = new Set();
  for (const sourceLeague of SOURCE_LEAGUES) {
    const catalog = catalogs[sourceLeague];
    if (!catalog || !Array.isArray(catalog.tiers)) continue;
    catalog.tiers.forEach((tier, tierIndex) => {
      for (const relic of tier?.relics ?? []) {
        if (typeof relic?.key !== "string") continue;
        const id = canonicalId(sourceLeague, relic.key);
        if (byId.has(id)) {
          ambiguous.add(id);
          continue;
        }
        byId.set(id, { id, sourceLeague, originalTier: tierIndex, relic });
      }
    });
  }
  return { byId, ambiguous };
}

/**
 * Build one catalog, or fail. The tier costs and passive text belong to the world's base
 * league (what its points and progression screens already use); each relic keeps its own
 * source league's name, description, grants and effects.
 */
function buildWorldCatalog({ raw, baseLeague, baseTiers, catalogs }) {
  const normalized = normalizeTierConfig(raw);
  if (!normalized.configured) return { configured: false, status: "default", tiers: null, warnings: [] };
  const errors = [];
  if (normalized.error) errors.push(normalized.error);
  if (!baseLeague) errors.push("league:type must name a league that has relics (4, 5 or 6)");
  if (errors.length) return invalid(errors);
  if (!Array.isArray(baseTiers) || baseTiers.length === 0) {
    return invalid([`league ${baseLeague}'s relic tiers are unavailable`]);
  }

  const tiers = normalized.tiers;
  if (!Array.isArray(tiers) || tiers.length < MIN_TIERS || tiers.length > MAX_TIERS) {
    return invalid([`league:relic-tiers must have ${MIN_TIERS}-${MAX_TIERS} tiers`]);
  }
  if (tiers.length > baseTiers.length) {
    return invalid([`league ${baseLeague} has only ${baseTiers.length} tiers, so ${tiers.length} cannot be configured`]);
  }

  const { byId, ambiguous } = sourceEntries(catalogs);
  const used = new Set();
  const canonicalTiers = [];
  const built = [];
  tiers.forEach((row, tierIndex) => {
    if (!Array.isArray(row) || row.length < MIN_CHOICES || row.length > MAX_CHOICES) {
      errors.push(`tier ${tierIndex + 1} must have ${MIN_CHOICES} or ${MAX_CHOICES} relics`);
      return;
    }
    const ids = [];
    const relics = [];
    row.forEach((value, slotIndex) => {
      const parsed = parseCanonicalId(value);
      if (!parsed) {
        errors.push(`tier ${tierIndex + 1} slot ${slotIndex + 1} is not a canonical relic id`);
        return;
      }
      const id = canonicalId(parsed.sourceLeague, parsed.key);
      ids.push(id);
      if (used.has(id)) {
        errors.push(`${id} is assigned more than once`);
        return;
      }
      used.add(id);
      if (!SOURCE_LEAGUES.includes(parsed.sourceLeague)) {
        errors.push(`${id} names an unsupported source league`);
        return;
      }
      if (ambiguous.has(id)) {
        errors.push(`${id} is ambiguous in its source catalog`);
        return;
      }
      const entry = byId.get(id);
      if (!entry) {
        errors.push(`${id} is not in league ${parsed.sourceLeague}'s relic catalog`);
        return;
      }
      const reason = incompatibleReason(entry.relic);
      if (reason) {
        errors.push(`${id} is incompatible: ${reason}`);
        return;
      }
      relics.push({
        ...entry.relic,
        key: entry.relic.key,
        canonicalId: id,
        sourceLeague: entry.sourceLeague,
        originalTier: entry.originalTier,
      });
    });
    canonicalTiers.push(ids);
    if (relics.length === row.length) {
      const base = baseTiers[tierIndex];
      built.push({ cost: Number(base?.cost) || 0, passive: String(base?.passive ?? ""), relics });
    }
  });

  if (errors.length || built.length !== tiers.length) return invalid(errors);
  return {
    configured: true,
    status: "custom",
    tiers: built,
    canonicalTiers,
    ids: canonicalTiers.flat(),
    warnings: [],
  };
}

function invalid(errors) {
  return {
    configured: true,
    status: "invalid",
    tiers: null,
    error: errors[0] ?? "the relic tier configuration is invalid",
    errors,
    warnings: [],
  };
}

module.exports = {
  MIN_TIERS, MAX_TIERS, MIN_CHOICES, MAX_CHOICES, SOURCE_LEAGUES,
  canonicalId, parseCanonicalId, normalizeTierConfig, incompatibleReason, sourceEntries, buildWorldCatalog,
};
