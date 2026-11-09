#!/usr/bin/env node
/**
 * Publish a built server.exe to the PaeScape platform.
 *
 * Runs the trusted-build side of Part 9: it hashes the executable, cuts a release
 * (version, generation, commit, protocol), uploads the bytes, then marks the
 * release current. The platform verifies the uploaded bytes' SHA-256 against the
 * manifest before storing them, so a truncated or altered upload is refused.
 *
 * Usage:
 *   node scripts/release/publish.mjs --version 1.0.0 --exe ../../dist-release/server.exe
 *
 * Environment:
 *   PAESCAPE_PLATFORM_URL     e.g. https://paescape.online
 *   PAESCAPE_PUBLISHER_TOKEN  the pipeline bearer token (PLATFORM_PUBLISHER_TOKEN on the platform)
 *   PAESCAPE_CHANNEL          release channel (default: stable)
 *   PAESCAPE_SOURCE_COMMIT    source commit this build came from
 *   PAESCAPE_PROTOCOL_VERSION protocol/API version the build speaks (default: 1)
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const args = parseArgs(process.argv.slice(2));
const version = args.version;
const exePath = path.resolve(args.exe ?? "server.exe");
const platformUrl = (args.platform ?? process.env.PAESCAPE_PLATFORM_URL ?? "").replace(/\/+$/, "");
const token = args.token ?? process.env.PAESCAPE_PUBLISHER_TOKEN ?? "";
const channel = args.channel ?? process.env.PAESCAPE_CHANNEL ?? "stable";
const sourceCommit = args.commit ?? process.env.PAESCAPE_SOURCE_COMMIT ?? "";
const protocolVersion = Number(args.protocol ?? process.env.PAESCAPE_PROTOCOL_VERSION ?? "1") || 1;

if (!version) fail("--version is required (e.g. --version 1.0.0)");
if (!platformUrl) fail("set PAESCAPE_PLATFORM_URL or pass --platform");
if (!token) fail("set PAESCAPE_PUBLISHER_TOKEN or pass --token");
if (!fs.existsSync(exePath)) fail(`executable not found: ${exePath}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

function fail(message) {
  console.error(`[publish] ${message}`);
  process.exit(1);
}

// Hash the executable as a stream so a 533 MB build never loads into memory.
const size = fs.statSync(exePath).size;
const sha256 = await new Promise((resolve, reject) => {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(exePath);
  input.on("data", (chunk) => hash.update(chunk));
  input.on("end", () => resolve(hash.digest("hex")));
  input.on("error", reject);
});
console.log(`[publish] ${path.basename(exePath)} ${size} bytes sha256=${sha256}`);

const common = { "content-type": "application/json", authorization: `Bearer ${token}` };

const create = await fetch(`${platformUrl}/platform/api/releases`, {
  method: "POST",
  headers: common,
  body: JSON.stringify({
    version,
    channel,
    sourceCommit,
    protocolVersion,
    files: [{ path: "server.exe", bytes: size, sha256 }],
    makeCurrent: false,
  }),
});
const created = await create.json();
if (!create.ok) fail(`release was refused (${create.status}): ${created?.error ?? "unknown error"}`);
const releaseId = created.release.id;
console.log(`[publish] created release ${releaseId} generation ${created.release.generation}`);

// Stream the bytes to the platform. Content-Length is set so the server can
// reject an oversized upload before reading it; the body is a file stream so the
// executable is never buffered, and the request is marked half-duplex.
const { Readable } = await import("node:stream");
const upload = await fetch(`${platformUrl}/platform/api/releases/${releaseId}/artifacts?path=server.exe`, {
  method: "PUT",
  headers: { "content-type": "application/octet-stream", "content-length": String(size), authorization: `Bearer ${token}` },
  body: Readable.toWeb(fs.createReadStream(exePath)),
  duplex: "half",
});
const uploaded = await upload.json();
if (!upload.ok) fail(`upload was refused (${upload.status}): ${uploaded?.error ?? "unknown error"}`);
console.log(`[publish] uploaded server.exe (stored sha256=${uploaded.sha256})`);

const promote = await fetch(`${platformUrl}/platform/api/releases/${releaseId}/current`, {
  method: "POST",
  headers: common,
  body: JSON.stringify({}),
});
const promoted = await promote.json();
if (!promote.ok) fail(`promotion was refused (${promote.status}): ${promoted?.error ?? "unknown error"}`);
console.log(`[publish] release ${version} (generation ${created.release.generation}) is now current`);
