/**
 * The league tier passives (issue #53): every passive line in Trailblazer Reloaded's, Raging
 * Echoes' and Demonic Pacts' tier text, split into independently selectable grants. The tier
 * text is the source: this unit classifies every bullet and fails on one it does not know, so a
 * newly added passive cannot silently disappear from the world editor's catalog.
 *
 * A passive id is source-qualified and versioned, `league-<league type>:t<tier>:<effect>`, so
 * a 2x drop rate at tier 1 and a 5x drop rate at tier 4 are distinct choices. A compound bullet
 * becomes one entry per independently implemented effect (Bigger and Badder, superior rate,
 * Slayer points and the task streak are four entries, not one bundle).
 */

const MIN_TIERS = 1;
const MAX_TIERS = 8;
const SOURCE_LEAGUES = [4, 5, 6];
const PASSIVE_ID = /^league-([1-9]\d*):t([1-8]):([a-z0-9]+(?:-[a-z0-9]+)*)$/;

const IMPLEMENTATIONS = Object.freeze({
  xpRate: {
    location: "plugins/modes/league/Common.LeagueMode.js:xpMultiplier",
    status: "implemented",
  },
  dropRate: {
    location: "plugins/modes/league/BoostedDrops.LeagueMode.js:rule",
    status: "implemented",
  },
  runEnergy: {
    location: "plugins/modes/league/Passives.LeagueMode.js:runEnergyDrain",
    status: "implemented",
  },
  scrollBoxes: {
    location: "plugins/modes/league/Passives.LeagueMode.js:scrollBoxes",
    status: "implemented",
  },
  clueStepProgress: {
    location: "plugins/modes/league/Passives.LeagueMode.js:clueProgress",
    status: "implemented",
  },
  farmingTicks: {
    location: "plugins/modes/league/Passives.LeagueMode.js:farmingGrowthRate",
    status: "implemented",
  },
  minigamePoints: {
    location: "plugins/modes/league/Passives.LeagueMode.js:minigamePoints",
    status: "implemented",
  },
  crystalOfMemories: {
    location: "plugins/modes/leaguerelics/CrystalOfMemories.LeagueRelics.js:unlocked",
    status: "implemented",
  },
  combatXp: {
    location: "plugins/modes/league/Passives.LeagueMode.js:combatExperience",
    status: "implemented",
  },
  biggerAndBadder: {
    location: "plugins/modes/league/Passives.LeagueMode.js:superiorSpawn",
    status: "implemented",
  },
  superiorSlayer: {
    location: "plugins/modes/league/Passives.LeagueMode.js:superiorSpawn",
    status: "implemented",
  },
  slayerPoints: {
    location: "plugins/modes/league/Passives.LeagueMode.js:slayerTaskReward",
    status: "implemented",
  },
  slayerFreeTasks: {
    location: "plugins/modes/league/Passives.LeagueMode.js:slayerTaskReward",
    status: "implemented",
  },
  unknown: {
    location: "plugins/modes/leaguerelics/PassivesCatalog.LeagueRelics.js:buildCatalog",
    status: "unsupported",
    reason: "The catalog builder could not classify this source line; add an implementation and parser.",
  },
});

function canonicalId(sourceLeague, originalTier, key) {
  return `league-${Number(sourceLeague)}:t${Number(originalTier)}:${key}`;
}

function parseCanonicalId(value) {
  if (typeof value !== "string") return null;
  const match = PASSIVE_ID.exec(value.trim().toLowerCase());
  if (!match) return null;
  return { sourceLeague: Number(match[1]), originalTier: Number(match[2]), key: match[3] };
}

function valueSlug(value) {
  return String(value).replace(".", "-");
}

