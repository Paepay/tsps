/**
 * Player-to-player Grand Exchange matching: a world order book that fills offers against
 * opposite player offers instead of the simulated OSRS market.
 *
 * Trade price is the resting offer's price (incoming buy lifts the lowest ask; incoming sell
 * hits the highest bid). Partial fills stay on the offer until it completes or is aborted.
 * Offline counterparties are updated in the book and applied on their next login.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** When true (default), offers fill from OSRS market data. When false, only player offers match. */
const SIMULATED_DATA_CONFIG = "GrandExchange:simulatedData";
/** Legacy enum retained so older world.local.json values still resolve. */
const MATCHING_CONFIG = "GrandExchange:matching";
const MATCHING_SIMULATED = "simulated";
const MATCHING_PLAYER = "player";

let host = null;
let fileSource = null;
let file = null;
let state = null; // { status: "ok"|"corrupt", offers: [], settled: [] }

function configure(options) {
  host = options;
  fileSource = options.file;
  file = null;
  state = null;
}

function filePath() {
  if (!file) file = typeof fileSource === "function" ? fileSource() : fileSource;
  return file;
}

/**
 * Simulated market data is on by default. An explicit boolean wins; otherwise the legacy
 * GrandExchange:matching enum (`player` / `simulated`) is honoured.
 */
function simulatedDataEnabled() {
  const api = host?.api;
  if (!api?.getPluginConfig) return true;
  const simulated = api.getPluginConfig(SIMULATED_DATA_CONFIG, undefined);
  if (typeof simulated === "boolean") return simulated;
  const legacy = api.getPluginConfig(MATCHING_CONFIG, undefined);
  if (legacy === MATCHING_PLAYER) return false;
  if (legacy === MATCHING_SIMULATED) return true;
  return true;
}

function matchingMode() {
  return simulatedDataEnabled() ? MATCHING_SIMULATED : MATCHING_PLAYER;
}

function isPlayerMatching() {
  return matchingMode() === MATCHING_PLAYER;
}

function accountOf(player) {
  return String(player.getUsername?.() ?? "").toLowerCase();
}

function validOffer(entry) {
  return entry
    && typeof entry.id === "string"
    && typeof entry.account === "string"
    && Number.isInteger(entry.slot) && entry.slot >= 0 && entry.slot < 8
    && Number.isInteger(entry.itemId) && entry.itemId > 0
    && typeof entry.sell === "boolean"
    && Number.isInteger(entry.price) && entry.price > 0
    && Number.isInteger(entry.quantity) && entry.quantity > 0
    && Number.isInteger(entry.remaining) && entry.remaining >= 0 && entry.remaining <= entry.quantity
    && Number.isInteger(entry.filled) && entry.filled >= 0
    && Number.isSafeInteger(entry.traded) && entry.traded >= 0
    && Number.isSafeInteger(entry.total) && entry.total >= 0
    && Number.isFinite(entry.placedAt);
}

