// The prod deploy has to be one atomic operation: fetch, compile, restart and
// wait for the replacement. These checks pin the failures that made the first
// restart serve the previous build.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");

const root = path.resolve(__dirname, "../..");
const workflow = fs.readFileSync(path.join(root, ".github/workflows/deploy-prod.yml"), "utf8");
const operator = fs.readFileSync(path.join(root, "server/deploy/paescape-official"), "utf8");
const packageJson = require("../package.json");

test("a manual prod deploy updates the checkout before restarting", () => {
    assert.match(workflow, /default: update-and-restart/);
    assert.match(workflow, /restart|update-and-restart\)[\s\S]*?echo "do_update=true"/);
    assert.match(workflow, /restart|update-and-restart\)[\s\S]*?echo "do_restart=true"/);
});

test("the prod deploy forces a fresh build and verifies it", () => {
    assert.equal(packageJson.scripts["build:deploy"], "node ../scripts/client-version.mjs && tsc --build --force");
    assert.match(workflow, /yarn install --immutable && yarn build:deploy/);
    assert.match(workflow, /build reused \$server_js from before this deploy/);
});

test("the prod deploy waits for the replacement process", () => {
    const repoOperator = workflow.indexOf('operator="$VPS_PATH/server/deploy/paescape-official"');
    const installedOperator = workflow.indexOf("operator=/usr/local/bin/paescape-official");
    assert.ok(repoOperator >= 0 && installedOperator > repoOperator, "the repo operator is preferred");
    assert.match(workflow, /"\$operator" restart --wait/);
});

test("the operator accepts --wait and retries a transient platform failure", () => {
    assert.match(operator, /--wait\) wait=1 ;;/);
    assert.match(operator, /for attempt in 1 2 3; do/);
    assert.match(operator, /retrying in 10s/);
    assert.match(operator, /yarn --cwd server build:deploy/);
});
