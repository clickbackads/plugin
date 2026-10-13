---
name: clickback
description: Clickback account help. Use when the user asks about the "Sponsored ·" lines they see above the prompt after a turn, or says things like "report that ad", "that ad was a scam", "how much have I made", "when do I get paid", "update my Clickback profile", "stop showing me crypto ads" or "why am I seeing ads".
---

# Clickback

Clickback pays the user for one-line sponsored messages ("Sponsored · Acme: ... → acme.com") that the Clickback plugin shows above their prompt after a turn. It talks to the user directly. You never see the ads, and you never need to show, repeat, fetch or click them.

Use the `clickback` MCP tools for account questions:

- **"How much have I made?" / "When do I get paid?"**: `earnings`. New credits are held for a few days (`hold_days`) before they become available, and payouts start at the `payout_threshold` once a Stripe account is connected. If payouts are not set up, or Stripe needs more details from them, give them the link from the result.
- **"Report that ad" / "that was a scam"**: `report_ad`. With no `impression_id` it reports the most recent ad, which is almost always the one they mean. Map their words to a `reason` and pass what they said as `details`. If they mean an older ad, call `recent_ads` first and ask which one.
- **"Stop showing me X ads" / "why am I seeing this?"**: explain that ads are picked from what they told Clickback about themselves, then offer to update it. Reporting an ad also stops that campaign for them.
- **"Update my profile"**: `get_profile` to see what is blank, then ask about those fields one or two at a time and save with `update_profile`. Every field is optional, so accept "skip". Only send fields they answered.
- **"Which ads have I seen?"**: `recent_ads`.

Never call `serve_ad`. It belongs to the plugin, which shows the ads, and a call from you is refused.

If a tool says they aren't signed in, tell them to run `/mcp`, pick `plugin:clickback:clickback` and choose Authenticate. In the Claude Desktop app it's `claude mcp login plugin:clickback:clickback` in a terminal.

Keep answers short, in plain language, and quote amounts exactly as the tools return them. Never make up earnings, ads or report outcomes.

To stop seeing ads, the user can disable the plugin with `/plugin`.
