import { execFileSync } from "child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL } from "url";

const ROOT = join(__dirname, "../..");
const distCjs = join(ROOT, "dist/cjs");
const distEsm = join(ROOT, "dist/esm");

interface InstalledPackageRun {
  dist: string;
  envFileDir: string;
  workingDir: string;
  keyValue: string;
  nodeArgs: (loaderPath: string) => string[];
}

function loadEnvKeyFromInstalledPackage(run: InstalledPackageRun): string {
  const root = mkdtempSync(join(tmpdir(), "revenium-env-"));
  const dirs: Record<string, string> = { root, app: join(root, "app") };
  mkdirSync(dirs.app);

  const installedPackage = join(root, "package");
  cpSync(run.dist, installedPackage, { recursive: true });

  writeFileSync(join(dirs[run.envFileDir], ".env"), `REVENIUM_METERING_API_KEY=${run.keyValue}\n`);

  try {
    return execFileSync(
      process.execPath,
      run.nodeArgs(join(installedPackage, "_core/config/loader.js")),
      { cwd: dirs[run.workingDir], encoding: "utf-8", env: { PATH: process.env.PATH } },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function loadEnvKeyFromEsm(envFileDir: string, workingDir: string): string {
  return loadEnvKeyFromInstalledPackage({
    dist: distEsm,
    envFileDir,
    workingDir,
    keyValue: "hak_esm_key",
    nodeArgs: (loaderPath) => [
      "--input-type=module",
      "-e",
      `const { loadEnvFiles } = await import(${JSON.stringify(pathToFileURL(loaderPath).href)});
       loadEnvFiles();
       process.stdout.write(String(process.env.REVENIUM_METERING_API_KEY));`,
    ],
  });
}

function loadEnvKeyFromCjs(envFileDir: string, workingDir: string): string {
  return loadEnvKeyFromInstalledPackage({
    dist: distCjs,
    envFileDir,
    workingDir,
    keyValue: "hak_cjs_key",
    nodeArgs: (loaderPath) => [
      "-e",
      `const { loadEnvFiles } = require(${JSON.stringify(loaderPath)});
       loadEnvFiles();
       process.stdout.write(String(process.env.REVENIUM_METERING_API_KEY));`,
    ],
  });
}

describe("CJS exports", () => {
  const cjsPaths = [
    "openai/index.js",
    "anthropic/index.js",
    "litellm/index.js",
    "perplexity/index.js",
    "google/genai/index.js",
    "google/vertex/index.js",
    "_core/tool-metering/index.js",
  ];

  it.each(cjsPaths)("dist/cjs/%s is requireable", (path) => {
    const fullPath = join(distCjs, path);
    if (!existsSync(fullPath)) {
      return;
    }

    const mod = require(fullPath);
    expect(mod).toBeDefined();
    expect(typeof mod).toBe("object");
  });

  it("openai CJS exports expected names", () => {
    const fullPath = join(distCjs, "openai/index.js");
    if (!existsSync(fullPath)) return;

    const mod = require(fullPath);
    expect(mod.ReveniumOpenAI).toBeDefined();
    expect(mod.Initialize).toBeDefined();
    expect(mod.trackUsageAsync).toBeDefined();
  });
});

describe("ESM distribution files exist", () => {
  const esmPaths = [
    "openai/index.js",
    "anthropic/index.js",
    "litellm/index.js",
    "perplexity/index.js",
    "google/genai/index.js",
    "google/vertex/index.js",
    "_core/tool-metering/index.js",
  ];

  it.each(esmPaths)("dist/esm/%s exists", (path) => {
    const fullPath = join(distEsm, path);
    expect(existsSync(fullPath)).toBe(true);
  });
});

describe("ESM .env loading", () => {
  it("loads a .env from the working directory with no dotenv installed", () => {
    expect(loadEnvKeyFromEsm("app", "app")).toBe("hak_esm_key");
  });

  it("ignores a .env in the parent of the working directory", () => {
    expect(loadEnvKeyFromEsm("root", "app")).toBe("undefined");
  });
});

describe("CJS .env loading", () => {
  it("loads a .env from the working directory with no dotenv installed", () => {
    expect(loadEnvKeyFromCjs("app", "app")).toBe("hak_cjs_key");
  });

  it("ignores a .env in the parent of the working directory", () => {
    expect(loadEnvKeyFromCjs("root", "app")).toBe("undefined");
  });
});

describe("package.json exports map", () => {
  it("defines all expected entry points", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));

    const expectedEntries = [
      ".",
      "./openai",
      "./anthropic",
      "./google/genai",
      "./google/vertex",
      "./perplexity",
      "./litellm",
      "./tools",
    ];

    for (const entry of expectedEntries) {
      expect(pkg.exports[entry]).toBeDefined();
      expect(pkg.exports[entry].import).toBeDefined();
      expect(pkg.exports[entry].require).toBeDefined();
    }
  });
});
