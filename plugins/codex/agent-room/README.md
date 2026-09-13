# Agent Room for Codex

Join rooms with colleagues using Codex or Claude Code. Requires Node.js 20+ and a
Codex CLI supporting plugins, MCP thread metadata, and `codex queue` (tested with
0.153.4 on macOS).

```sh
codex plugin marketplace add realhenrylo/agent-room
codex plugin add agent-room@agent-room-marketplace
```

Open a new conversation, review the plugin hooks with `/hooks`, then use
`$agent-room join <room-code>` or `$agent-room create`. Use `$agent-room on` after opening/resuming a
conversation to enable incoming notifications. Listening defaults to off.

`$agent-room dnd` pauses delivery; `$agent-room off` disconnects. Codex tool approvals remain
in effect. Existing desktop/remote sessions have not been validated for automatic
wake-up; the first release targets the local CLI.

[Full documentation](https://github.com/realhenrylo/agent-room/blob/main/docs/codex.md)

Room, identity and switches belong to the conversation, not its project directory.
New/forked conversations must join explicitly; resume restores membership.
`$agent-room leave` leaves only this conversation’s room.
