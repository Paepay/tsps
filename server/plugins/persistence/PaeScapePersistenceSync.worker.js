"use strict";

/**
 * Synchronous platform transport worker.
 *
 * The persistence base class is synchronous: load()/exists() must return a
 * PlayerSave (or a boolean) before the caller continues, and the login path
 * calls them between two await points in the same tick. A platform call is
 * asynchronous, so this worker performs the fetch on its own thread and hands
 * the answer back through a SharedArrayBuffer the main thread waits on with
 * Atomics.wait. That makes a real HTTP round trip to the platform usable from a
 * synchronous method without stubbing the platform out.
 *
 * One worker is kept alive for the process; each request carries its own buffer
 * and mailbox so two requests can never see each other's answer. The worker only
 * writes to memory the main thread is parked on, so it never touches game state.
 */

const { parentPort } = require("node:worker_threads");

/** Bytes reserved for the fixed header before the response body. */
const HEADER_BYTES = 16;

parentPort.on("message", async (message) => {
  const { sab, url, method, headers, body, timeoutMs } = message;
  const meta = new Int32Array(sab, 0, 4);
  const data = new Uint8Array(sab, HEADER_BYTES);

  const finish = (status, text) => {
    const bytes = Buffer.from(text ?? "", "utf8");
    const length = Math.min(bytes.length, data.length);
    data.set(bytes.subarray(0, length));
    // status, then the byte length, then a truncation flag, then the state word
    // last so the waiter is unblocked only once the payload is fully written.
    Atomics.store(meta, 1, status);
    Atomics.store(meta, 2, length);
    Atomics.store(meta, 3, bytes.length > data.length ? 1 : 0);
    Atomics.store(meta, 0, 1);
    Atomics.notify(meta, 0);
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    const text = await response.text();
    finish(response.status, text);
  } catch (error) {
    // status 0 marks a transport failure (timeout, refused, DNS); the caller
    // decides whether it is retryable.
    finish(0, String((error && error.message) || error));
  } finally {
    clearTimeout(timer);
  }
});
