# pi-subagents 生命周期与 Agents UI：参考研究（不是批准规格）

## 范围、版本与方法

- Primary sources：`https://github.com/tintinweb/pi-subagents` 当前源码、官方 README、仓库内 `docs/rpc.md`。静态追踪调用链，未安装依赖、未运行扩展或测试、未修改插件、未杀进程、未委托其他 Agent。
- 2026-10-06T16:19:07Z 再次 `git ls-remote origin HEAD`，与 clone 一致：**`e955e29c51b7a6cce37e1108cd2d6c57a77e151c`**，commit 时间 `2026-09-03T14:10:17+02:00`，标题 `fix: stand down for lowercase workflow tools (#283)`。本文全部引用固定在此 commit，不声称对应 npm 最新发布。源码 package.json 标示 `0.19.0`。[V]
- 用户给定旧副本 `/tmp/pi-github-repos/runtime-XKTTt9/a5366a4788dee421ac1316f95df71303e1e336c11a84ad623c94b5eece7cf151` 在本次环境不存在，不能核实其版本；目录名不能当 Git commit。新研究副本在 `/tmp/pi-subagents-research-MT8Wgy`。
- **已支持**＝有正向实现证据；**未支持**＝目标行为与实际执行路径冲突或入口明确拒绝；**未找到**＝检查的配置、类型、入口、README 中没有该能力，不能据此断言所有外部扩展也做不到。涉及宿主跨会话投递的实际时序，仅报告静态证据与未验证风险。
- 本项目已确认需求（来自用户，不是上游事实）：汇报后交互 Pi 在窗格空闲等待；区分委托型与用户直聊协作型；委托轮次自动回传，用户接手后不自动广播，需要时明确发总结；委托结束不等于用户问题/项目验收完成。以下只核查参考实现，不把参考行为或建议升级成规格。

## 一眼结论

| 本项目关心的行为 | 核查结果 | 证据 |
|---|---|---|
| 委托结果返回后保留同一会话上下文，允许后续继续 | **已支持，但有限保留**：内存 session 可 resume，完成约十分钟后会 dispose；默认持久化 session 文件 | [S1][S2][R1] |
| 汇报后原生交互 Pi 仍在独立窗格空闲等待 | **未支持该架构**：是同进程 SDK `AgentSession`；overlay 不是原生子 TUI，也没有独立 pane | [A1][U3][D1] |
| 委托型/用户协作型生命周期与通知策略分离 | **未找到角色模型；目标通知行为未支持**：用户 mention resume 复用普通后台完成通道 | [T1][I1][N1][N2] |
| 主 Agent 委托轮次自动回传并唤醒父模型 | **已支持（后台且结果未消费时）**：`followUp` + `triggerTurn: true`，可分组、去重 | [N1][N2][N3] |
| 用户接手后续聊不自动广播，只显式总结 | **未支持**：`@handle` 明确恢复未消费标记，后台 resume 再次完成后通知；查看 overlay 不建立“接手”状态 | [I1][S2][N1][U3] |
| completed 只表示委托结束，不等于项目验收 | **运行结束与会话存在已区分；独立验收状态未找到**：completed 来自 prompt 返回及错误判断，不包含用户验收 | [T1][S1][A2][O1] |

## 1. 进程、任务、会话与完成状态

1. **进程不是每个 agent 一个 Pi 进程。** runner 调用 SDK `createAgentSession`，再 `bindExtensions` 和 `session.prompt`；返回对象含 session。跨扩展所谓 RPC 官方明确是同进程 `pi.events`，不是 stdio RPC 子进程。[A1][A2][D1]
2. **任务/一次 run 与会话有区别，但不是完全独立实体模型。** `AgentRecord` 把 id、status、result、promise、abortController、session、completedAt 放在一起。后台 resume 复用 record/session，清空上次 result/error/completedAt/resultConsumed，进入 queued/running；不是建立一套长期任务验收实体。`isBackground` 是结果表面/池策略，`blocking` 才表示有人 inline await，不能把 foreground/background 当“委托型/协作型”。[T1][T2][S2]
3. **completed ≠ session 已销毁。** runner 的 prompt 返回后，manager 存 result 和 session，设置 terminal status/completedAt；后台结果通知之后可再次 resume。完成约十分钟、每六十秒扫描才移除 record 并触发 child shutdown/dispose。因此保留的是 SDK session，不是永远存活的交互窗格。[A2][S1][C1][C2][C4]
4. **状态精确含义**：`queued/running/completed/steered/aborted/stopped/error`。这里 terminal `steered` 是软 turn limit 后 wrap-up，不是“收到用户 steer 就完成”；`aborted` 是硬上限，`stopped` 是人工 stop。异常/partial 输出有明确标注。[T1][S1][A2][O1]
5. **项目/用户验收：未找到。** `completed` 的判定不检查用户满意或项目验收。源码已避免把 stopped/限额 partial 假称完成，但没有 `accepted/verified/user-done` 等独立验收字段。不能用参考 UI 的勾号替本项目验收。[S1][T1][O1]

