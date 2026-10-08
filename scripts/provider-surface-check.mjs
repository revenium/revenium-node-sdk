#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const PROVIDERS = [
  {
    name: "openai",
    pkg: "openai",
    sourceDirs: ["src/openai", "src/perplexity"],
    typeFiles: [
      "resources/completions.d.ts",
      "resources/responses/responses.d.ts",
      "resources/chat/completions/completions.d.ts",
    ],
    usageRoots: ["CompletionUsage", "ResponseUsage"],
    stopReasonTypes: [
      {
        owner: "ChatCompletion.Choice",
        prop: "finish_reason",
        mapperFiles: ["src/_core/stop-reason-mapper.ts"],
      },
      { alias: "ResponseStatus", mapperFiles: ["src/openai/responses-stop-reason.ts"] },
      {
        owner: "Response.IncompleteDetails",
        prop: "reason",
        mapperFiles: ["src/openai/responses-stop-reason.ts"],
      },
    ],
    mapperKeyPattern: /^\s+([a-z_]+): "/gm,
  },
  {
    name: "anthropic",
    pkg: "@anthropic-ai/sdk",
    sourceDirs: ["src/anthropic"],
    typeFiles: ["resources/messages/messages.d.ts"],
    usageRoots: ["Usage", "MessageDeltaUsage"],
    stopReasonTypes: [{ alias: "StopReason", mapperFiles: ["src/_core/stop-reason-mapper.ts"] }],
    mapperKeyPattern: /^\s+([a-z_]+): "/gm,
  },
  {
    name: "google",
    pkg: "@google/genai",
    sourceDirs: ["src/google"],
    typeFiles: ["dist/genai.d.ts"],
    usageRoots: ["GenerateContentResponseUsageMetadata"],
    stopReasonTypes: [{ enum: "FinishReason", mapperFiles: ["src/google/utils.ts"] }],
    mapperKeyPattern: /case "([A-Z_]+)":/g,
  },
];

const CONSUMED_PATH_PATTERN =
  /\b[A-Za-z_$][\w$]*\??\.((?:[A-Za-z_][A-Za-z0-9_]*\??\.)*[A-Za-z_][A-Za-z0-9_]*)/g;
const DECLARATION_PATTERN =
  /(?:export\s+)?(?:declare\s+)?(interface|class|namespace)\s+([A-Za-z0-9_]+)\s*(?:extends[^{]+)?(?:implements[^{]+)?\{/g;
const PROP_PATTERN = /^\s*(?:readonly\s+)?([A-Za-z_][A-Za-z0-9_]*)(\??):\s*([^;]+);/gm;
const BLOCK_COMMENT_PATTERN = /\/\*[\s\S]*?\*\//g;
const MAX_DEPTH = 3;

function listTypeScriptFiles(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return listTypeScriptFiles(full);
    return full.endsWith(".ts") ? [full] : [];
  });
}

function consumedPaths(provider) {
  const paths = new Set();
  for (const dir of provider.sourceDirs) {
    for (const file of listTypeScriptFiles(join(ROOT, dir))) {
      for (const match of readFileSync(file, "utf8").matchAll(CONSUMED_PATH_PATTERN)) {
        for (const path of chainSuffixes(match[1].replace(/\?/g, ""))) paths.add(path);
      }
    }
  }
  return paths;
}

function chainSuffixes(chain) {
  const parts = chain.split(".");
  return parts.map((_, index) => parts.slice(index).join("."));
}

function braceBlock(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "{") depth++;
    if (text[i] === "}" && --depth === 0) return text.slice(openIndex + 1, i);
  }
  throw new Error("unbalanced braces in type file");
}

function parseProps(body) {
  const props = {};
  for (const match of body.matchAll(PROP_PATTERN)) {
    props[match[1]] = { optional: match[2] === "?", type: match[3].trim() };
  }
  return props;
}

function parseInterfaces(text, prefix = "") {
  const interfaces = {};
  for (const match of text.matchAll(DECLARATION_PATTERN)) {
    const name = prefix ? `${prefix}.${match[2]}` : match[2];
    const body = braceBlock(text, match.index + match[0].length - 1);
    if (match[1] === "namespace") Object.assign(interfaces, parseInterfaces(body, name));
    else interfaces[name] = parseProps(body);
  }
  return interfaces;
}

function literalMembers(typeText) {
  return [...typeText.matchAll(/'([A-Za-z_]+)'/g)].map((match) => match[1]);
}

