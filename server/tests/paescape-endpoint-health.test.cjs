// Run from server/: node --test tests/paescape-endpoint-health.test.cjs
//
// Task 30: the platform verifies a world's public endpoint by fetching
// GET /api/platform/health, which must advertise this world's identity without a
// control token. This pins the route's contract and that it fails closed on
// anything else. A dead platform URL is used so startup registers the control
// handler without any real network work.
const assert = require("node:assert/strict");
const { test, before } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-health-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
delete process.env.PAESCAPE_WORLD_SECRET;
process.env.PAESCAPE_PUBLIC_ENDPOINT = "https://localhost.invalid:43594";
process.env.PAESCAPE_INSTALLATION_FILE = path.join(WORK_DIR, "paescape-installation.json");
// A closed port: startup registers the control handler synchronously, then this
// server's background platform calls fail fast and are reported as warnings.
process.env.PAESCAPE_PLATFORM_URL = "http://127.0.0.1:9";
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { PluginManager } = require("../dist/plugins/PluginManager");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

before(() => {
  PaeScape.register(PluginManager.createApi("PaeScape"));
  // start() registers the platform control handler (which owns the health route)
  // before it begins any hosted network work.
  PluginManager.emitServerStartup({ timestamp: Date.now() });
});

function control(request) {
  return PluginManager.handlePlatformControl(request);
}

test("the public health route reports identity without a control token", async () => {
  const result = await control({ method: "GET", path: "/api/platform/health", headers: {}, body: "" });
  assert.ok(result, "the route is claimed");
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.service, "paescape-world");
  assert.equal(typeof result.body.leased, "boolean");
  for (const key of Object.keys(result.body)) {
    assert.ok(!/secret|token|credential|key/i.test(key), `health must not leak ${key}`);
  }
});

test("health ignores the query string and only answers GET", async () => {
  const withQuery = await control({ method: "GET", path: "/api/platform/health?x=1", headers: {}, body: "" });
  assert.equal(withQuery.status, 200);
  const post = await control({ method: "POST", path: "/api/platform/health", headers: {}, body: "{}" });
  assert.ok(!post || post.status === 401, "a POST to health is not an unauthenticated success");
});

test("a control route without a valid token is still refused", async () => {
  const denied = await control({ method: "POST", path: "/api/platform/characters", headers: {}, body: JSON.stringify({ name: "x" }) });
  assert.equal(denied.status, 401);
});
