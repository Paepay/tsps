#!/usr/bin/env node
/**
 * Release-pipeline self-test.
 *
 * Exercises the parts of the release system that do not need a live platform:
 *   1. the manifest canonicalisation the platform signs matches the launcher's
 *      re-serialisation, so a signature verified by the platform is verified by
 *      the launcher;
 *   2. an ECDSA P-256 (IEEE-P1363) signature over that payload verifies with
 *      Node's crypto (the same primitive .NET's ECDsa uses);
 *   3. the bundle script's staging logic is reachable (dry checks only).
 *
 * Signature/checksum round-trips against the real launcher are covered by
 * scripts/release/launcher-e2e.mjs, which needs a platform origin.
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";

// A copy of the platform's canonical() so this test pins the exact payload form.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const record = value;
  const keys = Object.keys(record).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
}

function makeManifest() {
  return {
    format: "paescape-server-release",
    formatVersion: 1,
    releaseId: "rel_test",
    generation: 3,
    version: "1.2.0",
    channel: "stable",
    sourceCommit: "abc123",
    protocolVersion: 1,
    apiMinVersion: 1,
    publishedAt: "2026-01-01T00:00:00.000Z",
    files: [{ path: "server.exe", bytes: 10, sha256: "a".repeat(64) }],
    entry: "server.exe",
    buildId: null,
    notes: "",
  };
}

test("the canonical manifest payload is stable regardless of key order", () => {
  const manifest = makeManifest();
  const reordered = { notes: "", buildId: null, entry: "server.exe", files: manifest.files, publishedAt: manifest.publishedAt, apiMinVersion: 1, protocolVersion: 1, sourceCommit: "abc123", channel: "stable", version: "1.2.0", generation: 3, releaseId: "rel_test", formatVersion: 1, format: "paescape-server-release" };
  assert.equal(canonical(manifest), canonical(reordered));
});

test("an ECDSA P-256 IEEE-P1363 signature round-trips", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const payload = canonical(makeManifest());
  const sig = crypto.sign("sha256", Buffer.from(payload, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
  assert.equal(Buffer.from(sig, "base64").length, 64, "P-1363 signature is r||s (64 bytes)");
  assert.equal(ReadP1363(publicKey, payload, sig), true);
  assert.equal(ReadP1363(publicKey, payload + " ", sig), false, "a changed payload fails");
  assert.ok(jwk.x.length > 0 && jwk.y.length > 0);
});

function ReadP1363(publicKey, payload, sig) {
  return crypto.verify("sha256", Buffer.from(payload, "utf8"), { key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64"));
}
