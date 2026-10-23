# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - 2026-10-23

### Changed

- The exported `EnforcementRule` type changed shape: it now carries a required `filters` array, and the `subscriberId`, `productName`, `model` and `provider` fields the parse step never populated were removed. Code that only reads cost controls through `getRules()` keeps compiling; code that constructs an `EnforcementRule` literal must add `filters`, typed by the newly exported `EnforcementFilter`, and drop the four removed fields. This is a breaking type-surface change and needs a major release
- `trackImageUsageAsync`, exported from the `./openai` subpath, gained a trailing optional `extra` carrying the streamed-image fields (`isStreamed`, `timeToFirstToken`, `stopReason`, `completedImageCount`, token counts). The existing positional parameters are unchanged, so current callers keep working

### Fixed

- A cost control scoped to one provider, model, agent or product blocked every chat completion in the account once it was breached, including the traffic it was never meant to cover. The SDK read a cost control's threshold and breach flag but never its `filters[]`, so a cap written for, say, Anthropic spend refused OpenAI calls too, and the only workaround was deleting the cap. A cost control now acts only on the calls its filters cover: rows compose with AND, a cost control with no filters still covers every call, and `MODEL`, `PROVIDER`, `AGENT`, `PRODUCT`, `TASK_TYPE`, `ORGANIZATION`, `SUBSCRIBER` and `CREDENTIAL` are matched the way the platform matches them, with `PROVIDER` compared ignoring letter case and a subscriber supplied as an email compared on its normalized form. A filter row the SDK cannot evaluate — any other dimension, including `DEPARTMENT` outside a department block, or an unknown operator — makes the cost control block nobody client-side and leaves it to the platform, which still enforces it server-side, and is now named in a warning at poll time instead of failing open silently. Enforcement criteria now also carry the agent, task type, organization and the subscriber credential's alias name, and fall back to `productId` / `organizationId` exactly as the metered record does, so a cap filters on what the platform counts. A department-scoped cost control is filter-gated the same way: the server has already resolved its `DEPARTMENT` row by naming the caller, so that row is skipped and the remaining rows decide, which stops a department cap scoped to one provider or model from refusing the department's other traffic. On upgrade, a filtered cost control stops refusing traffic outside its scope and keeps refusing traffic inside it; unfiltered, team-wide and per-person cost controls behave exactly as before. Filter gating applies where enforcement runs today, which is OpenAI and Azure OpenAI chat completions; the other providers and the remaining OpenAI surfaces are still ungated and are enforced server-side only

- Streamed Azure OpenAI chat completions were metered under the deployment name, so the records never matched a price list entry and the spend landed unpriced. The streaming wrapper sent the model string the caller passed, which on Azure is the deployment name, while the non-streamed path has always sent the model the provider reported. The first non-empty `model` a chunk carries is now metered, so a deployment's streamed and non-streamed traffic meter under the same provider model; a leading Azure `prompt_filter_results` chunk carrying no model is skipped, a later chunk reporting a different or empty model cannot overwrite the first one, and the abandoned (`CANCELLED`) and failed (`ERROR`) paths carry the same model. When no chunk reports a model, the requested model is still metered. Plain OpenAI streams are affected too: they now meter under the dated model the chunks report (`gpt-4o-2024-08-06`) rather than the requested alias (`gpt-4o`), which is what the non-streamed path already sent. Azure image and audio records still carry the deployment name: neither the images response nor the transcription response carries a model, and the middleware has no deployment-to-model mapping to resolve it from, so fixing those paths needs a separate change

- Tool calls metered inside a `JobContext` were never tied to the job, and no tool call could carry a cost, so job cost and ROI left out every Node tool. `meterTool` and `reportToolCall` now send the job id at the top level of the tool event, resolved exactly as completions resolve it — per-call `agenticJobId` (or `usageMetadata.agenticJobId`) over the active job context, job context over `REVENIUM_AGENTIC_JOB_ID` — and a job id the metering API would reject is dropped with a warning and the next source in that order is used, rather than failing the tool call. Both entry points also accept an optional `costUsd`, sent as a top-level field and charged instead of the tool's price configured in Revenium, including when it is `0`; a negative or non-finite value is dropped with a warning and the configured price applies. On upgrade, tool events emitted inside a job start being attributed to it; a tool call made outside any job and without a cost meters exactly as before

