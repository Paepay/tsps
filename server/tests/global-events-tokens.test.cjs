// Run after `yarn build`: node --test tests/global-events-tokens.test.cjs
// Paepay/tsps#65 / Paepay/PaeScape_Realms#110: the platform is the only writer of activations,
// token balances and account preferences. The world makes one atomic activation call, re-reads
// account state, and applies the authoritative three-slot world state it receives.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, before, beforeEach, afterEach } = require("node:test");

const { Server } = require("../dist/Server");
Server.installProductionPathResolver();
const { CachePipeline } = require("../dist/game/cache/CachePipeline");
const { setPlatformAccess } = require("../plugins/paescape/PaeScapeBridge");
const Common = require("../plugins/events/global/Common.GlobalEvents");
const Tokens = require("../plugins/events/global/Tokens.GlobalEvents");

let store;
let calls;
let respond;

before(async () => {
  await CachePipeline.initialize(path.resolve(__dirname, ".."));
  store = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "global-events-")), "state.json");
  Common.testing.setStoreFile(store);
  Common.testing.reset();
  Tokens.attach({ core: {}, log() {} });
});

beforeEach(() => {
  Common.testing.reset();
  calls = [];
  respond = defaultResponses;
  setPlatformAccess({
    platformOrigin: () => "https://platform.example",
    platformUserId: (name) => (String(name).toLowerCase() === "tokener" ? "user-1" : null),
    worldRequest: async (route, options = {}) => {
      calls.push({ route, method: options.method ?? "GET", body: options.body ?? null });
      return respond(route, options);
    },
  });
});

afterEach(() => {
  setPlatformAccess(null);
});

function tokens(quantity = 2, eventId = "berserker") {
  return Common.catalog().map((event) => ({
    eventId: event.id,
    quantity: event.id === eventId ? quantity : 0,
  }));
}

function activationFor(eventId, tokenBalance = 1) {
  const event = Common.definition(eventId);
  const startsAt = new Date(Date.now() - 1000).toISOString();
  const endsAt = new Date(Date.now() + 5 * 60_000).toISOString();
  const activation = {
    category: event.category,
    eventId: event.id,
    name: event.name,
    summary: event.summary,
    description: event.description,
    effect: event.effect,
    startsAt,
    endsAt,
    activationId: `activation-${event.id}`,
    activator: { userId: "user-1", displayName: "Tokener" },
  };
  const events = { combat: null, skilling: null, utility: null };
  events[event.category] = activation;
  return { activation, events, tokenBalance };
}

function defaultResponses(route, options) {
  if (route.startsWith("/events/account")) {
    return {
      ok: true,
      status: 200,
      json: {
        account: {
          userId: "user-1",
          paepointsBalance: 250,
          tokens: tokens(2),
          preferences: [],
          disabledEventIds: [],
        },
      },
    };
  }
  if (route.startsWith("/events/tokens")) {
    return { ok: true, status: 200, json: { userId: "user-1", paepointsBalance: 250, tokens: tokens(2) } };
  }
  if (route === "/events/preferences" && options.method === "PUT") {
    const disabledEventIds = options.body?.disabled ? [options.body.eventId] : [];
    return {
      ok: true,
      status: 200,
      json: {
        preference: { eventId: options.body.eventId, disabled: Boolean(options.body.disabled) },
        preferences: [],
        disabledEventIds,
      },
    };
  }
  if (route === "/events/activate" && options.method === "POST") {
    const result = activationFor(options.body.eventId);
    return { ok: true, status: 201, json: { ok: true, replayed: false, ...result } };
  }
  return { ok: true, status: 200, json: {} };
}

function player(name = "tokener") {
  const messages = [];
  return {
    messages,
    attributes: new Map(),
    getUsername: () => name,
    sendMessage: (message) => messages.push(message),
    getAttribute(key) { return this.attributes.get(key); },
    setAttribute(key, value) { this.attributes.set(key, value); },
  };
}

test("activation is one atomic platform call with the userId and a fresh idempotency key", async () => {
  const p = player();
  const result = await Tokens.activate(p, "berserker");
  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => `${call.method} ${call.route}`), ["POST /events/activate"]);
  assert.equal(calls[0].body.userId, "user-1");
  assert.equal(calls[0].body.eventId, "berserker");
  assert.match(calls[0].body.idempotencyKey, /^[0-9a-f-]{20,}$/i);
  assert.equal(Common.active("combat").eventId, "berserker");
  assert.equal(Common.active("combat").instanceId, "activation-berserker");
  assert.equal(result.minutes, 5);
  assert.match(p.messages.join("\n"), /Berserker activated for 5 minutes/);
  assert.equal(Tokens.recordFor(p), null, "a player who never refreshed has no cached account yet");
});

