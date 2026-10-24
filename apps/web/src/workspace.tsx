import { createContext, useContext } from "react";
import type { Workspace } from "./api";

export type WorkspaceContextValue = {
  workspace: Workspace;
  workspaces: Workspace[];
  selectWorkspace: (id: string) => void;
};

export const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used inside WorkspaceContext");
  return value;
}
