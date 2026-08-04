import { tmpdir } from "node:os";

import log from "electron-log";

import { runBufferedProcess } from "../buffered_process";
import { isShellShim, resolveClaudeBinary } from "./resolve_binary";

const logger = log.scope("claude-cli-health");

/** Health probes should fail fast; the CLI answers this locally. */
const HEALTH_CHECK_TIMEOUT_MS = 30_000;

export interface ClaudeCliHealth {
  /** True when the CLI was found and is signed in. */
  ok: boolean;
  /** Resolved executable path, useful when diagnosing PATH problems. */
  binaryPath: string;
  installed: boolean;
  loggedIn: boolean;
  version?: string;
  /** e.g. "claude.ai" (subscription) or "apiKey". */
  authMethod?: string;
  subscriptionType?: string;
  /** Actionable description of the first problem found. */
  problem?: string;
}

/**
 * Reports whether the Claude CLI is usable, without generating any tokens.
 *
 * Runs `claude --version` and `claude auth status`, both of which are local
 * and free. Used by the settings UI and as a preflight so that a misconfigured
 * CLI produces a clear message instead of a failed generation.
 */
export async function checkClaudeCliHealth({
  binaryPath: configuredPath,
}: { binaryPath?: string } = {}): Promise<ClaudeCliHealth> {
  const binaryPath = resolveClaudeBinary({ configuredPath });
  const shell = isShellShim(binaryPath);

  const base: ClaudeCliHealth = {
    ok: false,
    binaryPath,
    installed: false,
    loggedIn: false,
  };

  let version: string | undefined;
  try {
    const result = await runBufferedProcess({
      command: binaryPath,
      args: ["--version"],
      shell,
      cwd: tmpdir(),
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });
    if (result.code !== 0) {
      return {
        ...base,
        problem:
          `Claude CLI at "${binaryPath}" exited with code ${result.code}. ${result.stderr.trim()}`.trim(),
      };
    }
    version = result.stdout.trim();
  } catch (error) {
    logger.debug("Claude CLI version probe failed", error);
    return {
      ...base,
      problem:
        `Claude CLI not found at "${binaryPath}". Install it with ` +
        `\`npm install -g @anthropic-ai/claude-code\`, or set claudeCli.binaryPath ` +
        `(or DYAD_CLAUDE_CLI_PATH).`,
    };
  }

  try {
    const result = await runBufferedProcess({
      command: binaryPath,
      args: ["auth", "status"],
      shell,
      cwd: tmpdir(),
      timeoutMs: HEALTH_CHECK_TIMEOUT_MS,
    });
    // `auth status` prints JSON on stdout even when signed out.
    const status = JSON.parse(result.stdout.trim() || "{}");
    const loggedIn = status.loggedIn === true;
    return {
      ok: loggedIn,
      binaryPath,
      installed: true,
      loggedIn,
      version,
      authMethod: status.authMethod,
      subscriptionType: status.subscriptionType,
      problem: loggedIn
        ? undefined
        : "Claude CLI is installed but not signed in. Run `claude auth login` in a terminal.",
    };
  } catch (error) {
    logger.debug("Claude CLI auth probe failed", error);
    return {
      ...base,
      installed: true,
      version,
      problem:
        "Could not read Claude CLI authentication status. Run `claude auth status` in a terminal to diagnose.",
    };
  }
}
