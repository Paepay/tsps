import assert from "node:assert/strict";
import { TRANSMIT_VARPS } from "../common/vars";

// The chatbox's game-filter toggle changes varbit 26 on chat_filter_assist (varp 1055) in the
// client. The server can only save the choice for the next login if the whole varp reaches it.
assert.ok(TRANSMIT_VARPS.has(1055), "game chat filter varp 1055 must reach the server");
console.log("Game chat filter varp transmission whitelist: ok");
