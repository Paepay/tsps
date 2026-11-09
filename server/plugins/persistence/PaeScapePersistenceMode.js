"use strict";

/**
 * Whether this world runs as a PaeScape hosted world, in which case the platform
 * owns authoritative character state and no local persistence backend may run.
 *
 * Detection mirrors the PaeScape plugin's own configuration precedence so the two
 * never disagree: the environment first, then the world configuration's
 * pluginConfig ("PaeScape:platformUrl" / "PaeScape:worldSecret"), which is where a
 * packaged server.exe carries them. Hosted mode is a platform URL with no world
 * secret; a secret means legacy/manual configured mode, which keeps local saves.
 */

let cached;

function readWorldPluginConfig() {
  try {
    const { readWorldConfig } = require("../../src/main/typescript/elvarg/game/definition/WorldDefinition");
    const config = readWorldConfig() || {};
    const pluginConfig = config.pluginConfig && typeof config.pluginConfig === "object" ? config.pluginConfig : {};
    return pluginConfig;
  } catch {
    return {};
  }
}

function isHostedPersistence() {
  if (cached !== undefined) return cached;
  const pluginConfig = readWorldPluginConfig();
  const url = String(process.env.PAESCAPE_PLATFORM_URL ?? pluginConfig["PaeScape:platformUrl"] ?? "").trim();
  const secret = String(process.env.PAESCAPE_WORLD_SECRET ?? pluginConfig["PaeScape:worldSecret"] ?? "").trim();
  cached = Boolean(url) && !secret;
  return cached;
}

module.exports = { isHostedPersistence };