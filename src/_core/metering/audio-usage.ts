import { getLogger } from "../config/manager.js";

export interface AudioUsage {
  durationSeconds: number;
  audioTokenCount: number;
  inputTokenCount?: number;
  outputTokenCount?: number;
  totalTokenCount?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function sumTokenCounts(
  inputTokenCount: number | undefined,
  outputTokenCount: number | undefined,
): number | undefined {
  if (inputTokenCount === undefined && outputTokenCount === undefined) return undefined;
  return (inputTokenCount ?? 0) + (outputTokenCount ?? 0);
}

function readTokenUsage(usage: Record<string, unknown>): AudioUsage {
  const audioTokenCount = asNumber(asRecord(usage.input_token_details)?.audio_tokens) ?? 0;

  if (audioTokenCount === 0) {
    getLogger().warn("Audio usage reported in tokens without an audio token count", { usage });
  }

  const inputTokenCount = asNumber(usage.input_tokens);
  const outputTokenCount = asNumber(usage.output_tokens);

  return {
    durationSeconds: 0,
    audioTokenCount,
    inputTokenCount,
    outputTokenCount,
    totalTokenCount:
      asNumber(usage.total_tokens) ?? sumTokenCounts(inputTokenCount, outputTokenCount),
  };
}

export function readAudioUsage(response: unknown): AudioUsage {
  const body = asRecord(response);
  const usage = asRecord(body?.usage);

  if (usage?.type === "tokens") return readTokenUsage(usage);

  if (usage?.type === "duration") {
    return { durationSeconds: asNumber(usage.seconds) ?? 0, audioTokenCount: 0 };
  }

  if (usage !== undefined) {
    getLogger().warn("Unrecognized audio usage shape, falling back to the response duration", {
      usageType: usage.type,
    });
  }

  return { durationSeconds: asNumber(body?.duration) ?? 0, audioTokenCount: 0 };
}