## 2. follow-up / send / resume：实际入口

- **主 Agent 工具**：`Agent({resume: <agent-id>, prompt, ...})`，默认后台，显式 `run_in_background: false` inline 返回。工具 resume 仅按内存 record 的 ID 找，要求 active session；record 已清理即报 not found，不会自动搜磁盘或解析 tombstone handle。后台运行/排队中的同一 agent 拒绝 resume，提示 steer 或 wait。[R2]
- **`steer_subagent` 工具**：ID/handle 找 record，但工具入口要求 `running`；启动中 session 未 ready 可 pendingSteers。消息作为 user 消息在当前工具之后介入。底层 manager 的 steer 还接受 queued，故不要将工具入口限制与 UI/mention 行为混为一谈。[F1][F2]
- **`get_subagent_result`**：ID/handle 检查结果，支持 wait、verbose；取消 wait 只取消等待，不停止后台 agent。terminal 结果读取后置 resultConsumed，避免重复通知；不是验收通过。[F3][R3]
- **用户 `@handle message`**：running/queued 时 steer，terminal 且有 session 时后台 resume，record 已驱逐但 tombstone 存在时精确 reopen；不存在才考虑启动类型。命中已有 agent 的 steer/resume 为 TUI-only，headless 不直接派发。[I1][I2]
- **启动新 mention**：默认 model 模式由离屏主会话 clone 仅持 Agent 工具写委托 prompt；direct 模式直接使用用户文本。两者只是启动路径差异，**不是协作/委托角色分类**。官方说 mention 输入不进入主聊天，但结果仍通过普通后台完成通知返回主模型。[R4][I1]
- **用户会话 overlay**：Enter 打开轻量 composer，只对 running/queued agent 做 steer；finished overlay 保持可阅读，但 canSteer=false，**不能在完成后的 overlay 直接发下一轮**，须退出用 mention/Agent resume。没有完整原生 Pi editor、命令系统或独立 TUI attach。[U2][U3][U4]
- **followUp 的含义要分开**：源码 `deliverAs: "followUp"` 是向父 Pi 投递完成消息，不是对子 session 的“用户续聊”。对子 session 的续聊用 `session.prompt`，中途消息用 `session.steer`。[N1][A2][F2]

## 3. 自动回传频率与父 Agent 唤醒

1. **已支持后台 run 完成时回传，不是每个 assistant message/tool/agentic turn 广播结果。** manager 在 run settle 调 onComplete；工具活动/usage 走 UI/统计回调。resumeAgent 等待本次 prompt 完成后提取本次文本；后台 resume 每次 settle 都再调 onComplete。[S1][S2][A2]
2. **明确请求自动唤醒父 Agent**：个体通知与分组通知均 `pi.sendMessage(..., {deliverAs:"followUp", triggerTurn:true})`。通知含摘要，个体 500 字符、组内每项 300 字符，并提示工具取全文；不是只 toast 用户。[N1][N2]
3. **不是严格“一任务一通知”。** 默认 smart：100ms debounce 收集并行调用，两个以上 smart/group agent 组队；全完成一起发，首个完成后 30s 超时可先发 partial，剩余组用 15s 超时。个体/组投递再 hold 200ms，结果已消费则抑制。因此是 run 完成驱动、允许聚合和多批通知，不是对整个长期 session 只汇报一次。[N1][N3][G1][G2]
4. **去重/消费不是“用户接手静音”。** foreground spawn inline 结果置 resultConsumed；get_result 和 RPC consume 可抑制待发送的通知，已发送不撤回。用户 `@handle` steer 强制 resultConsumed=false，后台 resume 同样重置，所以用户续聊结果依然唤醒父模型。overlay 只读不改变归属/通知策略。[N2][S3][F3][I1][S2][D2][U3]
5. **例外**：nested/workflow-owned child 不走顶层通知；queued 状态 stop 不调 onComplete；running stop 会在 run settle 后进入 terminal 完成路径，不等于正常成功。[N2][C3] 不应把 these exceptions 当用户接手模式。

