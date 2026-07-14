# JSON 报告字段说明

当前格式版本为 `schemaVersion: 2`，正式 Schema 位于 [`schema/report.schema.json`](../schema/report.schema.json)。

## 顶层字段

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `$schema` | string | 固定指向本仓库公开 JSON Schema |
| `schemaVersion` | integer | 报告结构版本，当前为 `2` |
| `reportId` | string | 本轮随机报告 ID，不包含 API Key |
| `generator` | object | 生成器名称、版本和检测模式 |
| `ok` | boolean | 是否通过 CLI 的关键门禁 |
| `checkedAt` | date-time | UTC 检测时间 |
| `baseUrl` | URI | 已规范化的被测接口地址 |
| `requestedModel` | string | 请求使用的模型 ID |
| `responseModel` | string/null | 响应声明的模型 ID |
| `score` | integer | 九项检查的加权分，范围 0 到 100 |
| `verdict` | enum | `兼容良好`、`部分兼容` 或 `需要排查` |
| `requestCount` | integer | 快速模式固定为 3 |
| `usage` | object | 两次 Chat Completions 的 Token 汇总；无法完整核对时为 `null` |
| `signals` | object | 元数据及协议字段存在性，不保存完整原始响应 |
| `checks` | array | 九项检查的结果、权重和脱敏说明 |
| `disclaimer` | string | 结论边界声明 |

## 兼容性约定

- 同一主版本内可以增加非必填字段，但不会改变既有字段含义。
- 删除字段、修改类型或改变计分语义时会提升 `schemaVersion`。
- 自动化程序应优先检查 `schemaVersion`，再读取字段。
- 报告中的 `model`、`system_fingerprint` 和 request ID 都可能被网关改写，只能作为交叉核对线索。

## CI 判定建议

严格门禁可同时检查：

```js
report.schemaVersion === 2 &&
report.ok === true &&
report.score >= 85
```

如果目标服务不提供 `/models` 或 usage，可按业务情况读取单项 `checks`，但应在评审记录中说明豁免原因，不能把缺失证据写成已通过。
