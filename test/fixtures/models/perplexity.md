> ## Documentation Index
> Fetch the complete documentation index at: https://docs.perplexity.ai/llms.txt
> Use this file to discover all available pages before exploring further.

# Agent API Models

> Compare Agent API models, token pricing, supported service tiers, and provider documentation.

> [!NOTE]
>
> Looking for ranked web results instead of a generated answer? Use the Search API at `POST /search`. It takes no `model` parameter and bills per successful request, not per token. Start with the [Search API quickstart](https://docs.perplexity.ai/docs/search/quickstart.md).

## Available Models

The Agent API provides a unified interface to models from multiple providers with transparent token-based pricing.

Pricing rates are published per model and may differ from provider list prices. All charges are based on actual token consumption, and every API response includes exact token counts so you know your costs per request.

The **Service tiers** column lists optional non-default tiers. An em dash means the model uses default processing only.

A rate with a context-length range, such as `(≤272k)`, changes when the input is above that range. A single value applies at every context length.

> [!TIP]
>
> Looking for pre-configured model setups? See [**Effort Levels**](https://docs.perplexity.ai/docs/agent-api/effort.md) — optimized for specific use cases.

> [tab] NVIDIA
>
> > [card] NVIDIA
> >
> > Nemotron 3.5 Super is a reasoning model with a 1,048,576-token context window and up to 131,072 output tokens. It accepts text input only.
>
> | Model | Input (\$/1M) | Output (\$/1M) | Cache read (\$/1M) | Service tiers | Docs |
> | - | - | - | - | - | - |
> | `perplexity/nemotron-3.5-super-120b-a12b` | 0.20 | 0.50 | 0.04 | — | — |

> [tab] Perplexity
>
> > [card] Perplexity
> >
> > Perplexity's grounded search model.
>
> | Model | Input (\$/1M) | Output (\$/1M) | Cache read (\$/1M) | Service tiers | Docs |
> | - | - | - | - | - | - |
> | `perplexity/sonar` | 0.25 | 2.50 | 0.0625 | — | — |

## Service tiers

Omit `service_tier`, or set it to `auto` or `default`, to use default processing. `flex` uses lower-cost, best-effort capacity at 0.5× the listed token prices. `priority` uses higher-priority processing at 2× the listed token prices. `fast` is accepted as an alias for `priority`. These multipliers apply only to models that list the tier in the **Service tiers** column. Other models always bill at the listed rate.