## 4. session 恢复定位、持久性与父会话离开

### 定位与持久性

- **精确路径已支持**：onSessionCreated 捕获 `session.sessionManager.getSessionFile()`；eviction 保存 `{handle, alias, id, type, description, sessionFile, completedAt}` tombstone；mention 恢复用该 sessionFile，runner `SessionManager.open(path)`。不是按标题、类型或“最新 session”猜测。[P1][P2][I2][A1]
- **默认磁盘会话已支持**：rememberAgents=true（顶层），frontmatter persist_session 可覆盖；可指定 session_dir；create 写 parentSession 元数据供宿主 `/resume` 分层。nested 默认不持久化，但可配置覆盖。`.output` transcript 与 Pi session 文件相互独立，官方说明 tmp transcript 可随 reboot 消失，不能把它当恢复凭据。[A1][R1][R5]
- **恢复不是定义快照**：evicted reopen 重新加载当前 agent definition，删除/禁用则拒绝，不降级另一个类型；原 session 文件缺失会报错并释放 tombstone handle，而非悄悄创建替代会话。内存 session resume 则复用现存 session；不可把两种恢复都说成重建当前配置。[I1][I2][S2][R1]
- **handle 持久性有限**：tombstone 只是进程内 Map，保留最近 100 个；clearCompleted 在父会话边界无条件清空 tombstones。README 也明确 `/new` / session switch 忘掉这些名字。磁盘 session 还在，并不等于重启父 Pi 后 `@explore` 仍定位原子会话；**未找到跨重启 handle→sessionFile 索引重建**。appendEntry final record 有状态结果，但不含 sessionFile/handle，不能拿它替代持久恢复注册表。[P2][C1][N2][R1]
- **工具与用户能力不对称**：Agent resume 工具仅内存 ID；用户 mention 有 tombstone reopen 分支；原生 `/resume` 浏览磁盘会话是第三种入口。不要宣称所有工具都能长期按 handle resume。[R2][I2][R5]

### 父会话离开：必须区分动作

| 动作 | 上游行为 / 边界 |
|---|---|
| 父模型一个轮次结束或用户 Esc 中断父后台委托轮次 | 后台 spawn 不绑定该轮次 signal，后台 resume 也特意不传 signal；后台 run 可继续。foreground 则绑定 parent abort signal。[B1][B2][S4] |
| 父 Pi session switch / `/new` 路径 | `session_before_switch` 只 clearCompleted(true) 和 scheduler.stop；clearCompleted 跳过 running/queued，也可保留未消费 terminal record，却无条件清空 tombstones；session_start 更新 currentCtx 并再次清理。**没有此处 abortAll / detach 独立进程机制**。[L1][L2][C1] |
| 真正退出父 Pi | session_shutdown 取消 RPC、scheduler/workflow，abortAll，清 pending nudges、dispose 所有 retained child session（child shutdown 有 3s 上限）。不是父进程退出后子窗格继续运行。[L3][C2] |
| 一个 nested 父 subagent 自己完成/stop/结束 resume | abortOwnedChildren，子任务不能超出其所有者 run 生命周期；README 明确 nested 从所有顶层 UI 隐藏。[S2][R6] |

**待验证风险，不作为实测结论**：切换父会话时 running/queued 与 pending completion 通道未在该 hook 被关闭，通知使用 activation 的 pi API，而不是明确绑定原父 session 的 mailbox。静态代码不足以保证“离开后结果只回原父会话、不唤醒新会话”；本项目若需该保证，应自己定义归属与缓冲协议，不能从该实现推断已具备。[L1][L2][N1]

