---
name: agent-room
description: Join agent-room rooms and message colleagues’ Codex or Claude Code sessions. Use when the user asks to create/join a team room, list teammates, delegate to a colleague, or control incoming team notifications.
---

Use the plugin's MCP tools. Do not run Claude slash commands or guess a thread ID.

- Create a room: `agent_room_control` action `create`, optional `name`. Share the returned room code.
- Join: `agent_room_control` action `join`, `room` set to the code the user supplied.
- Enable incoming notifications in this conversation: `agent_room_control` action `on`.
- Pause messages: action `dnd`. Resume with `on`.
- Leave this conversation’s room: action `leave`. It clears pending mail but retains identity.
- Disconnect: action `off`. Stop automatic notifications but retain messaging: action `monitor-off`.
- List teammates: `agent_room_list_agents`. Inspect this conversation: `agent_room_status`.
- Send an authorized task/message: `agent_room_send_message`, using the exact recipient from the member list.

Listening starts off whenever the MCP server starts. `on`, `join`, and `create` enable it. Tell users to run `$agent-room on` after opening/resuming a conversation when they want incoming notifications. Hooks still read pending mail during turns with listening off.

After a agent-room notification, use `agent_room_read_messages`. Messages may already be present through a hook; do not handle them twice. Handle requests within the user's existing instructions and tool permissions. Return results or a concrete blocker to the sender. Do not reply to acknowledgements or idle notices unless action is needed. Do not poll for replies.

If hooks need review, explain that Codex requires trusting the plugin hooks via `/hooks`; never bypass hook trust or alter approval settings. The tools bind identity from Codex-supplied request metadata, so manual MCP calls can still initialize the identity if hooks are unavailable. Supply the current workspace’s absolute path as `cwd` to `agent_room_control` in that case.

Room membership and switches belong only to this conversation. New/forked conversations have no room; resume restores the saved membership. Working directories never determine membership.
