import type {
  LanguageModelV3CallOptions,
  LanguageModelV3Message,
  SharedV3Warning,
} from "@ai-sdk/provider";

import { attachmentsUnsupportedError, toolsUnsupportedError } from "./errors";

export interface ClaudeCliRequest {
  /** Arguments passed to the CLI. Deliberately small -- see below. */
  args: string[];
  /** Conversation text piped to the CLI's stdin. */
  stdin: string;
  /**
   * System prompt, written to a temp file by the caller and passed via
   * `--system-prompt-file`.
   */
  systemPrompt?: string;
  /** Sampling settings the CLI cannot express, reported back to the AI SDK. */
  warnings: SharedV3Warning[];
}

function textOf(message: LanguageModelV3Message): string {
  if (message.role === "system") {
    return message.content;
  }
  if (message.role === "tool") {
    throw toolsUnsupportedError();
  }

  const chunks: string[] = [];
  for (const part of message.content) {
    switch (part.type) {
      case "text":
        chunks.push(part.text);
        break;
      case "reasoning":
        // Prior reasoning is not replayed to the CLI: it is not part of the
        // model-visible transcript and would only add noise.
        break;
      case "file":
        throw attachmentsUnsupportedError();
      case "tool-call":
      case "tool-result":
        throw toolsUnsupportedError();
      default:
        break;
    }
  }
  return chunks.join("\n");
}

/**
 * Serialises the conversation into a single prompt string.
 *
 * The CLI accepts one prompt, so multi-turn history is flattened with explicit
 * role markers. A single user turn (the common case for Dyad's build mode) is
 * sent verbatim to avoid wrapping it in unnecessary scaffolding.
 */
export function serializeConversation(
  messages: LanguageModelV3Message[],
): string {
  const turns = messages.filter((m) => m.role !== "system");

  if (turns.length === 1 && turns[0].role === "user") {
    return textOf(turns[0]);
  }

  return turns
    .map((message) => {
      const label = message.role === "assistant" ? "Assistant" : "Human";
      return `${label}: ${textOf(message)}`;
    })
    .join("\n\n")
    .concat("\n\nAssistant:");
}

export interface BuildClaudeCliRequestOptions {
  options: LanguageModelV3CallOptions;
  modelId: string;
  extraArgs?: string[];
}

/**
 * Builds the CLI invocation for a single generation.
 *
 * Nothing that scales with conversation size ever goes into `args`: the
 * transcript is piped through stdin and the system prompt is written to a temp
 * file. Windows caps a process command line at ~32k characters, and Dyad
 * routinely sends far more than that once codebase context is included, so
 * keeping argv bounded is a correctness requirement rather than an
 * optimisation.
 */
export function buildClaudeCliRequest({
  options,
  modelId,
  extraArgs = [],
}: BuildClaudeCliRequestOptions): ClaudeCliRequest {
  if (options.tools?.length) {
    throw toolsUnsupportedError();
  }

  const systemParts = options.prompt
    .filter((m): m is LanguageModelV3Message & { role: "system" } =>
      Boolean(m.role === "system"),
    )
    .map((m) => m.content);

  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--include-partial-messages",
    // stream-json output requires verbose mode.
    "--verbose",
    // Dyad owns file edits through its <dyad-write> pipeline, so the CLI runs
    // as a pure text generator with every built-in tool disabled.
    "--tools",
    "",
    "--model",
    modelId,
  ];

  args.push(...extraArgs);

  // The CLI exposes no sampling knobs in headless mode. Reporting these as
  // warnings (rather than silently dropping them) is how AI SDK providers
  // signal unsupported settings, and it keeps Dyad's behaviour honest.
  const warnings: SharedV3Warning[] = [];
  const unsupported: [string, unknown][] = [
    ["maxOutputTokens", options.maxOutputTokens],
    ["temperature", options.temperature],
    ["topP", options.topP],
    ["topK", options.topK],
    ["presencePenalty", options.presencePenalty],
    ["frequencyPenalty", options.frequencyPenalty],
    ["seed", options.seed],
    ["stopSequences", options.stopSequences],
  ];
  for (const [feature, value] of unsupported) {
    if (value != null) {
      warnings.push({
        type: "unsupported",
        feature,
        details:
          "The Claude CLI does not accept sampling options in print mode.",
      });
    }
  }

  return {
    args,
    stdin: serializeConversation(options.prompt),
    systemPrompt: systemParts.length ? systemParts.join("\n\n") : undefined,
    warnings,
  };
}
