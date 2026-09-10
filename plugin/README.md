# team-bridge plugin

1. Install: `/plugin install team-bridge@team-bridge-marketplace` — Claude Code asks for a display name (optional). The hub is built in.
2. In a repo: `/team create --name backend` to open a room, or `/team join <code>` for an existing one. It connects within seconds.
3. `team_list_agents` shows who is online; `team_send_message` reaches them; `/team dnd` mutes.
4. Monitor is off when a session opens. The first team skill invocation starts it; in an already joined repo, run `/team-bridge:team on` in each new session to receive idle notifications. An incoming notification prompts Claude to call `team_read_messages`, handle the task within its existing permissions, and reply to the sender. Without a running Monitor, messages arrive on the next tool round or user turn.

`/team` above is shorthand for `/team-bridge:team`; use the full name if the short command is not recognized.

After updating monitor code, restart the Claude session; `/reload-plugins` refreshes MCP servers and hooks but does not replace an already running monitor.

State lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/team-bridge-*/`) and is removed on uninstall.
