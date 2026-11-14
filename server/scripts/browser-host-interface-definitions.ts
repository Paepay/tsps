const { buildPresetsInterfaceDefinition } = require("../plugins/modes/pvp/PresetsWidget.PvpMode");

const plugins = [
  "Commands",
  "DestroyItem",
  "TeleportInterface",
  "MaxHitsInterface",
  "SideJournalDefaults",
];

const definitions: Array<{ groupId: number; widgets: unknown[] }> = [buildPresetsInterfaceDefinition()];
// Plugins pass api.core.PlayerRights.* into registerCommand at load time; the stub must
// expose the enum or yarn build:paescape dies before any interface is collected.
const api = new Proxy(
  {
    registerCustomInterface: (definition: { groupId: number; widgets: unknown[] }) => definitions.push(definition),
    core: {
      PlayerRights: {
        NONE: "NONE",
        MODERATOR: "MODERATOR",
        ADMINISTRATOR: "ADMINISTRATOR",
        OWNER: "OWNER",
        DEVELOPER: "DEVELOPER",
      },
    },
  },
  { get: (target, key) => target[key as keyof typeof target] ?? (() => {}) },
);

for (const name of plugins) require(`../plugins/interface/${name}.plugin`).register(api);

if (new Set(definitions.map((definition) => definition.groupId)).size !== definitions.length) {
  throw new Error("Duplicate browser-host interface group");
}
process.stdout.write(JSON.stringify(definitions));
