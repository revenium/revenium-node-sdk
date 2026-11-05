"use strict";
// FRONT-945 E2E smoke — NOT part of the shipped SDK or its test suite.
// Ad-hoc validation script; deleted or left un-tracked.
// Run: node scripts/e2e-smoke.js  (requires DEV_* env from ~/revenium/.env).

const {
  startEnforcementPolling,
  stopEnforcementPolling,
  waitForInitialRules,
  enforcePreCallRules,
  CostLimitExceeded,
  setConfig,
  resetConfig,
} = require("../dist/cjs/index.js");
// setLogger is not on the public root; pull it from the config manager directly
// for the smoke script's log capture.
const { setLogger } = require("../dist/cjs/_core/config/manager.js");

const assert = require("assert");

function makeLogCapture() {
  const logs = [];
  const logger = {
    debug: (m, meta) => logs.push({ level: "debug", m, meta }),
    info: (m, meta) => logs.push({ level: "info", m, meta }),
    warn: (m, meta) => logs.push({ level: "warn", m, meta }),
    error: (m, meta) => logs.push({ level: "error", m, meta }),
  };
  return { logs, logger };
}

function patchFetch(handler) {
  const orig = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => {
    const record = { url: String(url), method: init?.method || "GET", headers: init?.headers, ts: Date.now() };
    calls.push(record);
    return handler(record, url, init);
  };
  return {
    calls,
    restore: () => {
      global.fetch = orig;
    },
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

async function liveWiring() {
  const name = "LIVE_WIRING_AGAINST_DEV";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  setConfig({
    reveniumApiKey: process.env.DEV_API_KEY,
    reveniumBaseUrl: process.env.DEV_API_BASE_URL,
    reveniumEnforcementBaseUrl: `${process.env.DEV_API_BASE_URL}/profitstream`,
    reveniumTeamId: process.env.DEV_TEAM_ID,
    debug: true,
  });

  // Record real fetch + its status/body (pass-through to origin)
  const observed = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const t0 = Date.now();
    const res = await orig(url, init);
    observed.push({
      url: String(url),
      method: init?.method || "GET",
      status: res.status,
      xApiKeyPresent: !!(init?.headers && (init.headers["x-api-key"] || init.headers["X-API-Key"])),
      ms: Date.now() - t0,
    });
    return res;
  };

  startEnforcementPolling();
  await waitFor(() => observed.length >= 1, { timeoutMs: 15000 });
  // small pad so the "rules updated" debug log is captured
  await sleep(100);
  stopEnforcementPolling();
  global.fetch = orig;
  resetConfig();

  return { name, observed, logs };
}

async function exceptionContractBlock() {
  const name = "EXCEPTION_CONTRACT_BLOCK";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  setConfig({
    reveniumApiKey: "hak_test_block",
    reveniumBaseUrl: "http://synthetic.test",
    reveniumEnforcementBaseUrl: "http://synthetic.test",
    reveniumTeamId: "SYNTH_TEAM",
  });

  // Server-shape payload (what the live backend actually returns), verified 2026-04-21.
  const serverPayload = {
    rules: [
      {
        ruleId: 999001,
        teamId: 1372470220,
        name: "synthetic-block",
        metricType: "TOTAL_COST",
        operatorType: "GREATER_THAN_OR_EQUAL_TO",
        threshold: 0.01,
        currentValue: 0.0147,
        periodType: "DAILY",
        breached: true,
        shadowMode: false,
        action: "BLOCK",
        filters: [],
      },
    ],
  };

  const fetchPatch = patchFetch(
    async () =>
      new Response(JSON.stringify(serverPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  startEnforcementPolling();
  await waitForInitialRules();

  const tStart = Date.now();
  let caught;
  try {
    enforcePreCallRules({
      subscriberId: "sam-dev",
      productName: "support-agent",
      model: "gpt-4o-mini",
      provider: "openai",
    });
  } catch (e) {
    caught = e;
  }
  const latencyMs = Date.now() - tStart;

  stopEnforcementPolling();
  fetchPatch.restore();
  resetConfig();

  return {
    name,
    caughtType: caught && caught.constructor.name,
    isCostLimitExceeded: caught instanceof CostLimitExceeded,
    latencyMs,
    fields: caught && {
      name: caught.name,
      code: caught.code,
      message: caught.message,
      ruleId: caught.ruleId,
      threshold: caught.threshold,
      currentValue: caught.currentValue,
      periodType: caught.periodType,
      context: caught.context,
    },
    fetchCalls: fetchPatch.calls.map((c) => ({ url: c.url, method: c.method })),
  };
}

async function exceptionContractShadow() {
  const name = "EXCEPTION_CONTRACT_SHADOW_MODE";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  setConfig({
    reveniumApiKey: "hak_test_warn",
    reveniumBaseUrl: "http://synthetic.test",
    reveniumEnforcementBaseUrl: "http://synthetic.test",
    reveniumTeamId: "SYNTH_TEAM",
  });

  // A breached BLOCK rule with shadowMode: true should log but NOT throw.
  const serverPayload = {
    rules: [
      {
        ruleId: 999002,
        threshold: 0.01,
        currentValue: 0.02,
        periodType: "DAILY",
        action: "BLOCK",
        breached: true,
        shadowMode: true,
        filters: [],
      },
    ],
  };

  const fetchPatch = patchFetch(
    async () =>
      new Response(JSON.stringify(serverPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  startEnforcementPolling();
  await waitForInitialRules();

  let threw = null;
  try {
    enforcePreCallRules({
      subscriberId: "sam-dev",
      productName: "support-agent",
      model: "gpt-4o-mini",
      provider: "openai",
    });
    threw = false;
  } catch (e) {
    threw = true;
  }

  stopEnforcementPolling();
  fetchPatch.restore();
  resetConfig();

  const warnLogsForRule = logs.filter((l) => l.level === "warn" && /rule breached/i.test(l.m));

  return {
    name,
    threw,
    warnLoggedCount: warnLogsForRule.length,
    warnLogSample: warnLogsForRule[0] || null,
  };
}

async function missingTeamIdFailOpen() {
  const name = "FAIL_OPEN_MISSING_TEAM_ID";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  setConfig({
    reveniumApiKey: "hak_test_no_team",
    reveniumBaseUrl: "http://synthetic.test",
    // reveniumTeamId intentionally omitted
  });

  const fetchPatch = patchFetch(async () => {
    throw new Error("fetch should NOT be called when reveniumTeamId is missing");
  });

  startEnforcementPolling();
  await sleep(500); // give the skip-path time to log

  let threw = null;
  try {
    enforcePreCallRules({
      subscriberId: "sam-dev",
      productName: "support-agent",
      model: "gpt-4o-mini",
      provider: "openai",
    });
    threw = false;
  } catch (e) {
    threw = true;
  }

  stopEnforcementPolling();
  fetchPatch.restore();
  resetConfig();

  const skipWarn = logs.find((l) => l.level === "warn" && /No team id configured/.test(l.m));

  return {
    name,
    fetchAttempted: fetchPatch.calls.length > 0,
    enforceThrew: threw,
    warnEmitted: !!skipWarn,
    warnSample: skipWarn,
  };
}

async function noContentFailOpen() {
  const name = "FAIL_OPEN_204_NO_CONTENT";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  setConfig({
    reveniumApiKey: "hak_test_204",
    reveniumBaseUrl: "http://synthetic.test",
    reveniumEnforcementBaseUrl: "http://synthetic.test",
    reveniumTeamId: "SYNTH_TEAM",
  });

  const fetchPatch = patchFetch(async () => new Response(null, { status: 204 }));

  startEnforcementPolling();
  await waitForInitialRules();

  let threw = null;
  try {
    enforcePreCallRules({
      subscriberId: "sam-dev",
      productName: "support-agent",
      model: "gpt-4o-mini",
      provider: "openai",
    });
    threw = false;
  } catch (e) {
    threw = true;
  }

  stopEnforcementPolling();
  fetchPatch.restore();
  resetConfig();

  return { name, fetched: fetchPatch.calls.length, enforceThrew: threw };
}

async function integrationOpenAIBlock() {
  const name = "INTEGRATION_OPENAI_WRAPPER_BLOCKS_BEFORE_CALL";
  const { logs, logger } = makeLogCapture();
  setLogger(logger);

  // Route the OpenAI npm client at Ollama's OpenAI-compat endpoint.
  // Model name 'gpt-4o-mini' is aliased on Ollama and also what metering will
  // record server-side in a real-spend variant of this test.
  process.env.OPENAI_API_KEY = "ollama-dummy-key";
  process.env.OPENAI_BASE_URL = "http://localhost:11434/v1";

  // Patch fetch to:
  //   1. Return a synthetic BREACHED BLOCK rule on the enforcement URL.
  //   2. Count any call to Ollama's /v1/chat/completions — must stay at 0
  //      to prove enforcement fires BEFORE the provider request goes out.
  let ollamaCompletionCalls = 0;
  const orig = global.fetch;
  global.fetch = async (url, init) => {
    const us = String(url);
    if (us.includes("/v2/api/ai/enforcement-rules/")) {
      return new Response(
        JSON.stringify({
          rules: [
            {
              ruleId: 999101,
              teamId: 1372470220,
              name: "synthetic-openai-block",
              metricType: "TOTAL_COST",
              operatorType: "GREATER_THAN_OR_EQUAL_TO",
              threshold: 0.01,
              currentValue: 0.0147,
              periodType: "DAILY",
              breached: true,
              shadowMode: false,
              action: "BLOCK",
              filters: [],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (us.includes("/v1/chat/completions")) {
      ollamaCompletionCalls += 1;
    }
    return orig(url, init);
  };

  const { Initialize, GetClient, Reset } = require("../dist/cjs/openai/index.js");

  Initialize({
    reveniumApiKey: "hak_test_openai_block",
    reveniumBaseUrl: "http://synthetic.test",
    reveniumEnforcementBaseUrl: "http://synthetic.test",
    reveniumTeamId: "SYNTH_TEAM",
    openaiApiKey: "ollama-dummy-key",
  });

  // Wait for the first poll to populate the cache.
  await sleep(300);

  const client = GetClient();

  let caught;
  const tStart = Date.now();
  try {
    await client
      .chat()
      .completions()
      .create(
        {
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "Say hi" }],
          max_tokens: 10,
        },
        {
          subscriber: { id: "sam-dev", email: "samuel.combs@revenium.io" },
          productName: "support-agent",
        },
      );
  } catch (e) {
    caught = e;
  }
  const latencyMs = Date.now() - tStart;

  Reset();
  global.fetch = orig;
  resetConfig();

  return {
    name,
    caughtType: caught && caught.constructor.name,
    isCostLimitExceeded: caught && caught.name === "CostLimitExceeded",
    latencyMs,
    ollamaCompletionCalls, // MUST be 0
    fields: caught && {
      ruleId: caught.ruleId,
      threshold: caught.threshold,
      currentValue: caught.currentValue,
      periodType: caught.periodType,
      context: caught.context,
    },
  };
}

(async () => {
  const results = {};
  try {
    results.live = await liveWiring();
  } catch (e) {
    results.live = { error: e.message };
  }
  try {
    results.block = await exceptionContractBlock();
  } catch (e) {
    results.block = { error: e.message, stack: e.stack };
  }
  try {
    results.shadow = await exceptionContractShadow();
  } catch (e) {
    results.shadow = { error: e.message, stack: e.stack };
  }
  try {
    results.failOpenTeamId = await missingTeamIdFailOpen();
  } catch (e) {
    results.failOpenTeamId = { error: e.message };
  }
  try {
    results.failOpen204 = await noContentFailOpen();
  } catch (e) {
    results.failOpen204 = { error: e.message };
  }
  try {
    results.integration = await integrationOpenAIBlock();
  } catch (e) {
    results.integration = { error: e.message, stack: e.stack };
  }

  console.log(JSON.stringify(results, null, 2));

  // Quick self-assertions so exit code reflects pass/fail
  const fails = [];
  if (!results.live?.observed?.[0]) fails.push("live: no poll observed");
  if (results.block?.isCostLimitExceeded !== true) fails.push("block: did not throw CostLimitExceeded");
  if (results.block?.fields?.ruleId !== "999001") fails.push("block: ruleId mismatch");
  if (results.block?.fields?.threshold !== 0.01) fails.push("block: threshold mismatch");
  if (results.block?.fields?.periodType !== "DAILY") fails.push("block: periodType mismatch");
  if (results.shadow?.threw !== false) fails.push("shadow: should not have thrown");
  if (results.shadow?.warnLoggedCount < 1) fails.push("shadow: warn not logged");
  if (results.failOpenTeamId?.fetchAttempted !== false) fails.push("fail-open team: fetch fired");
  if (results.failOpenTeamId?.enforceThrew !== false) fails.push("fail-open team: threw");
  if (results.failOpen204?.enforceThrew !== false) fails.push("fail-open 204: threw");
  if (results.integration?.isCostLimitExceeded !== true)
    fails.push("integration: did not throw CostLimitExceeded");
  if (results.integration?.ollamaCompletionCalls !== 0)
    fails.push("integration: Ollama /v1/chat/completions was called despite BLOCK");

  if (fails.length) {
    console.error("\n--- FAILS ---\n" + fails.join("\n"));
    process.exit(1);
  }
  console.error("\n--- ALL SMOKE CHECKS PASSED ---");
  process.exit(0);
})();
