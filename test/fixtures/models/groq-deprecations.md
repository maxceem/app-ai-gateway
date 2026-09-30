## [Deprecation History](#deprecation-history)

### [September 14, 2026: qwen/qwen3.6-27b](#september-14-2026-qwenqwen3627b)

In line with our commitment to bringing you cutting-edge models, we announced the deprecation of `qwen/qwen3.6-27b` in favor of `qwen/qwen3.8-27b`. Qwen 3.8 27B is the direct successor: a 27B multimodal model with the same 131K context window, thinking and instruct modes, tunable reasoning effort, tool use, and JSON mode. This deprecation applies to free and developer-tier usage; enterprise customers with a committed-spend contract are not affected.

| Deprecated Model | Shutdown Date | Recommended Replacement Model ID |
| ---------------- | ------------- | -------------------------------- |
| qwen/qwen3.6-27b | 09/14/26      | qwen/qwen3.8-27b                 |

### [August 16, 2026: llama-3.1-8b-instant and llama-3.3-70b-versatile](#august-16-2026-llama318binstant-and-llama3370bversatile)

In line with our commitment to bringing you cutting-edge models, on June 17, 2026, we emailed users to announce the deprecation of `llama-3.1-8b-instant` and `llama-3.3-70b-versatile`. We recommend migrating to `openai/gpt-oss-20b` (for Llama 3.1 8B Instant) and `openai/gpt-oss-120b` or `qwen/qwen3.6-27b` (for Llama 3.3 70B Versatile), which deliver exceptional performance with faster inference. This deprecation applies to free and developer-tier usage; enterprise customers with a committed-spend contract are not affected.

| Deprecated Model        | Shutdown Date | Recommended Replacement Model ID        |
| ----------------------- | ------------- | --------------------------------------- |
| llama-3.1-8b-instant    | 08/16/26      | openai/gpt-oss-20b                      |
| llama-3.3-70b-versatile | 08/16/26      | openai/gpt-oss-120b or qwen/qwen3.6-27b |

### [April 14, 2025: Multiple Model Deprecations](#april-14-2025-multiple-model-deprecations)

In line with our commitment to bringing you cutting-edge models, on April 7, 2025, we emailed users to announce the deprecation of several older preview models in favor of Meta's Llama 4 suite. The new Llama 4 Scout and Maverick models deliver exceptional multimodal performance that outpaces our previous offerings, enabling your applications to harness state-of-the-art AI capabilities with unparalleled speed on our platform.

| Deprecated Model                      | Shutdown Date | Recommended Replacement Model ID                                  |
| ------------------------------------- | ------------- | ----------------------------------------------------------------- |
| llama-3.3-70b-specdec                 | 04/14/25      | meta-llama/llama-4-scout-17b-16e-instruct llama-3.3-70b-versatile |
| deepseek-r1-distill-llama-70b-specdec | 04/14/25      | deepseek-r1-distill-llama-70b deepseek-r1-distill-qwen-32b        |

### [March 24, 2025: DeepSeek R1 Distill Llama 70B (Speculative Decoding)](#march-24-2025-deepseek-r1-distill-llama-70b-speculative-decoding)

On March 17, 2025, we emailed all users of the `deepseek-r1-distill-llama-70b-specdec` model that we would be deprecating this model ID in favor of our standard DeepSeek R1 Distill Llama 70B model and the DeepSeek R1 Distill Qwen 32B reasoning model, both of which are more popular with our users for their performance.

| Model ID                              | Shutdown Date | Recommended Replacement Model ID                           |
| ------------------------------------- | ------------- | ---------------------------------------------------------- |
| deepseek-r1-distill-llama-70b-specdec | 03/24/25      | deepseek-r1-distill-llama-70b deepseek-r1-distill-qwen-32b |

### [January 6, 2025: Llama 3 Groq Tool Use Models](#january-6-2025-llama-3-groq-tool-use-models)

On January 6th, we deprecated our preview versions of Llama 3 fine-tuned for tool use, `llama3-groq-8b-8192-tool-use-preview` and `llama3-groq-70b-8192-tool-use-preview`, from GroqCloud™ in favor of transitioning users to our production-ready `llama-3.30-70b-versatile` model.

Users of the tool use models were notified about the upcoming deprecation via email. The recommended replacement model, `llama-3.3-70b-versatile`, offers superior tool use capabilities and we strongly encourage users to migrate applications to this model for improved reliability and performance.

| Model ID                              | Shutdown Date | Recommended Replacement Model ID |
| ------------------------------------- | ------------- | -------------------------------- |
| llama3-groq-8b-8192-tool-use-preview  | 1/6/25        | llama-3.3-70b-versatile          |
| llama3-groq-70b-8192-tool-use-preview | 1/6/25        | llama-3.3-70b-versatile          |
