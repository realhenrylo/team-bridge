---
description: Agent Room — create | join <code> | leave | on | off | dnd | visible | invisible | status
argument-hint: create [--name x] | join <code> | leave | on | off | dnd | visible | invisible | status
allowed-tools: Bash(node *agent-room.cjs team*)
---

Run this command and show the user its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/agent-room.cjs" team $ARGUMENTS
```

The first invocation of this skill starts this session's team inbox monitor. It is off at session startup; after resuming a joined conversation, `/agent-room on` enables idle notifications. New/forked conversations must create or join a room explicitly.

Meaning:
- `create [--name x]` — open a new room on the hub and join this conversation to it; share the printed code
- `join <code>` — join this conversation to a room (saved in plugin data)
- `leave` — leave only this conversation’s room; keep its identity
- `on` — connected, messages are injected into this conversation
- `dnd` — still listed and still receiving, but nothing is injected until `on`
- `off` — disconnected from the room
- `visible` / `invisible` — whether this session appears in colleagues' lists
- `status` — show this conversation’s room, identity and switches
