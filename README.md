# OpenAI Compatible API 自检工具

[![CI](https://github.com/KKWANG4444/openai-compatible-api-check/actions/workflows/ci.yml/badge.svg)](https://github.com/KKWANG4444/openai-compatible-api-check/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![在线检测](https://img.shields.io/badge/在线检测-打开工具-0f766e)](https://docs.aifast.club/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-badge)

一个无第三方依赖的命令行冒烟测试，用于检查任意公开 HTTPS、Bearer 认证的 OpenAI Compatible API。它适合在接入中转站、统一网关或自建代理前，快速核对模型列表、Chat Completions、响应模型声明、固定指令和 Token 字段。

> 本工具面向任意兼容服务，不属于 OpenAI、Anthropic、Google、DeepSeek 或其他模型厂商认证。检测结果描述当前接口的协议与行为，不单独证明底层模型身份。

## 为什么做成 CLI

- 可以放进 CI，在接口或路由调整后自动复测。
- API Key 只从环境变量读取，不进入命令历史和报告。
- Markdown 报告可直接附在 Issue、README 或技术评审中。
- 检测面向任意兼容服务，不要求使用 AI快站。

## 使用方法

需要 Node.js 20 或更新版本。

```bash
git clone https://github.com/KKWANG4444/openai-compatible-api-check.git
cd openai-compatible-api-check
```

```bash
export OPENAI_API_KEY="你的临时限额 Key"
node bin/model-api-check.mjs \
  --base-url https://api.example.com/v1 \
  --model your-model-id \
  --output reports/check.md
```

`--output` 的父目录不存在时会自动创建。命令仅在 Chat Completions 请求成功且随机 nonce 被原样返回时退出 `0`；接口返回成功但内容不匹配时退出 `1`，参数或运行配置错误时退出 `2`。

输出 JSON：

```bash
node bin/model-api-check.mjs \
  --base-url https://api.example.com/v1 \
  --model your-model-id \
  --format json
```

使用其他环境变量名：

```bash
export GATEWAY_TEST_KEY="你的临时限额 Key"
node bin/model-api-check.mjs \
  --base-url https://api.example.com/v1 \
  --model your-model-id \
  --key-env GATEWAY_TEST_KEY
```

## 检查项目

| 检查项 | 权重 | 说明 |
| --- | ---: | --- |
| 模型列表接口 | 15 | 检查 `GET /models` 是否可用 |
| 模型 ID 可发现 | 10 | 检查目标模型是否出现在模型列表 |
| Chat Completions | 30 | 检查基础调用、状态码与延迟 |
| 固定指令遵循 | 20 | 使用随机字符串降低固定答案适配 |
| 响应模型声明 | 15 | 核对请求模型与响应 `model` 字段 |
| Token 用量字段 | 10 | 检查是否返回可核对的非负整数 `total_tokens` |

整体成功条件比综合分更严格：Chat Completions 必须返回 HTTP 成功状态，并原样返回本轮随机 nonce。HTTP 200 但内容为空、被改写或不匹配时，命令仍退出 `1`。

## 安全边界

- 只接受 HTTPS 公网地址。
- 不接受命令行明文 API Key。
- 报告不会包含 API Key。
- 建议创建临时限额 Key，测试后立即撤销。
- 本工具不会绕过目标站点认证、限流或访问控制。

## 结果边界

这是一套协议与能力冒烟测试，不是模型厂商认证。网关可以改写 `model` 等元数据，单轮行为也可能受提示词、路由和采样影响。生产选型还需要多轮测试真实业务题集，并核对并发、错误率、延迟、账单和服务条款。

需要检测 SSE、工具调用、动态题、元数据和更完整的 Token 证据时，可使用免费的网页检测工具：

https://docs.aifast.club/model-check/

## 本地验证

```bash
npm run check
npm test
```

## Postman

导入 [`postman/OpenAI-Compatible-API-Smoke-Test.postman_collection.json`](postman/OpenAI-Compatible-API-Smoke-Test.postman_collection.json)，然后在 Collection Variables 中填写：

- `base_url`：公开 HTTPS Base URL，填写到 `/v1`。
- `api_key`：临时限额 API Key，变量类型保持 Secret。
- `model`：从目标服务商模型列表复制的真实模型 ID。

Collection 包含模型列表和 Chat Completions 两组请求。每轮请求都会生成新的随机 nonce，并精确核对返回内容，同时检查状态码、响应结构、模型声明和 Token 字段。公开或 Fork Workspace 前请确认 `api_key` 的 Current Value 没有被同步。

## 项目矩阵

| 需求 | 入口 |
| --- | --- |
| 浏览器里运行完整检测 | [大模型 API 中转站检测](https://docs.aifast.club/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-matrix) |
| 理解报告与检测边界 | [模型检测报告判读](https://kkwang4444.github.io/api-status/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-matrix) |
| OpenAI-compatible 迁移与排错 | [生产接入指南](https://github.com/KKWANG4444/llm-api-proxy-china) |
| Cursor、Dify、Claude Code 等配置 | [开发工具接入指南](https://github.com/KKWANG4444/ai-api-proxy-china-guide) |
| 模型目录、维护信息与证据 | [AI API 状态与证据中心](https://github.com/KKWANG4444/api-status) |

AI快站是上述在线工具与内容的维护方。需要比较备用线路或统一接入国内外模型时，可在完成自测后查看[模型与价格](https://www.aifast.club/pricing?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-matrix)。

## 安全问题

请不要在公开 Issue、日志或截图中提交真实 API Key。发现可能导致密钥泄露或请求越权的问题时，请使用 GitHub Security Advisory 私下报告。

## 许可证

MIT
