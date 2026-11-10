// Run from server/: node --test tests/paescape-authorization-gate.test.cjs
//
// The authorization gate is what stops hosted worlds spawning player bots (whose
// name checks read platform-backed persistence) before the enrollment handshake
// yields a lease. These pin its decisions without a live platform.
const assert = require("node:assert/strict");
const { test, beforeEach } = require("node:test");

const bridge = require("../plugins/paescape/PaeScapeBridge.js");
const gate = require("../plugins/paescape/AuthorizationGate.js");

beforeEach(() => {
  gate.setHostedProbe(false);
  bridge.setAuthorized(false);
});

test("a standalone world is never blocked and runs callbacks immediately", () => {
  gate.setHostedProbe(false);
  assert.equal(gate.isBlocked(), false);
  let ran = 0;
  gate.whenAuthorized(() => { ran++; });
  assert.equal(ran, 1);
});

test("a hosted world is blocked until it is authorized", () => {
  gate.setHostedProbe(true);
  bridge.setAuthorized(false);
  assert.equal(gate.isBlocked(), true);
  let ran = 0;
  const cancel = gate.whenAuthorized(() => { ran++; });
  assert.equal(ran, 0, "does not run while blocked");
  bridge.setAuthorized(true);
  assert.equal(ran, 1, "runs once authorization arrives");
  cancel();
});

test("an already-authorized hosted world runs callbacks immediately", () => {
  gate.setHostedProbe(true);
  bridge.setAuthorized(true);
  let ran = 0;
  gate.whenAuthorized(() => { ran++; });
  assert.equal(ran, 1);
});

test("a callback runs at most once across a later lease change", () => {
  gate.setHostedProbe(true);
  bridge.setAuthorized(false);
  let ran = 0;
  gate.whenAuthorized(() => { ran++; });
  bridge.setAuthorized(true);
  assert.equal(ran, 1);
  // A lease renewal does not change authorization, so nothing re-fires.
  bridge.setAuthorized(true);
  assert.equal(ran, 1);
  // Losing and regaining the lease must not restart the callback either.
  bridge.setAuthorized(false);
  bridge.setAuthorized(true);
  assert.equal(ran, 1, "a cancelled one-shot never re-runs on a later lease");
});

test("cancelling before authorization prevents the callback", () => {
  gate.setHostedProbe(true);
  bridge.setAuthorized(false);
  let ran = 0;
  const cancel = gate.whenAuthorized(() => { ran++; });
  cancel();
  bridge.setAuthorized(true);
  assert.equal(ran, 0);
});

test("enrollment failure keeps the world blocked", () => {
  gate.setHostedProbe(true);
  bridge.setAuthorized(false);
  let ran = 0;
  gate.whenAuthorized(() => { ran++; });
  // Enrollment fails: authorization is never set.
  assert.equal(ran, 0);
  assert.equal(gate.isBlocked(), true);
});

test("setAuthorized notifies only on a change", () => {
  const seen = [];
  const off = bridge.onAuthorizationChange((value) => seen.push(value));
  bridge.setAuthorized(false); // already false: no notification
  bridge.setAuthorized(true);
  bridge.setAuthorized(true); // no change: no notification
  bridge.setAuthorized(false);
  off();
  bridge.setAuthorized(true); // unsubscribed
  assert.deepEqual(seen, [true, false]);
});

test("publishing no platform access clears authorization", () => {
  bridge.setAuthorized(true);
  bridge.setPlatformAccess(null);
  assert.equal(bridge.isAuthorized(), false);
});
