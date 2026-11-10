#!/usr/bin/env node
/**
 * Platform base-URL normalisation regression tests.
 *
 * The world plugin and the release packaging share plugins/paescape/PlatformUrl.js.
 * These pin the contract the whole integration depends on: a bare origin gains the
 * public path exactly once, a prefixed URL is never double-prefixed, and an explicit
 * development/alternative base is preserved.
 *
 * Run: node --test scripts/release/platform-url.test.mjs   (from server/)
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { normalisePlatformBase, resolvePublicPath, normalisePath } = require(path.join(here, "..", "..", "plugins", "paescape", "PlatformUrl.js"));

test("a bare origin gains the default public path", () => {
  assert.equal(normalisePlatformBase("https://paescape.online"), "https://paescape.online/platform");
  assert.equal(normalisePlatformBase("http://localhost:5176"), "http://localhost:5176/platform");
});

test("a trailing slash on a bare origin does not double the separator", () => {
  assert.equal(normalisePlatformBase("https://paescape.online/"), "https://paescape.online/platform");
});

test("an already-prefixed origin is left alone (no double prefix)", () => {
  assert.equal(normalisePlatformBase("https://paescape.online/platform"), "https://paescape.online/platform");
  assert.equal(normalisePlatformBase("https://paescape.online/platform/"), "https://paescape.online/platform");
  assert.equal(
    normalisePlatformBase("https://paescape.online/platform/api/server/enroll/begin"),
    "https://paescape.online/platform/api/server/enroll/begin",
    "a deeper path under the prefix is normalised, never prefixed again",
  );
});

test("an explicit alternative base is preserved as configured", () => {
  assert.equal(normalisePlatformBase("https://dev.example.test/custom"), "https://dev.example.test/custom");
  assert.equal(normalisePlatformBase("http://127.0.0.1:8080/backend"), "http://127.0.0.1:8080/backend");
});

test("an explicit public-path override is honoured", () => {
  assert.equal(normalisePlatformBase("https://example.test", { publicPath: "/api" }), "https://example.test/api");
  assert.equal(normalisePlatformBase("https://example.test/api", { publicPath: "/api" }), "https://example.test/api");
});

test("an empty public-path override mounts at the origin root", () => {
  assert.equal(normalisePlatformBase("https://example.test", { publicPath: "" }), "https://example.test");
  assert.equal(normalisePlatformBase("https://example.test/", { publicPath: "" }), "https://example.test");
});

test("an empty value stays empty (standalone mode)", () => {
  assert.equal(normalisePlatformBase(""), "");
  assert.equal(normalisePlatformBase("   "), "");
});

test("the environment can set the public path", () => {
  const previous = process.env.PAESCAPE_PLATFORM_PUBLIC_PATH;
  process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = "/backend";
  try {
    assert.equal(resolvePublicPath(), "/backend");
    assert.equal(normalisePlatformBase("https://example.test"), "https://example.test/backend");
    assert.equal(normalisePlatformBase("https://example.test/backend"), "https://example.test/backend");
  } finally {
    if (previous === undefined) delete process.env.PAESCAPE_PLATFORM_PUBLIC_PATH;
    else process.env.PAESCAPE_PLATFORM_PUBLIC_PATH = previous;
  }
});

test("the appended API path has exactly one separator", () => {
  const base = normalisePlatformBase("https://paescape.online");
  assert.equal(`${base}/api/server/enroll/begin`, "https://paescape.online/platform/api/server/enroll/begin");
  assert.equal(`${base}/api/platform/public-key`, "https://paescape.online/platform/api/platform/public-key");
});

test("normalisePath collapses to '' or '/seg[ments]'", () => {
  assert.equal(normalisePath("/platform/"), "/platform");
  assert.equal(normalisePath("platform"), "/platform");
  assert.equal(normalisePath("/"), "");
  assert.equal(normalisePath(""), "");
});
