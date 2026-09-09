# team-bridge plugin

1. Install: `/plugin install team-bridge@team-bridge-marketplace` — Claude Code asks for a display name (optional). The hub is built in.
2. In a repo: `/team create --name backend` to open a room, or `/team join <code>` for an existing one. It connects within seconds.
3. `team_list_agents` shows who is online; `team_send_message` reaches them; `/team dnd` mutes.

State lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/team-bridge-*/`) and is removed on uninstall.
