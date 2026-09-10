# team-bridge

Cross-machine `ListAgents` / `SendMessage` for a team of Claude Code users. Sessions meet in **rooms**: anyone creates a room, gets a code like `4BCD-2QQF`, and colleagues join their repos to it. Each room is one Cloudflare Durable Object — it hibernates for free between events and is destroyed after `ROOM_IDLE_DAYS` (default 7) without activity.

```
packages/protocol   zod schemas shared by hub and client
packages/hub        Cloudflare Worker + TeamRoom Durable Object (registry, routing, offline inbox)
packages/bridge     CLI bundled into plugin/dist: `mcp` (tools + WebSocket), `hook` (Claude Code hooks), `team` (/team switches), `configure`
plugin/             Claude Code plugin: .mcp.json, hooks, /team command
```

## Deploy the hub (once, you)

```sh
pnpm install
cd packages/hub
npx wrangler login
npx wrangler secret put CREATE_TOKEN    # optional: gate room creation (joining only needs the code)
npx wrangler deploy                     # -> https://hub.agentroom.online
```

`ROOM_IDLE_DAYS` lives in `wrangler.jsonc` (`vars`). The custom domain is declared there too (`routes` with `custom_domain: true`); wrangler creates the DNS record and certificate on deploy. The `workers.dev` URL is disabled — it is blocked on some networks and the custom domain is not.

## Build the plugin

```sh
pnpm build                              # -> plugin/dist/team-bridge.cjs
```

## Distribute via GitHub

This repo *is* the marketplace (`.claude-plugin/marketplace.json` at the root points at `./plugin`). Claude Code copies `plugin/` into `~/.claude/plugins/cache/`, so the built bundle `plugin/dist/team-bridge.cjs` is committed — never edit it by hand, run `scripts/release.sh <version>`.

```sh
git init && git add -A && git commit -m "team-bridge"
gh repo create realhenrylo/team-bridge --private --source . --push
```

Colleagues (private repo works as long as `gh auth login` or SSH is set up):

```
/plugin marketplace add realhenrylo/team-bridge
/plugin install team-bridge@team-bridge-marketplace
```

Or make it automatic for a project: add to that repo's `.claude/settings.json` and everyone who trusts the folder gets it:

```json
{
  "extraKnownMarketplaces": {
    "team-bridge-marketplace": { "source": { "source": "github", "repo": "realhenrylo/team-bridge" } }
  },
  "enabledPlugins": { "team-bridge@team-bridge-marketplace": true }
}
```

## Release an update

```sh
scripts/release.sh 0.3.0     # pnpm build + bump plugin/.claude-plugin/plugin.json
git add -A && git commit -m "release plugin 0.3.0" && git push
```

Because `plugin.json` declares a `version`, users only see an update when that string changes; `/plugin update team-bridge@team-bridge-marketplace` (or auto-update, once per session) installs it. The previous version's cache dir lingers ~14 days so sessions still running on it keep working; `${CLAUDE_PLUGIN_DATA}` is untouched by updates. CI (`.github/workflows/plugin-bundle.yml`) fails if the committed bundle doesn't match a fresh build.

Local development without installing: `claude --plugin-dir ./plugin`. After `pnpm build`, `/reload-plugins` refreshes MCP servers and hooks; restart the Claude session to load changes to the monitor process.

## Per colleague

Installing the plugin asks for a display name (optional — defaults to your OS user name) and an optional room-creation token. The hub (`wss://hub.agentroom.online`) is built in; self-hosters override it with `TEAM_BRIDGE_HUB`. Then, inside `claude` in the repo:

```
/team create --name backend   # open a room and join this repo to it; share the code
/team join 4BCD-2QQF          # or join an existing one; connects within seconds
/team status
```

## Local smoke test (two terminals, one machine)

```sh
pnpm hub:dev -- --port 8799
S=/tmp/tb-smoke pnpm --filter @team-bridge/bridge smoke   # creates a room, joins two dirs, exercises everything
```

