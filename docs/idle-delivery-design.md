# 空闲会话接任务设计草案

核实日期：2026-09-10。本机 Claude Code：2.1.267。
本文件是建议方案，尚未实现或验证端到端唤醒。

## 目标

接收方已加入房间并开启协作时，任务抵达后无需再输入一句话，即可开始处理授权范围内的工作并回报结果。发送方能够区分消息送达、任务开始、等待确认和任务完成。

## 已确认的接口与当前缺口

- 官方插件 Monitor 会把 stdout 行交给 Claude 响应；不能仅凭截图认定它只显示通知。它有交互 CLI、提供商和环境变量方面的可用性限制。[Monitor](https://code.claude.com/docs/en/tools-reference#monitor-tool)、[插件声明](https://code.claude.com/docs/en/plugins-reference#monitors)
- 官方 Channels 支持向现有会话推送事件；忙时排队。通知写入 transport 不代表 Claude 已处理，未启用的 channel 事件甚至会被静默丢弃。[Channels 协议](https://code.claude.com/docs/en/channels-reference)
- 原生跨会话消息明确支持空闲时启动新回合；官方公开了每会话的 `CLAUDE_CODE_MESSAGING_SOCKET`，但其完整消息线协议仍需核实，不能自行猜测 payload。[原生消息](https://code.claude.com/docs/en/cross-session-messaging)
- 当前 `monitor.ts` 按 cwd 和启动时间猜测 bridge，无法可靠区分同目录双会话；临时 IPC 故障可能让 monitor 退出。
- 当前 `wait` 只订阅未来到达的消息，已有未读消息及 DND 解除后的积压可能不产生通知。
- 当前 `drain` 在 hook 输出被宿主处理前就清空消息；spool 按进程 PID 保存，缺少启动恢复和业务确认。
- 当前 `inbox.ts` 要求任何命令及外部操作都先确认，不能表达用户已授权的持续协作。
- 当前 smoke 测试启动 bridge/monitor 并手动调用 hook，不能证明真实 Claude Code 空闲会话已被唤醒。

## 投递层

保留 hub 的跨机器路由，在接收端抽象 `DeliveryAdapter`：

1. `monitor`：先修复现有实现，作为当前版本的兼容路径。
2. `channel`：显式启用后，通过现有 MCP 进程发出 `notifications/claude/channel`；声明 `experimental['claude/channel']` capability。
3. 原生 socket：仅作为后续候选，确认消息格式、权限语义和端到端行为后再接入。

一个会话同一时刻只启用一个主动投递适配器。Hook 可以作为恢复路径，但必须与适配器共用消息领取与确认状态，不能各自独立消费。

Channels 自定义插件目前需要开发启动参数或组织 allowlist，并受组织策略及认证方式限制。安装 MCP 插件不等于启用 Channel。状态应区分 configured、probe-pending、verified、unavailable；发送一次应用级探测并收到确认才能标记 verified。探测超时仅表示未验证，不能直接判定功能不支持。[启用条件](https://code.claude.com/docs/en/channels)

## 身份与监听

- 使用精确的会话标识与 bridge 实例标识建立绑定。只有能证明属于同一宿主会话才允许绑定；有歧义时报告 unbound，禁止选择最近的同目录进程。
- 具体绑定机制先做小实验：核实 MCP 与 monitor 可获得的环境变量或宿主进程身份，再由带 `session_id` 的 hook 完成握手。不能假定所有子进程都继承同一套变量。
- 逻辑会话身份跨 MCP 重启保持稳定；每次进程启动使用新的 generation，拒绝旧进程继续领取任务。
- Monitor 启动时读取未通知队列，再等待 cursor 之后的变化；查询积压与注册等待必须原子衔接，避免检查后订阅前丢事件。
- IPC 临时断开后按已绑定身份退避重连；DND 期间持久存储，恢复 on 时主动触发积压投递。

## 消息与任务状态

消息投递与任务执行分开记录：

- 消息：hub-stored → receiver-stored → notified → acknowledged。
- 任务：queued → claimed → running → completed / failed / blocked / cancelled。

增加 `messageId`、`taskId`、`replyTo`、稳定的发送方与接收方身份、类型和期限。普通消息、任务、结果、状态通知使用不同类型，避免把“已空闲”误认为工作请求。

Hub 和接收端采用至少一次投递；接收端持久去重。先写入可靠存储，再向上游确认。提供幂等的 `team_claim_task`、`team_report_task` 工具：模型先领取再执行，完成时提交结果。租约到期进入待恢复状态，不能直接重跑可能已经产生副作用的任务。

Monitor 的通知携带任务 ID，提示领取完整内容；Channel 可以附完整内容，但仍须领取。所有路径使用同一领取记录。重试次数有界、带退避和过期时间；未确认应显示“等待接收方确认”，不能显示“正在执行”。

## 授权与工作范围

新增协作策略，例如仅通知、只读审查、允许指定目录内修改。由接收方用户一次授权，并保存到本地用户控制的配置；任务正文不能扩大权限。自动回报原始派单方也应包含在授权范围中。

不能仅信任显示名称或房间码。当前协议的名称和 ref 由客户端提供；启用自动执行前，需要经过验证的成员身份或明确配对，并由 hub 绑定消息来源。权限约束由实际工具权限和运行环境执行，提示词仅用于说明规则。

任务应包含目标仓库、基线或提交、验收条件。目标目录没有代码时，接收方报告 blocked 给派单方；同目录的写任务需要 worktree 或仓库级写入协调。普通 room 消息不能批准工具权限请求。

## 状态与验收

`team status` 展示 delivery mode、绑定会话、最近监听心跳、待确认数量、当前 taskId、阻塞原因。发送工具返回真实阶段，不把 WebSocket 写入成功等同于模型开工。

分两阶段实施：

1. 修正绑定、积压补发、重连和状态描述，增加明确授权模式与真实交互验收。
2. 加入持久任务状态、应用级确认、去重恢复及可选 Channels 适配器。

必须验证的场景：同目录两个真实交互会话、消息早于监听启动、空闲时派单且用户不输入、忙时排队、DND 后恢复、MCP 重启、重复消息、确认后回执丢失、Channel 未启用、越权任务、目标仓库不存在。

成功标准：接收方自主领取并回报；发送方看到对应 taskId 的结果；同一任务不重复执行。模拟 monitor stdout 只能作为单元或集成检查，不能替代这个验收。
