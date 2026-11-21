import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
    getClientBrandName,
    getPlatformWorldListUrl,
    getServerListNotice,
    isPaeScapePlatformClient,
} from "../config/clientEnv";
import { handleServerListClick } from "../game/login/renderer/input/mouseClick";
import {
    discoverPlatformWorlds,
    platformWorldEntries,
    relayWorldEntries,
} from "../game/login/renderer/serverList";

const previousPublicUrl = process.env.PUBLIC_URL;
process.env.PUBLIC_URL = "/client";

const opened: string[] = [];
function setWindow(hostname: string, pathname = "/client/", search = ""): void {
    (globalThis as any).window = {
        location: { hostname, pathname, search, assign: (url: string) => opened.push(url) },
        open: (url: string) => opened.push(url),
    };
}

// The hosted client is the only place that should read the platform directory.
setWindow("paescape.online");
assert.equal(isPaeScapePlatformClient(), true);
assert.equal(getPlatformWorldListUrl(), "/platform/api/play/worlds");
assert.equal(getClientBrandName(), "PaeScape.Online");
assert.equal(getServerListNotice(), "Register on PaeScape.Online to publish your own world");

setWindow("localhost", "/", "");
assert.equal(isPaeScapePlatformClient(), false, "local development keeps the RSPS.app relay list");
assert.equal(getPlatformWorldListUrl(), undefined);
assert.equal(getClientBrandName(), "RSPS.app");

setWindow("127.0.0.1", "/client/", "?paescapePlatform=1&paescapeWorld=wld_AbCdEf12&paescapeCharacter=chr_AbCdEf12");
assert.equal(isPaeScapePlatformClient(), true, "the dev flag exercises the hosted client locally");

const payload = {
    ok: true,
    worlds: [
        {
            id: "wld_AbCdEf12", slug: "official", name: "PaeScape Official",
            online: true, joinable: true, playerCount: 42, maxPlayers: 2000, ownerName: "PaeScape",
        },
        {
            id: "wld_ZzYyXx99", slug: "kappa-house", name: "Kappa House",
            online: false, joinable: false, playerCount: 0, ownerName: "Kappa",
        },
        { id: "wld_short", slug: "bad-id", name: "Bad id" },
        { id: "wld_Good4567", slug: "bad slug", name: "Bad slug" },
        { id: "wld_Good8901", slug: "no-name", name: "" },
    ],
};

const entries = platformWorldEntries(payload);
assert.equal(entries.length, 3, "only worlds with a valid id and slug are listed");
assert.equal(entries[0].name, "PaeScape Official");
assert.equal(entries[0].address, "", "platform worlds are opened through the website, not the socket");
assert.equal(entries[0].playUrl, "/play/official");
assert.equal(entries[0].platformWorldId, "wld_AbCdEf12");
assert.equal(entries[0].playerCount, 42);
assert.equal(entries[0].maxPlayers, 2000);
assert.equal(entries[0].ownerName, "PaeScape");
assert.equal(entries[0].ownerProfileUrl, undefined, "there is no RSPS.app profile to link to");
assert.equal(entries[1].playerCount, null, "an offline world shows Offline");
assert.equal(entries[2].name, "no-name", "a blank name falls back to the slug");

