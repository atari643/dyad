import type { LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { describe, expect, it } from "vitest";

import {
  buildClaudeCliRequest,
  serializeConversation,
} from "@/ipc/utils/claude_cli/build_request";

function callOptions(
  overrides: Partial<LanguageModelV3CallOptions> = {},
): LanguageModelV3CallOptions {
  return {
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    ...overrides,
  } as LanguageModelV3CallOptions;
}

describe("buildClaudeCliRequest", () => {
  it("keeps the conversation out of argv and pipes it through stdin", () => {
    // Regression guard: Windows caps a command line at ~32k characters, and
    // Dyad's prompts routinely exceed that once codebase context is attached.
    const huge = "x".repeat(200_000);
    const request = buildClaudeCliRequest({
      modelId: "sonnet",
      options: callOptions({
        prompt: [
          { role: "system", content: huge },
          { role: "user", content: [{ type: "text", text: huge }] },
        ],
      }),
    });

    expect(request.stdin).toContain(huge);
    expect(request.systemPrompt).toBe(huge);
    expect(request.args.join(" ")).not.toContain(huge);
    expect(request.args.join(" ").length).toBeLessThan(500);
  });

  it("disables built-in tools so Dyad keeps ownership of file edits", () => {
    const { args } = buildClaudeCliRequest({
      modelId: "sonnet",
      options: callOptions(),
    });

    const toolsIndex = args.indexOf("--tools");
    expect(toolsIndex).toBeGreaterThan(-1);
    expect(args[toolsIndex + 1]).toBe("");
  });

  it("requests token-level streaming json output", () => {
    const { args } = buildClaudeCliRequest({
      modelId: "opus",
      options: callOptions(),
    });

    expect(args).toContain("--print");
    expect(args).toContain("--include-partial-messages");
    expect(args.slice(args.indexOf("--output-format"))).toContain(
      "stream-json",
    );
    expect(args.slice(args.indexOf("--model"))).toContain("opus");
  });

  it("appends extra args verbatim", () => {
    const { args } = buildClaudeCliRequest({
      modelId: "sonnet",
      options: callOptions(),
      extraArgs: ["--debug"],
    });

    expect(args).toContain("--debug");
  });

  it("reports unsupported sampling settings as warnings", () => {
    const { warnings } = buildClaudeCliRequest({
      modelId: "sonnet",
      options: callOptions({ temperature: 0.5, maxOutputTokens: 1000 }),
    });

    expect(warnings.map((w) => (w as any).feature).sort()).toEqual([
      "maxOutputTokens",
      "temperature",
    ]);
  });

  it("returns no warnings when no sampling settings are set", () => {
    const { warnings } = buildClaudeCliRequest({
      modelId: "sonnet",
      options: callOptions(),
    });

    expect(warnings).toEqual([]);
  });

  it("rejects tool calling, which the CLI provider cannot serve", () => {
    expect(() =>
      buildClaudeCliRequest({
        modelId: "sonnet",
        options: callOptions({
          tools: [
            {
              type: "function",
              name: "edit-code",
              inputSchema: { type: "object" },
            },
          ],
        }),
      }),
    ).toThrow(/does not support tool calling/i);
  });

  it("rejects file attachments with an actionable message", () => {
    expect(() =>
      buildClaudeCliRequest({
        modelId: "sonnet",
        options: callOptions({
          prompt: [
            {
              role: "user",
              content: [
                {
                  type: "file",
                  mediaType: "image/png",
                  data: "abc",
                },
              ],
            },
          ],
        }),
      }),
    ).toThrow(/only supports text prompts/i);
  });
});

describe("serializeConversation", () => {
  it("sends a lone user turn verbatim", () => {
    const text = serializeConversation([
      { role: "user", content: [{ type: "text", text: "just this" }] },
    ]);

    expect(text).toBe("just this");
  });

  it("labels roles when replaying multi-turn history", () => {
    const text = serializeConversation([
      { role: "system", content: "ignored here" },
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);

    expect(text).toBe(
      "Human: first\n\nAssistant: second\n\nHuman: third\n\nAssistant:",
    );
  });

  it("excludes system messages, which travel via --system-prompt-file", () => {
    const text = serializeConversation([
      { role: "system", content: "SECRET SYSTEM PROMPT" },
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ]);

    expect(text).not.toContain("SECRET SYSTEM PROMPT");
  });
});
