import { readFileSync } from "fs";
import { join } from "path";
import ts from "typescript";
import { createGeminiReply, createJsonResponse, settle, stubGoogleAuth } from "../helpers/fixtures";

const ROOT = join(__dirname, "../..");
const PACKAGE_NAME = "@revenium/middleware";
const DECLARATION_PREFIX = /^\.\/dist\/types\//;
const DECLARATION_SUFFIX = /\.d\.ts$/;

const QUICK_START_PATTERN = /### Quick Start - (.+)\n([\s\S]*?)```typescript\n([\s\S]*?)```/g;
const BACKTICKED_SETTING_PATTERN = /`([A-Z][A-Z0-9_]+)`/g;
const PROVIDER_ENV_PREFIXES = [
  "REVENIUM_",
  "OPENAI_",
  "AZURE_",
  "PERPLEXITY_",
  "GOOGLE_",
  "ANTHROPIC_",
  "FAL_",
  "LITELLM_",
];

const FAKE_SETTING = "quick-start";
const FAKE_SETTINGS: Record<string, string> = {
  REVENIUM_METERING_API_KEY: "hak_quick_start",
  AZURE_OPENAI_ENDPOINT: "https://quick-start.openai.azure.com",
};

const GEMINI_MODEL = "gemini-2.0-flash-001";
const METERING_URL = "https://api.revenium.ai/meter/v2/ai/completions";

stubGoogleAuth();

interface QuickStart {
  name: string;
  prose: string;
  code: string;
}

type AsyncFunctionConstructor = new (
  ...parameters: string[]
) => (...args: unknown[]) => Promise<void>;

const AsyncFunction = Object.getPrototypeOf(async () => undefined)
  .constructor as AsyncFunctionConstructor;

const originalFetch = global.fetch;

const publicEntryPoints: Record<string, string> = Object.fromEntries(
  Object.entries<{ require: { types: string } }>(
    JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).exports,
  ).map(([subpath, target]) => [
    `${PACKAGE_NAME}${subpath.slice(1)}`,
    target.require.types.replace(DECLARATION_PREFIX, "src/").replace(DECLARATION_SUFFIX, ""),
  ]),
);

const quickStarts: QuickStart[] = [
  ...readFileSync(join(ROOT, "README.md"), "utf8").matchAll(QUICK_START_PATTERN),
].map(([, name, prose, code]) => ({ name, prose, code }));

function quickStart(name: string): QuickStart {
  const section = quickStarts.find((candidate) => candidate.name === name);
  if (!section) {
    throw new Error(`README has no "Quick Start - ${name}" section`);
  }
  return section;
}

function virtualFileName(section: QuickStart): string {
  return join(ROOT, `quick-start-${quickStarts.indexOf(section)}.ts`);
}

function compilerOptions(): ts.CompilerOptions {
  const configPath = join(ROOT, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, ROOT);

  return {
    ...options,
    noEmit: true,
    module: ts.ModuleKind.ES2022,
    target: ts.ScriptTarget.ES2022,
    rootDir: undefined,
    baseUrl: ROOT,
    paths: Object.fromEntries(
      Object.entries(publicEntryPoints).map(([specifier, source]) => [specifier, [source]]),
    ),
  };
}

function createQuickStartProgram(): ts.Program {
  const options = compilerOptions();
  const sources = new Map(quickStarts.map((section) => [virtualFileName(section), section.code]));
  const host = ts.createCompilerHost(options);
  const { getSourceFile } = host;

  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const source = sources.get(fileName);
    return source === undefined
      ? getSourceFile(fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, source, languageVersion);
  };

  return ts.createProgram([...sources.keys()], options, host);
}

function compileErrors(program: ts.Program, section: QuickStart): string[] {
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(virtualFileName(section)))
    .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"));
}

function settingsNamedIn(prose: string): string[] {
  return [...prose.matchAll(BACKTICKED_SETTING_PATTERN)].map(([, setting]) => setting);
}

function isolateProviderEnvironment(settings: string[]): void {
  Object.keys(process.env)
    .filter((key) => PROVIDER_ENV_PREFIXES.some((prefix) => key.startsWith(prefix)))
    .forEach((key) => delete process.env[key]);

  settings.forEach((setting) => {
    process.env[setting] = FAKE_SETTINGS[setting] ?? FAKE_SETTING;
  });
}

