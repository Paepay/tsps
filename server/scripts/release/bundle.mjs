#!/usr/bin/env node
/**
 * Build a distributable PaeScape server.exe.
 *
 * Stages:
 *   1. compile      tsc --build (TypeScript -> dist/)
 *   2. assemble     stage dist/, plugins/, data/definitions and production node_modules
 *   3. obfuscate    every staged .js through javascript-obfuscator (on the COPY, so
 *                   the working tree's plugins/ and dist/ are never modified)
 *   4. sea          a Node single-executable blob over the staged tree
 *   5. inject       postject writes the blob into a copy of node.exe -> server.exe
 *
 * The result is one self-contained server.exe. Obfuscation is a speed bump, never a
 * security boundary: the platform enforces licensing and identity server-side.
 *
 * Usage:
 *   node scripts/release/bundle.mjs --version 1.0.0 [--generation 1] [--out ../../dist-release]
 *
 * Environment:
 *   PAESCAPE_PLATFORM_URL   stamped into the build so the exe knows where to enroll
 *   PAESCAPE_RELEASE_GENERATION / PAESCAPE_PROTOCOL_VERSION  embedded release metadata
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Reuse the plugin's own base-URL normalisation so the packaged exe, the plugin and
// the website all agree on where the platform API lives (bare origin, prefixed, or
// explicit development base). Imported from the plugin source, not duplicated.
const platformUrlSource = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "paescape", "PlatformUrl.js");
const platformUrlModule = await import(pathToFileURL(platformUrlSource).href);
const normalisePlatformBase = platformUrlModule.normalisePlatformBase ?? platformUrlModule.default?.normalisePlatformBase;
if (typeof normalisePlatformBase !== "function") {
  throw new Error("could not load normalisePlatformBase from plugins/paescape/PlatformUrl.js");
}

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = parseArgs(process.argv.slice(2));
const version = args.version ?? "0.0.0-dev";
const generation = Number(args.generation ?? process.env.PAESCAPE_RELEASE_GENERATION ?? "0") || 0;
const protocolVersion = Number(args.protocolVersion ?? process.env.PAESCAPE_PROTOCOL_VERSION ?? "1") || 1;
const outDir = path.resolve(serverDir, args.out ?? path.join("..", "dist-release"));
const stagingDir = path.join(outDir, "staging");

// A release build must never write into the checkout it is building from. The staged
// tree is the only thing obfuscation is allowed to touch: reading plugins/ and dist/
// while writing obfuscated JavaScript back over them silently replaces every source
// file with a directory of obfuscated text, which is what corrupted this repository
// once already. Refuse to run rather than risk it again.
const sourceTrees = ["dist", "plugins", "data", "node_modules", "caches"].map((name) => path.join(serverDir, name));
function assertSafeStaging() {
  const staged = path.resolve(stagingDir);
  const server = path.resolve(serverDir);
  // The staging tree (and the server.exe written into outDir) must live outside the
  // server checkout entirely. Writing it inside the checkout - e.g. `--out .` - leaves
  // generated copies in the working tree, where they can be committed by accident and
  // where a future mistake with the obfuscation target could reach the real sources.
  if (staged === server || staged.startsWith(server + path.sep)) {
    throw new Error(
      `refusing to build: the output directory (${staged}) is inside the server checkout (${server}). ` +
        "Choose an --out directory outside the server tree.",
    );
  }
  for (const source of sourceTrees) {
    const resolved = path.resolve(source);
    if (staged === resolved || staged.startsWith(resolved + path.sep) || resolved.startsWith(staged + path.sep)) {
      throw new Error(
        `refusing to build: staging directory (${staged}) overlaps source tree ${resolved}. ` +
          "Choose an --out directory outside the server checkout.",
      );
    }
  }
}
assertSafeStaging();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) out[token.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
  }
  return out;
}

function run(command, argv, options = {}) {
  console.log(`[bundle] ${command} ${argv.join(" ")}`);
  const result = spawnSync(command, argv, { stdio: "inherit", cwd: options.cwd ?? serverDir, shell: options.shell ?? false });
  if (result.status !== 0) throw new Error(`${command} ${argv.join(" ")} failed with status ${result.status}`);
}

function copyTree(from, to, filter) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (filter && !filter(src, entry)) continue;
    if (entry.isDirectory()) copyTree(src, dest, filter);
    else fs.copyFileSync(src, dest);
  }
}

/**
 * Remove a directory tree, retrying past transient Windows locks (an indexer or
 * antivirus can briefly hold a handle on a freshly written tree).
 */
