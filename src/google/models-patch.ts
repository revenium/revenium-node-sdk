import { Chats, Models } from "@google/genai";
import type { CreateChatParameters, GenerateContentParameters } from "@google/genai";
import { getLogger } from "../_core/config/manager.js";
import { GoogleUsageMetadata } from "./types.js";
import {
  meterEmbedContent,
  meterGenerateContent,
  meterGenerateContentStream,
  type ForwardRequest,
  type MeteredModels,
} from "./request-metering.js";

type SdkPrototype = Record<string, unknown>;
type SdkMethod<P, R> = (this: unknown, params: P) => R;
type RequestMeter<P, R> = (
  models: MeteredModels,
  original: ForwardRequest<P, R>,
  params: P,
) => Promise<R>;

const PATCHED_MARKER = Symbol.for("revenium.middleware.googleGenAIPatched");

function patchMember<M>(
  prototype: SdkPrototype,
  name: string,
  replace: (original: M) => unknown,
): boolean {
  const original = prototype[name];
  if (typeof original !== "function") {
    getLogger().warn("Google GenAI surface unavailable, it will not be metered", {
      surface: name,
    });
    return false;
  }

  prototype[name] = replace(original as M);
  return true;
}

function patchRequest<P, R>(
  prototype: SdkPrototype,
  name: string,
  meter: RequestMeter<P, R>,
): boolean {
  return patchMember<SdkMethod<Omit<P, "usageMetadata">, Promise<R>>>(
    prototype,
    name,
    (original) =>
      function (this: MeteredModels, params: P) {
        return meter(this, (cleanParams) => original.call(this, cleanParams), params);
      },
  );
}

function keepUsageMetadata(original: SdkMethod<GenerateContentParameters, Promise<object>>) {
  return async function (this: unknown, params: GenerateContentParameters) {
    const transformed = await original.call(this, params);
    return { ...transformed, usageMetadata: params.usageMetadata };
  };
}

function withChatUsageMetadata(models: Models, usageMetadata?: GoogleUsageMetadata): Models {
  return Object.create(models, {
    generateContent: {
      value: (params: GenerateContentParameters) =>
        models.generateContent({ ...params, usageMetadata }),
    },
    generateContentStream: {
      value: (params: GenerateContentParameters) =>
        models.generateContentStream({ ...params, usageMetadata }),
    },
  });
}

function attachChatUsageMetadata(
  original: SdkMethod<CreateChatParameters, { modelsModule: Models }>,
) {
  return function (this: unknown, params: CreateChatParameters) {
    const { usageMetadata, ...chatParams } = params;
    const chat = original.call(this, chatParams);
    chat.modelsModule = withChatUsageMetadata(chat.modelsModule, usageMetadata);
    return chat;
  };
}

function embedMethodName(prototype: SdkPrototype): string {
  return typeof prototype.embedContentInternal === "function"
    ? "embedContentInternal"
    : "embedContent";
}

export function isGoogleGenAIPatched(client?: { models: object }): boolean {
  const prototype = client ? Object.getPrototypeOf(client.models) : Models.prototype;
  return prototype[PATCHED_MARKER] === true;
}

export function patchGoogleGenAI(): void {
  if (PATCHED_MARKER in Models.prototype) return;

  const modelsPrototype = Models.prototype as unknown as SdkPrototype;
  const requestsPatched = [
    patchRequest(modelsPrototype, "generateContentInternal", meterGenerateContent),
    patchRequest(modelsPrototype, "generateContentStreamInternal", meterGenerateContentStream),
    patchRequest(modelsPrototype, embedMethodName(modelsPrototype), meterEmbedContent),
  ].every(Boolean);
  patchMember(modelsPrototype, "processParamsMaybeAddMcpUsage", keepUsageMetadata);
  patchMember(Chats.prototype as unknown as SdkPrototype, "create", attachChatUsageMetadata);

  Object.defineProperty(Models.prototype, PATCHED_MARKER, { value: requestsPatched });
}