- The advertised automatic `.env` loading never ran for most consumers and, when it did run, also read a `.env` from the directory above the application. Loading went through an optional `dotenv` resolved at runtime, but `dotenv` has only ever been a devDependency, so under ESM, bundlers and `pnpm`'s strict `node_modules` the resolution failed and the files were silently skipped - `Initialize()` threw for an application whose keys lived only in its own `.env`. The middleware now parses `.env.local` and `.env` itself, with no third-party module involved, so behaviour is identical under ESM, CommonJS and every installer layout, and the package keeps zero runtime dependencies. Existing `.env` files parse exactly as `dotenv@16` parsed them, and a file that cannot be read now produces a warning instead of being swallowed; a readable file whose content is malformed yields no keys, exactly as `dotenv` behaved. On upgrade, a `.env` in the parent of the working directory is no longer read: an application that relied on a monorepo-root `.env` must either start its process in the directory holding that file or set the variables in the real environment. Real environment variables still win over file values, and `.env.local` still wins over `.env`

- OpenAI speech-to-text and text-to-speech calls reached Revenium priced at zero: the metering payload carried the billing unit only inside `attributes`, where the platform never reads it, so no pricing dimension was ever selected; and the transcription duration was read from `response.duration`, a field only `response_format: "verbose_json"` returns, so a default-format transcription was metered as zero seconds. The resolved unit is now sent as a top-level `billingUnit` (`PER_SECOND`, `PER_CHARACTER` or `PER_TOKEN`) on both the OpenAI and fal audio paths, replacing the unread `attributes.billing_unit` copy, and the billable quantity is read from the `usage` object OpenAI now returns on every transcription, falling back to `response.duration`. Transcription and translation are mapped to `PER_SECOND`, matching the unit the platform syncs for whisper pricing, where they previously claimed `per_minute` in `attributes`. Transcriptions the provider meters in tokens (the `gpt-4o-transcribe` family) bill `PER_TOKEN` and carry `inputAudioTokenCount` plus the full `inputTokenCount` / `outputTokenCount`; `outputAudioTokenCount` is deliberately left unset, since the output of a transcription is text and pricing it at the audio-input rate would overcharge. A transcription whose token usage arrives without an audio-token breakdown keeps its duration-based unit and logs a warning rather than billing its text tokens at the audio rate. On upgrade, non-streamed transcriptions that previously cost zero start being priced; `audio.translations` and streamed transcriptions report no billable quantity of their own and still meter at zero seconds. A `verbose_json` transcription meters exactly as before apart from the added `billingUnit`, and a transcription returning plain text (`response_format: "text" | "srt" | "vtt"`) meters without throwing

- Streamed OpenAI image calls were metered as zero images and no tokens: `images.generate`/`images.edit` with `stream: true` were metered the moment the stream opened, with the SDK stream object passed where the response was expected, producing a record with `actualImageCount: 0`, `attributes.actual_image_count: 0`, `isStreamed: false`, null token counts and a duration covering only the time to first byte. The record is now sent once the stream finishes and carries the number of completed images, the token usage reported by the completion events, time to first image and the duration of the whole stream, with `isStreamed: true`. A stream the caller abandons meters as `CANCELLED` and one that throws as `ERROR`, both keeping the images completed before the stream ended. On upgrade, metered image counts and image cost rise for streamed traffic; non-streamed image calls meter exactly as before

