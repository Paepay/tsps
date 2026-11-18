/**
 * The global Help chat-channel (Paepay/tsps#66): an ownerless system channel every player joins
 * at login unless they already have a saved activity or group channel. Chat lines start with `/`,
 * as for every chat-channel, and the name is reserved in DisplayNames so no account can take it.
 */

const HELP_CHANNEL_KEY = "help";
const HELP_CHANNEL_NAME = "Help";
// The chat snapshot's member count is a 16-bit field; the world itself admits at most 2048
// players, so this is every player the server can hold without overflowing the packet.
const HELP_CHANNEL_CAPACITY = 0xffff;

let api;

function registerHelpChannel() {
  api.emitCustomEvent("friends-chat:system-channel", {
    key: HELP_CHANNEL_KEY,
    channel: {
      ownerName: HELP_CHANNEL_NAME,
      channelName: HELP_CHANNEL_NAME,
      capacity: HELP_CHANNEL_CAPACITY,
      default: true,
      // Help is global. A full member-list broadcast on every join would be quadratic; a joining
      // player still receives the roster once, but membership changes don't resend it to everyone.
      broadcastMembers: false,
    },
  });
}

module.exports = {
  name: "HelpChat",
  description: "The global Help chat-channel: everyone joins by default and talks with /.",
  register(pluginApi) {
    api = pluginApi;
    api.onServerStartup(registerHelpChannel);
  },
  _test: {
    HELP_CHANNEL_KEY,
    HELP_CHANNEL_NAME,
    HELP_CHANNEL_CAPACITY,
    registerHelpChannel,
  },
};
