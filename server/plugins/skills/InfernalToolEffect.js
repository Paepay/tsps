/**
 * Shared Toggle for Infernal axe, pickaxe and harpoon (Wiki, 14 October 2026): each tool can
 * disable its auto-burn / smelt / cook effect. Default is on. Ornamented copies put Toggle under
 * the Options submenu; plain ones and worn options expose Toggle directly.
 */
const ATTRIBUTES = Object.freeze({
  axe: "infernal:axe-effect",
  pickaxe: "infernal:pickaxe-effect",
  harpoon: "infernal:harpoon-effect",
});

const MESSAGES = Object.freeze({
  axe: {
    on: "Your Infernal axe will now burn the logs you chop.",
    off: "Your Infernal axe will now leave the logs as they are.",
  },
  pickaxe: {
    on: "Your Infernal pickaxe will now smelt the ore you mine.",
    off: "Your Infernal pickaxe will now leave the ore as it is.",
  },
  harpoon: {
    on: "Your Infernal harpoon will now cook the fish you catch.",
    off: "Your Infernal harpoon will now leave your catch raw.",
  },
});

/** Whether the tool's auto effect is on (default true when unset). */
function enabled(player, kind) {
  return player?.getAttribute?.(ATTRIBUTES[kind]) !== false;
}

function toggle(kind, { player }) {
  const next = !enabled(player, kind);
  player.setAttribute(ATTRIBUTES[kind], next);
  player.sendMessage(MESSAGES[kind][next ? "on" : "off"]);
  return true;
}

/** Options submenu entry (ornamented tools) or a direct Toggle option. */
function options(kind, event) {
  if (event.subOption === "Toggle") return toggle(kind, event);
  return false;
}

/**
 * Registers Check (optional), Toggle and Options→Toggle for each item name, and persists the
 * effect attribute once per kind.
 */
function attach(api, kind, names, check) {
  // Optional: unit harnesses (Tempoross cook) attach InfernalHarpoon with a stub api.
  api.persistAttribute?.(ATTRIBUTES[kind], true);
  const handlers = {
    Toggle: toggle.bind(null, kind),
    Options: options.bind(null, kind),
  };
  if (typeof check === "function") handlers.Check = check;
  for (const name of names) api.onItemAction(name, handlers);
}

module.exports = { enabled, attach, ATTRIBUTES, MESSAGES, _test: { toggle, options } };