function readFile(keepCopy) {
  let text;
  try {
    text = fs.readFileSync(filePath(), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { status: "ok", offers: [], settled: [] };
    return { status: "corrupt", error, offers: [], settled: [] };
  }
  try {
    const saved = JSON.parse(text);
    if (!Array.isArray(saved?.offers)) throw new Error("offers is not a list");
    const settled = Array.isArray(saved.settled) ? saved.settled.filter(validOffer).map((entry) => ({ ...entry })) : [];
    return { status: "ok", offers: saved.offers.filter(validOffer).map((entry) => ({ ...entry })), settled };
  } catch (error) {
    if (keepCopy) {
      try {
        fs.copyFileSync(filePath(), `${filePath()}.corrupt-${Date.now()}`);
      } catch {
        // Keep the original either way.
      }
    }
    return { status: "corrupt", error, offers: [], settled: [] };
  }
}

function current() {
  if (!state || state.status !== "ok") state = readFile(!state);
  return state;
}

function available() {
  return current().status === "ok";
}

function writeState(offers, settled = current().settled ?? []) {
  const next = {
    status: "ok",
    offers: offers.map((entry) => ({ ...entry })),
    settled: settled.map((entry) => ({ ...entry })),
  };
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify({ offers: next.offers, settled: next.settled }, null, 2)}\n`, "utf8");
  fs.renameSync(temp, target);
  state = next;
}

function bookOffers() {
  return available() ? current().offers : [];
}

function settledOffers() {
  return available() ? current().settled : [];
}

function findBookOffer(account, slot) {
  return bookOffers().find((entry) => entry.account === account && entry.slot === slot) ?? null;
}

function upsertBookOffer(entry) {
  const offers = bookOffers().filter((other) => !(other.account === entry.account && other.slot === entry.slot));
  const settled = settledOffers().filter((other) => !(other.account === entry.account && other.slot === entry.slot));
  if (entry.remaining > 0) offers.push({ ...entry });
  writeState(offers, settled);
}

/** Open row is gone; keep a settled row so an offline owner receives the fill on login. */
function settleBookOffer(entry) {
  const offers = bookOffers().filter((other) => !(other.account === entry.account && other.slot === entry.slot));
  const settled = settledOffers().filter((other) => !(other.account === entry.account && other.slot === entry.slot));
  settled.push({ ...entry, remaining: 0 });
  writeState(offers, settled);
}

function removeBookOffer(account, slot) {
  writeState(
    bookOffers().filter((entry) => !(entry.account === account && entry.slot === slot)),
    settledOffers().filter((entry) => !(entry.account === account && entry.slot === slot)),
  );
}

function itemKey(itemId) {
  return host.unNote(itemId);
}

/** Opposite resting offers that cross the aggressor's price, best price first then oldest. */
function candidates(aggressor) {
  const item = itemKey(aggressor.itemId);
  const open = bookOffers().filter((entry) =>
    entry.remaining > 0
    && entry.sell !== aggressor.sell
    && itemKey(entry.itemId) === item
    && !(entry.account === aggressor.account && entry.slot === aggressor.slot));
  if (aggressor.sell) {
    return open
      .filter((entry) => entry.price >= aggressor.price)
      .sort((a, b) => b.price - a.price || a.placedAt - b.placedAt || a.id.localeCompare(b.id));
  }
  return open
    .filter((entry) => entry.price <= aggressor.price)
    .sort((a, b) => a.price - b.price || a.placedAt - b.placedAt || a.id.localeCompare(b.id));
}

function onlinePlayer(account) {
  const byName = host.api.core.World.getPlayerByName?.(account);
  if (byName) return byName;
  for (const player of host.api.core.World.getPlayers?.() ?? []) {
    if (player && accountOf(player) === account) return player;
  }
  return null;
}

function announceFill(player, offer, filledNow) {
  if (!player || !offer || filledNow <= 0) return;
  const name = host.itemName(offer.itemId);
  const verb = offer.sell ? "Sold" : "Bought";
  if (offer.finished) {
    player.getPacketSender().sendMessage(
      `${verb} ${offer.quantity.toLocaleString("en-US")} x ${name}. Click Collect.`);
  } else {
    player.getPacketSender().sendMessage(
      `${verb} ${filledNow.toLocaleString("en-US")} x ${name}. Your offer is still open.`);
  }
  host.refreshOffer(player, offer);
}

/**
 * Fill `amount` on the book row at account/slot. Re-reads the row so callers never keep a
 * stale reference across writes. Returns how many were filled.
 */
function fillEntry(account, slot, amount, unitPrice, { notify }) {
  const entry = findBookOffer(account, slot);
  if (!entry || amount <= 0) return 0;
  const filledNow = Math.min(entry.remaining, amount);
  if (filledNow <= 0) return 0;
  const next = {
    ...entry,
    filled: entry.filled + filledNow,
    remaining: entry.remaining - filledNow,
    traded: entry.traded + filledNow * unitPrice,
  };
  const player = onlinePlayer(account);
  if (next.remaining > 0) upsertBookOffer(next);
  else if (player) removeBookOffer(account, slot);
  else settleBookOffer(next);

  if (player) {
    const offer = host.completedOffers(player)[slot];
    if (offer) {
      offer.filled = next.filled;
      offer.remaining = next.remaining;
      offer.traded = next.traded;
      offer.matching = MATCHING_PLAYER;
      offer.completesAt = null;
      if (next.remaining <= 0) {
        offer.finished = true;
        offer.completedAt = Date.now();
        offer.completesAt = offer.completedAt;
        host.recordHistory(player, offer);
      }
      host.saveOffers(player);
      if (notify) announceFill(player, offer, filledNow);
      else host.refreshOffer(player, offer);
    }
  }
  return filledNow;
}

function pricesCross(aggressor, resting) {
  return aggressor.sell ? resting.price >= aggressor.price : resting.price <= aggressor.price;
}

/** Match the open book row until no opposite offer crosses, or it is filled. */
function matchOffer(account, slot) {
  for (;;) {
    const aggressor = findBookOffer(account, slot);
    if (!aggressor || aggressor.remaining <= 0) return aggressor;
    let matched = false;
    for (const candidate of candidates(aggressor)) {
      const resting = findBookOffer(candidate.account, candidate.slot);
      if (!resting || resting.remaining <= 0 || !pricesCross(aggressor, resting)) continue;
      const amount = Math.min(aggressor.remaining, resting.remaining);
      const unitPrice = resting.price;
      fillEntry(resting.account, resting.slot, amount, unitPrice, { notify: true });
      fillEntry(account, slot, amount, unitPrice, { notify: false });
      matched = true;
      break;
    }
    if (!matched) return findBookOffer(account, slot);
  }
}

/** Place a newly escrowed offer into the book and try to match it. */
function place(player, offer) {
  if (!available()) {
    player.sendMessage("The Grand Exchange is temporarily unavailable.");
    return false;
  }
  const account = accountOf(player);
  const entry = {
    id: crypto.randomUUID(),
    account,
    slot: offer.slot,
    itemId: host.unNote(offer.itemId),
    sell: Boolean(offer.sell),
    price: offer.price,
    quantity: offer.quantity,
    remaining: offer.quantity,
    filled: 0,
    traded: 0,
    total: offer.total,
    placedAt: offer.placedAt,
  };
  Object.assign(offer, {
    bookId: entry.id,
    filled: 0,
    remaining: offer.quantity,
    traded: 0,
    finishesAt: null,
    completesAt: null,
    matching: MATCHING_PLAYER,
    finished: false,
  });
  upsertBookOffer(entry);
  host.completedOffers(player)[offer.slot] = offer;
  matchOffer(account, offer.slot);

  const live = findBookOffer(account, offer.slot);
  const currentOffer = host.completedOffers(player)[offer.slot];
  if (live) {
    Object.assign(currentOffer, {
      filled: live.filled,
      remaining: live.remaining,
      traded: live.traded,
      finished: false,
      completesAt: null,
    });
  } else if (currentOffer && !currentOffer.finished) {
    // Filled entirely during matchOffer; fillEntry already marked finished when online.
    Object.assign(currentOffer, {
      filled: currentOffer.quantity,
      remaining: 0,
      finished: true,
      completedAt: currentOffer.completedAt || Date.now(),
      completesAt: currentOffer.completedAt || Date.now(),
    });
    host.recordHistory(player, currentOffer);
  }
  host.saveOffers(player);
  host.refreshOffer(player, currentOffer);
  if (currentOffer.finished) {
    announceFill(player, currentOffer, currentOffer.filled);
  } else if (currentOffer.filled > 0) {
    announceFill(player, currentOffer, currentOffer.filled);
  } else {
    player.getPacketSender().sendMessage("Offer placed. It will fill when another player meets your price.");
  }
  return true;
}

/** Pull the latest book progress onto the offer and remove it from the book (abort). */
function abort(player, offer) {
  if (!offer) return;
  const account = accountOf(player);
  const book = findBookOffer(account, offer.slot);
  if (book) {
    offer.filled = book.filled;
    offer.remaining = book.remaining;
    offer.traded = book.traded;
    removeBookOffer(account, offer.slot);
  } else {
    removeBookOffer(account, offer.slot);
  }
}

/** On login: push book fills / settled finishes onto the player's open slots. */
function syncPlayer(player) {
  if (!isPlayerMatching() || !available()) return false;
  const slots = host.completedOffers(player);
  const account = accountOf(player);
  let changed = false;

  for (const settled of settledOffers().filter((entry) => entry.account === account)) {
    const offer = slots[settled.slot];
    if (!offer || offer.finished) {
      removeBookOffer(account, settled.slot);
      continue;
    }
    offer.filled = settled.filled;
    offer.traded = settled.traded;
    offer.remaining = 0;
    offer.matching = MATCHING_PLAYER;
    offer.finished = true;
    offer.completedAt = Date.now();
    offer.completesAt = offer.completedAt;
    offer.bookId = settled.id;
    host.recordHistory(player, offer);
    announceFill(player, offer, settled.filled);
    removeBookOffer(account, settled.slot);
    changed = true;
  }

  for (let slot = 0; slot < 8; slot++) {
    const offer = slots[slot];
    if (!offer || offer.finished) continue;
    // Simulated offers keep their timer; only player-matched (or legacy open-with-null delay) sync.
    if (offer.matching !== MATCHING_PLAYER && offer.completesAt != null) continue;
    const book = findBookOffer(account, slot);
    if (book) {
      if (book.filled !== (offer.filled ?? 0) || book.traded !== (offer.traded ?? 0)
          || book.remaining !== (offer.remaining ?? offer.quantity)) {
        offer.filled = book.filled;
        offer.traded = book.traded;
        offer.remaining = book.remaining;
        offer.matching = MATCHING_PLAYER;
        offer.completesAt = null;
        offer.bookId = book.id;
        changed = true;
      }
      continue;
    }
    if (offer.matching === MATCHING_PLAYER) {
      const filled = Number(offer.filled) || 0;
      const remaining = Math.max(0, offer.quantity - filled);
      if (remaining > 0) {
        upsertBookOffer({
          id: offer.bookId || crypto.randomUUID(),
          account,
          slot,
          itemId: host.unNote(offer.itemId),
          sell: Boolean(offer.sell),
          price: offer.price,
          quantity: offer.quantity,
          remaining,
          filled,
          traded: Number(offer.traded) || 0,
          total: offer.total,
          placedAt: offer.placedAt || Date.now(),
        });
      }
    }
  }
  if (changed) host.saveOffers(player);
  return changed;
}

function setBookOffersForTest(offers, settled = []) {
  state = {
    status: "ok",
    offers: (offers ?? []).map((entry) => ({ ...entry })),
    settled: (settled ?? []).map((entry) => ({ ...entry })),
  };
  fileSource = bookFileForTest;
  file = null;
}

function bookFileForTest() {
  return path.join(require("os").tmpdir(), `ge-book-test-${process.pid}.json`);
}

module.exports = {
  SIMULATED_DATA_CONFIG,
  MATCHING_CONFIG,
  MATCHING_SIMULATED,
  MATCHING_PLAYER,
  configure,
  simulatedDataEnabled,
  matchingMode,
  isPlayerMatching,
  available,
  place,
  abort,
  syncPlayer,
  matchOffer,
  candidates,
  findBookOffer,
  bookOffers,
  settledOffers,
  setBookOffersForTest,
  _test: {
    fillEntry,
    upsertBookOffer,
    settleBookOffer,
    removeBookOffer,
    writeState,
    accountOf,
  },
};
