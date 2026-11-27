"use strict";

/**
 * Event tokens and account preferences (Paepay/tsps#65, platform contract
 * Paepay/PaeScape_Realms#110).
 *
 * The platform is the only writer of activations, token balances and account preferences.
 * The world reads them through the lease-authenticated `/events/*` routes and never reserves,
 * releases or consumes a token itself. Activation is one atomic platform call: the platform
 * checks the category slot and the player's token in one transaction and only spends a token
 * when the activation commits. The world then applies the returned `events` state locally.
 *
 * Every request carries the stable platform `userId`; the platform derives the character name
 * it records as the activator. One freshly generated idempotency key is used per player action.
 */

const crypto = require("crypto");
const Common = require("./Common.GlobalEvents");
const { getPlatformAccess } = require("../../paescape/PaeScapeBridge");

const API = Common.config().platform ?? {};
const REQUEST_TIMEOUT_MS = Number(API.requestTimeoutMs ?? 10000);
const ACCOUNT_PATH = API.accountPath ?? "/events/account";
const TOKENS_PATH = API.tokensPath ?? "/events/tokens";
const PREFERENCES_PATH = API.preferencesPath ?? "/events/preferences";
const ACTIVATE_PATH = API.activatePath ?? "/events/activate";

let api = null;
let core = null;
const accounts = new WeakMap();
const pending = new Set();

function request() {
  const access = getPlatformAccess();
  return typeof access?.worldRequest === "function" ? access.worldRequest : null;
}

function available() {
  const access = getPlatformAccess();
  return request() !== null && Boolean(access?.platformOrigin?.());
}

function userIdOf(player) {
  return Common.platformUserId(player?.getUsername?.());
}

function linked(player) {
  return userIdOf(player) !== null;
}

function status(player = null) {
  return {
    available: available(),
    linked: player ? linked(player) : null,
    userId: player ? userIdOf(player) : null,
  };
}

function tokenMessage(player, key, values = {}) {
  const text = Common.message(key, values);
  if (text) player?.sendMessage?.(text);
  return text;
}