## 5. Agents 树 UI：来源、选择、归档/停止/清理

- **树形外观已支持，完整多层 Agents 拓扑树未支持。** above-editor widget 用 `├─` 等画顶层 agent 的活动列表；`widgetAgents` 从 manager records 按 isTopLevelAgent 与 widgetMode 过滤。nested/workflow child 隐藏，workflow 有自己的整体行；不是读取 tmux panes / OS PID 树，也不是完整递归展示 parentAgentId。[U1][U5][R6][R7]
- **状态来源已支持且集中**：record.status/result/usage/时间、agentActivity 的 tools/text/turnCount 及 SDK session context usage；render 实时读取。状态勾号代表 SDK run 状态，不是工作验收状态。[T1][S1][U1][U5]
- **选择动作**：可导航的 FleetView 是 below-editor 的列表（main + workflows + top-level agents），非上方树 widget 自身。空 prompt ↓/← 进入，↑↓选择，Enter 开 overlay（workflow 是 inspector），main/Esc 返回。只显示有 session 的可打开 agent，按启动时间排序；`/agents` Running agents 可选内存里已完成 record。[U3][U6][U7][U10][U11]
- **完成后 UI 留存不同于 session 留存**：Fleet finished 留 4000ms，正在查看的 agent 仍列出；widget completed 留一个计数轮次、error 两个；manager record 约十分钟后才 GC。UI 消失不是销毁 session 文件，也不是用户验收。[U6][U8][U9][C1][C4]
- **停止已支持**：overlay `x` 两次确认；queued stop 出队，running stop abortController 并标 stopped；不是杀一个独立 Pi 进程。Esc 离开 viewer 仅关闭 overlay，不 stop。RPC 也有 stop，需顶层且 active。[U4][C3][RPC1]
- **专门的运行归档/删除/手动清 completed 功能：未找到。** 检查 `/agents` 菜单与 viewer 操作只有查看、steer、stop；README 的 Edit/Disable/Delete 是 **agent 类型定义文件** 管理，不是 session/run archive。clearCompleted 是生命周期 hook 调用，GC 留 tombstone/磁盘 session，不等于用户归档工作。[U7][U4][C1][R8]
- **清理层次不可混用**：overlay dispose 取消 viewer 订阅；record eviction 触发 SDK child shutdown/dispose；session 文件仍可 reopen；可选 worktree 在 run 结束就 commit/建 branch/remove（force），不等用户验收。这种工作目录生命周期无法照搬给要继续留在窗格协作的 Pi。[U2][C1][C2][W1][S1]

## 6. 架构判定（避免混称）

**准确称呼：同进程后台/inline SDK 子 session + 顶层扩展 UI，会话间通过方法调用和内存事件交互。**

不是“每个 agent 开一个原生 Pi TUI”，也不是“用 Pi stdio RPC 管独立子进程”；官方 cross-extension RPC 是同 event loop 的总线接口。`ConversationViewer` 订阅 session 并自己 render transcript、Input composer；没有子 TTY attach。因此可借鉴 UI 视觉和控制语义，但“窗口保持”“切换到原生子 TUI”“父退出而子进程存活”不能由此获得。[A1][D1][U2][U3][L3]

## 可借鉴 / 不能照搬

### 可借鉴的参考方向（建议，未批准）

- AgentRecord/运行状态作为统一 UI 数据源；列表显示活动、usage、耗时、明确 partial/error。借鉴视觉层，不将上游 status 偷换成项目完成。[T1][U1][O1]
- 保存 **确切 sessionFile**，与稳定身份、handle/alias 分开；缺文件显式失败，避免“同名最新会话”误恢复。[P1][P2][I2]
- 回传的消费去重、分组聚合及显式 `triggerTurn`，作为委托型通知协议的参考。[N1][N3][D2]
- stop/close viewer/forget record/session persistence/worktree cleanup 是不同动作，UI 和命名应明确区分。[C1][C3][U4][W1]

### 不能直接照搬

