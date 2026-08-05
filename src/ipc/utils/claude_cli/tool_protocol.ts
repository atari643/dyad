import type {
  LanguageModelV3CallOptions,
  LanguageModelV3FunctionTool,
  LanguageModelV3ProviderTool,
  LanguageModelV3ToolChoice,
} from "@ai-sdk/provider";

/**
 * Text protocol used to emulate tool calling on a CLI that has no native
 * tool-call channel.
 *
 * The CLI runs with its own tools disabled and only produces text, so tool
 * calls are carried in the response body using an explicit marker and parsed
 * back out into AI SDK tool-call parts. The syntax is deliberately verbose and
 * unlikely to collide with prose or code fences.
 */
export const TOOL_CALL_OPEN = "<dyad_cli_tool_call";
export const TOOL_CALL_CLOSE = "</dyad_cli_tool_call>";
/** Used to replay previous tool results back into the flattened transcript. */
export const TOOL_RESULT_OPEN = "<dyad_cli_tool_result";
export const TOOL_RESULT_CLOSE = "</dyad_cli_tool_result>";

/** Longest prefix of the opening marker, used to hold back partial matches. */
export const MAX_PARTIAL_MARKER = TOOL_CALL_OPEN.length;

export function isFunctionTool(
  tool: LanguageModelV3FunctionTool | LanguageModelV3ProviderTool,
): tool is LanguageModelV3FunctionTool {
  return tool.type === "function";
}

function describeTool(tool: LanguageModelV3FunctionTool): string {
  const schema = JSON.stringify(tool.inputSchema ?? { type: "object" });
  const description = tool.description?.trim();
  return [
    `### ${tool.name}`,
    description ? description : undefined,
    `Input JSON schema: ${schema}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function toolChoiceInstruction(
  toolChoice: LanguageModelV3ToolChoice | undefined,
): string {
  switch (toolChoice?.type) {
    case "required":
      return "You MUST call exactly one tool in this turn. Do not answer in prose.";
    case "none":
      return "Do NOT call any tool in this turn. Answer in prose.";
    case "tool":
      return `You MUST call the \`${toolChoice.toolName}\` tool in this turn.`;
    default:
      return "Call a tool when it helps. Otherwise answer normally.";
  }
}

/**
 * Builds the system prompt section that teaches the model the tool protocol.
 *
 * Returns undefined when there is nothing to describe, so callers can skip
 * appending an empty section.
 */
export function buildToolProtocolPrompt(
  options: LanguageModelV3CallOptions,
): string | undefined {
  const tools = (options.tools ?? []).filter(isFunctionTool);
  if (tools.length === 0) {
    return undefined;
  }

  return [
    "## Tool calling protocol",
    "",
    "You can call tools. To call one, emit a line of exactly this form:",
    "",
    `${TOOL_CALL_OPEN} name="TOOL_NAME">{"arg": "value"}${TOOL_CALL_CLOSE}`,
    "",
    "Rules:",
    "- The body between the marker and its closing tag MUST be a single valid JSON object matching that tool's input schema.",
    "- Emit the whole call in one piece. Never wrap it in a code fence.",
    "- You may emit several calls in one turn; emit each one separately.",
    "- After emitting calls, stop. Tool results arrive in the next message.",
    `- ${toolChoiceInstruction(options.toolChoice)}`,
    "",
    "## Available tools",
    "",
    tools.map(describeTool).join("\n\n"),
  ].join("\n");
}

/** Stable-enough identifier; the AI SDK only requires uniqueness per call. */
export function createToolCallId(index: number): string {
  return `claude-cli-tool-${Date.now().toString(36)}-${index}`;
}
