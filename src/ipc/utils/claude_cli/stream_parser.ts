import type {
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import log from "electron-log";

import type { ClaudeCliRateLimit } from "./errors";
import { ToolCallExtractor } from "./tool_call_parser";

const logger = log.scope("claude-cli-parser");

/**
 * Raw usage block as emitted by the CLI's `result` event. Only the fields we
 * map are declared; unknown fields are ignored so CLI upgrades that add
 * counters do not break parsing.
 */
interface ClaudeCliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

function mapUsage(usage: ClaudeCliUsage | undefined): LanguageModelV3Usage {
  const noCache = usage?.input_tokens;
  const cacheRead = usage?.cache_read_input_tokens;
  const cacheWrite = usage?.cache_creation_input_tokens;

  // Dyad uses the input total to estimate how close a chat is to the context
  // limit, so cached tokens must be counted -- they still occupy the window.
  const inputTotal =
    noCache == null && cacheRead == null && cacheWrite == null
      ? undefined
      : (noCache ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);

  return {
    inputTokens: {
      total: inputTotal,
      noCache,
      cacheRead,
      cacheWrite,
    },
    outputTokens: {
      total: usage?.output_tokens,
      text: usage?.output_tokens,
      reasoning: undefined,
    },
    raw: usage as Record<string, never> | undefined,
  };
}

function mapFinishReason(
  stopReason: string | undefined,
  isError: boolean,
): LanguageModelV3FinishReason {
  if (isError) {
    return { unified: "error", raw: stopReason };
  }
  switch (stopReason) {
    case "end_turn":
    case "stop_sequence":
      return { unified: "stop", raw: stopReason };
    case "max_tokens":
      return { unified: "length", raw: stopReason };
    case "tool_use":
      return { unified: "tool-calls", raw: stopReason };
    case "refusal":
      return { unified: "content-filter", raw: stopReason };
    default:
      return { unified: "stop", raw: stopReason };
  }
}

export interface ClaudeCliResultSummary {
  isError: boolean;
  /** Final assistant text as reported by the CLI, used as a fallback. */
  text?: string;
  sessionId?: string;
}

/**
 * Incrementally converts the Claude CLI's `--output-format stream-json` NDJSON
 * output into AI SDK stream parts.
 *
 * The parser is deliberately tolerant: unknown event types are ignored and
 * malformed lines are logged and skipped rather than failing the whole
 * generation, because the CLI's output is an external contract that can gain
 * new event kinds between releases.
 */
export class ClaudeCliStreamParser {
  /** Holds an incomplete trailing line between chunks. */
  private buffer = "";
  private readonly openReasoningBlocks = new Set<string>();
  /**
   * Owns text framing and pulls emulated tool calls out of the text stream.
   * All assistant text flows through it.
   */
  private readonly toolCalls = new ToolCallExtractor();
  private emittedText = false;
  private finished = false;

  rateLimit: ClaudeCliRateLimit | undefined;
  result: ClaudeCliResultSummary | undefined;

  push(chunk: string): LanguageModelV3StreamPart[] {
    this.buffer += chunk;
    const parts: LanguageModelV3StreamPart[] = [];

    let newlineIndex = this.buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      parts.push(...this.handleLine(line));
      newlineIndex = this.buffer.indexOf("\n");
    }

    return parts;
  }

  /**
   * Drains any trailing partial line and closes open blocks. Must be called
   * once the process exits, otherwise a final line without a newline would be
   * dropped.
   */
  flush(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    if (this.buffer.trim()) {
      parts.push(...this.handleLine(this.buffer));
    }
    this.buffer = "";
    parts.push(...this.closeOpenBlocks());
    return parts;
  }

  /**
   * Safety net for runs that produced no streaming deltas (for example when
   * partial messages are unavailable): replay the final text from the
   * `result` event so the user still sees a response.
   */
  fallbackTextParts(): LanguageModelV3StreamPart[] {
    if (this.emittedText || !this.result?.text) {
      return [];
    }
    this.emittedText = true;
    // Routed through the extractor so a non-streamed response can still carry
    // tool calls.
    return [
      ...this.toolCalls.push(this.result.text),
      ...this.toolCalls.flush(),
    ];
  }

  hasEmittedText(): boolean {
    return this.emittedText;
  }

  hasFinished(): boolean {
    return this.finished;
  }

  private closeOpenBlocks(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    for (const id of this.openReasoningBlocks) {
      parts.push({ type: "reasoning-end", id });
    }
    this.openReasoningBlocks.clear();
    // Flushes any held-back text and closes the text block.
    parts.push(...this.toolCalls.flush());
    return parts;
  }

  private handleLine(rawLine: string): LanguageModelV3StreamPart[] {
    const line = rawLine.trim();
    if (!line) {
      return [];
    }

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      // Not fatal: skip the line but keep the stream alive.
      logger.warn(
        `Skipping unparsable CLI output line (${line.length} chars): ${line.slice(0, 200)}`,
      );
      return [];
    }

    switch (event?.type) {
      case "stream_event":
        return this.handleStreamEvent(event.event);
      case "rate_limit_event":
        this.rateLimit = event.rate_limit_info;
        return [];
      case "result":
        return this.handleResult(event);
      case "system":
      case "assistant":
      case "user":
        // `assistant` repeats content we already streamed as deltas; emitting
        // it again would duplicate the response.
        return [];
      default:
        logger.debug(`Ignoring unknown CLI event type: ${event?.type}`);
        return [];
    }
  }

  private handleStreamEvent(event: any): LanguageModelV3StreamPart[] {
    if (!event?.type) {
      return [];
    }
    const id = String(event.index ?? 0);

    switch (event.type) {
      case "content_block_start": {
        const blockType = event.content_block?.type;
        if (blockType === "thinking") {
          this.openReasoningBlocks.add(id);
          return [{ type: "reasoning-start", id }];
        }
        // Text framing is owned by the tool-call extractor, which cannot open
        // a block until it knows the text is not the start of a tool call.
        return [];
      }
      case "content_block_delta": {
        const delta = event.delta;
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          this.emittedText = true;
          // Tool calls are emulated inside the text stream, so text always
          // goes through the extractor, which owns text-start/end framing.
          return this.toolCalls.push(delta.text);
        }
        if (
          delta?.type === "thinking_delta" &&
          typeof delta.thinking === "string"
        ) {
          const parts: LanguageModelV3StreamPart[] = [];
          if (!this.openReasoningBlocks.has(id)) {
            this.openReasoningBlocks.add(id);
            parts.push({ type: "reasoning-start", id });
          }
          parts.push({ type: "reasoning-delta", id, delta: delta.thinking });
          return parts;
        }
        return [];
      }
      case "content_block_stop": {
        if (this.openReasoningBlocks.delete(id)) {
          return [{ type: "reasoning-end", id }];
        }
        // Text blocks are closed on flush, once the extractor knows no tool
        // call is still being assembled.
        return [];
      }
      default:
        return [];
    }
  }

  private handleResult(event: any): LanguageModelV3StreamPart[] {
    const isError = event.is_error === true;
    this.result = {
      isError,
      text: typeof event.result === "string" ? event.result : undefined,
      sessionId: event.session_id,
    };

    const parts: LanguageModelV3StreamPart[] = [];
    // A `result` without any deltas means the run produced its text in one
    // shot; replay it before closing the blocks.
    parts.push(...this.fallbackTextParts());
    parts.push(...this.closeOpenBlocks());

    if (isError) {
      // Surface the failure through the caller, which has richer context
      // (exit code, stderr, rate limit) than this event alone.
      return parts;
    }

    this.finished = true;
    // The CLI always reports "end_turn" because emulated tool calls are just
    // text to it. The agent loop keys off "tool-calls" to run another step, so
    // the reason has to reflect what was actually extracted.
    const finishReason = this.toolCalls.sawToolCall
      ? ({ unified: "tool-calls", raw: event.stop_reason } as const)
      : mapFinishReason(event.stop_reason, isError);
    parts.push({
      type: "finish",
      usage: mapUsage(event.usage),
      finishReason,
    });
    return parts;
  }
}
