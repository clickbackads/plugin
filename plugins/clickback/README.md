# Clickback for Claude Code

Clickback pays you for the one-line sponsored messages it shows you above the prompt after Claude finishes a turn:

```
 Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com
❯
```

The host is a link to the ad. The ad goes to you, not to Claude. It doesn't cost you any tokens and Claude never sees it. It goes away when you send your next prompt.

It works in Claude Code in a terminal and in the Code tab of the Claude Desktop app. It needs **Claude Code 2.1.287 or later**, the first version with mods. On an older version you get the account tools below but no ads. Check with `claude --version`.

## Install

You need a Clickback account and an API token from your dashboard at https://clickback.dev.

In Claude Code:

```
/plugin marketplace add simonhamp/clickback-plugin
/plugin install clickback@clickback
```

To try a local checkout instead, point the first command at the root of this repository: `/plugin marketplace add /path/to/clickback-plugin`.

When you enable the plugin, Claude Code asks for:

- **Clickback API token**: stored in your system keychain, not in `settings.json`.
- **Clickback server**: leave it as `https://clickback.dev`.

Then restart Claude Code or run `/reload-plugins`.

## What it installs

- **A mod** (`hooks/clickback.ts`). Mods are small modules that run inside a Claude Code session. After a turn ends, this one asks Clickback for an ad and draws it in the band above the prompt. The request runs after the turn has finished, so it never holds up Claude, and it gives up after 3 seconds. Clickback also spaces ads out, so most turns show nothing. It skips `claude -p`, the Agent SDK and the VS Code panel, where nothing it draws would be seen. Run `claude plugin validate` on this folder to see exactly which events it hooks and what it calls.
- **An MCP server** at `<server>/mcp` with account tools you can use by asking Claude: `earnings`, `get_profile`, `update_profile`, `recent_ads` and `report_ad`. There is no tool that shows ads.
- **A skill** that tells Claude when to use those tools, e.g. "report that ad", "how much have I made?" or "update my Clickback profile".

## Privacy

The mod sends Clickback your token, the session id, `surface=mod`, and `agent=claude-code` (or `claude-code-desktop` in the Desktop app). Your prompts, Claude's replies, the transcript and your working directory never leave your machine. It adds nothing to what Claude reads and never changes Claude's messages or tool calls.

The MCP tools only read and change your own Clickback account.

## Turning it off

Collapse the band for a while with `ctrl+x ctrl+a`. To stop ads, disable the plugin in `/plugin`, or uninstall it with `/plugin uninstall clickback@clickback`.

## Testing

```
claude plugin validate plugins/clickback
claude plugin test plugins/clickback
```

To try it against a local server:

```
claude --plugin-dir ./plugins/clickback \
  --settings '{"pluginConfigs":{"clickback@inline":{"options":{"api_token":"1|...","base_url":"http://clickback.test"}}}}'
```

A local `http://` tracking link is drawn as plain text, because Claude Code only makes `https://` (and `http://localhost`) links clickable.

`scripts/stop-hook.sh` is the old Stop hook that printed the ad as `Stop says: ...`. It isn't registered any more. It stays here for agents that only have shell hooks, and its tests live with the Clickback app.
