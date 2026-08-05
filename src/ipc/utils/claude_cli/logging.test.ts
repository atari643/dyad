import { afterEach, describe, expect, it, vi } from "vitest";

const debugSpy = vi.fn();
const infoSpy = vi.fn();

vi.mock("electron-log", () => ({
  default: {
    scope: () => ({
      debug: debugSpy,
      info: infoSpy,
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

const { debugLog } = await import("@/ipc/utils/claude_cli/logging");

afterEach(() => {
  delete process.env.DYAD_CLAUDE_CLI_DEBUG;
  debugSpy.mockClear();
  infoSpy.mockClear();
});

describe("debugLog", () => {
  it("stays at debug level by default", () => {
    debugLog("hello");

    expect(debugSpy).toHaveBeenCalledWith("hello");
    expect(infoSpy).not.toHaveBeenCalled();
  });

  it("promotes diagnostics to info when DYAD_CLAUDE_CLI_DEBUG=1", () => {
    // Documented in docs/cli-providers.md: this is what makes the provider's
    // diagnostics visible without enabling debug logging application-wide.
    process.env.DYAD_CLAUDE_CLI_DEBUG = "1";

    debugLog("hello");

    expect(infoSpy).toHaveBeenCalledWith("hello");
    expect(debugSpy).not.toHaveBeenCalled();
  });

  it("ignores values other than 1", () => {
    process.env.DYAD_CLAUDE_CLI_DEBUG = "true";

    debugLog("hello");

    expect(debugSpy).toHaveBeenCalledWith("hello");
    expect(infoSpy).not.toHaveBeenCalled();
  });
});
