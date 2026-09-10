# Codex plugin

The Codex package lives in `plugins/codex/team-bridge/`. It shares the Hub, protocol,
mailbox, room configuration and messaging tools with the Claude package in
`plugins/claude/team-bridge/`. The Hub needs no new deployment for mixed rooms.

## Install

Requirements: Node.js 20+, Codex CLI with `codex queue`, plugin support, and MCP
`_meta.threadId`. Tested with Codex CLI 0.153.4 on macOS. Linux uses the same
Unix-socket implementation; Windows and desktop-only installations are not yet
validated. The `codex` executable must be on the MCP process's PATH and use the
same `CODEX_HOME` as the target conversation.

Run in a terminal:

```sh
codex plugin marketplace add realhenrylo/team-bridge
codex plugin add team-bridge@team-bridge-marketplace
```

Start a new Codex conversation in your project. Use `/hooks` to review and trust
the team-bridge lifecycle hooks. Installation does not grant hook trust or tool
approval. Then ask:

```text
$team join YOUR-ROOM-CODE
```

To create a room, use `$team create`; a room-creation token is only needed if your
Hub requires it. The default Hub is `wss://hub.agentroom.online`. Anyone using the
Claude plugin can join the same room code.

Incoming notifications start **off** whenever the MCP process starts. `$team on`,
`$team join ...`, and `$team create` enable them for this running conversation.
`$team dnd` pauses delivery; `$team off` disconnects; `$team monitor-off` disables
automatic notifications while retaining the connection. Trusted hooks can still
read mail during a user/tool turn when automatic listening is off.

Tool execution remains subject to Codex's existing approval policy. Receiving a
message does not grant permission to run a tool. A delivered receipt means the
bridge received the message, not that the task completed.

## Identity and storage

Each conversation has one private record at
`<plugin-data>/conversations/<session-hash>.json`, containing its identity, room
and switches. The key is the host plus conversation ID; the project path is only
display metadata. Two conversations in one directory can join different rooms.
`$team leave` clears only the current conversation's room and pending mail,
retaining its identity. Resume restores the room and switches; new/forked
conversations start without a room. No project configuration is read or written.

The MCP request's host-supplied `_meta.threadId` selects the identity. It is not
accepted as a model-controlled tool argument. Record keys are namespaced with `codex:` or `claude:` so the two hosts
cannot share a record by ID collision. New/forked threads get separate identities; resume restores the ref when the first lifecycle hook or MCP request binds the conversation.

The MCP launcher starts from the installed plugin root. Lifecycle hooks supply
the actual project cwd; the bridge never treats its plugin directory as the
user's workspace. Without trusted hooks, `team_control` accepts an explicit
absolute `cwd`; identity and room membership always come from request metadata, even without cwd.

Data uses `TEAM_BRIDGE_HOME`, then `PLUGIN_DATA` if supplied by the host, otherwise
`$CODEX_HOME/team-bridge` (`~/.codex/team-bridge` by default). The fallback survives
plugin updates and removal. `TEAM_BRIDGE_HUB` supports self-hosting. To configure
a display name or creation token, run the installed `dist/team-bridge.cjs configure`
command with `TEAM_BRIDGE_HOME` pointing to the same data directory. Tokens should
be configured locally rather than sent in a conversation.

## Delivery

A small listener inside the MCP process calls `codex queue --thread <id>` with a
fixed notification. Colleague message contents remain in the mailbox and arrive
through the MCP read tool or trusted lifecycle hook; they are not placed in the
queued user prompt. The listener coalesces pending messages, advances its cursor
only after successful queueing, and retries failures with backoff. `team_status`
shows listening state and the latest notification error.

The queue path has been verified against a local Codex CLI session. It is not a
claim that any arbitrary desktop or remote App Server can be woken by the local
CLI. These hosts need an explicitly selected connection adapter and separate
acceptance testing. No additional permission system is implemented here.

Unread mail already received by a terminated MCP process is not durable yet.
The Hub can queue messages sent while a known identity is offline.

## Development

```sh
pnpm build
pnpm typecheck
pnpm --filter @team-bridge/bridge test
codex plugin marketplace add /absolute/path/to/team-bridge
codex plugin add team-bridge@team-bridge-marketplace
```

Use an isolated `CODEX_HOME` for integration tests. The suite uses a fake `codex`
executable for deterministic queue assertions, so it cannot send test messages to
real conversations. It also reruns both Claude delivery scenarios.

For local plugin iterations, bump the Codex manifest cachebuster and reinstall;
new conversations load the installed copy. Both packages contain the same generated
bundle, copied by `scripts/package-plugins.mjs`; CI checks both copies.
