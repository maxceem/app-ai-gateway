# Deprecations

## Upcoming deprecations

### 2026-08-26: Transcription models

On August 26, 2026, we notified developers using `whisper-1`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, and `gpt-4o-transcribe-diarize` of their deprecation and removal from the API on February 26, 2027.

For information about the recommended replacements, see the [transcription guide](https://developers.openai.com/api/docs/guides/transcription).

| Shutdown date | Model / system              | Recommended replacement                   |
| ------------- | --------------------------- | ----------------------------------------- |
| Feb 26, 2027  | `whisper-1`                 | `gpt-live-transcribe` or `gpt-transcribe` |
| Feb 26, 2027  | `gpt-4o-transcribe`         | `gpt-live-transcribe` or `gpt-transcribe` |
| Feb 26, 2027  | `gpt-4o-mini-transcribe`    | `gpt-live-transcribe` or `gpt-transcribe` |
| Feb 26, 2027  | `gpt-4o-transcribe-diarize` | `gpt-live-transcribe` or `gpt-transcribe` |

### 2026-06-11: GPT-5 and o3 model deprecations

On June 11, 2026, we notified developers using older GPT-5 and o3 model snapshots of their deprecation and removal from the API on December 11, 2026.

| Shutdown date | Model / system          | Recommended replacement               |
| ------------- | ----------------------- | ------------------------------------- |
| Dec 11, 2026  | `gpt-5-2025-08-07`      | `gpt-5.6-sol`                         |
| Dec 11, 2026  | `gpt-5-mini-2025-08-07` | `gpt-5.6-terra`                       |
| Dec 11, 2026  | `o3-pro-2025-06-10`     | `gpt-5.6-sol` (`reasoning.mode: pro`) |

### 2026-06-03: Reusable prompts

On June 3, 2026, we notified developers using reusable prompts in the dashboard and API that reusable prompt objects are being deprecated.

| Date         | Update                                                                       |
| ------------ | ---------------------------------------------------------------------------- |
| June 3, 2026 | Deprecation announced and prompt creation de-emphasized in the platform.     |
| Nov 30, 2026 | The `v1/prompts` API and reusable prompt objects are scheduled to shut down. |

To migrate, move reusable prompt content into your application code. See [Migrate from prompt objects](https://developers.openai.com/api/docs/guides/prompting/migrate-from-prompt-object).

## Past deprecations

### 2026-04-22: Legacy GPT model snapshots

To improve reliability and make it easier for developers to choose the right models, we are deprecating a set of older OpenAI models. Access to these models will be shut down on the dates below.

| Shutdown date    | Model snapshot                                                         | Substitute model                                  |
| ---------------- | ---------------------------------------------------------------------- | ------------------------------------------------- |
| October 23, 2026 | `gpt-4-1106-preview`                                                   | `gpt-5.6-sol`                                     |

### 2025-09-26: Legacy GPT model snapshots (March 2026 shutdown)

To improve reliability and make it easier for developers to choose the right models, we deprecated a set of older OpenAI models with declining usage. Access to these models was shut down on March 26, 2026.

| Shutdown date | Model / system                                                                                                             | Recommended replacement |
| ------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| 2026‑03‑26    | `gpt-4-0314`                                                                                                               | `gpt-5` or `gpt-4.1*`   |
| 2026‑03‑26    | `gpt-4-1106-preview`                                                                                                       | `gpt-5` or `gpt-4.1*`   |
