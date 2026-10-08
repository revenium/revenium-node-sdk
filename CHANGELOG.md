# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.0] - 2026-10-08

### Fixed

- LiteLLM calls that proxy Anthropic models were metered with zero cache tokens: the emitter hardcoded `cacheCreationTokenCount` to `0` and read cache reads only from the OpenAI-shaped `prompt_tokens_details.cached_tokens`, so the Anthropic-native `cache_read_input_tokens` and `cache_creation_input_tokens` LiteLLM surfaces were dropped on both the non-streaming and the SSE path. A shared extractor now reads both shapes, reports `undefined` rather than `0` for a field the usage object does not carry, and the Anthropic middleware reuses it (BACK-2409)
- Anthropic extended-thinking output was metered with no `reasoningTokenCount`; the `usage.output_tokens_details.thinking_tokens` field shipped in `@anthropic-ai/sdk` 0.129 is now forwarded for both non-streaming and streaming calls (FRONT-2939)
- Anthropic `model_context_window_exceeded`, `refusal` and `pause_turn` stop reasons fell through to `END` with a warning; they now map to `TOKEN_LIMIT`, `ERROR` and `END`
- Google `TOO_MANY_TOOL_CALLS` and `LANGUAGE` finish reasons fell through to the default; they now map to `COMPLETION_LIMIT` and `ERROR`, and any unknown Google finish reason logs a warning like the other providers
- Every OpenAI Responses API call was metered as `END` and logged an `Unknown stop reason: completed` warning, because the middleware read a `finish_reason` field the SDK `Response` does not have; the response `status` and `incomplete_details.reason` are now resolved, so a truncated call meters `TOKEN_LIMIT` and a content-filtered call `ERROR`, on both the non-streaming and the streaming path (FRONT-2961)
- OpenAI Responses calls that failed were not metered at all: the non-streaming path rethrew the provider error without a record, and both paths skipped metering whenever the response carried no `usage`. A failure now meters as `ERROR`, and a stream abandoned before it ends meters as `CANCELLED`, matching the Chat Completions surface. A `background: true` call that returns while still `queued` is not metered; retrieving its terminal result is not yet intercepted, so that call stays unmetered (FRONT-2961)
- OpenAI Responses streams ending in `response.incomplete` or `response.failed` produced no metering record at all, so transaction counts and metered token volume will rise on upgrade for traffic that was previously invisible (FRONT-2961)
- Streamed OpenAI Responses output was forwarded to Revenium without the credential sanitizing already applied on the Chat Completions streaming path (FRONT-2961)
- `client.messages.stream()` threw `messages.create(...).withResponse is not a function` once the middleware was loaded, because the SDK helper re-entered the patched `create`; it now runs against the original method. The call also returns the SDK `MessageStream` again instead of a bare async generator, so `.on()`, `.finalMessage()`, `.finalText()` and `.withResponse()` work under the middleware as they do without it, and the call meters exactly once (BACK-2737)

### Changed

- Claude served through Microsoft Foundry is now metered as `provider: "Foundry"` instead of direct `Anthropic`, so an administrator can reconcile that spend against a Microsoft invoice. Detection reads the Anthropic client's `baseURL` and matches the `services.ai.azure.com` host; every other base URL, including Azure OpenAI's `openai.azure.com`, keeps the `Anthropic` label and a byte-identical payload. `modelSource` stays `ANTHROPIC` on both, and no resource name, host or URL fragment is added to the payload. Release sequencing: BACK-2689 (the `FOUNDRY` enforcement alias) and BACK-2921 (the `foundry → azure` billing-coverage bucket) must be deployed before a release carrying this change reaches customers, otherwise Anthropic-scoped budget rules stop counting Foundry spend and `/billing/coverage` drops it (BACK-2737)
- Development dependencies raised to the current provider SDK majors: `openai` 7.23, `@anthropic-ai/sdk` 0.129, `@google/genai` 2.24, `@fal-ai/client` 1.10; the unit suite passes against all of them. Peer dependency floors are unchanged
- `scripts/provider-surface-check.mjs` compares the provider response fields and stop reasons this middleware reads against the latest published SDK types and fails when a consumed field disappears or a stop reason is unmapped; a weekly workflow runs it and the unit suite against the latest provider versions. It now also tracks the OpenAI `ResponseStatus` and `incomplete_details.reason` tables, so a new Responses status or incomplete reason fails the check instead of silently metering as `END` (FRONT-2961)

## [1.2.1] - 2026-09-24

### Fixed

- Top-level `operationSubtype` on the seven multimodal paths — OpenAI images and audio, fal images, audio and video, Google Vertex images and video. These payloads previously carried the subtype only inside `attributes`, so the metering API received none and logged a `*_MISSING_OPERATION_SUBTYPE` warning for each call; audio also priced without a resolved direction (FRONT-2790)
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

- Skill attribution fields on the metering payload: `skillName`, `skillSource`, `skillKind`, `skillPluginName`, `skillMarketplaceName`, `skillInvocationTrigger`, each accepted in camelCase or snake_case and truncated to the backend column limits (BACK-2662)
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

- `ticketId` field on metering payload for correlating AI usage with support/issue tickets (FRONT-1543)

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
