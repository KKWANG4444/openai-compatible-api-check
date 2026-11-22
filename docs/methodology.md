# 模型 API 检测方法论

本文说明 `openai-compatible-api-check` 如何采集证据、如何给分，以及哪些结论不能由一次黑盒检测推出。方法复核日期：2026-11-23。

本轮方法借鉴了公开的一手实现：[vLLM OpenAI 兼容端点测试目录](https://github.com/vllm-project/vllm/tree/main/tests/entrypoints/openai) 将 Chat、stream、tool calling 和 error 分开验收；[LiteLLM 的流式错误说明](https://github.com/BerriAI/litellm-docs/blob/main/docs/proxy/error_reference.md) 明确区分首个 chunk 前的 HTTP 错误与已经返回 200 后的流内错误；[SGLang 的 OpenAI 流式处理器](https://github.com/sgl-project/sglang/blob/main/sgl-model-gateway/src/routers/openai/responses/streaming.rs) 将 SSE 解析、事件累积和工具调用识别视为独立边界。这里只借鉴测试维度和失败分类，不复制服务端代码或把其他项目的实现结果当作本项目的检测结果。

## 检测对象

工具检测的是一个使用 Bearer 认证、暴露 OpenAI Compatible 接口的 HTTPS Base URL。CLI 发起 3 次请求：

1. `GET /models`：读取模型列表。
2. `POST /chat/completions`：执行随机字符串精确返回测试。
3. `POST /chat/completions`：执行每轮参数不同的 R1 多步计算题，并核对随机 nonce。

随机值在本地生成，减少服务端针对固定问题返回预设答案的空间。API Key 只通过环境变量读取，不写入报告。

## 九项检查与证据含义

| 检查 | 权重 | 能说明什么 | 不能说明什么 |
| --- | ---: | --- | --- |
| 模型列表接口 | 10 | `/models` 在检测时点可访问 | 列表中的每个模型都可调用 |
| 模型 ID 可发现 | 5 | 请求模型出现在返回列表 | 模型 ID 对应某一厂商原版模型 |
| Chat Completions | 15 | 基础非流式调用成功 | 高并发与长期稳定性 |
| 协议层合规 | 15 | 关键响应字段结构接近 OpenAI 协议 | 所有 SDK 边界行为完全一致 |
| 固定指令遵循 | 15 | 能精确执行本轮随机字符串指令 | 通用推理能力或业务质量 |
| 元数据指纹 | 10 | 可采集 model、request ID 等交叉核对线索 | 指纹无法被网关改写 |
| 响应模型声明 | 10 | 请求与响应的 `model` 文本一致 | 底层实际路由一定未变化 |
| 计费 Token 字段 | 10 | usage 字段完整且加法一致 | 计费系统一定按该数字扣费 |
| R1 动态题 | 10 | 本轮随机多步计算和 nonce 均正确 | 模型没有降智、套壳或动态路由 |

综合分是上述证据的加权结果。CLI 的 `ok` 要求九项检查全部通过；任何必检项失败，`verdict` 均显示“需要排查”，不能用较高总分覆盖失败项。两次生成响应都检查 HTTP、协议、元数据、模型声明与 Token 算术；Token 汇总仅在两次数据和安全整数范围均通过时可用。顶层 `responseModel` 和 `signals` 保留首次响应摘要，两次核验结果记录在 `checks` 中。分数和 `ok` 用于自动化门禁，但不能替代人工判断。

## 三种检测模式

| 模式 | 请求量 | 用途 | 覆盖范围 |
| --- | ---: | --- | --- |
| Postman 基础冒烟 | 2 | 手工接入前快速检查 | 模型列表、基础调用、随机字符串、基本字段 |
| CLI 快速检测 | 3 | 本地、CI、变更后复测 | 9 项检查、Schema v2 JSON/Markdown 报告 |
| CLI/GitHub Action thorough | 6 | 发布前深度验收 | 9 项核心检查 + SSE、工具调用结构、错误响应契约和延迟样本 |
| [在线标准检测](https://docs.aifast.hk/model-check/) | 约 7 | 更完整的交互式筛查 | 10 个维度，追加输出风格、知识边界、SSE、工具调用等证据 |

不同模式的分数不可直接横向比较。需要对多个服务做对比时，应固定测试时间、网络位置、模型 ID、参数和题集，并保留原始报告。

### thorough 深度证据

thorough 在 3 次核心请求后追加 3 次探测：

1. `stream: true`：必须看到 `text/event-stream`、合法 JSON chunk、delta、终止 `finish_reason` 和 `[DONE]`。这能发现普通 JSON 正常但 SSE 截断、事件格式损坏或没有终止标志的问题。
2. `tool_choice`：发送只包含字符串参数的最小函数，不执行外部工具；核对现代 `tool_calls` 或旧式 `function_call` 的函数名及 JSON 参数。
3. 不存在模型：要求 4xx 和 `error.message`。如果网关把未知模型静默路由到默认模型，错误契约会失败，但不会覆盖核心协议分。

深度检查结果放在报告的可选 `advanced` 字段中。工具调用不是所有模型的必备能力，所以它不会改变核心 `ok`；SSE、工具和错误契约的失败必须按具体细节排查，不能简单解释为模型不可用。

## 模型真伪与降智判断边界

黑盒接口无法单凭一次响应完成厂商级身份认证，原因包括：网关可改写模型名和元数据；同一模型可能存在快慢版本、区域版本或动态路由；知识题会受到联网检索、系统提示和缓存影响；输出风格也可通过提示词模拟。

合理做法是把检测结果当作“风险筛查证据”：

1. 先看协议、错误码、request ID 和 Token 是否可核对。
2. 再用动态题与真实业务题集做多轮测试。
3. 在固定并发下记录成功率、P50/P95 延迟和状态码分布。
4. 对照账单、服务条款、模型更新公告与供应商支持记录。
5. 对重要业务保留至少一条备用线路，并定期复测。

## 复现与引用

JSON 报告遵循 [`schema/report.schema.json`](../schema/report.schema.json)，示例见 [`examples/report.example.json`](../examples/report.example.json)。公开报告前应移除业务输入、用户数据及可关联内部系统的 request ID。请勿发布真实 API Key。

本项目由 AI快站维护，但检测工具面向任意兼容服务。AI快站官网、模型价格或注册入口不参与检测计分。

## 目录同步记录（2026-11-23）

检测器仍只验证公开 HTTPS OpenAI Compatible Chat Completions Base URL。当前目录中的 qwen4-max、gpt-6.2-astra、gpt-6.2-sol、hy4-flash、gemini-4-hydrogen、gemini-4-carbon 和 claude-fable-5-2 可作为精确模型 ID 示例，但必须先从账号实时 /models 或控制台确认。thorough 会探测高级协议能力，但不会强行把 Gemini、Anthropic、Responses 或厂商原生端点改写成 Chat Completions。

语音转文字、图像、视频、音乐、实时和厂商原生端点不应强行套用本检测器；应按对应协议单独验证。/models 返回、目录收录或单次 Chat Completions 成功都不能证明长期可用性、模型身份或高级能力。
