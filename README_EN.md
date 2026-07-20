# OpenAI Compatible API Check: Methodology and Report Schema

[中文](README.md) · [English](README_EN.md) · [Run the online check](https://docs.aifast.club/en/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-en-language-nav)

This repository publishes selected protocol checks, report schemas, examples, and regression tests used to review the browser-based AIFast model quality checker. Regular users do not need to download a program or install Node.js.

> The checker is maintained by AIFast, but its scoring rules are provider-neutral. It is not an OpenAI, Anthropic, Google, DeepSeek, or model-vendor certification. A result describes protocol behavior, visible metadata, token fields, and sampled responses at one point in time. It cannot independently prove model identity or rule out capability degradation, impersonation, or dynamic routing.

## Use the Website

[Run the browser-based LLM API gateway check](https://docs.aifast.club/en/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-en-primary)

The website accepts public HTTPS OpenAI Compatible APIs and checks model declarations, token fields, randomized tasks, output behavior, knowledge-boundary signals, SSE, and tool calls. Use a temporary, low-limit API key and revoke it after testing.

[Read the report interpretation guide](https://docs.aifast.club/en/guides/model-check-report-guide/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-en-report-guide)

Codex custom providers use the Responses API and are outside the current Chat Completions browser test. Use the [Codex custom provider guide](https://docs.aifast.club/en/tools/codex/?utm_source=github&utm_medium=repository&utm_campaign=integration-guide&utm_content=source-en-codex) and [Codex gateway validation checklist](https://docs.aifast.club/en/troubleshooting/codex-gateway-checklist/?utm_source=github&utm_medium=repository&utm_campaign=integration-guide&utm_content=source-en-codex-checklist) instead.

## Evidence Covered by the Repository

| Check | Evidence retained |
| --- | --- |
| Model list | `GET /models` status and target model discovery |
| Chat Completions | Status, latency, and response structure |
| Protocol compliance | `id`, `object`, `created`, `choices`, `message`, and `finish_reason` |
| Instruction following | Exact randomized nonce return |
| Metadata fingerprint | Visible model, request ID, and system fingerprint fields |
| Model declaration | Requested and returned model text comparison |
| Token accounting | Non-negative integer fields and arithmetic consistency |
| Dynamic challenge | Randomized multi-step calculation and nonce match |

The online website performs additional checks, including output-style observations, knowledge-boundary prompts, SSE, and tool calls. Neither mode is a vendor identity certificate.

## Reproducible Artifacts

- [Methodology](docs/methodology.md)
- [JSON Schema v2](schema/report.schema.json)
- [Example JSON report](examples/report.example.json)
- [Report field reference](docs/report-schema.md)
- [Machine-readable summary](llms.txt)
- [Full machine-readable notes](llms-full.txt)

Model declarations, system fingerprints, and request IDs may be rewritten by a gateway. Treat them as cross-check signals rather than identity credentials. Remove business prompts, user data, and internal request IDs before publishing a report.

## Security Boundary

- Public targets must use HTTPS and resolve to public network addresses.
- URLs containing embedded credentials, query strings, or fragments are rejected.
- Never paste an API key into an Issue, screenshot, public log, or report.
- The checker does not bypass authentication, rate limits, or access controls.
- A passing test does not establish production reliability; test concurrency, sample size, error distribution, billing, and contractual terms separately.

## AIFast Technical Resources

- [Online model quality check](https://docs.aifast.club/en/model-check/?utm_source=github&utm_medium=repository&utm_campaign=model-check&utm_content=source-en-resource-check)
- [Base URL checker](https://docs.aifast.club/en/tools/base-url-checker/?utm_source=github&utm_medium=repository&utm_campaign=developer_acquisition&utm_content=source-en-base-url)
- [AIFast Developer Hub](https://github.com/KKWANG4444/aifast-developer-hub)
- [API integration guide](https://github.com/KKWANG4444/ai-api-proxy-china-guide/blob/main/README_EN.md)
- [Production troubleshooting guide](https://github.com/KKWANG4444/llm-api-proxy-china/blob/main/README_EN.md)
- [International payment and account setup](https://docs.aifast.club/en/payment/?utm_source=github&utm_medium=repository&utm_campaign=international-payment&utm_content=source-en-payment)

This repository is maintained by the operator of AIFast. Product statements, point-in-time test results, and contractual service levels are kept separate.
