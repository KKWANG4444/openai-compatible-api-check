# 安全策略

## 报告安全问题

请通过 GitHub 仓库的 **Security > Report a vulnerability** 私下提交安全问题，不要在公开 Issue 中附带真实 API Key、请求头、账户信息或完整上游响应。

报告时可以提供脱敏后的复现步骤、受影响版本、预期行为和实际行为。所有密钥都应替换为 `[REDACTED]`。

## 使用建议

- 只使用临时、低额度 API Key；
- 检测完成后撤销临时 Key；
- 不要把 Key 写入命令参数、报告、CI 日志或仓库 Secret 之外的位置；
- 仅检测你有权访问的公开 HTTPS API。
