#!/usr/bin/env bash
#
# install-mcp.sh — register this pg-connection-pool gateway as a Claude Code MCP
# server so any project can use it immediately.
#
# There is ONE shared install (this directory, holding the single .env with DB creds
# + MCP_TOKEN). "Installing" a project just registers a pointer to it — never a copy,
# so credentials never fork.
#
#   ./install-mcp.sh                 register at USER scope → available in EVERY project
#   ./install-mcp.sh --project       write ./.mcp.json in the current dir (committable)
#   ./install-mcp.sh --project DIR   write DIR/.mcp.json
#   ./install-mcp.sh --local         register privately for the current project only
#   ./install-mcp.sh --name NAME     server name in the config (default: pg-connection-pool)
#   ./install-mcp.sh --print         print the JSON block only; register nothing
#   ./install-mcp.sh --link          symlink this script into ~/.local/bin so it is on PATH
#   ./install-mcp.sh --help
#
set -euo pipefail

# ── self-locate (symlink-safe) so a PATH symlink still resolves the real gateway dir ──
SOURCE="${BASH_SOURCE[0]}"
while [ -h "$SOURCE" ]; do
    DIR="$(cd -P "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ $SOURCE != /* ]] && SOURCE="$DIR/$SOURCE"
done
ROOT="$(cd -P "$(dirname "$SOURCE")" && pwd)"

NAME="pg-connection-pool"
SCOPE="user"       # user | local | project
PROJECT_DIR=""     # target dir for --project (default: cwd)
PRINT_ONLY=false
DO_LINK=false

err()  { printf '\033[31m✗ %s\033[0m\n' "$*" >&2; }
info() { printf '\033[36m→ %s\033[0m\n' "$*" >&2; }
ok()   { printf '\033[32m✓ %s\033[0m\n' "$*" >&2; }
warn() { printf '\033[33m! %s\033[0m\n' "$*" >&2; }

# print the header comment block (from line 3 to just before `set -euo`), stripping "# "
usage() { sed -n '3,/^set -euo/p' "$0" | sed '/^#/!d; s/^# \{0,1\}//'; }

# ── args ──
while [ $# -gt 0 ]; do
    case "$1" in
        --user)    SCOPE="user"; shift ;;
        --local)   SCOPE="local"; shift ;;
        --project) SCOPE="project"; shift
                   # optional directory argument (anything not starting with '-')
                   if [ $# -gt 0 ] && [[ $1 != -* ]]; then PROJECT_DIR="$1"; shift; fi ;;
        --name)    NAME="${2:?--name needs a value}"; shift 2 ;;
        --print)   PRINT_ONLY=true; shift ;;
        --link)    DO_LINK=true; shift ;;
        -h|--help) usage; exit 0 ;;
        *)         err "unknown option: $1"; usage; exit 2 ;;
    esac
done

# ── build the server entry (absolute path → works from any project) ──
ENTRY="$ROOT/dist/mcp/mcp-server.js"
server_json() {
    jq -n \
        --arg env "--env-file-if-exists=$ROOT/.env" \
        --arg entry "$ENTRY" \
        '{type:"stdio", command:"node", args:[$env, $entry]}'
}

if $PRINT_ONLY; then
    server_json
    exit 0
fi

# ── prerequisites ──
command -v node >/dev/null 2>&1 || { err "node not found on PATH"; exit 1; }
command -v jq   >/dev/null 2>&1 || { err "jq not found on PATH";   exit 1; }
command -v claude >/dev/null 2>&1 || { err "claude CLI not found on PATH"; exit 1; }

# ── ensure the gateway is built (idempotent: only does work when missing) ──
if [ ! -d "$ROOT/node_modules" ]; then
    info "installing dependencies (npm ci)…"
    ( cd "$ROOT" && npm ci )
fi
if [ ! -f "$ENTRY" ]; then
    info "building gateway (npm run build)…"
    ( cd "$ROOT" && npm run build )
fi
[ -f "$ENTRY" ] || { err "build did not produce $ENTRY"; exit 1; }

# ── ensure a usable .env — a broken registration is worse than a loud error ──
if [ ! -f "$ROOT/.env" ]; then
    cp "$ROOT/.env.example" "$ROOT/.env"
    err "no .env found — created one from .env.example."
    err "Fill DB credentials and set MCP_TOKEN (README → Configuration), then re-run."
    exit 1
fi
if ! grep -q '^MCP_TOKEN=' "$ROOT/.env"; then
    err ".env has no MCP_TOKEN — the MCP process needs it to pick an identity. Set it, then re-run."
    exit 1
fi
if grep -qE 'change-me' "$ROOT/.env"; then
    warn ".env still contains 'change-me' placeholders — the gateway may fail its boot ping."
fi

# ── optional: put this script on PATH for future one-liner installs ──
if $DO_LINK; then
    mkdir -p "$HOME/.local/bin"
    ln -sf "$SOURCE" "$HOME/.local/bin/pgcp-mcp-install"
    ok "linked → ~/.local/bin/pgcp-mcp-install (run 'pgcp-mcp-install' from anywhere)"
fi

# ── register (idempotent: remove-then-add so re-runs update cleanly) ──
JSON="$(server_json)"
register() {
    claude mcp remove "$NAME" --scope "$SCOPE" >/dev/null 2>&1 || true
    claude mcp add-json "$NAME" "$JSON" --scope "$SCOPE"
}

case "$SCOPE" in
    project)
        TARGET="${PROJECT_DIR:-$PWD}"
        [ -d "$TARGET" ] || { err "target dir does not exist: $TARGET"; exit 1; }
        # project scope writes <cwd>/.mcp.json, so run from the target dir
        ( cd "$TARGET" && register )
        ok "registered '$NAME' → $TARGET/.mcp.json (project scope — commit it to share)"
        ;;
    local)
        register
        ok "registered '$NAME' for this project only (local scope)"
        ;;
    user)
        register
        ok "registered '$NAME' at user scope — available in EVERY project"
        ;;
esac

info "verify with:  claude mcp get $NAME"
info "in a Claude Code session, run /mcp to (re)connect."
