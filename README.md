# team-bridge

Cross-machine messaging for teams using Claude Code and Codex. Sessions meet in **rooms**: anyone creates a room, gets a code like `4BCD-2QQF`, and colleagues join their conversations to it. Each room is one Cloudflare Durable Object — it hibernates for free between events and is destroyed after `ROOM_IDLE_DAYS` (default 7) without activity.

For Codex installation and usage, see [the Codex guide](docs/codex.md).

The full Claude plugin command is `/team-bridge:team`; `/team` below is shorthand. If Claude reports `/team` as unknown, use the full name, for example `/team-bridge:team on`.

```
packages/protocol/          shared wire protocol and validation
packages/hub/               Cloudflare room service (both hosts)
packages/bridge/            shared MCP, mailbox, room and identity logic
  src/hosts/                host-specific delivery adapters
plugins/
  claude/team-bridge/       Claude package: commands, MCP, hooks and monitor
  codex/team-bridge/        Codex package: skills, MCP launcher and hooks
.claude-plugin/             Claude marketplace catalog
.agents/plugins/           Codex marketplace catalog
scripts/                   build and release both self-contained packages
```

The two installation packages contain the same generated bridge bundle. Host
selection is explicit (`mcp` for Claude, `mcp --codex` for Codex); the Codex launcher
selects it automatically. The bridge builds once into `packages/bridge/dist/`,
then `scripts/package-plugins.mjs` copies it into both packages. Protocol and Hub
changes are shared, while host-specific lifecycle and notification behavior stays in the bridge adapter/package layers.

## Deploy the hub (once, you)

```sh
pnpm install
cd packages/hub
npx wrangler login
npx wrangler deploy                     # -> https://hub.agentroom.online
```

`ROOM_IDLE_DAYS` lives in `wrangler.jsonc` (`vars`). The custom domain is declared there too (`routes` with `custom_domain: true`); wrangler creates the DNS record and certificate on deploy. The `workers.dev` URL is disabled — it is blocked on some networks and the custom domain is not.

## Build the plugin

```sh
pnpm build                              # -> packages/bridge/dist/ + both plugin packages
```

## Distribute via GitHub

This repo *is* the marketplace (`.claude-plugin/marketplace.json` at the root points at `./plugins/claude/team-bridge`). Claude Code copies `plugins/claude/team-bridge/` into `~/.claude/plugins/cache/`, so the built bundle `plugins/claude/team-bridge/dist/team-bridge.cjs` is committed — never edit it by hand, run `scripts/release.sh <version>`.

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
scripts/release.sh 0.4.0     # build both packages + bump both plugin manifests
git add -A && git commit -m "release plugin 0.4.0" && git push
```

Because `plugin.json` declares a `version`, users only see an update when that string changes; `/plugin update team-bridge@team-bridge-marketplace` (or auto-update, once per session) installs it. The previous version's cache dir lingers ~14 days so sessions still running on it keep working; `${CLAUDE_PLUGIN_DATA}` is untouched by updates. CI (`.github/workflows/plugin-bundle.yml`) fails if the committed bundle doesn't match a fresh build.

Local development without installing: `claude --plugin-dir ./plugins/claude/team-bridge`. After `pnpm build`, `/reload-plugins` refreshes MCP servers and hooks; restart the Claude session to load changes to the monitor process.

## Per colleague

Installing the plugin asks for a display name (optional — defaults to your OS user name). The hub (`wss://hub.agentroom.online`) is built in; self-hosters override it with `TEAM_BRIDGE_HUB`. Then, inside `claude` in the repo:

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
- The plugin **monitor** is off at session startup. The first invocation of `/team` (including `/team on`, `join`, `create`, or `status`) starts it for that session. After resuming a joined conversation, run `/team on` to enable idle notifications. New conversations must join a room explicitly. Repeated `/team` invocations do not start additional monitors.
- Once started, the monitor (`team-bridge monitor`, see `plugins/claude/team-bridge/monitors/monitors.json`) long-polls the bridge and prints one line per incoming message. Claude Code delivers the notification to the session; Claude calls `team_read_messages` to read the complete messages and handle task requests. Hooks and this tool share one inbox, so a message read by either path is not returned again. A desktop notification is sent as well.
- Monitors, hooks, and session switches use the session's messaging socket identity or its parent process chain, never the closest start time in the same directory. A monitor stays alive while its bridge restarts. Cursor-based waits include existing unread mail and notify when DND is lifted.
- Room identity is persisted per Claude `session_id`. Exiting and resuming the same conversation, or restarting its MCP server, keeps its `ref`; a new or forked conversation gets a separate identity. The bridge waits for the session hook before registering. Identity records live in the plugin data directory and survive plugin updates. Room membership and switches are also saved per conversation. New/forked conversations start without a room.
- Task requests use the session's existing user instructions and tool permissions; the plugin does not add a second blanket confirmation step. Results or blockers are sent back to the original sender. A `delivered` receipt means the bridge received the message, not that Claude has started or finished the task.

