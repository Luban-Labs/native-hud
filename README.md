# native-hud 0.1.0

用 Claude Code 自带的界面元素，在输入框下方显示模型、路径、git/worktree、上下文、5 小时与 7 天用量及重置倒计时、输出速度和缓存命中率。纯 mod：不向模型上下文写任何内容，不占 token。

```text
  ⏵⏵ auto mode on (shift+tab to cycle)
  ◆ Opus 5.5 1M   ~/code/app   ⎇ main ●2 ↑1
  ctx ━━━━━━━━━━ 38% 380k/1M   5h ━━━━━━━━━━ 72% ↻ 2h13m   7d ━━━━━━━━━━ 9% ↻ 3d4h   ⚡ 53 tok/s   cache 90%
```

## 安装

在 Claude Code 中运行：

```text
/plugin marketplace add Luban-Labs/native-hud
/plugin install native-hud
```

本地试用：

```bash
claude --plugin-dir /path/to/native-hud
```

需要 **Claude Code ≥ 2.1.289**（函数钩子 mod，在 2.1.289 上测试）。如果 `settings.json` 里还配着 `statusLine`（例如 claude-hud），两套会同时显示；只想留一套就删掉那段 `statusLine`。

## 看懂每一段

| 段 | 含义 |
|---|---|
| `◆ Opus 5.5 1M` | 当前模型；`1M` 表示 100 万 token 上下文 |
| 路径 | 会话工作目录，家目录写作 `~`，过长时中间截断 |
| `⎇ main` | 当前分支；不在分支上时显示提交号前 7 位。`wt:名字` 表示在 linked worktree 里，`●N` 是未提交文件数，`✓` 表示干净，`↑N` / `↓N` 是领先 / 落后远端的提交数 |
| `ctx` | 上一次请求的输入占上下文窗口的比例和 token 数 |
| `5h` / `7d` | 订阅的 5 小时和 7 天用量，`↻` 后是距离重置的时间；非订阅账号显示 `—` |
| `⚡ N tok/s` | 上一次回复的输出速度：输出 token 数 ÷ 从第一个流式数据到结束的时间。包含屏幕上看不到的思考时间，不包含等待首字的时间。回复流式输出时显示 `~N` 估算值，中断后清除 |
| `cache N%` | 上一次请求的输入里命中提示缓存的比例 |

用量类数字按占用着色：低于 60% 绿，60–85% 黄，85% 及以上红。缓存命中率反过来：80% 及以上绿，50–80% 黄，低于 50% 红。只统计主会话，子代理不计入。终端变窄时，放不下的段会换到下一行。

## 显示位置

HUD 画在输入框下方的提示行（`PromptHint`）里：原来的模式行（如 `auto mode on`）和它右侧的提示照常保留在第一行，HUD 的两行在它下面。mod 没有办法在 `statusLine` 那一格画图形，所以位置比 statusLine 低一行。

## 数据从哪来

- 上下文、5h/7d：引擎推送的 `session.measure`，不读 transcript，不联网。
- 速度、缓存：每次主会话请求结束时流式数据里的 usage；所有流式数据原样透传，不改动回复。
- git：`git --no-optional-locks status --porcelain=v2 --branch`，在每轮结束、Bash 执行了 git 或 cd、以及每 30 秒时刷新。不拿锁，不会和你自己的 git 写操作抢 `index.lock`。

## 开发

```bash
claude plugin validate .
claude plugin test .
```

## License

MIT
