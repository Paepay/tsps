"use strict";

/**
 * Central player persistence: the PaeScape Realms platform owns the authoritative
 * character state.
 *
 * In hosted mode (a distributed server.exe with a platform URL and no world
 * secret) this backend replaces the local JSON/SQLite stores. A character is
 * loaded from the platform's SQL-backed state API and saved back to it; nothing
 * is written to the host's disk. When the platform cannot be reached, or the
 * world holds no valid lease, loading fails closed and the login is refused -
 * there is deliberately no fallback to a local save.
 *
 * The persistence base class is synchronous (load/save/exists return in the same
 * tick). Two transports bridge that to the network without stubbing the platform:
 *
 *   - load/exists/delete use the synchronous transport, which runs a real HTTP
 *     request on a worker thread and blocks the caller with Atomics.wait. These
 *     run only during login (once per character), never on the game tick.
 *   - save/saveOffline use the asynchronous transport and a background queue, so
 *     a save never blocks the game loop. flush() awaits the queue and rethrows any
 *     failure, so a caller that reports success (logout, shutdown) knows the data
 *     reached the platform.
 *
 * Serialization is deliberately the existing one: JsonPlayerPersistence's
 * replacer/reviver/hydratePlayerSave are reused so a platform-stored document is
 * the same shape as a local save, and no field is dropped.
 */

const { PlayerPersistence } = require("../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerPersistence");
const { MAIN_PROFILE } = PlayerPersistence;
const { PlayerSave } = require("../../src/main/typescript/elvarg/game/entity/impl/player/persistence/PlayerSave");
const jsonPersistence = require("./JsonPlayerPersistence.plugin.js");
const { JsonPlayerPersistence } = jsonPersistence;
const { requestSync, requestAsync } = require("./PaeScapePersistenceTransport");
const { getPlatformAccess } = require("../paescape/PaeScapeBridge");
const { isHostedPersistence } = require("./PaeScapePersistenceMode");

/** Per-request timeout to the platform. */
const REQUEST_TIMEOUT_MS = Number(process.env.PAESCAPE_PERSISTENCE_TIMEOUT_MS) > 0
  ? Math.floor(Number(process.env.PAESCAPE_PERSISTENCE_TIMEOUT_MS))
  : 8000;
/** Bounded retries for a recoverable save failure. */
const MAX_SAVE_ATTEMPTS = Number(process.env.PAESCAPE_PERSISTENCE_ATTEMPTS) > 0
  ? Math.floor(Number(process.env.PAESCAPE_PERSISTENCE_ATTEMPTS))
  : 5;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15000;
/** How long a "not registered on this world" answer is trusted before asking again. */
const NOT_REGISTERED_CACHE_MS = 30_000;

/**
 * Schema version of the document this adapter writes. The document is the normal
 * TSPS PlayerSave shape (see PlayerSave.fromPlayer); the version lets a future
 * server migrate a stored save without guessing, and is stored *beside* the save
 * so a reader that does not know the field simply ignores it. A document with no
 * version is a legacy save written before versioning and is read as current.
 */
const SAVE_SCHEMA_VERSION = 1;

/** A failure that means the data did not reach the platform. */
class PersistenceFailure extends Error {
  constructor(message, status) {
    super(message);
    this.name = "PersistenceFailure";
    this.status = status ?? 0;
  }
}

function isRetryableStatus(status) {
  // status 0 is a transport failure (timeout, refused, DNS). 429 and 5xx are
  // transient on the platform side. Everything else is a decision, not a blip.
  return status === 0 || status === 429 || (status >= 500 && status <= 599);
}

