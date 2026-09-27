# Tmux Pi 子任务

`src/subagent.ts` 是 Pi 扩展。它在当前 tmux server 中启动交互式子 Pi，并将其第一次 `agent_settled` 后的结果在线送回原会话。需要 Pi 0.87.1、Node.js 和 tmux；主 Pi 必须保持运行。子任务不继承聊天记录，也不被强制只读。

在主 Pi 启动时加载扩展：

    pi --extension /absolute/path/to/subagent_lab/src/subagent.ts

主 Pi 可调用：

    subagent({ task: "只读调查认证代码，并报告关键路径", piArgs: ["--model", "openai-codex/gpt-6-luna"] })

工具立即返回 tmux session 名称和 `switch-client`、`capture-pane`、`kill-session` 命令。多个任务可并发启动；子任务结束后由扩展自动回传。已结束的窗格保留到手动清理。主 Pi 离开原会话或退出后不补投结果；启动早期失败也不自动报告，此时用 `capture-pane` 排查。

运行检查：

    pnpm install
    pnpm typecheck
    pnpm test
