# Sailing Highlights

Draws clickboxes around the Sailing content the PaeScape server actually places and lines along
the charted routes near the player. Turn it on in the plugin list; it is off on fresh installs.

## What it highlights

- Raised shipwrecks (the `Inspect` locs), and optionally their sunken forms.
- The spyglass and current-duck hint markers the server registers for sea charting.
- Current-duck routes and the two ends of each weather troll's route.
- Port task notice boards near a port.

Every id and tile comes from the server's Sailing content in
`server/plugins/skills/sailing/data`: the wreck types and cache-map wreck sites
(`sailing-salvage.json`), charting markers/routes (`charting.json`), ports
(`sailing-ports.json`) and board objects (`port-tasks.json`). The client bundle cannot import
across the client root, so `data/sailing-highlight-data.json` holds the subset the overlay needs.
`client/tests/sailing-highlights.test.ts` compares that file with the server JSON, so update the
server data and regenerate the copy when either changes.

## Config group `sailing`

- **Show shipwrecks** - raised wrecks (`Inspect`).
- **Show sunken shipwrecks** - wrecks that are not currently raised.
- **Show charting markers** - spyglasses and current-duck starts.
- **Show charting routes** - current-duck and weather-troll routes within 128 tiles.
- **Show port task boards** - boards within 20 tiles of a port's buoy/gangplank/landing.
- **Shipwreck/Charting/Route/Port board color** - overlay colours.

## Limits

The overlay only draws locs the server has in the scene, so content it does not spawn (or a board
outside the loaded scene) is not shown. There is no server data for shipwreck sailing routes, so
only the charting routes are drawn.
