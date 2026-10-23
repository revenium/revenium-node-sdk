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
- **Fire-and-Forget** - Metering never blocks your application flow
- **Streaming Support** - Handles regular and streaming requests for all providers
- **ESM + CJS** - Dual output with full TypeScript type definitions
- **Automatic .env Loading** - Reads `.env.local` and `.env` from your application's working directory, with no extra dependency. Real environment variables always win; files outside the working directory are never read

## Supported Providers

| Provider         | Sub-Path Import                      | API Pattern                                                 |
| ---------------- | ------------------------------------ | ----------------------------------------------------------- |
| OpenAI           | `@revenium/middleware/openai`        | `Initialize()` / `GetClient()`                              |
| Azure OpenAI     | `@revenium/middleware/openai`        | `Initialize()` / `GetClient()` (auto-detected)              |
| Anthropic        | `@revenium/middleware/anthropic`     | `initialize()` / `configure()` / auto-init on import        |
| Foundry          | `@revenium/middleware/anthropic`     | Same as Anthropic (auto-detected from the base URL)         |
| Google GenAI     | `@revenium/middleware/google/genai`  | `GoogleGenAIController` / `configure()` / init on first use |
| Google Vertex AI | `@revenium/middleware/google/vertex` | `VertexAIController` / `configure()` / init on first use    |
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

```typescript
import { Initialize, GetClient } from "@revenium/middleware/openai";

Initialize();
const client = GetClient();

const response = await client.chat.completions.create({
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
import { GoogleGenAIController } from "@revenium/middleware/google/genai";

const controller = new GoogleGenAIController();

const response = await controller.createChat(["Hello!"], "gemini-2.0-flash-001");
```

### Quick Start - Azure OpenAI

```typescript
import { Initialize, GetClient } from "@revenium/middleware/openai";

Initialize();
const client = GetClient();

const response = await client.chat.completions.create({
  model: "my-deployment-name",
  messages: [{ role: "user", content: "Hello!" }],
});
```

Azure is auto-detected when `AZURE_OPENAI_API_KEY` and `AZURE_OPENAI_ENDPOINT` are set.

### Quick Start - Google Vertex AI

Ensure `GOOGLE_CLOUD_PROJECT`, `GOOGLE_APPLICATION_CREDENTIALS` and `REVENIUM_METERING_API_KEY` are set in your environment or `.env` file.

```typescript
import { VertexAIController } from "@revenium/middleware/google/vertex";

const controller = new VertexAIController();

const response = await controller.createChat(["Hello!"], "gemini-2.0-flash-001");
```

### Quick Start - Perplexity

```typescript
import { Initialize, GetClient } from "@revenium/middleware/perplexity";

Initialize();
const client = GetClient();

const response = await client.chat.completions.create({
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

| Function              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from environment or explicit config |
| `GetClient()`         | Get the wrapped OpenAI client instance                    |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration   |
| `IsInitialized()`     | Check if middleware is initialized                        |
| `Reset()`             | Reset the global client (useful for testing)              |

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

### Google GenAI / Vertex AI

Controller and service pattern:

| Export                                         | Description                           |
| ---------------------------------------------- | ------------------------------------- |
| `GoogleGenAIController` / `VertexAIController` | Main controller for API calls         |
| `GoogleGenAIService` / `VertexAIService`       | Service implementation                |
| `trackGoogleUsageAsync()`                      | Manual usage tracking                 |
| `mapGoogleFinishReason()`                      | Map finish reasons to standard format |

Google accepts the same per-call `usageMetadata` as every other provider, including `subscriber`, `environment`, `region`, `ticketId`, the trace fields and the skill fields. See [Metadata Fields](#metadata-fields). The flat `subscriberId`, `subscriberEmail`, `subscriberCredential` and `subscriberCredentialName` fields remain supported and are folded into `subscriber`; when both forms are present, `subscriber` wins field by field.

### Perplexity

Same Go-aligned client pattern as OpenAI:

| Function              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from environment or explicit config |
| `GetClient()`         | Get the wrapped Perplexity client instance                |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration   |
| `IsInitialized()`     | Check if middleware is initialized                        |
| `Reset()`             | Reset the global client (useful for testing)              |

### fal.ai

Enterprise wrapper for fal.ai's multi-modal platform (images, video, audio, LLM) with automatic metering:

| Function              | Description                                               |
| --------------------- | --------------------------------------------------------- |
| `Initialize(config?)` | Initialize middleware from environment or explicit config |
| `GetClient()`         | Get the wrapped fal.ai client instance                    |
| `Configure(config)`   | Alias for `Initialize()` for programmatic configuration   |
| `IsInitialized()`     | Check if middleware is initialized                        |
| `Reset()`             | Reset the global client (useful for testing)              |

**Client Methods:**

| Method                                          | Description                                                          |
| ----------------------------------------------- | -------------------------------------------------------------------- |
| `fal.subscribe(endpointId, options, metadata?)` | Submit to queue and wait for result (recommended for most use cases) |
| `fal.run(endpointId, options, metadata?)`       | Execute directly and wait for result (low-latency models)            |
| `fal.stream(endpointId, options, metadata?)`    | Stream partial results (real-time LLM or progress tracking)          |
| `fal.queue`                                     | Access the underlying queue client directly                          |
| `fal.realtime`                                  | Access the underlying realtime client directly                       |
| `fal.storage`                                   | Access the underlying storage client directly                        |
| `fal.getUnderlyingClient()`                     | Get the raw `FalClient` instance (not metered)                       |

The `metadata` parameter is optional on all methods and enables cost attribution (e.g., `{ subscriber: { id: '...' }, organizationName, traceId }`). It does not affect the fal.ai payload. See [Metadata Fields](#metadata-fields) for all supported options.

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
| `operationSubtype`       | string | Overrides the detected image/audio/video subtype         |

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

Per-call enforcement blocks outgoing provider requests when a subscriber has a breached `BLOCK` cost control configured in Revenium. The OpenAI middleware gates both sync and streaming chat completions; other providers will adopt the same gate in follow-up work (unified exception + Anthropic wiring + Node/Python/Go env-var normalization). Enforcement currently covers chat completions only; embeddings, images, and audio are not gated.

### Environment variables

| Variable                        | Required            | Description                                                                                                                                                         |
| ------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REVENIUM_METERING_API_KEY`     | Yes                 | Revenium API key (starts with `hak_` or `rev_`). The `_METERING_` infix is load-bearing.                                                                            |
| `REVENIUM_TEAM_ID`              | Yes for enforcement | Hashed team ID. If unset, the engine starts dormant (warns once, skips cost control fetch) and all provider calls pass through.                                     |
| `REVENIUM_ENFORCEMENT_BASE_URL` | No                  | Host base for the enforcement API (e.g. `https://api.revenium.ai`); the SDK appends the service path itself. Falls back to `REVENIUM_METERING_BASE_URL` when unset. |