function removeTree(dir) {
  if (!fs.existsSync(dir)) return;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      return;
    } catch (error) {
      if (attempt === 5) throw error;
      // Busy-wait briefly so the lock can clear before the next attempt.
      const end = Date.now() + 400;
      while (Date.now() < end) { /* spin */ }
    }
  }
}

function walk(root) {
  const files = [];
  if (!fs.existsSync(root)) return files;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files;
}

/* 1 --------------------------------------------------------------- compile --- */
console.log("[bundle] stage 1/5: compile");
run(process.execPath, [path.join(serverDir, "node_modules", "typescript", "bin", "tsc"), "--build"]);

/* 2 -------------------------------------------------------------- assemble --- */
console.log("[bundle] stage 2/5: assemble");
removeTree(stagingDir);
fs.mkdirSync(stagingDir, { recursive: true });
copyTree(path.join(serverDir, "dist"), path.join(stagingDir, "dist"));
copyTree(path.join(serverDir, "plugins"), path.join(stagingDir, "plugins"));
// World content the server reads at runtime. Generated JSON is copied verbatim, except
// world.local.json: that is a gitignored per-deployment override for the operator's own
// checkout (their XP rate, spawn, plugin switches) and shipping it would hand every host
// this build environment's private world settings. The committed world.json ships, and a
// minimal override is written below.
copyTree(
  path.join(serverDir, "data", "definitions"),
  path.join(stagingDir, "data", "definitions"),
  (src) => path.basename(src) !== "world.local.json",
);
copyTree(path.join(serverDir, "data", "models"), path.join(stagingDir, "data", "models"));
copyTree(path.join(serverDir, "caches"), path.join(stagingDir, "caches"));
// The cache pipeline reads target.txt from the working directory to decide which cache
// revision to load before it touches anything else. Without it the packaged server exits
// on startup before the game loop begins.
if (fs.existsSync(path.join(serverDir, "target.txt"))) {
  fs.copyFileSync(path.join(serverDir, "target.txt"), path.join(stagingDir, "target.txt"));
} else {
  throw new Error("target.txt is missing from the server directory; the packaged server cannot select a cache without it.");
}
// Fail the build when the packaged cache and target.txt disagree on the revision, or
// the packaged caches/ does not actually contain the revision target.txt names. Shipping
// a relabelled-but-241 cache is exactly the bug this guards against.
{
  const { verifyCacheConsistency } = await import(pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "verify-cache.mjs")).href);
  const check = verifyCacheConsistency({ serverDir, expectedRevision: args.cacheRevision ?? process.env.PAESCAPE_EXPECTED_CACHE_REVISION });
  if (!check.ok) {
    throw new Error("cache revision consistency check failed:\n  - " + check.problems.join("\n  - "));
  }
  console.log(`[bundle] cache revision ${check.revision} (${check.name}) verified against target.txt and caches/`);
}
// Production dependencies only, minus dev tooling, source maps, and type declaration
// packages. @types packages are compile-time only and, worse, the Node SEA type
// definitions embed the very sentinel postject searches for, which would make the
// injection ambiguous.
copyTree(
  path.join(serverDir, "node_modules"),
  path.join(stagingDir, "node_modules"),
  (src) =>
    !src.includes(`${path.sep}.bin`) &&
    !src.includes(`${path.sep}@types${path.sep}`) &&
    !src.endsWith(".map") &&
    !src.endsWith(".d.ts") &&
    !src.endsWith(".d.mts") &&
    !src.endsWith(".d.cts") &&
    !src.endsWith(".ts"),
);
// The extracted tree lands beside server.exe, which may sit under a folder whose
// package.json sets "type": "module" (as the website repo does). Pin this tree to
// CommonJS so the compiled server loads as it would from its own checkout.
fs.writeFileSync(path.join(stagingDir, "package.json"), JSON.stringify({ name: "paescape-server", private: true, type: "commonjs" }, null, 2));
// Stamp the normalised platform API base (origin + public path) so the packaged exe
// posts to /platform/api/... on the public website without the host editing anything.
const platformBase = normalisePlatformBase(process.env.PAESCAPE_PLATFORM_URL ?? "");
fs.writeFileSync(
  path.join(stagingDir, "paescape-app.json"),
  JSON.stringify({ version, generation, protocolVersion, platformUrl: platformBase, builtAt: new Date().toISOString() }, null, 2),
);
// world.json leaves the PaeScape integration plugin disabled (correct for an offline
// world), but a distributed server.exe is always a hosted world that must enroll and
// authenticate with the platform without the host editing any file. Write a minimal
// world.local.json that turns the plugin on and defaults the platform base. A host can
// still override it with PAESCAPE_PLATFORM_URL at runtime.
{
  const local = {
    plugins: { PaeScape: true },
    pluginConfig: platformBase
      ? { "PaeScape:platformUrl": platformBase }
      : {},
  };
  fs.writeFileSync(path.join(stagingDir, "data", "definitions", "world.local.json"), JSON.stringify(local, null, 2) + "\n");
}

