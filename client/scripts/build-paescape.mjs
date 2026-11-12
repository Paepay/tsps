import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAESCAPE_PUBLIC_PATH = "/client";
export const PAESCAPE_CACHE_BASE_URL = "/cache/";

const clientRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function regularFiles(root, relative = "") {
    const files = [];
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
        const name = path.posix.join(relative.replaceAll("\\", "/"), entry.name);
        const local = path.join(root, name);
        if (entry.isDirectory()) files.push(...regularFiles(root, name));
        else if (entry.isFile()) files.push(name);
        else throw new Error(`Unsupported PaeScape build entry: ${name}`);
    }
    return files;
}

export function validatePaeScapeBuild(buildRoot) {
    const indexPath = path.join(buildRoot, "index.html");
    const manifestPath = path.join(buildRoot, "asset-manifest.json");
    const workerPath = path.join(buildRoot, "service-worker.js");
    for (const required of [indexPath, manifestPath, workerPath]) {
        if (!existsSync(required) || !statSync(required).isFile()) {
            throw new Error(`PaeScape client build is missing ${path.basename(required)}`);
        }
    }

    const index = readFileSync(indexPath, "utf8");
    if (!index.includes(`${PAESCAPE_PUBLIC_PATH}/static/`)) {
        throw new Error("PaeScape client index does not load assets from /client/");
    }
    if (/(?:src|href)=["']\/play\//.test(index)) {
        throw new Error("PaeScape client index still references the legacy /play/ mount");
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const fileUrls = Object.values(manifest.files ?? {});
    const entryUrls = (manifest.entrypoints ?? []).map((url) => typeof url === "string" && !url.startsWith("/")
        ? `${PAESCAPE_PUBLIC_PATH}/${url}`
        : url);
    const urls = [...fileUrls, ...entryUrls];
    if (urls.length === 0 || fileUrls.some((url) => typeof url !== "string" || !url.startsWith(`${PAESCAPE_PUBLIC_PATH}/`))) {
        throw new Error("PaeScape client manifest contains an asset outside /client/");
    }
    for (const url of urls) {
        const relative = url.slice(PAESCAPE_PUBLIC_PATH.length + 1).split(/[?#]/, 1)[0];
        if (!relative || !existsSync(path.join(buildRoot, ...relative.split("/")))) {
            throw new Error(`PaeScape client manifest references a missing asset: ${url}`);
        }
    }
    if (existsSync(path.join(buildRoot, "caches"))) {
        throw new Error("PaeScape client build must stream /cache/ rather than bundle mutable cache data");
    }

    const files = regularFiles(buildRoot);
    if (files.some((name) => name.endsWith(".map"))) {
        throw new Error("PaeScape production client must not publish source maps");
    }
    return { files: files.length, bytes: files.reduce((sum, name) => sum + statSync(path.join(buildRoot, name)).size, 0) };
}

function runBuild() {
    const runner = path.resolve(clientRoot, "../scripts/run-with-env.mjs");
    const craco = path.resolve(clientRoot, "node_modules/@craco/craco/dist/bin/craco.js");
    const result = spawnSync(process.execPath, [runner, "production", craco, "build"], {
        cwd: clientRoot,
        env: {
            ...process.env,
            PUBLIC_URL: PAESCAPE_PUBLIC_PATH,
            REACT_APP_CACHE_BASE_URL: PAESCAPE_CACHE_BASE_URL,
            REACT_APP_DISABLE_DEBUG_ID: "true",
            GENERATE_SOURCEMAP: "false",
        },
        stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`PaeScape client build failed (${result.status ?? result.signal})`);

    const buildRoot = path.join(clientRoot, "build");
    const summary = validatePaeScapeBuild(buildRoot);
    const sourceCommit = process.env.PAESCAPE_CLIENT_SOURCE_COMMIT?.trim();
    if (sourceCommit && !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Invalid PAESCAPE_CLIENT_SOURCE_COMMIT");
    writeFileSync(path.join(buildRoot, "paescape-build.json"), JSON.stringify({
        version: 1,
        sourceCommit: sourceCommit || null,
        publicPath: `${PAESCAPE_PUBLIC_PATH}/`,
        cacheBaseUrl: PAESCAPE_CACHE_BASE_URL,
    }));
    console.log(`PaeScape client: ${summary.files} files, ${(summary.bytes / 1048576).toFixed(1)} MiB, ${PAESCAPE_PUBLIC_PATH}/`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        runBuild();
    } catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
