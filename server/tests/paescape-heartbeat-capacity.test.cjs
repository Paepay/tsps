// Run from server/ after `yarn build`: node --test tests/paescape-heartbeat-capacity.test.cjs
//
// The plugin reports the world's player cap to the platform on every heartbeat
// and lease renewal. The engine's slot list exposes that cap as
// `capacityReturn()`, not a `capacity()` method: reading it as a method throws,
// and because the calls sit inside the heartbeat and lease-renewal try blocks, a
// throw is swallowed as a warning while the *renewal itself never happens* - the
// lease then silently expires and the platform refuses to issue login tickets.
//
// This pins the contract without a live platform: a stub platform records the
// heartbeat body, and the test asserts the reported maxPlayers is the engine's
// real cap (a positive, finite number) rather than the 0 a swallowed throw leaves.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-capacity-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
// Never read a real server's persisted platform snapshot: this test pins the
// fallback to the engine slot count when the platform supplies no owner cap.
process.env.PAESCAPE_WORLD_PLATFORM_CONFIG = path.join(WORK_DIR, "world.platform.json");
// A world secret means "configured" mode, so startup exchanges the credential
// for a session and beats, without any enrollment work.
process.env.PAESCAPE_WORLD_SECRET = "test-world-secret";
process.env.PAESCAPE_WORLD_ID = "wld_capacity_test";
delete process.env.PAESCAPE_INSTALLATION_FILE;
delete process.env.PAESCAPE_PUBLIC_ENDPOINT;
// The stub platform below mounts at the origin root (empty public path).
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";

let stub = null;
let stubUrl = "";
const heartbeats = [];

function startStub() {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const route = `${req.method} ${(req.url || "").split("?")[0]}`;
      res.setHeader("content-type", "application/json");
      if (route === "GET /api/platform/public-key") {
        // fetchPublicKey only logs a warning without a key; the heartbeat path
        // under test does not need one.
        res.end(JSON.stringify({ publicKey: "" }));
        return;
      }
      if (route === "POST /api/world/auth") {
        res.end(JSON.stringify({ token: "test-session", expiresAt: new Date(Date.now() + 900_000).toISOString(), world: { id: process.env.PAESCAPE_WORLD_ID } }));
        return;
      }
      if (route === "POST /api/world/heartbeat") {
        try { heartbeats.push(JSON.parse(body)); } catch { heartbeats.push({ parseError: body }); }
        res.end(JSON.stringify({ ok: true, configRevision: 1 }));
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
const { World } = require("../dist/game/World");
const { PluginManager } = require("../dist/plugins/PluginManager");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

before(async () => {
  await startStub();
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && heartbeats.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
});

after(async () => {
  if (stub) await new Promise((resolve) => stub.close(resolve));
});

test("the heartbeat reports the engine's real player cap, not a swallowed throw", () => {
  assert.ok(heartbeats.length > 0, "the plugin sent at least one heartbeat");
  const beat = heartbeats[0];
  const capacity = World.getPlayers().capacityReturn();
  assert.ok(Number.isFinite(beat.maxPlayers), `maxPlayers is a finite number, got ${JSON.stringify(beat.maxPlayers)}`);
  assert.ok(beat.maxPlayers > 0, `maxPlayers is positive, got ${beat.maxPlayers}`);
  // The usable limit is one below the slot list's capacity, matching how
  // AdminCommands.plugin.js reports the world NPC cap.
  assert.equal(beat.maxPlayers, capacity - 1, "the reported cap matches the engine's slots");
  assert.ok(Number.isFinite(beat.playerCount), "the player count is reported too");
});
