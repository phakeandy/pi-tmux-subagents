# Tmux Pi 子任务

`src/subagent.ts` 是唯一默认加载的 Pi 扩展。它在当前 tmux server 的 `pi-tmux-subagents` session 中启动独立、交互式的 Pi；父 Pi 不等待子任务结束。每轮委托的结果在线回到原父会话，子 Pi 随后空闲等待，**不会因为汇报而退出**。

需要 Pi（开发类型依赖 0.87.1，实机验证 1.0.2）、Node.js、tmux。主 Pi 必须在 tmux 中。子会话不继承父聊天记录；背景由任务提供，不强制只读，不允许继续委托子任务。

## 安装 / 独立试用

```sh
pi install git:github.com/phakeandy/pi-tmux-subagents
# 更新源码后：pi update git:github.com/phakeandy/pi-tmux-subagents
# 已运行的 Pi 中：/reload
```

只加载本地这个扩展，不加载其他扩展（包括内置 MCP / codemode 扩展）：

```sh
pi --no-extensions --extension /absolute/path/to/subagent_lab/src/subagent.ts
```

不要同时加载已安装版本和本地版本。`tmux-status-title.ts` 是另一个独立、可选插件，不随本插件加载。

## 启动与继续委托

```ts
subagent({
  task: "只读调查认证流程，不修改文件；报告关键路径",
  title: "my-project｜调查认证流程",
  piArgs: ["--model", "openai-codex/gpt-6.1-sol"],
  cwd: "/path/to/project",
})
```

工具立即返回任务 ID、稳定 window/pane ID 和查看命令。`piArgs` 是参数数组，不是 shell；布局必须为 `regular`，缺少时自动补上。禁止 `--print`、`--mode`、`--no-session`、指定会话和自定义 `--name` 等冲突选项。参数策略仍由主 Agent 决定。若希望子 Pi 也只有本插件，传 `piArgs: ["--no-extensions"]`。

`mode: "user"` 可以直接启动用户协作型会话：初始任务和后续聊天均不自动回传。

## 接手与回传

- **不干预**：一次委托进入 `agent_settled` 后自动汇报原父会话，留在原窗格等待。执行停止不代表项目完成或用户验收。
- **仅进入窗格查看**：不改变回传规则。
- **Esc 或直接发送消息**：接手用户协作，立即取消尚未发送的本轮自动回传；Esc 仍正常中断执行，不退出进程，也不自动发送“已中断”。后续用户聊天不广播。
- **显式发送**：对子 Agent 明确要求发送总结，它可调用 `subagent_report({text})`；每次会弹确认框。也可直接执行 `/subagent-report <总结>`，或 `/subagent-report` 发送上次总结。
- **交回主 Agent**：子会话空闲时，你执行 `/subagent-handoff`。此后允许主 Agent 再次委托，直到你重新接手；交回本身不发送总结，也不开始工作。

主 Agent 在用户交回后可以复用同一会话：

```ts
subagent({ action: "followup", id: "exact-task-id", task: "继续只读检查测试覆盖" })
```

工作中、启动中或尚未交回的用户协作会话拒绝新委托。不会自动抢占、排入额外任务或恢复已退出的 Pi。恢复后的会话默认归用户，需重新交回才接受委托。

回传有原父会话的接收确认；确认表示结果进入原会话日志，并非模型已处理或用户已验收。SDK 唤醒是异步的，接收日志通过上下文事件保证结果可见。原父会话不在线时明确提示未送达，保留上次总结供手动发送，**不自动补投或重试**。已发出的报告不能撤回。

## Agents 状态树

父 Pi 输入框上方显示紧凑树形列表：Running、Reported · waiting、Waiting for you、Awaiting delegation、Blocked、Not delivered、Exited、Pane closed。插件状态、活动、通知和确认文案统一为 English；用户任务标题、提示词和对话内容不翻译。运行状态来自子 Pi 事件，窗格身份和存活来自 tmux；不靠抓屏判断任务完成。空闲条目不自动隐藏，列表最多显示四项双行条目，并保留总数和上下溢出提示。主行显示真实轮次、工具调用、累计本轮 token／上下文占比和耗时；缩进活动行显示思考、读取、编辑或工具执行。停止后保留本轮耗时，不显示空闲计时，等待状态不会持续跳动。未知指标不编造，不展示不存在的队列或轮次上限。

