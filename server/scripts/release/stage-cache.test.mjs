import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { stageReleaseCache } from "./stage-cache.mjs";

function writeCache(root, name, revision) {
  const dir = path.join(root, "caches", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "main_file_cache.dat2"), `data-${revision}`);
  fs.writeFileSync(path.join(dir, "main_file_cache.idx255"), `index-${revision}`);
  fs.writeFileSync(path.join(dir, "info.json"), JSON.stringify({ revision }));
}

test("a release stages only the cache selected by target.txt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-stage-cache-"));
  const serverDir = path.join(root, "server");
  const stagingDir = path.join(root, "staging");
  const active = "osrs-242_2026-11-03";
  const inactive = "osrs-241_2026-10-20";
  try {
    fs.mkdirSync(serverDir, { recursive: true });
    fs.writeFileSync(path.join(serverDir, "target.txt"), active + "\n");
    writeCache(serverDir, active, 242);
    writeCache(serverDir, inactive, 241);
    fs.writeFileSync(
      path.join(serverDir, "caches", "caches.json"),
      JSON.stringify([
        { name: active, revision: 242 },
        { name: inactive, revision: 241 },
      ]),
    );

    const result = stageReleaseCache({ serverDir, stagingDir, expectedRevision: 242 });

    assert.equal(result.name, active);
    assert.ok(fs.existsSync(path.join(stagingDir, "caches", active, "main_file_cache.dat2")));
    assert.ok(fs.existsSync(path.join(stagingDir, "caches", "caches.json")));
    assert.equal(fs.existsSync(path.join(stagingDir, "caches", inactive)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a release fails before staging when the selected cache is incomplete", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-stage-cache-invalid-"));
  const serverDir = path.join(root, "server");
  const stagingDir = path.join(root, "staging");
  try {
    fs.mkdirSync(path.join(serverDir, "caches", "osrs-242_2026-11-03"), { recursive: true });
    fs.writeFileSync(path.join(serverDir, "target.txt"), "osrs-242_2026-11-03\n");
    assert.throws(
      () => stageReleaseCache({ serverDir, stagingDir, expectedRevision: 242 }),
      /cache revision consistency check failed/,
    );
    assert.equal(fs.existsSync(path.join(stagingDir, "caches")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
