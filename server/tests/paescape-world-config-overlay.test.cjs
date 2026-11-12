// Run from server/ after `yarn build`: node --test tests/paescape-world-config-overlay.test.cjs
//
// A hosted world is configured on the website, which stores and returns a config blob
// in its own shape (`{ settings: { spawn, xpRate, zones, ... } }`). The runtime reads a
// different, flatter world.json shape. The plugin has to bridge the two, and until it
// did, a world's configured spawn, XP rate and zones never reached the server: the
// owner picked coordinates and rates that were silently ignored.
//
// Two halves, both pinned here without a live platform:
//   1. PlatformWorldConfig.toWorldOverlay - the pure blob -> world.json translation,
//      including the xpRate key the platform actually writes.
//   2. WorldDefinition.applyWorldConfigOverlay - the core layering that applies the
//      result to a running server, idempotently and fail-closed.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { toWorldOverlay } = require("../plugins/paescape/PlatformWorldConfig.js");

/* ------------------------------------------------- translation (pure) --- */

/** The blob shape the platform stores and returns (PaeScape_Realms world-adapter.ts). */
function platformBlob(settings, extra = {}) {
  return { version: 1, mode: "online", template: "osrs", settings, shops: [], mapOverrides: [], ...extra };
}

test("the platform's xpRate key becomes the runtime's experienceMultiplier", () => {
  // The platform writes settings.xpRate; the old plugin read settings.experienceMultiplier,
  // a key the platform never writes, so the XP branch never fired.
  const { overlay, experienceRate } = toWorldOverlay(platformBlob({ xpRate: 1000 }));
  assert.equal(overlay.experienceMultiplier, 1000);
  assert.equal(experienceRate, 1000);
});

test("an experienceMultiplier key is accepted as a fallback", () => {
  const { overlay } = toWorldOverlay(platformBlob({ experienceMultiplier: 7 }));
  assert.equal(overlay.experienceMultiplier, 7);
});

test("the owner's spawn is translated, defaulting a missing plane to 0", () => {
  assert.deepEqual(toWorldOverlay(platformBlob({ spawn: { x: 3222, y: 3219, z: 1 } })).overlay.spawn, { x: 3222, y: 3219, z: 1 });
  assert.deepEqual(toWorldOverlay(platformBlob({ spawn: { x: 3095, y: 3495 } })).overlay.spawn, { x: 3095, y: 3495, z: 0 });
});

test("an out-of-range spawn is dropped with a note, without failing the rest", () => {
  const { overlay, notes } = toWorldOverlay(platformBlob({ spawn: { x: -1, y: 99999 }, xpRate: 5 }));
  assert.equal(overlay.spawn, undefined, "a bad spawn is not applied");
  assert.equal(overlay.experienceMultiplier, 5, "the rest of the config still applies");
  assert.ok(notes.some((n) => /spawn/i.test(n)), `a note explains the dropped spawn: ${JSON.stringify(notes)}`);
});

test("an empty or absent zone list leaves the world's own zones alone", () => {
  // Empty means "not authored on the website", not "this world has no zones".
  assert.equal(toWorldOverlay(platformBlob({ zones: [] })).overlay, null);
  assert.equal(toWorldOverlay(platformBlob({})).overlay, null);
});

test("a global-PvP world becomes one whole-map pvp zone, buildings-safe when asked", () => {
  const plain = toWorldOverlay(platformBlob({ globalPvp: true })).overlay;
  assert.deepEqual(plain.zones, [{ tags: ["pvp"] }]);
  const safe = toWorldOverlay(platformBlob({ globalPvp: true, allBuildingsSafe: true })).overlay;
  assert.deepEqual(safe.zones, [{ tags: ["pvp", "all-buildings-safe"] }]);
});

test("F2P is carried as the FreeToPlay plugin switch the runtime derives members from", () => {
  assert.deepEqual(toWorldOverlay(platformBlob({ f2pWorld: true })).overlay.plugins, { FreeToPlay: true });
  assert.deepEqual(toWorldOverlay(platformBlob({ f2pWorld: false })).overlay.plugins, { FreeToPlay: false });
});

test("a non-positive XP rate is rejected with a note", () => {
  const zero = toWorldOverlay(platformBlob({ xpRate: 0 }));
  assert.equal(zero.overlay, null);
  assert.ok(zero.notes.some((n) => /xp rate/i.test(n)));
});

test("a non-object config is refused rather than throwing", () => {
  assert.deepEqual(toWorldOverlay(null).overlay, null);
  assert.deepEqual(toWorldOverlay("nope").overlay, null);
});

/* ------------------------------------------------------ overlay (core) --- */

const modulePath = require.resolve("../dist/game/definition/WorldDefinition");
// Load runtime dependencies before the fixture switches to a minimal data directory.
const { PluginManager } = require("../dist/plugins/PluginManager");

