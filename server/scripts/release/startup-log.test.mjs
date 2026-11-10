#!/usr/bin/env node
/**
 * Startup-log regression tests.
 *
 * The world plugin prints a timestamped, numbered startup timeline while it
 * enrolls and authenticates (plugins/paescape/StartupLog.js). Two properties are
 * load-bearing and pinned here: no log line may ever contain a credential, and
 * the stage numbering must match the launcher so the two processes read as one
 * timeline.
 *
 * Run: node --test scripts/release/startup-log.test.mjs   (from server/)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { redact, timestamp, line, stageLine, REDACTED } = require(path.join(here, "..", "..", "plugins", "paescape", "StartupLog.js"));

test("a bearer token is redacted wherever it appears", () => {
  const out = redact("refused GET with authorization: Bearer abcDEF123._-xyz");
  assert.doesNotMatch(out, /abcDEF123/);
  assert.match(out, /Bearer <redacted>/);
});

test("platform credential prefixes are redacted", () => {
  for (const token of ["wsk_livekey1234567890", "wsi_credentialabcdef123456", "wsm_nonce1234567890", "wst_ticket1234567890"]) {
    const out = redact(`failed with ${token}`);
    assert.doesNotMatch(out, new RegExp(token), token + " leaked: " + out);
    assert.match(out, /ws_<redacted>/);
  }
});

test("credential-shaped query parameters are redacted", () => {
  const out = redact("GET https://paescape.online/x?token=abc123&code=wxyz done");
  assert.doesNotMatch(out, /abc123|wxyz/);
  assert.match(out, /token=<redacted>/);
  assert.match(out, /code=<redacted>/);
});

test("a message with no secret is unchanged apart from the prefix", () => {
  const out = line("log", "enrolled with world W123");
  assert.match(out, /^\[\d\d:\d\d:\d\d\] \[paescape\] enrolled with world W123$/);
});

test("a warn line carries its level tag", () => {
  assert.match(line("warn", "retrying"), /\[paescape\] \[warn\] retrying/);
});

test("undefined and null messages never throw", () => {
  assert.equal(redact(undefined), undefined);
  assert.equal(redact(null), null);
  assert.doesNotThrow(() => line("log", undefined));
});

test("the timestamp is a zero-padded wall clock", () => {
  const date = new Date(2026, 0, 2, 3, 4, 5);
  assert.equal(timestamp(date), "03:04:05");
});

test("a stage line names the stage out of seven", () => {
  assert.match(stageLine(5, "enrolling"), /\[stage 5\/7\] enrolling$/);
  assert.match(stageLine(7, "world is ready"), /\[stage 7\/7\] world is ready$/);
});

test("the redaction sentinel is a single token", () => {
  assert.equal(REDACTED, "<redacted>");
});
