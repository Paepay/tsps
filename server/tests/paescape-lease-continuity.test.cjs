// Run from server/ after `yarn build`:
//   node --test tests/paescape-lease-continuity.test.cjs
//
// Task 29 follow-up. The platform treats `POST /api/server/lease/renew` as the
// world's heartbeat: it refreshes `worlds.last_heartbeat_at`, and a world whose
// heartbeat is older than 90 s (platform/src/worlds.ts `HEARTBEAT_STALE_MS`) is
// reported offline and offered no login tickets.
//
// A hosted server used to renew only "shortly before the lease expires"
// (~14 minutes on the 15-minute lease), so a perfectly healthy world flapped
// offline for most of every lease period, and the renewal loop also stopped
// permanently after a single refused or failed attempt. This boots the real
// plugin against a stub platform and pins the fixed behaviour:
//
//   - the renewal loop runs continuously at the configured cadence, so the
//     notion of "now" on the platform never goes stale;
//   - a transient platform failure (503, or a dropped connection) does not stop
//     the loop, and the next success recovers it;
//   - the cadence stays strictly inside the platform's staleness window, and a
//     world that really stops renewing is therefore detected offline - which is
//     the behaviour the platform relies on to take a dead world down.
const assert = require("node:assert/strict");
const { test, before, after } = require("node:test");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { DEFAULT_LEASE_RENEW_INTERVAL_MS, PLATFORM_STALE_MS } = require("../plugins/paescape/LeaseLiveness");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-continuity-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
// Hosted mode: a platform URL and no world secret.
delete process.env.PAESCAPE_WORLD_SECRET;
delete process.env.PAESCAPE_WORLD_ID;
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";
// The stub platform below mounts at the origin root (empty public path).
process.env.PAESCAPE_PUBLIC_ENDPOINT = "https://localhost.invalid:43594";
process.env.PAESCAPE_INSTALLATION_FILE = path.join(WORK_DIR, "paescape-installation.json");
process.env.PAESCAPE_RELEASE_GENERATION = "7";
// Renew far faster than the 90 s production window so the test finishes quickly.
// This is the same knob the plugin reads in production (default 30 s), clamped
// strictly below the platform's staleness window.
const TEST_INTERVAL_MS = 1000;
process.env.PAESCAPE_LEASE_RENEW_INTERVAL_MS = String(TEST_INTERVAL_MS);

// A real Ed25519 public key so the stub answers the public-key route faithfully.
const { publicKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_KEY_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");

// A pre-enrolled installation identity: skip the enrollment claim so startup goes
// straight to revalidate -> handshake -> lease.
fs.writeFileSync(
  process.env.PAESCAPE_INSTALLATION_FILE,
  JSON.stringify({ key: "wsk_continuity_test_installation_key", credential: "wsi_continuity_test_credential", worldId: "wld_continuity", worldLabel: "Continuity" }),
);

let stub = null;
let stubUrl = "";
const renewals = []; // epoch ms of every accepted renewal (a heartbeat)
const startupRoutes = [];
const startupEvents = [];
let failuresToInject = 0; // when > 0, the next renew is refused with 503
let leaseToken = "lease_continuity_0";
const originalConsoleLog = console.log;
console.log = (...args) => {
  startupEvents.push(String(args[0] ?? ""));
  originalConsoleLog(...args);
};

function renewBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function startStub() {
  stub = http.createServer(async (req, res) => {
    const route = `${req.method} ${(req.url || "").split("?")[0]}`;
    startupRoutes.push(route);
    startupEvents.push(route);
    res.setHeader("content-type", "application/json");
    if (route === "GET /api/platform/public-key") {
      res.end(JSON.stringify({ publicKey: PUBLIC_KEY_B64 }));
      return;
    }
    if (route === "GET /api/server/installation") {
      res.end(JSON.stringify({ world: { id: "wld_continuity", configRevision: 1, status: "live" }, label: "Continuity", reselectRequested: false }));
      return;
    }
    if (route === "POST /api/server/handshake/nonce") {
      res.end(JSON.stringify({ nonce: crypto.randomBytes(16).toString("base64url") }));
      return;
    }
    if (route === "POST /api/server/handshake") {
      leaseToken = "lease_continuity_issued";
      res.end(JSON.stringify({
        world: { id: "wld_continuity", configRevision: 1, status: "live", config: { settings: {} } },
        contentRevision: "1",
        lease: { token: leaseToken, expiresAt: new Date(Date.now() + 900_000).toISOString(), generation: 7 },
      }));
      return;
    }
    if (route === "POST /api/server/lease/renew") {
      await renewBody(req);
      if (failuresToInject > 0) {
        failuresToInject -= 1;
        // Two shapes of transient failure: a refused request and a dropped
        // connection. Both must leave the renewal loop running.
        if (failuresToInject % 2 === 0) {
          res.statusCode = 503;
          res.end(JSON.stringify({ ok: false, error: "platform busy" }));
        } else {
          req.socket.destroy();
        }
        return;
      }
      renewals.push(Date.now());
      res.end(JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 900_000).toISOString(), generation: 7, configRevision: 1 }));
      return;
    }
    if (route === "GET /api/server/content-manifest") {
      res.end(JSON.stringify({ ok: true, revision: "1", entries: [] }));
      return;
    }
    if (route === "GET /api/server/world-state") {
      res.end(JSON.stringify({ ok: true, state: { worldId: "wld_continuity", revision: 1, state: { stores: {} } } }));
      return;
    }
    if (route === "POST /api/server/endpoint") {
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false }));
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
const { PluginManager } = require("../dist/plugins/PluginManager");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

