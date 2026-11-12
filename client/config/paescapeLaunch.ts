export interface PaeScapeLaunchRequest {
    worldId: string;
    characterId: string;
}

export interface PaeScapeLogin {
    ticket: string;
    character: { id: string; name: string };
    world: { id: string; name: string; endpointUrl: string };
    websocketUrl: string;
    serverAddress: string;
}

type FetchLike = typeof fetch;

const WORLD_ID = /^wld_[A-Za-z0-9_-]{8,128}$/;
const CHARACTER_ID = /^chr_[A-Za-z0-9_-]{8,128}$/;
// TicketStore issues 32 random bytes as unpadded base64url (43 characters).
// Keep the same bounded shape accepted by the hosted server so malformed
// handoffs never reach the game login protocol.
const LOGIN_TICKET = /^[A-Za-z0-9_-]{40,64}$/;
const LOOPBACK = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i;

/**
 * A PaeScape launch URL carries only opaque record ids. The single-use login
 * ticket is deliberately requested after the 3D client and cache have loaded,
 * so its short lifetime is spent connecting to the world rather than loading
 * the application.
 */
export function parsePaeScapeLaunch(search: string): PaeScapeLaunchRequest | undefined {
    const params = new URLSearchParams(search);
    const worldId = params.get("paescapeWorld");
    const characterId = params.get("paescapeCharacter");
    if (!worldId && !characterId) return undefined;
    if (!worldId || !WORLD_ID.test(worldId)) throw new Error("This PaeScape world link is invalid.");
    if (!characterId || !CHARACTER_ID.test(characterId)) throw new Error("This PaeScape character link is invalid.");
    return { worldId, characterId };
}

/** Convert the platform-verified public HTTPS origin into the direct game WSS target. */
export function paescapeSocketTarget(endpoint: string): { websocketUrl: string; serverAddress: string } {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error("The world returned an invalid connection endpoint.");
    }
    if (url.username || url.password) throw new Error("The world endpoint must not contain credentials.");
    if (url.protocol === "http:" && !LOOPBACK.test(url.hostname)) {
        throw new Error("A public PaeScape world must use a secure HTTPS endpoint.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("The world returned an unsupported connection endpoint.");
    }
    const websocket = new URL(url.origin);
    websocket.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    websocket.pathname = "/";
    return { websocketUrl: websocket.toString(), serverAddress: websocket.host };
}

async function responseJson(response: Response): Promise<Record<string, any>> {
    let body: Record<string, any> = {};
    try {
        body = await response.json();
    } catch {
        // The status still gives a useful fallback below.
    }
    if (!response.ok) {
        const message = typeof body.error === "string" && body.error.trim()
            ? body.error
            : `PaeScape returned ${response.status}.`;
        throw new Error(message);
    }
    return body;
}

/**
 * Mint a fresh, single-use ticket through the signed-in website session.
 * Endpoint selection comes only from the authenticated platform response; URL
 * parameters can select ids but can never choose a network destination.
 */
export async function requestPaeScapeLogin(
    launch: PaeScapeLaunchRequest,
    fetchImpl: FetchLike = fetch,
): Promise<PaeScapeLogin> {
    const sessionResponse = await fetchImpl("/platform/api/auth/session", {
        credentials: "include",
        headers: { accept: "application/json" },
    });
    const session = await responseJson(sessionResponse);
    if (session.authenticated !== true || typeof session.csrfToken !== "string" || !session.csrfToken) {
        throw new Error("Sign in with Discord on PaeScape, then press Play again.");
    }

    const ticketResponse = await fetchImpl(
        `/platform/api/worlds/${encodeURIComponent(launch.worldId)}/characters/${encodeURIComponent(launch.characterId)}/login-ticket`,
        {
            method: "POST",
            credentials: "include",
            headers: {
                accept: "application/json",
                "content-type": "application/json",
                "x-csrf-token": session.csrfToken,
            },
            body: "{}",
        },
    );
    const issued = await responseJson(ticketResponse);
    const character = issued.character;
    const world = issued.world;
    if (
        typeof issued.ticket !== "string" || !LOGIN_TICKET.test(issued.ticket) ||
        !character || character.id !== launch.characterId || typeof character.name !== "string" ||
        !world || world.id !== launch.worldId || typeof world.name !== "string" || typeof world.endpointUrl !== "string"
    ) {
        throw new Error("PaeScape returned an invalid login handoff.");
    }
    const target = paescapeSocketTarget(world.endpointUrl);
    return {
        ticket: issued.ticket,
        character: { id: character.id, name: character.name },
        world: { id: world.id, name: world.name, endpointUrl: world.endpointUrl },
        ...target,
    };
}
