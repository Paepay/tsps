// Unit coverage for the queued-save snapshot that feeds the website summary.
// Run after `yarn build`:
//   node --test tests/paescape-persistence-pending.test.cjs
//
// Does not boot the PaeScape platform: the transport is stubbed so the race
// between logout's async PUT and load()/buildSummary can be asserted on the
// same tick.
const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const { test, before, after } = require("node:test");

const SERVER_DIR = path.resolve(__dirname, "..");
const TRANSPORT_ID = require.resolve("../plugins/persistence/PaeScapePersistenceTransport");
const ADAPTER_ID = require.resolve("../plugins/persistence/PaeScapePlayerPersistence.plugin");

const state = {
  revisionByCharacter: new Map(),
  documents: new Map(),
  /** When set, every PUT awaits this promise before completing. */
  putGate: null,
};

function ok(json) {
  return { ok: true, status: 200, json, text: JSON.stringify(json) };
}

function notFound() {
  return { ok: false, status: 404, json: { error: "not found" }, text: "not found" };
}

function parseUrl(url) {
  const match = String(url).match(/\/api\/server\/characters\/([^/?]+)(?:\/state)?(?:\?profile=([^&]+))?/);
  if (!match) return null;
  return { characterId: decodeURIComponent(match[1]), profile: match[2] ? decodeURIComponent(match[2]) : "main" };
}

const fakeTransport = {
  requestSync({ url, method }) {
    if (String(url).includes("/api/server/characters/by-name/")) {
      const name = decodeURIComponent(String(url).split("/by-name/")[1] || "").toLowerCase();
      if (name === "pending hero") return ok({ character: { id: "char-pending" } });
      return notFound();
    }
    const parsed = parseUrl(url);
    if (!parsed || method !== "GET") return notFound();
    const key = parsed.characterId + ":" + parsed.profile;
    const revision = state.revisionByCharacter.get(key) || 0;
    const document = state.documents.get(key);
    return ok({ state: { revision, state: document === undefined ? null : document } });
  },
  async requestAsync({ url, method, body }) {
    if (state.putGate) await state.putGate;
    const parsed = parseUrl(url);
    if (!parsed || method !== "PUT") return notFound();
    const key = parsed.characterId + ":" + parsed.profile;
    const payload = typeof body === "string" ? JSON.parse(body) : body;
    const expected = Number(payload.expectedRevision) || 0;
    const current = state.revisionByCharacter.get(key) || 0;
    if (expected !== current) {
      return { ok: false, status: 409, json: { error: "revision conflict" }, text: "conflict" };
    }
    const next = current + 1;
    state.revisionByCharacter.set(key, next);
    state.documents.set(key, payload.state);
    return ok({ revision: next });
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === TRANSPORT_ID || request === "./PaeScapePersistenceTransport") {
    return fakeTransport;
  }
  return originalLoad.apply(this, arguments);
};
after(() => {
  Module._load = originalLoad;
});

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();

const { GameConstants } = require("../dist/game/GameConstants");
const { Player } = require("../dist/game/entity/impl/player/Player");
const { Item } = require("../dist/game/model/Item");
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { SkillManager } = require("../dist/game/content/skill/SkillManager");
const bridge = require("../plugins/paescape/PaeScapeBridge");

delete require.cache[ADAPTER_ID];
const adapterModule = require("../plugins/persistence/PaeScapePlayerPersistence.plugin");

function installAdapter() {
  bridge.setPlatformAccess({
    platformOrigin: () => "http://127.0.0.1:9",
    leaseToken: () => "test-lease",
    readConfig: () => ({ url: "http://127.0.0.1:9", worldSecret: "" }),
  });
  const active = new adapterModule.PaeScapePlayerPersistence(SkillManager);
  GameConstants.setPlayerPersistence(active);
  return active;
}

function makePlayer(name) {
  const session = { sendClientPacket: () => true, write() {}, getChannel: () => null };
  const player = new Player(session);
  player.setUsername(name);
  return player;
}

before(async () => {
  await CachePipeline.initialize(SERVER_DIR);
});

test("load returns a queued logout save before the platform PUT finishes", async () => {
  // The website's "Refresh data" builds a summary via load(). Logout only enqueues
  // an async platform write; without a pending snapshot, load kept serving the
  // pre-logout cache and the characters page looked frozen until a later refresh.
  state.revisionByCharacter.clear();
  state.documents.clear();
  state.putGate = null;

  const active = installAdapter();
  const player = makePlayer("Pending Hero");
  player.getInventory().setItem(0, new Item(995, 10));

  assert.equal(active.load("Pending Hero"), null, "new character has no prior state");
  active.save(player, "autosave");
  await active.flush();
  assert.equal(active.load("Pending Hero").getInventory()[0].getAmount(), 10, "cache is primed at the pre-logout value");

  let releasePut;
  state.putGate = new Promise((resolve) => {
    releasePut = resolve;
  });

  player.getInventory().setItem(0, new Item(995, 99));
  active.save(player, "logout");
  const pending = active.load("Pending Hero");
  assert.equal(
    pending.getInventory()[0].getAmount(),
    99,
    "load must surface the queued logout snapshot on the same tick, before the PUT completes",
  );
  assert.ok(active.writesCompleted < active.writesQueued, "the gated PUT is still in flight");

  releasePut();
  await active.flush();
  assert.equal(active.load("Pending Hero").getInventory()[0].getAmount(), 99, "the snapshot still matches after the write lands");
});
