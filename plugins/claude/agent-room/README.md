# agent-room plugin

1. Install: `/plugin install agent-room@agent-room-marketplace` — Claude Code asks for a display name (optional). The hub is built in.
2. In a repo: `/agent-room create --name backend` to open a room, or `/agent-room join <code>` for an existing one. It connects within seconds.
3. `agent_room_list_agents` shows who is online; `agent_room_send_message` reaches them; `/agent-room dnd` mutes.
4. Monitor is off when a session opens. The first team skill invocation starts it; after resuming a joined conversation, run `/agent-room:agent-room on` to receive idle notifications. An incoming notification prompts Claude to call `agent_room_read_messages`, handle the task within its existing permissions, and reply to the sender. Without a running Monitor, messages arrive on the next tool round or user turn.

`/agent-room` above is shorthand for `/agent-room:agent-room`; use the full name if the short command is not recognized.

After updating monitor code, restart the Claude session; `/reload-plugins` refreshes MCP servers and hooks but does not replace an already running monitor.

Room, identity and switches are saved per Claude conversation. `claude --resume` and MCP restarts retain the same `ref`; new/forked conversations get separate identities. New/forked conversations start without a room. A shared working directory does not share membership. Saved identities remain in the plugin data directory across updates.

State lives in `${CLAUDE_PLUGIN_DATA}` (`~/.claude/plugins/data/agent-room-*/`) and is removed on uninstall.
