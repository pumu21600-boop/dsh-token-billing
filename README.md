# dsh-token-billing

DSH 插件：按模型实时统计 token 消耗与费用。

## 功能

- 输入框下方状态栏显示实时费用胶囊，点击展开按模型明细。
- 设置页「Token 计费」配置模型价格（每百万 token：输入价 / 输出价 / 缓存输入价）与货币符号。
- 支持按「供应商 / 模型」分开计价；**未设置价格的模型默认按 0 元计费**。
- 深色/浅色主题自适应，配色与「上下文」胶囊一致的中性灰风格。

## 安装（DSH ≥ 0.2.0：插件即 bundle）

1. 把本目录 junction 到桌面端 profile 的插件目录：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-token-billing" `
     -Target "C:\path\to\dsh-token-billing"
   ```

2. 在 `~/.dsh/profiles/desktop/package.json` 里把插件加入 `dependencies` 与
   `dsh.profile.bundles`（0.2.0 起 profile 的 cordis.patch.yml 不再负责装载插件；
   本包自带 `dsh.bundle.patch`，无需再写用户层 insert）：

   ```json
   "dependencies": { "dsh-token-billing": "0.3.1" }
   ```

   ```json
   "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-token-billing"] } }
   ```

3. 重启桌面端即生效。

## 使用

- **设置 → Token 计费**：为每个模型填写价格（模型名需与模型 id 一致；同一模型在不同供应商下可写成 `供应商::模型`）。
- 对话中实际使用的模型会自动按价格匹配计费，未定价模型按 0 元处理。
- 价格表持久化在 profile 条目配置里（`lib/index.js` 导出的 `Config` schema，端点 `/dsh-token-billing/config` 读写，经 configEditor 落盘），**不使用 localStorage**——换端口/换访问地址不会丢。
- 供应商目录通过官方 `llm.listConfigurableProviders` 接口拉取（0.2.0 起 `llm.providers` 已移除）。

## 协议

MIT
