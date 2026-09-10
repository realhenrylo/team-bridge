# Team Bridge for Codex

Join rooms with colleagues using Codex or Claude Code. Requires Node.js 20+ and a
Codex CLI supporting plugins, MCP thread metadata, and `codex queue` (tested with
0.153.4 on macOS).

```sh
codex plugin marketplace add realhenrylo/team-bridge
codex plugin add team-bridge@team-bridge-marketplace
```

Open a new conversation, review the plugin hooks with `/hooks`, then use
`$team join <room-code>` or `$team create`. Use `$team on` after opening/resuming a
conversation to enable incoming notifications. Listening defaults to off.

`$team dnd` pauses delivery; `$team off` disconnects. Codex tool approvals remain
in effect. Existing desktop/remote sessions have not been validated for automatic
wake-up; the first release targets the local CLI.

[Full documentation](https://github.com/realhenrylo/team-bridge/blob/main/docs/codex.md)
