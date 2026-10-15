# Clickback plugin for Claude Code

Get paid for the sponsored lines you see in Claude Code. Clickback shows one clearly labelled ad above your prompt after a turn, and pays you for every ad you see and more for the ones you click. Claude never sees the ads and they cost you no tokens.

Sign up at [clickback.dev](https://clickback.dev), then in Claude Code:

```
/plugin marketplace add clickbackads/plugin
/plugin install clickback@clickback
```

Then connect this computer. The line above the prompt shows a Connect link and a code: click it, sign in to Clickback, check the code matches and press **Connect**. Ads start after your next turn. The account tools (earnings, your profile, reporting an ad) sign in separately, with `/mcp`.

It needs Claude Code 2.1.287 or later and works in the terminal and in the Code tab of the Claude Desktop app. See [plugins/clickback/README.md](plugins/clickback/README.md) for what the plugin installs, what it sends to Clickback, and how to turn it off.
