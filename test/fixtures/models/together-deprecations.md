# Deprecations

## Scheduled deprecations

The following models are deprecated and will be removed from serverless inference on the date listed. Migrate to the recommended replacement or a [dedicated endpoint](/docs/dedicated-endpoints) before that date.

| Removal date | Model | Recommended replacement | Supported by on-demand dedicated endpoints |
| :- | :- | :- | :- |
| 2026-09-14 | `openai/gpt-oss-20b` | `Qwen/Qwen3.5-9B` | Yes |
| 2026-09-14 | `google/gemma-4-31B-it` | `zai-org/GLM-5.3-Flash` | Yes |
| 2026-09-14 | `thinkingmachines/Inkling-Small` | `zai-org/GLM-5.3-Flash` | Yes |

## Deprecation history

### Inference

The table below lists all models removed from serverless inference, most recent first.

| Removal date | Model | Supported by on-demand dedicated endpoints |
| :- | :- | :- |
| 2026-09-15 | `google/gemma-4-31B-it` | Yes |
| 2026-08-19 | `moonshotai/Kimi-K2.6` | Yes |
| 2026-04-16 | `Qwen/Qwen3-235B-A22B-Thinking-2507` | Yes |
| 2026-03-06 | `Qwen/Qwen3-235B-A22B-Thinking-2507` | Yes |
| **Notes on model support:** | | |

* The support column reflects the current [supported models](/docs/dedicated-endpoints/models) catalog for dedicated model inference and is updated automatically as the catalog changes.
* Models marked "Yes" can be deployed as on-demand dedicated endpoints, either under the listed ID or as the underlying base model of a serving variant (for example, a deprecated `-FP8` or `-Turbo` ID).
* Models marked "No" are not available as on-demand endpoints and require migration to a different model or a monthly reserved dedicated endpoint.

### Fine-tuning

The table below lists all models removed from the fine-tuning service, most recent first. These models can no longer be used as a base model for a fine-tuning job. Where a close equivalent exists, the suggested replacement is listed. A blank cell means there is no direct equivalent. See [Supported models](/docs/fine-tuning/supported-models) for the full list of models available today.

| Removal date | Model | Suggested replacement |
| :- | :- | :- |
| 2026-07-29 | `nvidia/NVIDIA-Nemotron-Nano-9B-v2` | `Qwen/Qwen3.5-9B` |
