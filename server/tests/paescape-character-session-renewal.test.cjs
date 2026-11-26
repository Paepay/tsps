"use strict";

// Run from server/ after `yarn build`:
//   node --test tests/paescape-character-session-renewal.test.cjs
//
// A hosted character session is the platform's live gameplay lease. The server
// renews it on a short cadence, and only the platform's explicit 409 may end a
// player's login. This regression test pins the reconnect behaviour: a refused
// or dropped renewal is retried, a superseded timer cannot end the login that
// replaced it, and an authoritative revocation logs out exactly once.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { test, before, after } = require("node:test");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-session-renewal-"));
process.env.TSPS_ACCOUNTS_FILE = path.join(WORK_DIR, "accounts.json");
process.env.TSPS_DISPLAY_NAMES_FILE = path.join(WORK_DIR, "display-names.json");
// Production routes renew every 30 s. Tests use the same code path at a 1 s
// cadence so a transient failure and recovery finish quickly.
process.env.PAESCAPE_CHARACTER_SESSION_RENEW_INTERVAL_MS = "1000";

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const PaeScape = require("../plugins/paescape/PaeScape.plugin");
const {
  DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS,
  PLATFORM_SESSION_RECLAIM_MS,
  characterSessionRenewIntervalMs,
  characterSessionRetryDelayMs,
  isAuthoritativeCharacterSessionRefusal,
} = require("../plugins/paescape/CharacterSessionLiveness");

const RENEW_PATH = /^\/api\/server\/character-sessions\/([^/]+)\/renew$/;
const sessionBehaviors = new Map();
const renewalAttempts = new Map();
const renewalSuccesses = new Map();
const endedSessions = new Map();
const players = new Map();

let stub = null;
let stubUrl = "";
let sessionSequence = 0;
let nextBehaviors = [];

function makePlayer(name) {
  const player = {
    logoutCalls: 0,
    requestLogout() {
      this.logoutCalls += 1;
    },
  };
  players.set(name, player);
  return player;
}

function queueNextSession(behaviors) {
  nextBehaviors = behaviors.slice();
}

function attemptsFor(token) {
  return renewalAttempts.get(token) ?? 0;
}

function successesFor(token) {
  return renewalSuccesses.get(token) ?? 0;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function startStub() {
  stub = http.createServer(async (req, res) => {
    const pathname = (req.url || "").split("?")[0];
    await readBody(req);
    res.setHeader("content-type", "application/json");

    if (req.method === "POST" && pathname === "/api/server/character-sessions") {
      sessionSequence += 1;
      const token = `session_test_${sessionSequence}`;
      sessionBehaviors.set(token, nextBehaviors);
      nextBehaviors = [];
      res.statusCode = 201;
      res.end(JSON.stringify({
        ok: true,
        token,
        session: { expiresAt: new Date(Date.now() + 900_000).toISOString() },
      }));
      return;
    }

    const renewal = RENEW_PATH.exec(pathname);
    if (req.method === "POST" && renewal) {
      const token = decodeURIComponent(renewal[1]);
      renewalAttempts.set(token, attemptsFor(token) + 1);
      const behavior = sessionBehaviors.get(token)?.shift?.() ?? {};
      if (behavior.drop) {
        req.socket.destroy();
        return;
      }
      if (behavior.status) {
        res.statusCode = behavior.status;
        res.end(JSON.stringify({ ok: false, error: behavior.error ?? "platform failure" }));
        return;
      }
      renewalSuccesses.set(token, successesFor(token) + 1);
      res.end(JSON.stringify({ ok: true, expiresAt: new Date(Date.now() + 900_000).toISOString() }));
      return;
    }

    const ended = /^\/api\/server\/character-sessions\/([^/]+)$/.exec(pathname);
    if (req.method === "DELETE" && ended) {
      const token = decodeURIComponent(ended[1]);
      const reason = new URL(req.url, "http://stub").searchParams.get("reason") ?? "logout";
      endedSessions.set(token, reason);
      res.end(JSON.stringify({ ok: true, ended: true }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: "not found" }));
  });
  return new Promise((resolve) => {
    stub.listen(0, "127.0.0.1", () => {
      stubUrl = `http://127.0.0.1:${stub.address().port}`;
      resolve();
    });
  });
}

async function waitFor(predicate, { timeout = 6000, step = 25 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, step));
  }
  return predicate();
}

before(async () => {
  await startStub();
  const testApi = {
    core: {
      World: {
        getPlayerByName: (name) => players.get(name),
      },
    },
  };
  PaeScape._test.configureCharacterSessionsForTests({
    platformUrl: stubUrl,
    lease: { token: "lease_test", expiresAt: Date.now() + 900_000, generation: 1 },
    api: testApi,
    clear: true,
  });
});

