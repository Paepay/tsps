import assert from "node:assert/strict";

import { parseWorldIdFromPath } from "../config/clientEnv";

// Production: the PaeScape client is mounted at /client.
assert.equal(parseWorldIdFromPath("/client/browser-zqnoxb", "/client"), "browser-zqnoxb");
assert.equal(parseWorldIdFromPath("/client/world-1", "/client/"), "world-1");
assert.equal(parseWorldIdFromPath("/client/browser-x/extra", "/client"), "browser-x");
assert.equal(parseWorldIdFromPath("/client", "/client"), undefined);
assert.equal(parseWorldIdFromPath("/", "/client"), undefined);

// Development: craco forces PUBLIC_URL to "/" but hosted links still carry /client.
assert.equal(parseWorldIdFromPath("/client/browser-zqnoxb", "/"), "browser-zqnoxb");
assert.equal(parseWorldIdFromPath("/client", "/"), undefined);
assert.equal(parseWorldIdFromPath("/browser-zqnoxb", "/"), "browser-zqnoxb");
assert.equal(parseWorldIdFromPath("/", "/"), undefined);

// The logout/refresh path must not be mistaken for a world id.
assert.equal(parseWorldIdFromPath("/client/bad world", "/client"), undefined);
assert.equal(parseWorldIdFromPath("", "/client"), undefined);

console.log("browser-host-world-path ok");
