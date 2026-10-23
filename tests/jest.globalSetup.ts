import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export const TEST_CWD_ENV_VAR = "REVENIUM_TEST_CWD";

export default function globalSetup(): void {
  process.env[TEST_CWD_ENV_VAR] = mkdtempSync(join(tmpdir(), "revenium-test-cwd-"));
}