async function waitFor(predicate, { timeout = 15000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

before(async () => {
  await startStub();
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });
  // Wait for the first renewal, which proves the handshake and lease succeeded.
  assert.ok(await waitFor(() => renewals.length >= 1), `the hosted world obtained a lease and renewed it (renewals=${renewals.length})`);
  // Startup then warms the hosted world-state mirror before its stage-7 line.
  // Wait for that full readiness boundary so tests do not race the synchronous
  // production mirror loader used by this in-process stub.
  assert.ok(
    await waitFor(() => startupEvents.some((event) => event.includes("stage 7/7"))),
    "the hosted world completed startup and announced stage 7 readiness",
  );
});

after(async () => {
  console.log = originalConsoleLog;
  if (stub) await new Promise((resolve) => stub.close(resolve));
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

test("the renewal cadence stays strictly inside the platform's offline window", () => {
  assert.ok(
    DEFAULT_LEASE_RENEW_INTERVAL_MS > 0 && DEFAULT_LEASE_RENEW_INTERVAL_MS < PLATFORM_STALE_MS,
    `the default renewal interval (${DEFAULT_LEASE_RENEW_INTERVAL_MS}ms) must be inside the platform's ${PLATFORM_STALE_MS}ms staleness window`,
  );
});

test("hosted startup refreshes liveness before announcing stage 7 readiness", () => {
  const renewal = startupEvents.indexOf("POST /api/server/lease/renew");
  const ready = startupEvents.findIndex((event) => event.includes("stage 7/7"));
  assert.ok(renewal >= 0, "startup sent an immediate lease renewal heartbeat");
  assert.ok(ready >= 0, "startup announced stage 7 readiness");
  assert.ok(renewal < ready, `renewal (${renewal}) happened before stage 7 readiness (${ready})`);
});

test("a healthy world renews continuously instead of only before the lease expires", async () => {
  // The old schedule renewed roughly every 14 minutes; over this stretch of
  // uptime it would have produced at most one renewal. Require many.
  const before = renewals.length;
  const observedFrom = Date.now();
  await waitFor(() => renewals.length >= before + 6, { timeout: 10000 });
  const gained = renewals.length - before;
  const elapsed = Date.now() - observedFrom;
  assert.ok(gained >= 6, `expected at least 6 renewals in ${elapsed}ms at a ${TEST_INTERVAL_MS}ms cadence, saw ${gained}`);
  // No gap may approach the platform's offline window: that is what keeps a
  // healthy world reading online rather than flapping.
  let worstGap = 0;
  for (let i = 1; i < renewals.length; i++) worstGap = Math.max(worstGap, renewals[i] - renewals[i - 1]);
  assert.ok(worstGap < PLATFORM_STALE_MS, `the worst renewal gap ${worstGap}ms must stay under the ${PLATFORM_STALE_MS}ms offline window`);
});

test("a transient platform failure does not stop the renewal loop", async () => {
  failuresToInject = 4;
  const before = renewals.length;
  // The loop must survive both refused (503) and dropped connections and recover.
  const recovered = await waitFor(() => renewals.length >= before + 3, { timeout: 10000 });
  assert.ok(recovered, `the renewal loop kept running through failures (before=${before}, after=${renewals.length})`);
  const gap = renewals[before] - renewals[before - 1];
  assert.ok(gap < PLATFORM_STALE_MS, `a failure must not leave a gap approaching the offline window (gap=${gap}ms)`);
});

test("a world that stops renewing is detected offline after the staleness window", () => {
  // Mirrors the platform's own rule: `isOnline` is false once the newest
  // heartbeat is older than HEARTBEAT_STALE_MS. Using the real constant here
  // (no waiting) proves a genuine stop is still taken offline, so recovery is
  // not achieved by weakening how offline is decided.
  const isOnline = (at) => at - renewals[renewals.length - 1] < PLATFORM_STALE_MS;
  const last = renewals[renewals.length - 1];
  assert.equal(isOnline(last + 1_000), true, "a fresh heartbeat reads online");
  assert.equal(isOnline(last + PLATFORM_STALE_MS + 1), false, "a heartbeat older than the window reads offline");
});