The smoke test sets `CLAUDE_PLUGIN_DATA` / `CLAUDE_PLUGIN_OPTION_*` itself; `HUB=default` runs it against the built-in hub. To drive the CLI by hand outside Claude, `team-bridge configure --user ...` writes a fallback `credentials.json` (there is no login — rooms are the only credential).

Set `ROOM_IDLE_DAYS=0.0001` in `packages/hub/.dev.vars` and run with `EXPIRY=1` to also watch the empty room get destroyed (~1 min).

## How delivery works

- Sender's MCP process -> WebSocket -> TeamRoom DO -> recipient's MCP process (or SQLite queue if offline).
- Recipient's MCP process spools the message; the next hook (`PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`) drains it via a local unix socket and injects it as `<team-message>` context. Hooks never touch the network.
- `Stop` with unread mail returns `decision: block` so Claude handles it before going idle.
- A plugin **monitor** (`team-bridge monitor`, see `plugin/monitors/monitors.json`) long-polls the bridge and prints one line per incoming message. Claude Code delivers the notification to the session; Claude calls `team_read_messages` to read the complete messages and handle task requests. Hooks and this tool share one inbox, so a message read by either path is not returned again. A desktop notification is sent as well.
- Monitors, hooks, and session switches use the session's messaging socket identity or its parent process chain, never the closest start time in the same directory. A monitor stays alive while its bridge restarts. Cursor-based waits include existing unread mail and notify when DND is lifted.
- Task requests use the session's existing user instructions and tool permissions; the plugin does not add a second blanket confirmation step. Results or blockers are sent back to the original sender. A `delivered` receipt means the bridge received the message, not that Claude has started or finished the task.

Plugin monitors require a Claude Code host where Monitor is available. If no monitor is running, messages remain available to `team_read_messages` and the next hook; desktop notifications alone do not start a model turn.

### Delivery regression tests

Run `pnpm build` then `pnpm --filter @team-bridge/bridge test`. The tests use a local in-process WebSocket hub and separate host processes in one directory, covering exact binding, parent-chain fallback, startup backlog, DND resume, hook/tool consumption, and monitor recovery after an MCP restart. They do not call a model.

For the interactive acceptance check, start two Claude Code sessions with the local plugin in one test directory and join a test room. Let the receiver finish a turn. Ask the sender to delegate a small read-only review and return to idle. Without typing anything in the receiver, verify it reads the file and replies, and that the sender handles the reply automatically.

## Proxies

`*.workers.dev` is unreachable directly from some networks. The bridge honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (and `NO_PROXY`) for both the room HTTP calls and the WebSocket, so if `curl` reaches the hub through your proxy, the plugin will too. `localhost` hubs always connect directly.

## Where things live

| What | Where |
|---|---|
| `state.json` (switches), `credentials.json` (fallback), inbox spool | `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<plugin-id>/` — survives updates, removed on uninstall |
| user name, create token | plugin `userConfig` → `~/.claude/settings.json` / Keychain, exported as `CLAUDE_PLUGIN_OPTION_*`; hub URL is built in (`DEFAULT_HUB`, override `TEAM_BRIDGE_HUB`) |
| unix sockets + meta | `os.tmpdir()/team-bridge-<uid>/` (short paths; per-process, ephemeral) |
| `.team-bridge.json` (room code) | repo root, committed or not as the team prefers |
| the bundled CLI | `${CLAUDE_PLUGIN_ROOT}/dist/team-bridge.cjs` — read-only, replaced on update |

## Switches

`/team on | off | dnd | visible | invisible | status [--global]` — stored in `~/.team-bridge/state.json` (global) with per-session overrides. `/team create` / `/team join <code>` / `/team leave` manage the repo's `.team-bridge.json`.

## Room lifecycle

- `POST /rooms` creates one (8-char code, no ambiguous letters). The code is the only credential to join.
- Every message touches `lastActive`. The DO alarm ticks every minute while anyone is online; once empty it sleeps until `lastActive + ROOM_IDLE_DAYS`, then `deleteAll()` — the code returns 404 afterwards, and a bridge still pointing at it reports "room expired" in `team_status`.
