import { StreamingWrapper } from "../../../src/perplexity/middleware";
import { setConfig, resetConfig } from "../../../src/_core/config/manager";
import { resolveConfig } from "../../../src/_core/config/call-config";
import { createReveniumConfig } from "../../helpers/fixtures";

describe("Perplexity StreamingWrapper organization binding", () => {
  const ORG_A_KEY = "hak_org_a_1234567890";
  const ORG_B_KEY = "hak_org_b_1234567890";

  afterEach(() => {
    resetConfig();
  });

  async function* usageStream(): AsyncGenerator<Record<string, unknown>> {
    yield { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] };
    yield {
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    };
  }

  it("meters under the configuration active when the wrapper was built", async () => {
    setConfig(createReveniumConfig({ reveniumApiKey: ORG_A_KEY }));

    const keysSeenByTracking: Array<string | undefined> = [];
    const trackFn = jest.fn(() => {
      keysSeenByTracking.push(resolveConfig()?.reveniumApiKey);
    });

    const wrapper = new StreamingWrapper(
      usageStream(),
      "sonar",
      Date.now(),
      "txn-perplexity-1",
      undefined,
      undefined,
      [],
      trackFn,
    );

    setConfig(createReveniumConfig({ reveniumApiKey: ORG_B_KEY }));

    for await (const _chunk of wrapper) {
      void _chunk;
    }

    expect(keysSeenByTracking).toEqual([ORG_A_KEY]);
  });
});