/* 3 ------------------------------------------------------------- obfuscate --- */
console.log("[bundle] stage 3/5: obfuscate");
// In-process: a fresh process per file (3,000+ files) is far too slow. The
// obfuscator API is synchronous, and it runs on the staged copy so the working
// tree's plugins/ and dist/ stay clean.
let JavaScriptObfuscator;
try {
  const mod = await import("javascript-obfuscator");
  JavaScriptObfuscator = mod.default ?? mod;
} catch {
  throw new Error(
    "javascript-obfuscator is not installed. Run: (cd server && yarn add -D javascript-obfuscator). Obfuscation is mandatory for a release build.",
  );
}
const OBFUSCATOR_OPTIONS = {
  compact: true,
  selfDefending: true,
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 0.75,
  deadCodeInjection: false,
  debugProtection: false,
  controlFlowFlattening: false,
  identifierNamesGenerator: "hexadecimal",
  // Keep object keys and property access readable: the game server and its plugin
  // API touch many properties dynamically, which obfuscation would break.
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};
function obfuscateTree(root) {
  if (!fs.existsSync(root)) return 0;
  // Last line of defence: obfuscation rewrites .js in place, so it must only ever
  // run over the staged copy, never the checkout.
  if (!path.resolve(root).startsWith(path.resolve(stagingDir) + path.sep)) {
    throw new Error(`refusing to obfuscate outside the staging directory: ${root}`);
  }
  let count = 0;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) { count += obfuscateTree(full); continue; }
    if (!entry.name.endsWith(".js")) continue;
    const source = fs.readFileSync(full, "utf8");
    try {
      const result = JavaScriptObfuscator.obfuscate(source, OBFUSCATOR_OPTIONS).getObfuscatedCode();
      fs.writeFileSync(full, result);
      count++;
    } catch (error) {
      throw new Error(`obfuscation failed for ${full}: ${error.message}`);
    }
  }
  return count;
}
// Remove source maps from the staged dist: a release must not ship them.
for (const map of walk(path.join(stagingDir, "dist")).filter((file) => file.endsWith(".js.map"))) fs.rmSync(map, { force: true });
const obfuscated = obfuscateTree(path.join(stagingDir, "dist")) + obfuscateTree(path.join(stagingDir, "plugins"));
console.log(`[bundle] obfuscated ${obfuscated} staged file(s)`);

/* 4 ------------------------------------------------------------------ sea --- */
console.log("[bundle] stage 4/5: single-executable blob");
// The SEA blob embeds the staged application as named assets. The bootstrap
// (scripts/release/server-bootstrap.cjs) extracts them beside the exe on first
// run and then requires the real entry, so plugins/, data/ and cwd-relative
// module resolution all behave as a normal install.
const assets = {};
for (const file of walk(stagingDir)) {
  const rel = path.relative(stagingDir, file).split(path.sep).join("/");
  assets[rel] = file;
}
const seaConfig = path.join(stagingDir, "sea-config.json");
fs.writeFileSync(
  seaConfig,
  JSON.stringify(
    {
      main: path.resolve(serverDir, "scripts", "release", "server-bootstrap.cjs"),
      output: path.join(stagingDir, "sea-prep.blob"),
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets,
    },
    null,
    2,
  ),
);
run(process.execPath, ["--experimental-sea-config", seaConfig], { cwd: stagingDir });

/* 5 --------------------------------------------------------------- inject --- */
console.log("[bundle] stage 5/5: inject into server.exe");
const exePath = path.join(outDir, "server.exe");
fs.copyFileSync(process.execPath, exePath);
run("npx", ["--yes", "postject", exePath, "NODE_SEA_BLOB", path.join(stagingDir, "sea-prep.blob"), "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"], { cwd: outDir, shell: true });

const exeBytes = fs.statSync(exePath).size;
fs.writeFileSync(path.join(outDir, "server.exe.sha256"), crypto.createHash("sha256").update(fs.readFileSync(exePath)).digest("hex") + "  server.exe\n");
console.log(`[bundle] wrote ${exePath} (${(exeBytes / 1024 / 1024).toFixed(1)} MB)`);
console.log("[bundle] next: node scripts/release/publish.mjs --version " + version + " --exe " + exePath);