function chatCompletionResponse(): Response {
  return new Response(
    JSON.stringify({
      id: "chatcmpl-quick-start",
      object: "chat.completion",
      created: 0,
      model: "quick-start",
      choices: [{ index: 0, message: { role: "assistant", content: "hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 2, total_tokens: 11 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function geminiResponse(): Response {
  return createJsonResponse(
    createGeminiReply({ promptTokenCount: 9, candidatesTokenCount: 2, totalTokenCount: 11 }),
  );
}

function providerResponse(url: string): Response {
  if (url.includes("/chat/completions")) return chatCompletionResponse();
  if (url.includes(":generateContent")) return geminiResponse();
  return new Response("{}", { status: 200 });
}

function createProviderFetch(): jest.Mock {
  return jest.fn((input: unknown) => Promise.resolve(providerResponse(String(input))));
}

function requireFromSource(specifier: string): unknown {
  const source = publicEntryPoints[specifier];
  return require(source === undefined ? specifier : join(ROOT, source));
}

async function runQuickStart(code: string): Promise<void> {
  const { outputText } = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });

  await jest.isolateModulesAsync(async () => {
    try {
      await new AsyncFunction("require", "exports", outputText)(requireFromSource, {});
    } finally {
      const { stopEnforcementPolling } = require("../../src/_core/enforcement/engine");
      stopEnforcementPolling();
    }
  });
}

function expectChatRequestTo(url: string): (providerFetch: jest.Mock) => void {
  return (providerFetch) => {
    expect(providerFetch.mock.calls.map(([input]) => String(input))).toContain(url);
  };
}

async function expectOneGeminiRecord(providerFetch: jest.Mock): Promise<void> {
  const meteringBodies = () =>
    providerFetch.mock.calls
      .filter(([input]) => String(input) === METERING_URL)
      .map(([, init]) => JSON.parse(String(init.body)));

  for (let attempt = 0; attempt < 100 && meteringBodies().length === 0; attempt++) {
    await settle();
  }
  await settle();

  expect(meteringBodies()).toEqual([
    expect.objectContaining({
      model: GEMINI_MODEL,
      inputTokenCount: 9,
      outputTokenCount: 2,
      subscriber: { id: "user-123" },
    }),
  ]);
}

describe("README quick starts", () => {
  it("covers every provider quick start", () => {
    expect(quickStarts.map((section) => section.name)).toEqual([
      "OpenAI",
      "Anthropic",
      "Google GenAI",
      "Azure OpenAI",
      "Google Vertex AI",
      "Perplexity",
      "fal.ai",
      "LiteLLM",
    ]);
  });

  describe("compiles under the repo TypeScript settings", () => {
    let program: ts.Program;

    beforeAll(() => {
      program = createQuickStartProgram();
    });

    it.each<[string, QuickStart]>(quickStarts.map((section) => [section.name, section]))(
      "%s",
      (_name, section) => {
        expect(compileErrors(program, section)).toEqual([]);
      },
    );
  });

  describe("runs its first call against a stub with only the settings its section names", () => {
    let envSnapshot: NodeJS.ProcessEnv;

    beforeEach(() => {
      envSnapshot = { ...process.env };
    });

    afterEach(() => {
      process.env = envSnapshot;
      global.fetch = originalFetch;
    });

    it.each<[string, (providerFetch: jest.Mock) => void | Promise<void>]>([
      ["OpenAI", expectChatRequestTo("https://api.openai.com/v1/chat/completions")],
      [
        "Azure OpenAI",
        expectChatRequestTo(
          `${FAKE_SETTINGS.AZURE_OPENAI_ENDPOINT}/openai/deployments/my-deployment-name/chat/completions?api-version=${FAKE_SETTING}`,
        ),
      ],
      ["Perplexity", expectChatRequestTo("https://api.perplexity.ai/chat/completions")],
      ["Google GenAI", expectOneGeminiRecord],
      ["Google Vertex AI", expectOneGeminiRecord],
    ])("%s", async (name, expectFirstCall) => {
      const section = quickStart(name);
      const providerFetch = createProviderFetch();

      isolateProviderEnvironment(settingsNamedIn(section.prose));
      global.fetch = providerFetch as unknown as typeof fetch;

      await runQuickStart(section.code);

      await expectFirstCall(providerFetch);
    });
  });
});