function enumMembers(text, name) {
  const declaration = text.match(new RegExp(`export declare enum ${name} \\{`));
  if (!declaration) return [];
  const body = braceBlock(text, declaration.index + declaration[0].length - 1);
  return [...body.matchAll(/=\s*["']([A-Za-z_]+)["']/g)].map((match) => match[1]);
}

function specValues(spec, text, interfaces) {
  if (spec.owner) return literalMembers(interfaces[spec.owner]?.[spec.prop]?.type ?? "");
  if (spec.enum) return enumMembers(text, spec.enum);
  const alias = text.match(new RegExp(`export (?:declare )?type ${spec.alias} = ([^;]+);`));
  return alias ? literalMembers(alias[1]) : [];
}

function stopReasonGroups(provider, text, interfaces) {
  return provider.stopReasonTypes.map((spec) => {
    const values = [...new Set(specValues(spec, text, interfaces))];
    if (values.length === 0) {
      throw new Error(`${provider.pkg}: no values found for ${JSON.stringify(spec)}`);
    }
    return { spec, values };
  });
}

function typeSurface(provider, rawText) {
  const text = rawText.replace(BLOCK_COMMENT_PATTERN, "");
  const interfaces = parseInterfaces(text);
  const missingRoots = provider.usageRoots.filter((root) => !interfaces[root]);
  if (missingRoots.length) {
    throw new Error(`${provider.pkg}: usage types not found: ${missingRoots.join(", ")}`);
  }
  const stopReasons = stopReasonGroups(provider, text, interfaces);
  if (stopReasons.length === 0) throw new Error(`${provider.pkg}: stop reason values not found`);
  return { interfaces, stopReasons };
}

function readTypeText(provider, packageDir) {
  const text = provider.typeFiles
    .map((file) => join(packageDir, file))
    .filter((file) => existsSync(file))
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  if (!text) throw new Error(`${provider.pkg}: no type files under ${packageDir}`);
  return text;
}

function referencedType(typeText) {
  const cleaned = typeText
    .replace(/\|\s*null/g, "")
    .replace(/Array<(.+)>/, "$1")
    .replace(/\[\]$/, "")
    .trim();
  return /^[A-Z][A-Za-z0-9_.]*$/.test(cleaned) ? cleaned : null;
}

function flattenPaths(interfaces, typeName, depth = 0) {
  const props = interfaces[typeName];
  if (!props || depth >= MAX_DEPTH) return [];
  return Object.entries(props).flatMap(([name, prop]) => {
    const nested = referencedType(prop.type);
    const children = nested ? flattenPaths(interfaces, nested, depth + 1) : [];
    return [name, ...children.map((child) => `${name}.${child}`)];
  });
}

function usagePaths(provider, surface) {
  return new Set(provider.usageRoots.flatMap((root) => flattenPaths(surface.interfaces, root)));
}

function mapperKeys(provider, spec) {
  const keys = new Set();
  for (const file of spec.mapperFiles) {
    const text = readFileSync(join(ROOT, file), "utf8");
    const fileKeys = [...text.matchAll(provider.mapperKeyPattern)].map((m) => m[1].toLowerCase());
    if (fileKeys.length === 0) throw new Error(`${file}: no mapper keys found`);
    for (const key of fileKeys) keys.add(key);
  }
  return keys;
}

function resolveConsumed(consumed, installedPaths) {
  const byLeaf = new Map();
  for (const path of installedPaths) {
    const leaf = path.slice(path.lastIndexOf(".") + 1);
    byLeaf.set(leaf, [...(byLeaf.get(leaf) ?? []), path]);
  }
  return new Set(
    [...consumed].flatMap((candidate) =>
      installedPaths.has(candidate) ? [candidate] : (byLeaf.get(candidate) ?? []),
    ),
  );
}

function compare(provider, consumed, installed, latest, keysForSpec) {
  const installedPaths = usagePaths(provider, installed);
  const latestPaths = usagePaths(provider, latest);
  const providerPaths = [...resolveConsumed(consumed, installedPaths)];
  if (providerPaths.length === 0) {
    throw new Error(`${provider.name}: no consumed path resolves against the installed types`);
  }
  const installedStopReasons = new Set(installed.stopReasons.flatMap((group) => group.values));
  const unmapped = latest.stopReasons.flatMap((group) => {
    const keys = keysForSpec(group.spec);
    return group.values.filter((value) => !keys.has(value.toLowerCase()));
  });
  return {
    consumed: providerPaths,
    removed: providerPaths.filter((path) => !latestPaths.has(path)),
    addedSiblings: [...latestPaths].filter((path) => !installedPaths.has(path)),
    stopReasonsAdded: [
      ...new Set(
        latest.stopReasons
          .flatMap((group) => group.values)
          .filter((value) => !installedStopReasons.has(value)),
      ),
    ],
    unmappedStopReasons: [...new Set(unmapped)],
  };
}

function isFailure(result) {
  return result.removed.length > 0 || result.unmappedStopReasons.length > 0;
}

function latestPackageDir(provider, workDir) {
  const packArgs = ["pack", `${provider.pkg}@latest`, "--pack-destination", workDir, "--json"];
  const [packed] = JSON.parse(execFileSync("npm", packArgs, { encoding: "utf8" }));
  const target = join(workDir, provider.name);
  mkdirSync(target, { recursive: true });
  execFileSync("tar", [
    "-xzf",
    join(workDir, packed.filename),
    "-C",
    target,
    "--strip-components=1",
  ]);
  return target;
}

function packageVersion(dir) {
  return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;
}

function render(provider, result, installedVersion, latestVersion) {
  const lines = [`## ${provider.pkg}: installed ${installedVersion}, latest ${latestVersion}`];
  lines.push(`consumed provider paths: ${result.consumed.length}`);
  if (result.removed.length) lines.push(`REMOVED in latest: ${result.removed.join(", ")}`);
  if (result.unmappedStopReasons.length) {
    lines.push(`UNMAPPED stop reasons: ${result.unmappedStopReasons.join(", ")}`);
  }
  if (result.stopReasonsAdded.length) {
    lines.push(`new stop reasons since installed: ${result.stopReasonsAdded.join(", ")}`);
  }
  if (result.addedSiblings.length) {
    lines.push(`new usage fields since installed: ${result.addedSiblings.join(", ")}`);
  }
  if (lines.length === 2) lines.push("in sync");
  return lines.join("\n");
}

function checkProvider(provider, workDir) {
  const installedDir = join(ROOT, "node_modules", provider.pkg);
  const latestDir = latestPackageDir(provider, workDir);
  const installed = typeSurface(provider, readTypeText(provider, installedDir));
  const latest = typeSurface(provider, readTypeText(provider, latestDir));
  const result = compare(provider, consumedPaths(provider), installed, latest, (spec) =>
    mapperKeys(provider, spec),
  );
  console.log(render(provider, result, packageVersion(installedDir), packageVersion(latestDir)));
  console.log();
  return isFailure(result);
}

function run() {
  const workDir = mkdtempSync(join(tmpdir(), "provider-surface-"));
  try {
    const failures = PROVIDERS.map((provider) => checkProvider(provider, workDir));
    return failures.some(Boolean) ? 1 : 0;
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const FIXTURE_INSTALLED = `
/**
 * Unbalanced example in a doc comment: { "a": 1
 */
export interface Usage {
    input_tokens: number;
    output_tokens: number;
    details: Details | null;
}
export interface Details {
    thinking_tokens: number;
}
export type StopReason = 'end_turn' | 'max_tokens';
export type SecondaryStatus = 'refusal';
`;

const FIXTURE_LATEST = `
export interface Usage {
    input_tokens: number;
    output_tokens: number;
    details: Details | null;
    inference_geo: string | null;
}
export interface Details {
    thinking_tokens: number;
}
export type StopReason = 'end_turn' | 'max_tokens' | 'refusal';
export type SecondaryStatus = 'refusal';
`;

const FIXTURE_RENAMED = FIXTURE_LATEST.replace("thinking_tokens", "reasoning_tokens");

function selftest() {
  const keysBySpec = new Map([
    ["StopReason", new Set(["end_turn", "max_tokens"])],
    ["SecondaryStatus", new Set(["refusal"])],
  ]);
  const provider = {
    name: "fixture",
    pkg: "fixture",
    usageRoots: ["Usage"],
    stopReasonTypes: [...keysBySpec.keys()].map((alias) => ({ alias })),
  };
  const consumed = new Set(["input_tokens", "details.thinking_tokens", "stopReason"]);
  const compareTexts = (installedText, latestText) =>
    compare(
      provider,
      consumed,
      typeSurface(provider, installedText),
      typeSurface(provider, latestText),
      (spec) => keysBySpec.get(spec.alias),
    );

  const inSync = compareTexts(FIXTURE_INSTALLED, FIXTURE_INSTALLED);
  const evolved = compareTexts(FIXTURE_INSTALLED, FIXTURE_LATEST);
  const renamed = compareTexts(FIXTURE_INSTALLED, FIXTURE_RENAMED);
  let missingRootRefused = false;
  try {
    typeSurface({ ...provider, usageRoots: ["Missing"] }, FIXTURE_INSTALLED);
  } catch {
    missingRootRefused = true;
  }

  const checks = [
    ["own-object paths are ignored", inSync.consumed.length === 2],
    ["identical surfaces report nothing", !isFailure(inSync) && inSync.addedSiblings.length === 0],
    [
      "unbalanced braces inside doc comments do not corrupt the surface",
      Object.keys(typeSurface(provider, FIXTURE_INSTALLED).interfaces.Usage).length === 3,
    ],
    ["new sibling field is reported", evolved.addedSiblings.includes("inference_geo")],
    [
      "new stop reason fails even when another type's mapper already has that key",
      evolved.unmappedStopReasons.includes("refusal") && isFailure(evolved),
    ],
    [
      "renamed consumed field fails as removed",
      renamed.removed.includes("details.thinking_tokens") && isFailure(renamed),
    ],
    ["missing usage root refuses instead of reporting in sync", missingRootRefused],
  ];
  for (const [name, ok] of checks) console.log(`${ok ? "ok" : "FAIL"}  ${name}`);
  return checks.every(([, ok]) => ok) ? 0 : 1;
}

function main() {
  try {
    process.exitCode = process.argv.includes("--selftest") ? selftest() : run();
  } catch (error) {
    console.error(
      `provider-surface-check: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 2;
  }
}

main();
