import {
    getConfiguredDefaultServer,
    getConfiguredServers,
    getPlatformWorldListUrl,
    getWebRtcRelayConfig,
} from "../../../config/clientEnv";
import { SERVER_LIST_URL } from "./constants";
import type { LoginRendererHost } from "./host";
import type { ServerListEntry } from "./types";

function filterServersForCurrentHost(servers: ServerListEntry[]) {

        // The default server is always pickable, even when the list doesn't name it, so
        // choosing another world never strands the player away from it.
        const preferred = getConfiguredDefaultServer();
        if (preferred && !servers.some((s) => s.address === preferred.address)) {
            servers = [serverEntry(preferred), ...servers];
        }
        if (typeof window === "undefined") return servers;
        const pageHost = window.location.hostname.toLowerCase();
        const pageIsLocal =
            pageHost === "localhost" ||
            pageHost === "127.0.0.1" ||
            pageHost === "[::1]" ||
            pageHost === "::1";
        if (pageIsLocal) return servers;

        return servers.filter((s) => {
            const address = s.address.trim().toLowerCase();
            return !(
                address === "localhost" ||
                address.startsWith("localhost:") ||
                address === "127.0.0.1" ||
                address.startsWith("127.0.0.1:") ||
                address === "[::1]" ||
                address.startsWith("[::1]:") ||
                address === "::1"
            );
        });
    
}

function serverEntry(server: any): ServerListEntry {
    const transport = server?.transport === "webrtc" ? "webrtc" : "websocket";
    const signalUrl = typeof server?.signalUrl === "string" ? server.signalUrl : undefined;
    return {
        name: server?.name ?? "Unknown",
        address:
            typeof server?.address === "string"
                ? server.address
                : transport === "webrtc" && signalUrl
                  ? new URL(signalUrl).host
                  : "",
        secure: server?.secure ?? false,
        playerCount: null,
        maxPlayers: server?.maxPlayers ?? 2047,
        transport,
        signalUrl,
        worldId: typeof server?.worldId === "string" ? server.worldId : undefined,
        ownerUsername: typeof server?.ownerUsername === "string" ? server.ownerUsername : undefined,
        iceServers: Array.isArray(server?.iceServers) ? server.iceServers : [],
    };
}

function validPublicText(value: unknown, maxLength: number): value is string {
    if (typeof value !== "string" || value.length < 1 || value.length > maxLength) return false;
    return !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
    });
}

export function relayWorldEntries(
    signalUrl: string,
    iceServers: RTCIceServer[],
    payload: unknown,
): ServerListEntry[] {
    const worlds = (payload as any)?.worlds;
    if (!Array.isArray(worlds)) return [];
    const relayUrl = new URL(signalUrl);
    return worlds
        // The relay also lists recently offline worlds; only the website shows those.
        .filter((world: any) => typeof world?.worldId === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(world.worldId) && world.online !== false)
        .flatMap((world: any): ServerListEntry[] => {
            let endpoint = relayUrl;
            if (world.transport === "websocket") {
                try {
                    endpoint = new URL(world.webSocketUrl);
                    if (!["ws:", "wss:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.hash) return [];
                } catch { return []; }
            }
            return [{
                name:
                    validPublicText(world.name, 64) && world.name === world.name.trim()
                        ? world.name
                        : world.worldId,
                address: endpoint.host + (world.transport === "websocket" ? endpoint.pathname + endpoint.search : ""),
                secure: endpoint.protocol === "wss:",
                playerCount:
                    Number.isInteger(world.playerCount) && world.playerCount >= 0 && world.playerCount <= 2047
                        ? world.playerCount
                        : -1,
                maxPlayers: 2047,
                transport: world.transport === "websocket" ? "websocket" : "webrtc",
                signalUrl,
                worldId: world.worldId,
                ownerUsername:
                    validPublicText(world.ownerUsername, 100)
                        ? world.ownerUsername
                        : undefined,
                ownerProfileUrl:
                    validPublicText(world.ownerUsername, 100)
                        ? forumProfileUrl(world.ownerUsername)
                        : undefined,
                iceServers,
                relayDiscovered: true,
            }];
        });
}

export function forumProfileUrl(ownerUsername: string): string {
    return `https://rsps.app/public/u/${encodeURIComponent(ownerUsername)}`;
}

const WORLD_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const PLATFORM_WORLD_ID = /^wld_[A-Za-z0-9_-]{8,128}$/;

/**
 * PaeScape.Online's public world directory (`/platform/api/play/worlds`).
 *
 * These worlds cannot be entered by re-pointing the socket: the hosted client needs a
 * website-minted single-use ticket bound to a character. Each row therefore carries the
 * world's `/play/<slug>` page, where the player picks a character and starts a new client.
 */
export function platformWorldEntries(payload: unknown): ServerListEntry[] {
    const worlds = (payload as any)?.worlds;
    if (!Array.isArray(worlds)) return [];
    return worlds.flatMap((world: any): ServerListEntry[] => {
        if (typeof world?.slug !== "string" || !WORLD_SLUG.test(world.slug)) return [];
        if (typeof world?.id !== "string" || !PLATFORM_WORLD_ID.test(world.id)) return [];
        const name =
            validPublicText(world.name, 64) && world.name === world.name.trim()
                ? world.name
                : world.slug;
        const online = world.online !== false;
        const playerCount =
            online && Number.isInteger(world.playerCount) && world.playerCount >= 0 && world.playerCount <= 2047
                ? world.playerCount
                : online ? -1 : null;
        return [{
            name,
            address: "",
            secure: true,
            playerCount,
            maxPlayers:
                Number.isInteger(world.maxPlayers) && world.maxPlayers > 0
                    ? world.maxPlayers
                    : 2047,
            transport: "websocket",
            playUrl: `/play/${encodeURIComponent(world.slug)}`,
            platformWorldId: world.id,
            ownerName: validPublicText(world.ownerName, 100) ? world.ownerName : undefined,
            relayDiscovered: true,
        }];
    });
}

export async function discoverPlatformWorlds(
    directoryUrl = getPlatformWorldListUrl(),
): Promise<ServerListEntry[]> {
    if (!directoryUrl) return [];
    try {
        const response = await fetch(directoryUrl, { signal: AbortSignal.timeout(5000) });
        return response.ok ? platformWorldEntries(await response.json()) : [];
    } catch {
        return [];
    }
}

export function replaceRelayWorlds(
    current: ServerListEntry[],
    discovered: ServerListEntry[],
): ServerListEntry[] {
    const permanent = current.filter((server) => !server.relayDiscovered);
    const configured = new Set(
        permanent
            .filter((server) => server.signalUrl && server.worldId)
            .map((server) => `${server.signalUrl}|${server.worldId}`),
    );
    return [
        ...permanent,
        ...discovered.filter((server) => !configured.has(`${server.signalUrl}|${server.worldId}`)),
    ];
}

export async function discoverRelayWorlds(relay = getWebRtcRelayConfig()): Promise<ServerListEntry[]> {
    if (!relay) return [];
    try {
        const url = new URL(relay.signalUrl);
        url.protocol = url.protocol === "wss:" ? "https:" : "http:";
        url.pathname = "/worlds";
        const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
        return response.ok
            ? relayWorldEntries(relay.signalUrl, relay.iceServers, await response.json())
            : [];
    } catch {
        return [];
    }
}

function probeWebSocket(url: string, timeoutMs: number) {

        return new Promise((resolve) => {
            let settled = false;
            const ws = new WebSocket(url);
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    ws.close();
                    resolve(false);
                }
            }, timeoutMs);
            ws.addEventListener("open", () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    ws.close();
                    resolve(true);
                }
            });
            ws.addEventListener("error", () => {
                if (!settled) {
                    settled = true;
                    clearTimeout(timer);
                    resolve(false);
                }
            });
        });
    
}

