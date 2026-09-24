import { getLogger } from "../config/manager.js";

export const IMAGE_OPERATION_SUBTYPES = [
  "generation",
  "edit",
  "variation",
  "upscale",
  "inpainting",
] as const;

export const AUDIO_OPERATION_SUBTYPES = [
  "transcription",
  "translation",
  "synthesis",
  "speech",
  "tts",
  "realtime",
] as const;

export const VIDEO_OPERATION_SUBTYPES = ["generation", "upscale", "extend", "edit"] as const;

export type ImageOperationSubtype = (typeof IMAGE_OPERATION_SUBTYPES)[number];
export type AudioOperationSubtype = (typeof AUDIO_OPERATION_SUBTYPES)[number];
export type VideoOperationSubtype = (typeof VIDEO_OPERATION_SUBTYPES)[number];

export type LegacyAudioOperationSubtype = "speech_synthesis" | "audio_generation";

export const LEGACY_AUDIO_OPERATION_SUBTYPES: Readonly<
  Record<LegacyAudioOperationSubtype, AudioOperationSubtype>
> = {
  speech_synthesis: "tts",
  audio_generation: "synthesis",
};

export type AudioBillingUnit = "per_character" | "per_minute" | "per_second";

const AUDIO_BILLING_UNITS: Record<AudioOperationSubtype, AudioBillingUnit> = {
  transcription: "per_minute",
  translation: "per_minute",
  synthesis: "per_second",
  speech: "per_character",
  tts: "per_character",
  realtime: "per_second",
};

export function resolveAudioBillingUnit(
  subtype: AudioOperationSubtype,
  characterCount: number,
  durationSeconds: number,
): AudioBillingUnit {
  const unit = AUDIO_BILLING_UNITS[subtype];
  if (unit === "per_character" && characterCount === 0 && durationSeconds > 0) {
    return "per_second";
  }
  return unit;
}

function normalizeOperationSubtype<T extends string>(
  accepted: readonly T[],
  value: string,
  aliases: Readonly<Record<string, T>>,
): T | undefined {
  const normalized = value.trim().toLowerCase();
  if (accepted.includes(normalized as T)) return normalized as T;
  return aliases[normalized];
}

export function resolveOperationSubtype<T extends string>(
  accepted: readonly T[],
  override: unknown,
  detected: T,
  aliases: Readonly<Record<string, T>> = {},
): T {
  if (typeof override !== "string" || override.trim() === "") return detected;
  const resolved = normalizeOperationSubtype(accepted, override, aliases);
  if (resolved !== undefined) return resolved;
  getLogger().warn("Ignoring unsupported operationSubtype override", { override, detected });
  return detected;
}

function isLegacyAudioSubtype(subtype: string): subtype is LegacyAudioOperationSubtype {
  return subtype in LEGACY_AUDIO_OPERATION_SUBTYPES;
}

function toAcceptedAudioSubtype(
  subtype: AudioOperationSubtype | LegacyAudioOperationSubtype,
): AudioOperationSubtype {
  return isLegacyAudioSubtype(subtype) ? LEGACY_AUDIO_OPERATION_SUBTYPES[subtype] : subtype;
}

export function resolveAudioOperationSubtype(
  override: unknown,
  detected: AudioOperationSubtype | LegacyAudioOperationSubtype,
): AudioOperationSubtype {
  return resolveOperationSubtype(
    AUDIO_OPERATION_SUBTYPES,
    override,
    toAcceptedAudioSubtype(detected),
    LEGACY_AUDIO_OPERATION_SUBTYPES,
  );
}
