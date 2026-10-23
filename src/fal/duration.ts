import { getLogger } from "../_core/config/manager.js";
import type { FalAudioResult, FalVideoResult } from "./types.js";

const NUMERIC_SECONDS_PATTERN = /^\d+(\.\d+)?s?$/i;

const DURATION_KEYS = ["duration", "duration_seconds", "seconds_total", "total_seconds"] as const;

const VIDEO_DEFAULT_DURATIONS: ReadonlyArray<{ pattern: RegExp; seconds: number }> = [
  { pattern: /^fal-ai\/veo3(\/fast)?(\/image-to-video)?$/i, seconds: 8 },
  { pattern: /^fal-ai\/kling-video\/(v2\/master|v1\.6\/pro)\/(text|image)-to-video$/i, seconds: 5 },
];

export function parseDurationSeconds(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;

  const trimmed = value.trim();
  if (!NUMERIC_SECONDS_PATTERN.test(trimmed)) return undefined;

  const seconds = Number.parseFloat(trimmed);
  return seconds > 0 ? seconds : undefined;
}

export function readStatedDurationSeconds(source: unknown): number | undefined {
  if (typeof source !== "object" || source === null) return undefined;

  const record = source as Record<string, unknown>;
  for (const key of DURATION_KEYS) {
    const seconds = parseDurationSeconds(record[key]);
    if (seconds !== undefined) return seconds;
  }
  return undefined;
}

export function resolveVideoDurationSeconds(
  endpointId: string,
  input: Record<string, unknown> | undefined,
  result: FalVideoResult | undefined,
): number | undefined {
  const stated = readStatedDurationSeconds(input) ?? readStatedDurationSeconds(result);
  if (stated !== undefined) return stated;

  const modelDefault = VIDEO_DEFAULT_DURATIONS.find(({ pattern }) => pattern.test(endpointId));
  if (modelDefault) return modelDefault.seconds;

  getLogger().warn("No fal video duration resolved, omitting durationSeconds", { endpointId });
  return undefined;
}

export function resolveTranscriptDurationSeconds(
  result: FalAudioResult | undefined,
): number | undefined {
  const stated = readStatedDurationSeconds(result);
  if (stated !== undefined) return stated;

  return (result?.chunks ?? []).reduce<number | undefined>((longest, chunk) => {
    const reached =
      parseDurationSeconds(chunk?.timestamp?.[1]) ?? parseDurationSeconds(chunk?.timestamp?.[0]);
    if (reached === undefined) return longest;
    return longest === undefined || reached > longest ? reached : longest;
  }, undefined);
}
