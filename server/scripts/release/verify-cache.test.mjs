#!/usr/bin/env node
/**
 * Cache-revision consistency check tests.
 *
 * verify-cache.mjs is the build-time guard that stops a release shipping a
 * relabelled-but-wrong cache. These exercise it against synthetic cache trees so
 * the guard's decisions are pinned without touching a real cache.
 *
 * Run: node --test scripts/release/verify-cache.test.mjs   (from server/)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { verifyCacheConsistency, revisionOfCachedPath } = await import(pathToFileURL(path.join(here, "verify-cache.mjs")).href);

/** Build a synthetic server checkout with a target and a cache directory. */
function makeServer({ target, cacheName, infoRevision, manifestRevision, withData = true, manifest = true }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-cache-"));
  fs.writeFileSync(path.join(root, "target.txt"), target);
  const caches = path.join(root, "caches");
  const dir = path.join(caches, cacheName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify({ builds: [{ major: infoRevision }] }));
  if (withData) {
    fs.writeFileSync(path.join(dir, "main_file_cache.dat2"), Buffer.alloc(16));
    fs.writeFileSync(path.join(dir, "main_file_cache.idx255"), Buffer.alloc(8));
  }
  if (manifest) {
    fs.writeFileSync(path.join(caches, "caches.json"), JSON.stringify([{ name: cacheName, revision: manifestRevision }]));
  }
  return root;
}

test("a target and a matching cache data directory pass", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 242, manifestRevision: 242 });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, true, result.problems.join("; "));
  assert.equal(result.revision, 242);
});

test("a target whose cache directory is missing fails", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 242, manifestRevision: 242 });
  fs.rmSync(path.join(root, "caches", "osrs-242_2026-11-03"), { recursive: true, force: true });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /does not exist/);
});

test("a relabelled cache (target 242, data 241) fails", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 241, manifestRevision: 241 });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /revision 241 but target\.txt names 242/);
});

test("a cache directory missing its data files fails", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 242, manifestRevision: 242, withData: false });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /missing main_file_cache\.dat2/);
});

test("an expected revision that disagrees fails", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 242, manifestRevision: 242 });
  const result = verifyCacheConsistency({ serverDir: root, expectedRevision: 243 });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /expects revision 243/);
});

test("the manifest revision is checked too", () => {
  const root = makeServer({ target: "osrs-242_2026-11-03", cacheName: "osrs-242_2026-11-03", infoRevision: 242, manifestRevision: 241 });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /caches\.json names revision 241/);
});

test("a malformed target fails cleanly", () => {
  const root = makeServer({ target: "osrs-242", cacheName: "osrs-242", infoRevision: 242, manifestRevision: 242 });
  const result = verifyCacheConsistency({ serverDir: root });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /not of the form/);
});

test("revisionOfCachedPath reads the revision from a cache directory name", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-website-cache-"));
  const cacheDir = path.join(dir, "osrs-242_2026-11-03");
  fs.mkdirSync(cacheDir, { recursive: true });
  assert.equal(revisionOfCachedPath(cacheDir), 242);
});
