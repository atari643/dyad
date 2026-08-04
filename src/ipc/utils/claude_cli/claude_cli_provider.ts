import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3Content,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3StreamResult,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import log from "electron-log";
import treeKill from "tree-kill";

import { buildClaudeCliRequest } from "./build_request";
import {
  binaryNotFoundError,
  exitCodeError,
  notAuthenticatedError,
  timeoutError,
} from "./errors";
import { checkClaudeCliHealth } from "./health_check";
import { isShellShim, resolveClaudeBinary } from "./resolve_binary";
import { ClaudeCliStreamParser } from "./stream_parser";

const logger = log.scope("claude-cli");

export const DEFAULT_CLAUDE_CLI_TIMEOUT_MS = 10 * 60 * 1000;
/** Grace period between SIGTERM and SIGKILL when tearing a run down. */
const FORCE_KILL_GRACE_MS = 5_000;

const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

export interface ClaudeCliProviderOptions {
  /** Explicit CLI path; falls back to DYAD_CLAUDE_CLI_PATH then PATH. */
  binaryPath?: string;
  timeoutMs?: number;
  /** Escape hatch for extra CLI flags, for debugging. */
  extraArgs?: string[];
}

export interface ClaudeCliProvider {
  (modelId: string): LanguageModel;
}

/**
 * Settings win over the environment variable, which wins over the default.
 * A malformed env value is ignored rather than silently disabling the timeout.
 */
export function resolveTimeoutMs(
  configured: number | undefined,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (configured != null && configured > 0) {
    return configured;
  }
  const fromEnv = Number(env.DYAD_CLAUDE_CLI_TIMEOUT_MS);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return DEFAULT_CLAUDE_CLI_TIMEOUT_MS;
}

/**
 * A temp directory holding the system prompt file for one run.
 *
 * It doubles as the process working directory: running the CLI outside the
 * user's project keeps any local CLAUDE.md from leaking into Dyad's prompts,
 * which would make generations depend on unrelated machine state.
 */
function createRunDirectory(systemPrompt: string | undefined): {
  cwd: string;
  systemPromptFile?: string;
  cleanup: () => void;
} {
  const cwd = mkdtempSync(path.join(tmpdir(), "dyad-claude-cli-"));
  let systemPromptFile: string | undefined;
  if (systemPrompt) {
    systemPromptFile = path.join(cwd, "system-prompt.txt");
    writeFileSync(systemPromptFile, systemPrompt, "utf8");
  }
  return {
    cwd,
    systemPromptFile,
    cleanup: () => {
      try {
        rmSync(cwd, { recursive: true, force: true });
      } catch (error) {
        logger.warn(`Failed to clean up ${cwd}`, error);
      }
    },
  };
}

function killProcessTree(child: ChildProcess) {
  if (child.pid == null || child.exitCode != null) {
    return;
  }
  // The CLI can spawn helpers; killing only the parent would orphan them.
  treeKill(child.pid, "SIGTERM", (error) => {
    if (error && child.exitCode == null) {
      setTimeout(() => {
        if (child.pid != null && child.exitCode == null) {
          treeKill(child.pid, "SIGKILL");
        }
      }, FORCE_KILL_GRACE_MS);
    }
  });
}

interface RunOutcome {
  parts: LanguageModelV3StreamPart[];
}

/**
 * Spawns the CLI for a single generation and turns its NDJSON output into AI
 * SDK stream parts.
 *
 * `onParts` is invoked as output arrives so callers can stream incrementally;
 * the returned promise settles once the process exits.
 */
