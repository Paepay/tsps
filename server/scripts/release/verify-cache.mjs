#!/usr/bin/env node
/**
 * Build-time cache-revision consistency check.
 *
 * The packaged server ships its cache directory plus a `target.txt` naming the
 * revision the server loads, and the website's cache service reads its own cache
 * directory. If those two disagree (or the packaged `caches/` does not actually
 * contain the revision `target.txt` claims) a release goes out that reports one
 * revision while running another. This check fails the build in that case instead
 * of shipping it.
 *
 * It verifies, for a server checkout:
 *   1. `target.txt` matches `osrs-{revision}_{date}`;
 *   2. `caches/<target>/` exists and holds the real cache data (dat2 + idx255 + info.json),
 *      not just an updated label;
 *   3. the cache directory's own revision (from `info.json`, or `caches.json` beside it)
 *      equals the revision `target.txt` names;
 *   4. the shared `caches/caches.json` manifest names that same revision;
 *   5. when `expectedRevision` is given (the release's intended revision), it matches.
 *
 * Read-only. Exits non-zero with a readable reason when any check fails.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TARGET_PATTERN = /^osrs-(\d+)_(\d{4}-\d{2}-\d{2})$/;

/** Read and parse `caches/<name>/info.json`, returning its revision or null. */
function revisionFromInfo(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
    const builds = Array.isArray(raw.builds) ? raw.builds : [];
    const fromBuilds = builds[0] && Number(builds[0].major);
    if (Number.isFinite(fromBuilds) && fromBuilds > 0) return fromBuilds;
    const direct = Number(raw.revision);
    if (Number.isFinite(direct) && direct > 0) return direct;
  } catch {
    /* missing/unreadable info.json is reported by the caller */
  }
  return null;
}

/** The revision named by an entry in the shared `caches/caches.json`, or null. */
function revisionFromManifest(cachesRoot, name) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(cachesRoot, "caches.json"), "utf8"));
    if (!Array.isArray(list)) return null;
    const match = list.find((entry) => entry && entry.name === name);
    return match ? Number(match.revision) || null : null;
  } catch {
    return null;
  }
}

/**
 * Verify the packaged server cache and its target agree on one revision.
 * Returns `{ ok, revision, name, problems }`. Never throws for a data problem.
 */
export function verifyCacheConsistency({ serverDir, expectedRevision } = {}) {
  const problems = [];
  const targetFile = path.join(serverDir, "target.txt");
  let name = "";
  let revision = null;
  try {
    name = fs.readFileSync(targetFile, "utf8").trim();
  } catch {
    problems.push(`target.txt is missing from ${serverDir}`);
    return { ok: false, revision: null, name: "", problems };
  }
  const parsed = TARGET_PATTERN.exec(name);
  if (!parsed) {
    problems.push(`target.txt "${name}" is not of the form osrs-{revision}_{date}`);
    return { ok: false, revision: null, name, problems };
  }
  revision = Number(parsed[1]);

  const cachesRoot = path.join(serverDir, "caches");
  const cacheDir = path.join(cachesRoot, name);
  if (!fs.existsSync(cacheDir) || !fs.statSync(cacheDir).isDirectory()) {
    problems.push(`caches/${name} does not exist; the packaged server has no cache for its target`);
    return { ok: false, revision, name, problems };
  }
  for (const file of ["main_file_cache.dat2", "main_file_cache.idx255", "info.json"]) {
    if (!fs.existsSync(path.join(cacheDir, file))) {
      problems.push(`caches/${name} is missing ${file}; it is not real cache data`);
    }
  }
  const infoRevision = revisionFromInfo(cacheDir);
  if (infoRevision === null) {
    problems.push(`caches/${name}/info.json does not report a revision`);
  } else if (infoRevision !== revision) {
    problems.push(`caches/${name} is revision ${infoRevision} but target.txt names ${revision}`);
  }
  const manifestRevision = revisionFromManifest(cachesRoot, name);
  if (manifestRevision !== null && manifestRevision !== revision) {
    problems.push(`caches/caches.json names revision ${manifestRevision} but target.txt names ${revision}`);
  }
  if (expectedRevision !== undefined && expectedRevision !== null && Number(expectedRevision) !== revision) {
    problems.push(`target.txt names revision ${revision} but the release expects revision ${Number(expectedRevision)}`);
  }
  return { ok: problems.length === 0, revision, name, problems };
}

/** The website cache service's configured revision, read from its `OSRS_CACHE_PATH`. */
export function revisionOfCachedPath(cachePath) {
  if (!cachePath) return null;
  const base = path.basename(path.resolve(cachePath));
  const match = TARGET_PATTERN.exec(base);
  if (match) return Number(match[1]);
  const info = revisionFromInfo(path.resolve(cachePath));
  if (info !== null) return info;
  return revisionFromManifest(path.dirname(path.resolve(cachePath)), base);
}

function cli() {
  const args = process.argv.slice(2);
  const get = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const serverDir = path.resolve(get("--server") ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ".."));
  const expectedRevision = get("--expect-revision");
  const websiteCachePath = get("--website-cache");
  const result = verifyCacheConsistency({ serverDir, expectedRevision });
  let ok = result.ok;
  if (result.ok) {
    console.log(`[cache-check] server target.txt and packaged cache agree on revision ${result.revision} (${result.name})`);
  } else {
    for (const problem of result.problems) console.error(`[cache-check] ${problem}`);
  }
  if (websiteCachePath) {
    const websiteRevision = revisionOfCachedPath(websiteCachePath);
    if (websiteRevision === null) {
      console.error(`[cache-check] could not determine a revision from the website cache path ${websiteCachePath}`);
      ok = false;
    } else if (websiteRevision !== result.revision) {
      console.error(`[cache-check] website cache is revision ${websiteRevision} but the server targets ${result.revision}`);
      ok = false;
    } else {
      console.log(`[cache-check] website cache and server target agree on revision ${websiteRevision}`);
    }
  }
  if (!ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  cli();
}
