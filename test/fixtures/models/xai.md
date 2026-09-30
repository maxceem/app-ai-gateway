### Text API Pricing

| Model | Context | Input / 1M tokens | Cached input / 1M tokens | Output / 1M tokens |
| --- | --- | --- | --- | --- |
| grok-4.7 (< 200k prompt tokens) | 500k | $2.00 | $0.50 | $6.00 |
| grok-4.7 (≥ 200k prompt tokens) | 500k | $4.00 | $1.00 | $12.00 |
| grok-4.5 (< 200k prompt tokens) | 500k | $2.00 | $0.30 | $6.00 |
| grok-4.5 (≥ 200k prompt tokens) | 500k | $4.00 | $0.60 | $12.00 |
| grok-4.3 (< 200k prompt tokens) | 1M | $1.25 | $0.20 | $2.50 |
| grok-4.3 (≥ 200k prompt tokens) | 1M | $2.50 | $0.40 | $5.00 |
| grok-4.20-0309-reasoning (< 200k prompt tokens) | 1M | $1.25 | $0.20 | $2.50 |
| grok-4.20-0309-reasoning (≥ 200k prompt tokens) | 1M | $2.50 | $0.40 | $5.00 |
| grok-build-0.1 (< 200k prompt tokens) | 256k | $1.00 | $0.20 | $2.00 |
| grok-build-0.1 (≥ 200k prompt tokens) | 256k | $2.00 | $0.40 | $4.00 |

*Prices shown per million tokens. Models listed with two rows use long context pricing: requests whose prompt reaches the listed token threshold are billed at the higher rate for all tokens in the request.*

### Imagine Pricing

| Model | Cost |
| --- | --- |
| grok-imagine-image | $0.02 / image |
| grok-imagine-video | $0.050 / sec |

### Voice Pricing

| Mode | Cost |
| --- | --- |
| Speech to Speech (grok-voice-think-fast-2.0) | $0.08 / min ($4.80 / hr)<br />$0.004 / text input |
| Speech to Text | $0.10 / hr (REST), $0.20 / hr (Streaming) |
| Text to Speech | $15.00 / 1M chars |
