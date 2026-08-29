# dsh-token-billing

DSH 插件：按模型实时统计 token 消耗与费用。

## 功能

- 输入框下方状态栏显示实时费用胶囊，点击展开按模型明细。
- 设置页「Token 计费」配置模型价格（每百万 token：输入价 / 输出价 / 缓存输入价）与货币符号。
- 支持按「供应商 / 模型」分开计价；**未设置价格的模型默认按 0 元计费**。
- 深色/浅色主题自适应，配色与「上下文」胶囊一致的中性灰风格。

## 安装（本机）

1. 把本目录链接到插件目录：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-token-billing" `
     -Target "C:\path\to\dsh-token-billing"
   ```

2. 在 `~/.dsh/profiles/web/cordis.patch.yml` 追加：

   ```yaml
   - id: dsh-token-billing
     name: 'dsh-token-billing'
   ```

3. 重启 DSH 后端并刷新页面。

## 使用

- **设置 → Token 计费**：为每个模型填写价格（模型名需与模型 id 一致；同一模型在不同供应商下可写成 `供应商::模型`）。
- 对话中实际使用的模型会自动按价格匹配计费，未定价模型按 0 元处理。

## 协议

MIT
