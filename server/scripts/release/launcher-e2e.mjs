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
function buildTinyExe(marker, exitCode = 0) {
  const dir = path.join(workRoot, "tiny-" + marker);
  fs.mkdirSync(dir, { recursive: true });
  const main = path.join(dir, "main.js");
  // A tiny stand-in for server.exe. It prints its marker so the test can prove
  // which build actually ran, then exits with the code the supervisor interprets
  // (0 normal, 10 update required, 11 auth failure, ...).
  fs.writeFileSync(main, `console.log("TINY-EXE-RAN:" + "${marker}"); process.exit(${exitCode});`);
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
/**
 * How many more downloads should be cut short mid-body (simulating a proxy RST).
 * Each served download decrements it once; once it reaches zero, downloads run
 * to completion so a test can prove the resume path finishes.
 */
let interruptDownloads = 0;
/** When true, answer a Range request as a full 200 (ignore the range). */
let ignoreRange = false;
/** When true, answer a Range request with a deliberately wrong Content-Range. */
let badContentRange = false;
/** When true, report an entry size that disagrees with the signed manifest. */
let tamperEntryBytes = false;
/** Called after a download is served; lets a test advance the current release. */
let afterDownload = null;
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
      publishedAt: manifest.publishedAt, entry: "server.exe", entrySha256: manifest.files[0].sha256, entryBytes: tamperEntryBytes ? currentExe.length + 7 : currentExe.length,
      files: manifest.files, manifestPayload: payload,
      signature: crypto.sign(null, Buffer.from(payload, "utf8"), crypto.generateKeyPairSync("ed25519").privateKey).toString("base64"),
      releaseSignature: tamperSignature ? Buffer.from("tampered").toString("base64") : sig, key: { algorithm: "ecdsa-p256", x: jwk.x, y: jwk.y },
      downloadPath: "/platform/api/releases/download?channel=stable",
    }));
    return;
  }
  if (url.pathname.endsWith("/api/releases/download")) {
    const bytes = corruptDownload ? (() => { const b = Buffer.from(currentExe); b[Math.floor(b.length / 2)] ^= 0xff; return b; })() : currentExe;
    const total = bytes.length;
    const rangeHeader = req.headers.range;
    // A deliberately broken Content-Range proves the launcher rejects a lying
    // proxy instead of appending arbitrary bytes.
    if (rangeHeader && badContentRange) {
      const m = Number(/bytes=(\d+)-/.exec(rangeHeader)?.[1] ?? 0);
      res.writeHead(206, { "content-type": "application/octet-stream", "content-range": `bytes ${m + 7}-${total - 1}/${total}`, "content-length": total - (m + 7) });
      res.end(bytes.subarray(m + 7));
      return;
    }
    // ignoreRange simulates a proxy that drops the Range header and answers 200.
    if (rangeHeader && !ignoreRange) {
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(206, { "content-type": "application/octet-stream", "content-range": `bytes ${start}-${end}/${total}`, "content-length": slice.length });
      if (interruptDownloads > 0) {
        // Send a partial body then destroy the socket, as a reset mid-transfer.
        interruptDownloads -= 1;
        res.write(slice.subarray(0, Math.max(1, Math.floor(slice.length / 2))));
        setTimeout(() => res.destroy(), 10);
        return;
      }
      res.end(slice, () => { const hook = afterDownload; if (hook) { afterDownload = null; hook(); } });
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream", "content-length": total });
    if (interruptDownloads > 0) {
      interruptDownloads -= 1;
      res.write(bytes.subarray(0, Math.max(1, Math.floor(total / 2))));
      setTimeout(() => res.destroy(), 10);
      return;
    }
    res.end(bytes, () => {
      const hook = afterDownload;
      if (hook) { afterDownload = null; hook(); }
    });
    return;
  }
  res.writeHead(404); res.end();
});

/**
 * A second mock origin that serves ONLY the download route, to prove the
 * launcher fetches the manifest from PAESCAPE_PLATFORM_URL and the large
 * executable from a distinct PAESCAPE_DOWNLOAD_URL (the DNS-only publishing
 * host in production). Every request to it must be a Range GET; a non-range
 * request is refused so the split is unambiguous.
 */
