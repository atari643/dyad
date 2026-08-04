import { describe, expect, it } from "vitest";

import { ClaudeCliStreamParser } from "@/ipc/utils/claude_cli/stream_parser";

/** Builds one NDJSON line, as the CLI emits it. */
function line(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function textDelta(text: string, index = 0) {
  return line({
    type: "stream_event",
    event: {
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    },
  });
}

function resultEvent(overrides: Record<string, unknown> = {}) {
  return line({
    type: "result",
    subtype: "success",
    is_error: false,
    stop_reason: "end_turn",
    result: "hello world",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 50,
    },
    ...overrides,
  });
}

describe("ClaudeCliStreamParser", () => {
  it("converts text deltas into AI SDK text parts", () => {
    const parser = new ClaudeCliStreamParser();

    const parts = [
      ...parser.push(
        line({ type: "system", subtype: "init", session_id: "abc" }),
      ),
      ...parser.push(textDelta("hello")),
      ...parser.push(textDelta(" world")),
      ...parser.push(resultEvent()),
      ...parser.flush(),
    ];

    expect(parts).toEqual([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "hello" },
      { type: "text-delta", id: "0", delta: " world" },
      { type: "text-end", id: "0" },
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("reassembles a JSON object split across two chunks", () => {
    const parser = new ClaudeCliStreamParser();
    const full = textDelta("split");
    const cut = Math.floor(full.length / 2);

    // The first half is not a complete line, so nothing should be emitted yet.
    expect(parser.push(full.slice(0, cut))).toEqual([]);

    expect(parser.push(full.slice(cut))).toEqual([
      { type: "text-start", id: "0" },
      { type: "text-delta", id: "0", delta: "split" },
    ]);
  });

  it("skips malformed lines without dropping surrounding output", () => {
    const parser = new ClaudeCliStreamParser();

    const parts = [
      ...parser.push(textDelta("before")),
      ...parser.push("{not valid json\n"),
      ...parser.push(textDelta("after")),
    ];

    expect(
      parts.filter((p) => p.type === "text-delta").map((p: any) => p.delta),
    ).toEqual(["before", "after"]);
  });

  it("emits a trailing line that never got a newline", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(textDelta("a"));

    // No trailing newline: only flush() can surface this event.
    const noNewline = textDelta("b").trimEnd();
    parser.push(noNewline);

    const flushed = parser.flush();
    expect(flushed).toContainEqual({
      type: "text-delta",
      id: "0",
      delta: "b",
    });
  });

  it("counts cached tokens in the input total so context estimates stay accurate", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(textDelta("hi"));
    const parts = parser.push(resultEvent());

    const finish: any = parts.find((p) => p.type === "finish");
    // 10 fresh + 100 cache read + 50 cache write.
    expect(finish.usage.inputTokens.total).toBe(160);
    expect(finish.usage.inputTokens.cacheRead).toBe(100);
    expect(finish.usage.outputTokens.total).toBe(4);
    expect(finish.finishReason.unified).toBe("stop");
  });

  it("maps max_tokens to the length finish reason", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(textDelta("hi"));
    const parts = parser.push(resultEvent({ stop_reason: "max_tokens" }));

    const finish: any = parts.find((p) => p.type === "finish");
    expect(finish.finishReason.unified).toBe("length");
  });

  it("does not emit a finish part when the run reports an error", () => {
    const parser = new ClaudeCliStreamParser();
    const parts = parser.push(
      resultEvent({ is_error: true, result: undefined }),
    );

    expect(parts.some((p) => p.type === "finish")).toBe(false);
    expect(parser.result?.isError).toBe(true);
    expect(parser.hasFinished()).toBe(false);
  });

  it("replays the final text when no deltas were streamed", () => {
    const parser = new ClaudeCliStreamParser();
    const parts = parser.push(resultEvent());

    expect(parts).toEqual([
      { type: "text-start", id: "fallback" },
      { type: "text-delta", id: "fallback", delta: "hello world" },
      { type: "text-end", id: "fallback" },
      expect.objectContaining({ type: "finish" }),
    ]);
  });

  it("does not replay the final text when deltas already streamed it", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(textDelta("hello world"));
    const parts = parser.push(resultEvent());

    expect(parts.filter((p) => p.type === "text-delta")).toEqual([]);
  });

  it("captures rate limit events for later error reporting", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(
      line({
        type: "rate_limit_event",
        rate_limit_info: {
          status: "rejected",
          resetsAt: 1785894000,
          rateLimitType: "five_hour",
        },
      }),
    );

    expect(parser.rateLimit).toEqual({
      status: "rejected",
      resetsAt: 1785894000,
      rateLimitType: "five_hour",
    });
  });

  it("ignores assistant events so streamed text is not duplicated", () => {
    const parser = new ClaudeCliStreamParser();
    parser.push(textDelta("hello"));

    const parts = parser.push(
      line({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "hello" }],
        },
      }),
    );

    expect(parts).toEqual([]);
  });

  it("maps thinking deltas to reasoning parts", () => {
    const parser = new ClaudeCliStreamParser();
    const parts = parser.push(
      line({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "pondering" },
        },
      }),
    );

    expect(parts).toEqual([
      { type: "reasoning-start", id: "0" },
      { type: "reasoning-delta", id: "0", delta: "pondering" },
    ]);
  });
});
