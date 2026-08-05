import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useLanguageModelProviders } from "./useLanguageModelProviders";

const mocks = vi.hoisted(() => ({
  selectedModel: {
    provider: "ollama",
    name: "llama3",
  },
  useQueryResult: {
    data: undefined as { id: string; type?: string }[] | undefined,
    isLoading: true,
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mocks.useQueryResult,
}));

vi.mock("@/ipc/types", () => ({
  ipc: {
    languageModel: {
      getProviders: vi.fn(),
    },
  },
}));

vi.mock("./useSettings", () => ({
  useSettings: () => ({
    envVars: {},
    settings: {
      providerSettings: {},
      selectedModel: mocks.selectedModel,
    },
  }),
}));

describe("useLanguageModelProviders", () => {
  beforeEach(() => {
    mocks.selectedModel = {
      provider: "ollama",
      name: "llama3",
    };
    mocks.useQueryResult = {
      data: undefined,
      isLoading: true,
    };
  });

  it("treats a selected Ollama model as a configured provider while provider data is loading", () => {
    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(true);
  });

  it("treats a selected LM Studio model as a configured provider", () => {
    mocks.selectedModel = {
      provider: "lmstudio",
      name: "local-model",
    };

    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(true);
  });

  it("treats a selected Claude CLI model as a configured provider", () => {
    // Credentials live in the CLI session, so there is no API key to check.
    // Without this, sending the first prompt is blocked by the setup gate and
    // the user is told to configure an API key they do not need.
    mocks.selectedModel = {
      provider: "claude-cli",
      name: "sonnet",
    };

    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(true);
  });

  it("still reports nothing configured when no provider is selected", () => {
    // The setup banner must keep working on a fresh install.
    mocks.selectedModel = { provider: "openai", name: "gpt-5.5" };
    mocks.useQueryResult = { data: [], isLoading: false };

    const { result } = renderHook(() => useLanguageModelProviders());

    expect(result.current.isAnyProviderSetup()).toBe(false);
  });
});
