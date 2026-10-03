import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback } from "react";

import { useServerConfigs } from "~/state/entities";

/** Whether an environment's server persists board task fields (taskDetails /
    workflowPreset). Older servers drop the keys silently, so the board hides
    task editing for them instead of showing edits that never stick. */
export function useTaskDetailsSupport(): (environmentId: EnvironmentId) => boolean {
  const configs = useServerConfigs();
  return useCallback(
    (environmentId) =>
      configs.get(environmentId)?.environment.capabilities.threadTaskDetails === true,
    [configs],
  );
}
