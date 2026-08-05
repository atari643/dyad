import { useQuery } from "@tanstack/react-query";
import { ipc, type LanguageModelProvider } from "@/ipc/types";
import { useSettings } from "./useSettings";
import { cloudProviders } from "@/lib/schemas";
import { CLI_PROVIDERS } from "@/ipc/shared/language_model_constants";
import { queryKeys } from "@/lib/queryKeys";
import { isProviderSetup as isProviderSetupUtil } from "@/lib/providerUtils";

/**
 * Providers whose credentials live outside Dyad — a local server (Ollama,
 * LM Studio) or a signed-in CLI session.
 *
 * There is no API key for Dyad to check, so they count as configured once the
 * user has actually selected one. Gating on selection rather than on mere
 * existence keeps the setup banner working for a fresh install; if the backing
 * server or CLI is missing, the request fails with an actionable error instead.
 */
const selfConfiguredProviders = new Set([
  "ollama",
  "lmstudio",
  ...Object.keys(CLI_PROVIDERS),
]);

export function useLanguageModelProviders() {
  const { settings, envVars } = useSettings();

  const queryResult = useQuery<LanguageModelProvider[], Error>({
    queryKey: queryKeys.languageModels.providers,
    queryFn: async () => {
      return ipc.languageModel.getProviders();
    },
  });

  const isProviderSetup = (provider: string) => {
    return isProviderSetupUtil(provider, {
      settings,
      envVars,
      providerData: queryResult.data,
      isLoading: queryResult.isLoading,
    });
  };

  const isAnyProviderSetup = () => {
    if (
      settings?.selectedModel.provider &&
      selfConfiguredProviders.has(settings.selectedModel.provider) &&
      settings.selectedModel.name.trim()
    ) {
      return true;
    }

    // Check hardcoded cloud providers
    if (cloudProviders.some((provider) => isProviderSetup(provider))) {
      return true;
    }

    // Check custom providers
    const customProviders = queryResult.data?.filter(
      (provider) => provider.type === "custom",
    );
    return (
      customProviders?.some((provider) => isProviderSetup(provider.id)) ?? false
    );
  };

  return {
    ...queryResult,
    isProviderSetup,
    isAnyProviderSetup,
  };
}
