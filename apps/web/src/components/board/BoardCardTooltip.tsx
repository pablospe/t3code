import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { deriveProviderInstanceEntries, shouldShowInstanceBadge } from "~/providerInstances";
import { useEnvironments } from "~/state/environments";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { primaryServerProvidersAtom } from "~/state/server";
import { useThreadRunningTerminalIds } from "~/state/terminalSessions";
import { vcsEnvironment } from "~/state/vcs";
import type { SidebarThreadSummary } from "~/types";

import { resolveLocalCheckoutBranchMismatch } from "../BranchToolbar.logic";
import { getTriggerDisplayModelLabel } from "../chat/providerIconUtils";
import { SidebarThreadTooltip } from "../Sidebar";
import { terminalStatusFromRunningIds } from "../ThreadStatusIndicators";

/** The sidebar row's hover card, fed from hooks so board cards reuse it
    without threading a dozen props through the column tree. The hooks
    subscribe to the same stores and query keys the sidebar rows already
    hold for these threads, so the board adds no new server traffic. */
export function BoardCardTooltip({
  thread,
  projectTitle,
}: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
}) {
  const projects = useProjects();
  const project = useMemo(
    () =>
      projects.find(
        (candidate) =>
          candidate.environmentId === thread.environmentId && candidate.id === thread.projectId,
      ) ?? null,
    [projects, thread.environmentId, thread.projectId],
  );
  const { environments } = useEnvironments();
  const environmentLabel =
    environments.find((environment) => environment.environmentId === thread.environmentId)?.label ??
    null;

  const serverProviders = useAtomValue(primaryServerProvidersAtom);
  const providerEntries = useMemo(
    () => deriveProviderInstanceEntries(serverProviders),
    [serverProviders],
  );
  const modelInstanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const providerEntry =
    providerEntries.find((entry) => entry.instanceId === modelInstanceId) ?? null;
  const showInstanceBadge =
    providerEntry !== null && shouldShowInstanceBadge(providerEntry, providerEntries);
  const selectedModel = providerEntry?.models.find(
    (model) => model.slug === thread.modelSelection.model,
  );
  const modelLabel = selectedModel
    ? getTriggerDisplayModelLabel(selectedModel)
    : thread.modelSelection.model;

  const gitCwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
  const gitStatus = useEnvironmentQuery(
    (thread.branch != null || thread.worktreePath !== null) && gitCwd !== null
      ? vcsEnvironment.status({
          environmentId: thread.environmentId,
          input: { cwd: gitCwd },
        })
      : null,
  );
  const branchMismatch = resolveLocalCheckoutBranchMismatch({
    effectiveEnvMode: thread.worktreePath === null ? "local" : "worktree",
    activeWorktreePath: thread.worktreePath,
    activeThreadBranch: thread.branch,
    currentGitBranch: gitStatus.data?.refName ?? null,
  });

  const runningTerminalIds = useThreadRunningTerminalIds({
    environmentId: thread.environmentId,
    threadId: thread.id,
  });
  const terminalStatus = terminalStatusFromRunningIds(runningTerminalIds);

  return (
    <SidebarThreadTooltip
      thread={thread}
      projectTitle={projectTitle}
      projectCwd={project?.workspaceRoot ?? null}
      projectFaviconPath={project?.faviconPath ?? null}
      environmentLabel={environmentLabel}
      providerEntry={providerEntry}
      showInstanceBadge={showInstanceBadge}
      modelInstanceId={modelInstanceId}
      modelLabel={modelLabel}
      branchMismatch={branchMismatch}
      terminalStatus={terminalStatus}
      terminalProcessCount={runningTerminalIds.length}
    />
  );
}
