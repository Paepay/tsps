# Rooftop Agility Clickboxes

Draws a blue/cyan clickbox around every obstacle of the ten rooftop agility courses, so the
next gap, rope, wall or ledge is easy to see and click. It is off on fresh installs; enable
**Rooftop Agility Clickboxes** in the plugin list.

## What it highlights

Only the locs the server's rooftop course files use
(`server/plugins/skills/agility/courses/*Rooftop*.js`): Draynor, Al Kharid, Varrock, Canifis,
Falador, Seers' Village, Pollnivneach, Rellekka, Ardougne and Prifddinas. Other agility content
(the Agility Pyramid, Werewolf, the Wilderness course and shortcuts) is excluded. The id list
lives in `RooftopObstacles.ts`; its test compares it with the server course files, so it cannot
drift or blanket-highlight unrelated agility objects.

## Settings

Config group `rooftopagility`:

- **Show clickboxes** - the overlay toggle while the plugin itself stays enabled.
- **Clickbox color** - border colour, cyan by default.
- **Clickbox fill color** - translucent cyan by default.
- **Border width** - border width in pixels.

The clickbox is the screen hull of the object model's world-space bounds, the same projection
Object Markers uses. Rooftop courses stack their obstacles on planes 0-3, so the plugin scans all
four planes inside the course areas derived from the cache's map placements; scanning only the
player's current plane hid every gap, ledge or rope that stood a level above or below it.
