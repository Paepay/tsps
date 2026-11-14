// DiscordNames.PaeScape unit coverage (no platform / world boot).
//   node --test tests/discord-names-paescape.test.cjs
const assert = require("node:assert/strict");
const { test } = require("node:test");
const DiscordNames = require("../plugins/paescape/DiscordNames.PaeScape.js");

test("sanitizeDiscordName strips tags and bounds length", () => {
  assert.equal(DiscordNames.sanitizeDiscordName("  Pat <>  "), "Pat");
  assert.equal(DiscordNames.sanitizeDiscordName(""), null);
  assert.equal(DiscordNames.sanitizeDiscordName(null), null);
  assert.equal(DiscordNames.sanitizeDiscordName("a".repeat(40)).length, 32);
});

test("rememberPending stores a clean name under the account key", () => {
  DiscordNames._test.reset();
  // Attach only enough core for Accounts.key; login hooks are unused here.
  DiscordNames.attach({
    core: {
      Accounts: { key: (name) => String(name).toLowerCase().replace(/[^a-z0-9]/g, "") },
      World: { getPlayers: () => [], getPlayerByName: () => undefined },
      encodePluginMessage: (channel, data) => ({ channel, data }),
    },
    onPlayerLogin() {},
    onPlayerLogout() {},
    onPlayerDisconnect() {},
  });
  DiscordNames.rememberPending("Zezima", "  Patrick <> ");
  assert.equal(DiscordNames._test.pendingByAccount.get("zezima"), "Patrick");
  DiscordNames.rememberPending("Zezima", "");
  assert.equal(DiscordNames._test.pendingByAccount.has("zezima"), false);
  DiscordNames._test.reset();
});
