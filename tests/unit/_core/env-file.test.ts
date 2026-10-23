import { parseEnvFile } from "../../../src/_core/config/env-file";

describe("parseEnvFile", () => {
  it.each([
    ["bare value", "KEY=value", { KEY: "value" }],
    ["surrounding spaces", "KEY = value ", { KEY: "value" }],
    ["empty value", "KEY=", { KEY: "" }],
    ["export prefix", "export KEY=v", { KEY: "v" }],
    ["dotted and dashed keys", "a.b=1\nc-d=2", { "a.b": "1", "c-d": "2" }],
    ["blank and comment lines", "\n# comment\nKEY=v\n", { KEY: "v" }],
    ["commented pair is not a pair", "# KEY=v", {}],
    ["inline comment after bare value", "KEY=value # comment", { KEY: "value" }],
    ["hash inside double quotes", 'KEY="value # not a comment"', { KEY: "value # not a comment" }],
    ["single quotes keep escapes literal", "KEY='line1\\nline2'", { KEY: "line1\\nline2" }],
    ["double quotes unescape", 'KEY="line1\\nline2"', { KEY: "line1\nline2" }],
    ["double quotes unescape carriage return", 'KEY="line1\\rline2"', { KEY: "line1\rline2" }],
    [
      "double quotes keep tab, backslash and quote escapes literal",
      'K="a\\tb\\\\c\\"d"',
      { K: 'a\\tb\\\\c\\"d' },
    ],
    [
      "backslashes in a windows path survive verbatim",
      'P="C:\\\\Users\\\\app"',
      {
        P: "C:\\\\Users\\\\app",
      },
    ],
    ["unterminated double quote keeps the value intact", 'KEY="hak_abc', { KEY: '"hak_abc' }],
    ["unterminated single quote keeps the value intact", "KEY='abc", { KEY: "'abc" }],
    ["unterminated backtick keeps the value intact", "KEY=`abc", { KEY: "`abc" }],
    ["colon separator", "KEY: value", { KEY: "value" }],
    ["colon separator requires a space", "KEY:value", {}],
    ["backtick quotes", "KEY=`a 'b' \"c\"`", { KEY: "a 'b' \"c\"" }],
    ["multiline inside quotes", 'KEY="line1\nline2"\nNEXT=v', { KEY: "line1\nline2", NEXT: "v" }],
    ["CRLF line endings", "A=1\r\nB=2\r\n", { A: "1", B: "2" }],
    ["BOM prefix", "﻿KEY=v", { KEY: "v" }],
    ["last duplicate wins", "KEY=first\nKEY=last", { KEY: "last" }],
    ["malformed lines are skipped", "NOT A PAIR\nKEY=v\n=novalue", { KEY: "v" }],
    ["no variable expansion", "A=1\nB=$A", { A: "1", B: "$A" }],
    ["empty input", "", {}],
  ])("parses %s", (_label, contents, expected) => {
    expect(parseEnvFile(contents)).toEqual(expected);
  });

  it("parses the .env.example grammar without losing a key", () => {
    const contents = [
      "# OpenAI API Configuration",
      "OPENAI_API_KEY=sk-your-openai-api-key-here",
      "",
      "AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com/",
      "GOOGLE_APPLICATION_CREDENTIALS=/path/to/service-account-key.json",
      "REVENIUM_TRACE_NAME=Support Ticket #12345",
      "REVENIUM_PRINT_SUMMARY=false",
    ].join("\n");

    expect(parseEnvFile(contents)).toEqual({
      OPENAI_API_KEY: "sk-your-openai-api-key-here",
      AZURE_OPENAI_ENDPOINT: "https://your-resource.openai.azure.com/",
      GOOGLE_APPLICATION_CREDENTIALS: "/path/to/service-account-key.json",
      REVENIUM_TRACE_NAME: "Support Ticket",
      REVENIUM_PRINT_SUMMARY: "false",
    });
  });
});
