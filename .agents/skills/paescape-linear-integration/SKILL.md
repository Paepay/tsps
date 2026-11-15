---
name: paescape-linear-integration
description: Keep Paepay/tsps prod and PaeScape website client pins growing as one timeline; use when opening PaeScape PRs, pinning game-client.lock.json, shipping client branding/bug-report changes, or choosing a merge base across Paepay/tsps and Paepay/PaeScape_Realms.
---

# PaeScape linear integration

Paepay/tsps and Paepay/PaeScape_Realms must grow with time on one integration
line each. Do not run parallel "live" histories that later overwrite each other.

## Integration lines

| Repository | Integration branch | What lands here |
| --- | --- | --- |
| `Paepay/tsps` | `prod` | Hosted-world server + browser client that PaeScape ships |
| `Paepay/PaeScape_Realms` | `main` | Website, platform, and `game-client.lock.json` |

Feature branches are fine. Merging or pinning a long-lived parallel line
(`codex/task31-playable-client`, a stale lock tip, or any other side branch) as
if it were production is not.

## Hard rules

1. **Base every production PR on the current integration tip.** For tsps that
   is `origin/prod`. For Realms that is `origin/main`. Rebase or merge the tip
   into the feature branch before opening or updating the PR.
2. **Land client fixes on `prod` first.** Do not merge browser-client changes
   only into a side branch and then pin that side branch from the website.
3. **Advance `game-client.lock.json` only to a `prod` descendant.** The new
   lock commit must contain every earlier client pin's changes. Never jump
   from a side-branch SHA back to an unrelated `prod` SHA that lacks those
   fixes.
4. **Stack, do not replace.** If Discord Names, branding, PlayerRights stubs,
   and bug-report targets all need to ship, they belong on one `prod` history
   and one lock tip that follows that history.
5. **Cross-repo work needs both tips.** When tsps already expects a platform
   field (for example ticket `discordName`), finish and merge the matching
   Realms change on `main` instead of leaving it on an open parallel PR.

## Cross-repo issues

Agents may **create and comment on GitHub issues in both** `Paepay/tsps` and
`Paepay/PaeScape_Realms` to communicate work that crosses the boundary.

- File (or link) an issue in **each** repo that must change. Do not leave the
  other side as chat-only context.
- State which repo owns which acceptance criteria, link the sibling issue URLs,
  and use `Refs #N` across repos until both sides are merged.
- Prefer an issue when a tsps change needs a Realms platform/website/lock
  follow-up (or the reverse), even if you are only implementing one side now.
- Follow each repo's issue forms and `AGENTS.md`; never put secrets, tokens,
  or private player data in issue bodies.

## Before you pin or merge

```bash
# tsps: feature branch must be based on current prod
git fetch origin prod
git merge-base --is-ancestor origin/prod HEAD   # must succeed after updating

# Realms lock must point at a prod commit that includes prior client pins
git -C <tsps> merge-base --is-ancestor <previous-lock-sha> <new-lock-sha>
```

If the previous lock SHA is not an ancestor of the new one, stop. Cherry-pick
or re-land the missing client commits onto `prod`, then pin that tip.

## Anti-patterns

- Opening client PRs against `codex/task31-playable-client` (or any non-`prod`
  integration branch) after that branch is no longer the live line.
- Pinning Realms to commit A for branding, then to commit B on a different
  history for Discord Names, dropping branding.
- Leaving a required Realms platform change open while the matching tsps
  client/server change is already on `prod`.

## Related

- Root [AGENTS.md](../../../AGENTS.md) — repository-wide rule.
- [docs/paescape-client-deployment.md](../../../docs/paescape-client-deployment.md)
  — lock and `/client/` build contract.
- On Paepay/PaeScape_Realms, the matching skill is also named
  `paescape-linear-integration`.
