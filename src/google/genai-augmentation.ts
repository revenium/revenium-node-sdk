import { GoogleUsageMetadata } from "./types.js";

export {};

declare module "@google/genai" {
  interface GenerateContentParameters {
    usageMetadata?: GoogleUsageMetadata;
  }

  interface EmbedContentParameters {
    usageMetadata?: GoogleUsageMetadata;
  }

  interface CreateChatParameters {
    usageMetadata?: GoogleUsageMetadata;
  }
}
