import assert from "node:assert/strict";
import {
    paescapeSocketTarget,
    parsePaeScapeLaunch,
    requestPaeScapeLogin,
} from "../config/paescapeLaunch";

const worldId = "wld_CwpaEFjBEdHU6oq4";
const characterId = "chr_FzTPdSQgqIABb6eX";
const ticket = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG";

assert.deepEqual(
    parsePaeScapeLaunch(`?paescapeWorld=${worldId}&paescapeCharacter=${characterId}`),
    { worldId, characterId },
);
assert.equal(parsePaeScapeLaunch("?debug"), undefined);
assert.throws(() => parsePaeScapeLaunch(`?paescapeWorld=${worldId}`), /character link is invalid/);
assert.throws(
    () => parsePaeScapeLaunch(`?paescapeWorld=${worldId}&paescapeCharacter=not-a-character`),
    /character link is invalid/,
);

assert.deepEqual(paescapeSocketTarget("https://world.example:8443/control?ignored=1"), {
    websocketUrl: "wss://world.example:8443/",
    serverAddress: "world.example:8443",
});
assert.deepEqual(paescapeSocketTarget("http://127.0.0.1:43701"), {
    websocketUrl: "ws://127.0.0.1:43701/",
    serverAddress: "127.0.0.1:43701",
});
assert.throws(() => paescapeSocketTarget("http://world.example"), /must use a secure HTTPS endpoint/);
assert.throws(() => paescapeSocketTarget("https://name:secret@world.example"), /must not contain credentials/);

const calls: Array<{ url: string; init?: RequestInit }> = [];
const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/api/auth/session")) {
        return Response.json({ authenticated: true, csrfToken: "csrf_test" });
    }
    return Response.json({
        ticket,
        character: { id: characterId, name: "Task31Check" },
        world: { id: worldId, name: "1st world", endpointUrl: "https://world.example:8443" },
    });
};

const wrongWorldFetch = async (input: RequestInfo | URL): Promise<Response> => {
    if (String(input).endsWith("/api/auth/session")) {
        return Response.json({ authenticated: true, csrfToken: "csrf_test" });
    }
    return Response.json({
        ticket,
        character: { id: characterId, name: "Task31Check" },
        world: { id: "wld_wrongWorld123", name: "Wrong", endpointUrl: "https://wrong.example" },
    });
};

async function main(): Promise<void> {
    const login = await requestPaeScapeLogin({ worldId, characterId }, fetchImpl as typeof fetch);
    assert.equal(login.websocketUrl, "wss://world.example:8443/");
    assert.equal(login.character.name, "Task31Check");
    assert.equal(calls.length, 2);
    assert.equal(calls[1]?.url, `/platform/api/worlds/${worldId}/characters/${characterId}/login-ticket`);
    assert.equal((calls[1]?.init?.headers as Record<string, string>)["x-csrf-token"], "csrf_test");
    assert.equal(calls[1]?.init?.credentials, "include");

    await assert.rejects(
        requestPaeScapeLogin({ worldId, characterId }, wrongWorldFetch as typeof fetch),
        /invalid login handoff/,
    );
    console.log("PaeScape website launch test passed");
}

void main();