async function checkSwitch(): Promise<void> {
    (globalThis as any).self = globalThis;
    require.extensions[".glsl"] = (module, file) => { module.exports = readFileSync(file, "utf8"); };
    for (const extension of [".png", ".jpg", ".webp"]) {
        require.extensions[extension] = (module, file) => { module.exports = file; };
    }
    const { OsrsClient } = await import("../game/OsrsClient");

    const here = { ...entries[0] };
    const there = { ...entries[1], platformWorldId: "wld_ZzYyXx99", playUrl: "/play/kappa-house" };
    let clicked: any;
    const done: string[] = [];
    const client: any = Object.create(OsrsClient.prototype);
    client.loginRenderer = { serverList: [here, there], handleMouseClick: () => clicked };
    client.inputManager = { clickMode3: 1, saveClickX: 1, saveClickY: 1 };
    client.loginState = {
        serverTransport: "websocket", serverAddress: "", serverSecure: true,
        serverListOpen: true, serverSwitchConfirm: null,
    };
    client.varManager = { getVarbit: () => 0 };
    client.performLogout = (after: () => void) => { done.push("logout"); after(); };
    client.processLoginAction = (action: any) => done.push(action.type);

    setWindow("paescape.online", "/client/", "?paescapeWorld=wld_AbCdEf12&paescapeCharacter=chr_AbCdEf12");
    const click = (action: any) => {
        clicked = action;
        Object.assign(client.inputManager, { clickMode3: 1, saveClickX: 1, saveClickY: 1 });
        client.handleInGameServerListInput();
    };

    click({ type: "select_server", index: 0 });
    assert.deepEqual(done, ["close_server_list"], "the launched world is current and just closes the list");
    click({ type: "select_server", index: 1 });
    assert.equal(client.loginState.serverSwitchConfirm, there, "another platform world asks first");
    click({ type: "confirm_server_switch" });
    assert.deepEqual(done, ["close_server_list"], "switching to a platform world does not log out first");
    assert.deepEqual(opened, ["https://rsps.app/public/u/toby", "/play/kappa-house"]);

    opened.length = 0;
    client.loginState.serverListOpen = true;
    client.varManager.getVarbit = () => 1;
    click({ type: "select_server", index: 1 });
    assert.equal(client.loginState.serverSwitchConfirm, null, "with the confirmation off it goes straight there");
    assert.deepEqual(opened, ["/play/kappa-house"]);

    opened.length = 0;
    const direct: any = Object.create(OsrsClient.prototype);
    direct.loginRenderer = { serverList: [there] };
    direct.loginState = { serverListOpen: true, hoveredServerIndex: 0 };
    assert.equal(direct.processLoginAction({ type: "select_server", index: 0 }), undefined);
    assert.deepEqual(opened, ["/play/kappa-house"], "the login screen hands off the same way");
}

async function main(): Promise<void> {
    setWindow("paescape.online");
    const originalFetch = globalThis.fetch;
    let requested = "";
    globalThis.fetch = (async (url: string) => {
        requested = String(url);
        return { ok: true, json: async () => payload };
    }) as any;
    const discovered = await discoverPlatformWorlds();
    assert.equal(requested, "/platform/api/play/worlds");
    assert.deepEqual(discovered.map((world) => world.platformWorldId), ["wld_AbCdEf12", "wld_ZzYyXx99", "wld_Good8901"]);
    globalThis.fetch = originalFetch;

    // The Owner cell links only when the entry names a profile.
    const host = {
        probed: true,
        serverList: [{ ...entries[0] }],
        canvasWidth: 800,
        canvasHeight: 600,
        contentScale: 1,
        layoutConfig: { isTouch: false, minTouchTarget: 44 },
        fontPlain12: { measure: (text: string) => text.length * 6 },
    } as any;
    const rowY = Math.floor((600 - 54) / 2) + 30 + 10;
    assert.deepEqual(handleServerListClick(host, {} as any, 365, rowY), { type: "select_server", index: 0 });
    assert.deepEqual(opened, [], "a platform owner name is not a link");

    const relay = relayWorldEntries("wss://worlds.rsps.app", [], {
        worlds: [{ worldId: "toby", name: "TobyScape", ownerUsername: "toby", playerCount: 3 }],
    })[0];
    assert.equal(relay.ownerProfileUrl, "https://rsps.app/public/u/toby");
    host.serverList = [relay];
    assert.equal(handleServerListClick(host, {} as any, 365, rowY), undefined);
    assert.deepEqual(opened, ["https://rsps.app/public/u/toby"]);

    await checkSwitch();
}

main().then(
    () => {
        if (previousPublicUrl === undefined) delete process.env.PUBLIC_URL;
        else process.env.PUBLIC_URL = previousPublicUrl;
        console.log("Platform world list test passed");
    },
    (error) => {
        console.error(error);
        process.exit(1);
    },
);
