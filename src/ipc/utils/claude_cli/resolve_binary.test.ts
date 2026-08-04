import { describe, expect, it } from "vitest";

import {
  isShellShim,
  resolveClaudeBinary,
} from "@/ipc/utils/claude_cli/resolve_binary";

describe("resolveClaudeBinary", () => {
  it("prefers an explicitly configured path over everything else", () => {
    const resolved = resolveClaudeBinary({
      configuredPath: "/custom/claude",
      env: { PATH: "/usr/bin", DYAD_CLAUDE_CLI_PATH: "/from/env/claude" },
    });

    expect(resolved).toBe("/custom/claude");
  });

  it("falls back to DYAD_CLAUDE_CLI_PATH when no setting is present", () => {
    const resolved = resolveClaudeBinary({
      env: { PATH: "/usr/bin", DYAD_CLAUDE_CLI_PATH: "/from/env/claude" },
    });

    expect(resolved).toBe("/from/env/claude");
  });

  it("ignores a blank configured path", () => {
    const resolved = resolveClaudeBinary({
      configuredPath: "   ",
      env: { PATH: "/usr/bin", DYAD_CLAUDE_CLI_PATH: "/from/env/claude" },
    });

    expect(resolved).toBe("/from/env/claude");
  });

  it("falls back to a bare command name when nothing is found on PATH", () => {
    // A clear ENOENT from spawn beats guessing at an install location.
    const resolved = resolveClaudeBinary({
      env: { PATH: "/nonexistent-dir-for-tests" },
    });

    expect(resolved).toBe("claude");
  });
});

describe("isShellShim", () => {
  it("flags Windows batch shims, which cannot be spawned without a shell", () => {
    expect(isShellShim("C:/npm/claude.cmd")).toBe(true);
    expect(isShellShim("C:/npm/claude.BAT")).toBe(true);
  });

  it("does not flag native executables", () => {
    expect(isShellShim("C:/npm/claude.exe")).toBe(false);
    expect(isShellShim("/usr/local/bin/claude")).toBe(false);
  });
});