after(async () => {
  PaeScape._test.configureCharacterSessionsForTests({ clear: true });
  if (stub) {
    stub.closeAllConnections?.();
    await new Promise((resolve) => stub.close(resolve));
  }
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
});

test("session renewal stays inside the platform's reclaim window", () => {
  assert.ok(DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS > 0);
  assert.ok(DEFAULT_CHARACTER_SESSION_RENEW_INTERVAL_MS < PLATFORM_SESSION_RECLAIM_MS);
  assert.equal(characterSessionRenewIntervalMs(), 1000, "the test cadence is applied");
  assert.equal(characterSessionRetryDelayMs(1), 500);
  assert.equal(characterSessionRetryDelayMs(2), 1000);
  assert.equal(isAuthoritativeCharacterSessionRefusal(409), true);
  assert.equal(isAuthoritativeCharacterSessionRefusal(429), false);
  assert.equal(isAuthoritativeCharacterSessionRefusal(503), false);
});

test("a refused or dropped renewal retries and keeps the player logged in", async () => {
  queueNextSession([{ status: 503, error: "platform busy" }, { drop: true }]);
  const player = makePlayer("Transient Hero");
  const issued = await PaeScape._test.startCharacterSession("transient", "char-transient", "Transient Hero");

  assert.ok(await waitFor(() => attemptsFor(issued.token) >= 2), "both failed renewal attempts were made");
  assert.equal(player.logoutCalls, 0, "a transient failure never ends the login");
  assert.equal(PaeScape._test.characterSessionForTests("transient")?.token, issued.token);

  assert.ok(await waitFor(() => successesFor(issued.token) >= 1), "a later renewal recovered the session");
  assert.equal(player.logoutCalls, 0, "recovery leaves the player connected");
  assert.equal(PaeScape._test.characterSessionForTests("transient")?.token, issued.token);
});

test("an authoritative 409 revokes the session and logs out exactly once", async () => {
  queueNextSession([{ status: 409, error: "This gameplay session is no longer active." }]);
  const player = makePlayer("Revoked Hero");
  const issued = await PaeScape._test.startCharacterSession("revoked", "char-revoked", "Revoked Hero");

  assert.ok(await waitFor(() => player.logoutCalls === 1), "the revoked session logged the player out");
  assert.equal(PaeScape._test.characterSessionForTests("revoked"), null);
  await new Promise((resolve) => setTimeout(resolve, 1200));
  assert.equal(player.logoutCalls, 1, "the ended session did not log the player out again");
  assert.equal(attemptsFor(issued.token), 1, "an authoritative revocation is not retried");
});

test("a superseded session cannot delete or log out the newer login", async () => {
  const player = makePlayer("Replacement Hero");
  const old = await PaeScape._test.startCharacterSession("replacement", "char-old", "Replacement Hero");
  const current = await PaeScape._test.startCharacterSession("replacement", "char-current", "Replacement Hero");
  assert.notEqual(current.token, old.token);
  const attemptsBefore = attemptsFor(old.token);

  await PaeScape._test.renewCharacterSession(old);

  assert.equal(attemptsFor(old.token), attemptsBefore, "the stale renewal did not reach the platform");
  assert.equal(player.logoutCalls, 0, "the stale timer did not log out the replacement login");
  assert.equal(PaeScape._test.characterSessionForTests("replacement")?.token, current.token);
});

test("a replaced login ends its own lease and leaves the live one alone", async () => {
  endedSessions.clear();
  const oldPlayer = makePlayer("Reconnect");
  const old = await PaeScape._test.startCharacterSession("reconnect", "char-reconnect", "Reconnect");
  PaeScape._test.bindCharacterSessionPlayer("Reconnect", oldPlayer);

  const livePlayer = makePlayer("Reconnect");
  const live = await PaeScape._test.startCharacterSession("reconnect", "char-reconnect", "Reconnect");
  PaeScape._test.bindCharacterSessionPlayer("Reconnect", livePlayer);

  assert.ok(await waitFor(() => endedSessions.get(old.token) === "superseded"), "the replaced lease was ended");
  await PaeScape._test.closeCharacterSession({ player: oldPlayer, username: "Reconnect" });
  assert.equal(endedSessions.get(live.token), undefined, "the replaced login did not end the live session");
  assert.equal(PaeScape._test.characterSessionForTests("reconnect")?.token, live.token);
  assert.equal(livePlayer.logoutCalls, 0);

  await PaeScape._test.closeCharacterSession({ player: livePlayer, username: "Reconnect" });
  assert.equal(endedSessions.get(live.token), "logout", "the live login's own logout still ends its lease");
  assert.equal(PaeScape._test.characterSessionForTests("reconnect"), null);
});