function backoff(attempt) {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * Math.pow(2, attempt - 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class PaeScapePlayerPersistence extends PlayerPersistence {
  constructor(skillManager) {
    super();
    // Reuse the local backend's serialization so platform documents match saves
    // exactly. That class reads a module-level SkillManager normally set by its own
    // register(), so inject it here when this adapter is built directly.
    if (skillManager && typeof jsonPersistence.setSkillManager === "function") {
      jsonPersistence.setSkillManager(skillManager);
    }
    this.serializer = new JsonPlayerPersistence();
    /** storageKey -> { characterId, revision, save, stale } */
    this.cache = new Map();
    /** storageKey -> platform character id (null = not registered), resolved once per process. */
    this.characterIds = new Map();
    /** The ordered background write chain; every save appends to it. */
    this.writeChain = Promise.resolve();
    /** Failures since the last flush, so flush() can rethrow them. */
    this.failures = [];
    this.writesQueued = 0;
    this.writesCompleted = 0;
  }

  /* --------------------------------------------------------- platform --- */

  access() {
    const access = getPlatformAccess();
    if (!access || typeof access.platformOrigin !== "function") {
      throw new PersistenceFailure("The PaeScape platform bridge is unavailable; refusing to fall back to local saves.");
    }
    return access;
  }

  /** The absolute URL for a platform path, plus a live lease bearer token. */
  endpoint(path) {
    const access = this.access();
    const origin = String(access.platformOrigin() ?? "").replace(/\/+$/, "");
    if (!origin) throw new PersistenceFailure("No PaeScape platform URL is configured.");
    const token = typeof access.leaseToken === "function" ? access.leaseToken() : null;
    if (!token) {
      throw new PersistenceFailure("This world holds no valid platform authorization lease; character data cannot be loaded or saved.");
    }
    return { url: origin + path, token };
  }

  storageKey(username, profile) {
    return PlayerPersistence.profileStorageKey(this.normalize(username), profile ?? MAIN_PROFILE);
  }

  normalize(username) {
    return String(username ?? "").trim().toLowerCase();
  }

  /* ------------------------------------------------------- identity --- */

  /** Forget a cached character id so the next lookup asks the platform again. */
  invalidateCharacterId(username) {
    this.characterIds.delete(this.storageKey(username, MAIN_PROFILE));
  }

  /**
   * The platform's id for a character on this world, or null when it is not registered.
   *
   * A null result is cached only briefly: the website may create the character after a
   * fresh login looked it up (the login ticket is issued once ownership exists), and a
   * process-wide "not registered" cache would then refuse every save for that character.
   * `force` skips the cache entirely.
   */
  resolveCharacterId(username, { force = false } = {}) {
    const key = this.storageKey(username, MAIN_PROFILE);
    const cached = this.characterIds.get(key);
    if (!force && cached && cached.id !== null && cached.expiresAt > Date.now()) return cached.id;
    const { url, token } = this.endpoint("/api/server/characters/by-name/" + encodeURIComponent(username));
    const response = requestSync({
      url,
      method: "GET",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) {
      this.characterIds.set(key, { id: null, expiresAt: Date.now() + NOT_REGISTERED_CACHE_MS });
      return null;
    }
    if (!response.ok) {
      throw new PersistenceFailure("The platform could not resolve character " + username + " (status " + response.status + ")", response.status);
    }
    const id = response.json && response.json.character && response.json.character.id ? String(response.json.character.id) : null;
    this.characterIds.set(key, { id, expiresAt: Number.POSITIVE_INFINITY });
    return id;
  }

  /* ------------------------------------------------------------ load --- */

  load(username, profile = MAIN_PROFILE) {
    const storageKey = this.storageKey(username, profile);
    const cached = this.cache.get(storageKey);
    // A save written by this session is not a load: keep `loaded` false so the
    // next load fetches the authoritative document instead of trusting a null
    // placeholder created when a character had no prior state.
    // A null character id is only a snapshot of registration at the time of the
    // lookup. Character creation may commit on the platform immediately after
    // that lookup, so it must not turn into a session-long negative cache.
    if (cached && cached.loaded && !cached.stale && cached.characterId !== null) return cached.save;

    const characterId = this.resolveCharacterId(username);
    if (!characterId) {
      // Not registered on this world yet: no authoritative state exists.
      this.cache.set(storageKey, { characterId: null, revision: 0, save: null, loaded: true, stale: false });
      return null;
    }

    const { url, token } = this.endpoint("/api/server/characters/" + encodeURIComponent(characterId) + "/state?profile=" + encodeURIComponent(profile));
    const response = requestSync({
      url,
      method: "GET",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      throw new PersistenceFailure("The platform could not load " + username + " (status " + response.status + ").", response.status);
    }
    const document = response.json && response.json.state;
    if (!document) {
      throw new PersistenceFailure("The platform returned no state document for " + username + ".", response.status);
    }
    const revision = Number(document.revision ?? 0) || 0;
    if (document.state == null) {
      this.cache.set(storageKey, { characterId, revision, save: null, loaded: true, stale: false });
      return null;
    }
    const parsed = JSON.parse(JSON.stringify(document.state), this.serializer.reviver.bind(this.serializer));
    // The current format wraps the save so it can be versioned; a document with no
    // wrapper is a legacy save and is read as-is. A document from a *newer* schema
    // is refused rather than silently mis-read, so an old server never mangles a
    // save written by a newer one.
    const versioned = parsed && typeof parsed === "object" && parsed.__paescapeSchema !== undefined && parsed.save !== undefined;
    const schemaVersion = versioned ? Number(parsed.__paescapeSchema) || 0 : 0;
    if (schemaVersion > SAVE_SCHEMA_VERSION) {
      throw new PersistenceFailure(
        "Refusing to load " + username + ": the platform save uses schema " + schemaVersion + " but this server understands up to " + SAVE_SCHEMA_VERSION + ".",
      );
    }
    const save = this.serializer.hydratePlayerSave(versioned ? parsed.save : parsed);
    this.cache.set(storageKey, { characterId, revision, save, loaded: true, stale: false });
    return save;
  }

  exists(username, profile = MAIN_PROFILE) {
    // Ownership on the platform is what reserves a name on this world.
    return this.resolveCharacterId(username, { force: true }) !== null;
  }

  /**
   * A cheap pre-login guard for hosted mode. The base login path asks for the save
   * before the PaeScape plugin's ticket extension runs; refusing here means a world
   * whose lease has expired cannot load a character or accept a new login. A login
   * that arrives while the lease is being renewed waits briefly for it, then fails.
   */
  authorizeLogin(timeoutMs = REQUEST_TIMEOUT_MS) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs) || 0);
    for (;;) {
      const access = getPlatformAccess();
      const token = access && typeof access.leaseToken === "function" ? access.leaseToken() : null;
      if (token) return token;
      if (Date.now() >= deadline) {
        throw new PersistenceFailure("This world holds no valid platform authorization lease; login is refused.");
      }
      const remaining = deadline - Date.now();
      try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(250, remaining));
      } catch (_error) {
        const until = Date.now() + Math.min(250, remaining);
        while (Date.now() < until) { /* bounded wait without SharedArrayBuffer */ }
      }
    }
  }

  /* ------------------------------------------------------------ save --- */

  save(player) {
    if (!player || !player.getUsername || !player.getUsername()) return;
    this.saveOffline(player.getUsername(), PlayerSave.fromPlayer(player), "save", player.getProfile?.() ?? MAIN_PROFILE);
  }

  saveOffline(username, save, reason = "save", profile = MAIN_PROFILE) {
    const storageKey = this.storageKey(username, profile);
    const serialized = JSON.stringify(save, this.serializer.replacer.bind(this.serializer));
    this.serializer.validateSerializedSave(serialized, username);
    // Store a versioned envelope around the unchanged PlayerSave document so a
    // future schema change can migrate a stored save instead of guessing at it.
    const envelope = JSON.stringify({
      __paescapeSchema: SAVE_SCHEMA_VERSION,
      save: JSON.parse(serialized),
    });
    this.enqueue(storageKey, username, profile, serialized, envelope, reason);
  }

  /**
   * Append a save to the background chain. The write resolves the character's
   * current revision when it runs (not when it is queued), so a burst of saves
   * writes sequentially rather than all racing the same base revision.
   */
  enqueue(storageKey, username, profile, serialized, envelope, reason) {
    this.writesQueued++;
    this.writeChain = this.writeChain
      .catch(() => undefined)
      .then(() => this.write(storageKey, username, profile, serialized, envelope, reason))
      .then(() => {
        this.writesCompleted++;
      })
      .catch((error) => {
        this.writesCompleted++;
        this.failures.push(error instanceof Error ? error : new Error(String(error)));
        console.error("[persistence] platform save failed for " + username + " (" + profile + ")", error);
      });
  }

  async write(storageKey, username, profile, serialized, envelope, reason) {
    const entry = this.cache.get(storageKey);
    if (entry && entry.stale) {
      throw new PersistenceFailure("Refusing to save " + username + ": the platform state changed under this session. Log the character out.");
    }
    const cachedIdentity = this.characterIds.get(storageKey);
    let characterId = entry ? entry.characterId : cachedIdentity ? cachedIdentity.id : undefined;
    // A save can be queued immediately after central character registration,
    // before another load has refreshed an earlier negative lookup. Always ask
    // the platform again instead of trusting that stale null identity.
    if (!characterId) characterId = this.resolveCharacterId(username, { force: true });
    if (!characterId) {
      throw new PersistenceFailure("Refusing to save " + username + ": the character is not registered on this world.");
    }
    // Seed the revision from the platform when this character was never loaded.
    let expectedRevision = entry && entry.characterId === characterId ? entry.revision : null;
    if (expectedRevision === null) expectedRevision = this.fetchRevision(characterId, profile);

    // One idempotency key per write: a retry of this write reuses it, so a lost
    // response cannot be applied twice.
    const idempotencyKey = characterId + ":" + profile + ":" + this.nextId();
    const body = JSON.stringify({ profile, expectedRevision, state: JSON.parse(envelope), idempotencyKey, kind: reason });

    const { url, token } = this.endpoint("/api/server/characters/" + encodeURIComponent(characterId) + "/state");
    let lastStatus = 0;
    let lastMessage = "";
    for (let attempt = 1; attempt <= MAX_SAVE_ATTEMPTS; attempt++) {
      const response = await requestAsync({
        url,
        method: "PUT",
        headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json" },
        body,
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      if (response.ok) {
        const revision = Number(response.json && response.json.revision) || expectedRevision + 1;
        const current = this.cache.get(storageKey);
        if (current && current.characterId === characterId) {
          current.revision = revision;
          current.stale = false;
          // The document just written is the new authoritative state. Keep it as the
          // loaded save so a later load in this process does not return an older copy.
          const written = JSON.parse(serialized, this.serializer.reviver.bind(this.serializer));
          current.save = this.serializer.hydratePlayerSave(written);
          current.loaded = true;
        } else {
          this.cache.set(storageKey, { characterId, revision, save: null, loaded: false, stale: false });
        }
        return;
      }
      lastStatus = response.status;
      lastMessage = (response.json && response.json.error) || response.text || ("status " + response.status);
      if (response.status === 409) {
        // Another writer advanced the state. Do not clobber it; mark this session
        // desynced so the character must be reloaded.
        const current = this.cache.get(storageKey);
        if (current) current.stale = true;
        throw new PersistenceFailure("Refusing to save " + username + ": the platform state changed (409).", 409);
      }
      if (!isRetryableStatus(response.status) || attempt === MAX_SAVE_ATTEMPTS) break;
      const wait = backoff(attempt);
      console.warn("[persistence] retrying platform save for " + username + " in " + wait + "ms (status " + response.status + ")");
      await sleep(wait);
    }
    throw new PersistenceFailure("Could not save " + username + " to the platform (status " + lastStatus + "): " + lastMessage, lastStatus);
  }

  /** The stored revision for a character/profile, used to seed an unloaded save. */
  fetchRevision(characterId, profile) {
    const { url, token } = this.endpoint("/api/server/characters/" + encodeURIComponent(characterId) + "/state?profile=" + encodeURIComponent(profile));
    const response = requestSync({
      url,
      method: "GET",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok) {
      throw new PersistenceFailure("Could not read the current revision for a save (status " + response.status + ").", response.status);
    }
    return Number(response.json && response.json.state && response.json.state.revision) || 0;
  }

  /** Wait for every queued save; throw the first failure so a caller never reports a false success. */
  async flush() {
    await super.flush();
    await this.writeChain.catch(() => undefined);
    if (this.failures.length > 0) {
      const first = this.failures[0];
      this.failures.length = 0;
      throw first;
    }
  }

  /* ---------------------------------------------------------- delete --- */

  /* ------------------------------------------------ atomic economy --- */

  /**
   * A serialized snapshot of one online player for an atomic commit. Returns the
   * platform character id, the base revision this process last saw, and the
   * versioned document the platform expects, all captured *before* the world
   * mutates the player so a failed commit can be rolled back.
   */
  captureTransactionParticipant(player, profile = MAIN_PROFILE) {
    const username = player.getUsername();
    if (!username) throw new PersistenceFailure("Cannot transact for a player with no username.");
    const storageKey = this.storageKey(username, profile);
    const characterId = this.resolveCharacterId(username);
    if (!characterId) {
      throw new PersistenceFailure("Cannot transact: " + username + " is not registered on this world.");
    }
    const entry = this.cache.get(storageKey);
    const revision = entry && entry.characterId === characterId ? entry.revision : this.fetchRevision(characterId, profile);
    const serialized = JSON.stringify(PlayerSave.fromPlayer(player), this.serializer.replacer.bind(this.serializer));
    this.serializer.validateSerializedSave(serialized, username);
    return {
      username,
      profile,
      characterId,
      revision,
      serialized,
      state: { __paescapeSchema: SAVE_SCHEMA_VERSION, save: JSON.parse(serialized) },
    };
  }

  /**
   * Atomically commit the resulting state of every participant. The platform
   * writes them in one transaction, so either both trades commit or neither
   * does. Returns the platform result. Throws a PersistenceFailure (carrying a
   * `.status`) when the transaction did not commit, so the caller rolls back.
   */
  commitEconomyTransaction({ kind, idempotencyKey, participants, administrativeActor = null, metadata = null }) {
    const body = JSON.stringify({
      kind,
      idempotencyKey,
      administrativeActor,
      metadata,
      participants: participants.map((p) => ({
        characterId: p.characterId,
        profile: p.profile ?? MAIN_PROFILE,
        expectedRevision: p.revision,
        state: p.state,
      })),
    });
    const { url, token } = this.endpoint("/api/server/economy/transactions");
    const response = requestSync({
      url,
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json", accept: "application/json" },
      body,
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    // An unreachable platform surfaces as status 0. The transaction may still
    // have committed, so reconcile by idempotency key before deciding.
    if (response.status === 0) {
      const found = this.findEconomyTransaction(idempotencyKey);
      if (found) return { ...found, reconciled: true };
      throw new PersistenceFailure("The platform could not confirm the transaction (" + response.text + ").", 0);
    }
    if (!response.ok) {
      const message = (response.json && response.json.error) || response.text || ("status " + response.status);
      throw new PersistenceFailure("The platform refused the transaction: " + message, response.status);
    }
    return response.json;
  }

  /** Reconcile an uncertain commit: the stored result for an idempotency key, or null. */
  findEconomyTransaction(idempotencyKey) {
    const { url, token } = this.endpoint("/api/server/economy/transactions/" + encodeURIComponent(idempotencyKey));
    const response = requestSync({
      url,
      method: "GET",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new PersistenceFailure("Could not reconcile the transaction (status " + response.status + ").", response.status);
    }
    return response.json;
  }

  /**
   * Adopt a committed result: mark each participant's cache at the new revision
   * and treat the document we just wrote as the current authoritative state, so a
   * later autosave cannot race it back to an older revision.
   */
  applyEconomyResult(participants, result) {
    const byCharacter = new Map((result && result.participants ? result.participants : []).map((p) => [p.characterId, p]));
    for (const participant of participants) {
      const committed = byCharacter.get(participant.characterId);
      const storageKey = this.storageKey(participant.username, participant.profile ?? MAIN_PROFILE);
      const current = this.cache.get(storageKey) ?? {};
      current.characterId = participant.characterId;
      current.revision = committed ? Number(committed.toRevision) : Number(current.revision ?? 0) + 1;
      current.stale = false;
      current.loaded = true;
      if (participant.serialized !== undefined) {
        current.save = this.serializer.hydratePlayerSave(JSON.parse(participant.serialized, this.serializer.reviver.bind(this.serializer)));
      }
      this.cache.set(storageKey, current);
    }
  }

  /** The stored platform revision for an online player, seeding it if unloaded. */
  characterRevision(username, profile = MAIN_PROFILE) {
    const storageKey = this.storageKey(username, profile);
    const entry = this.cache.get(storageKey);
    if (entry && entry.characterId && !entry.stale) return entry.revision;
    const characterId = this.resolveCharacterId(username);
    if (!characterId) return null;
    const revision = this.fetchRevision(characterId, profile);
    this.cache.set(storageKey, { characterId, revision, save: entry ? entry.save : null, loaded: Boolean(entry && entry.loaded), stale: false });
    return revision;
  }

  /* ---------------------------------------------------------- delete --- */

  async delete(username, profile = MAIN_PROFILE) {
    const characterId = this.resolveCharacterId(username);
    if (!characterId) return;
    const { url, token } = this.endpoint("/api/server/characters/" + encodeURIComponent(characterId) + "/state?profile=" + encodeURIComponent(profile));
    const response = requestSync({
      url,
      method: "DELETE",
      headers: { authorization: "Bearer " + token, accept: "application/json" },
      timeoutMs: REQUEST_TIMEOUT_MS,
    });
    if (!response.ok && response.status !== 404) {
      throw new PersistenceFailure("The platform could not delete character state (status " + response.status + ").", response.status);
    }
    this.cache.delete(this.storageKey(username, profile));
    this.characterIds.delete(this.storageKey(username, MAIN_PROFILE));
  }

  /* ------------------------------------------------------------ misc --- */

  /**
   * Discard this process's cached copy of a character so the next load reads the
   * authoritative platform document. Used after character creation, where a login
   * may have cached "no save" before the website's creation reached the platform.
   */
  invalidate(username, profile = MAIN_PROFILE) {
    this.cache.delete(this.storageKey(username, profile));
  }

  nextId() {
    try {
      return require("crypto").randomUUID();
    } catch (_error) {
      return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }
  }

  /* ------------------------------------------- core persistence hooks --- */

  supportsAtomicExchange() {
    return true;
  }

  /**
   * Durably commit a single character's change before acknowledging it. The
   * whole resulting document is written through the economy route with the
   * captured base revision, so a bank change cannot be lost to a stale autosave.
   */
  commitCharacterChange(player, before, kind = "bank") {
    if (!this.supportsAtomicExchange()) return "unsupported";
    const participant = this.captureTransactionParticipant(player);
    const result = this.commitEconomyTransaction({
      kind,
      idempotencyKey: participant.characterId + ":" + (player.getProfile?.() ?? MAIN_PROFILE) + ":" + this.nextId(),
      participants: [participant],
    });
    if (result && result.ok) {
      this.applyEconomyResult([participant], result);
      return "committed";
    }
    return "rollback";
  }

  /** A short description for the plugin log and diagnostics. */
  describe() {
    return {
      mode: "paescape-platform",
      writesQueued: this.writesQueued,
      writesCompleted: this.writesCompleted,
      failures: this.failures.length,
      localSaves: false,
    };
  }
}

// Hosted mode is decided in one place (PaeScapePersistenceMode) so the guards on
// the local backends and this adapter can never disagree about which is active.
const hostedConfigured = isHostedPersistence;

let active = null;

module.exports = {
  name: "PaeScapePlayerPersistence",
  // Enabled by default so the packaged world.local.json only has to disable the
  // local backends; register() still refuses to take over outside hosted mode.
  enabled: true,
  register(pluginApi) {
    if (!hostedConfigured()) {
      pluginApi.log("not hosted mode; leaving the local persistence backend in place");
      return;
    }
    active = new PaeScapePlayerPersistence(pluginApi.getSkillManager ? pluginApi.getSkillManager() : undefined);
    pluginApi.setPlayerPersistence(active);
    pluginApi.log("registered for hosted platform persistence", { localSaves: false });

    // Safety net: if a local backend replaced ours (enabled by mistake), the world
    // would silently persist to disk - the exact thing hosted mode must prevent.
    pluginApi.onServerStartup(() => {
      const current = pluginApi.core.GameConstants.PLAYER_PERSISTENCE;
      if (current !== active) {
        console.error("[persistence] FATAL: hosted mode but the active backend is not the PaeScape platform store: " + ((current && current.constructor && current.constructor.name) || "unknown"));
        try {
          pluginApi.core.Server.shutdown("paescape-persistence-misconfigured", 12);
        } catch (_error) {
          process.exit(12);
        }
      }
    });
  },
  PaeScapePlayerPersistence,
};
