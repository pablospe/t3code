/**
 * Mirror of the sidebar's project-scope selector ("All projects" dropdown),
 * shared so other surfaces - the board page and board drawer - follow the one
 * selector instead of growing their own. Not persisted: it tracks the
 * sidebar's session-local state, which owns the selection.
 */

import { create } from "zustand";

interface ProjectScopeState {
  /** `${environmentId}:${projectId}` member keys of the scoped group, or null for all projects. */
  scopedProjectKeys: ReadonlySet<string> | null;
  setScopedProjectKeys: (keys: ReadonlySet<string> | null) => void;
}

export const useProjectScopeStore = create<ProjectScopeState>()((set) => ({
  scopedProjectKeys: null,
  setScopedProjectKeys: (scopedProjectKeys) => set({ scopedProjectKeys }),
}));
