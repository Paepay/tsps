import fs from "node:fs";
import path from "node:path";

import { verifyCacheConsistency } from "./verify-cache.mjs";

function copyTree(source, destination) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(destination, { recursive: true });
    for (const entry of fs.readdirSync(source)) {
      copyTree(path.join(source, entry), path.join(destination, entry));
    }
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

/**
 * Stage the one cache selected by target.txt for a universal release.
 *
 * A build checkout may retain older cache revisions for local comparison. Those
 * revisions are not runtime inputs and must not inflate the SEA payload or make
 * extraction at startup depend on unrelated local cache history.
 */
export function stageReleaseCache({ serverDir, stagingDir, expectedRevision } = {}) {
  const check = verifyCacheConsistency({ serverDir, expectedRevision });
  if (!check.ok) {
    throw new Error("cache revision consistency check failed:\n  - " + check.problems.join("\n  - "));
  }

  const sourceRoot = path.join(serverDir, "caches");
  const stagedRoot = path.join(stagingDir, "caches");
  fs.mkdirSync(stagedRoot, { recursive: true });

  const manifest = path.join(sourceRoot, "caches.json");
  if (fs.existsSync(manifest)) {
    fs.copyFileSync(manifest, path.join(stagedRoot, "caches.json"));
  }
  copyTree(path.join(sourceRoot, check.name), path.join(stagedRoot, check.name));
  return check;
}