function entry(sourceLeague, originalTier, key, name, description, sourceText, effect) {
  const implementation = IMPLEMENTATIONS[effect.type];
  if (!implementation) throw new Error(`passive ${effect.type} has no implementation reference`);
  return {
    id: canonicalId(sourceLeague, originalTier, key),
    key,
    name,
    description,
    sourceText,
    sourceLeague,
    originalTier,
    effect: { ...effect },
    implementation: { ...implementation },
    compatible: implementation.status === "implemented",
    incompatibleReason: implementation.status === "implemented" ? null : implementation.reason,
  };
}

/** Every individual passive a tier bullet grants; an unknown bullet becomes an unsupported entry. */
function splitBullet(sourceLeague, originalTier, sourceText, leagueEffects) {
  const text = sourceText.trim();
  const out = [];
  let match;

  if (text === "There are no passive unlocks for this tier.") return out;

  if ((match = /^Items from eligible sources will be (\d+)x as common\.$/.exec(text))) {
    const multiplier = Number(match[1]);
    out.push(entry(sourceLeague, originalTier, `drop-rate-x${multiplier}`,
      "Boosted drops", text, text, { type: "dropRate", multiplier }));
    return out;
  }

  if ((match = /^League XP multiplier (?:is |increased from [0-9.]+x to )([0-9.]+)x\.$/.exec(text))) {
    const multiplier = Number(match[1]);
    out.push(entry(sourceLeague, originalTier, `xp-multiplier-${valueSlug(multiplier)}x`,
      "League XP multiplier", text, text, { type: "xpRate", multiplier }));
    return out;
  }

  if (text === "Run energy is never drained whilst running.") {
    out.push(entry(sourceLeague, originalTier, "run-energy",
      "No run-energy drain", text, text, { type: "runEnergy" }));
    return out;
  }

  if (text === "Farming ticks will occur every minute instead of every five minutes.") {
    out.push(entry(sourceLeague, originalTier, "farming-ticks-every-minute",
      "Farming ticks", text, text, { type: "farmingTicks", minutes: 1 }));
    return out;
  }

  if ((match = /^Minigame points received are boosted by (\d+)x\.$/.exec(text))) {
    const multiplier = Number(match[1]);
    out.push(entry(sourceLeague, originalTier, `minigame-points-x${multiplier}`,
      "Minigame points", text, text, {
        type: "minigamePoints", multiplier, minigames: [...(leagueEffects.minigamePoints?.minigames ?? [])],
      }));
    return out;
  }

  if ((match = /^All clue scrolls will drop as stackable scroll boxes, and (clue-step progress is saved between clues)\.$/.exec(text))) {
    out.push(entry(sourceLeague, originalTier, "scroll-boxes",
      "Clue scrolls drop as scroll boxes", "All clue scrolls will drop as stackable scroll boxes", text,
      { type: "scrollBoxes" }));
    out.push(entry(sourceLeague, originalTier, "clue-step-progress",
      "Clue-step progress is saved", match[1], text, { type: "clueStepProgress" }));
    return out;
  }

  if (text === "All clue scrolls will drop as stackable scroll boxes, limited to steps in unlocked regions.") {
    out.push(entry(sourceLeague, originalTier, "scroll-boxes",
      "Clue scrolls drop as scroll boxes", text, text, { type: "scrollBoxes" }));
    return out;
  }

  if (text === "Grants a crystal of memories, which teleports you back to the last place you teleported from.") {
    out.push(entry(sourceLeague, originalTier, "crystal-of-memories",
      "Crystal of memories", text, text, { type: "crystalOfMemories" }));
    return out;
  }

  if ((match = /^Combat skills \(Including Hitpoints & Prayer\) have a ([\d.]+)x Multiplier \(Multiplicative with other modifiers\)\.$/.exec(text))) {
    const multiplier = Number(match[1]);
    out.push(entry(sourceLeague, originalTier, `combat-xp-x${valueSlug(multiplier)}`,
      "Combat XP", text, text, {
        type: "combatXp", multiplier, skills: [...(leagueEffects.combatXp?.skills ?? [])],
      }));
    return out;
  }

  if ((match = /^(Bigger and Badder is unlocked), and (superior slayer monsters spawn 1 in 50)\.$/.exec(text))) {
    out.push(entry(sourceLeague, originalTier, "slayer-bigger-and-badder",
      "Bigger and Badder", match[1], text, { type: "biggerAndBadder" }));
    out.push(entry(sourceLeague, originalTier, "slayer-superior-1-in-50",
      "Superior Slayer chance", match[2], text, { type: "superiorSlayer", chance: 50 }));
    return out;
  }

  if (text === `The "Bigger and badder" slayer unlock is unlocked for free.`) {
    out.push(entry(sourceLeague, originalTier, "slayer-bigger-and-badder",
      "Bigger and Badder", text, text, { type: "biggerAndBadder" }));
    return out;
  }

  if (text === "Slayer Superior rates are increased to a 1/50 chance to appear.") {
    out.push(entry(sourceLeague, originalTier, "slayer-superior-1-in-50",
      "Superior Slayer chance", text, text, { type: "superiorSlayer", chance: 50 }));
    return out;
  }

  if ((match = /^(Slayer point rewards are 5x), (with no minimum task streak)\.$/.exec(text))) {
    out.push(entry(sourceLeague, originalTier, "slayer-points-x5",
      "Slayer task points", match[1], text, { type: "slayerPoints", multiplier: 5 }));
    out.push(entry(sourceLeague, originalTier, "slayer-no-task-streak",
      "No Slayer task streak", match[2], text, { type: "slayerFreeTasks", freeTasks: 0 }));
    return out;
  }

  if ((match = /^(Slayer points are x5 from tasks),? and (you aren't required to complete 5 tasks before earning points)\.$/.exec(text))) {
    out.push(entry(sourceLeague, originalTier, "slayer-points-x5",
      "Slayer task points", match[1], text, { type: "slayerPoints", multiplier: 5 }));
    out.push(entry(sourceLeague, originalTier, "slayer-no-task-streak",
      "No Slayer task streak", match[2], text, { type: "slayerFreeTasks", freeTasks: 0 }));
    return out;
  }

  throw new Error(`unrecognized league ${sourceLeague} tier ${originalTier} passive: ${text}`);
}

/**
 * The complete catalog from the actual source tier text. `catalogs` maps a league type to its
 * resolved catalog (4 and 5 from league-relics.json, 6 from the cache). `leagueEffects` maps a
 * league type to leagues.json passives, used only to attach their minigame and combat-skill lists.
 */
function buildCatalog(catalogs, leagueEffects = {}) {
  const entries = [];
  for (const sourceLeague of SOURCE_LEAGUES) {
    const catalog = catalogs[sourceLeague];
    if (!catalog || !Array.isArray(catalog.tiers)) continue;
    const effects = leagueEffects[sourceLeague] ?? {};
    catalog.tiers.forEach((tier, tierIndex) => {
      const text = String(tier?.passive ?? "");
      let bulletIndex = 0;
      for (const bullet of text.split(/<br\s*\/?>/i)) {
        const clean = bullet.trim().replace(/^-\s*/, "");
        if (!clean) continue;
        bulletIndex++;
        try {
          entries.push(...splitBullet(sourceLeague, tierIndex + 1, clean, effects));
        } catch {
          entries.push(entry(sourceLeague, tierIndex + 1,
            `unrecognized-t${tierIndex + 1}-line-${bulletIndex}`,
            "Unrecognized tier passive", clean, clean, { type: "unknown" }));
        }
      }
    });
  }
  const byId = new Map();
  for (const passive of entries) {
    if (byId.has(passive.id)) throw new Error(`passive catalog repeats ${passive.id}`);
    byId.set(passive.id, passive);
  }
  return { entries, byId };
}

function normalizePassiveConfig(raw) {
  let value = raw;
  if (value === undefined || value === null) return { configured: false, tiers: null };
  if (typeof value === "string") {
    if (!value.trim()) return { configured: false, tiers: null };
    try {
      value = JSON.parse(value);
    } catch {
      return { configured: true, tiers: null, error: "league:passive-tiers is not valid JSON" };
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.tiers)) {
    value = value.tiers;
  }
  if (!Array.isArray(value)) return { configured: true, tiers: null, error: "league:passive-tiers must be an array of tiers" };
  return { configured: true, tiers: value };
}

function invalid(errors) {
  return {
    configured: true,
    status: "invalid",
    tiers: null,
    ids: [],
    entries: [],
    error: errors[0] ?? "the passive tier configuration is invalid",
    errors,
    warnings: [],
  };
}

/**
 * Validate the world's passive rows atomically. Each row may hold any number of passives (the
 * 2/3 limit is for relics only). A repeated canonical id, unknown or incompatible passive, bad
 * row or too many rows refuses the whole configuration and keeps the league's own passives.
 */
function buildWorldPassives({ raw, baseLeague, baseTiers, catalogs, leagueEffects = {}, relicTierCount = null }) {
  const normalized = normalizePassiveConfig(raw);
  const catalog = buildCatalog(catalogs, leagueEffects);
  if (!normalized.configured) {
    return { configured: false, status: "default", tiers: null, ids: [], entries: [], catalog, warnings: [] };
  }
  const errors = [];
  if (normalized.error) errors.push(normalized.error);
  if (!baseLeague) errors.push("league:type must name a league that has passives (4, 5 or 6)");
  if (errors.length) return { ...invalid(errors), catalog };
  if (!Array.isArray(baseTiers) || baseTiers.length === 0) {
    return { ...invalid([`league ${baseLeague}'s passive tiers are unavailable`]), catalog };
  }
  const rows = normalized.tiers;
  const maxTiers = Math.min(MAX_TIERS, baseTiers.length,
    Number.isInteger(relicTierCount) ? relicTierCount : baseTiers.length);
  if (!Array.isArray(rows) || rows.length < MIN_TIERS || rows.length > maxTiers) {
    return { ...invalid([`league:passive-tiers must have ${MIN_TIERS}-${maxTiers} tiers`]), catalog };
  }

  const used = new Set();
  const tiers = [];
  const ids = [];
  rows.forEach((row, tierIndex) => {
    if (!Array.isArray(row)) {
      errors.push(`passive tier ${tierIndex + 1} must be an array`);
      return;
    }
    const granted = [];
    row.forEach((value, slotIndex) => {
      const parsed = parseCanonicalId(value);
      if (!parsed) {
        errors.push(`passive tier ${tierIndex + 1} slot ${slotIndex + 1} is not a canonical passive id`);
        return;
      }
      const id = canonicalId(parsed.sourceLeague, parsed.originalTier, parsed.key);
      if (used.has(id)) {
        errors.push(`${id} is assigned more than once`);
        return;
      }
      used.add(id);
      if (!SOURCE_LEAGUES.includes(parsed.sourceLeague)) {
        errors.push(`${id} names an unsupported source league`);
        return;
      }
      const passive = catalog.byId.get(id);
      if (!passive) {
        errors.push(`${id} is not in league ${parsed.sourceLeague}'s passive catalog`);
        return;
      }
      if (!passive.compatible) {
        errors.push(`${id} is incompatible: ${passive.incompatibleReason}`);
        return;
      }
      granted.push({ ...passive, grantTier: tierIndex + 1 });
    });
    tiers.push(granted);
    ids.push(granted.map((passive) => passive.id));
  });

  if (errors.length) return { ...invalid(errors), catalog };
  return {
    configured: true,
    status: "custom",
    tiers,
    ids,
    entries: tiers.flat(),
    catalog,
    warnings: [],
  };
}

module.exports = {
  MIN_TIERS, MAX_TIERS, SOURCE_LEAGUES, IMPLEMENTATIONS,
  canonicalId, parseCanonicalId, splitBullet, buildCatalog, normalizePassiveConfig, buildWorldPassives,
};
