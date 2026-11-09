"use strict";

/**
 * Authoritative WORLD data for plugins: the scoreboards, records, timeboards and
 * noticeboards a world accumulates as players play (kills, deaths, best times,
 * clan rosters, party-chest contents, shooting-star history), as opposed to one
 * character's own save.
 *
 * Task 10 (section 8): a hosted world must keep its authoritative world state on
 * the PaeScape platform, not in JSON files beside server.exe. This module is the
 * seam. A plugin keeps its existing file code as the standalone path and asks this
 * module only when the world is hosted:
 *
 *   if (worldData.isHosted()) { ... platform read/write ... } else { ...file... }
 *
 * Hosted reads and writes go to one shared document in the platform's world-state
 * row, keyed by a per-plugin store name and written with the platform's optimistic
 * concurrency and idempotency. Nothing is written to the host's disk in hosted
 * mode. Reads are served from an in-memory mirror loaded once from the platform, so
 * a scoreboard read on a game tick never blocks on the network; writes update the
 * mirror and upload on a coalescing background chain. A write is refused before the
 * mirror has loaded, so an unloaded store can never overwrite the platform's copy
 * with zeros. The whole document is versioned so a later schema change can migrate
 * it rather than guess.
 */

const { isHostedPersistence } = require("./PaeScapePersistenceMode");
const { requestSync, requestAsync } = require("./PaeScapePersistenceTransport");
const { getPlatformAccess } = require("../paescape/PaeScapeBridge");

/** Per-request timeout to the platform. */
const REQUEST_TIMEOUT_MS = Number(process.env.PAESCAPE_WORLDDATA_TIMEOUT_MS) > 0
  ? Math.floor(Number(process.env.PAESCAPE_WORLDDATA_TIMEOUT_MS))
  : 8000;
/** Bounded retries for a recoverable world-state upload. */
const MAX_WRITE_ATTEMPTS = Number(process.env.PAESCAPE_WORLDDATA_ATTEMPTS) > 0
  ? Math.floor(Number(process.env.PAESCAPE_WORLDDATA_ATTEMPTS))
  : 4;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15000;
/** Schema version of the world-state document this module writes. */
const SCHEMA_VERSION = 1;

let hostedCache;

/** True when the platform owns world state (a platform URL and no world secret). */
function isHosted() {
  if (hostedCache === undefined) {
    try {
      hostedCache = isHostedPersistence();
    } catch (_error) {
      hostedCache = false;
    }
  }
  return hostedCache;
}

/** storeName -> value. The in-memory mirror of the platform world-state document. */
let stores = {};
/** True once the platform document has been read into the mirror. */
let loaded = false;
/** The platform revision the mirror is based on. */
let revision = 0;
/** Set when a load was attempted and failed, so read() can report "unavailable". */
let loadError = null;
/** The coalescing upload for the current dirty mirror, or null. */
let pendingUpload = null;
/** Upload failures since the last flush(), so flush() can rethrow the first. */
const failures = [];
let writesCompleted = 0;

class WorldDataFailure extends Error {
  constructor(message, status) {
    super(message);
    this.name = "WorldDataFailure";
    this.status = status ?? 0;
  }
}

function isRetryableStatus(status) {
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}

function backoff(attempt) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Blocking sleep for the synchronous path, without busy-waiting. */
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_error) {
    // Atomics.wait is unavailable (rare on a browser-like runtime); skip the delay.
  }
}

function nextIdempotencyKey() {
  try {
    return "world-data:" + require("node:crypto").randomUUID();
  } catch (_error) {
    return "world-data:" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }
}

/** The platform origin and a live lease bearer token, or a refusal to proceed. */
function endpoint() {
  const access = getPlatformAccess();
  if (!access || typeof access.platformOrigin !== "function") {
    throw new WorldDataFailure("The PaeScape platform bridge is unavailable; refusing to fall back to local world data.");
  }
  const origin = String(access.platformOrigin() ?? "").replace(/\/+$/, "");
  if (!origin) throw new WorldDataFailure("No PaeScape platform URL is configured.");
  const token = typeof access.leaseToken === "function" ? access.leaseToken() : null;
  if (!token) {
    throw new WorldDataFailure("This world holds no valid platform authorization lease; world data cannot be loaded or saved.");
  }
  return { origin, token };
}

/**
 * The stores object from a world-state response. The GET route returns
 * `{ ok, state: { worldId, revision, state: <document>, updatedAt } }`, where the
 * inner `state` is the document this module wrote (`{ __paescapeWorldData, stores }`).
 * Tolerate that shape and the two flatter ones (the document directly, or a
 * `{ revision, state }` wrapper) so a future route change does not silently load an
 * empty mirror and overwrite the platform's copy.
 */
