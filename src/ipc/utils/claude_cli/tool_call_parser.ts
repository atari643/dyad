import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";

import { logger } from "./logging";
import {
  createToolCallId,
  TOOL_CALL_CLOSE,
  TOOL_CALL_OPEN,
} from "./tool_protocol";

/**
 * Length of the longest suffix of `text` that is also a prefix of `marker`.
 *
 * That suffix must stay buffered: emitting it eagerly would leak a partial
 * `<dyad_cli_tool_ca` into the user-visible response if the next chunk
 * completes the marker.
 */
function longestPartialSuffix(text: string, marker: string): number {
  const max = Math.min(text.length, marker.length - 1);
  for (let len = max; len > 0; len--) {
    if (marker.startsWith(text.slice(text.length - len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Extracts emulated tool calls from a text stream.
 *
 * The model is instructed (see `tool_protocol.ts`) to emit tool calls as
 * `<dyad_cli_tool_call name="x">{...}</dyad_cli_tool_call>`. This splits that
 * marker out of the surrounding prose and turns it into AI SDK tool-call
 * parts, so the rest of Dyad's agent loop is unaware the provider has no
 * native tool channel.
 *
 * Text and tool calls may interleave arbitrarily, and markers can be split
 * across chunk boundaries.
 */
export class ToolCallExtractor {
  private buffer = "";
  private insideCall = false;
  private toolCallCount = 0;
  private textOpen = false;
  private readonly textId = "text-0";

  /** True when at least one tool call was emitted, for the finish reason. */
  sawToolCall = false;

  push(delta: string): LanguageModelV3StreamPart[] {
    this.buffer += delta;
    return this.drain(false);
  }

  /** Flushes whatever remains once the stream ends. */
  flush(): LanguageModelV3StreamPart[] {
    const parts = this.drain(true);
    if (this.textOpen) {
      this.textOpen = false;
      parts.push({ type: "text-end", id: this.textId });
    }
    return parts;
  }

  private emitText(text: string, parts: LanguageModelV3StreamPart[]): void {
    if (!text) {
      return;
    }
    if (!this.textOpen) {
      this.textOpen = true;
      parts.push({ type: "text-start", id: this.textId });
    }
    parts.push({ type: "text-delta", id: this.textId, delta: text });
  }

  private drain(final: boolean): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];

    for (;;) {
      if (this.insideCall) {
        const end = this.buffer.indexOf(TOOL_CALL_CLOSE);
        if (end === -1) {
          if (final) {
            // Truncated call: surface the raw text rather than dropping it.
            logger.warn(
              "Unterminated tool call in CLI output; emitting as text",
            );
            this.emitText(TOOL_CALL_OPEN + this.buffer, parts);
            this.buffer = "";
            this.insideCall = false;
          }
          return parts;
        }

        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + TOOL_CALL_CLOSE.length);
        this.insideCall = false;
        this.emitToolCall(raw, parts);
        continue;
      }

      const start = this.buffer.indexOf(TOOL_CALL_OPEN);
      if (start !== -1) {
        this.emitText(this.buffer.slice(0, start), parts);
        this.buffer = this.buffer.slice(start + TOOL_CALL_OPEN.length);
        this.insideCall = true;
        continue;
      }

      if (final) {
        this.emitText(this.buffer, parts);
        this.buffer = "";
        return parts;
      }

      // Keep back anything that could still become an opening marker.
      const partial = longestPartialSuffix(this.buffer, TOOL_CALL_OPEN);
      const safeLength = this.buffer.length - Math.max(partial, 0);
      if (safeLength > 0) {
        this.emitText(this.buffer.slice(0, safeLength), parts);
        this.buffer = this.buffer.slice(safeLength);
      }
      return parts;
    }
  }

  /**
   * `raw` is everything between the opening marker and its closing tag, i.e.
   * ` name="tool">{json}`.
   */
  private emitToolCall(raw: string, parts: LanguageModelV3StreamPart[]): void {
    const match = /^\s*name\s*=\s*"([^"]+)"\s*>/.exec(raw);
    if (!match) {
      logger.warn("Tool call without a parseable name; emitting as text");
      this.emitText(TOOL_CALL_OPEN + raw + TOOL_CALL_CLOSE, parts);
      return;
    }

    const toolName = match[1];
    const input = raw.slice(match[0].length).trim();

    try {
      JSON.parse(input);
    } catch {
      // Invalid arguments would break the caller's tool execution. Surfacing
      // the text keeps the failure visible instead of silently dropping work.
      logger.warn(
        `Tool call "${toolName}" had invalid JSON arguments; emitting as text`,
      );
      this.emitText(TOOL_CALL_OPEN + raw + TOOL_CALL_CLOSE, parts);
      return;
    }

    // Close any open text block: a tool call is a separate content part.
    if (this.textOpen) {
      this.textOpen = false;
      parts.push({ type: "text-end", id: this.textId });
    }

    const toolCallId = createToolCallId(this.toolCallCount++);
    this.sawToolCall = true;

    // The full sequence keeps consumers that render streaming tool input happy.
    parts.push({ type: "tool-input-start", id: toolCallId, toolName });
    parts.push({ type: "tool-input-delta", id: toolCallId, delta: input });
    parts.push({ type: "tool-input-end", id: toolCallId });
    parts.push({ type: "tool-call", toolCallId, toolName, input });
  }
}