- 主输入框**为空且空闲**时：`↓` 或 `←` 进入列表。
- `↑` / `↓` 选择（可到达所有条目）。
- `Enter` 进入该任务的原生 tmux 窗格。
- `Esc` 返回输入框。
- 选中后 `Delete` 移除该子会话。

不会替换现有编辑器，不拦截非空输入框或选择对话框。结果卡片在 **fullscreen** 模式可用鼠标单击，进入对应子窗格；regular 模式的鼠标由终端管理，仍用树形键盘入口。旧结果卡片重新加载后也可导航；已移除／关闭的任务只提示失败，不猜其他会话。状态树不提供父 Pi 内聊天 viewer 或完整管理界面。子会话执行 **`/main`** 返回原主 Agent，不中断子任务，也不改变接手/回传状态。子输入框为空且空闲时，**`←` 或 `↓`** 也执行同样的返回；输入非空、正在执行、启动中或有对话框时不拦截原本的键盘行为。它向在线的原主会话查询当前窗格并核验身份，不猜“上一个 session”。原主会话不在线时提示失败，不跳到其他会话。多个 client 同时停在父 pane 时无法唯一定位，提示手动切换，不猜测用户 client。

## 退出与恢复

任务元数据保存在 `~/.pi/agent/tmux-subagents/`（目录 0700、文件 0600），包括原父归属、精确子 session path/id、工作目录、标题、启动参数、任务、稳定 pane/window ID 和最后进度。原父 Pi 重启或切换回来后可重建列表与在线回传入口。新父会话不会接收旧结果；离线期间结果不补投。

选中已退出任务只进入保留的窗格，不自动启动。你可以告诉仍在线的主 Agent “继续那个任务”，由它调用：

```ts
subagent({ action: "restore", id: "exact-task-id" })
```

恢复检查精确 session 文件和 header ID，只在原 Pi 已退出且存活检查可靠时启动；不会猜最新同名会话或再次执行原任务。原 pane 仍在时复用死 pane，否则创建新 pane。进程可能仍存活、文件丢失或身份不匹配时明确拒绝。

也可以手动启动原会话：

```sh
cd /original/cwd
pi --no-extensions --session /exact/saved/session.jsonl
```

这是独立手动继续聊天，不自动重新绑定插件任务；需要保留原任务的回传能力时，请用主 Agent 的 `restore`。tmux server 重启可重用 pane ID，因此插件同时核对每个 pane 的任务身份标记。子 Pi `/new` 或切换到其他会话时停用原任务关联，不把新聊天冒充原任务。

## 移除不再需要的子会话

在父 Pi 中执行 **`/subagent-remove`** 选择任务，或树中选中任务后按 **Delete**。也可 `/subagent-remove <精确任务ID>`。

移除会让子 Pi 退出、关闭对应 pane，并从列表永久移除；磁盘会话和项目文件保留。正在执行、启动中或状态不明时先确认，取消则不改变任务。插件先取消自动回传、请求正常中断/退出，确认进程退出后再关闭原 pane；不能可靠验证身份、会话已切换或 Pi 未退出时拒绝强杀。只关闭对应 pane，不关闭用户后来添加的其他 pane。历史结果仍保留在父聊天记录里，但不再能跳到已移除窗格。

旧子 Pi 需要先 `/reload` 才支持正常退出请求；未响应退出请求时不会默默强杀。手动窗口清理仍可使用 `tmux kill-window -t @ID`，需自行确认其中没有其他工作。

不设置自动过期、不自动删除会话文件、不终止其他窗口。长期空闲 Pi 会占用内存；若配置空闲缓存 warming，也可能消耗模型费用。

## 验证

```sh
pnpm install
pnpm typecheck
pnpm test
# 可选实机测试：会使用当前模型凭据，产生少量真实请求；只清理自己的独立 tmux server。
PI_SUBAGENT_LIVE_TEST=1 pnpm exec vitest run test/live-pi.test.ts test/live-ui.test.ts
```

实机测试覆盖自动汇报后仍存活、用户续聊静音、显式总结、交回后再次委托、执行中 Esc、原父运行时重建、精确恢复原会话。另一个实机测试覆盖真实 fullscreen 鼠标结果卡片点击、`/main` 返回和空闲任务正常退出/移除。树形视觉和与个人配置的最终验收仍由用户确认。

旧版本已退出任务未保存精确登记，不能自动迁移恢复；仍可使用 Pi 原生会话历史手动寻找。该限制不能被窗口标题或 `capture-pane` 猜测掩盖。
