# 大模型 API 在线检测：规则与技术实现

<p align="center"><img src="assets/social-preview.png" width="100%" alt="OpenAI Compatible API 模型检测：协议、元数据、Token、输出风格、cutoff 与动态题"></p>

[![CI](https://github.com/KKWANG4444/openai-compatible-api-check/actions/workflows/ci.yml/badge.svg)](https://github.com/KKWANG4444/openai-compatible-api-check/actions/workflows/ci.yml)
[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2F22%2F24-339933)](https://nodejs.org/)
[![Report Schema v2](https://img.shields.io/badge/report-schema%20v2-2563eb)](schema/report.schema.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![在线检测](https://img.shields.io/badge/在线检测-10%20个维度-0f766e)](https://docs.aifast.club/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-badge)

本仓库公开在线检测使用的部分协议检查规则、报告结构和回归测试，供技术审计与方法复核。普通用户无需下载程序、安装 Node.js 或离开网站。

> 本工具由 AI快站维护，但检测计分与服务商无关。它不是 OpenAI、Anthropic、Google、DeepSeek 或其他模型厂商认证；结果只能描述检测时点的接口协议、可见元数据、Token 字段与行为样本，不能单独证明底层模型身份，也不能排除降智、套壳或动态路由。

## 直接在网站检测

[立即运行大模型 API 中转站检测](https://docs.aifast.club/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-readme-primary)

网站支持公开 HTTPS OpenAI Compatible API，可检查模型声明、Token、随机动态题、输出风格、知识边界、SSE 和工具调用，并继续查看分项结果。

[查看检测报告判读教程](https://docs.aifast.club/guides/model-check-report-guide/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-readme-report-guide)

## 九项快速检查

| 检查项 | 权重 | 采集的证据 |
| --- | ---: | --- |
| 模型列表接口 | 10 | `GET /models` 状态码 |
| 模型 ID 可发现 | 5 | 目标模型是否出现在列表 |
| Chat Completions | 15 | 基础调用状态码和延迟 |
| 协议层合规 | 15 | `id`、`object`、`created`、`choices`、`message`、`finish_reason` |
| 固定指令遵循 | 15 | 本轮随机字符串是否被原样返回 |
| 元数据指纹 | 10 | model、request ID、system fingerprint 等可见线索 |
| 响应模型声明一致 | 10 | 请求与响应的 `model` 文本是否一致 |
| 计费 Token 字段 | 10 | 输入、输出和总 Token 是否为非负整数且算术一致 |
| R1 动态题 | 10 | 每轮随机多步计算答案与 nonce 是否精确匹配 |

具体证据含义、计分方式和模型真伪判断边界见[检测方法论](docs/methodology.md)。

## 网站检测与技术证据

| 模式 | 请求量 | 适合场景 | 能力边界 |
| --- | ---: | --- | --- |
| [在线标准检测](https://docs.aifast.club/model-check/) | 约 7 | 普通用户与开发者 | 10 个维度，包含输出风格、知识边界、SSE、工具调用等证据 |
| 仓库回归测试 | 3 | 维护者审查规则 | 9 项协议与行为检查，用于防止检测逻辑回归 |

网站结果用于兼容性与风险筛查，不是模型厂商认证。不同时间、地区、模型和参数的结果不应直接横向比较。

## 报告与证据复用

- [JSON Schema v2](schema/report.schema.json)
- [示例 JSON 报告](examples/report.example.json)
- [报告字段说明](docs/report-schema.md)
- [检测方法论](docs/methodology.md)
- [机器可读摘要](llms.txt)
- [机器可读完整说明](llms-full.txt)

公开报告前请移除业务输入、用户数据和可关联内部系统的 request ID。模型声明、system fingerprint 与 request ID 都可能被网关改写，应作为交叉核对线索，而不是身份凭证。

## 安全与使用边界

- 公开目标只接受 HTTPS，不接受 URL 内嵌账号、密码、查询参数或片段。
- 在线检测只接受公网可解析的 HTTPS 目标，不接受本机、私网、链路本地及保留地址。
- 不要在 Issue、截图或公开报告中提交 API Key；建议使用临时限额 Key 并在检测后撤销。
- 工具不会绕过认证、限流或访问控制。
- 单轮通过不代表生产稳定；应继续测试并发、样本量、成功率、P50/P95、状态码分布、账单和服务条款。
- 发现密钥泄露、请求越权等问题时，请使用 GitHub Security Advisory 私下报告。

## AI快站技术矩阵

| 需求 | 入口 |
| --- | --- |
| 检测、迁移、排错与工具配置总入口 | [AI快站开发者中心](https://github.com/KKWANG4444/aifast-developer-hub) |
| 浏览器运行 10 维标准检测 | [大模型 API 中转站检测](https://docs.aifast.club/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=cli-readme-online-check) |
| 判读检测报告与风险边界 | [网站报告判读](https://docs.aifast.club/guides/model-check-report-guide/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-matrix-report-guide) |
| OpenAI Compatible 迁移与排错 | [生产接入与 API Doctor](https://github.com/KKWANG4444/llm-api-proxy-china) |
| Cursor、Dify、Claude Code 等配置 | [开发工具接入指南](https://github.com/KKWANG4444/ai-api-proxy-china-guide) |
| 成功率、P50/P95 与错误分布 | [稳定性监控方法](https://github.com/KKWANG4444/AI-API-Stability-Tracker) |
| 500+ 模型目录、维护信息与证据 | [AI API 状态与证据中心](https://github.com/KKWANG4444/api-status) |

AI快站提供 500+ 国内外模型统一接入、国外模型国内直连、高速稳定线路、99% 模型可用性目标和企业发票支持。需要实际接入时，请以[官网](https://www.aifast.club/?utm_source=github&utm_medium=repository&utm_campaign=integration-guide&utm_content=cli-readme-footer-website)与[控制台模型价格](https://www.aifast.club/pricing?utm_source=github&utm_medium=repository&utm_campaign=integration-guide&utm_content=cli-readme-footer-pricing)的当前展示为准。

## 本地验证

```bash
npm ci
npm run verify
```

该命令仅供仓库维护者验证检测规则和报告结构，不是普通用户的使用入口。公开检测统一使用网站页面。

## 许可证

MIT