- SDK session 保留不等于原生子 TUI 窗格空闲；必须另设计进程、pane、session 和任务轮次关联。[A1][C1][U3]
- 用户 mention 跟委托共享自动回传，违反本项目“接手后不广播”；不能用 resultConsumed 临时布尔值冒充持久角色/控制权状态。[I1][S2][N2]
- 内存 tombstone 不等于跨父 session/重启的持久注册表；默认 handle 清空不适合长期同一协作者身份。[P2][C1][R1]
- completed 勾号及约 4s/一个轮次自动消失，不应意味着用户问题已结束；worktree run 后清理更不能当验收策略。[S1][U8][W1]

## 待用户继续 grilling 的选择（不是新增决定）

1. **角色/控制权如何转换？** 已确认两种角色与接手后静音；还需选择接手由明确按钮/命令触发，还是实际直聊触发；什么动作能把下一轮重新标为主 Agent 委托。上游没有可直接引用的转换协议。[I1][T1]
2. **父会话离开策略？** 切换与退出时，独立窗格是否保留；尚未回传的委托结果绑定原父会话、暂存还是取消；恢复时是否显式补发。上游不是独立子进程且切换 hook 未提供明确原父 mailbox 保证。[L1][L3][N1]
3. **身份持久化边界？** 要跨父切换/重启保存哪些 id→sessionFile→pane 映射；session 文件丢失、pane 已关、进程仍在的组合分别如何反馈。上游只提供有限期内存名字与精确路径的参考。[P1][P2][C1]
4. **长期协作树的留存/归档？** 已确认汇报后 Pi 空闲等待，不应套用上游临时 UI linger；归档仅隐藏、停止委托、退出 Pi、删除恢复记录，应选择为不同动作。验收完成必须单独表达，不能由 terminal run 自动推导。[U8][C1][T1]
5. **“明确发总结”操作与投递目标？** 协作型明确发送时，是否唤醒哪个父会话、是否消费本轮结果、能否重复发送；上游只有自动 notification/consume，未找到对应的人类显式总结入口。[N1][D2][U4]

## 固定源码证据索引

所有链接均固定 commit `e955e29c51b7a6cce37e1108cd2d6c57a77e151c`；每个引用的文件路径与行号在链接中。

[V]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/package.json#L1-L14
[T1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/types.ts#L156-L204
[T2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/types.ts#L208-L240
[A1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L955-L1026
[A2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-runner.ts#L1108-L1213
[S1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L849-L936
[S2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1107-L1299
[S3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L950-L985
[S4]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L744-L759
[R1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L196-L198
[R2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1970-L2032
[R3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L460-L479
[R4]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L147-L194
[R5]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L237-L250
[R6]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L341-L349
[R7]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L126-L142
[R8]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/README.md#L533-L542
[I1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L906-L942
[I2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L948-L1011
[F1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L2819-L2873
[F2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1315-L1329
[F3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L2753-L2815
[N1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L447-L527
[N2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L567-L610
[N3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1223-L1263
[G1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/group-join.ts#L23-L108
[G2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1161-L1171
[D1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/docs/rpc.md#L1-L7
[D2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/docs/rpc.md#L110-L128
[P1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L806-L816
[P2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1428-L1468
[C1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1470-L1498
[C2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L332-L360
[C3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L1407-L1425
[B1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1309-L1327
[B2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L2055-L2068
[L1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1090-L1093
[L2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L786-L829
[L3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L1095-L1122
[U1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/agent-widget.ts#L295-L313
[U2]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/conversation-viewer.ts#L390-L482
[U3]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/fleet-list.ts#L382-L434
[U4]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/conversation-viewer.ts#L194-L239
[U5]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/agent-widget.ts#L398-L443
[U6]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/fleet-list.ts#L238-L295
[U7]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L2900-L2960
[U8]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/agent-widget.ts#L327-L358
[O1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/status-note.ts#L13-L32
[W1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/worktree.ts#L130-L194
[RPC1]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/cross-extension-rpc.ts#L167-L195
[C4]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/agent-manager.ts#L415-L429
[U9]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/fleet-list.ts#L25-L29
[U10]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/ui/fleet-list.ts#L328-L359
[U11]: https://github.com/tintinweb/pi-subagents/blob/e955e29c51b7a6cce37e1108cd2d6c57a77e151c/src/index.ts#L3037-L3078
