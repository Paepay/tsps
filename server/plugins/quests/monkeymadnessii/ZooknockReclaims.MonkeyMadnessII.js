/**
 * Zooknock's free post-Monkey Madness II replacements.
 *
 * The wiki transaction's conditions and hand-out messages are answered here rather than in the
 * quest module so a world with Quests off gets exactly the same ownership checks and transcript
 * as the Quests world (issues 136/196). A bank placeholder is the item id at amount 0, so only a
 * real bank holding counts; worn greegrees and inventory copies count too.
 */
const QuestRuntime = require("../QuestRuntime");

const PAGE = "Zooknock";
const POST_QUEST = "standard-dialogue-after-monkey-madness-ii";
const COMPLETE_STAGE = 195;

function attach(api, { stageOf }) {
  const { ItemIdentifiers, NpcIdentifiers } = api.core;
  const ZOOKNOCK_IDS = new Set([
    NpcIdentifiers.ZOOKNOCK, NpcIdentifiers.ZOOKNOCK_2, NpcIdentifiers.ZOOKNOCK_3, NpcIdentifiers.ZOOKNOCK_4,
  ]);
  // Canonical Transcript:Zooknock postquest page. These are free replacements, distinct from the
  // tunnel's paid remains exchange and the MM2 paw quest step.
  const RECLAIMS = [
    ["vCCtz2", "qhilom", ItemIdentifiers.NINJA_MONKEY_GREEGREE],
    ["eUnnK9", "bzMEBy", ItemIdentifiers.NINJA_MONKEY_GREEGREE_2],
    ["mmr4it", "l9BRxu", ItemIdentifiers.KRUK_MONKEY_GREEGREE],
    ["QE-M1k", "VulznX", ItemIdentifiers.ZOMBIE_MONKEY_GREEGREE],
    ["0HZd3F", "O3moWv", ItemIdentifiers.ZOMBIE_MONKEY_GREEGREE_2],
    ["moHRJE", "6WKlze", ItemIdentifiers.GORILLA_GREEGREE],
    ["FuxRIL", "S-kK90", ItemIdentifiers.BEARDED_GORILLA_GREEGREE],
    ["Jkpi5j", "g6Dp--", ItemIdentifiers.KARAMJAN_MONKEY_GREEGREE],
    ["34nXxJ", "1FErIR", ItemIdentifiers.MSPEAK_AMULET],
    ["zZr5-T", "Xrklqr", ItemIdentifiers._10TH_SQUAD_SIGIL],
  ];
  const CONDITION_TO_ITEM = new Map(RECLAIMS.map(([condition, , item]) => [condition, item]));
  const MESSAGE_TO_ITEM = new Map(RECLAIMS.map(([, message, item]) => [message, item]));

  function isPostquestZooknock(event) {
    return event.npcId === NpcIdentifiers.ZOOKNOCK_4 && stageOf(event.player) >= COMPLETE_STAGE
      && event.pages?.some(page => page.page === PAGE && page.variants?.includes(POST_QUEST));
  }

  function bankHasItem(player, itemId) {
    for (const bank of player.getBanks?.() ?? []) {
      if ((bank?.getAmount?.(itemId) ?? 0) > 0) return true;
    }
    return false;
  }

  function equippedItem(player, itemId) {
    return (player.getEquipment?.()?.getItems?.() ?? [])
      .some(item => item?.getId?.() === itemId && (item.getAmount?.() ?? 0) > 0);
  }

  function hasReclaim(player, itemId) {
    return player.getInventory().getAmount(itemId) > 0 || equippedItem(player, itemId) || bankHasItem(player, itemId);
  }

  function talk(event) {
    const { player, npcId } = event;
    if (!ZOOKNOCK_IDS.has(npcId) || stageOf(player) < COMPLETE_STAGE) return false;
    event.handled = true;
    QuestRuntime.startTranscript(api, player, npcId, PAGE, POST_QUEST, undefined, event.npc ?? null);
    return true;
  }

  function answerCondition(event) {
    const itemId = CONDITION_TO_ITEM.get(event.stepId);
    if (itemId === undefined || !isPostquestZooknock(event)) return undefined;
    return hasReclaim(event.player, itemId);
  }

  function handleReclaim(event) {
    const itemId = MESSAGE_TO_ITEM.get(event.stepId);
    if (event.kind !== "message" || itemId === undefined || !isPostquestZooknock(event)) return false;
    event.handled = true;
    // Recheck at delivery, not just while resolving the condition. Never replace an already-owned
    // item or drop a free reward on a full inventory.
    if (hasReclaim(event.player, itemId)) {
      event.player.sendMessage("You already have one of those.");
      event.end = true;
    } else if (event.player.getInventory().getFreeSlots() <= 0) {
      event.player.sendMessage("You need a free inventory slot before Zooknock can hand you a replacement.");
      event.end = true;
    } else {
      event.player.getInventory().adds(itemId, 1);
      event.box = { items: [itemId] };
    }
    return true;
  }

  api.onNpcInteraction("Zooknock", { "Talk-to": talk });
  api.onNpcDialogueCondition(answerCondition);
  api.onCustomEvent("npc-dialogue:action", handleReclaim);
  return { talk, answerCondition, handleReclaim, hasReclaim, isPostquestZooknock, reclaims: RECLAIMS };
}

module.exports = { attach, PAGE, POST_QUEST, COMPLETE_STAGE };
