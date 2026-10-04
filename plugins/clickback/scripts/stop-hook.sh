#!/bin/sh
# Clickback Stop hook: shows you one sponsored line after Claude finishes a turn.
#
# Privacy: of the hook input on stdin this reads only session_id and
# stop_hook_active. Your prompt, Claude's reply, the transcript path and your
# working directory never leave this machine.
#
# On success it prints {"systemMessage": "..."}, which Claude Code shows to you
# and never sends to Claude. Anything else (no token, no ad, a slow or broken
# server, a response it doesn't understand) prints nothing. It always exits 0,
# so it can never get in the way of the agent.
#
# Needs only sh and curl.

LC_ALL=C
export LC_ALL

# Skip unattended runs (claude -p in CI and scripts), where nobody sees the ad but
# the advertiser would still pay for it. Claude Code sets this to 0 there and 1
# in the interactive UI. It's undocumented, so this is best effort: unset or any
# other value carries on as normal.
[ "${CLAUDE_CODE_SESSION_ATTENDED-}" = 0 ] && exit 0

# userConfig values arrive as CLAUDE_PLUGIN_OPTION_<KEY>. Strip stray whitespace
# from a pasted token.
token=$(printf '%s' "${CLAUDE_PLUGIN_OPTION_API_TOKEN:-}" | tr -d '[:space:]')
base=${CLAUDE_PLUGIN_OPTION_BASE_URL:-https://clickback.dev}
base=${base%/}

# A Sanctum token is "<id>|<random>", maybe with a prefix. Anything else can't
# be ours, and this keeps quotes and backslashes out of the curl config below.
case $token in
    '' | *[!A-Za-z0-9._\|-]*) exit 0 ;;
esac

case $base in
    http://* | https://*) ;;
    *) exit 0 ;;
esac

command -v curl >/dev/null 2>&1 || exit 0

input=$(cat)

# Claude is already continuing because of a Stop hook. Don't show another ad.
if printf '%s\n' "$input" | grep -Eq '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
    exit 0
fi

# Every quote inside a JSON string is escaped, so this only matches the real
# top-level key. Session ids are UUIDs; anything unexpected is dropped.
session=$(printf '%s\n' "$input" \
    | sed -n 's/.*"session_id"[[:space:]]*:[[:space:]]*"\([A-Za-z0-9._-]\{1,255\}\)".*/\1/p' \
    | head -n 1)

# The token goes in through curl's config on stdin, so it never shows up in ps.
response=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -K - \
    --silent \
    --globoff \
    --max-time 2 \
    --request POST \
    --header 'Accept: application/json' \
    --data-urlencode 'surface=stop_hook' \
    --data-urlencode 'agent=claude-code' \
    --data-urlencode "session_id=$session" \
    --write-out '\n%{http_code}' \
    "$base/api/v1/ads/serve" 2>/dev/null) || exit 0

status=$(printf '%s\n' "$response" | tail -n 1)
[ "$status" = 200 ] || exit 0

# The serve response carries the finished line in "text", already JSON-escaped
# by the server. Take that string literal as it is (no decoding, so nothing to
# re-escape), then check it is a well-formed JSON string body: no bare quotes,
# no raw control characters, only valid escapes. That way the output below is
# always a single systemMessage and the server can't add other hook fields.
text=$(printf '%s\n' "$response" | sed '$d' \
    | sed -En 's/.*"text"[[:space:]]*:[[:space:]]*"(([^"\\]|\\.)*)".*/\1/p' \
    | head -n 1)

[ -n "$text" ] || exit 0

printf '%s\n' "$text" \
    | grep -Eq '^([^"\\[:cntrl:]]|\\["\\/bfnrt]|\\u[0-9A-Fa-f]{4})*$' \
    || exit 0

printf '{"systemMessage":"%s"}\n' "$text"
exit 0
