#!/usr/bin/env node
/**
 * Generate docs/league-passives-audit.json from the actual tier definitions. Any bullet the
 * catalog builder cannot split is written as an unsupported entry, and the audit records every
 * tier source text beside the individual grants derived from it. Run from server/ after
 * `npm run build`:
 *
 *   node scripts/generate-league-passives-audit.cjs
 */
const fs = require("fs");
const path = require("path");
const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const Common = require("../plugins/modes/leaguerelics/Common.LeagueRelics");
const leagues = require("../plugins/modes/data/leagues.json").leagues;

async function main() {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  const core = PluginManager.getCoreApi();
  Common.init({
    core,
    getPluginConfig: (_key, fallback) => fallback,
    emitCustomEvent() {},
    log() {},
  });

  const entries = Common.passiveCatalog();
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const sources = [4, 5, 6].map((type) => {
    const catalog = Common.sourceCatalog(type);
    return {
      type,
      key: leagues[type]?.key ?? null,
      name: leagues[type]?.name ?? null,
      tiers: (catalog?.tiers ?? []).map((tier, index) => ({
        tier: index + 1,
        sourceText: tier.passive,
        passives: entries.filter((entry) => entry.sourceLeague === type && entry.originalTier === index + 1)
          .map((entry) => entry.id),
      })),
    };
  });

  const counts = {};
  for (const entry of entries) counts[entry.sourceLeague] = (counts[entry.sourceLeague] ?? 0) + 1;
  const otherLeagues = [1, 2, 3].map((type) => ({
    type,
    key: leagues[type]?.key ?? null,
    name: leagues[type]?.name ?? null,
    tierPassiveCatalog: false,
    definitionNote: leagues[type]?._xp ?? "No tier-passive definitions in the implemented server data.",
  }));
  const audit = {
    schemaVersion: 1,
    generatedBy: "server/scripts/generate-league-passives-audit.cjs",
    sources: [
      "server/plugins/modes/data/league-relics.json",
      "server/plugins/modes/data/leagues.json",
      "cache league struct 6436 (Demonic Pacts tier passive text)",
    ],
    counts,
    otherLeagues,
    tiers: sources,
    passives: entries.map((entry) => ({
      id: entry.id,
      name: entry.name,
      description: entry.description,
      sourceText: entry.sourceText,
      sourceLeague: entry.sourceLeague,
      sourceLeagueKey: leagues[entry.sourceLeague]?.key ?? null,
      originalTier: entry.originalTier,
      effect: entry.effect,
      implementation: entry.implementation,
      compatible: entry.compatible,
      incompatibleReason: entry.incompatibleReason,
    })),
  };

  const output = path.resolve(__dirname, "..", "docs", "league-passives-audit.json");
  fs.writeFileSync(output, `${JSON.stringify(audit, null, 2)}\n`);
  if (byId.size !== entries.length) throw new Error("passive ids are not unique");
  console.log(`wrote ${path.relative(process.cwd(), output)}: ${entries.length} individual passives`);
  const unsupported = entries.filter((entry) => !entry.compatible);
  if (unsupported.length > 0) {
    console.error(`${unsupported.length} passive(s) have no implementation: ${unsupported.map((entry) => entry.id).join(", ")}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
