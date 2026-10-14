## Chat models

| Organization | Model name | API model string | Context length | Input pricing (per 1M tokens) | Cached input pricing (per 1M tokens) | Output pricing (per 1M tokens) | Quantization | Function calling | Structured outputs |
| :- | :- | :- | :- | :- | :- | :- | :- | :- | :- |
| Moonshot | Kimi K3 | moonshotai/Kimi-K3 | 1048576 | \$3.00 | \$0.30 | \$15.00 | - | Yes | Yes |
| Z.ai | GLM-5.3 | zai-org/GLM-5.3 | 1048575 | \$1.40 | \$0.26 | \$4.40 | FP4 | Yes | Yes |
| OpenAI | GPT-OSS 120B | openai/gpt-oss-120b | 131072 | \$0.15 | - | \$0.60 | MXFP4 | Yes | Yes |
| DeepSeek | DeepSeek V4 Pro 0813 | deepseek-ai/DeepSeek-V4-Pro-0813 | 1048576 | \$1.32 | \$0.13 | \$3.96 | NVFP4 | Yes | Yes |
| Meta | Llama 3.3 70B Instruct Turbo | meta-llama/Llama-3.3-70B-Instruct-Turbo | 131072 | \$1.04 | - | \$1.04 | FP8 | Yes | Yes |
| Prism ML | Ternary Bonsai 27B | Prism-ML/Ternary-Bonsai-27B | 262144 | Free | - | Free | - | - | - |

## Image models

Use our [Images](/reference/post-images-generations) endpoint for image models. Calling image models requires a positive credit balance.

<Note>
  Prices for models billed by `image` are estimates, not rates. Models billed by `megapixel` use the [formula below](#per-megapixel-cost-formula).
</Note>

| Organization | Model name | Model string for API | Unit | Price | Output per \$1 |
| :- | :- | :- | :- | :- | :- |
| Black Forest Labs | Flux1.1 \[pro] | black-forest-labs/FLUX.1.1-pro | `megapixel` | \$0.04 | 25 megapixels |
| OpenAI | GPT Image 2 | openai/gpt-image-2 | `image` | \$0.053+ ([varies](/docs/serverless/overview#how-image-models-bill)) | 19 images |

## Vision models