function runClaudeCli(
  {
    options,
    modelId,
    providerOptions,
  }: {
    options: LanguageModelV3CallOptions;
    modelId: string;
    providerOptions: ClaudeCliProviderOptions;
  },
  onParts: (parts: LanguageModelV3StreamPart[]) => void,
): Promise<RunOutcome> {
  const request = buildClaudeCliRequest({
    options,
    modelId,
    extraArgs: providerOptions.extraArgs,
  });

  const binaryPath = resolveClaudeBinary({
    configuredPath: providerOptions.binaryPath,
  });
  const timeoutMs = resolveTimeoutMs(providerOptions.timeoutMs);
  const run = createRunDirectory(request.systemPrompt);

  const args = [...request.args];
  if (run.systemPromptFile) {
    args.push("--system-prompt-file", run.systemPromptFile);
  }

  return new Promise<RunOutcome>((resolve, reject) => {
    const parser = new ClaudeCliStreamParser();
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let aborted = false;
    let timeoutId: NodeJS.Timeout | undefined;

    logger.debug(
      `Spawning ${binaryPath} ${args.join(" ")} (stdin: ${request.stdin.length} chars, ` +
        `system prompt: ${request.systemPrompt?.length ?? 0} chars)`,
    );

    let child: ChildProcess;
    try {
      child = spawn(binaryPath, args, {
        cwd: run.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        // Windows batch shims cannot be spawned without a shell; the resolver
        // prefers the native executable, so this is a rarely-taken fallback.
        shell: isShellShim(binaryPath),
        env: process.env,
      });
    } catch (error) {
      run.cleanup();
      // A synchronous spawn failure is almost always a missing or unusable
      // binary; anything else is passed through so it is not misdiagnosed.
      const code = (error as NodeJS.ErrnoException).code;
      reject(
        code === "ENOENT" || code === "EINVAL"
          ? binaryNotFoundError(binaryPath)
          : error,
      );
      return;
    }

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      options.abortSignal?.removeEventListener("abort", handleAbort);
      run.cleanup();
      fn();
    };

    function handleAbort() {
      aborted = true;
      killProcessTree(child);
    }

    if (options.abortSignal) {
      if (options.abortSignal.aborted) {
        handleAbort();
      } else {
        options.abortSignal.addEventListener("abort", handleAbort, {
          once: true,
        });
      }
    }

    timeoutId = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      try {
        const parts = parser.push(chunk);
        if (parts.length) {
          onParts(parts);
        }
      } catch (error) {
        logger.error("Failed to process CLI output chunk", error);
      }
    });

    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Bounded so a chatty failure cannot grow without limit.
      if (stderr.length < 32_000) {
        stderr += chunk;
      }
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      finish(() => {
        if (error.code === "ENOENT") {
          reject(binaryNotFoundError(binaryPath));
        } else {
          reject(error);
        }
      });
    });

    child.on("close", (code) => {
      const tailParts = parser.flush();
      if (tailParts.length) {
        onParts(tailParts);
      }

      finish(() => {
        if (aborted) {
          // The AI SDK treats an abort as a normal early termination.
          resolve({ parts: [] });
          return;
        }
        if (timedOut) {
          reject(timeoutError(timeoutMs));
          return;
        }
        // Rate limit events are only consulted when the run actually failed.
        // The CLI also emits them on healthy runs (status "allowed"), and
        // treating an unrecognised status as fatal would reject good output.
        if (code !== 0 || parser.result?.isError) {
          reject(exitCodeError({ code, stderr, rateLimit: parser.rateLimit }));
          return;
        }

        const trailing: LanguageModelV3StreamPart[] = [];
        // Guard against a successful run that never produced a finish part
        // (e.g. output truncated by an unexpected CLI change).
        if (!parser.hasFinished()) {
          trailing.push(...parser.fallbackTextParts());
          trailing.push({
            type: "finish",
            usage: EMPTY_USAGE,
            finishReason: { unified: "stop", raw: undefined },
          });
        }
        resolve({ parts: trailing });
      });
    });

    child.stdin?.on("error", (error) => {
      logger.warn("Failed to write prompt to CLI stdin", error);
    });
    child.stdin?.end(request.stdin, "utf8");
  });
}

class ClaudeCliLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "claude-cli";
  readonly supportedUrls = {};

  /**
   * Cached so the probe cost (two fast local process spawns) is paid once per
   * provider instance rather than on every generation.
   */
  private preflight: Promise<void> | undefined;

  constructor(
    readonly modelId: string,
    private readonly options: ClaudeCliProviderOptions,
  ) {}

  /**
   * Verifies the CLI is installed and signed in before the first generation,
   * so setup problems surface as an actionable message instead of a failed
   * run. Only a confirmed-bad result throws: if the probe itself cannot run we
   * fall through and let the real invocation report the error.
   */
  private async ensureReady(): Promise<void> {
    this.preflight ??= (async () => {
      const health = await checkClaudeCliHealth({
        binaryPath: this.options.binaryPath,
      });
      if (health.ok) {
        logger.debug(
          `Claude CLI ready: ${health.version} (${health.authMethod ?? "unknown auth"}, ` +
            `${health.subscriptionType ?? "unknown plan"})`,
        );
        return;
      }
      if (!health.installed) {
        throw binaryNotFoundError(health.binaryPath);
      }
      if (!health.loggedIn) {
        throw notAuthenticatedError();
      }
    })().catch((error) => {
      // Do not cache a rejected promise: the user can fix the problem (log in,
      // install the CLI) and retry without restarting Dyad.
      this.preflight = undefined;
      throw error;
    });
    return this.preflight;
  }

  async doStream(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3StreamResult> {
    const request = buildClaudeCliRequest({
      options,
      modelId: this.modelId,
      extraArgs: this.options.extraArgs,
    });

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      start: async (controller) => {
        controller.enqueue({
          type: "stream-start",
          warnings: request.warnings,
        });
        try {
          await this.ensureReady();
          const { parts } = await runClaudeCli(
            {
              options,
              modelId: this.modelId,
              providerOptions: this.options,
            },
            (chunk) => {
              for (const part of chunk) {
                controller.enqueue(part);
              }
            },
          );
          for (const part of parts) {
            controller.enqueue(part);
          }
          controller.close();
        } catch (error) {
          // Surfacing the failure as an error part lets Dyad render it in the
          // chat instead of tearing down the whole stream.
          controller.enqueue({ type: "error", error });
          controller.close();
        }
      },
    });

    return { stream };
  }

  async doGenerate(
    options: LanguageModelV3CallOptions,
  ): Promise<LanguageModelV3GenerateResult> {
    const request = buildClaudeCliRequest({
      options,
      modelId: this.modelId,
      extraArgs: this.options.extraArgs,
    });

    await this.ensureReady();

    const collected: LanguageModelV3StreamPart[] = [];
    const { parts } = await runClaudeCli(
      { options, modelId: this.modelId, providerOptions: this.options },
      (chunk) => collected.push(...chunk),
    );
    collected.push(...parts);

    let text = "";
    let reasoning = "";
    let usage: LanguageModelV3Usage = EMPTY_USAGE;
    let finishReason: LanguageModelV3GenerateResult["finishReason"] = {
      unified: "stop",
      raw: undefined,
    };

    for (const part of collected) {
      if (part.type === "text-delta") {
        text += part.delta;
      } else if (part.type === "reasoning-delta") {
        reasoning += part.delta;
      } else if (part.type === "finish") {
        usage = part.usage;
        finishReason = part.finishReason;
      } else if (part.type === "error") {
        throw part.error;
      }
    }

    const content: LanguageModelV3Content[] = [];
    if (reasoning) {
      content.push({ type: "reasoning", text: reasoning });
    }
    if (text) {
      content.push({ type: "text", text });
    }

    return {
      content,
      finishReason,
      usage,
      warnings: request.warnings,
    };
  }
}

/**
 * Creates a provider that runs generations through the locally installed
 * Claude Code CLI instead of the Anthropic API.
 *
 * The CLI runs with every built-in tool disabled, so it behaves as a plain
 * text generator and Dyad keeps full ownership of file edits through its
 * `<dyad-write>` tag pipeline.
 */
export function createClaudeCliProvider(
  options: ClaudeCliProviderOptions = {},
): ClaudeCliProvider {
  return (modelId: string) =>
    new ClaudeCliLanguageModel(modelId, options) as unknown as LanguageModel;
}
