import { ORCHESTRATION_V2_WS_METHODS } from "@t3tools/contracts";
import { createOrchestrationEnvironmentAtoms } from "@t3tools/client-runtime/state/orchestration";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const orchestrationEnvironment = createOrchestrationEnvironmentAtoms(connectionAtomRuntime);

/** One-shot read of a thread's full projection, for gestures that need
    detail the shell does not carry (the board's plan approval). */
export const fetchThreadProjection = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:orchestration-v2:fetch-thread-projection",
  tag: ORCHESTRATION_V2_WS_METHODS.getThreadProjection,
});
