#!/bin/sh
# PermissionRequest hook for serve_ad, the tool the Clickback mod fetches ads with.
#
# The mod's own call to serve_ad goes through Claude Code's permission check like
# any tool call, and a mod can't answer that check for its own call. Without this
# hook you would be asked about a request you never made, after every turn.
#
# It allows only a call that carries this session's own id, made on the main
# thread, which is what the mod sends. Claude's calls to serve_ad never get this
# far: the mod refuses them before the permission check. If the mod isn't running
# (mods turned off, an older Claude Code), Claude doesn't know the session id, so
# a call from Claude still gets the usual question.
#
# Reads only session_id and agent_id from the hook input. Prints the allow
# decision or nothing, and always exits 0.

LC_ALL=C
export LC_ALL

input=$(cat)

# A subagent's call gets the usual question.
if printf '%s\n' "$input" | grep -Eq '"agent_id"[[:space:]]*:'; then
    exit 0
fi

# Every quote inside a JSON string is escaped, so this only matches real keys:
# the hook's own session_id and the one in tool_input. There must be exactly
# those two, and they must be the same.
ids=$(printf '%s\n' "$input" \
    | grep -Eo '"session_id"[[:space:]]*:[[:space:]]*"[A-Za-z0-9._-]{1,255}"' \
    | sed -E 's/.*"([^"]*)"$/\1/')

[ "$(printf '%s\n' "$ids" | grep -c .)" = 2 ] || exit 0
[ "$(printf '%s\n' "$ids" | sort -u | grep -c .)" = 1 ] || exit 0

printf '%s\n' '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