### How it works

`Initialize()` (from `@revenium/middleware/openai`) calls `startEnforcementPolling()`, which boots a background poller on `/profitstream/v2/api/ai/enforcement-rules/{teamId}` every 30s with ±20% jitter. Fetched cost controls are cached in memory; a `204 No Content` response caches an empty set. A `4xx` response leaves the cache untouched and logs a warning on every poll, naming the requested URL and status and stating whether previously loaded cost controls are still blocking calls or nothing is loaded; a `429` additionally backs polling off for the `Retry-After` window (capped at 60s). The poll timer is `unref`'d so it never prevents process exit.

Before every chat completion (sync and streaming), the middleware builds enforcement criteria from the request — `subscriberId` and `subscriberEmail` from `metadata.subscriber`, `credential` from the subscriber credential's alias name (its secret value is used only when no name field was supplied at all), `model` from request params, `agent` and `taskType` from metadata, `productName` and `organizationName` from metadata (each falling back to its deprecated `*Id` spelling the way the metered record does), `provider` from the detected provider — and calls `enforcePreCallRules(criteria)`. The evaluator resolves the caller to the subscriber id and the normalized email, then:

- acts on a cost control only when its `filters[]` cover the call. Filter rows compose with AND, a row with no value constrains nothing, and a cost control with no filters covers every call. The dimensions the SDK evaluates are `MODEL`, `PROVIDER`, `AGENT`, `PRODUCT`, `TASK_TYPE`, `ORGANIZATION`, `SUBSCRIBER` and `CREDENTIAL`; `PROVIDER` compares ignoring letter case, `SUBSCRIBER` ignores case only when the caller supplied an email, and the rest compare exactly. A row the SDK cannot evaluate — any other dimension, including `DEPARTMENT` outside the department path below, or an operator outside `IS` / `IS_NOT` / `IN` / `CONTAINS` / `STARTS_WITH` / `ENDS_WITH` — makes the cost control cover nothing client-side and leaves it to the platform, which enforces it server-side regardless;
- on a per-person cost control (`groupBy` set), looks the caller up in `groupBreakdown` and acts only on their own row: someone who has not crossed the limit passes even while a teammate is blocked, and the error reports the blocked person's own figure. A grouped cost control the server sent no breakdown for (its metric is not cost) blocks nobody;
- on a department-scoped cost control, acts only when the caller is named in `departmentBudgetBlocks`, reporting the balance from `departmentBudgetBlockBalances`. The server has already resolved the `DEPARTMENT` row by naming the caller, so that row is skipped and the cost control's other filter rows are applied as usual: a department cap scoped to one provider or model covers only that traffic;
- on a team-wide cost control, skips it where `breached === false` and otherwise acts on the rule-level `currentValue`;
- logs a warning and continues past cost controls where `shadowMode === true` or `action ∈ {WARN_ONLY, THROTTLE}` — these are observation-only client-side; the server still enforces server-side throttling;
- throws `CostLimitExceeded` on the first matching `BLOCK` cost control.