- Gemini thinking tokens were never priced: the Google emitter metered only `candidatesTokenCount` as output while the thinking tokens were reported separately as `reasoningTokenCount`, which the metering API treats as an informational breakdown and never prices, so a thinking call was billed at a fraction of what Google charges. The metered output count now includes the thinking tokens (`candidatesTokenCount + thoughtsTokenCount`), matching Anthropic, OpenAI and LiteLLM, where reasoning has always been part of the output count, and restoring `inputTokenCount + outputTokenCount === totalTokenCount` on calls where Google reports no tool-use tokens (`toolUsePromptTokenCount` is additive to Google's total and is still not metered). `reasoningTokenCount` keeps its current value and stays a subset of the output count, never an additional priced leg. On upgrade, metered output tokens and cost rise for Gemini traffic that uses thinking; calls with no thinking tokens meter exactly as before. On streamed Gemini calls the token counts reported by earlier chunks now survive a final chunk that omits them or reports them as zero, so the thinking leg is no longer dropped from the billed output
- Gemini embeddings were metered as zero input tokens, and therefore at zero cost: the Google embedding reply carries no `usageMetadata`, and the emitter defaulted the missing prompt count to `0`. The input count is now resolved with `client.models.countTokens()` for both the AI Studio and the Vertex AI paths, so embedding traffic is metered and priced on its real token volume; metered embedding tokens and cost rise on upgrade. When no count can be obtained — the provider reports none and `countTokens` is unavailable or fails — the record is now sent with a `null` input and total count ("unknown") instead of claiming a zero, and the console usage summary prints `unknown` for such a count. Each embedding call now makes one additional `countTokens` call against the same Google quota. `createEmbedding()` keeps returning `usageMetadata`, but its `promptTokenCount` and `totalTokenCount` are now `undefined` when the provider reports none, where they were previously `0`; a caller doing arithmetic on those fields must guard for `undefined`

## [1.3.1] - 2026-10-14

### Fixed

- Cached Claude tokens were billed twice on the LiteLLM path. LiteLLM's Anthropic transformer folds both cache legs into `prompt_tokens` (`input_tokens + cache_creation + cache_read`) and the emitter billed that total as-is, so every cache read and cache write was charged once at its cached rate and again at the uncached input rate. The folded legs are now removed from the prompt total before metering, and the de-fold is decided from the model family — read from the model the response reports, falling back to the request alias — so Claude behind a proxy alias or reported in the OpenAI shape is de-folded too, while Gemini, whose transformer does not fold, is left alone. Cache-creation tokens are now also split into their 5-minute and 1-hour TTL buckets, and streamed usage details are merged field by field so a later chunk that omits or zeroes a cache, TTL or reasoning count can no longer erase an earlier report
- A single breached budget rule blocked every caller in the account rather than the person it covered. The matching path compared rule criteria the parse step never populates, so every rule matched every call and any breached `BLOCK` rule raised `CostLimitExceeded` for unrelated subscribers. Rules are now scoped to the caller they cover, matched on both the raw subscriber id and the normalized email, because department-block rows are keyed by the normalized identity while `groupBreakdown` rows keep the exact value the server sent. When one person owns more than one row, any breached row still blocks and the largest figure is the one reported
- Enforcement rules were never loaded on a default install: the rules URL was built by appending `/v2/api/ai/enforcement-rules/<teamId>` to the configured base, omitting the `/profitstream` service segment the endpoint lives under, so the default `https://api.revenium.ai` host produced a 404 and cost controls stayed silently inactive. A base already carrying extra service or version segments duplicated them instead, and only a base ending exactly in `/profitstream` produced a working URL. The service prefix is now stripped from the base before `/profitstream/v2/api/ai/enforcement-rules/<teamId>` is appended, and a single-label internal host keeps its name. A rejected poll now logs which environment variables to check and whether cost controls are loaded; a `429` backs polling off for the interval the server asks for, capped, and that backoff now applies to the first scheduled poll instead of being skipped; `408` is treated as transient; and stopping polling clears the cache even when no poll was pending
- Following the README's LiteLLM setup produced no metering records at all. The LiteLLM path read only `REVENIUM_METERING_API_KEY`, never loaded `.env` files and never installed the shared Revenium configuration, so the documented `REVENIUM_API_KEY` setup metered nothing. Setup now goes through the shared loader: `REVENIUM_API_KEY` is accepted when the metering-specific key is absent, `.env` files are loaded, and the configuration present before setup is captured and restored on `reset()` rather than left cleared. While the LiteLLM middleware is installed it still owns the shared Revenium key and base URL, so a process metering several providers against different Revenium destinations sends all of them to LiteLLM's until reset. An invalid API key is reported once at setup and the HTTP client is left unpatched, a malformed `REVENIUM_MAX_RETRIES` is ignored with a warning instead of dropping the record, and a missing proxy URL names every accepted variable in a single warning
- A streamed OpenAI chat completion that drained to the end was always metered as `END`, whatever the provider reported: the streaming wrapper passed a hardcoded `null` to the payload builder, which maps an absent reason to the `END` default, so a stream cut off by the token limit or by the content filter was indistinguishable from one that ran to completion. Streams that threw or were abandoned already metered as `ERROR` and `CANCELLED`. The reported `finish_reason` is now read and metered, it survives a stream the caller abandons (falling back to `CANCELLED` only when no reason arrived), and chunks are matched on choice index rather than array position, so a response with `n > 1` no longer meters whichever choice the provider happened to send first. `content_filter` now maps to `CONTENT_FILTER` instead of `ERROR` for every provider sharing the stop-reason map
- LiteLLM calls were dropping the person, job and ticket they were tagged with, so per-person spend and per-job ROI excluded LiteLLM traffic. A subscriber is now metered whenever any identity is supplied, instead of only when id, email, credential name and credential value were all present; the credential is attached only when both its name and value are given. LiteLLM calls made inside a `JobContext` or in a process with `REVENIUM_AGENTIC_JOB_*` set are now tagged with that job, resolved by the same source order used by every other provider, with the per-request header winning over the job context and the job context over the environment. `x-revenium-ticket-id` plus the four `x-revenium-agentic-job-*` headers are accepted per request; a ticket id longer than 256 characters is truncated and an agentic job id the metering API would reject is dropped, so a malformed header no longer costs the whole metering record
- An explicit `usageMetadata: { agenticJobName: undefined }` wiped the active `JobContext` job name on every provider; the context value is now kept. The job fields are the only ones affected, and only when the caller passes the key with an empty value

## [1.3.0] - 2026-10-08

### Fixed

- LiteLLM calls that proxy Anthropic models were metered with zero cache tokens: the emitter hardcoded `cacheCreationTokenCount` to `0` and read cache reads only from the OpenAI-shaped `prompt_tokens_details.cached_tokens`, so the Anthropic-native `cache_read_input_tokens` and `cache_creation_input_tokens` LiteLLM surfaces were dropped on both the non-streaming and the SSE path. A shared extractor now reads both shapes, reports `undefined` rather than `0` for a field the usage object does not carry, and the Anthropic middleware reuses it
- Anthropic extended-thinking output was metered with no `reasoningTokenCount`; the `usage.output_tokens_details.thinking_tokens` field shipped in `@anthropic-ai/sdk` 0.129 is now forwarded for both non-streaming and streaming calls
- Anthropic `model_context_window_exceeded`, `refusal` and `pause_turn` stop reasons fell through to `END` with a warning; they now map to `TOKEN_LIMIT`, `ERROR` and `END`
- Google `TOO_MANY_TOOL_CALLS` and `LANGUAGE` finish reasons fell through to the default; they now map to `COMPLETION_LIMIT` and `ERROR`, and any unknown Google finish reason logs a warning like the other providers
- Every OpenAI Responses API call was metered as `END` and logged an `Unknown stop reason: completed` warning, because the middleware read a `finish_reason` field the SDK `Response` does not have; the response `status` and `incomplete_details.reason` are now resolved, so a truncated call meters `TOKEN_LIMIT` and a content-filtered call `ERROR`, on both the non-streaming and the streaming path
- OpenAI Responses calls that failed were not metered at all: the non-streaming path rethrew the provider error without a record, and both paths skipped metering whenever the response carried no `usage`. A failure now meters as `ERROR`, and a stream abandoned before it ends meters as `CANCELLED`, matching the Chat Completions surface. A `background: true` call that returns while still `queued` is not metered; retrieving its terminal result is not yet intercepted, so that call stays unmetered
- OpenAI Responses streams ending in `response.incomplete` or `response.failed` produced no metering record at all, so transaction counts and metered token volume will rise on upgrade for traffic that was previously invisible
- Streamed OpenAI Responses output was forwarded to Revenium without the credential sanitizing already applied on the Chat Completions streaming path
- `client.messages.stream()` threw `messages.create(...).withResponse is not a function` once the middleware was loaded, because the SDK helper re-entered the patched `create`; it now runs against the original method. The call also returns the SDK `MessageStream` again instead of a bare async generator, so `.on()`, `.finalMessage()`, `.finalText()` and `.withResponse()` work under the middleware as they do without it, and the call meters exactly once

### Changed

- Claude served through Microsoft Foundry is now metered as `provider: "Foundry"` instead of direct `Anthropic`, so an administrator can reconcile that spend against a Microsoft invoice. Detection reads the Anthropic client's `baseURL` and matches the `services.ai.azure.com` host; every other base URL, including Azure OpenAI's `openai.azure.com`, keeps the `Anthropic` label and a byte-identical payload. `modelSource` stays `ANTHROPIC` on both, and no resource name, host or URL fragment is added to the payload. Release sequencing: the `FOUNDRY` enforcement alias and the `foundry → azure` billing-coverage bucket must be deployed on the platform before a release carrying this change reaches customers, otherwise Anthropic-scoped budget rules stop counting Foundry spend and `/billing/coverage` drops it
- Development dependencies raised to the current provider SDK majors: `openai` 7.23, `@anthropic-ai/sdk` 0.129, `@google/genai` 2.24, `@fal-ai/client` 1.10; the unit suite passes against all of them. Peer dependency floors are unchanged
- `scripts/provider-surface-check.mjs` compares the provider response fields and stop reasons this middleware reads against the latest published SDK types and fails when a consumed field disappears or a stop reason is unmapped; a weekly workflow runs it and the unit suite against the latest provider versions. It now also tracks the OpenAI `ResponseStatus` and `incomplete_details.reason` tables, so a new Responses status or incomplete reason fails the check instead of silently metering as `END`

## [1.2.1] - 2026-09-24

### Fixed

- Top-level `operationSubtype` on the seven multimodal paths — OpenAI images and audio, fal images, audio and video, Google Vertex images and video. These payloads previously carried the subtype only inside `attributes`, so the metering API received none and logged a `*_MISSING_OPERATION_SUBTYPE` warning for each call; audio also priced without a resolved direction
- Google Vertex image upscale was metered as `variation`; it now ships `upscale`
- A caller-supplied `usageMetadata.operationSubtype` was silently dropped on every Google Vertex path; it is now forwarded and takes precedence over the detected value
- fal endpoints that are neither transcription nor text-to-speech (`speech-to-text`, `voice-clone`, `audio-to-audio`, `stable-audio`) were classified as `tts` and metered at zero chargeable characters; they now ship `synthesis` and meter by duration. `speech-to-text` and `stt` endpoints are classified as `transcription`
- fal speech endpoints such as `fal-ai/minimax/speech-02-hd` were classified as `synthesis` and billed per second, recording zero billable seconds when no duration was available; they now classify as `tts` and bill by input characters
- An OpenAI audio call metered as `synthesis` inherited the transcription `per_minute` billing unit; the audio billing unit is now derived from the effective subtype (`per_character` for `tts` and `speech`, `per_minute` for `transcription` and `translation`, `per_second` for `synthesis` and `realtime`)
- A caller override to `tts` or `speech` on a request that carries no text no longer discards the available duration; billing falls back to the measure the request actually provides
- A fal transcription or translation call whose result carries no duration no longer reports the caller-supplied `input.duration` as the transcribed audio measure; the request duration is only used for generated audio

### Changed

- Detected audio subtypes now use the vocabulary the metering API accepts: `speech_synthesis` ships as `tts`, and fal's `audio_generation` ships as `synthesis`. `transcription`, `translation` and every image and video subtype are unchanged
- `operationSubtype` removed from `attributes` on all multimodal payloads — it is now sent once, at the top level
- A caller-supplied `operationSubtype` is trimmed, lowercased and checked against the accepted vocabulary for its operation type. Values outside it are logged as a warning and ignored in favour of the detected subtype, instead of being sent and rejected by the metering API with a 400 that drops the event
- The earlier literals `speech_synthesis` and `audio_generation` remain accepted, both as `trackAudioUsageAsync` arguments and as caller overrides, and are sent as `tts` and `synthesis`
- Billing attributes (`billing_unit`, `characterCount`, `durationSeconds`) are derived from the effective subtype, so a caller override no longer leaves the payload describing two different operations
- Audio calls now resolve a pricing direction on the backend. A tenant whose only AUDIO pricing row for a model and billing unit is explicitly `INPUT` will stop matching on `tts` calls and report no cost, where it previously matched at the wrong rate

## [1.2.0] - 2026-08-27

### Added

- Skill attribution fields on the metering payload: `skillName`, `skillSource`, `skillKind`, `skillPluginName`, `skillMarketplaceName`, `skillInvocationTrigger`, each accepted in camelCase or snake_case and truncated to the backend column limits
- LiteLLM proxy support for the skill fields via the `x-revenium-skill-*` request headers
- Anthropic cache creation TTL split: `cacheCreation5mTokenCount` and `cacheCreation1hTokenCount`, read from `usage.cache_creation` on both streaming and non-streaming responses
- `amendJobOutcome(jobId, amendment, teamId?)` for updating previously reported outcomes via PATCH
- `getJobOutcomeHistory(jobId, teamId?)` for retrieving ordered outcome revision history
- `JobContext.amendOutcome(amendment)` convenience method
- Typed error classes: `OutcomeAlreadyReportedError`, `OutcomeNotReportedError`, `OutcomeAmendConflictError`
- `JobOutcomeAmendment` and `JobOutcomeRevisionEntry` interfaces
- `outcomeUpdateCount`, `outcomeUpdatedAt`, `outcomeUpdatedBy` fields on `JobResource`

### Changed

- **Breaking:** `reportJobOutcome` now throws `OutcomeAlreadyReportedError` on 409 when the backend returns a structured conflict body (with `details.guidance`). Consumers relying on the silent-return behavior must add a try/catch. The fallback for legacy backends without the structured body is preserved.

## [1.1.10] - 2026-07-30

### Fixed

- `ticketId` support for LiteLLM and fal providers

## [1.1.9] - 2026-07-23

### Added

- `ticketId` field on metering payload for correlating AI usage with support/issue tickets

## [1.1.8] - 2026-07-09

### Added

- Store-and-forward buffer for metering events that exhaust retries: events that fail after retry exhaustion or circuit breaker rejection are buffered in memory and replayed automatically every 30s
- Bounded buffer with configurable capacity (default 1000 events, FIFO eviction) and 24h TTL aligned with backend Idempotency-Key TTL
- `flushMeteringBuffer()` export for manual flush in serverless shutdown hooks
- `getBufferStats()` export for observability
- Automatic best-effort flush on process `beforeExit`, `SIGTERM`, and `SIGINT`

## [1.1.7] - 2026-07-06

### Added

- Retry with exponential backoff + jitter for all metering POSTs (completions, tool events, job outcomes)
- HTTP status classification: retry `{408, 429, 500, 502, 503, 504}`, fail fast on other 4xx
- `Retry-After` header support (delta-seconds and HTTP-date, clamped at 60s)
- Stable `Idempotency-Key` across retry attempts for server-side deduplication
- `HttpError` class with status code and Retry-After metadata
- Circuit breaker protection for tool event metering

### Changed

- Centralized retry logic in metering API client; removed Anthropic-specific retry and circuit breaker
- `config.maxRetries` is now honored by the centralized retry layer

## [1.1.6] - 2026-06-04

### Added

- HMAC webhook verification helper for signature validation
- Idempotency-Key auto-generation for metering requests
- Cache token metering support

### Fixed

- Drop deprecated organizationId/productId from LiteLLM and fal.ai wire-emit

## [1.1.5] - 2026-05-08

### Fixed

- Circuit breaker isolation: metering and enforcement now use independent breaker instances, preventing enforcement failures from tripping the metering circuit and vice versa

### Changed

- README: added Cost Controls / Enforcement section with configuration and usage documentation

## [1.1.4] - 2026-05-04

### Added

- 13 fields to shared `UsageMetadata` interface (`retryNumber`, `environment`, `region`, `parentTransactionId`, `transactionName`, `traceType`, `traceName`, `operationSubtype`, `errorReason`, `credentialAlias`, `mediationLatency`, `systemFingerprint`, `temperature`) for per-request configuration across all providers

### Fixed

- Precedence bug in `payload-builder.ts` where env vars overwrote user-provided values (now: user-set > env var > undefined)

### Changed

- De-duplicated `GoogleUsageMetadata`, `FalUsageMetadata`, `LiteLLMUsageMetadata` to extend shared `UsageMetadata` interface instead of redeclaring fields

## [1.1.3] - 2026-04-27

### Added

- Support for new `rev_` API key prefix (covers `rev_mk_`, `rev_sk_`, and future key types)
- Client-side cost enforcement engine with polling, rule evaluation, and circuit breaker integration
- `CostLimitExceeded` error class for enforcement rule violations
- E2E smoke test script

### Changed

- API key validator now accepts both `hak_` (legacy) and `rev_` (new) prefixes
- Config loader reads `REVENIUM_ENFORCEMENT_BASE_URL` environment variable
- `ReveniumConfig` type extended with `reveniumTeamId` and `reveniumEnforcementBaseUrl` fields

## [1.1.2] - 2026-04-02

### Changed

- Renamed package repository from `revenium-middleware-node` to `revenium-node-sdk`

### Added

- Usage examples for OpenAI, Anthropic, Google GenAI, Google Vertex AI, Perplexity and Azure OpenAI covering basic, streaming, metadata, prompt capture and embeddings

### Fixed

- Anthropic streaming runtime error in embed example
- `REVENIUM_TEAM_ID` environment variable fallback in `buildJobRequest`
- Prettier formatting in `normalizePagedResponse`

## [1.1.0] - 2026-03-19

### Added

- Jobs API support with `JobContext` using `AsyncLocalStorage` for agentic workflow tracking
- Environment variable fallbacks for Jobs API configuration
- Graceful 409 conflict handling in Jobs API responses
- fal.ai middleware wrapper with multi-modal metering support (image, video, audio)
- HATEOAS-driven Jobs API endpoint discovery

### Fixed

- Google Vertex image resolution and quality fields in metering payload
- VIDEO endpoint routing and circuit breaker wiring
- Canonical model name from API response for accurate pricing resolution
- LiteLLM `ReveniumPayload` type safety enforcement
- API key error messages for clearer diagnostics
- Internal package reference in Perplexity client error message

## [1.0.0] - 2025-02-24

### Added

- Unified middleware combining OpenAI, Anthropic, Google (GenAI + Vertex AI), Perplexity, and LiteLLM providers
- Sub-path imports for tree-shakeable provider access (`@revenium/middleware/openai`, `/anthropic`, `/google/genai`, `/google/vertex`, `/perplexity`, `/litellm`, `/tools`)
- Go-aligned API pattern with `Initialize()` / `GetClient()` for OpenAI and Perplexity providers
- Auto-initialization on import for Anthropic provider with `patchAnthropic()` / `unpatchAnthropic()` control
- Google GenAI and Vertex AI support via controller/service pattern
- LiteLLM proxy support with HTTP client patching, `enable()` / `disable()` lifecycle
- Shared core infrastructure (`_core`) with circuit breaker, config manager, API client, retry logic, and error handling
- Tool metering system with `meterTool()`, `reportToolCall()`, and async-safe context management via `AsyncLocalStorage`
- Streaming support for all providers with base wrapper abstraction
- Fire-and-forget metering that never blocks application flow
- ESM + CJS dual output with TypeScript type definitions
- Metadata and trace visualization fields for distributed tracing and analytics
- Terminal summary output with human-readable and JSON formats
- Prompt capture with automatic PII sanitization
- Azure OpenAI automatic detection and configuration
- 130 unit and integration tests

[2.0.0]: https://github.com/revenium/revenium-node-sdk/releases/tag/v2.0.0
[1.3.1]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.3.1
[1.3.0]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.3.0
[1.2.1]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.2.1
[1.2.0]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.2.0
[1.1.10]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.10
[1.1.9]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.9
[1.1.8]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.8
[1.1.7]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.7
[1.1.6]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.6
[1.1.5]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.5
[1.1.4]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.4
[1.1.3]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.3
[1.1.2]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.2
[1.1.1]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.1
[1.1.0]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.1.0
[1.0.0]: https://github.com/revenium/revenium-node-sdk/releases/tag/v1.0.0
