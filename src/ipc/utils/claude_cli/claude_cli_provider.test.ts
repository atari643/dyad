import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createClaudeCliProvider,
  resolveTimeoutMs,
} from "@/ipc/utils/claude_cli/claude_cli_provider";

// Vitest runs from the repo root, and `import.meta.url` is not a file URL
// after transformation, so resolve the fixture from the project root.
const FIXTURE = path.resolve(
  process.cwd(),
  "src/ipc/utils/claude_cli/testing/fake_claude_cli.mjs",
);

let workDir: string;
let fakeCliPath: string;

/**
 * Writes a launcher that the provider can spawn like the real CLI.
 *
 * On Windows the provider treats a `.cmd` as a shell shim and spawns it
 * through a shell, which mirrors how npm installs the real binary; elsewhere a
 * shebang script is directly executable.
 */
function createFakeCli(dir: string): string {
  if (process.platform === "win32") {
    const cmd = path.join(dir, "fake-claude.cmd");
    writeFileSync(
      cmd,
      `@echo off\r\n"${process.execPath}" "${FIXTURE}" %*\r\n`,
    );
    return cmd;
  }
  const sh = path.join(dir, "fake-claude.sh");
  writeFileSync(
    sh,
    `#!/bin/sh\nexec "${process.execPath}" "${FIXTURE}" "$@"\n`,
  );
  chmodSync(sh, 0o755);
  return sh;
}

function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  } as LanguageModelV3CallOptions;
}

async function collect(stream: ReadableStream<any>) {
  const parts: any[] = [];
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  return parts;
}

function textOf(parts: any[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");
}

async function streamWith(
  options: LanguageModelV3CallOptions,
  providerOptions: Record<string, unknown> = {},
) {
  const model = createClaudeCliProvider({
    binaryPath: fakeCliPath,
    ...providerOptions,
  })("sonnet") as any;
  const { stream } = await model.doStream(options);
  return collect(stream);
}

beforeAll(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "dyad-claude-cli-test-"));
  fakeCliPath = createFakeCli(workDir);
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.FAKE_CLAUDE_SCENARIO;
  delete process.env.FAKE_CLAUDE_LOGGED_IN;
});

