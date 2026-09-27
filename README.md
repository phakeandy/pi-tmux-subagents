# Tmux Pi 子任务

`src/subagent.ts` 是 Pi 扩展。它在当前 tmux server 的共享 session `pi-tmux-subagents` 中为每个子任务创建独立 window，启动交互式子 Pi，并将其第一次 `agent_settled` 后的结果在线送回原会话。需要 Pi 0.87.1、Node.js 和 tmux；主 Pi 必须保持运行。子任务不继承聊天记录，也不被强制只读。

从 GitHub 全局安装，之后在已运行的 Pi 中执行 `/reload`（或重新启动）：

    pi install git:github.com/phakeandy/pi-tmux-subagents

更新已安装的 Git 版本后，同样执行 `/reload`：

    pi update git:github.com/phakeandy/pi-tmux-subagents

也可以只在一次启动时加载本地源码，不必安装：

    pi --extension /absolute/path/to/subagent_lab/src/subagent.ts

不要同时安装 Git 版本并用 `--extension` 加载同一扩展。主 Pi 可调用：

    subagent({ task: "只读调查认证代码，并报告关键路径", title: "my-project｜调查认证流程", piArgs: ["--model", "openai-codex/gpt-6-luna"] })

`title` 应简短说明项目和工作内容；扩展将其设置为 window 名称及子 Pi 的 `--name`（终端标题）。不要在 `piArgs` 中再次指定 `--name`。工具立即返回共享 session 名称、稳定的 window ID（如 `@42`）和切换、抓取、清理命令。不要用会变化的窗口序号定位任务。多个任务可并发启动；子任务结束后由扩展自动回传。已结束的窗格保留到手动清理单个 window：`tmux kill-window -t @42`。主 Pi 离开原会话或退出后不补投结果；启动早期失败也不自动报告，此时用 `capture-pane` 排查。

运行检查：

    pnpm install
    pnpm typecheck
    pnpm test