A caller carrying neither a subscriber id nor an email cannot be matched against a per-person or department-scoped cost control, so those pass; team-wide cost controls still block it.

A `MODEL` or `PROVIDER` filter is matched against what the request asks for, because the gate runs before the provider replies, while the metered record carries what the response reports. The two differ on three known paths: on Azure the request names the deployment and the record the provider model; on a streamed OpenAI chat the request names the alias (`gpt-4o`) and the record the dated model the chunks report (`gpt-4o-2024-08-06`); and on a call proxied through LiteLLM the gate sees the transport provider (`OpenAI`) where the record names the upstream one (`Anthropic`). A cost control written from what Revenium reporting shows therefore may not block client-side on those paths. The platform's own evaluation is authoritative and still enforces the cap server-side.

The engine fails open: missing team ID, network outages, an unreachable Revenium API, or a parse error all leave the cache untouched and `enforcePreCallRules` becomes a no-op (the request passes). Enforcement errors never bubble to user code as metering failures.

### Error shape

```ts
class CostLimitExceeded extends ReveniumError {
  readonly ruleId: string; // numeric server ruleId, stringified for JSON-safe logging
  readonly threshold: number; // cost control limit
  readonly currentValue: number; // subscriber's metered value at block time
  readonly periodType: string; // DAILY / WEEKLY / MONTHLY / QUARTERLY
  readonly context?: Record<string, unknown>; // subscriberId / subscriberEmail / productName / model / provider at call time
}
```

`CostLimitExceeded` is exported from the package root:

```ts
import { CostLimitExceeded } from "@revenium/middleware";
```

### Usage

```ts
import { Initialize, GetClient } from "@revenium/middleware/openai";
import { CostLimitExceeded } from "@revenium/middleware";

Initialize(); // loads REVENIUM_METERING_API_KEY + REVENIUM_TEAM_ID from env, starts enforcement polling
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
    console.warn(
      `blocked by cost control ${err.ruleId}: $${err.currentValue.toFixed(2)} of $${err.threshold.toFixed(2)} ${err.periodType} limit`,
    );
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

| Variable                     | Required | Description                                                |
| ---------------------------- | -------- | ---------------------------------------------------------- |
| `REVENIUM_METERING_API_KEY`  | Yes      | Revenium API key (starts with `hak_` or `rev_`)            |
| `REVENIUM_METERING_BASE_URL` | No       | Revenium API endpoint (default: `https://api.revenium.ai`) |
| `REVENIUM_DEBUG`             | No       | Enable debug logging (`true`/`false`)                      |
| `REVENIUM_PRINT_SUMMARY`     | No       | Terminal summary (`true`, `human`, `json`, `false`)        |
| `REVENIUM_TEAM_ID`           | No       | Team ID for cost display in terminal summary               |
| `REVENIUM_CAPTURE_PROMPTS`   | No       | Enable prompt capture (`true`/`false`)                     |

### Provider-Specific Variables

| Variable                         | Provider      | Description                                       |
| -------------------------------- | ------------- | ------------------------------------------------- |
| `OPENAI_API_KEY`                 | OpenAI        | OpenAI API key                                    |
| `AZURE_OPENAI_API_KEY`           | Azure OpenAI  | Azure OpenAI API key                              |
| `AZURE_OPENAI_ENDPOINT`          | Azure OpenAI  | Azure resource endpoint URL                       |
| `AZURE_OPENAI_API_VERSION`       | Azure OpenAI  | API version (default: `2024-02-15-preview`)       |
| `ANTHROPIC_API_KEY`              | Anthropic     | Anthropic API key                                 |
| `GOOGLE_API_KEY`                 | Google GenAI  | Google AI Studio API key                          |
| `GOOGLE_CLOUD_PROJECT`           | Google Vertex | GCP project ID                                    |
| `GOOGLE_APPLICATION_CREDENTIALS` | Google Vertex | Path to service account key file                  |
| `GOOGLE_CLOUD_LOCATION`          | Google Vertex | GCP region (default: `us-central1`)               |
| `PERPLEXITY_API_KEY`             | Perplexity    | Perplexity API key                                |
| `LITELLM_PROXY_URL`              | LiteLLM       | LiteLLM proxy URL (e.g., `http://localhost:4000`) |
| `LITELLM_API_KEY`                | LiteLLM       | LiteLLM proxy API key                             |
| `FAL_KEY`                        | fal.ai        | fal.ai API key                                    |

See [`.env.example`](https://github.com/revenium/revenium-node-sdk/blob/HEAD/.env.example) for the complete list with all optional configuration.

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
- **Cost controls / enforcement** — rules are polled under the process configuration, and those rules decide every call, including calls made through a per-organization client.
- **Jobs and outcomes API** — outcomes are reported under the process configuration.
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
