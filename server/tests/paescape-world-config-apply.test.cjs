// Run from server/ after `yarn build`: node --test tests/paescape-world-config-apply.test.cjs
//
// The companion to paescape-world-config-overlay.test.cjs: that one pins the pure
// translation and the core overlay in isolation; this one drives the *real*
// PaeScape plugin against a stub platform and asserts the owner's configured spawn
// and XP rate actually take effect on the running engine. Before the fix the plugin
// read a key the platform never writes (settings.experienceMultiplier) and never
// read the spawn at all, so both were silently ignored.
//
// Configured mode (a world secret) is used because it needs no enrollment: the stub
// answers /api/world/auth with a config blob, the plugin applies it, and the test
// reads the engine's live world definition - not a mock.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { test, before, after } = require("node:test");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-config-apply-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
process.env.PAESCAPE_WORLD_SECRET = "test-world-secret";
process.env.PAESCAPE_WORLD_ID = "wld_config_apply";
delete process.env.PAESCAPE_INSTALLATION_FILE;
delete process.env.PAESCAPE_PUBLIC_ENDPOINT;
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";

// The authoritative config the stub platform returns: the exact shape the website
// saves (settings.xpRate, settings.spawn) for a world whose owner picked a
// non-default spawn and 1000x XP.
const CONFIG = {
  version: 1,
  mode: "online",
  template: "osrs",
  settings: {
    description: "Test world for trials",
    spawn: { x: 3222, y: 3219, z: 0 },
    xpRate: 1000,
    zones: [],
    f2pWorld: false,
    gameframe: "modern-resizable",
  },
  shops: [],
  mapOverrides: [],
};
const CONFIG_REVISION = 7;

let stub = null;
let stubUrl = "";

function startStub() {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const route = `${req.method} ${(req.url || "").split("?")[0]}`;
      res.setHeader("content-type", "application/json");
      if (route === "GET /api/platform/public-key") {
        res.end(JSON.stringify({ publicKey: "" }));
        return;
      }
      if (route === "POST /api/world/auth") {
        res.end(JSON.stringify({
          token: "test-session",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          world: { id: process.env.PAESCAPE_WORLD_ID, name: "Config Apply World", status: "live", configRevision: CONFIG_REVISION, config: CONFIG },
          limits: { maxCharactersPerUser: 3 },
        }));
        return;
      }
      if (route === "POST /api/world/heartbeat") {
        res.end(JSON.stringify({ ok: true, configRevision: CONFIG_REVISION, restartRequired: false, config: CONFIG }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false }));
    });
  });
  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => {
      stubUrl = `http://127.0.0.1:${stub.address().port}`;
      process.env.PAESCAPE_PLATFORM_URL = stubUrl;
      resolve();
    });
  });
}

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { GameConstants } = require("../dist/game/GameConstants");
const WorldDefinition = require("../dist/game/definition/WorldDefinition");
const { PluginManager } = require("../dist/plugins/PluginManager");
const { Player } = require("../dist/game/entity/impl/player/Player");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

before(async () => {
  await startStub();
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });
  // Wait for the configured-mode startup chain (auth -> ...) to apply the config.
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && WorldDefinition.getWorldDefinition().experienceMultiplier !== 1000) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(async () => {
  if (stub) await new Promise((resolve) => stub.close(resolve));
});

test("the owner's configured spawn reaches the running world", () => {
  const spawn = WorldDefinition.WORLD_SPAWN;
  assert.deepEqual({ x: spawn.getX(), y: spawn.getY(), z: spawn.getZ() }, { x: 3222, y: 3219, z: 0 });
});

test("the owner's configured XP rate reaches the running engine", () => {
  assert.equal(WorldDefinition.getWorldDefinition().experienceMultiplier, 1000);
  assert.equal(GameConstants.EXPERIENCE_MULTIPLIER, 1000);
});

test("the configured description and gameframe reach the running world", () => {
  const definition = WorldDefinition.getWorldDefinition();
  assert.equal(definition.description, "Test world for trials");
  assert.equal(definition.gameframe, "modern-resizable");
});

test("a login clones the configured spawn", () => {
  // GameConstants.DEFAULT_LOCATION is the mutable WORLD_SPAWN the login path clones.
  const cloned = GameConstants.DEFAULT_LOCATION.clone();
  assert.deepEqual({ x: cloned.getX(), y: cloned.getY(), z: cloned.getZ() }, { x: 3222, y: 3219, z: 0 });
});

test("a player entering on the login path spawns at the configured coordinates", () => {
  // NetworkBuilder.login builds a Player with GameConstants.DEFAULT_LOCATION.clone();
  // constructing one the same way shows the configured spawn reaches the world, not
  // just the constant.
  const player = new Player(null, GameConstants.DEFAULT_LOCATION.clone());
  const location = player.getLocation();
  assert.deepEqual({ x: location.getX(), y: location.getY(), z: location.getZ() }, { x: 3222, y: 3219, z: 0 });
});