describe("createClaudeCliProvider", () => {
  it("streams the CLI's text output and finishes with usage", async () => {
    const parts = await streamWith(callOptions());

    expect(parts[0]).toEqual({ type: "stream-start", warnings: [] });
    expect(textOf(parts)).toContain("stdin:hello");
    expect(parts.some((p) => p.type === "error")).toBe(false);

    const finish = parts.find((p) => p.type === "finish");
    // 11 fresh + 7 cache read + 2 cache write.
    expect(finish.usage.inputTokens.total).toBe(20);
    expect(finish.usage.outputTokens.total).toBe(3);
    expect(finish.finishReason.unified).toBe("stop");
  });

  it("sends the conversation over stdin, never on the command line", async () => {
    // Far beyond the Windows command line limit: this must still work.
    const huge = "x".repeat(100_000);
    const parts = await streamWith(
      callOptions({
        prompt: [{ role: "user", content: [{ type: "text", text: huge }] }],
      }),
    );

    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(textOf(parts)).toContain(`stdin:${huge}`);
  });

  it("delivers the system prompt through a file", async () => {
    const parts = await streamWith(
      callOptions({
        prompt: [
          { role: "system", content: "SYSTEM RULES" },
          { role: "user", content: [{ type: "text", text: "hello" }] },
        ],
      }),
    );

    expect(textOf(parts)).toContain("|system:SYSTEM RULES");
  });

  it("reports a non-zero exit with the CLI's stderr", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "exit-error";

    const parts = await streamWith(callOptions());

    const error = parts.find((p) => p.type === "error");
    expect(error.error.message).toContain("exited with code 2");
    expect(error.error.message).toContain("fake CLI failure detail");
  });

  it("classifies a throttled run as a rate limit rather than a generic failure", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "rate-limit";

    const parts = await streamWith(callOptions());

    const error = parts.find((p) => p.type === "error");
    expect(error.error.message).toMatch(/rate limited/i);
    expect(error.error.message).toMatch(/five hour/i);
    expect(error.error.kind).toBe("rate_limited");
  });

  it("does not fail a healthy run that reports quota status", async () => {
    // The CLI emits rate_limit_event on successful runs too. Only a failed run
    // should be reinterpreted as a rate limit.
    process.env.FAKE_CLAUDE_SCENARIO = "quota-ok";

    const parts = await streamWith(callOptions());

    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(parts.some((p) => p.type === "finish")).toBe(true);
    expect(textOf(parts)).toContain("stdin:hello");
  });

  it("terminates a hung run once the timeout elapses", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "hang";

    const parts = await streamWith(callOptions(), { timeoutMs: 1500 });

    const error = parts.find((p) => p.type === "error");
    expect(error.error.message).toMatch(/did not respond within/i);
  }, 20_000);

  it("stops the run when the caller aborts", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "hang";
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);

    const parts = await streamWith(
      callOptions({ abortSignal: controller.signal }),
    );

    // An abort is a normal early termination, not something to report as an error.
    expect(parts.some((p) => p.type === "error")).toBe(false);
  }, 20_000);

  it("tells the user to log in when the CLI is signed out", async () => {
    process.env.FAKE_CLAUDE_LOGGED_IN = "0";

    const parts = await streamWith(callOptions());

    const error = parts.find((p) => p.type === "error");
    expect(error.error.message).toMatch(/claude auth login/);
  });

  it("explains how to install a missing CLI", async () => {
    const parts = await streamWith(callOptions(), {
      binaryPath: path.join(workDir, "definitely-not-here"),
    });

    const error = parts.find((p) => p.type === "error");
    expect(error.error.message).toMatch(/not found/i);
    expect(error.error.message).toMatch(/npm install -g/);
  });

  it("turns an emulated tool call into a real tool-call part", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool-call";

    const parts = await streamWith(
      callOptions({
        tools: [
          {
            type: "function",
            name: "read_file",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    const toolCall = parts.find((p) => p.type === "tool-call");
    expect(toolCall.toolName).toBe("read_file");
    expect(JSON.parse(toolCall.input)).toEqual({ path: "a.ts" });

    // The agent loop keys off this to run another step.
    const finish = parts.find((p) => p.type === "finish");
    expect(finish.finishReason.unified).toBe("tool-calls");
    expect(parts.some((p) => p.type === "error")).toBe(false);
  });

  it("keeps the tool protocol out of the user-visible text", async () => {
    process.env.FAKE_CLAUDE_SCENARIO = "tool-call";

    const parts = await streamWith(
      callOptions({
        tools: [
          {
            type: "function",
            name: "read_file",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );

    expect(textOf(parts)).not.toContain("dyad_cli");
  });

  it("returns aggregated text from doGenerate", async () => {
    const model = createClaudeCliProvider({ binaryPath: fakeCliPath })(
      "sonnet",
    ) as any;

    const result = await model.doGenerate(callOptions());

    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("stdin:hello") },
    ]);
    expect(result.finishReason.unified).toBe("stop");
  });
});

describe("resolveTimeoutMs", () => {
  it("prefers the configured value", () => {
    expect(resolveTimeoutMs(1234, { DYAD_CLAUDE_CLI_TIMEOUT_MS: "9999" })).toBe(
      1234,
    );
  });

  it("falls back to the environment variable", () => {
    expect(
      resolveTimeoutMs(undefined, { DYAD_CLAUDE_CLI_TIMEOUT_MS: "9999" }),
    ).toBe(9999);
  });

  it("ignores a malformed environment value rather than disabling the timeout", () => {
    expect(
      resolveTimeoutMs(undefined, {
        DYAD_CLAUDE_CLI_TIMEOUT_MS: "not-a-number",
      }),
    ).toBe(10 * 60 * 1000);
  });
});
