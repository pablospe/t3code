import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import type { UnifiedSettings } from "@t3tools/contracts/settings";

import { resolveAppModelSelectionForInstance } from "../../modelSelection";
import { deriveProviderInstanceEntries } from "../../providerInstances";

/**
 * The model a board task is created with, in the order a regular new thread
 * uses: the project's default, then the user's sticky composer pick, then the
 * first usable provider's default model. Every candidate must name a provider
 * instance that is enabled and available on the project's environment, so a
 * task never inherits a placeholder such as a mirrored terminal session's
 * instance, which has no adapter to run it. Null means nothing can run it yet.
 */
export function resolveBoardTaskModelSelection(input: {
  readonly projectDefault: ModelSelection | null;
  readonly sticky: {
    readonly activeProvider: ProviderInstanceId | null;
    readonly byProvider: Partial<Record<ProviderInstanceId, ModelSelection>>;
  };
  /** The project environment's providers. */
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: UnifiedSettings;
}): ModelSelection | null {
  const usable = deriveProviderInstanceEntries(input.providers).filter(
    (entry) => entry.enabled && entry.isAvailable,
  );
  const onUsableProvider = (selection: ModelSelection | null | undefined) => {
    if (!selection || !usable.some((entry) => entry.instanceId === selection.instanceId)) {
      return null;
    }
    const model = resolveAppModelSelectionForInstance(
      selection.instanceId,
      input.settings,
      input.providers,
      selection.model,
    );
    if (!model) return null;
    // Options belong to the model they were picked for.
    return model === selection.model ? selection : { instanceId: selection.instanceId, model };
  };
  const stickySelection =
    input.sticky.activeProvider === null
      ? null
      : input.sticky.byProvider[input.sticky.activeProvider];
  const fallback = usable
    .map((entry) => {
      const model = resolveAppModelSelectionForInstance(
        entry.instanceId,
        input.settings,
        input.providers,
        null,
      );
      return model ? { instanceId: entry.instanceId, model } : null;
    })
    .find((selection) => selection !== null);
  return (
    onUsableProvider(input.projectDefault) ?? onUsableProvider(stickySelection) ?? fallback ?? null
  );
}
