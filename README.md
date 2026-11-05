# Revenium Middleware for Node.js

[![npm version](https://img.shields.io/npm/v/@revenium/middleware.svg)](https://www.npmjs.com/package/@revenium/middleware)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B-green)](https://nodejs.org/)
[![Documentation](https://img.shields.io/badge/docs-revenium.io-blue)](https://docs.revenium.io)
[![Website](https://img.shields.io/badge/website-revenium.ai-blue)](https://www.revenium.ai)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**Unified TypeScript middleware for automatic AI usage tracking across multiple providers**

A professional-grade Node.js middleware that integrates with OpenAI, Azure OpenAI, Anthropic, Google (GenAI + Vertex AI), Perplexity, LiteLLM, and fal.ai to provide automatic usage tracking, billing analytics, and metadata collection. Features Go-aligned API patterns, sub-path imports for tree-shaking, and ESM + CJS dual output.

## Features

- **Multi-Provider Support** - OpenAI, Azure OpenAI, Anthropic, Google GenAI, Google Vertex AI, Perplexity, LiteLLM, fal.ai
- **Go-Aligned API** - Consistent `Initialize()` / `GetClient()` pattern across providers
- **Sub-Path Imports** - Tree-shakeable `@revenium/middleware/openai`, `/anthropic`, etc.
- **Tool Metering** - Track custom tool and external API calls with `meterTool()` and `reportToolCall()`
- **Fire-and-Forget** - Metering never blocks your application flow, except the Anthropic batch results loop, which waits while 32 records are still being delivered
- **Streaming Support** - Handles regular and streaming requests for all providers, for the calls made through the clients the SDK wraps; each provider section lists the calls that are not metered
- **ESM + CJS** - Dual output with full TypeScript type definitions
- **Automatic .env Loading** - Reads `.env.local` and `.env` from your application's working directory, with no extra dependency. Real environment variables always win; files outside the working directory are never read

## Supported Providers

| Provider         | Sub-Path Import                      | API Pattern                                                 |
| ---------------- | ------------------------------------ | ----------------------------------------------------------- |
| OpenAI           | `@revenium/middleware/openai`        | `Initialize()` / `GetClient()`                              |
| Azure OpenAI     | `@revenium/middleware/openai`        | `Initialize()` / `GetClient()` (auto-detected)              |
| Anthropic        | `@revenium/middleware/anthropic`     | `initialize()` / `configure()` / auto-init on import        |
| Foundry          | `@revenium/middleware/anthropic`     | Same as Anthropic (auto-detected from the base URL)         |
| Google GenAI     | `@revenium/middleware/google/genai`  | Your `GoogleGenAI` client / `configure()` / patch on import |
| Google Vertex AI | `@revenium/middleware/google/vertex` | Your `GoogleGenAI` client / `configure()` / patch on import |
| Perplexity       | `@revenium/middleware/perplexity`    | `Initialize()` / `GetClient()`                              |
| LiteLLM          | `@revenium/middleware/litellm`       | `initialize()` / `configure()` / `enable()` / `disable()`   |
| fal.ai           | `@revenium/middleware/fal`           | `Initialize()` / `GetClient()`                              |
| Tool Metering    | `@revenium/middleware/tools`         | `meterTool()` / `reportToolCall()`                          |

## Getting Started

### Installation

```bash
npm install @revenium/middleware
```

Install the provider SDK you need as a peer dependency:

```bash
npm install openai                    # For OpenAI / Azure OpenAI / Perplexity
npm install @anthropic-ai/sdk         # For Anthropic
npm install @google/genai             # For Google GenAI
npm install google-auth-library       # For Google Vertex AI
npm install @fal-ai/client            # For fal.ai
```

CI runs the unit suite on Node 22 against `openai` 7.x, `@anthropic-ai/sdk` 0.129.x, `@google/genai` 2.x and `@fal-ai/client` 1.10.x, on Node 20 against `openai` 6.x, and on Node 18 against `openai` 6.x and `@google/genai` 1.x, which are the newest majors those runtimes support.

### Configuration

Create a `.env` file in the directory your process is started from. See [`.env.example`](https://github.com/revenium/revenium-node-sdk/blob/HEAD/.env.example) for all available options.

The middleware reads `.env.local` and then `.env` from `process.cwd()` only. A `.env` sitting at the root of a monorepo is not read when the process starts in a workspace package, and no parent directory is ever searched. Values already present in the real environment are never overwritten, and `.env.local` takes precedence over `.env`.

Minimum required:

```env
REVENIUM_METERING_API_KEY=hak_your_revenium_api_key_here
REVENIUM_METERING_BASE_URL=https://api.revenium.ai
```

Plus the API key for your chosen provider (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.).

### Quick Start - OpenAI

Ensure `OPENAI_API_KEY` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file.

```typescript
import { Initialize, GetClient } from "@revenium/middleware/openai";

Initialize();
const client = GetClient();

const response = await client
  .chat()
  .completions()
  .create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: "Hello!" }],
  });
```

### Quick Start - Anthropic

```typescript
import "@revenium/middleware/anthropic";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const response = await client.messages.create({
  model: "claude-sonnet-4-20250514",
  max_tokens: 1024,
  messages: [{ role: "user", content: "Hello!" }],
});
```

### Quick Start - Google GenAI

Ensure `GOOGLE_API_KEY` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file.

```typescript
import "@revenium/middleware/google/genai";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GOOGLE_API_KEY });

const response = await ai.models.generateContent({
  model: "gemini-2.0-flash-001",
  contents: "Hello!",
  usageMetadata: { subscriber: { id: "user-123" } },
});
```

### Quick Start - Azure OpenAI

Ensure `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file.

```typescript
import { Initialize, GetClient } from "@revenium/middleware/openai";

Initialize();
const client = GetClient();

const response = await client
  .chat()
  .completions()
  .create({
    model: "my-deployment-name",
    messages: [{ role: "user", content: "Hello!" }],
  });
```

Azure is auto-detected when `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` are set.

### Quick Start - Google Vertex AI

Ensure `GOOGLE_CLOUD_PROJECT` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file. Vertex AI signs in with Google Application Default Credentials, so it works as is on Cloud Run, GKE, Compute Engine or after `gcloud auth application-default login`; a service account key file is optional.

```typescript
import "@revenium/middleware/google/vertex";
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  vertexai: true,
  project: process.env.GOOGLE_CLOUD_PROJECT,
  location: "us-central1",
});

const response = await ai.models.generateContent({
  model: "gemini-2.0-flash-001",
  contents: "Hello!",
  usageMetadata: { subscriber: { id: "user-123" } },
});
```

### Quick Start - Perplexity

Ensure `PERPLEXITY_API_KEY` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file.

```typescript
import { Initialize, GetClient } from "@revenium/middleware/perplexity";

Initialize();
const client = GetClient();

const response = await client
  .chat()
  .completions()
  .create({
    model: "sonar",
    messages: [{ role: "user", content: "Hello!" }],
  });
```

### Quick Start - fal.ai

Ensure `FAL_KEY` and `REVENIUM_METERING_API_KEY` are set in your environment before initializing.

```typescript
import { Initialize, GetClient } from "@revenium/middleware/fal";

Initialize();
const fal = GetClient();

// Image generation (with cost attribution metadata)
const image = await fal.subscribe(
  "fal-ai/flux/schnell",
  {
    input: { prompt: "a futuristic cityscape at sunset" },
  },
  { subscriber: { id: "user_123" }, traceId: "req_abc789" },
);
console.log(image.data.images[0].url);

// Video generation
const video = await fal.subscribe("fal-ai/kling-video/v2/master/text-to-video", {
  input: { prompt: "ocean waves crashing on rocks", duration: 5 },
});
console.log(video.data.video.url);

// Audio generation (text-to-speech)
const audio = await fal.subscribe("fal-ai/kokoro/american-english", {
  input: { prompt: "Hello from Revenium!", voice: "af_heart" },
});
console.log(audio.data.audio.url);

// LLM via OpenRouter
const chat = await fal.subscribe("openrouter/router", {
  input: { prompt: "Explain quantum computing", model: "google/gemini-2.5-flash" },
});
console.log(chat.data.output);
```

The middleware automatically detects the media type from the endpoint ID and routes metering data to the correct Revenium endpoint. The optional `metadata` parameter enables cost attribution per subscriber, organization, or trace.

### Quick Start - LiteLLM

```typescript
import { initialize } from "@revenium/middleware/litellm";

initialize();
```

## API Reference

### OpenAI

Go-aligned client pattern with Azure auto-detection:

| Function              | Description                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from explicit config; the environment fills the keys it leaves out ([Configuring in code](#configuring-in-code)) |
| `GetClient()`         | Get the wrapped OpenAI client instance                                                                                                 |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration                                                                                |
| `IsInitialized()`     | Check if middleware is initialized                                                                                                     |
| `Reset()`             | Reset the global client (useful for testing)                                                                                           |

**Client Methods:**

| Method                                                                 | Description                                                  |
| ---------------------------------------------------------------------- | ------------------------------------------------------------ |
| `chat().completions().create(params, metadata?)`                       | Chat completion                                              |
| `chat().completions().createStreaming(params, metadata?)`              | Streamed chat completion                                     |
| `chat().completions().parse(params, metadata?)`                        | Chat completion with structured output                       |
| `responses().create(params, metadata?)`                                | Responses API call, streamed with `stream: true`             |
| `responses().createStreaming(params, metadata?)`                       | Streamed Responses API call                                  |
| `responses().parse(params, metadata?)`                                 | Responses API call with structured output                    |
| `responses().retrieve(id, metadata?)`                                  | Collect a background response                                |
| `embeddings().create(params, metadata?)`                               | Embeddings                                                   |
| `images().generate(params)`, `edit(params)`, `createVariation(params)` | Image generation, edit and variation                         |
| `audio().transcriptions`, `translations`, `speech` `.create(params)`   | Transcription, translation and text-to-speech                |
| `decisions().create(params, metadata?)`                                | Decisions API call (requires `openai` >= 7.30.0)             |
| `getUnderlyingClient()`                                                | Get the raw `OpenAI` or `AzureOpenAI` instance (not metered) |

#### Structured outputs and Decisions

`chat().completions().parse` and `responses().parse` take the same parameters as the `openai`
methods of the same name, return the same parsed result, and emit one usage record with the
tokens the provider reported, including reasoning and cached tokens. When the `openai` parser
throws after the provider answered (`LengthFinishReasonError`, `ContentFilterFinishReasonError`,
invalid JSON or a failed schema check), the record still carries those tokens and the parse
error is rethrown. A Responses `parse` with `background: true` is metered when collected with
`responses().retrieve(id)`, like `create`.

`decisions().create` emits one usage record per call with input, output, reasoning, cached and
cache-write tokens. The Decisions API exists from `openai` 7.30.0; with an older `openai` the call
throws `Decisions API not available in this OpenAI SDK version (requires openai >= 7.30.0)`
before anything is sent. The answers are not captured as response content.

```typescript
import { Initialize, GetClient } from "@revenium/middleware/openai";

Initialize();
const client = GetClient();

const decision = await client.decisions().create(
  {
    model: "gpt-6-luna",
    input: "Buy cheap watches now",
    questions: [{ type: "predicate", name: "is_spam", instructions: "Is this message spam?" }],
  },
  { subscriber: { id: "user-123" } },
);
```

#### Responses API — background mode

A Responses call created with `background: true` returns while the job is still `queued` or
`in_progress`, so no tokens exist yet and no usage record is emitted. Collect the finished job
with `client.responses().retrieve(id)`: once the status is terminal the wrapper emits exactly one
usage record carrying the job's input, output, reasoning and cached tokens, with the provider
response id as the transaction id and the job's wall time (`completed_at - created_at`) as the
request duration, falling back to the collection latency when the job carries no timestamps.
Polling `retrieve` while the job is unfinished meters nothing.

Metadata passed to `create`, the agentic job active at that moment, and the captured input are
reused by the later `retrieve` on the same client instance; metadata passed to `retrieve` overrides
it field by field. Up to 1000 pending jobs are remembered per client instance, so pass the metadata
again at collection when the job is collected by a different process or client, or when more than
1000 jobs are created before they are collected.

Collecting the same response again emits no further record: the most recent 1000 metered response
ids are remembered per client instance — collected jobs, synchronous calls and streams alike — and
every record sends a deterministic `Idempotency-Key` derived from the response id, so a collection
beyond that window, or from a different process, is deduplicated by Revenium instead for as long as
its idempotency store retains the key (24 hours by default). That also covers a `retrieve` on a
response already metered by its own `create` or by its own stream. A job ending `failed` or
`cancelled` is recorded once with that outcome; a transport failure on `retrieve` is rethrown and
records nothing, and a failed delivery to Revenium leaves the id collectable again.

Not metered:

- `chat.completions.stream` and `chat.completions.runTools`: use
  `chat().completions().createStreaming` for streamed chat.
- `responses.stream`: use `responses().create({ ...params, stream: true })`. `responses.compact`
  is not metered either.
- `videos.*` (Sora), `batches.*`, `realtime.*` and `live.*`.
- `completions.create` (legacy Completions).
- `beta.threads.runs.*` (Assistants).
- `beta.responses.*`, `beta.agents.*`, `beta.chatkit.*` and `beta.realtime.*`.
- `fineTuning.jobs.*`, `fineTuning.alpha.graders.run`, `containers.*` and `evals.runs.*`.
- Every call made through `getUnderlyingClient()`.
- `decisions().create` with `openai` older than 7.30.0, which throws instead.

### Anthropic

Auto-initializes on import. Manual control available:

| Function             | Description                                         |
| -------------------- | --------------------------------------------------- |
| `initialize()`       | Explicitly initialize middleware                    |
| `configure(config)`  | Set configuration and patch Anthropic               |
| `patchAnthropic()`   | Enable request interception                         |
| `unpatchAnthropic()` | Disable request interception                        |
| `isInitialized()`    | Check initialization status                         |
| `getStatus()`        | Get detailed status including circuit breaker state |
| `reset()`            | Reset middleware and circuit breaker                |

The host serving Claude is detected from the Anthropic client's `baseURL`: `services.ai.azure.com`
and its subdomains meter as `provider: "Foundry"`, the AWS Bedrock runtime hosts used by
`AnthropicBedrock` as `"AWS"`, the Vertex AI `aiplatform.googleapis.com` hosts used by
`AnthropicVertex` as `"Google"`, and every other host as `"Anthropic"`. A Foundry, Bedrock or
Vertex AI endpoint reached through a proxy or gateway hostname meters as `"Anthropic"`, since only
the configured `baseURL` is visible to the client. `modelSource` is `ANTHROPIC` in every case, and
no other payload field changes.

`client.beta.messages` emits the same usage records as `client.messages`: `create` (streamed or
not), `stream`, `parse` and `toolRunner` each produce exactly one record per model call, whether
the result is awaited, iterated, split with `tee()`, converted with `toReadableStream()` or read
as a raw `Response` through `asResponse()`. Compaction iterations reported under
`usage.iterations` are added to the metered token counts, since the Anthropic beta API excludes
them from the top-level `usage` fields.

Message Batches are metered when the application iterates `client.messages.batches.results()` or
`client.beta.messages.batches.results()`: each `succeeded` result produces one record with
`pricingTier: "BATCH"`, the result's `message.id` as `transactionId` and the tokens of that
result. Metadata goes in `results(batchId, { usageMetadata })`, not in `requests[].params` of
`batches.create`, which the Anthropic API rejects with extra fields. Each record carries the
`Idempotency-Key` `anthropic-batch-<message.id>` and is dated at the batch's `ended_at`, read with
one extra `batches.retrieve` call, with a `requestDuration` of 0 ms, since the batch exposes no
per-request timing. Reading the same results again, from this or another process, is deduplicated
by Revenium for as long as its idempotency store retains the key (24 hours by default); after that,
reading them again meters them again. At most 32 batch records are sent at once, so the results
loop waits while 32 are still being delivered. Batch records carry no prompt capture, since the
batch does not expose the request.

Not metered:

- `client.completions.create` (legacy Text Completions): the response carries no token counts.
- `client.messages.batches.create` and `client.beta.messages.batches.create`: the batch carries no
  usage; its tokens are metered through `results()`.
- Batch results downloaded directly from `results_url` without going through `results()`.
- `errored`, `canceled` and `expired` batch results, which Anthropic does not bill.

### Google GenAI / Vertex AI

Importing `@revenium/middleware/google/genai` or `@revenium/middleware/google/vertex` meters your own `GoogleGenAI` client, including clients created with `vertexai: true` and clients created before the import. Import the middleware before the first call. Every request sent to Google produces one record, so a `generateContent` call that runs two automatic function calling rounds produces two records, each with the tokens of its own round. `generateContent`, `generateContentStream` and `embedContent` take `usageMetadata` directly; a chat takes it once at creation and applies it to every message:

```typescript
const chat = ai.chats.create({
  model: "gemini-2.0-flash-001",
  usageMetadata: { subscriber: { id: "user-123" } },
});

await chat.sendMessage({ message: "Hello!" });
```

Load the middleware and `@google/genai` the same way, both with `import` or both with `require`. Node gives each form its own copy of `@google/genai`, and the middleware meters only the copy that resolves the same way it was loaded, so a `require` of the middleware next to an `import` of `@google/genai`, or the reverse, meters nothing. `isGoogleGenAIPatched(ai)` reports whether your client is metered: it returns `false` for a client from a copy of `@google/genai` the middleware did not patch, and when the installed `@google/genai` lacks a request method the middleware meters. Called without a client, it checks the copy the middleware loaded.

If you already call `trackGoogleUsageAsync()` for requests made on your own `GoogleGenAI` client, remove those calls when you upgrade: the import now meters these requests, and keeping both sends two records per request.

Not metered:

- The Live API (WebSocket sessions).
- `ai.batches`, `ai.caches` and `ai.interactions`.
- `generateImages`, `editImage`, `upscaleImage`, `recontextImage`, `segmentImage` and `generateVideos` called on your own client; use the `VertexAIController` image and video methods to meter `generateImages`, `editImage`, `upscaleImage` and `generateVideos`.
- `@google/genai/web`, the browser build of the SDK.

The controller and service pattern remains available as an alternative:

| Export                                         | Description                           |
| ---------------------------------------------- | ------------------------------------- |
| `GoogleGenAIController` / `VertexAIController` | Main controller for API calls         |
| `GoogleGenAIService` / `VertexAIService`       | Service implementation                |
| `trackGoogleUsageAsync()`                      | Manual usage tracking                 |
| `mapGoogleFinishReason()`                      | Map finish reasons to standard format |

Google accepts the same per-call `usageMetadata` as every other provider, including `subscriber`, `environment`, `region`, `ticketId`, the trace fields and the skill fields. See [Metadata Fields](#metadata-fields). The flat `subscriberId`, `subscriberEmail`, `subscriberCredential` and `subscriberCredentialName` fields remain supported and are folded into `subscriber`; when both forms are present, `subscriber` wins field by field.

### Perplexity

Same Go-aligned client pattern as OpenAI:

| Function              | Description                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from explicit config; the environment fills the keys it leaves out ([Configuring in code](#configuring-in-code)) |
| `GetClient()`         | Get the wrapped Perplexity client instance                                                                                             |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration                                                                                |
| `IsInitialized()`     | Check if middleware is initialized                                                                                                     |
| `Reset()`             | Reset the global client (useful for testing)                                                                                           |

### fal.ai

Enterprise wrapper for fal.ai's multi-modal platform (images, video, audio, LLM) with automatic metering:

| Function              | Description                                                                                                                            |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from explicit config; the environment fills the keys it leaves out ([Configuring in code](#configuring-in-code)) |
| `GetClient()`         | Get the wrapped fal.ai client instance                                                                                                 |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration                                                                                |
| `IsInitialized()`     | Check if middleware is initialized                                                                                                     |
| `Reset()`             | Reset the global client (useful for testing)                                                                                           |

**Client Methods:**

| Method                                                            | Description                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `fal.subscribe(endpointId, options, metadata?)`                   | Submit to queue and wait for result (recommended for most use cases)                      |
| `fal.run(endpointId, options, metadata?)`                         | Execute directly and wait for result (low-latency models)                                 |
| `fal.stream(endpointId, options, metadata?)`                      | Stream partial results (real-time LLM or progress tracking)                               |
| `fal.queue.submit(endpointId, options, metadata?)`                | Submit a job to the queue without waiting; checked against cost controls, sends no record |
| `fal.queue.result(endpointId, { requestId, input? }, metadata?)`  | Collect a queued job's result; metered once per job                                       |
| `fal.queue.status`, `streamStatus`, `subscribeToStatus`, `cancel` | The fal.ai queue methods, unchanged (not metered)                                         |
| `fal.realtime`                                                    | Access the underlying realtime client directly (not metered)                              |
| `fal.storage`                                                     | Access the underlying storage client directly (not metered)                               |
| `fal.getUnderlyingClient()`                                       | Get the raw `FalClient` instance (not metered)                                            |

The `metadata` parameter is optional on all methods and enables cost attribution (e.g., `{ subscriber: { id: '...' }, organizationName, traceId }`). It does not affect the fal.ai payload. See [Metadata Fields](#metadata-fields) for all supported options.

**Queued jobs:** `fal.queue.submit` and `fal.queue.status` send nothing; `fal.queue.result` sends one record when the job's result is collected, and collecting the same job again from the same client sends nothing. Metadata passed to `result` overrides the metadata passed to `submit` one top-level field at a time: a `subscriber` passed to `result` replaces the whole `subscriber` passed to `submit`. A job whose result is never collected through `fal.queue.result`, including one delivered only by webhook, is not metered. When another process collects the result, it has neither the `submit` metadata nor the `submit` input: pass the metadata as the third argument and the job's input as `input` in the `result` options. Without that `input`, the billed quantity comes only from the result and the model defaults, so a Kling video submitted with `duration: "10"` is billed as 5 seconds, a per-character TTS job as 0 characters, and the requested image count, `resolution`, `aspect_ratio` and an input `model` are lost; the record's `requestTime` and `requestDuration` then cover only the `result` call, not the job. Each record carries the `Idempotency-Key` `fal-<requestId>`, so Revenium deduplicates a job collected more than once. Each client keeps the metadata of at most 1,000 submitted jobs, and only the input fields used for billing (`model`, `num_images`, `image_size`, `aspect_ratio`, `resolution`, `text`, `prompt`, `input` and the duration fields); since `text`, `prompt` and `input` can all be kept for the same job, the worst case is 1,000 × 3 × the size of the largest of them, about 300 MB with 100 KB prompts. Past 1,000 pending jobs, the oldest job is collected like one from another process, without its `submit` metadata and input.

**Media Type Routing:**

| Media Type | Metering Endpoint | Detection Examples                    | Billing Metric                                                         |
| ---------- | ----------------- | ------------------------------------- | ---------------------------------------------------------------------- |
| IMAGE      | `/ai/images`      | flux, stable-diffusion, recraft, sdxl | Per image (+ resolution)                                               |
| VIDEO      | `/ai/video`       | kling-video, veo, sora, runway, luma  | Seconds of video                                                       |
| AUDIO      | `/ai/audio`       | kokoro, chatterbox, whisper, f5-tts   | Characters (`tts`) / minutes (`transcription`) / seconds (`synthesis`) |
| CHAT       | `/ai/completions` | openrouter                            | Token usage (input/output/total)                                       |

Media type is detected via a two-phase approach: first by regex matching on the endpoint ID, then corrected by inspecting the response structure (e.g., presence of `images`, `video`, `audio_url`, or `usage` fields).

> **Fallback:** Unknown endpoints default to IMAGE metering. A warning is logged automatically for unrecognized endpoints.

### LiteLLM

HTTP client patching for LiteLLM proxy:

| Function                    | Description                           |
| --------------------------- | ------------------------------------- |
| `initialize()`              | Initialize from environment variables |
| `configure(config)`         | Set configuration explicitly          |
| `enable()`                  | Enable HTTP client patching           |
| `disable()`                 | Disable HTTP client patching          |
| `isMiddlewareInitialized()` | Check initialization status           |
| `getStatus()`               | Get status including proxy URL        |
| `reset()`                   | Reset all state                       |

#### LiteLLM per-request tagging headers

Any request sent through the patched HTTP client can carry attribution as `x-revenium-*` headers. Each header overrides the payload field listed below. When a header is absent the field falls back to the matching `REVENIUM_*` environment variable, the LiteLLM configuration (for the organization), or the active `JobContext` (for the job fields); only fields with no such fallback stay unset. Note that `environment` resolves to `NODE_ENV` and `retryNumber` resolves to `0` when nothing else is set.

| Header                                  | Payload field                 |
| --------------------------------------- | ----------------------------- |
| `x-revenium-subscriber-id`              | `subscriber.id`               |
| `x-revenium-subscriber-email`           | `subscriber.email`            |
| `x-revenium-subscriber-credential-name` | `subscriber.credential.name`  |
| `x-revenium-subscriber-credential`      | `subscriber.credential.value` |
| `x-revenium-subscription-id`            | `subscriptionId`              |
| `x-revenium-organization-name`          | `organizationName`            |
| `x-revenium-organization-id`            | `organizationName` (fallback) |
| `x-revenium-product-name`               | `productName`                 |
| `x-revenium-product-id`                 | `productName` (fallback)      |
| `x-revenium-trace-id`                   | `traceId`                     |
| `x-revenium-trace-type`                 | `traceType`                   |
| `x-revenium-trace-name`                 | `traceName`                   |
| `x-revenium-task-type`                  | `taskType`                    |
| `x-revenium-agent`                      | `agent`                       |
| `x-revenium-environment`                | `environment`                 |
| `x-revenium-region`                     | `region`                      |
| `x-revenium-operation-subtype`          | `operationSubtype`            |
| `x-revenium-retry-number`               | `retryNumber`                 |
| `x-revenium-parent-transaction-id`      | `parentTransactionId`         |
| `x-revenium-transaction-name`           | `transactionName`             |
| `x-revenium-credential-alias`           | `credentialAlias`             |
| `x-revenium-ticket-id`                  | `ticketId`                    |
| `x-revenium-agentic-job-id`             | `agenticJobId`                |
| `x-revenium-agentic-job-name`           | `agenticJobName`              |
| `x-revenium-agentic-job-type`           | `agenticJobType`              |
| `x-revenium-agentic-job-version`        | `agenticJobVersion`           |
| `x-revenium-skill-name`                 | `skillName`                   |
| `x-revenium-skill-source`               | `skillSource`                 |
| `x-revenium-skill-kind`                 | `skillKind`                   |
| `x-revenium-skill-plugin-name`          | `skillPluginName`             |
| `x-revenium-skill-marketplace-name`     | `skillMarketplaceName`        |
| `x-revenium-skill-invocation-trigger`   | `skillInvocationTrigger`      |
| `x-revenium-effort`                     | `effort`                      |
| `x-revenium-prompt-id`                  | `promptId`                    |
| `x-revenium-prompt-length`              | `promptLength`                |
| `x-revenium-query-source`               | `querySource`                 |
| `x-revenium-speed`                      | `speed`                       |
| `x-revenium-subagent-type`              | `subagentType`                |
| `x-revenium-capture-prompts`            | prompt capture toggle         |

Subscriber headers are independent: supplying only an id, or only an email, still attributes the call. A credential is attached only when both the name and the value are supplied.

LiteLLM calls made inside a `JobContext` are tagged with that job, as with every other provider. When the same job field is supplied more than once, the per-request `x-revenium-agentic-job-*` header wins over the active job context, and the job context wins over the `REVENIUM_AGENTIC_JOB_*` environment variables.

`x-revenium-ticket-id` is truncated at 256 characters, and an `x-revenium-agentic-job-id` the metering API would reject is dropped with a warning rather than failing the whole record. Prefer `JobContext.run()` over `JobContext.start()` in a shared-process server: `start()` has no scope end, so the job stays attached to everything the process handles afterwards.

## Tool Metering

Track custom tool and external API calls. Available from any provider sub-path or directly via `@revenium/middleware/tools`.

Tool calls made inside a `JobContext` are tagged with that job, with the same precedence as completions: the per-call `agenticJobId` field (or `usageMetadata.agenticJobId`) wins over the active job context, and the job context wins over the `REVENIUM_AGENTIC_JOB_ID` environment variable. A job id the metering API would reject is dropped with a warning and the next source in that order is used. As with completions, prefer `JobContext.run()` over `JobContext.start()` in a shared-process server.

```typescript
import { meterTool, setToolContext } from "@revenium/middleware/tools";

setToolContext({
  agent: "my-agent",
  traceId: "session-123",
});

const result = await meterTool(
  "weather-api",
  async () => {
    return await fetch("https://api.example.com/weather");
  },
  {
    operation: "get_forecast",
    outputFields: ["temperature", "humidity"],
  },
);
```

### Functions

| Function                           | Description                                                               |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `meterTool(toolId, fn, metadata?)` | Wrap a function with automatic metering (timing, success/failure, errors) |
| `reportToolCall(toolId, report)`   | Manually report an already-executed tool call                             |
| `setToolContext(ctx)`              | Set context for all subsequent tool calls                                 |
| `getToolContext()`                 | Get current context                                                       |
| `clearToolContext()`               | Clear context                                                             |
| `runWithToolContext(ctx, fn)`      | Run function with scoped context (uses AsyncLocalStorage)                 |

### Tool Metadata Options

| Field                  | Description                                           |
| ---------------------- | ----------------------------------------------------- |
| `operation`            | Tool operation name (e.g., "search", "scrape")        |
| `outputFields`         | Array of field names to auto-extract from result      |
| `usageMetadata`        | Custom metrics (e.g., tokens, results count)          |
| `agent`                | Agent identifier (inherited from context)             |
| `traceId`              | Trace identifier (inherited from context)             |
| `organizationName`     | Organization name (inherited from context)            |
| `productName`          | Product name (inherited from context)                 |
| `subscriberCredential` | Subscriber credential string (inherited from context) |
| `workflowId`           | Workflow identifier (inherited from context)          |
| `transactionId`        | Transaction identifier (inherited from context)       |
| `agenticJobId`         | Agentic job the tool call belongs to                  |
| `costUsd`              | Cost in US dollars; overrides the configured price    |

## Metadata Fields

All fields are optional and can be set per-request via `usageMetadata`:

| Field                    | Type   | Description                                              |
| ------------------------ | ------ | -------------------------------------------------------- |
| `traceId`                | string | Unique identifier for session or conversation tracking   |
| `taskType`               | string | Type of AI task (e.g., "chat", "embedding")              |
| `agent`                  | string | AI agent or bot identifier                               |
| `organizationName`       | string | Organization or company name                             |
| `productName`            | string | Product or feature name                                  |
| `subscriptionId`         | string | Subscription plan identifier                             |
| `environment`            | string | Deployment environment, overrides `REVENIUM_ENVIRONMENT` |
| `region`                 | string | Cloud region, overrides the detected region              |
| `ticketId`               | string | Ticket or work item the request belongs to               |
| `responseQualityScore`   | number | Custom quality rating (0.0-1.0)                          |
| `subscriber.id`          | string | Unique user identifier                                   |
| `subscriber.email`       | string | User email address                                       |
| `subscriber.credential`  | object | Authentication credential (`name` and `value`)           |
| `skillName`              | string | Name of the skill that produced the request              |
| `skillSource`            | string | Where the skill came from (e.g., "projectSettings")      |
| `skillKind`              | string | Kind of skill (e.g., "workflow")                         |
| `skillPluginName`        | string | Plugin that provides the skill                           |
| `skillMarketplaceName`   | string | Marketplace the skill plugin came from                   |
| `skillInvocationTrigger` | string | How the skill was invoked (e.g., "user-slash")           |
| `effort`                 | string | Reasoning effort tag (e.g., "high"), max 16 chars        |
| `promptId`               | string | Prompt identifier, max 64 chars                          |
| `promptLength`           | number | Prompt length, integer from 0 to 2147483647              |
| `querySource`            | string | Where the query came from, max 128 chars                 |
| `speed`                  | string | Speed tag (e.g., "fast"), max 16 chars                   |
| `subagentType`           | string | Subagent type that issued the request, max 128 chars     |
| `operationSubtype`       | string | Overrides the detected image/audio/video subtype         |

`effort`, `promptId`, `promptLength`, `querySource`, `speed` and `subagentType` are sent only on chat and embedding records. `effort`, `speed` and `promptId` accept letters, digits, `_` and `-`; `querySource` and `subagentType` also accept `.` and `:`. A value outside these rules is dropped with a warning naming the field, and the record is still sent. The snake_case aliases `prompt_id`, `prompt_length`, `query_source` and `subagent_type` are also accepted.

A field set to an empty string is sent as an empty string and overrides its environment-variable fallback, so `environment: ""` records an empty environment instead of `REVENIUM_ENVIRONMENT`. The same applies to `region`, `credentialAlias`, `traceType`, `traceName`, `ticketId`, `parentTransactionId` and `transactionName`. Omit the field to keep the fallback.

Accepted `operationSubtype` values, by operation type. Any other value is logged as a warning and ignored, and the detected subtype is sent instead. The earlier literals `speech_synthesis` and `audio_generation` are still accepted and sent as `tts` and `synthesis`:

| Operation type | Accepted values                                                          |
| -------------- | ------------------------------------------------------------------------ |
| IMAGE          | `generation`, `edit`, `variation`, `upscale`, `inpainting`               |
| AUDIO          | `transcription`, `translation`, `synthesis`, `speech`, `tts`, `realtime` |
| VIDEO          | `generation`, `upscale`, `extend`, `edit`                                |

## Trace Visualization Fields

Environment variables for distributed tracing and analytics:

| Environment Variable             | Description                                                                |
| -------------------------------- | -------------------------------------------------------------------------- |
| `REVENIUM_ENVIRONMENT`           | Deployment environment (production, staging, development)                  |
| `REVENIUM_REGION`                | Cloud region (auto-detected from AWS/Azure/GCP if not set)                 |
| `REVENIUM_CREDENTIAL_ALIAS`      | Human-readable credential name                                             |
| `REVENIUM_TRACE_TYPE`            | Categorical identifier (alphanumeric, hyphens, underscores, max 128 chars) |
| `REVENIUM_TRACE_NAME`            | Human-readable label for trace instances (max 256 chars)                   |
| `REVENIUM_PARENT_TRANSACTION_ID` | Parent transaction reference for distributed tracing                       |
| `REVENIUM_TRANSACTION_NAME`      | Human-friendly operation label                                             |
| `REVENIUM_RETRY_NUMBER`          | Retry attempt number (0 for first attempt)                                 |

## Cost Controls / Enforcement

Per-call enforcement blocks outgoing provider requests when a subscriber has a breached `BLOCK` cost control configured in Revenium. Every call that produces a metering record is gated, for every provider: OpenAI and Azure OpenAI chat (sync and streaming), embeddings, images, audio and the Responses API; Anthropic `messages.create`, `messages.stream` and `beta.messages.create`; Perplexity chat; Google AI and Vertex AI chat, streaming and embeddings, plus Vertex image and video; the LiteLLM proxy `fetch`; and fal.ai `run`, `subscribe`, `stream` and `queue.submit`. Collecting a background response with `responses().retrieve(id)` or a queued fal.ai job with `queue.result` is not gated, because it collects work that was already paid for.

A call is refused when either source reports a breach: the cost controls polled from the enforcement API (OpenAI `Initialize()` only, see below), or a `BLOCK` directive Revenium returns on the metering reply of an earlier call (every provider, no team id needed).

### Environment variables

| Variable                        | Required            | Description                                                                                                                                                                                  |
| ------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVENIUM_METERING_API_KEY`     | Yes                 | Revenium API key (starts with `hak_` or `rev_`). The `_METERING_` infix is load-bearing.                                                                                                     |
| `REVENIUM_TEAM_ID`              | Yes for enforcement | Hashed team ID, or `reveniumTeamId` passed to `Initialize(config)`. If neither is set, the engine starts dormant (warns once, skips cost control fetch) and all provider calls pass through. |
| `REVENIUM_ENFORCEMENT_BASE_URL` | No                  | Host base for the enforcement API (e.g. `https://api.revenium.ai`); the SDK appends the service path itself. Falls back to `REVENIUM_METERING_BASE_URL` when unset.                          |

### How it works

`Initialize()` (from `@revenium/middleware/openai`) calls `startEnforcementPolling()`, which boots a background poller on `/profitstream/v2/api/ai/enforcement-rules/{teamId}` every 30s with ±20% jitter. Fetched cost controls are cached in memory; a `204 No Content` response caches an empty set. The first gated call after `Initialize()` waits for that first fetch to finish, for at most the 5s fetch timeout, so a breached `BLOCK` cost control applies from the first call; later calls do not wait, and the metered latency never includes this wait. Anthropic `messages.stream()` and `beta.messages.create()` return synchronously and cannot wait, so they are checked against whatever has loaded by then. Calling `Initialize()` or `Configure()` again refetches the cost controls, and the next gated call waits for that fetch. Without polling, the gate never waits. Code that calls `startEnforcementPolling()` and `enforcePreCallRules()` from the package root directly can `await waitForInitialRules()` before its first check for the same guarantee. Cached cost controls apply for at most 300s after the last successful fetch (`200` or `204`). A failed refresh leaves the cache untouched and logs a warning on every poll stating how many seconds ago the cost controls were refreshed and whether they are still blocking calls, no longer applied, or not loaded; a `4xx` warning also names the requested URL and status, and a `429` additionally backs polling off for the `Retry-After` window (capped at 60s). The poll timer is `unref`'d so it never prevents process exit.

Before every gated call, the middleware builds enforcement criteria from the request — `subscriberId` and `subscriberEmail` from `metadata.subscriber` (or the flat `subscriberId` / `subscriberEmail` fields on Google and LiteLLM), `credential` from the subscriber credential's alias name (its secret value is used only when no name field was supplied at all; on Google, `subscriberCredentialName`, then `subscriberCredential`), `model` from request params, `agent` and `taskType` from metadata, `productName` and `organizationName` from metadata (each falling back to its deprecated `*Id` spelling the way the metered record does), `provider` from the detected provider — and calls `enforcePreCallRules(criteria)`. The evaluator resolves the caller to the subscriber id and the normalized email, then:

- acts on a cost control only when its `filters[]` cover the call. Filter rows compose with AND, a row with no value constrains nothing, and a cost control with no filters covers every call. The dimensions the SDK evaluates are `MODEL`, `PROVIDER`, `AGENT`, `PRODUCT`, `TASK_TYPE`, `ORGANIZATION`, `SUBSCRIBER` and `CREDENTIAL`; `PROVIDER` compares ignoring letter case, `SUBSCRIBER` ignores case only when the caller supplied an email, and the rest compare exactly. A row the SDK cannot evaluate — any other dimension, including `DEPARTMENT` outside the department path below, or an operator outside `IS` / `IS_NOT` / `IN` / `CONTAINS` / `STARTS_WITH` / `ENDS_WITH` — makes the cost control cover nothing client-side and leaves it to the platform, which enforces it server-side regardless;
- on a per-person cost control (`groupBy` set), looks the caller up in `groupBreakdown` and acts only on their own row: someone who has not crossed the limit passes even while a teammate is blocked, and the error reports the blocked person's own figure. A grouped cost control the server sent no breakdown for (its metric is not cost) blocks nobody;
- on a department-scoped cost control, acts only when the caller is named in `departmentBudgetBlocks`, reporting the balance from `departmentBudgetBlockBalances`. The server has already resolved the `DEPARTMENT` row by naming the caller, so that row is skipped and the cost control's other filter rows are applied as usual: a department cap scoped to one provider or model covers only that traffic;
- on a team-wide cost control, skips it where `breached === false` and otherwise acts on the rule-level `currentValue`;
- logs a warning and continues past cost controls where `shadowMode === true` or `action ∈ {WARN_ONLY, THROTTLE}` — these are observation-only client-side; the server still enforces server-side throttling;
- throws `CostLimitExceeded` on the first matching `BLOCK` cost control.

The polled cost controls are checked first, so their error carries the full figures; a block reported on a metering reply is checked after them.

A caller carrying neither a subscriber id nor an email cannot be matched against a per-person or department-scoped cost control, so those pass; team-wide cost controls still block it.

A `MODEL` or `PROVIDER` filter is matched against what the request asks for, because the gate runs before the provider replies, while the metered record carries what the response reports. The two differ on three known paths: on Azure the request names the deployment and the record the provider model; on a streamed OpenAI chat the request names the alias (`gpt-4o`) and the record the dated model the chunks report (`gpt-4o-2024-08-06`); and on a call proxied through LiteLLM the gate sees the transport provider (`OpenAI`) where the record names the upstream one (`Anthropic`). A cost control written from what Revenium reporting shows therefore may not block client-side on those paths. The platform's own evaluation is authoritative and still enforces the cap server-side.

### Blocks reported on the metering reply

Revenium can answer a metering record with `{"enforcement": {"action": "BLOCK", "ruleName": "...", "message": "..."}}` when the call it just metered crossed an active `BLOCK` cost control. The SDK then refuses later calls made under the same Revenium API key whose enforcement criteria are exactly the criteria of the metered call: same subscriber id, email (ignoring case and surrounding spaces), product, requested model, provider, agent, task type, organization and credential. A call that differs in any of them passes, and a call with no identity at all matches only other calls with no identity. The refusal throws `CostLimitExceeded` with the directive's `message` (or `Cost limit exceeded: <ruleName>` when the message is empty) before the provider is called.

The block is lifted by whichever comes first:

- 300 seconds after the directive arrived. Because a refused call is never metered, no reply could lift the block otherwise; once it expires one call goes through, and a new `BLOCK` reply blocks again, so at most one call per scope leaks every 300 seconds;
- a later metering reply for the same criteria that carries no directive or a `WARN_ONLY` directive, provided its request was sent after the request that produced the block. A `BLOCK` reply that arrives late for an older request can still block again for up to 300 seconds;
- a cost control refresh (OpenAI polling) for the same API key that no longer reports any rule with that name as breached, including a `204` with no rules. Rule names are not unique, so any breached rule with the same name keeps the block;
- `stopEnforcementPolling()` or the OpenAI `Reset()`.

An empty, non-JSON or unreadable metering reply changes nothing and never fails the metering send. Records resent from the outage buffer, and `trackAnthropicCall` or `trackGoogleUsageAsync` called directly without an `enforcementScope`, carry no criteria and never record a block.

How the refusal surfaces differs on a few paths:

- Anthropic `messages.stream()` and `beta.messages.create()` return synchronously, so they throw `CostLimitExceeded` synchronously instead of rejecting, and do not wait for the first cost control fetch after `Initialize()`.
- On LiteLLM the patched `fetch` rejects with `CostLimitExceeded`. Called through the `openai` SDK, that surfaces as `APIConnectionError` with the `CostLimitExceeded` as its `cause`, after the SDK's own retries; every retry is refused too, so no attempt leaves the process. An OpenAI or Perplexity client pointed at the proxy does not meter that refusal as a failed call.

The engine fails open: with a missing team ID, or before any cost control has loaded, `enforcePreCallRules` is a no-op and the request passes. Network outages, an unreachable Revenium API, or a parse error leave the cache untouched, so cost controls loaded earlier keep blocking until they are 300s old; after that they are no longer applied and requests pass until a fetch succeeds again. Enforcement errors never bubble to user code as metering failures.

### Error shape

```ts
class CostLimitExceeded extends ReveniumError {
  readonly ruleId: string; // numeric server ruleId, stringified for JSON-safe logging
  readonly threshold: number; // cost control limit
  readonly currentValue: number; // subscriber's metered value at block time
  readonly periodType: string; // DAILY / WEEKLY / MONTHLY / QUARTERLY
  readonly ruleName?: string; // rule name, set when the block came from a metering reply
  readonly context?: Record<string, unknown>; // subscriberId / subscriberEmail / productName / model / provider at call time
}
```

A block reported on a metering reply carries no figures: `ruleId` and `periodType` are `""` and `threshold` and `currentValue` are `NaN`. `message` always describes the block, so prefer it over formatting the numeric fields yourself.

`CostLimitExceeded` is exported from the package root:

```ts
import { CostLimitExceeded } from "@revenium/middleware";
```

### Usage

```ts
import { Initialize, GetClient } from "@revenium/middleware/openai";
import { CostLimitExceeded } from "@revenium/middleware";

Initialize(); // loads REVENIUM_METERING_API_KEY + REVENIUM_TEAM_ID from env (or pass them in config), starts enforcement polling
const client = GetClient();

try {
  const response = await client
    .chat()
    .completions()
    .create(
      {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      },
      { subscriber: { id: "alice@example.com" } },
    );
  console.log(response.choices[0].message.content);
} catch (err) {
  if (err instanceof CostLimitExceeded) {
    console.warn(`blocked by cost control: ${err.message}`);
    return; // or degrade gracefully
  }
  throw err; // not an enforcement error — handle as usual
}
```

### Shadow mode

`shadowMode: true` on any cost control (including `action: BLOCK`) downgrades it to observation-only for the SDK — the cost control is logged at `warn` level via the configured logger but never throws. This matches the Go SDK semantics so a cost control can be safely rolled out in shadow mode before flipping to enforcement.

## Jobs API

### Reporting an Outcome

```typescript
import { reportJobOutcome, OutcomeAlreadyReportedError } from "@revenium/middleware";

try {
  const job = await reportJobOutcome("loan-app-123", {
    executionStatus: "SUCCESS",
    outcomeType: "CONVERTED",
    outcomeValue: 150.0,
    outcomeCurrency: "USD",
  });
} catch (err) {
  if (err instanceof OutcomeAlreadyReportedError) {
    console.log(`Already reported at ${err.reportedAt}, updates: ${err.updateCount}`);
  }
}
```

### Amending an Outcome

```typescript
import {
  amendJobOutcome,
  OutcomeNotReportedError,
  OutcomeAmendConflictError,
} from "@revenium/middleware";

try {
  const updated = await amendJobOutcome("loan-app-123", {
    reason: "Customer churned 30 days after initial conversion",
    executionStatus: "FAILED",
  });
  console.log(`Update count: ${updated.outcomeUpdateCount}`);
} catch (err) {
  if (err instanceof OutcomeNotReportedError) {
    console.log("No outcome to amend yet");
  } else if (err instanceof OutcomeAmendConflictError) {
    console.log("Concurrent update detected, refetch and retry");
  }
}
```

### Outcome History

```typescript
import { getJobOutcomeHistory } from "@revenium/middleware";

const history = await getJobOutcomeHistory("loan-app-123");
for (const entry of history) {
  console.log(`#${entry.sequence}: ${entry.executionStatus} (${entry.reason ?? "initial report"})`);
}
```

### Using JobContext

```typescript
import { JobContext } from "@revenium/middleware";

const ctx = new JobContext({ jobId: "loan-app-123", teamId: "team-1" });
const result = await ctx.run(async () => {
  // AI calls within this scope are automatically tagged with the job
  return await processLoanApplication();
});

// Report or amend outcomes through the context
await ctx.reportOutcome({
  executionStatus: "SUCCESS",
  outcomeType: "CONVERTED",
  outcomeValue: 150,
});
await ctx.amendOutcome({ reason: "Value correction", outcomeValue: 175 });
```

## Configuration Options

### Common Environment Variables

| Variable                     | Required | Description                                                                       |
| ---------------------------- | -------- | --------------------------------------------------------------------------------- |
| `REVENIUM_METERING_API_KEY`  | Yes      | Revenium API key (starts with `hak_` or `rev_`)                                   |
| `REVENIUM_METERING_BASE_URL` | No       | Revenium API endpoint (default: `https://api.revenium.ai`)                        |
| `REVENIUM_DEBUG`             | No       | Enable debug logging (`true`/`false`)                                             |
| `REVENIUM_PRINT_SUMMARY`     | No       | Terminal summary (`true`, `human`, `json`, `false`)                               |
| `REVENIUM_TEAM_ID`           | No       | Team ID: turns on cost controls (OpenAI) and cost display in the terminal summary |
| `REVENIUM_CAPTURE_PROMPTS`   | No       | Enable prompt capture (`true`/`false`)                                            |

### Configuring in code

`Initialize(config)` and `Configure(config)` for OpenAI, Perplexity and fal.ai accept the settings below. A value passed in code wins over the environment variable; a key left out, or set to `undefined`, is read from the environment, including `.env.local` and `.env` in the working directory, which are loaded into `process.env` on the first `Initialize()`.

| Config key                                  | Environment variable                                                        | Notes                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reveniumApiKey`                            | `REVENIUM_METERING_API_KEY` (or `REVENIUM_API_KEY`)                         |                                                                                                                                                                                                                                                                             |
| `reveniumBaseUrl`                           | `REVENIUM_METERING_BASE_URL` (or `REVENIUM_BASE_URL`)                       | Default `https://api.revenium.ai`                                                                                                                                                                                                                                           |
| `reveniumTeamId` (`teamId` on fal.ai)       | `REVENIUM_TEAM_ID`                                                          | Turns on cost controls (OpenAI) and cost display in the terminal summary. Not read from the environment for either when `reveniumApiKey` differs from `REVENIUM_METERING_API_KEY`; the jobs and outcomes API still falls back to `REVENIUM_TEAM_ID`, so pass `teamId` there |
| `reveniumEnforcementBaseUrl`                | `REVENIUM_ENFORCEMENT_BASE_URL`                                             | OpenAI only, the only provider that enforces cost controls. Not read from the environment when `reveniumApiKey` differs from `REVENIUM_METERING_API_KEY`                                                                                                                    |
| `printSummary`                              | `REVENIUM_PRINT_SUMMARY`                                                    |                                                                                                                                                                                                                                                                             |
| `capturePrompts`                            | `REVENIUM_CAPTURE_PROMPTS`                                                  |                                                                                                                                                                                                                                                                             |
| `maxPromptSize`                             | `REVENIUM_MAX_PROMPT_SIZE`                                                  | The variable is read on each call when the config leaves the key out                                                                                                                                                                                                        |
| `debug`                                     | `REVENIUM_DEBUG`                                                            | Either one turns debug logging on; the variable is read on each log call                                                                                                                                                                                                    |
| `failSilent`, `maxRetries`, `bufferMaxSize` | none                                                                        | Code only. fal.ai `Initialize()` without config reads `failSilent` from `REVENIUM_FAIL_SILENT`                                                                                                                                                                              |
| `openaiApiKey`                              | `OPENAI_API_KEY`                                                            | OpenAI only, read by the OpenAI client                                                                                                                                                                                                                                      |
| `azure`                                     | `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_VERSION` | OpenAI only. Read from the environment only by `Initialize()` without config; when you pass config, pass `azure` to route calls to Azure                                                                                                                                    |
| `perplexityApiKey`                          | `PERPLEXITY_API_KEY`                                                        | Perplexity only                                                                                                                                                                                                                                                             |
| `perplexityBaseUrl`                         | `PERPLEXITY_API_BASE_URL`                                                   | Perplexity only, default `https://api.perplexity.ai`                                                                                                                                                                                                                        |
| `falApiKey`                                 | `FAL_KEY`                                                                   | fal.ai only, read by the fal.ai client                                                                                                                                                                                                                                      |
| `organizationName`, `organizationId`        | `REVENIUM_ORGANIZATION_NAME`, `REVENIUM_ORGANIZATION_ID`                    | fal.ai only. Read from the environment only by `Initialize()` without config                                                                                                                                                                                                |

`setConfig()` applies the config exactly as given and reads nothing from the environment.

### Provider-Specific Variables

| Variable                         | Provider      | Description                                                                                              |
| -------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `OPENAI_API_KEY`                 | OpenAI        | OpenAI API key                                                                                           |
| `AZURE_OPENAI_API_KEY`           | Azure OpenAI  | Azure OpenAI API key                                                                                     |
| `AZURE_OPENAI_ENDPOINT`          | Azure OpenAI  | Azure resource endpoint URL                                                                              |
| `AZURE_OPENAI_API_VERSION`       | Azure OpenAI  | API version, required (e.g. `2024-02-15-preview`)                                                        |
| `ANTHROPIC_API_KEY`              | Anthropic     | Anthropic API key                                                                                        |
| `GOOGLE_API_KEY`                 | Google GenAI  | Google AI Studio API key                                                                                 |
| `GOOGLE_CLOUD_PROJECT`           | Google Vertex | GCP project ID, required unless `projectId` is passed to the call                                        |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Vertex | Optional path to a service account key file; when unset, Google Application Default Credentials are used |
| `GOOGLE_CLOUD_LOCATION`          | Google Vertex | GCP region (default: `us-central1`)                                                                      |
| `PERPLEXITY_API_KEY`             | Perplexity    | Perplexity API key                                                                                       |
| `LITELLM_PROXY_URL`              | LiteLLM       | LiteLLM proxy URL (e.g., `http://localhost:4000`)                                                        |
| `LITELLM_API_KEY`                | LiteLLM       | LiteLLM proxy API key                                                                                    |
| `FAL_KEY`                        | fal.ai        | fal.ai API key                                                                                           |

See [`.env.example`](https://github.com/revenium/revenium-node-sdk/blob/HEAD/.env.example) for the complete list with all optional configuration.

### Outage buffering

A usage record that cannot reach Revenium is kept in memory instead of being lost. This happens when the metering call fails with `408`, `429`, `500`, `502`, `503` or `504` after its retries, on a network error after its retries, on the first 10-second timeout, which is never retried in-line, and while the metering circuit breaker is open after an outage.

- Buffered records are retried every 30 seconds, oldest first, keeping their original `Idempotency-Key`. A replay answered with `409` and a `Retry-After`, because Revenium is still processing the record's first attempt, waits for that delay and is retried, up to three times; a record still answered with `409` after that is discarded so the records behind it are not held back.
- The buffer holds up to 20,000 records by default, about 11 minutes of a service sending 30 records per second. When it is full, the oldest record is discarded and a `Metering buffer full, evicting oldest event` warning is logged; an outage longer than that still loses the oldest usage.
- Records older than 24 hours are discarded on the next flush.
- A full buffer of 20,000 records takes about 28 MB of heap with typical chat records (about 1.4 KB each), and about 76 MB when each record carries around 2.4 KB of metadata.
- With prompt capture on (`capturePrompts` or `REVENIUM_CAPTURE_PROMPTS`), each record also holds the system prompt, the input messages and the response, each up to `maxPromptSize` characters (50,000 by default), at about 1 byte per character, or 2 when the text has characters such as CJK or emoji. A record can then reach about 150 KB, so a full buffer of 20,000 can take about 3 GB of heap, more than a typical container has. When prompt capture is on, set `bufferMaxSize` to the memory you can spare divided by about `3 × maxPromptSize` bytes; for example, 2,000 records keep the buffer under about 300 MB at the default `maxPromptSize`.

Change the limit with `bufferMaxSize` in `Initialize()` or `Configure()` (`configure()` for Anthropic, Google and LiteLLM):

```typescript
import { Initialize } from "@revenium/middleware/openai";

Initialize({ reveniumApiKey: process.env.REVENIUM_METERING_API_KEY, bufferMaxSize: 50_000 });
```

The buffer is shared by the whole process and reads `bufferMaxSize` once, when the buffer is first used: the first buffered record, or the first call to `getBufferStats()` or `flushMeteringBuffer()`. A value set after that is ignored until the process restarts.

Call `flushMeteringBuffer()` to try to send the buffered records immediately, and `getBufferStats()` to read the buffer depth and the `totalFlushed`, `totalDropped`, `totalEvicted` and `totalExpired` counters. Both are exported from the package root and from every provider subpath.

`flushMeteringBuffer()` is best effort. It resolves at once, sending nothing, when a flush is already running, and it stops at the first record that fails with a retryable error or a `429`, leaving that record and the rest buffered for the next flush. Records are sent one at a time, so draining a full buffer of 20,000 takes about 20,000 round trips to Revenium, roughly 17 minutes at 50 ms each. Before a planned shutdown, check `getBufferStats().size` after the call to see how many records are still held in memory.

### Metering several Revenium organizations from one process

`Initialize()` and `Configure()` set the process-wide configuration. To meter more than one organization from a single process, build a client per organization instead and keep using that client for its own calls:

```typescript
import { ReveniumOpenAI, Provider } from "@revenium/middleware/openai";

const orgA = new ReveniumOpenAI(
  { reveniumApiKey: "hak_org_a...", openaiApiKey: process.env.OPENAI_API_KEY },
  Provider.OPENAI,
);
const orgB = new ReveniumOpenAI(
  { reveniumApiKey: "hak_org_b...", openaiApiKey: process.env.OPENAI_API_KEY },
  Provider.OPENAI,
);
```

Every usage record raised through a client carries that client's API key, base URL and prompt-capture setting, resolved when the call starts. Reconfiguring the process while a call or a stream is in flight does not change where that call is reported.

Settings the client leaves out fall back to the process configuration, so a client built with only `reveniumApiKey` keeps the `reveniumBaseUrl`, prompt-capture, retry and summary settings installed by `Initialize()`. A client metering under its own key does not inherit the process `reveniumTeamId`, since a team belongs to the organization that owns the key; set `reveniumTeamId` on the client to report under a team. The constructor validates the resulting configuration and throws on a missing or malformed Revenium API key.

Supported per client: OpenAI, Azure OpenAI, Perplexity and fal.ai.

Process-wide, and therefore following the last `Initialize()`/`Configure()` call:

- **Anthropic** — the SDK is instrumented by patching the shared `Messages` prototype, so one key per process.
- **Google GenAI and Google Vertex AI**, and the **LiteLLM** proxy.
- **Cost controls / enforcement** — rules are polled under the process configuration, and those rules decide every call, including calls made through a per-organization client. A `BLOCK` directive on a metering reply is kept per Revenium API key, so it only refuses calls made under the key the record was metered with.
- **Jobs and outcomes API** — outcomes are reported under the process configuration.
- **Outage buffer** — one buffer holds the records of every client, sized by the process configuration, so a `bufferMaxSize` passed to a per-organization client is ignored.
- **Tool metering** — `meterTool()` and `reportToolCall()` are not bound to a client. They report under the configuration of the call they run inside, and under the process configuration when there is none.

## Troubleshooting

### No tracking data appears

1. Verify environment variables are set correctly in `.env`
2. Enable debug logging: `REVENIUM_DEBUG=true`
3. Check console for `[Revenium]` log messages
4. Verify your `REVENIUM_METERING_API_KEY` is valid

### Client not initialized error

- Make sure you call `Initialize()` before `GetClient()`
- Check that your `.env` file is in the directory the process is started from (`process.cwd()`), or set the variables in the real environment
- Verify `REVENIUM_METERING_API_KEY` is set

### Azure OpenAI not working

- Verify all Azure environment variables are set (see `.env.example`)
- Check that `AZURE_OPENAI_ENDPOINT` and `AZURE_OPENAI_API_KEY` are correct
- Ensure you're using a valid deployment name in the `model` parameter

### Debug Mode

Enable detailed logging:

```env
REVENIUM_DEBUG=true
```

## Testing

```bash
npm test                # Run all tests
npm run test:core       # Run core module tests
npm run test:openai     # Run OpenAI tests
npm run test:anthropic  # Run Anthropic tests
npm run test:google     # Run Google tests
npm run test:perplexity # Run Perplexity tests
npm run test:litellm    # Run LiteLLM tests
npm run test:fal        # Run fal.ai tests
npm run test:integration # Run integration tests
npm run test:coverage   # Run tests with coverage
```

## Requirements

- Node.js 18+
- TypeScript 5.0+ (for TypeScript projects)
- At least one provider SDK installed as peer dependency

## Contributing

See [CONTRIBUTING.md](https://github.com/revenium/revenium-node-sdk/blob/HEAD/CONTRIBUTING.md)

## Code of Conduct

See [CODE_OF_CONDUCT.md](https://github.com/revenium/revenium-node-sdk/blob/HEAD/CODE_OF_CONDUCT.md)

## Security

See [SECURITY.md](https://github.com/revenium/revenium-node-sdk/blob/HEAD/SECURITY.md)

## License

This project is licensed under the MIT License - see the [LICENSE](https://github.com/revenium/revenium-node-sdk/blob/HEAD/LICENSE) file for details.

## Support

- **Website**: [www.revenium.ai](https://www.revenium.ai)
- **Documentation**: [docs.revenium.io](https://docs.revenium.io)
- **Issues**: [Report bugs or request features](https://github.com/revenium/revenium-node-sdk/issues)
- **Email**: support@revenium.io

---

**Built by Revenium**
