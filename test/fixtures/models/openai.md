# Pricing

> For the complete documentation index, see [llms.txt](/llms.txt). Markdown versions of documentation pages are available by appending `.md` to the page URL.

<a id="astra"></a>
<a id="latest-models"></a>

Flagship models

  
Speed

    Prices per 1M tokens.

Standard

      
### Standard pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-6-astra | $10.00 | $50.00 | $1.00 | $12.50 | $25.00 | $20.00 | $75.00 | $2.00 | $25.00 | $50.00 |
| gpt-5.6-sol | $4.00 | $20.00 | $0.40 | $5.00 | $10.00 | $8.00 | $30.00 | $0.80 | $10.00 | $20.00 |
| gpt-5.5 (<272K context length) | $5.00 | $30.00 | $0.50 | - | - | $10.00 | $45.00 | $1.00 | - | - |
| gpt-5.5-pro (<272K context length) | $30.00 | $180.00 | - | - | - | $60.00 | $270.00 | - | - | - |

| Model | Input | Output | Cached input |
| --- | --- | --- | --- |
| gpt-5.4-mini | $0.75 | $4.50 | $0.075 |
| gpt-5.2-pro | $21.00 | $168.00 | - |
| gpt-4o | $2.50 | $10.00 | $1.25 |

    

      
Batch

      
### Batch pricing data

#### Batch

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $2.00 | $10.00 | $0.20 | $2.50 | $5.00 | $4.00 | $15.00 | $0.40 | $5.00 | $10.00 |

      
Fast

      
### Fast pricing data

| Model | Short context input | Short context output | Short context cached input | Short context 30m write | Short context 12h write | Long context input | Long context output | Long context cached input | Long context 30m write | Long context 12h write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $8.00 | $40.00 | $0.80 | $10.00 | $20.00 | $16.00 | $60.00 | $1.60 | $20.00 | $40.00 |

Short context: ≤272K input tokens. Long context: >272K input tokens.

Regional processing (data residency) endpoints are charged a 10% uplift for models released on or after March 5, 2026.

Multimodal models

  
Prices per 1M tokens unless noted.

    

Images

  
Speed

Standard

      
### Grouped Pricing Table data

| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-image-2 | Image | $8.00 | $30.00 | $2.00 |
| gpt-image-2 | Text | $5.00 | - | $1.25 |
| gpt-image-1.5 | Image | $8.00 | $32.00 | $2.00 |
| gpt-image-1.5 | Text | $5.00 | $10.00 | $1.25 |
| gpt-image-1-mini | Image | $2.50 | $8.00 | $0.25 |
| gpt-image-1-mini | Text | $2.00 | - | $0.20 |
| chatgpt-image-latest | Image | $8.00 | $32.00 | $2.00 |
| chatgpt-image-latest | Text | $5.00 | $10.00 | $1.25 |

Cached input rates for GPT Image 2 and GPT Image 2.5 only apply to images generated with the Responses API. [Learn more](https://developers.openai.com/api/docs/guides/image-generation#cached-input-pricing).

      
Batch

      
### Grouped Pricing Table data

| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-image-2 | Image | $4.00 | $15.00 | $1.00 |
| gpt-image-2 | Text | $2.50 | - | $0.625 |

For image generation cost estimates, use the [calculator in the image generation guide](https://developers.openai.com/api/docs/guides/image-generation#calculating-costs).

  

Audio

Realtime & Audio

### Grouped Pricing Table data

| Model | Modality | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| gpt-realtime-2 | Audio | $32.00 | $64.00 | $0.40 |
| gpt-realtime-2 | Text | $4.00 | $24.00 | $0.40 |
| tts-1 | Text | $15.00 / 1M characters | - | - |

  

Transcription

### Grouped Pricing Table data

| Model | Use case | Input | Output | Estimated cost |
| --- | --- | --- | --- | --- |
| gpt-live-transcribe | Live transcription | - | - | $0.017 / minute |
| gpt-transcribe | Transcription | - | - | $0.0045 / minute |
| gpt-4o-transcribe | Transcription | $2.50 | $10.00 | $0.006 / minute |
| Whisper | Transcription | - | - | $0.006 / minute |

  

    

Specialized models

  
Speed

    Prices per 1M tokens.

Standard

      
### Grouped Pricing Table data

| Category | Model | Input | Output | Cached input | 30m write | 12h write |
| --- | --- | --- | --- | --- | --- | --- |
| <a id="cyber-models"></a>Cyber — Trusted Access: [Daybreak](https://openai.com/daybreak/) | gpt-6-cyber (short context) | $20.00 | $100.00 | $2.00 | $25.00 | $50.00 |
| Cyber — Trusted Access: [Daybreak](https://openai.com/daybreak/) | gpt-6-cyber (long context) | $40.00 | $150.00 | $4.00 | - | - |
| Cyber — Trusted Access: [Daybreak](https://openai.com/daybreak/) | gpt-5.6-cyber (short context) | $12.50 | $75.00 | $1.25 | $15.625 | $31.25 |
| Cyber — Trusted Access: [Daybreak](https://openai.com/daybreak/) | gpt-5.6-cyber (long context) | - | - | - | - | - |
| <a id="life-sciences-models"></a>Life Sciences — Trusted Access: [Rosalind](https://help.openai.com/en/articles/20001193-gpt-rosalind-for-life-sciences-research) | gpt-6-rosalind (short context) | $15.00 | $75.00 | $1.50 | $18.75 | $37.50 |
| Life Sciences — Trusted Access: [Rosalind](https://help.openai.com/en/articles/20001193-gpt-rosalind-for-life-sciences-research) | gpt-6-rosalind (long context) | $30.00 | $112.50 | $3.00 | $37.50 | $75.00 |
| Life Sciences — Trusted Access: [Rosalind](https://help.openai.com/en/articles/20001193-gpt-rosalind-for-life-sciences-research) | gpt-rosalind-research (short context) | $5.00 | $25.00 | $0.50 | - | - |
| Life Sciences — Trusted Access: [Rosalind](https://help.openai.com/en/articles/20001193-gpt-rosalind-for-life-sciences-research) | gpt-rosalind-research (long context) | - | - | - | - | - |
| <a id="legal-model-configurations"></a>Legal | gpt-6-astra-law | $10.00 | $50.00 | $1.00 | - | - |
| ChatGPT | chat-latest | $5.00 | $30.00 | $0.50 | - | - |
| Codex | gpt-5.3-codex | $1.75 | $14.00 | $0.175 | - | - |
| Embedding | text-embedding-3-small | $0.02 | - | - | - | - |
| Moderation | omni-moderation-latest | Free | - | - | - | - |

GPT-6 Astra for Law promotional pricing is available at least through December 31, 2026.

    

      
Fast

      
### Grouped Pricing Table data

| Category | Model | Input | Output | Cached input |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $3.50 | $28.00 | $0.35 |

Tools

### Grouped Pricing Table data

| Tool | Details | Pricing |
| --- | --- | --- |
| File search | Tool call | $2.50 / 1k calls |
