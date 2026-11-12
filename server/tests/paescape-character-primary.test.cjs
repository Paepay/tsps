// Run from server/ after `npx tsc --build`: node --test tests/paescape-character-primary.test.cjs
//
// Issue #16: the website offered Delete on the account's *first* (primary)
// character, which always fails. The runtime rule is deliberate and documented
// (docs/character-slots.md): the primary save holds the account credential
// (login name, password hash, remembered logins), so it cannot be deleted. The
// fix keeps that rule and makes the world *report* it, so the platform and
// website can stop offering the action instead of masking the refusal.
//
// This drives the real PaeScape plugin's control API against a stub platform and
// pins the contract the platform now relies on:
//   - GET  /api/platform/characters/:name/summary reports character.primary;
//   - POST /api/platform/characters/:name refuses the primary with 409 and the
//     player-facing message, and still deletes an alt;
//   - the control token stays scoped to one action.
// Configured mode (a world secret) is used because it needs no enrollment.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-primary-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
process.env.PAESCAPE_WORLD_SECRET = "test-world-secret";
process.env.PAESCAPE_WORLD_ID = "wld_primary_issue16";
delete process.env.PAESCAPE_INSTALLATION_FILE;
delete process.env.PAESCAPE_PUBLIC_ENDPOINT;
// The stub platform mounts at the origin root; tell the plugin so it does not
// prefix /platform.
process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "";
// The plugin writes data/paescape-users.json relative to the working directory;
// before() switches there so a test run never writes into the checkout. The
// engine modules resolved their own paths from the checkout root at require time.
const ORIGINAL_CWD = process.cwd();

// A real Ed25519 keypair: the stub publishes the public key, the test signs the
// control tokens with the private key, exactly as the platform does.
const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const PUBLIC_KEY_B64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
const WORLD_ID = process.env.PAESCAPE_WORLD_ID;

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
        res.end(JSON.stringify({ publicKey: PUBLIC_KEY_B64 }));
        return;
      }
      if (route === "POST /api/world/auth") {
        res.end(JSON.stringify({
          token: "test-session",
          expiresAt: new Date(Date.now() + 900_000).toISOString(),
          world: { id: WORLD_ID, name: "Primary Delete World", status: "live", configRevision: 1, config: { settings: {} } },
          limits: { maxCharactersPerUser: 3 },
        }));
        return;
      }
      if (route === "POST /api/world/heartbeat") {
        res.end(JSON.stringify({ ok: true, configRevision: 1, restartRequired: false }));
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
const { PluginManager } = require("../dist/plugins/PluginManager");
const PaeScape = require("../plugins/paescape/PaeScape.plugin");

/** A platform control token scoped to one action and this world, as the platform signs it. */
function controlToken(action) {
  const claims = {
    worldId: WORLD_ID,
    action,
    exp: Math.floor(Date.now() / 1000) + 120,
    nonce: crypto.randomBytes(8).toString("base64url"),
  };
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return `Bearer ${payload}.${signature}`;
}

function control(method, controlPath, { action, body, authorization } = {}) {
  return PluginManager.handlePlatformControl({
    method,
    path: controlPath,
    headers: { authorization: authorization ?? controlToken(action) },
    body: body === undefined ? "" : JSON.stringify(body),
  });
}

const create = (name, userId) => control("POST", "/api/platform/characters", { action: "character:create", body: { name, userId } });
const summary = (name) => control("GET", `/api/platform/characters/${name}/summary`, { action: "character:summary" });
const remove = (name) => control("POST", `/api/platform/characters/${name}`, { action: "character:delete", body: { confirmName: name } });

before(async () => {
  await startStub();
  process.chdir(WORK_DIR);
  PaeScape.register(PluginManager.createApi("PaeScape"));
  PluginManager.emitServerStartup({ timestamp: Date.now() });
  // The control handler is registered synchronously; the configured startup chain
  // caches the platform's control public key a moment later. Until it does, every
  // signed call is a 401. Poll a deliberately invalid create (a 400, never a
  // write) until it stops being a 401, which proves the key is cached.
  const deadline = Date.now() + 20000;
  for (;;) {
    const probe = await control("POST", "/api/platform/characters", { action: "character:create", body: { name: "", userId: "probe" } });
    if (probe && probe.status !== 401) break;
    if (Date.now() > deadline) throw new Error("the plugin never cached the platform control public key");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});

after(async () => {
  process.chdir(ORIGINAL_CWD);
  if (stub) await new Promise((resolve) => stub.close(resolve));
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

test("the account's first character is reported as the primary", async () => {
  const first = await create("Tester", "u1");
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.character.primary, true, "the first character created for a platform user is the primary");
});

test("a later character on the same account is not the primary", async () => {
  const alt = await create("Second", "u1");
  assert.equal(alt.status, 201, JSON.stringify(alt.body));
  assert.equal(alt.body.character.primary, false, "an alt is not the primary");
});

test("the authoritative summary reports which character is primary", async () => {
  const first = await summary("Tester");
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.character.primary, true);
  const alt = await summary("Second");
  assert.equal(alt.status, 200, JSON.stringify(alt.body));
  assert.equal(alt.body.character.primary, false);
});

test("the world refuses to delete the primary character with 409 and a clear message", async () => {
  const refused = await remove("Tester");
  assert.equal(refused.status, 409, "the primary cannot be deleted");
  assert.match(String(refused.body.error), /first character on this world can't be deleted/i);
  // It is still there: a refused delete must not release the record.
  const still = await summary("Tester");
  assert.equal(still.status, 200);
});

test("a non-primary character is still deleted", async () => {
  const deleted = await remove("Second");
  assert.equal(deleted.status, 200, JSON.stringify(deleted.body));
  assert.equal(deleted.body.ok, true);
  const gone = await summary("Second");
  assert.equal(gone.status, 404, "the deleted character is no longer registered");
});

test("the primary is refused even when it is the account's only character, and the account stays usable", async () => {
  // "Only character" is the deleted-the-last-character case option 3 must also
  // define: the refusal is still the same 409 and the account (its primary, and
  // therefore its login) is untouched.
  const only = await create("Solo", "u2");
  assert.equal(only.status, 201, JSON.stringify(only.body));
  assert.equal(only.body.character.primary, true);
  const refused = await remove("Solo");
  assert.equal(refused.status, 409);
  assert.match(String(refused.body.error), /first character on this world can't be deleted/i);
  // The account and its primary survive: the summary still resolves and login is intact.
  const still = await summary("Solo");
  assert.equal(still.status, 200);
  assert.equal(still.body.character.primary, true);
  const alt = await create("SoloAlt", "u2");
  assert.equal(alt.status, 201, "the account can still add a character");
  assert.equal(alt.body.character.primary, false);
});

test("a control token scoped to another action is refused", async () => {
  const wrongAction = await control("POST", "/api/platform/characters/Tester", { action: "character:summary", body: { confirmName: "Tester" } });
  assert.equal(wrongAction.status, 401, "a token minted for a different action must not authorise a delete");
});

test("a delete whose confirmation name does not match is refused", async () => {
  const created = await create("Third", "u1");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const mismatch = await control("POST", "/api/platform/characters/Third", { action: "character:delete", body: { confirmName: "NotThird" } });
  assert.equal(mismatch.status, 400);
  assert.equal((await remove("Third")).status, 200);
});
