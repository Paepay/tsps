// Run from server/: node --test tests/paescape-restart-control.test.cjs
//
// Issue 50: a dashboard restart is one signed, platform-scoped control call that
// must pause new logins, run a protected five-minute countdown, log out and save
// every online account, and leave evidence the platform can verify before it
// reopens the world. These pin the control-route contract without a live platform.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { test, beforeEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { _test } = require("../plugins/paescape/PaeScape.plugin");

const WORLD_ID = "wld_official_paescape";
const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");

function token(action, overrides = {}) {
  const payload = Buffer.from(JSON.stringify({
    worldId: WORLD_ID,
    action,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  })).toString("base64url");
  const signature = crypto.sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64");
  return `Bearer ${payload}.${signature}`;
}

function request({ action = "world:restart", authorization, body, method = "POST", path = "/api/platform/restart" }) {
  // undefined means "a correct token"; null means "send no authorization header".
  const header = authorization === undefined ? token(action) : authorization;
  return {
    method,
    path,
    headers: header === null ? {} : { authorization: header },
    body: body === undefined ? JSON.stringify({ seconds: 300, requestId: "rst_test0001" }) : body,
  };
}

let players;
let emitted;

function configure({ accept = true, worldSecret = "", lifecycleReporter, publicKeyFetcher = null } = {}) {
  players = [];
  emitted = [];
  _test.configureControlForTests({
    publicKey,
    worldId: WORLD_ID,
    worldSecret,
    lifecycleReporter,
    publicKeyFetcher,
    restartState: { active: false, state: "ready", requestId: null, outcome: null },
    api: {
      core: { World: { getPlayers: () => players } },
      emitCustomEvent: (name, event) => {
        emitted.push({ name, event });
        if (name === "GameUpdate:start" && accept) event.accepted = true;
      },
    },
  });
}

beforeEach(() => configure());

test("hosted worlds report through the lease and configured worlds through the credential", () => {
  configure({ worldSecret: "" });
  assert.equal(_test.lifecycleHeartbeatChannel(), "lease");
  configure({ worldSecret: "world-secret" });
  assert.equal(_test.lifecycleHeartbeatChannel(), "credential");
});

test("accepting a restart reports through the active lifecycle channel", async () => {
  let reports = 0;
  configure({ lifecycleReporter: () => { reports += 1; } });
  const result = await _test.handleControl(request({}));
  assert.equal(result.status, 202);
  assert.equal(reports, 1, "a hosted acceptance must not call the credential heartbeat");
});

test("a replacement process acknowledges the adopted request on its lifecycle channel", async () => {
  let reports = 0;
  configure({ lifecycleReporter: () => { reports += 1; } });
  _test.applyRestartDirective({ ok: true, json: { restart: { active: true, requestId: "rst_replacement1" } } });
  assert.equal(reports, 0);
  await new Promise((resolve) => setTimeout(resolve, 900));
  assert.equal(reports, 1, "the follow-up ready report must use the hosted lease channel");
});

test("without a cached public key the control API refuses with 503 and does not begin a restart", async () => {
  configure();
  _test.configureControlForTests({
    publicKey: null,
    publicKeyFetcher: async () => false,
  });
  const result = await _test.handleControl(request({}));
  assert.equal(result.status, 503);
  assert.match(result.body.error, /public key/i);
  assert.equal(_test.restartState().active, false);
  assert.equal(emitted.length, 0);
  const health = await _test.handleControl({ method: "GET", path: "/api/platform/health", headers: {}, body: "" });
  assert.equal(health.body.controlKeyLoaded, false);
});

test("a missing public key is fetched before control auth so a dashboard restart can recover", async () => {
  configure();
  let fetches = 0;
  _test.configureControlForTests({
    publicKey: null,
    publicKeyFetcher: async () => {
      fetches += 1;
      _test.configureControlForTests({ publicKey });
      return true;
    },
  });
  const result = await _test.handleControl(request({}));
  assert.equal(fetches, 1);
  assert.equal(result.status, 202);
  assert.equal(_test.hasPublicKey(), true);
  assert.equal(_test.restartState().active, true);
});

test("a correctly signed world:restart token is accepted and pauses logins", async () => {
  const result = await _test.handleControl(request({}));
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { ok: true, accepted: true, seconds: 300, requestId: "rst_test0001" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].name, "GameUpdate:start");
  assert.equal(emitted[0].event.seconds, 300);
  assert.equal(emitted[0].event.id, "rst_test0001");
  assert.equal(emitted[0].event.cancellable, false, "an operator restart cannot be cancelled in game");
  const state = _test.restartState();
  assert.equal(state.active, true);
  assert.equal(state.state, "maintenance");
  assert.equal(state.requestId, "rst_test0001");

  const health = await _test.handleControl({ method: "GET", path: "/api/platform/health", headers: {}, body: "" });
  assert.equal(health.status, 200);
  assert.equal(health.body.maintenance, true);
  assert.equal(health.body.restartRequestId, "rst_test0001");
});

