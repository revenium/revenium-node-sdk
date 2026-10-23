import { rmSync } from "fs";
import { TEST_CWD_ENV_VAR } from "./jest.globalSetup";

export default function globalTeardown(): void {
  const testCwd = process.env[TEST_CWD_ENV_VAR];
  if (testCwd) rmSync(testCwd, { recursive: true, force: true });
}
