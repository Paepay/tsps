"use strict";

/**
 * Platform transport for the PaeScape persistence adapter.
 *
 * The persistence base class is synchronous (load/save/exists return a value in
 * the same tick), but the platform is reached over HTTP, which is asynchronous.
 * Two transports bridge that without stubbing the platform:
 *
 *   - requestSync performs the request on a worker thread and blocks the calling
 *     thread with Atomics.wait, so a real round trip is usable from a synchronous
 *     method. It is used only for login-time reads (load/exists/delete), never on
 *     the game tick.
 *   - requestAsync performs the request with the main thread's fetch and returns a
 *     promise; it is used for background saves so the game loop is never blocked.
 *
 * Nothing is stubbed: the request goes to the configured platform over the
 * network, and an unreachable platform surfaces as a transport failure code, not
 * a silent success.
 */

const path = require("path");
const { Worker } = require("worker_threads");

/** Bytes reserved for the response header (state, status, length, truncated). */
const HEADER_BYTES = 16;
/** Bytes reserved for the response body. Platform state documents are capped at 2 MB. */
const BODY_BYTES = 3 * 1024 * 1024;

let worker = null;

function ensureWorker() {
  if (worker) return worker;
  worker = new Worker(path.join(__dirname, "PaeScapePersistenceSync.worker.js"));
  // A crashed worker must not be reused with a broken request queue.
  worker.on("error", () => {
    worker = null;
  });
  worker.on("exit", () => {
    worker = null;
  });
  worker.unref?.();
  return worker;
}

function parseJson(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/**
 * Perform one request on the worker thread and return its response, blocking the
 * calling thread until it arrives. On a transport failure returns status 0 with
 * the error text; it never throws for a reachable-but-failed request, so the
 * caller can decide whether it is retryable.
 */
function requestSync({ url, method = "GET", headers, body, timeoutMs = 8000 }) {
  const active = ensureWorker();
  const sab = new SharedArrayBuffer(HEADER_BYTES + BODY_BYTES);
  const meta = new Int32Array(sab, 0, 4);
  // Reset the state word so a reused buffer never looks already-answered.
  Atomics.store(meta, 0, 0);

  active.postMessage({ sab, url, method, headers, body, timeoutMs });

  const waited = Atomics.wait(meta, 0, 0, timeoutMs + 2000);
  if (Atomics.load(meta, 0) !== 1) {
    return { ok: false, status: 0, text: "platform request timed out after " + timeoutMs + "ms", json: null, waited };
  }

  const status = Atomics.load(meta, 1);
  const length = Atomics.load(meta, 2);
  const text = Buffer.from(new Uint8Array(sab, HEADER_BYTES, length)).toString("utf8");
  return { ok: status >= 200 && status < 300, status: status || 0, text, json: parseJson(text), waited };
}

/**
 * Perform one request on the main thread and return a promise of its response.
 * Used for background saves: the game loop is never blocked waiting on it.
 */
async function requestAsync({ url, method = "GET", headers, body, timeoutMs = 8000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    return { ok: response.ok, status: response.status, text, json: parseJson(text) };
  } catch (error) {
    const aborted = error && error.name === "AbortError";
    return { ok: false, status: 0, text: aborted ? "platform request timed out" : String((error && error.message) || error), json: null };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { requestSync, requestAsync, HEADER_BYTES, BODY_BYTES };