test("missing, forged, expired, wrong-action and wrong-world tokens are refused", async () => {
  const forgedPayload = Buffer.from(JSON.stringify({ worldId: WORLD_ID, action: "world:restart", exp: Math.floor(Date.now() / 1000) + 60 })).toString("base64url");
  const cases = [
    { name: "missing", authorization: null },
    { name: "forged", authorization: `Bearer ${forgedPayload}.${Buffer.from("not a signature").toString("base64")}` },
    { name: "expired", authorization: token("world:restart", { exp: Math.floor(Date.now() / 1000) - 1 }) },
    { name: "wrong action", authorization: token("character:create") },
    { name: "wrong world", authorization: token("world:restart", { worldId: "wld_someone_else" }) },
  ];
  for (const testCase of cases) {
    configure();
    const result = await _test.handleControl(request({ authorization: testCase.authorization }));
    assert.equal(result.status, 401, `${testCase.name} token must be refused`);
    assert.equal(_test.restartState().active, false, `${testCase.name} token must not begin a restart`);
    assert.equal(emitted.length, 0);
  }
});

test("the countdown is exactly five minutes and the request id must be a restart id", async () => {
  for (const seconds of [0, 60, 299, 301, 600]) {
    configure();
    const result = await _test.handleControl(request({ body: JSON.stringify({ seconds, requestId: "rst_test0001" }) }));
    assert.equal(result.status, 400, `${seconds} seconds must be refused`);
    assert.equal(emitted.length, 0);
  }
  for (const requestId of ["", "restart-1", "rst_", "rst_has space", "other_12345678"]) {
    configure();
    const result = await _test.handleControl(request({ body: JSON.stringify({ seconds: 300, requestId }) }));
    assert.equal(result.status, 400, `request id ${JSON.stringify(requestId)} must be refused`);
    assert.equal(emitted.length, 0);
  }
});

test("a second restart while one is active is refused", async () => {
  const first = await _test.handleControl(request({}));
  assert.equal(first.status, 202);
  const second = await _test.handleControl(request({ body: JSON.stringify({ seconds: 300, requestId: "rst_second001" }) }));
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already in progress/);
  assert.equal(emitted.length, 1);
});

test("a countdown that the world refuses leaves logins open", async () => {
  configure({ accept: false });
  const result = await _test.handleControl(request({}));
  assert.equal(result.status, 409);
  assert.equal(_test.restartState().active, false);
  assert.equal(_test.restartState().outcome, "failed");
});

test("new logins and ticket redemptions are refused while the restart is pending", async () => {
  await _test.handleControl(request({}));
  const rejected = [];
  const login = await _test.preAuthenticate({ typedName: "player", password: "x" }, {
    reject: (code, reason) => rejected.push({ code, reason }),
  });
  assert.equal(login, undefined);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].code, 4);
  assert.match(rejected[0].reason, /restarting/);

  const refused = {};
  const redeemed = await _test.redeemLoginTicket("A".repeat(40), true, refused);
  assert.equal(redeemed.ok, false);
  assert.equal(refused.code, 4);
  assert.match(refused.reason, /restarting/);
});

test("at shutdown every online account is told, logged out and its progress is kept for persistence", async () => {
  const messages = [];
  const loggedOut = [];
  players.push(
    { sendMessage: (message) => messages.push(`one:${message}`), requestLogout: () => loggedOut.push("one") },
    { sendMessage: (message) => messages.push(`two:${message}`), requestLogout: () => loggedOut.push("two") },
  );
  await _test.handleControl(request({}));
  const event = emitted[0].event;
  assert.equal(typeof event.beforeShutdown, "function");
  event.beforeShutdown();
  assert.deepEqual(loggedOut, ["one", "two"]);
  assert.equal(messages.length, 2);
  assert.ok(messages.every((message) => /progress is being saved/.test(message)));
});

test("one failing logout does not stop the remaining accounts from being logged out", async () => {
  const loggedOut = [];
  players.push(
    { sendMessage() { throw new Error("broken pipe"); }, requestLogout: () => loggedOut.push("one") },
    { sendMessage() {}, requestLogout: () => loggedOut.push("two") },
  );
  await _test.handleControl(request({}));
  assert.doesNotThrow(() => emitted[0].event.beforeShutdown());
  assert.deepEqual(loggedOut, ["two"]);
});

test("a cancelled restart reports its outcome and reopens logins", async () => {
  await _test.handleControl(request({}));
  emitted[0].event.onCancelled("test cancellation");
  const state = _test.restartState();
  assert.equal(state.active, false);
  assert.equal(state.outcome, "cancelled");
  assert.equal(state.requestId, "rst_test0001", "the platform must be able to match the cancellation");
  const rejected = [];
  const login = await _test.preAuthenticate({ typedName: "player", password: "x" }, {
    reject: (code, reason) => rejected.push({ code, reason }),
  });
  assert.equal(login, undefined);
  assert.equal(rejected.length, 0, "logins are open again");
});

