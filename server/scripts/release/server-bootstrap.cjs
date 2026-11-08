#!/usr/bin/env node
/**
 * server.exe bootstrap.
 *
 * A Node single-executable has no real "directory" to resolve modules against, and
 * the game server resolves its own modules relative to process.cwd(). So the SEA
 * blob embeds the compiled application as assets; this bootstrap writes them to a
 * versioned directory under the executable's folder (so plugins, data and logs sit
 * beside server.exe exactly as a normal install) and then runs the real entry.
 *
 * Extraction happens only when the embedded build differs from the extracted one:
 * a normal start costs one small JSON read. The tree is written into a directory
 * named after the build hash and the marker is written last, so an interrupted
 * extraction is simply redone on the next start.
 */
"use strict";

const sea = require("node:sea");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MARKER = "paescape-app.json";
const ROOT = path.dirname(process.execPath);

// The extracted tree lives in a directory named after this build's hash, so a
// changed build gets a fresh directory and the old one can be removed without a
// rename (which Windows can block while an indexer or antivirus holds a handle).
const BUILD = sea.getAsset("paescape-app.json", "utf8");
const HASH = crypto.createHash("sha256").update(BUILD).digest("hex").slice(0, 16);
const APP_DIR = path.join(ROOT, "app-" + HASH);
const APP_MARKER = path.join(APP_DIR, MARKER);

/**
 * Extract the application files beside the executable when this build has not
 * been extracted yet. The marker is written LAST, so an interrupted extraction
 * simply lacks a marker and is redone on the next start. No rename is used: on
 * Windows a rename of a freshly written tree can fail on a transient lock.
 */
function extractIfNeeded() {
  const current = readMarker(APP_MARKER);
  if (current === BUILD) return;
  fs.mkdirSync(APP_DIR, { recursive: true });
  for (const name of sea.getAssetKeys()) {
    if (name === MARKER) continue;
    const dest = path.join(APP_DIR, name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, readAsset(name));
  }
  fs.writeFileSync(APP_MARKER, BUILD);
}

/**
 * Read one embedded asset as its exact bytes.
 *
 * Node 24 dropped the "buffer" encoding from sea.getAsset, so the old
 * getAsset(name, "buffer") call throws and a UTF-8 fallback silently replaces
 * every byte that is not valid UTF-8 (which is most of the OSRS cache) with
 * U+FFFD - corrupting the extracted tree while leaving it the right shape.
 * getRawAsset returns the raw bytes and is the only safe read for binary
 * assets; assert the type so a future API change fails loudly instead of
 * quietly corrupting the install.
 */
function readAsset(name) {
  if (typeof sea.getRawAsset === "function") {
    const raw = sea.getRawAsset(name);
    if (Buffer.isBuffer(raw)) return raw;
    if (raw instanceof ArrayBuffer) return Buffer.from(raw);
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
    throw new Error(`embedded asset ${name} was not returned as bytes`);
  }
  const buffer = sea.getAsset(name, "buffer");
  if (!Buffer.isBuffer(buffer)) throw new Error(`embedded asset ${name} was not returned as a buffer`);
  return buffer;
}

function readMarker(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

try {
  extractIfNeeded();
} catch (error) {
  console.error("[server] could not prepare its application files:", error.message);
  process.exit(1);
}

// Run from the extracted app directory so the server's cwd-relative resolution,
// plugins/ and data/ all behave exactly as in a normal install.
process.chdir(APP_DIR);
process.env.PAESCAPE_EXTRACTED_APP = APP_DIR;
process.env.PAESCAPE_BUILD_HASH = HASH;
// Load the real entry as the main module: dist/Server.js only starts the server
// when require.main === module, and a plain require would leave it a bystander.
const Module = require("node:module");
Module._load(path.join(APP_DIR, "dist", "Server.js"), null, true);