const SHIPPED = {
  spawn: { x: 3089, y: 3524, z: 0 },
  zones: [{ tags: ["multi-combat"] }, { minX: 0, maxX: 0x3fff, minY: 0, maxY: 0x3fff, z: 0, tags: ["f2p"] }],
  plugins: { TutorialIsland: false },
  experienceMultiplier: 1,
  description: "",
};

/** Loads a fresh WorldDefinition over a temp data directory holding world.json. */
function withFreshWorld(run, shippedWorld = SHIPPED) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tsps-world-overlay-"));
  const cwd = process.cwd();
  try {
    fs.mkdirSync(path.join(directory, "data/definitions"), { recursive: true });
    fs.writeFileSync(path.join(directory, "data/definitions/world.json"), JSON.stringify(shippedWorld));
    process.chdir(directory);
    delete require.cache[modulePath];
    const world = require(modulePath);
    PluginManager.pluginConfigCache = undefined;
    return run(world);
  } finally {
    process.chdir(cwd);
    PluginManager.pluginConfigCache = undefined;
    delete require.cache[modulePath];
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("applying an overlay changes the running spawn, XP, zones and description", () => {
  withFreshWorld((world) => {
    assert.deepEqual({ ...world.WORLD_SPAWN }, { x: 3089, y: 3524, z: 0 });
    const result = world.applyWorldConfigOverlay({
      spawn: { x: 3222, y: 3219, z: 0 },
      experienceMultiplier: 1000,
      description: "Test world for trials",
      zones: [{ tags: ["pvp"] }],
    });
    assert.equal(result.applied, true, result.error);
    const definition = world.getWorldDefinition();
    assert.equal(definition.experienceMultiplier, 1000);
    assert.equal(definition.description, "Test world for trials");
    assert.equal(definition.zones.length, 1);
    assert.equal(definition.zones[0].tags[0], "pvp");
    // WORLD_SPAWN is a mutable Location the sync keeps in step, so the same object
    // a login clones now points at the configured coordinates.
    assert.deepEqual({ ...world.WORLD_SPAWN }, { x: 3222, y: 3219, z: 0 });
  });
});

test("re-applying without a key restores the world file's value (idempotent layering)", () => {
  withFreshWorld((world) => {
    world.applyWorldConfigOverlay({ spawn: { x: 3222, y: 3219, z: 0 }, experienceMultiplier: 50 });
    assert.equal(world.getWorldDefinition().experienceMultiplier, 50);
    // The second overlay omits experienceMultiplier, so the file's 1 comes back -
    // an overlay layers over the file, never over the previous overlay.
    world.applyWorldConfigOverlay({ spawn: { x: 3100, y: 3200, z: 0 } });
    assert.equal(world.getWorldDefinition().experienceMultiplier, 1);
    assert.deepEqual({ ...world.WORLD_SPAWN }, { x: 3100, y: 3200, z: 0 });
  });
});

test("an invalid overlay is refused and leaves the running world untouched", () => {
  withFreshWorld((world) => {
    const before = world.getWorldDefinition();
    const result = world.applyWorldConfigOverlay({ spawn: { x: -5, y: 0, z: 0 } });
    assert.equal(result.applied, false);
    assert.ok(result.error, "the refusal carries a reason");
    assert.deepEqual(world.getWorldDefinition(), before, "nothing changed");
    assert.deepEqual({ ...world.WORLD_SPAWN }, { x: 3089, y: 3524, z: 0 });
  });
});

test("a F2P overlay whose spawn is inside f2p land applies", () => {
  withFreshWorld((world) => {
    // The f2p zone is a box around the spawn, so flipping a members world to F2P keeps
    // that spawn and the world becomes members-free.
    assert.equal(world.isMembersWorld(), true);
    const result = world.applyWorldConfigOverlay({ plugins: { FreeToPlay: true } });
    assert.equal(result.applied, true, result.error);
    assert.equal(world.isMembersWorld(), false);
    assert.equal(world.isMembersArea(1000, 1000), true, "land outside the f2p zone is members land");
    assert.equal(world.isMembersArea(3050, 3500), false, "the f2p zone itself is free land");
  }, {
    spawn: { x: 3050, y: 3500, z: 0 },
    zones: [{ minX: 3000, maxX: 3100, minY: 3400, maxY: 3600, z: 0, tags: ["f2p"] }],
    plugins: { TutorialIsland: false },
    experienceMultiplier: 1,
  });
});

test("a F2P overlay that leaves the spawn outside every f2p zone is refused", () => {
  withFreshWorld((world) => {
    const result = world.applyWorldConfigOverlay({ plugins: { FreeToPlay: true }, spawn: { x: 1000, y: 1000, z: 0 } });
    assert.equal(result.applied, false);
    assert.ok(/f2p/i.test(result.error), `the reason names the f2p rule: ${result.error}`);
  }, {
    spawn: { x: 3050, y: 3500, z: 0 },
    zones: [{ minX: 3000, maxX: 3100, minY: 3400, maxY: 3600, z: 0, tags: ["f2p"] }],
    plugins: { TutorialIsland: false },
    experienceMultiplier: 1,
  });
});