test("a 402 means no token: nothing is activated and nothing is spent", async () => {
  respond = () => ({ ok: false, status: 402, json: { error: "You do not have a Berserker token to activate." } });
  const p = player();
  const result = await Tokens.activate(p, "berserker");
  assert.equal(result.ok, false);
  assert.equal(result.status, 402);
  assert.equal(Common.active("combat"), null);
  assert.match(p.messages.join("\n"), /don't have a Berserker token/);
});

test("a 409 reports the occupied category and leaves the platform state alone", async () => {
  respond = () => ({
    ok: false,
    status: 409,
    json: { error: "combat already has Onslaught active on this world until 2026-01-01." },
  });
  const p = player();
  const result = await Tokens.activate(p, "berserker");
  assert.equal(result.ok, false);
  assert.equal(result.error, "eventAlreadyRunning");
  assert.match(p.messages.join("\n"), /category already has an event running/);
});

test("a 409 duration error and a 403 membership error map to clear messages", async () => {
  respond = () => ({ ok: false, status: 409, json: { error: "Deadeye does not have a configured duration yet." } });
  const p = player();
  assert.equal((await Tokens.activate(p, "deadeye")).error, "tokenNoDuration");
  assert.match(p.messages.join("\n"), /does not have a configured duration/);

  respond = () => ({ ok: false, status: 403, json: { error: "That account is not a member of this world." } });
  const outsider = player();
  assert.equal((await Tokens.activate(outsider, "deadeye")).error, "tokenNotMember");
  assert.match(outsider.messages.join("\n"), /not a member of this world/);
});

test("an unlinked character and an unavailable platform both fail closed without a request", async () => {
  const unlinked = player("stranger");
  const result = await Tokens.activate(unlinked, "accelerate");
  assert.equal(result.ok, false);
  assert.equal(result.error, "unlinked");
  assert.equal(calls.length, 0);
  assert.match(unlinked.messages.join("\n"), /not linked to a PaeScape account/);

  setPlatformAccess(null);
  const p = player();
  const unavailable = await Tokens.activate(p, "accelerate");
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.error, "unavailable");
  assert.match(p.messages.join("\n"), /PaeScape platform is unavailable/);
});

test("concurrent clicks for the same account and event make one activation request", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  respond = async (route, options) => {
    await gate;
    return defaultResponses(route, options);
  };
  const p = player();
  const first = Tokens.activate(p, "rags-to-riches");
  const second = Tokens.activate(p, "rags-to-riches");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1, "one activation in flight");
  release();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((result) => result.ok), [true, false]);
  assert.match(p.messages.join("\n"), /already in progress/);
});

test("refreshAccount applies the platform's disabledEventIds and per-event token counts", async () => {
  respond = (route) => route.startsWith("/events/account")
    ? {
      ok: true,
      status: 200,
      json: {
        account: {
          userId: "user-1",
          paepointsBalance: 42,
          tokens: tokens(3, "mystique"),
          preferences: [{ eventId: "accelerate", disabled: true }],
          disabledEventIds: ["accelerate"],
        },
      },
    }
    : defaultResponses(route, { method: "GET" });
  const p = player();
  const result = await Tokens.refreshAccount(p);
  assert.equal(result.ok, true);
  assert.deepEqual(Common.disabledEvents(p), ["accelerate"]);
  assert.equal(Tokens.quantityFor(p, "mystique"), 3);
  assert.equal(Tokens.quantityFor(p, "berserker"), 0);
  assert.equal(Tokens.paepointsBalance(p), 42);
  assert.match(calls[0].route, /^\/events\/account\?userId=user-1$/);
});

test("a preference write is account x event and stores the authoritative disabled list", async () => {
  const p = player();
  const result = await Tokens.setPreference(p, "accelerate", true);
  assert.equal(result.ok, true);
  assert.equal(result.enabled, false);
  assert.deepEqual(calls[0].body, { userId: "user-1", eventId: "accelerate", disabled: true });
  assert.deepEqual(Common.disabledEvents(p), ["accelerate"]);
  assert.equal(Common.effectsEnabled(p, "accelerate"), false);
});

test("the platform helpers use the documented shapes", () => {
  const helpers = Tokens._test;
  assert.equal(helpers.accountPath("a b"), "/events/account?userId=a%20b");
  assert.equal(helpers.tokensPath("a b"), "/events/tokens?userId=a%20b");
  assert.deepEqual(helpers.preferenceBody("u", "prodigy", false), { userId: "u", eventId: "prodigy", disabled: false });
  assert.deepEqual(helpers.activationBody("u", "prodigy", "key"), { userId: "u", eventId: "prodigy", idempotencyKey: "key" });
  assert.equal(helpers.errorKey(402, {}), "tokenNone");
  assert.equal(helpers.errorKey(403, {}), "tokenNotMember");
  assert.equal(helpers.errorKey(400, {}), "tokenBadRequest");
  assert.equal(helpers.errorKey(409, { error: "no configured duration" }), "tokenNoDuration");
  assert.equal(helpers.errorKey(409, { error: "slot busy" }), "eventAlreadyRunning");
  assert.equal(helpers.errorKey(500, {}), "tokenUnavailable");
  const activation = { startsAt: new Date(Date.now()).toISOString(), endsAt: new Date(Date.now() + 7 * 60_000).toISOString() };
  assert.equal(helpers.durationMinutes(activation), 7);
  assert.deepEqual(helpers.tokenRows({ tokens: [{ eventId: "berserker", quantity: 2 }, { eventId: "nope", quantity: 4 }] }),
    [{ eventId: "berserker", quantity: 2 }]);
});
