import { execFileSync } from "node:child_process";

import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import { createClaudeCliProvider } from "@/ipc/utils/claude_cli/claude_cli_provider";
import { resolveClaudeBinary } from "@/ipc/utils/claude_cli/resolve_binary";

/**
 * Contract tests against the real Claude CLI.
 *
 * These consume subscription quota, so they are skipped unless the CLI is
 * installed and signed in. Their job is to catch the case the mocked tests
 * cannot: the CLI changing its output contract, or the model failing to follow
 * the emulated tool-call protocol.
 */
function cliAvailable(): boolean {
  try {
    const status = execFileSync(resolveClaudeBinary(), ["auth", "status"], {
      encoding: "utf8",
      timeout: 30_000,
    });
    return JSON.parse(status).loggedIn === true;
  } catch {
    return false;
  }
}

const AVAILABLE = cliAvailable();

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

describe.skipIf(!AVAILABLE)("Claude CLI (real binary)", () => {
  it("streams plain text", async () => {
    const model = createClaudeCliProvider()("haiku") as any;
    const { stream } = await model.doStream({
      prompt: [
        { role: "system", content: "Reply with exactly: PONG" },
        { role: "user", content: [{ type: "text", text: "ping" }] },
      ],
    } as LanguageModelV3CallOptions);

    const parts = await collect(stream);
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");

    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(text).toContain("PONG");
    expect(parts.some((p) => p.type === "finish")).toBe(true);
  }, 180_000);

  it("produces a real tool call through the emulated protocol", async () => {
    // The load-bearing assumption of the whole tool emulation: the model
    // follows the protocol taught in the system prompt.
    const model = createClaudeCliProvider()("sonnet") as any;
    const { stream } = await model.doStream({
      prompt: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Read the file src/main.ts. Use a tool, do not guess.",
            },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "read_file",
          description: "Read a file from the project",
          inputSchema: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      ],
    } as LanguageModelV3CallOptions);

    const parts = await collect(stream);
    const toolCall = parts.find((p) => p.type === "tool-call");

    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(toolCall).toBeDefined();
    expect(toolCall.toolName).toBe("read_file");
    expect(JSON.parse(toolCall.input).path).toContain("main.ts");

    const finish = parts.find((p) => p.type === "finish");
    expect(finish.finishReason.unified).toBe("tool-calls");

    // The protocol markers must never reach the user's chat.
    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => p.delta)
      .join("");
    expect(text).not.toContain("dyad_cli");
  }, 180_000);
});
