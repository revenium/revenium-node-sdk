import { TEST_CWD_ENV_VAR } from "./jest.globalSetup";

process.chdir(process.env[TEST_CWD_ENV_VAR] as string);

const noop = () => {};
global.console.debug = noop;
global.console.info = noop;
global.console.warn = noop;

global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true,
    status: 200,
    statusText: "OK",
    json: () => Promise.resolve({}),
    text: () => Promise.resolve(""),
  } as unknown as Response),
);
