import { existsSync, statSync } from "node:fs";
import path from "node:path";

const IS_WINDOWS = process.platform === "win32";
const BASENAME = "claude";

/**
 * Where the npm package keeps its native launcher, relative to the directory
 * holding npm's generated shims.
 */
const NPM_PACKAGE_EXE = path.join(
  "node_modules",
  "@anthropic-ai",
  "claude-code",
  "bin",
  IS_WINDOWS ? "claude.exe" : "claude",
);

function isFile(candidate: string): boolean {
  try {
    return existsSync(candidate) && statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * npm generates a `claude.cmd` batch shim on Windows, and Node refuses to spawn
 * `.cmd`/`.bat` files unless `shell: true` (EINVAL since the CVE-2024-27980
 * fix). Using a shell would drag in cmd.exe quoting rules and its ~8k command
 * line limit, so we prefer the real `.exe` the package ships next to the shim
 * and keep spawning with `shell: false`.
 */
export function upgradeShimToNativeBinary(shimPath: string): string {
  if (!isShellShim(shimPath)) {
    return shimPath;
  }
  const sibling = path.join(path.dirname(shimPath), NPM_PACKAGE_EXE);
  return isFile(sibling) ? sibling : shimPath;
}

/** True when spawning requires a shell (Windows batch shims). */
export function isShellShim(binaryPath: string): boolean {
  const ext = path.extname(binaryPath).toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function candidateNames(): string[] {
  // Ordered by preference: a native executable spawns without a shell.
  return IS_WINDOWS ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
}

function searchPath(env: NodeJS.ProcessEnv): string | undefined {
  const rawPath = env.PATH ?? env.Path ?? "";
  const dirs = rawPath.split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of candidateNames()) {
      const candidate = path.join(dir, name);
      if (isFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

export interface ResolveClaudeBinaryOptions {
  /** Explicit path from user settings (highest precedence). */
  configuredPath?: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolves the Claude CLI executable.
 *
 * Precedence: explicit setting -> DYAD_CLAUDE_CLI_PATH -> PATH lookup ->
 * bare "claude" (lets the OS resolve it, and produces a clear ENOENT if the
 * CLI really is missing).
 */
export function resolveClaudeBinary({
  configuredPath,
  env = process.env,
}: ResolveClaudeBinaryOptions = {}): string {
  const explicit = configuredPath?.trim() || env.DYAD_CLAUDE_CLI_PATH?.trim();
  if (explicit) {
    // Honour the user's choice verbatim; only swap a shim for its native
    // sibling, which is behaviour-preserving.
    return upgradeShimToNativeBinary(explicit);
  }

  const found = searchPath(env);
  if (found) {
    return upgradeShimToNativeBinary(found);
  }

  return BASENAME;
}
