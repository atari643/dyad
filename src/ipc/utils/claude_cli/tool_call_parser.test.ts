import { describe, expect, it } from "vitest";

import { ToolCallExtractor } from "@/ipc/utils/claude_cli/tool_call_parser";
import {
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
} from "@/ipc/utils/claude_cli/tool_protocol";

function call(name: string, input: string): string {
  return `${TOOL_CALL_OPEN} name="${name}">${input}${TOOL_CALL_CLOSE}`;
}

/** Feeds text one character at a time, the worst case for marker splitting. */
function pushCharByChar(extractor: ToolCallExtractor, text: string) {
  const parts = [];
  for (const char of text) {
    parts.push(...extractor.push(char));
  }
  parts.push(...extractor.flush());
  return parts;
}

function textOf(parts: any[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("");
}

describe("ToolCallExtractor", () => {
  it("passes plain text through unchanged", () => {
    const extractor = new ToolCallExtractor();
    const parts = [...extractor.push("hello world"), ...extractor.flush()];

    expect(textOf(parts)).toBe("hello world");
    expect(parts[0].type).toBe("text-start");
    expect(parts.at(-1)!.type).toBe("text-end");
    expect(extractor.sawToolCall).toBe(false);
  });

  it("extracts a tool call and reports it", () => {
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(call("read_file", '{"path":"a.ts"}')),
      ...extractor.flush(),
    ];

    const toolCall: any = parts.find((p) => p.type === "tool-call");
    expect(toolCall.toolName).toBe("read_file");
    expect(toolCall.input).toBe('{"path":"a.ts"}');
    expect(extractor.sawToolCall).toBe(true);
    expect(textOf(parts)).toBe("");
  });

  it("emits the full streaming sequence for a tool call", () => {
    const extractor = new ToolCallExtractor();
    const parts = [...extractor.push(call("f", "{}")), ...extractor.flush()];

    expect(parts.map((p) => p.type)).toEqual([
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
    ]);
    const ids = new Set(parts.map((p: any) => p.id ?? p.toolCallId));
    expect(ids.size).toBe(1);
  });

  it("never leaks a partial marker as visible text", () => {
    // The decisive property: a marker split across chunks must not surface as
    // "<dyad_cli_too..." in the user's chat.
    const extractor = new ToolCallExtractor();
    const parts = pushCharByChar(
      extractor,
      `before ${call("go", '{"x":1}')} after`,
    );

    expect(textOf(parts)).toBe("before  after");
    expect(textOf(parts)).not.toContain("dyad_cli");
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(1);
  });

  it("keeps text and tool calls in order when interleaved", () => {
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(`thinking ${call("a", "{}")} more ${call("b", "{}")}`),
      ...extractor.flush(),
    ];

    const names = parts
      .filter((p) => p.type === "tool-call")
      .map((p: any) => p.toolName);
    expect(names).toEqual(["a", "b"]);
    expect(textOf(parts)).toBe("thinking  more ");
  });

  it("gives each tool call a distinct id", () => {
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(call("a", "{}") + call("b", "{}")),
      ...extractor.flush(),
    ];

    const ids = parts
      .filter((p) => p.type === "tool-call")
      .map((p: any) => p.toolCallId);
    expect(new Set(ids).size).toBe(2);
  });

  it("falls back to text when the arguments are not valid JSON", () => {
    // Passing malformed input to the caller's tool executor would fail far
    // from the cause; surfacing it keeps the problem visible.
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(call("broken", "{not json")),
      ...extractor.flush(),
    ];

    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    expect(textOf(parts)).toContain("broken");
    expect(extractor.sawToolCall).toBe(false);
  });

  it("falls back to text when the tool name is missing", () => {
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(`${TOOL_CALL_OPEN}>{}${TOOL_CALL_CLOSE}`),
      ...extractor.flush(),
    ];

    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    expect(textOf(parts)).toContain("{}");
  });

  it("recovers an unterminated tool call at end of stream", () => {
    const extractor = new ToolCallExtractor();
    const parts = [
      ...extractor.push(`${TOOL_CALL_OPEN} name="a">{"x":`),
      ...extractor.flush(),
    ];

    expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    // The partial call is surfaced rather than silently discarded.
    expect(textOf(parts)).toContain('name="a"');
  });

  it("does not emit an empty text block when output is only a tool call", () => {
    const extractor = new ToolCallExtractor();
    const parts = [...extractor.push(call("only", "{}")), ...extractor.flush()];

    expect(parts.some((p) => p.type === "text-start")).toBe(false);
  });
});
