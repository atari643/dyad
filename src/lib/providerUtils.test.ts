import { describe, expect, it } from "vitest";

import {
  CLAUDE_CLI_PROVIDER_ID,
  CLI_PROVIDERS,
  CLOUD_PROVIDERS,
  LOCAL_PROVIDERS,
  MODEL_OPTIONS,
} from "@/ipc/shared/language_model_constants";
import { isProviderSetup } from "@/lib/providerUtils";
import type { UserSettings } from "@/lib/schemas";

const EMPTY_SETTINGS = { providerSettings: {} } as unknown as UserSettings;

describe("isProviderSetup", () => {
  it("treats the Claude CLI provider as configured without any API key", () => {
    // Credentials live in the CLI's own session, so there is nothing for Dyad
    // to store. Reporting it as set up is what keeps its models unlocked in
    // the picker.
    expect(
      isProviderSetup(CLAUDE_CLI_PROVIDER_ID, {
        settings: EMPTY_SETTINGS,
        envVars: {},
      }),
    ).toBe(true);
  });

  it("still reports an unconfigured API provider as not set up", () => {
    expect(
      isProviderSetup("openai", { settings: EMPTY_SETTINGS, envVars: {} }),
    ).toBe(false);
  });

  it("reports nothing as set up while data is still loading", () => {
    expect(
      isProviderSetup(CLAUDE_CLI_PROVIDER_ID, {
        settings: EMPTY_SETTINGS,
        envVars: {},
        isLoading: true,
      }),
    ).toBe(false);
  });
});

describe("CLI provider registry", () => {
  it("registers Claude CLI with selectable models", () => {
    expect(CLI_PROVIDERS[CLAUDE_CLI_PROVIDER_ID]).toBeDefined();
    expect(MODEL_OPTIONS[CLAUDE_CLI_PROVIDER_ID]?.length).toBeGreaterThan(0);
  });

  it("keeps CLI providers out of the cloud and local registries", () => {
    // A CLOUD_PROVIDERS entry would require a gatewayPrefix, which makes Dyad
    // Pro route the request through its hosted engine instead of the local
    // CLI. LOCAL_PROVIDERS is reserved for runtime-discovered models.
    expect(CLOUD_PROVIDERS[CLAUDE_CLI_PROVIDER_ID]).toBeUndefined();
    expect(LOCAL_PROVIDERS[CLAUDE_CLI_PROVIDER_ID]).toBeUndefined();
  });

  it("bills CLI models as free, since they run on the user's subscription", () => {
    for (const model of MODEL_OPTIONS[CLAUDE_CLI_PROVIDER_ID]) {
      expect(model.dollarSigns).toBe(0);
    }
  });
});