export async function fetchServerList(host: LoginRendererHost): Promise<void> {

        if (host.serverListFetched) return;

        // The PaeScape website client has one authoritative list: its platform's worlds.
        if (getPlatformWorldListUrl()) {
            const worlds = await discoverPlatformWorlds();
            if (worlds.length > 0) {
                host.serverList = worlds;
                host.serverListFetched = true;
                return;
            }
        }

        const configured = getConfiguredServers();
        if (configured && configured.length > 0) {
            host.serverList = filterServersForCurrentHost(
                configured.map(serverEntry),
            );
            host.serverListFetched = true;
            return;
        }

        try {
            const res = await fetch(SERVER_LIST_URL, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data) && data.length > 0) {
                    host.serverList = filterServersForCurrentHost(
                        data.map(serverEntry),
                    );
                }
            }
        } catch {
            // keep fallback
        }
        host.serverListFetched = true;
    
}

export function refreshServerList(host: LoginRendererHost) {

        if (host.probing) return;
        host.probed = false;
        host.probing = true;

        const visibleServers = host.serverList.filter((server) => !server.relayDiscovered);
        const promises = visibleServers.map(async (server) => {
            if (server.signalUrl && server.worldId) {
                try {
                    const statusUrl = new URL(server.signalUrl);
                    statusUrl.protocol = statusUrl.protocol === "wss:" ? "https:" : "http:";
                    statusUrl.pathname = "/worlds";
                    const response = await fetch(statusUrl, { signal: AbortSignal.timeout(8000) });
                    const data = response.ok ? await response.json() : undefined;
                    const world = data?.worlds?.find((entry: any) => entry?.worldId === server.worldId && entry.online !== false);
                    const entry = relayWorldEntries(server.signalUrl, server.iceServers ?? [], { worlds: world ? [world] : [] })[0];
                    if (entry) Object.assign(server, entry, { name: server.name, relayDiscovered: false });
                    server.playerCount = Number.isInteger(world?.playerCount) ? world.playerCount : world ? -1 : null;
                } catch {
                    server.playerCount = null;
                }
                return;
            }
            const wsProto = server.secure ? "wss" : "ws";
            const alive = await probeWebSocket(`${wsProto}://${server.address}`, 5000);
            server.playerCount = alive ? -1 : null;
        });

        const discovery = getPlatformWorldListUrl()
            ? discoverPlatformWorlds()
            : discoverRelayWorlds();
        Promise.all([Promise.all(promises), discovery]).then(([, discovered]) => {
            host.serverList = replaceRelayWorlds(visibleServers, discovered);
        }).finally(() => {
            host.probing = false;
            host.probed = true;
        });
    
}