test("a replacement process adopts the active request id and then reports ready", () => {
  configure();
  _test.applyRestartDirective({ ok: true, json: { restart: { active: true, requestId: "rst_replacement1" } } });
  assert.deepEqual(_test.restartState(), {
    active: false,
    state: "ready",
    requestId: "rst_replacement1",
    outcome: null,
  });
  _test.applyRestartDirective({ ok: true, json: { restart: { active: false } } });
  assert.deepEqual(_test.restartState(), { active: false, state: "ready", requestId: null, outcome: null });
});

test("an unrelated control route still needs a token and a restart is not acknowledged by a GET", async () => {
  const denied = await _test.handleControl({ method: "POST", path: "/api/platform/characters", headers: {}, body: "{}" });
  assert.equal(denied.status, 401);
  const get = await _test.handleControl(request({ method: "GET", path: "/api/platform/restart", authorization: null }));
  assert.equal(get.status, 401);
  assert.equal(_test.restartState().active, false);
});

test("a correctly signed world:stop is accepted with a fixed five-minute exit-75 countdown", async () => {
  const result = await _test.handleControl(request({
    action: "world:stop",
    path: "/api/platform/stop",
    body: JSON.stringify({ seconds: 300, requestId: "stp_test0001" }),
  }));
  assert.equal(result.status, 202);
  assert.deepEqual(result.body, { ok: true, accepted: true, seconds: 300, requestId: "stp_test0001" });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].event.seconds, 300);
  assert.equal(emitted[0].event.exitCode, 75);
  assert.equal(emitted[0].event.exitCode, Server.EXIT_OPERATOR_STOP);
  assert.equal(emitted[0].event.cancellable, false);
  assert.equal(_test.restartState().state, "stopping");
});

test("stop tokens are action-bound and stop needs exactly 300 seconds and a stp request id", async () => {
  const restartTokenOnStop = await _test.handleControl(request({
    action: "world:restart",
    path: "/api/platform/stop",
    body: JSON.stringify({ seconds: 300, requestId: "stp_test0001" }),
  }));
  assert.equal(restartTokenOnStop.status, 401);
  for (const seconds of [0, 299, 301, 600]) {
    configure();
    const result = await _test.handleControl(request({
      action: "world:stop",
      path: "/api/platform/stop",
      body: JSON.stringify({ seconds, requestId: "stp_test0001" }),
    }));
    assert.equal(result.status, 400, `${seconds} seconds must be refused`);
  }
  for (const requestId of ["", "rst_test0001", "stp_", "stp_has space"]) {
    configure();
    const result = await _test.handleControl(request({
      action: "world:stop",
      path: "/api/platform/stop",
      body: JSON.stringify({ seconds: 300, requestId }),
    }));
    assert.equal(result.status, 400, `request id ${JSON.stringify(requestId)} must be refused`);
  }
});

test("a stopped world pauses logins with shutdown wording and logs out every player", async () => {
  const messages = [];
  const loggedOut = [];
  players.push(
    { sendMessage: (message) => messages.push(message), requestLogout: () => loggedOut.push("one") },
    { sendMessage: () => {}, requestLogout: () => loggedOut.push("two") },
  );
  await _test.handleControl(request({
    action: "world:stop",
    path: "/api/platform/stop",
    body: JSON.stringify({ seconds: 300, requestId: "stp_test0001" }),
  }));
  const rejected = [];
  await _test.preAuthenticate({ typedName: "player", password: "x" }, {
    reject: (code, reason) => rejected.push({ code, reason }),
  });
  assert.equal(rejected[0].code, 4);
  assert.match(rejected[0].reason, /shutting down/i);
  emitted[0].event.beforeShutdown();
  assert.deepEqual(loggedOut, ["one", "two"]);
  assert.ok(messages.some((message) => /server is stopping/i.test(message)));
});

test("a stop cannot be cancelled in game, but a failed shutdown reports cancellation", async () => {
  await _test.handleControl(request({
    action: "world:stop",
    path: "/api/platform/stop",
    body: JSON.stringify({ seconds: 300, requestId: "stp_test0001" }),
  }));
  emitted[0].event.onCancelled("persistence failed");
  const state = _test.restartState();
  assert.equal(state.active, false);
  assert.equal(state.outcome, "cancelled");
  assert.equal(state.requestId, "stp_test0001");
});

test("a replacement process does not adopt a stop directive as a restart", () => {
  configure();
  _test.applyRestartDirective({ ok: true, json: { restart: { active: true, action: "stop", requestId: "stp_replacement1" } } });
  assert.deepEqual(_test.restartState(), { active: false, state: "ready", requestId: null, outcome: null });
});

test("the official systemd units prevent automatic restart after exit 75", () => {
  for (const unit of ["paescape-official.service", "paescape-official.user.service"]) {
    const text = fs.readFileSync(path.join(__dirname, "..", "deploy", "systemd", unit), "utf8");
    assert.match(text, /^RestartPreventExitStatus=75$/m, unit);
    assert.match(text, /^SuccessExitStatus=0 75$/m, unit);
  }
});