function parseDocument(text) {
  try {
    const parsed = text ? JSON.parse(text) : null;
    if (!parsed || typeof parsed !== "object") return { stores: {}, revision: 0 };
    // Peel the route envelope, then any document-level wrapper, to the stores map.
    const envelope = parsed.state && typeof parsed.state === "object" ? parsed.state : parsed;
    const revision = Number(envelope.revision) || 0;
    const candidates = [envelope.state, envelope];
    for (const candidate of candidates) {
      if (candidate && typeof candidate === "object" && candidate.stores && typeof candidate.stores === "object") {
        return { stores: candidate.stores, revision };
      }
    }
  } catch (_error) {
    // An unreadable document is treated as empty rather than crashing a login.
  }
  return { stores: {}, revision: 0 };
}

/**
 * Read the world-state document from the platform into the mirror. Runs once,
 * synchronously (login-time style), so a later read on a game tick is a memory
 * lookup. Never throws for a reachable-but-refused request: it records the error
 * and leaves the mirror unloaded, so read() reports "unavailable" instead of
 * silently serving an empty (and therefore destructive) default.
 */
function load() {
  if (loaded) return true;
  const { origin, token } = endpoint();
  const response = requestSync({
    url: origin + "/api/server/world-state",
    method: "GET",
    headers: { authorization: "Bearer " + token, accept: "application/json" },
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
  if (!response.ok) {
    loadError = new WorldDataFailure("The platform could not load world state (status " + response.status + ").", response.status);
    return false;
  }
  const document = parseDocument(response.text);
  stores = { ...document.stores };
  revision = document.revision;
  loaded = true;
  loadError = null;
  return true;
}

/**
 * Load world state once a lease exists. The PaeScape plugin calls this right
 * after the hosted handshake, so stores are warm before players touch them.
 */
function prefetch() {
  if (!isHosted()) return false;
  try {
    return load();
  } catch (error) {
    loadError = error instanceof Error ? error : new Error(String(error));
    return false;
  }
}

/**
 * The named store's value. Returns `{ loaded, value }`. `loaded` is false in hosted
 * mode until the mirror has been read (or if the read failed), so a caller keeps
 * its default rather than caching an empty value that would look authoritative.
 * Never throws: a read on a game tick must not interrupt play.
 */
function read(key) {
  if (!isHosted()) return { loaded: false, value: undefined, hosted: false };
  if (!loaded) {
    try {
      if (!load()) return { loaded: false, value: undefined, hosted: true, error: loadError };
    } catch (error) {
      return { loaded: false, value: undefined, hosted: true, error };
    }
  }
  return { loaded: true, value: stores[key], hosted: true };
}

/** Mark the mirror dirty and coalesce the next upload into one request. */
function scheduleFlush() {
  if (pendingUpload) return;
  pendingUpload = new Promise((resolve) => {
    const timer = setTimeout(resolve, 0);
    timer.unref?.();
  })
    .then(() => upload())
    .finally(() => {
      pendingUpload = null;
    });
}

/**
 * Make sure the mirror is loaded before a write, so an unloaded store has an
 * authoritative copy in memory instead of overwriting the platform's copy with a
 * default. Throws (WorldDataFailure) when the platform copy cannot be read.
 */
function ensureLoaded(key) {
  if (loaded) return;
  let ok = false;
  try {
    ok = load();
  } catch (error) {
    throw error instanceof WorldDataFailure ? error : new WorldDataFailure(String(error && error.message ? error.message : error));
  }
  if (!ok) throw new WorldDataFailure("Refusing to write world data for " + key + ": the platform state is not loaded.");
}

/**
 * Set a store's value and upload the whole document in the background. Refused
 * before the mirror has loaded: an unloaded store has no authoritative copy in
 * memory, so writing would discard whatever the platform holds. Throws so a caller
 * can log the refusal; the upload itself is coalesced and retried off the game loop.
 */
function write(key, value) {
  if (!isHosted()) return;
  ensureLoaded(key);
  stores = { ...stores, [key]: value };
  scheduleFlush();
}

/**
 * Set a store's value and upload the whole document synchronously, before this
 * returns. Used where the upload is the commit point of a change that must not be
 * reported as done until the platform holds it (e.g. a party-room balloon handed
 * over only after the chest was recorded). Blocks on a worker-thread round trip,
 * so it is reserved for player-initiated actions, never the game tick. Throws (and
 * changes nothing) if the platform cannot be reached, so the caller can refuse the
 * change rather than lose the record. On 409 the platform copy is reloaded and this
 * process's keys re-applied once; each attempt carries its own idempotency key.
 */
function writeNow(key, value) {
  if (!isHosted()) return;
  ensureLoaded(key);
  // Merge over the committed stores only on success, so a refused write leaves the
  // mirror exactly as the platform holds it (the commit-point contract the caller
  // relies on: a failed write must not look like a stored one).
  let merged = { ...stores, [key]: value };
  let lastStatus = 0;
  let lastMessage = "";
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    const target = endpoint();
    const response = requestSync({
      url: target.origin + "/api/server/world-state",
      method: "PUT",
      headers: { authorization: "Bearer " + target.token, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        expectedRevision: revision,
        state: { __paescapeWorldData: SCHEMA_VERSION, stores: merged },
        idempotencyKey: nextIdempotencyKey(),
        kind: "world-data",
      }),
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.ok) {
      stores = merged;
      revision = Number(response.json && response.json.revision) || revision + 1;
      writesCompleted++;
      return;
    }
    lastStatus = response.status;
    lastMessage = (response.json && response.json.error) || response.text || ("status " + response.status);
    if (response.status === 409) {
      // Another writer advanced the document: reload, re-apply this change on top
      // of theirs so neither is lost, then retry once.
      loaded = false;
      if (load()) {
        merged = { ...stores, [key]: value };
        if (attempt >= 2) break;
        continue;
      }
      break;
    }
    if (!isRetryableStatus(response.status) || attempt === MAX_WRITE_ATTEMPTS) break;
    sleepSync(backoff(attempt));
  }
  throw new WorldDataFailure("Could not save world data to the platform (status " + lastStatus + "): " + lastMessage, lastStatus);
}

/**
 * Upload the mirror to the platform. Uses optimistic concurrency: a stale base
 * revision is refused (409), and the write reloads the platform copy and re-applies
 * this process's keys once before giving up, so a concurrent writer's other keys
 * are not lost. Each attempt carries its own idempotency key, so a lost response
 * cannot be applied twice.
 */
async function upload() {
  let lastStatus = 0;
  let lastMessage = "";
  for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
    let target;
    try {
      target = endpoint();
    } catch (error) {
      failures.push(error);
      return;
    }
    const body = JSON.stringify({
      expectedRevision: revision,
      state: { __paescapeWorldData: SCHEMA_VERSION, stores },
      idempotencyKey: nextIdempotencyKey(),
      kind: "world-data",
    });
    const response = await requestAsync({
      url: target.origin + "/api/server/world-state",
      method: "PUT",
      headers: { authorization: "Bearer " + target.token, "content-type": "application/json", accept: "application/json" },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.ok) {
      revision = Number(response.json && response.json.revision) || revision + 1;
      writesCompleted++;
      return;
    }
    lastStatus = response.status;
    lastMessage = (response.json && response.json.error) || response.text || ("status " + response.status);
    if (response.status === 409) {
      // Another writer advanced the document. Reload, keep this process's keys on
      // top of theirs (the mirror holds our latest values), and retry once only.
      const previous = stores;
      try {
        loaded = false;
        if (load()) stores = { ...stores, ...previous };
        else stores = previous;
      } catch (_error) {
        stores = previous;
      }
      if (attempt >= 2) break;
      continue;
    }
    if (!isRetryableStatus(response.status) || attempt === MAX_WRITE_ATTEMPTS) break;
    await sleep(backoff(attempt));
  }
  failures.push(new WorldDataFailure("Could not save world data to the platform (status " + lastStatus + "): " + lastMessage, lastStatus));
}

/** Wait for the queued upload; throw the first failure so a caller never reports a false success. */
async function flush() {
  if (pendingUpload) await pendingUpload;
  if (failures.length > 0) {
    const first = failures[0];
    failures.length = 0;
    throw first;
  }
}

/** Diagnostics for the plugin log and tests. */
function describe() {
  return { hosted: isHosted(), loaded, revision, stores: Object.keys(stores).length, writesCompleted, failures: failures.length };
}

/** Tests: forget the mirror and the host detection so each case starts clean. */
function resetForTests({ hosted } = {}) {
  stores = {};
  loaded = false;
  revision = 0;
  loadError = null;
  failures.length = 0;
  writesCompleted = 0;
  pendingUpload = null;
  if (hosted !== undefined) hostedCache = hosted;
}

module.exports = {
  isHosted,
  read,
  write,
  writeNow,
  load,
  prefetch,
  flush,
  describe,
  WorldDataFailure,
  resetForTests,
};
