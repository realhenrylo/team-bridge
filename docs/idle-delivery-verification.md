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

本次未实现跨进程重启的未读消息恢复、持久任务回执或 Channels 适配器。Monitor 仍依赖宿主对该功能的支持。部署新版后需重启 Claude 会话，才能替换已运行的 Monitor。

## 0.2.6 按需启动验收

在同一版本 Claude Code 的真实交互会话验证：进入会话后没有 Monitor；调用 `/team-bridge:team on` 后出现一个 Monitor。触发条件使用完整技能名 `on-skill-invoke:team-bridge:team`，仅写 `team` 无法触发。已有房间中的新会话也需主动调用一次技能来启用空闲唤醒。
