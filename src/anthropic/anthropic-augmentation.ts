import { UsageMetadata } from "../_core/types/index.js";

export {};

declare module "@anthropic-ai/sdk/resources/messages" {
  interface MessageCreateParamsBase {
    usageMetadata?: UsageMetadata;
  }

  interface MessageCreateParamsNonStreaming {
    usageMetadata?: UsageMetadata;
  }

  interface MessageCreateParamsStreaming {
    usageMetadata?: UsageMetadata;
  }
}

declare module "@anthropic-ai/sdk/resources/beta/messages/messages" {
  interface MessageCreateParamsBase {
    usageMetadata?: UsageMetadata;
  }

  interface MessageCreateParamsNonStreaming {
    usageMetadata?: UsageMetadata;
  }

  interface MessageCreateParamsStreaming {
    usageMetadata?: UsageMetadata;
  }
}
