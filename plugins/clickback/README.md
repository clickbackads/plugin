# Clickback for Claude Code

Clickback pays you for the one-line sponsored messages it shows you above the prompt after Claude finishes a turn:

```
 Sponsored · Shipfast: Deploy Laravel apps in 30 seconds → shipfast.example.com
❯
```

The whole line is a link to the ad, so clicking anywhere on it opens it. The ad goes to you, not to Claude. It doesn't cost you any tokens and Claude never sees it. It goes away when you send your next prompt.

It works in Claude Code in a terminal and in the Code tab of the Claude Desktop app. It needs **Claude Code 2.1.287 or later**, the first version with mods. Check with `claude --version`.

## Install

You need a Clickback account at https://clickback.dev. In Claude Code:

```
/plugin marketplace add clickbackads/plugin
/plugin install clickback@clickback
```

## Connecting this computer

Until this computer is connected, the line above the prompt asks you to connect it:

```
 Clickback · Connect this computer to start earning: https://clickback.dev/link (code ABCD-EFGH)
```

1. Click the line; the whole of it is a link to the Connect page. If your terminal doesn't make it clickable, go to the address and type the code.
2. Sign in to Clickback if you need to, check the code matches, and press **Connect**.

The line goes within a few seconds, and ads start after your next turn. Every session on the computer shows the same code, and connecting once covers them all. A code lasts 15 minutes; after that, the next turn shows a new one.

To disconnect a computer, use the Connect your agent page of your Clickback dashboard. The next turn then asks you to connect again.

### The account tools

The plugin also has an MCP server with tools you use by asking Claude. They sign in separately, with Claude Code's own `/mcp`:

1. Run `/mcp`.
2. Pick `plugin:clickback:clickback` and choose **Authenticate**.
3. Your browser opens Clickback. Sign in if you need to, then press **Connect**.

In the Claude Desktop app, which has no `/mcp` panel, run `claude mcp login plugin:clickback:clickback` in a terminal instead. Ads don't need this sign-in.

## What it installs

- **A mod** (`hooks/clickback.ts`). Mods are small modules that run inside a Claude Code session. After a turn ends, this one asks Clickback for an ad and draws it in the band above the prompt. The first time the ad is drawn, it tells Clickback, and that's when you're paid for it. Requests run after the turn has finished, so they never hold up Claude, and each gives up after 3 seconds. It asks at most once a minute, counted across your terminal sessions (the Desktop app keeps its own count), and Clickback spaces ads out further for your whole account, so most turns show nothing. It skips `claude -p`, the Agent SDK and the VS Code panel, where nothing it draws would be seen. Run `claude plugin validate` on this folder to see exactly which events it hooks and what it calls.
- **An MCP server** at `<server>/mcp` with the account tools: `earnings`, `get_profile`, `update_profile`, `recent_ads` and `report_ad`.
- **A skill** that tells Claude when to use those tools, e.g. "report that ad", "how much have I made?" or "update my Clickback profile".

## What it stores and sends

The mod keeps these in the plugin's own store, a JSON file under `~/.claude/plugins/store/` that every session on the computer shares and other mods can't read:

- `token`: the ad token you got by connecting. It fetches ads and confirms them, and nothing else. It can't read your earnings or change your account.
- `link`: the code waiting for you to press Connect, while there is one.
- `linkPolledAt`: when any session last checked that code, so open sessions take turns checking it rather than all asking at once.
- `lastAskedAt`: when any session last asked for an ad.

It sends Clickback:

- To connect: which app you're in (`claude-code`, or `claude-code-desktop` in the Desktop app), then the link's device code every few seconds until you press Connect. However many sessions are open, one of them checks each time.
- For an ad: the ad token, `surface=mod`, which app you're in and the session id.
- When it draws the ad: the ad token, to that ad's address on the Clickback server.

## Privacy

Your prompts, Claude's replies, the transcript and your working directory never leave your machine. The mod adds nothing to what Claude reads, never changes Claude's messages and touches no tool call. Its requests are plain HTTP from the mod itself, not tool calls, so they never go through Claude or a permission prompt.

The MCP tools only read and change your own Clickback account.

## If no ads show

Most turns show nothing on purpose: the plugin asks at most once a minute and Clickback leaves a couple of minutes between ads.

The plugin never adds lines to your transcript. It writes what happened at each step to Claude Code's debug log, led by `clickback`: for example `asking for an ad`, `got ad 41 from shipfast.example.com` and `confirmed ad 41 as shown, charged: yes`, or why it didn't ask or what failed. Start Claude Code with `claude --debug` to write that log. The Desktop app doesn't write one.

## Turning it off

Collapse the band for a while with `ctrl+x ctrl+a`. To stop ads, disable the plugin in `/plugin`, or uninstall it with `/plugin uninstall clickback@clickback`. If you're done with it for good, also disconnect the computer on the Connect your agent page, so its ad token stops working.

## Testing

```
claude plugin validate plugins/clickback
claude plugin test plugins/clickback
```