function numberFrom(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function tokenRows(json) {
  const rows = Array.isArray(json?.tokens) ? json.tokens : [];
  return rows
    .map((row) => ({
      eventId: String(row?.eventId ?? ""),
      quantity: Math.max(0, Math.floor(Number(row?.quantity) || 0)),
    }))
    .filter((row) => Common.definition(row.eventId));
}

function tokenMap(rows) {
  return new Map(rows.map((row) => [row.eventId, row.quantity]));
}

function disabledFrom(json) {
  const account = json?.account ?? json ?? {};
  if (Array.isArray(account.disabledEventIds)) return account.disabledEventIds;
  if (Array.isArray(account.preferences)) {
    return account.preferences.filter((entry) => entry?.disabled === true).map((entry) => String(entry.eventId));
  }
  return null;
}

function recordFor(player) {
  return accounts.get(player) ?? null;
}

function recordAccount(player, { userId, paepointsBalance = null, tokens = null, disabledEventIds = null } = {}) {
  const previous = recordFor(player) ?? {};
  const next = {
    userId: userId ?? previous.userId ?? userIdOf(player),
    paepointsBalance: paepointsBalance === null ? previous.paepointsBalance ?? null : Math.max(0, Math.floor(Number(paepointsBalance) || 0)),
    tokens: tokens === null ? previous.tokens ?? new Map() : tokenMap(tokens),
    disabledEventIds: disabledEventIds === null ? previous.disabledEventIds ?? [] : disabledEventIds,
    fetchedAt: Date.now(),
  };
  accounts.set(player, next);
  return next;
}

function sendTokens(player, record) {
  const rows = [...record.tokens.entries()].map(([eventId, quantity]) => ({ eventId, quantity }));
  Common.sendPluginMessage(player, {
    type: "tokens",
    available: true,
    userId: record.userId,
    paepointsBalance: record.paepointsBalance,
    tokens: rows,
    balance: rows.reduce((total, row) => total + row.quantity, 0),
  });
}

async function call(player, path, options, label) {
  const send = request();
  if (!send) {
    tokenMessage(player, "tokenUnavailable");
    return { ok: false, error: "unavailable", status: 0, json: null };
  }
  try {
    const result = await send(path, { timeoutMs: REQUEST_TIMEOUT_MS, ...options });
    return result && typeof result.ok === "boolean"
      ? result
      : { ok: false, error: "invalid-response", status: 0, json: null };
  } catch (error) {
    api?.log?.(`GlobalEvents: ${label} failed: ${error.message}`);
    return { ok: false, error: "transport", status: 0, json: null };
  }
}

function withUser(base, userId) {
  return `${base}?userId=${encodeURIComponent(userId)}`;
}

function accountPath(userId) {
  return withUser(ACCOUNT_PATH, userId);
}

function tokensPath(userId) {
  return withUser(TOKENS_PATH, userId);
}

/**
 * Re-read the account's authoritative opt-outs, token counts and PaePoints balance. Called on
 * login, reconnect and whenever the Events UI opens, so a stale local view is never used.
 */
async function refreshAccount(player) {
  if (!available()) return { ok: false, error: "unavailable" };
  const userId = userIdOf(player);
  if (!userId) {
    tokenMessage(player, "tokenAccountUnlinked");
    return { ok: false, error: "unlinked" };
  }
  const result = await call(player, accountPath(userId), { method: "GET" }, "account refresh");
  if (!result.ok) {
    tokenMessage(player, result.status === 403 ? "tokenNotMember" : "tokenUnavailable");
    return { ok: false, error: "unavailable", status: result.status };
  }
  const account = result.json?.account ?? {};
  const disabled = disabledFrom(result.json) ?? [];
  Common.applyDisabledEvents(player, disabled);
  const record = recordAccount(player, {
    userId,
    // The platform renamed PaeBux to PaePoints; an older lease may still send the old field.
    paepointsBalance: account.paepointsBalance ?? account.paebuxBalance,
    tokens: tokenRows(account),
    disabledEventIds: disabled,
  });
  Common.sendState(player);
  sendTokens(player, record);
  return { ok: true, account: record };
}

/** Refresh only the token counts, as the Tokens tab does. */
async function refreshTokens(player) {
  if (!available()) return { ok: false, error: "unavailable" };
  const userId = userIdOf(player);
  if (!userId) {
    tokenMessage(player, "tokenAccountUnlinked");
    return { ok: false, error: "unlinked" };
  }
  const result = await call(player, tokensPath(userId), { method: "GET" }, "token refresh");
  if (!result.ok) {
    tokenMessage(player, result.status === 403 ? "tokenNotMember" : "tokenUnavailable");
    return { ok: false, error: "unavailable", status: result.status };
  }
  const body = result.json?.account ?? result.json ?? {};
  const record = recordAccount(player, {
    userId,
    paepointsBalance: body.paepointsBalance ?? body.paebuxBalance,
    tokens: tokenRows(body),
  });
  sendTokens(player, record);
  return { ok: true, account: record };
}

/** Backwards-compatible name used by the interface refresh loop. */
function refresh(player) {
  return refreshTokens(player);
}

function quantityFor(player, eventId) {
  return recordFor(player)?.tokens.get(eventId) ?? 0;
}

function paepointsBalance(player) {
  return recordFor(player)?.paepointsBalance ?? null;
}

function preferenceBody(userId, eventId, disabled) {
  return { userId, eventId, disabled: Boolean(disabled) };
}

/** Persist one account x event opt-out. The platform returns the whole authoritative list. */
async function setPreference(player, eventId, disabled) {
  const event = Common.definition(eventId);
  if (!event) return { ok: false, error: "unknown-event" };
  const userId = userIdOf(player);
  if (!userId) {
    tokenMessage(player, "tokenAccountUnlinked");
    return { ok: false, error: "unlinked" };
  }
  const result = await call(player, PREFERENCES_PATH, {
    method: "PUT",
    body: preferenceBody(userId, eventId, disabled),
  }, "preference update");
  if (!result.ok) {
    tokenMessage(player, result.status === 403 ? "tokenNotMember" : "tokenPreferenceFailed");
    return { ok: false, error: "preference", status: result.status };
  }
  const disabledIds = disabledFrom(result.json);
  if (disabledIds !== null) Common.applyDisabledEvents(player, disabledIds);
  const record = recordAccount(player, { userId, disabledEventIds: disabledIds });
  api?.emitCustomEvent?.("global-events:preference-changed", {
    player,
    eventId,
    enabled: !disabled,
    platform: true,
  });
  Common.sendState(player);
  return { ok: true, enabled: !disabled, disabledEventIds: record.disabledEventIds };
}

function newIdempotencyKey() {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

function activationBody(userId, eventId, idempotencyKey) {
  return { userId, eventId, idempotencyKey };
}

function errorKey(status, json) {
  const text = String(json?.error ?? json?.message ?? "");
  if (status === 402) return "tokenNone";
  if (status === 403) return "tokenNotMember";
  if (status === 400) return "tokenBadRequest";
  if (status === 409) return /duration/i.test(text) ? "tokenNoDuration" : "eventAlreadyRunning";
  return "tokenUnavailable";
}

function durationMinutes(activation) {
  const starts = Date.parse(String(activation?.startsAt ?? ""));
  const ends = Date.parse(String(activation?.endsAt ?? ""));
  if (Number.isFinite(starts) && Number.isFinite(ends) && ends > starts) {
    return Math.max(1, Math.round((ends - starts) / 60_000));
  }
  return null;
}

/**
 * Spend one token through the platform, then apply the returned world state. There is no
 * local reserve/consume step: the platform either activated the event and spent exactly one
 * token, or it refused and spent nothing.
 */
async function activate(player, eventId) {
  const event = Common.definition(eventId);
  if (!event) {
    tokenMessage(player, "adminUnknown", { event: eventId });
    return { ok: false, error: "unknown-event" };
  }
  if (!available()) {
    tokenMessage(player, "tokenUnavailable");
    return { ok: false, error: "unavailable" };
  }
  const userId = userIdOf(player);
  if (!userId) {
    tokenMessage(player, "tokenAccountUnlinked");
    return { ok: false, error: "unlinked" };
  }
  const key = `${userId}:${eventId}`;
  if (pending.has(key)) {
    tokenMessage(player, "tokenPending");
    return { ok: false, error: "pending" };
  }
  pending.add(key);
  try {
    const idempotencyKey = newIdempotencyKey();
    const result = await call(player, ACTIVATE_PATH, {
      method: "POST",
      body: activationBody(userId, eventId, idempotencyKey),
    }, "activation");
    if (!result.ok) {
      const messageKey = errorKey(result.status, result.json);
      tokenMessage(player, messageKey, {
        event: event.name,
        reason: String(result.json?.error ?? ""),
      });
      return {
        ok: false,
        error: messageKey,
        status: result.status,
        platformMessage: String(result.json?.error ?? ""),
      };
    }

    const events = result.json?.events;
    if (events && typeof events === "object") {
      Common.applyPlatformWorld(events, { reason: "activation" });
    } else {
      // The contract always returns the three slots. If a partial deployment does not, apply
      // just this activation rather than guessing that another category is empty.
      const slots = { combat: null, skilling: null, utility: null };
      if (result.json?.activation) slots[event.category] = result.json.activation;
      Common.applyPlatformWorld(slots, { reason: "activation" });
    }
    const previous = recordFor(player);
    if (previous) {
      // The activation response's tokenBalance is the authoritative post-spend count.
      const balance = numberFrom(result.json?.tokenBalance);
      if (balance !== null) {
        const tokens = new Map(previous.tokens);
        tokens.set(eventId, Math.max(0, Math.floor(balance)));
        recordAccount(player, { userId, tokens: [...tokens.entries()].map(([id, quantity]) => ({ eventId: id, quantity })) });
      }
    }
    const minutes = durationMinutes(result.json?.activation) ?? 0;
    tokenMessage(player, "tokenActivated", { event: event.name, minutes });
    Common.sendState(player);
    const record = recordFor(player);
    if (record) sendTokens(player, record);
    return { ok: true, minutes, activation: result.json?.activation ?? null };
  } finally {
    pending.delete(key);
  }
}

function attach(pluginApi) {
  api = pluginApi;
  core = pluginApi.core;
  Common.setTokenStatusProvider(status);
}

module.exports = {
  attach,
  available,
  linked,
  status,
  refreshAccount,
  refreshTokens,
  refresh,
  quantityFor,
  paepointsBalance,
  setPreference,
  activate,
  recordFor,
  _test: {
    tokenRows,
    tokenMap,
    disabledFrom,
    accountPath,
    tokensPath,
    preferenceBody,
    activationBody,
    errorKey,
    durationMinutes,
    numberFrom,
    pending,
  },
};
