// Run after `yarn build`, with the PaeScape_Realms platform checkout available:
//   node --test tests/paescape-world-data.test.cjs
//
// This is not a mocked test. It boots the real PaeScape platform as a separate
// process (in-memory SQLite) and drives the real WorldData bridge and the real
// synchronous platform transport against the real /api/server/world-state route.
// A hosted world's scoreboards, records, clans and party chest must live on the
// platform, never in JSON files beside server.exe (task10 section 8).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test, before, after } = require("node:test");

const SERVER_DIR = path.resolve(__dirname, "..");
const PLATFORM_PORT = Number(process.env.TEST_PLATFORM_PORT || 5213);
const PLATFORM_URL = `http://127.0.0.1:${PLATFORM_PORT}`;
// The bridge and the mode guard agree on hosted mode through this env var; set it
// before anything reads the mode.
process.env.PAESCAPE_PLATFORM_URL = PLATFORM_URL;
delete process.env.PAESCAPE_WORLD_SECRET;

/** The PaeScape platform checkout. Override with PAESCAPE_PLATFORM_DIR. */
function resolvePlatformDir() {
  const candidates = [
    process.env.PAESCAPE_PLATFORM_DIR,
    "D:\\PaeScape_Realms\\platform",
    path.resolve(SERVER_DIR, "..", "..", "PaeScape_Realms", "platform"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "src", "index.ts"))) return candidate;
  }
  return candidates[0];
}
const PLATFORM_DIR = resolvePlatformDir();
const SAVE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-worlddata-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(SAVE_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(SAVE_DIR, "display-names.json");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const bridge = require("../plugins/paescape/PaeScapeBridge");
const worldData = require("../plugins/persistence/WorldData");

let platform = null;
let platformOutput = "";
let cookie = "";
let csrf = "";
let worldId = "";
let worldTwoId = "";
let leaseToken = "";
let leaseTwoToken = "";

async function platformFetch(pathname, { method = "GET", body, bearer } = {}) {
  const headers = { "content-type": "application/json" };
  if (cookie) headers.cookie = cookie;
  if (csrf && !bearer) headers["x-csrf-token"] = csrf;
  if (bearer) headers.authorization = `Bearer ${bearer}`;
  const response = await fetch(`${PLATFORM_URL}${pathname}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = null; }
  return { status: response.status, json, headers: response.headers };
}

async function waitForPlatform() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${PLATFORM_URL}/api/platform/public-key`);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("the platform did not start:\n" + platformOutput.slice(-2000));
}

async function signInAs(username, discordId) {
  const login = await platformFetch("/api/auth/dev-login", { method: "POST", body: { username, discordId } });
  assert.equal(login.status, 200, JSON.stringify(login.json));
  const sessionCookie = (login.headers.get("set-cookie") || "").split(";")[0] || "";
  assert.ok(sessionCookie, "the dev login set a session cookie");
  cookie = sessionCookie;
  const session = await platformFetch("/api/auth/session");
  assert.equal(session.json.authenticated, true, JSON.stringify(session.json));
  csrf = session.json.csrfToken;
  return { cookie: sessionCookie, csrf, userId: session.json.user.id };
}

async function enrollAndLease(id, keySuffix) {
  const installationKey = `paescape-worlddata-install-${keySuffix}`;
  const begin = await platformFetch("/api/server/enroll/begin", { method: "POST", body: { installationKey, label: keySuffix } });
  assert.equal(begin.status, 201, JSON.stringify(begin.json));
  const claim = await platformFetch(`/api/worlds/${id}/enroll`, { method: "POST", body: { code: begin.json.code } });
  assert.equal(claim.status, 200, JSON.stringify(claim.json));
  const complete = await platformFetch("/api/server/enroll/complete", { method: "POST", body: { installationKey } });
  assert.equal(complete.status, 201, JSON.stringify(complete.json));
  const credential = complete.json.credential;
  const nonce = (await platformFetch("/api/server/handshake/nonce", { method: "POST", body: { installationKey } })).json.nonce;
  const handshake = await platformFetch("/api/server/handshake", {
    method: "POST",
    bearer: credential,
    body: { nonce, generation: 1, protocolVersion: 1 },
  });
  assert.equal(handshake.status, 200, JSON.stringify(handshake.json));
  return handshake.json.lease.token;
}

/** Point the persistence bridge at a platform origin and lease, hosted mode. */
function attach(origin = PLATFORM_URL, token = leaseToken) {
  bridge.setPlatformAccess({
    platformOrigin: () => origin,
    leaseToken: () => token,
    readConfig: () => ({ url: origin, worldSecret: "" }),
  });
}

before(async () => {
  await require("../dist/game/cache/CachePipeline").CachePipeline.initialize(SERVER_DIR);
  fs.mkdirSync(SAVE_DIR, { recursive: true });

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
  await waitForPlatform();

  await signInAs("World Data Tester", "discord-1");
  const created = await platformFetch("/api/worlds", { method: "POST", body: { name: "World Data World" } });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  worldId = created.json.world.id;
  const live = await platformFetch(`/api/worlds/${worldId}/go-live`, { method: "POST", body: {} });
  assert.equal(live.status, 200, JSON.stringify(live.json));

  const second = await platformFetch("/api/worlds", { method: "POST", body: { name: "World Data Other" } });
  assert.equal(second.status, 201, JSON.stringify(second.json));
  worldTwoId = second.json.world.id;
  await platformFetch(`/api/worlds/${worldTwoId}/go-live`, { method: "POST", body: {} });

  const release = await platformFetch("/api/releases", { method: "POST", body: { version: "1.0.0", channel: "stable" } });
  assert.equal(release.status, 201, JSON.stringify(release.json));

  leaseToken = await enrollAndLease(worldId, "one");
  leaseTwoToken = await enrollAndLease(worldTwoId, "two");
});

after(async () => {
  if (platform) {
    platform.kill();
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  fs.rmSync(SAVE_DIR, { recursive: true, force: true });
});

test("hosted mode is detected, so world data goes to the platform", () => {
  attach();
  worldData.resetForTests({ hosted: true });
  assert.equal(worldData.isHosted(), true);
});

test("a world-data store round-trips through platform SQL, not a local file", async () => {
  attach();
  worldData.resetForTests({ hosted: true });
  worldData.write("test-scoreboard", { best: [{ name: "Zezima", kills: 42 }] });
  await worldData.flush();

  // A fresh process (mirror cleared) reads the store back only from the platform.
  worldData.resetForTests({ hosted: true });
  attach();
  const read = worldData.read("test-scoreboard");
  assert.equal(read.loaded, true, "the store loaded from the platform");
  assert.deepEqual(read.value, { best: [{ name: "Zezima", kills: 42 }] });

  // Nothing was written beside server.exe.
  const stray = fs.existsSync(SAVE_DIR) ? fs.readdirSync(SAVE_DIR).filter((n) => n.includes("test-scoreboard")) : [];
  assert.deepEqual(stray, [], "no world-data file is written to disk in hosted mode");
});

test("a write is refused before the platform state has loaded", () => {
  worldData.resetForTests({ hosted: true });
  // A lease but an unreachable platform: the load fails, so the write must be
  // refused rather than start from an empty mirror that would clobber the world.
  attach("http://127.0.0.1:1", leaseToken);
  assert.throws(() => worldData.write("refused-store", { n: 1 }), /not loaded|platform|status/i);
  attach();
  worldData.resetForTests({ hosted: true });
});

test("the synchronous write is the commit point for the party chest", async () => {
  attach();
  worldData.resetForTests({ hosted: true });
  worldData.writeNow("party-room", { version: 1, chest: [{ id: 995, amount: 1000 }], confirmed: {} });

  worldData.resetForTests({ hosted: true });
  attach();
  const read = worldData.read("party-room");
  assert.equal(read.loaded, true);
  assert.deepEqual(read.value.chest, [{ id: 995, amount: 1000 }]);
});

test("a synchronous write is refused when the platform is unreachable", () => {
  worldData.resetForTests({ hosted: true });
  attach("http://127.0.0.1:1", leaseToken);
  assert.throws(() => worldData.writeNow("party-room", { version: 1, chest: [], confirmed: {} }), /could not save|platform|status/i);
  attach();
  worldData.resetForTests({ hosted: true });
});

test("world data is isolated per world: another world never sees this store", async () => {
  attach(PLATFORM_URL, leaseToken);
  worldData.resetForTests({ hosted: true });
  worldData.write("isolation-store", { secret: "world-one" });
  await worldData.flush();

  // A different world's lease cannot read world one's store.
  attach(PLATFORM_URL, leaseTwoToken);
  worldData.resetForTests({ hosted: true });
  const read = worldData.read("isolation-store");
  assert.equal(read.loaded, true);
  assert.equal(read.value, undefined, "the other world sees no store from world one");

  attach();
  worldData.resetForTests({ hosted: true });
});

test("a stale write is reconciled rather than lost when the document advanced", async () => {
  attach();
  worldData.resetForTests({ hosted: true });
  worldData.write("mine", { v: 1 });
  await worldData.flush();

  // Advance the platform document behind the mirror's back.
  const current = await platformFetch("/api/server/world-state", { bearer: leaseToken });
  const external = await platformFetch("/api/server/world-state", {
    method: "PUT",
    bearer: leaseToken,
    body: { expectedRevision: current.json.state.revision, idempotencyKey: "world-data-external-1", state: { __paescapeWorldData: 1, stores: { theirs: { v: 9 } } } },
  });
  assert.equal(external.status, 200, JSON.stringify(external.json));

  // The mirror still believes revision 1, so its next write conflicts and the
  // bridge reloads, re-applies its own keys and retries rather than clobbering.
  attach();
  worldData.write("mine", { v: 2 });
  await worldData.flush();

  const finalDoc = await platformFetch("/api/server/world-state", { bearer: leaseToken });
  const stores = finalDoc.json.state.state.stores;
  assert.deepEqual(stores.mine, { v: 2 }, "this world keeps its own latest value");
  assert.deepEqual(stores.theirs, { v: 9 }, "the concurrent writer's key survives");
});
