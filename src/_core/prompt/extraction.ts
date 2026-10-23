import { UsageMetadata } from "../types/index.js";
import { resolveConfig } from "../config/call-config.js";
import { DEFAULT_CONFIG } from "../constants.js";

export interface PromptData {
  systemPrompt?: string;
  inputMessages?: string;
  outputResponse?: string;
  promptsTruncated: boolean;
}

interface ContentBlock {
  type: string;
  text?: string;
  image_url?: unknown;
}

type MessageContent = string | ContentBlock[];

export function getMaxPromptSize(): number {
  const config = resolveConfig();
  if (config?.maxPromptSize && config.maxPromptSize > 0) {
    return config.maxPromptSize;
  }

  const envValue = process.env.REVENIUM_MAX_PROMPT_SIZE;
  if (envValue) {
    const parsed = parseInt(envValue, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }

  return DEFAULT_CONFIG.MAX_PROMPT_SIZE;
}

export function shouldCapturePrompts(metadata?: UsageMetadata): boolean {
  if (metadata?.capturePrompts !== undefined) {
    return metadata.capturePrompts;
  }

  const config = resolveConfig();
  if (config?.capturePrompts !== undefined) {
    return config.capturePrompts;
  }

  const envValue = process.env.REVENIUM_CAPTURE_PROMPTS;
  if (envValue !== undefined) {
    return envValue.toLowerCase() === "true";
  }

  return DEFAULT_CONFIG.CAPTURE_PROMPTS;
}

export function sanitizeCredentials(text: string): string {
  const patterns = [
    { regex: /pplx-[a-zA-Z0-9_-]{20,}/g, replacement: "pplx-***REDACTED***" },
    { regex: /sk-proj-[a-zA-Z0-9_-]{48,}/g, replacement: "sk-proj-***REDACTED***" },
    { regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, replacement: "sk-ant-***REDACTED***" },
    { regex: /sk-[a-zA-Z0-9_-]{20,}/g, replacement: "sk-***REDACTED***" },
    { regex: /AKIA[A-Z0-9]{16}/g, replacement: "AKIA***REDACTED***" },
    { regex: /ghp_[a-zA-Z0-9]{36,}/g, replacement: "ghp_***REDACTED***" },
    { regex: /ghs_[a-zA-Z0-9]{36,}/g, replacement: "ghs_***REDACTED***" },
    {
      regex: /eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g,
      replacement: "***REDACTED_JWT***",
    },
    { regex: /Bearer\s+[a-zA-Z0-9_\-.+\/=]+/gi, replacement: "Bearer ***REDACTED***" },
    {
      regex: /api[_-]?key["'\s:=]+[a-zA-Z0-9_\-.+\/=]{20,}/gi,
      replacement: "api_key: ***REDACTED***",
    },
    { regex: /token["'\s:=]+[a-zA-Z0-9_\-.+\/=]{20,}/gi, replacement: "token: ***REDACTED***" },
    {
      regex: /password["'\s:=]+["']?([^"'\s]{8,})["']?/gi,
      replacement: "password: ***REDACTED***",
    },
    { regex: /secret["'\s:=]+["']?([^"'\s]{8,})["']?/gi, replacement: "secret: ***REDACTED***" },
  ];

  let sanitized = text;
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern.regex, pattern.replacement);
  }
  return sanitized;
}

export function truncateString(
  str: string | null | undefined,
  maxLength: number,
): { value: string; truncated: boolean } {
  if (!str || str.length === 0) return { value: "", truncated: false };
  const sanitized = sanitizeCredentials(str);
  if (sanitized.length <= maxLength) return { value: sanitized, truncated: false };
  return { value: sanitized.substring(0, maxLength), truncated: true };
}

function contentBlocksToString(blocks: ContentBlock[]): string {
  return blocks
    .map((block) => {
      if (block.type === "text" && block.text) return block.text;
      if (block.type === "image_url") return "[IMAGE]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export function extractPrompts(
  messages: any[],
  responseContent: string | undefined,
  metadata?: UsageMetadata,
): PromptData | null {
  if (!shouldCapturePrompts(metadata)) return null;

  const maxSize = getMaxPromptSize();
  let anyTruncated = false;

  const systemMessages = (messages || [])
    .filter((msg: any) => msg.role === "system")
    .map((msg: any) => {
      const content = msg.content as MessageContent;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) return contentBlocksToString(content);
      return "";
    })
    .filter(Boolean);

  const systemPromptRaw = systemMessages.join("\n\n");
  const systemPromptResult = truncateString(systemPromptRaw, maxSize);
  anyTruncated = anyTruncated || systemPromptResult.truncated;

  const inputMessagesRaw = (messages || [])
    .filter((msg: any) => msg.role !== "system")
    .map((message: any) => {
      const role = message.role;
      let content = "";
      const msgContent = message.content as MessageContent;
      if (typeof msgContent === "string") content = msgContent;
      else if (Array.isArray(msgContent)) content = contentBlocksToString(msgContent);
      return `[${role}]\n${content}`;
    })
    .join("\n\n");

  const inputMessagesResult = truncateString(inputMessagesRaw, maxSize);
  anyTruncated = anyTruncated || inputMessagesResult.truncated;

  const outputResponseResult = truncateString(responseContent, maxSize);
  anyTruncated = anyTruncated || outputResponseResult.truncated;

  const hasAnyContent =
    systemPromptResult.value || inputMessagesResult.value || outputResponseResult.value;

  if (!hasAnyContent) return null;

  return {
    systemPrompt: systemPromptResult.value || undefined,
    inputMessages: inputMessagesResult.value || undefined,
    outputResponse: outputResponseResult.value || undefined,
    promptsTruncated: anyTruncated,
  };
}
