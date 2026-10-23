const BYTE_ORDER_MARK = /^\uFEFF/;

const ENTRY =
  /^\s*(?:export\s+)?([\w.-]+)(?:\s*=\s*?|:\s+?)(\s*'(?:\\'|[^'])*'|\s*"(?:\\"|[^"])*"|\s*`(?:\\`|[^`])*`|[^#\r\n]+)?\s*(?:#.*)?$/gm;

const SURROUNDING_QUOTES = /^(['"`])([\s\S]*)\1$/;

function readValue(raw: string): string {
  const trimmed = raw.trim();
  const unquoted = trimmed.replace(SURROUNDING_QUOTES, "$2");

  if (trimmed[0] !== '"') return unquoted;

  return unquoted.replace(/\\n/g, "\n").replace(/\\r/g, "\r");
}

export function parseEnvFile(contents: string): Record<string, string> {
  const normalized = contents.replace(BYTE_ORDER_MARK, "").replace(/\r\n?/g, "\n");
  const values: Record<string, string> = {};

  for (const [, key, rawValue] of normalized.matchAll(ENTRY)) {
    values[key] = readValue(rawValue ?? "");
  }

  return values;
}
