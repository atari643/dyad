import { DyadError, DyadErrorKind } from "@/errors/dyad_error";

/**
 * Rate limit information surfaced by the CLI's `rate_limit_event` stream
 * events. Captured while streaming so that a later failure can explain *why*
 * the run stopped instead of showing a bare non-zero exit code.
 */
export interface ClaudeCliRateLimit {
  status?: string;
  /** Unix timestamp (seconds) when the current window resets. */
  resetsAt?: number;
  /** e.g. "five_hour" or "weekly". */
  rateLimitType?: string;
}

export function isRateLimited(rateLimit: ClaudeCliRateLimit | undefined) {
  return rateLimit?.status != null && rateLimit.status !== "allowed";
}

function formatResetTime(resetsAt: number | undefined): string {
  if (!resetsAt) {
    return "";
  }
  // The CLI reports seconds; Date expects milliseconds.
  const date = new Date(resetsAt * 1000);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return ` Quota resets at ${date.toLocaleString()}.`;
}

export function rateLimitError(rateLimit: ClaudeCliRateLimit): DyadError {
  const window = rateLimit.rateLimitType
    ? ` (${rateLimit.rateLimitType.replace(/_/g, " ")} limit)`
    : "";
  return new DyadError(
    `Claude CLI is rate limited${window}.${formatResetTime(rateLimit.resetsAt)} ` +
      `This is a subscription quota, not a billing error — wait for the reset or switch to another provider.`,
    DyadErrorKind.RateLimited,
  );
}

export function binaryNotFoundError(binaryPath: string): DyadError {
  return new DyadError(
    `Claude CLI not found at "${binaryPath}". Install it with ` +
      `\`npm install -g @anthropic-ai/claude-code\`, or set the binary path in ` +
      `Settings (claudeCli.binaryPath) or the DYAD_CLAUDE_CLI_PATH environment variable.`,
    DyadErrorKind.Precondition,
  );
}

export function notAuthenticatedError(): DyadError {
  return new DyadError(
    `Claude CLI is not authenticated. Run \`claude auth login\` in a terminal, ` +
      `then retry. No API key is required when signed in with a Claude subscription.`,
    DyadErrorKind.Auth,
  );
}

export function timeoutError(timeoutMs: number): DyadError {
  return new DyadError(
    `Claude CLI did not respond within ${Math.round(timeoutMs / 1000)}s and was terminated. ` +
      `Increase claudeCli.timeoutMs (or DYAD_CLAUDE_CLI_TIMEOUT_MS) if long generations are expected.`,
    DyadErrorKind.External,
  );
}

/**
 * The provider runs the CLI as a plain text generator (`--tools ""`) so that
 * Dyad keeps ownership of file edits via its `<dyad-write>` pipeline. Chat
 * modes that rely on AI SDK tool calling (ask / plan / agent) therefore cannot
 * be served by this provider.
 */
export function toolsUnsupportedError(): DyadError {
  return new DyadError(
    `The Claude CLI provider does not support tool calling, which Dyad's ask, plan ` +
      `and agent modes require. Switch to Build mode, or select an API-based ` +
      `provider for those modes.`,
    DyadErrorKind.Precondition,
  );
}

export function attachmentsUnsupportedError(): DyadError {
  return new DyadError(
    `The Claude CLI provider only supports text prompts; images and file ` +
      `attachments are not supported. Remove the attachment or use an API-based provider.`,
    DyadErrorKind.Precondition,
  );
}

/**
 * Maps a non-zero CLI exit into a typed error. `stderr` is included because the
 * CLI writes actionable diagnostics there, but it is trimmed so a runaway
 * process cannot flood the UI with megabytes of text.
 */
export function exitCodeError({
  code,
  stderr,
  rateLimit,
}: {
  code: number | null;
  stderr: string;
  rateLimit?: ClaudeCliRateLimit;
}): DyadError {
  if (isRateLimited(rateLimit)) {
    return rateLimitError(rateLimit!);
  }

  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("not logged in") ||
    normalized.includes("authentication") ||
    normalized.includes("please run `claude auth login`") ||
    normalized.includes("invalid api key")
  ) {
    return notAuthenticatedError();
  }

  const detail = stderr.trim().slice(0, 2000);
  // A zero exit code paired with a failure means the CLI reported the error in
  // its result event; saying "exited with code 0" there would be misleading.
  const summary =
    code === 0 || code == null
      ? "Claude CLI reported an error"
      : `Claude CLI exited with code ${code}`;
  return new DyadError(
    `${summary}.${detail ? `\n${detail}` : ""}`,
    DyadErrorKind.External,
  );
}
