# PaeScape browser-client build

PaeScape serves this client at `/client/`; permanent world pages remain at
`/play/<world-slug>`. The production artifact is built from source with:

```text
cd client
corepack yarn install --immutable
corepack yarn build:paescape
```

Requirements are Node 22 or newer and Corepack/Yarn 4.12.0 (pinned by
`client/package.json`). `build:paescape` sets the public path to `/client`, the
read-only cache base to `/cache/`, disables debug IDs and source maps, and then
validates every manifest asset before writing `client/build/paescape-build.json`.
The output is `client/build`; cache data is intentionally not copied into it.

`PaeScape_Realms/game-client.lock.json` pins the exact TSPS commit used by the
website. Its `npm run build` fetches that commit when needed, exports tracked
source into an isolated `.release-build` directory, performs the immutable
client install/build, validates the source-commit marker and installs the
artifact at `dist/client`. No generated client file is committed or copied by
hand.

The cache stays on the PaeScape origin: `/cache/caches.json` and byte-range
requests below `/cache/<revision>/` are served read-only by the website cache
service. Gameplay WebSockets are not proxied; the selected client still
connects directly to the platform-verified world WSS endpoint.

To roll back the browser client, revert the website lock file and website
commit, rebuild, and redeploy `dist`. The pinned TSPS commit remains available
in Git history and does not require changing a hosted world's server files.