Plugin monitors require a Claude Code host where Monitor is available. If no monitor is running, messages remain available to `team_read_messages` and the next hook; desktop notifications alone do not start a model turn.

`/team off` disconnects messaging and `/team dnd` pauses delivery. A monitor that has already started waits silently in those modes; it exits with the Claude session. The startup default controls the monitor, not the MCP connection to an already joined room.

### Delivery regression tests

Run `pnpm build` then `pnpm --filter @team-bridge/bridge test`. The tests use a local in-process WebSocket hub and separate host processes in one directory, covering exact binding, parent-chain fallback, startup backlog, DND resume, hook/tool consumption, and monitor recovery after an MCP restart. They do not call a model.

For the interactive acceptance check, start two Claude Code sessions with the local plugin in one test directory and join a test room. Let the receiver finish a turn. Ask the sender to delegate a small read-only review and return to idle. Without typing anything in the receiver, verify it reads the file and replies, and that the sender handles the reply automatically.

## Proxies

`*.workers.dev` is unreachable directly from some networks. The bridge honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` (and `NO_PROXY`) for both the room HTTP calls and the WebSocket, so if `curl` reaches the hub through your proxy, the plugin will too. `localhost` hubs always connect directly.

## Where things live

| What | Where |
|---|---|
| `credentials.json` (fallback), inbox spool | `${CLAUDE_PLUGIN_DATA}` = `~/.claude/plugins/data/<plugin-id>/` — survives updates, removed on uninstall |
| user name | plugin `userConfig` → `~/.claude/settings.json`, exported as `CLAUDE_PLUGIN_OPTION_*`; hub URL is built in (`DEFAULT_HUB`, override `TEAM_BRIDGE_HUB`) |
| unix sockets + meta | `os.tmpdir()/team-bridge-<uid>/` (short paths; per-process, ephemeral) |
| Conversation identity, room and switches | `<plugin-data>/conversations/<session-hash>.json`, keyed by host + conversation ID |
| the bundled CLI | `${CLAUDE_PLUGIN_ROOT}/dist/team-bridge.cjs` — read-only, replaced on update |

Each conversation owns its room membership. `leave` clears its room while retaining
its identity and switches. Working directories are display metadata only. Two
conversations in the same directory can join the same or different rooms independently.

## Switches

`/team on | off | dnd | visible | invisible | status` only affects the current conversation.
`/team create`, `/team join <code>` and `/team leave` also affect only that conversation.
There are no global overrides or project bindings. Resume restores the saved room, ref
and switches; the incoming notification listener still starts off.

Version 0.4.0 uses the conversation record exclusively. Earlier project/identity
configuration is not imported; join once again after upgrading.

## Room lifecycle

- `POST /rooms` creates one (8-char code, no ambiguous letters). The code is the only credential to join.
- Every message touches `lastActive`. The DO alarm ticks every minute while anyone is online; once empty it sleeps until `lastActive + ROOM_IDLE_DAYS`, then `deleteAll()` — the code returns 404 afterwards, and a bridge still pointing at it reports "room expired" in `team_status`.
