# Clickback for Claude Code

Clickback pays you for the one-line sponsored messages it shows you above the prompt after Claude finishes a turn:

```
 Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com
❯
```

The host is a link to the ad. The ad goes to you, not to Claude. It doesn't cost you any tokens and Claude never sees it. It goes away when you send your next prompt.

It works in Claude Code in a terminal and in the Code tab of the Claude Desktop app. It needs **Claude Code 2.1.287 or later**, the first version with mods. Check with `claude --version`.

## Install

You need a Clickback account at https://clickback.dev. In Claude Code:

```
/plugin marketplace add simonhamp/clickback-plugin
/plugin install clickback@clickback
```

Then sign in once:

1. Run `/mcp`.
2. Pick `plugin:clickback:clickback` and choose **Authenticate**.
3. Your browser opens Clickback. Sign in if you need to, then press **Connect**.

That one sign-in is all it takes: it fetches your ads and runs the account tools. Claude Code keeps the token and refreshes it on its own; the plugin never sees it. Until you sign in, the line above the prompt tells you how.

In the Claude Desktop app, which has no `/mcp` panel, run this in a terminal instead:

```
claude mcp login plugin:clickback:clickback
```

To sign a computer out, use **Disconnect** on the Connect your agent page of your dashboard, or choose **Clear authentication** in `/mcp`.

## What it installs

- **A mod** (`hooks/clickback.ts`). Mods are small modules that run inside a Claude Code session. After a turn ends, this one asks Clickback for an ad and draws it in the band above the prompt. The request runs after the turn has finished, so it never holds up Claude, and it gives up after 3 seconds. It asks at most once a minute, counted across every Claude Code session on your computer, and Clickback spaces ads out further, so most turns show nothing. It skips `claude -p`, the Agent SDK and the VS Code panel, where nothing it draws would be seen. Run `claude plugin validate` on this folder to see exactly which events it hooks and what it calls.
- **A permission hook** (`hooks/allow-serve-ad.sh`). The mod's request goes through Claude Code's permission check like any tool call, and without this you'd be asked about it after every turn. It allows a `serve_ad` call only when it carries the current session's id, which is what the mod sends and Claude doesn't know. Anything else gets the usual question.
- **An MCP server** at `<server>/mcp` with account tools you can use by asking Claude: `earnings`, `get_profile`, `update_profile`, `recent_ads` and `report_ad`. It also has `serve_ad`, which the mod fetches ads with. Claude only sees that tool's name, behind tool search, and the mod refuses any call to it that Claude or a subagent makes, so an ad can't reach Claude that way either.
- **A skill** that tells Claude when to use those tools, e.g. "report that ad", "how much have I made?" or "update my Clickback profile".

## Privacy

The mod sends Clickback the session id, `surface=mod`, and `agent=claude-code` (or `claude-code-desktop` in the Desktop app), over the MCP server you signed in to. Your prompts, Claude's replies, the transcript and your working directory never leave your machine. It adds nothing to what Claude reads and never changes Claude's messages. The only tool call it touches is a call to `serve_ad`, which it refuses.

The MCP tools only read and change your own Clickback account.

## Turning it off

Collapse the band for a while with `ctrl+x ctrl+a`. To stop ads, disable the plugin in `/plugin`, or uninstall it with `/plugin uninstall clickback@clickback`.

## Testing

```
claude plugin validate plugins/clickback
claude plugin test plugins/clickback
```
