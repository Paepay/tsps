#!/usr/bin/env node
/**
 * Launcher end-to-end test.
 *
 * Spins up a mock release API, then runs the real StartServer.bat against a real
 * single-executable "server.exe" (a tiny SEA build, not the full game server, so
 * the test stays fast). Checks:
 *   - a signed manifest verifies and the launcher starts the exe;
 *   - a tampered manifest is refused and nothing runs;
 *   - a bad checksum on the downloaded exe is refused;
 *   - an outdated installed generation triggers an update, then a recheck.
 *
 * Run: node scripts/release/launcher-e2e.mjs   (Windows + Node with SEA support)
 */
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-launcher-"));

function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

/* --- A tiny real executable built with Node SEA so the launcher can run it. */
function buildTinyExe(marker) {
  const dir = path.join(workRoot, "tiny-" + marker);
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, "main.js");
  fs.writeFileSync(main, `console.log("TINY-EXE-RAN:" + "${marker}");`);
  const cfg = path.join(dir, "sea.json");
  const blob = path.join(dir, "sea.blob");
  fs.writeFileSync(cfg, JSON.stringify({ main, output: blob, disableExperimentalSEAWarning: true }));
  run(process.execPath, ["--experimental-sea-config", cfg]);
  const exe = path.join(dir, "server.exe");
  fs.copyFileSync(process.execPath, exe);
  run("npx", ["--yes", "postject", exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"]);
  return fs.readFileSync(exe);
}

function run(cmd, argv, opts = {}) {
  // shell:true only for npx (a .cmd shim); a real executable path must not be
  // split by cmd.exe.
  const useShell = cmd === "npx";
  const r = spawnSync(cmd, argv, { stdio: "pipe", shell: useShell, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(" ")} failed: ${r.stderr}`);
  return r;
}

/* --- The mock release service. */
const { privateKey, publicKey } = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = publicKey.export({ format: "jwk" });
let currentExe = buildTinyExe("v1");
let generation = 1;
let tamperSignature = false;
let corruptDownload = false;

function manifestFor(gen, exeBytes) {
  return {
    format: "paescape-server-release", formatVersion: 1, releaseId: "rel_" + gen, generation: gen,
    version: "1.0." + gen, channel: "stable", sourceCommit: "test", protocolVersion: 1, apiMinVersion: 1,
    publishedAt: new Date().toISOString(),
    files: [{ path: "server.exe", bytes: exeBytes.length, sha256: crypto.createHash("sha256").update(exeBytes).digest("hex") }],
    entry: "server.exe", buildId: null, notes: "",
  };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.endsWith("/api/releases/launcher")) {
    const manifest = manifestFor(generation, currentExe);
    const payload = canonical(manifest);
    const sig = crypto.sign("sha256", Buffer.from(payload, "utf8"), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      ok: true, channel: "stable", generation, version: "1.0." + generation, protocolVersion: 1, apiMinVersion: 1,
      publishedAt: manifest.publishedAt, entry: "server.exe", entrySha256: manifest.files[0].sha256, entryBytes: currentExe.length,
      files: manifest.files, manifestPayload: payload,
      signature: crypto.sign(null, Buffer.from(payload, "utf8"), crypto.generateKeyPairSync("ed25519").privateKey).toString("base64"),
      releaseSignature: tamperSignature ? Buffer.from("tampered").toString("base64") : sig, key: { algorithm: "ecdsa-p256", x: jwk.x, y: jwk.y },
      downloadPath: "/platform/api/releases/download?channel=stable",
    }));
    return;
  }
  if (url.pathname.endsWith("/api/releases/download")) {
    const bytes = corruptDownload ? Buffer.concat([currentExe, Buffer.from("XX")]) : currentExe;
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(bytes);
    return;
  }
  res.writeHead(404); res.end();
});

async function withServer(fn) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  try { return await fn(`http://127.0.0.1:${port}`); }
  finally { await new Promise((r) => server.close(r)); }
}

function freshServerDir() {
  const dir = fs.mkdtempSync(path.join(workRoot, "server-"));
  fs.copyFileSync(path.join(here, "StartServer.bat"), path.join(dir, "StartServer.bat"));
  return dir;
}

function launch(dir, platformUrl) {
  // Async so the in-process mock release server keeps serving while the launcher
  // (a separate process) makes its requests.
  return new Promise((resolve) => {
    const child = spawn("cmd", ["/c", path.join(dir, "StartServer.bat")], {
      cwd: dir,
      env: { ...process.env, PAESCAPE_PLATFORM_URL: platformUrl, PAESCAPE_CHANNEL: "stable", PAESCAPE_NO_PAUSE: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { out += d; });
    child.on("close", (code) => resolve({ status: code, stdout: out }));
  });
}

let failures = 0;
async function check(name, fn) {
  try { await fn(); console.log("ok - " + name); }
  catch (e) { failures++; console.error("FAIL - " + name + ": " + e.message); }
}

await withServer(async (platformUrl) => {
  const dir = freshServerDir();

  await check("a signed release downloads and starts", async () => {
    const r = await launch(dir, platformUrl);
    assert.match(r.stdout, /signature verified/, r.stdout + r.stderr);
    assert.match(r.stdout, /TINY-EXE-RAN:v1/, r.stdout + r.stderr);
    const state = JSON.parse(fs.readFileSync(path.join(dir, "paescape-installed.json"), "utf8"));
    assert.equal(state.generation, 1);
  });

  await check("a second run is up to date and does not re-download", async () => {
    const before = fs.statSync(path.join(dir, "server.exe")).mtimeMs;
    const r = await launch(dir, platformUrl);
    assert.match(r.stdout, /matches the current release/);
    assert.match(r.stdout, /TINY-EXE-RAN:v1/);
    assert.equal(fs.statSync(path.join(dir, "server.exe")).mtimeMs, before);
  });

  await check("an outdated installed generation updates then runs the new exe", async () => {
    currentExe = buildTinyExe("v2");
    generation = 2;
    const r = await launch(dir, platformUrl);
    assert.match(r.stdout, /update required/, r.stdout + r.stderr);
    assert.match(r.stdout, /TINY-EXE-RAN:v2/, r.stdout + r.stderr);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "paescape-installed.json"), "utf8")).generation, 2);
    currentExe = buildTinyExe("v1"); generation = 1; // restore
  });

  await check("a tampered manifest signature is refused and nothing runs", async () => {
    tamperSignature = true;
    const dir2 = freshServerDir();
    const r = await launch(dir2, platformUrl);
    assert.match(r.stdout + r.stderr, /signature did not verify/);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
    tamperSignature = false;
  });

  await check("a corrupted download is refused by the checksum", async () => {
    corruptDownload = true;
    const dir3 = freshServerDir();
    const r = await launch(dir3, platformUrl);
    assert.match(r.stdout + r.stderr, /checksum/i);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
    corruptDownload = false;
  });

  await check("an unreachable release service fails closed", async () => {
    const dir4 = freshServerDir();
    const r = await launch(dir4, "http://127.0.0.1:1");
    assert.match(r.stdout + r.stderr, /Could not reach the PaeScape release service/);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
  });
});

console.log(failures === 0 ? "\nlauncher e2e: all checks passed" : `\nlauncher e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
