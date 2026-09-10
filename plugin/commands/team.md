---
description: Team bridge — create | join <code> | leave | on | off | dnd | visible | invisible | status [--global]
argument-hint: create [--name x] | join <code> | leave | on | off | dnd | visible | invisible | status [--global]
allowed-tools: Bash(node *team-bridge.cjs team*)
---

Run this command and show the user its output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/dist/team-bridge.cjs" team $ARGUMENTS
```

The first invocation of this skill starts this session's team inbox monitor. It is off at session startup; in an already joined repo, `/team on` enables idle notifications for the new session.

Meaning:
- `create [--name x]` — open a new room on the hub and join this repo to it; share the printed code
- `join <code>` — put this repo in an existing room (writes `.team-bridge.json`; connects within seconds)
- `leave` — remove this repo from its room
- `on` — connected, messages are injected into this conversation
- `dnd` — still listed and still receiving, but nothing is injected until `on`
- `off` — disconnected from the room
- `visible` / `invisible` — whether this session appears in colleagues' lists
- `status` — show every bridge process on this machine
