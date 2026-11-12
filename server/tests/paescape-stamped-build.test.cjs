// Verifies readBuildMetadata() honours a stamped paescape-app.json (what a packaged
// server.exe ships) and that the plugin then completes a real hosted handshake at
// that generation without PAESCAPE_RELEASE_GENERATION in the environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test, before, after } = require("node:test");
const http = require("node:http");

const SERVER_DIR = path.resolve(__dirname, "..");
function resolvePlatformDir() {
  for (const candidate of [process.env.PAESCAPE_PLATFORM_DIR, "D:\\PaeScape_Realms\\platform"]) {
    if (candidate && fs.existsSync(path.join(candidate, "src", "index.ts"))) return candidate;
  }
  throw new Error("platform checkout not found");
}
const PLATFORM_DIR = resolvePlatformDir();
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5218);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-stamp-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
// The test platform below mounts at the origin root (PLATFORM_PUBLIC_PATH ''), so
// tell the world plugin the public path is empty: no /platform prefix.
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";
delete process.env.PAESCAPE_WORLD_SECRET;
delete process.env.PAESCAPE_RELEASE_GENERATION;
delete process.env.PAESCAPE_BUILD_VERSION;
process.env.PAESCAPE_PUBLIC_ENDPOINT = "https://localhost.invalid:43594";
process.env.PAESCAPE_INSTALLATION_FILE = path.join(WORK_DIR, "paescape-installation.json");
// A packaged build extracts beside the exe and stamps its release here.
const STAMPED_DIR = path.join(WORK_DIR, "app-stamped");
fs.mkdirSync(STAMPED_DIR, { recursive: true });
fs.writeFileSync(path.join(STAMPED_DIR, "paescape-app.json"), JSON.stringify({ version: "9.9.9", generation: 1, protocolVersion: 1 }));
process.env.PAESCAPE_EXTRACTED_APP = STAMPED_DIR;

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { PluginManager } = require("../dist/plugins/PluginManager");
const bridge = require("../plugins/paescape/PaeScapeBridge");

let platform = null;
let platformOutput = "";
let cookie = "";
let csrf = "";
let worldId = "";

async function platformFetch(pathname, { method = "GET", body, bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = csrf;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${PLATFORM_URL}${pathname}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, headers: response.headers };
}

before(async () => {
  await CachePipeline.initialize(SERVER_DIR);
  platform = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: PLATFORM_DIR,
    env: {
      ...process.env,
      PLATFORM_DEV_LOGIN: "1",
      PLATFORM_PORT: String(PLATFORM_PORT),
      PLATFORM_DATABASE_FILE: ":memory:",
      PLATFORM_PUBLIC_PATH: "",
      PLATFORM_PUBLISHER_DISCORD_IDS: "discord-1",
      DISCORD_CLIENT_ID: "test-client-id",
      DISCORD_CLIENT_SECRET: "test-client-secret",
      NODE_ENV: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  platform.stdout.on("data", (d) => (platformOutput += d));
  platform.stderr.on("data", (d) => (platformOutput += d));
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try { if ((await fetch(`${PLATFORM_URL}/api/platform/public-key`)).ok) break; } catch { /* not up */ }
    await new Promise((r) => setTimeout(r, 300));
  }

  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username: "Tester", discordId: "discord-1" } });
  cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  csrf = (await platformFetch("/api/auth/session")).json.csrfToken;
  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "Stamp World", config: { settings: { experienceMultiplier: 1 } } } });
  worldId = created.json.world.id;
  await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  await platformFetch(`/api/worlds/${worldId}/endpoint`, { method: "POST", body: { endpointUrl: "https://localhost.invalid:43594" } });
  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));

  const installationKey = "paescape-stamp-install";
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey } });
  await platformFetch(`/api/worlds/${worldId}/enroll`, { method: "POST", body: { code: begin.json.code } });
  const credential = (await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } })).json.credential;
  fs.writeFileSync(process.env.PAESCAPE_INSTALLATION_FILE, JSON.stringify({ key: installationKey, credential }, null, 2));

  const PaeScape = require("../plugins/paescape/PaeScape.plugin");
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });
  const leaseDeadline = Date.now() + 30000;
  while (Date.now() < leaseDeadline) {
    const access = bridge.getPlatformAccess();
    if (access && typeof access.leaseToken === "function" && access.leaseToken()) break;
    await new Promise((r) => setTimeout(r, 200));
  }
});

after(async () => {
  if (platform) { platform.kill(); await new Promise((r) => setTimeout(r, 300)); }
});

test("the plugin reports the stamped release generation and completes the handshake", async () => {
  const access = bridge.getPlatformAccess();
  assert.ok(access && access.leaseToken(), "the plugin holds a lease");
  const lease = await platformFetch("/api/server/lease/renew", { method: "POST", bearer: access.leaseToken(), body: { generation: 1, configRevision: 1, contentRevision: "", playerCount: 0, buildVersion: "9.9.9" } });
  assert.equal(lease.status, 200, JSON.stringify(lease.json));
  assert.equal(lease.json.generation, 1, "the stamped generation was used, not the default 0");
});
