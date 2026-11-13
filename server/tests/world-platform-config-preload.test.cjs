// Run from server/ after `yarn build`: node --test tests/world-platform-config-preload.test.cjs
//
// Issue #45: plugin switches and pluginConfig are resolved while plugins load, which is
// before the asynchronous platform handshake can answer. PaeScape persists the accepted
// platform overlay as data/definitions/world.platform.json; this test proves that layer
// is what PluginManager sees at startup, and that it actually gates plugin loading.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const WORK_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "paescape-preload-"));
const CONFIG_FILE = path.join(WORK_DIR, "world.platform.json");
const PLUGINS = path.join(WORK_DIR, "plugins");

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}
function plugin(file, name) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `module.exports = { name: "${name}", register(api) {} };`);
}

// The startup layer is read when WorldDefinition is first imported, so the snapshot and
// environment must exist before Server (which imports it) is required.
write(CONFIG_FILE, {
  name: "Platform World",
  plugins: { EnabledProbe: true, DisabledProbe: false, Pets: false },
  pluginConfig: { "probe:value": "platform", "SkillLevelUp:interruptActions": false },
});
plugin(path.join(PLUGINS, "enabled", "EnabledProbe.plugin.js"), "EnabledProbe");
plugin(path.join(PLUGINS, "disabled", "DisabledProbe.plugin.js"), "DisabledProbe");
plugin(path.join(PLUGINS, "pets", "Pets.plugin.js"), "Pets");
process.env.PAESCAPE_WORLD_PLATFORM_CONFIG = CONFIG_FILE;

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

test("the platform snapshot is the effective startup configuration", () => {
  const Definition = require("../dist/game/definition/WorldDefinition");
  const config = Definition.readWorldConfig();
  assert.equal(config.name, "Platform World", "the platform world name wins");
  assert.equal(config.plugins.Pets, false, "a switch off in the snapshot is off");
  assert.equal(config.plugins.EnabledProbe, true);
  assert.equal(config.plugins.DisabledProbe, false);
  assert.equal(config.pluginConfig["probe:value"], "platform");
  assert.equal(config.pluginConfig["SkillLevelUp:interruptActions"], false);
  const definition = Definition.getWorldDefinition();
  assert.equal(definition.name, "Platform World");
  assert.equal(definition.pluginConfig["SkillLevelUp:interruptActions"], false);
});

test("the snapshot actually gates which plugins load", () => {
  const { PluginManager } = require("../dist/plugins/PluginManager");
  PluginManager.loadFromDirectory(PLUGINS);
  assert.ok(PluginManager.loadedPlugins.includes("EnabledProbe"), "enabled probe loaded");
  assert.equal(PluginManager.loadedPlugins.includes("DisabledProbe"), false, "disabled probe not loaded");
  assert.equal(PluginManager.loadedPlugins.includes("Pets"), false, "Pets is disabled by the platform switch");
  assert.equal(PluginManager.getPluginConfig("probe:value"), "platform");
  assert.equal(PluginManager.getPluginConfig("SkillLevelUp:interruptActions"), false);
});