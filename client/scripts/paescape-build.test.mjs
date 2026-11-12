import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { validatePaeScapeBuild } from "./build-paescape.mjs";

function fixture(index = '<script src="/client/static/js/main.js"></script>') {
    const root = mkdtempSync(path.join(os.tmpdir(), "paescape-client-build-"));
    mkdirSync(path.join(root, "static/js"), { recursive: true });
    writeFileSync(path.join(root, "index.html"), index);
    writeFileSync(path.join(root, "service-worker.js"), "// scoped shell worker");
    writeFileSync(path.join(root, "static/js/main.js"), "console.log('client')");
    writeFileSync(path.join(root, "asset-manifest.json"), JSON.stringify({
        files: { main: "/client/static/js/main.js" },
        entrypoints: ["/client/static/js/main.js"],
    }));
    return root;
}

const valid = fixture();
try {
    assert.equal(validatePaeScapeBuild(valid).files, 4);
} finally {
    rmSync(valid, { recursive: true, force: true });
}

const legacy = fixture('<script src="/play/static/js/main.js"></script>');
try {
    assert.throws(() => validatePaeScapeBuild(legacy), /does not load assets from \/client/);
} finally {
    rmSync(legacy, { recursive: true, force: true });
}

const missing = fixture();
try {
    writeFileSync(path.join(missing, "asset-manifest.json"), JSON.stringify({
        files: { main: "/client/static/js/missing.js" },
    }));
    assert.throws(() => validatePaeScapeBuild(missing), /missing asset/);
} finally {
    rmSync(missing, { recursive: true, force: true });
}

console.log("PaeScape deployment build contract passed");
