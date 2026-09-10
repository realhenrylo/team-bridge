# 空闲会话投递验收

2026-09-10，macOS，Claude Code 2.1.267。

## 已实现

- Monitor、Hook 和 `/team` 会话开关按宿主会话地址或父进程链绑定，移除同目录启动时间猜测。
- Monitor 在启动后补报积压消息；解除 DND 时唤醒等待；MCP 进程重启后重新绑定。
- 新增 `team_read_messages`，与 Hook 共用收件箱，避免重复读取。
- 移除消息模板中一律要求再次确认的额外限制，继续遵守会话原有用户指令和工具权限。未新增权限系统。
- 发送结果明确区分 bridge 收到消息与 Claude 实际执行。

## 真实交互验收

启动本地 Cloudflare Hub，在同一个测试目录运行两个独立的 Claude Code 交互会话。两者加载当前插件的 Hook 和 Monitor；为隔离其他 MCP 配置，测试通过显式 MCP 配置加载同一个构建产物。

接收方预先允许只读审查及向派单方回报，完成初始化后进入 idle。测试文件是一个三行函数，`add(a, b)` 错误地返回 `a - b`。

时间为 UTC：

| 时间 | 事件 |
| --- | --- |
| 02:08:04.388 | 发送方调用 `team_send_message`，要求只读审查并回报 `REVIEW_DONE_910` |
| 02:08:04.708 | 空闲接收方收到 Monitor 事件，开始新一轮处理 |
| 02:08:06.528 | 发送方结束派单回合 |
| 02:08:08.510 | 接收方读取测试文件；完整消息通过 Hook 注入 |
| 02:08:17.042 | 接收方调用 `team_send_message` 回报运算符错误 |
| 02:08:17.372 | 发送方收到回复的 Monitor 事件 |
| 02:08:21.742 | 发送方自动展示审查结果 |

派单后没有向接收方输入任何内容，发送方也没有额外人工输入以读取回复。测试文件没有修改。

## 自动化检查

- `pnpm typecheck`
- `pnpm build`
- `pnpm --filter @team-bridge/bridge test`
- 本地 Hub smoke 测试
- `git diff --check`

回归测试分别覆盖会话地址和父进程链两种绑定方式：同目录隔离、SessionStart 早于 MCP、启动积压、长轮询、DND 恢复、Hook/工具共享消费、MCP 重启重连，以及旧 Monitor 在插件重载后不会对同一条未读消息循环输出。

尚未实现已投递至 MCP 的未读消息跨进程恢复、持久任务回执或 Channels 适配器。Monitor 仍依赖宿主对该功能的支持。部署新版后需重启 Claude 会话，才能替换已运行的 Monitor。

## 0.2.6 按需启动验收

在同一版本 Claude Code 的真实交互会话验证：进入会话后没有 Monitor；调用 `/team-bridge:team on` 后出现一个 Monitor。触发条件使用完整技能名 `on-skill-invoke:team-bridge:team`，仅写 `team` 无法触发。已有房间中的新会话也需主动调用一次技能来启用空闲唤醒。

## 0.2.7 会话身份验收

身份改为按 Claude `session_id` 持久化到插件数据目录。Hook 在 MCP 启动前后均可交接会话 ID；尚未拿到会话 ID 时不向房间注册临时身份。MCP 重启和退出后 resume 复用同一 ref，新会话及 fork 使用独立身份。从旧版升级会生成一次新身份。

真实 Claude Code 2.1.267 交互测试：会话 `7d99436c-2692-4842-83a4-a68a0d27e599` 首次连接后执行 `/exit`，再以 `claude --resume` 恢复。MCP PID 从 `91181` 变为 `92144`，名字均为 `resume-test-workspace-f39a`，ref 均为 `f39a44`，恢复后自动连接成功。测试使用本地 Cloudflare Hub。

自动回归同时覆盖宿主地址和父进程链路径：MCP 重启、整个宿主退出后恢复、恢复 DND 设置、发给旧 ref 的离线消息、新会话隔离以及 Hook/MCP 两种启动顺序。本地 Hub smoke 额外验证实际 Hub 在重连后保留名字并投递离线消息。

## 0.3.0 Codex 验收

Codex CLI 0.153.4，macOS，本地 Cloudflare Hub，独立临时 `CODEX_HOME`。

- 安装真实 Codex marketplace/package，而非只手动注册 MCP。安装包须以 `cwd: "."` 启动相对 launcher；业务 workspace 由 Hook 显式传入，不能用安装缓存目录。
- 实际 MCP 请求包含 `_meta.threadId`；代码不从模型参数或同目录进程猜测身份。
- 初始 `listening: false`；`team_control on` 后为 true。
- 发送端测试客户端使用与 Claude 相同的 Hub 协议，向空闲 Codex 发只读审查请求。Codex 被队列通知唤醒，读取 `arithmetic.js`，找出 `a - b` 应为 `a + b`，并通过 `team_send_message` 返回 `CODEX_REVIEW_DONE`。首次读消息和发消息走了 Codex 自身审批，插件没有绕过审批。
- 实际 `codex resume 01a089fd-ca2e-7290-8621-8d8e7b3e01ed` 后，首个用户回合重新绑定。MCP PID 从 `3628` 变为 `5383`，名字保持 `henrylo-work-3ea6`，ref 保持 `3ea6f2`，监听恢复默认关闭。未声称打开 resume UI 的瞬间一定完成绑定。
- 自动测试覆盖缺失 metadata 时拒绝猜测、线程隔离、同连接拒绝跨线程绑定、开启前积压、通知不包含远程消息正文、DND、关闭监听后的 Hook 消费、重启保留 ref/off 设置、fork 身份分离、通知失败可见且不丢收件箱。

桌面端和远程 App Server 的自动唤醒尚未验收；首版支持本地 CLI。原有两条 Claude 自动回归继续通过。

恢复后的第二轮测试在隔离配置中预先允许相关 MCP 工具：06:56:30.085 UTC 投递，06:56:41.906 UTC 收到审查回复，期间没有向接收方键入内容。该结果验证获准工具下的自动闭环，并不取消默认审批要求。


## 0.4.0 conversation membership regression

Room membership, identity and switches now use one record per host conversation.
The local automated suites exercise real Claude CLI/IPC and Codex MCP control
paths with two host processes in the same directory. Verified: new sessions do
not autojoin; both can join one room; changing/leaving A does not change B;
resume restores room/ref/switches; forks start without membership; changing cwd
does not change membership; switching rooms clears pending mail; failed joins
retain the previous room; concurrent join/leave requests commit in order.
The suite continues to cover idle notifications, DND and MCP restart recovery.
These checks use a local test Hub and a fake Codex queue executable; they do not
claim a new interactive model acceptance run for this version.