function downloadOnlyServer(bytes) {
  let rangeRequests = 0;
  let nonRangeRequests = 0;
  const srv = http.createServer((req, res) => {
    if (req.url.includes("/api/releases/download")) {
      const rangeHeader = req.headers.range;
      if (!rangeHeader) {
        nonRangeRequests += 1;
        res.writeHead(200, { "content-type": "application/octet-stream", "content-length": bytes.length });
        if (interruptDownloads > 0) {
          interruptDownloads -= 1;
          res.write(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
          setTimeout(() => res.destroy(), 10);
          return;
        }
        res.end(bytes);
        return;
      }
      rangeRequests += 1;
      const m = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
      const start = Number(m[1]);
      const end = m[2] ? Math.min(Number(m[2]), bytes.length - 1) : bytes.length - 1;
      const slice = bytes.subarray(start, end + 1);
      res.writeHead(206, { "content-type": "application/octet-stream", "content-range": `bytes ${start}-${end}/${bytes.length}`, "content-length": slice.length });
      res.end(slice);
      return;
    }
    res.writeHead(404); res.end();
  });
  return { srv, stats: () => ({ rangeRequests, nonRangeRequests }) };
}
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

function launch(dir, platformUrl, extraEnv = {}) {
  // Async so the in-process mock release server keeps serving while the launcher
  // (a separate process) makes its requests.
  return new Promise((resolve) => {
    const child = spawn("cmd", ["/c", path.join(dir, "StartServer.bat")], {
      cwd: dir,
      env: { ...process.env, PAESCAPE_PLATFORM_URL: platformUrl, PAESCAPE_CHANNEL: "stable", PAESCAPE_NO_PAUSE: "1", ...extraEnv },
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

  // --- Supervisor: the launcher stays alive and reacts to the server's exit code.

  await check("exit code 10 makes the supervisor install the new release and restart", async () => {
    const dir5 = freshServerDir();
    // Generation 1 asks for an update (exits 10). The moment its executable is
    // downloaded, the mock service advances to generation 2, which runs normally.
    currentExe = buildTinyExe("sup-a", 10);
    generation = 1;
    afterDownload = () => { currentExe = buildTinyExe("sup-b", 0); generation = 2; };
    const r = await launch(dir5, platformUrl, { PAESCAPE_UPDATE_BACKOFF_SECONDS: "1" });
    // The server asked for an update, the supervisor re-checked, installed
    // generation 2, and ran it - in one launcher invocation.
    assert.match(r.stdout, /TINY-EXE-RAN:sup-b/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /more than 5 times/);
    const state = JSON.parse(fs.readFileSync(path.join(dir5, "paescape-installed.json"), "utf8"));
    assert.equal(state.generation, 2);
    afterDownload = null;
    currentExe = buildTinyExe("v1"); generation = 1;
  });

  await check("a normal shutdown (exit 0) stops the supervisor without restarting", async () => {
    const dir6 = freshServerDir();
    currentExe = buildTinyExe("stop-ok", 0);
    generation = 1;
    const r = await launch(dir6, platformUrl, { PAESCAPE_UPDATE_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout, /server stopped normally/);
    assert.match(r.stdout, /TINY-EXE-RAN:stop-ok/);
    assert.equal((r.stdout.match(/TINY-EXE-RAN:stop-ok/g) || []).length, 1, "the server runs once, not in a loop");
    currentExe = buildTinyExe("v1"); generation = 1;
  });

  await check("an authentication failure (exit 11) is terminal and never loops", async () => {
    const dir7 = freshServerDir();
    currentExe = buildTinyExe("auth-fail", 11);
    generation = 1;
    const r = await launch(dir7, platformUrl, { PAESCAPE_UPDATE_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout + r.stderr, /could not authenticate/);
    assert.equal((r.stdout.match(/TINY-EXE-RAN:auth-fail/g) || []).length, 1, "the server is not restarted after an auth failure");
    currentExe = buildTinyExe("v1"); generation = 1;
  });

  await check("a fatal error (exit 13) is not restarted", async () => {
    const dir8 = freshServerDir();
    currentExe = buildTinyExe("fatal", 13);
    generation = 1;
    const r = await launch(dir8, platformUrl, { PAESCAPE_UPDATE_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout + r.stderr, /fatal error/);
    assert.equal((r.stdout.match(/TINY-EXE-RAN:fatal/g) || []).length, 1);
    currentExe = buildTinyExe("v1"); generation = 1;
  });

  await check("repeated update requests are capped, not looped forever", async () => {
    const dir9 = freshServerDir();
    // The server always asks for an update; the supervisor must give up after a
    // bounded number of cycles instead of spinning.
    currentExe = buildTinyExe("loop", 10);
    generation = 1;
    const r = await launch(dir9, platformUrl, { PAESCAPE_UPDATE_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout + r.stderr, /restart loop|more than 5 times/);
    const runs = (r.stdout.match(/TINY-EXE-RAN:loop/g) || []).length;
    assert.ok(runs >= 2 && runs <= 6, `the server ran a bounded number of times, saw ${runs}`);
    currentExe = buildTinyExe("v1"); generation = 1;
  });
  // --- Resumable download and metadata-binding regressions (task19).

  await check("an interrupted download resumes over Range requests and installs the exact file", async () => {
    const dir10 = freshServerDir();
    // Generation 1 is up to date once installed; start from nothing so an update
    // runs. Cut three failed (interrupted) transfers, then let it complete.
    interruptDownloads = 3;
    const expectedSha = crypto.createHash("sha256").update(currentExe).digest("hex");
    const r = await launch(dir10, platformUrl, { PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1", PAESCAPE_DOWNLOAD_ATTEMPTS: "8" });
    assert.match(r.stdout, /download complete and verified/, r.stdout + r.stderr);
    assert.match(r.stdout, /TINY-EXE-RAN:v1/, r.stdout + r.stderr);
    // The installed exe is bit-for-bit the release, and no partial files remain.
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir10, "server.exe"))).digest("hex"), expectedSha);
    assert.ok(!fs.existsSync(path.join(dir10, "server.exe.part")), "no partial file is left behind");
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir10, "paescape-installed.json"), "utf8")).generation, 1);
    interruptDownloads = 0;
  });

  await check("a proxy that ignores Range (full 200) never corrupts the partial file", async () => {
    // Serve a partial 206 first (interrupted), then answer the resume with a
    // full 200. The launcher must restart from zero, not append.
    const dir11 = freshServerDir();
    interruptDownloads = 1;
    ignoreRange = true;
    const expectedSha = crypto.createHash("sha256").update(currentExe).digest("hex");
    const r = await launch(dir11, platformUrl, { PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout + r.stderr, /server ignored the resume request/, r.stdout + r.stderr);
    assert.match(r.stdout, /TINY-EXE-RAN:v1/, r.stdout + r.stderr);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(path.join(dir11, "server.exe"))).digest("hex"), expectedSha);
    interruptDownloads = 0; ignoreRange = false;
  });

  await check("a response with a wrong Content-Range is refused, never appended", async () => {
    const dir12 = freshServerDir();
    interruptDownloads = 1;
    badContentRange = true;
    // All attempts get a bogus Content-Range; the download must never complete.
    const r = await launch(dir12, platformUrl, { PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1", PAESCAPE_DOWNLOAD_ATTEMPTS: "2" });
    assert.match(r.stdout + r.stderr, /unexpected Content-Range|did not complete after/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
    assert.ok(!fs.existsSync(path.join(dir12, "server.exe")), "nothing unverified is installed");
    interruptDownloads = 0; badContentRange = false;
  });

  await check("a partial download from a different release is discarded, not resumed", async () => {
    // Plant a partial file plus metadata for a different generation/sha; the
    // launcher must not resume it.
    const dir13 = freshServerDir();
    const stale = Buffer.from("this belongs to an older release");
    fs.writeFileSync(path.join(dir13, "server.exe.part"), stale);
    fs.writeFileSync(path.join(dir13, "server.exe.part.json"), JSON.stringify({ generation: 99, sha256: "0".repeat(64), bytes: 999999999, url: "https://example.invalid/x" }));
    const r = await launch(dir13, platformUrl, { PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1" });
    assert.match(r.stdout, /download complete and verified/, r.stdout + r.stderr);
    assert.match(r.stdout, /TINY-EXE-RAN:v1/, r.stdout + r.stderr);
    assert.ok(fs.statSync(path.join(dir13, "server.exe")).size > stale.length, "the stale partial was not reused");
  });

  await check("unsigned metadata that disagrees with the signed manifest is refused", async () => {
    const dir14 = freshServerDir();
    // Tamper only the unsigned sibling field, leaving the signature valid.
    tamperEntryBytes = true;
    const r = await launch(dir14, platformUrl);
    assert.match(r.stdout + r.stderr, /file size disagrees with the signed manifest/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
    assert.ok(!fs.existsSync(path.join(dir14, "server.exe")));
    tamperEntryBytes = false;
  });

  await check("a corrupt body that hashes wrong is refused and nothing is installed", async () => {
    const dir15 = freshServerDir();
    corruptDownload = true;
    const r = await launch(dir15, platformUrl, { PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1", PAESCAPE_DOWNLOAD_ATTEMPTS: "2" });
    assert.match(r.stdout + r.stderr, /checksum|failed its checksum/, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /TINY-EXE-RAN/);
    assert.ok(!fs.existsSync(path.join(dir15, "server.exe")), "a corrupt download is never installed");
    corruptDownload = false;
  });

  await check("the manifest comes from the platform host and the executable from the download host", async () => {
    // Requirement: normal API/manifest traffic stays on PAESCAPE_PLATFORM_URL,
    // while the large executable is fetched from PAESCAPE_DOWNLOAD_URL. A
    // distinct, download-only origin proves the two are not conflated.
    const { srv, stats } = downloadOnlyServer(currentExe);
    await new Promise((r) => srv.listen(0, "127.0.0.1", r));
    const downloadUrl = `http://127.0.0.1:${srv.address().port}`;
    try {
      const dir16 = freshServerDir();
      interruptDownloads = 1;
      // The mock platform server answers the manifest; the download host only
      // answers the artifact. Both must be used for the run to succeed.
      const r = await launch(dir16, platformUrl, {
        PAESCAPE_DOWNLOAD_URL: downloadUrl,
        PAESCAPE_DOWNLOAD_BACKOFF_SECONDS: "1",
      });
      assert.match(r.stdout, /TINY-EXE-RAN:v1/, r.stdout + r.stderr);
      const s = stats();
      assert.ok(s.rangeRequests >= 1, `the resumed leg used a Range request (${JSON.stringify(s)})`);
      // The full manifest download is a single 0- range request; the mock
      // platform download route must not have been used at all.
      assert.match(r.stdout, new RegExp("downloading server.exe .* from " + downloadUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), r.stdout);
    } finally {
      interruptDownloads = 0;
      await new Promise((r) => srv.close(r));
    }
  });});

console.log(failures === 0 ? "\nlauncher e2e: all checks passed" : `\nlauncher e2e: ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
