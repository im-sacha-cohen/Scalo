import type { AccountRole } from './edition';

/** A workspace: a separate account (contacts, funnels, emails, payments, settings…) the person can switch to. */
export interface Workspace {
  id: number;
  name: string;
  /** The role of the signed-in person in it (`owner` for his own workspaces). */
  role: AccountRole;
  /** The first account of the person: deleting it deletes the person and all his workspaces. */
  personal: boolean;
  created_at: string;
}

export interface WorkspaceList {
  /** The workspace the request worked on. */
  current: number;
  workspaces: Workspace[];
  /** The person may create workspaces (owners of their own account, not the logins of team members). */
  can_create: boolean;
}

/** URL of the MCP server of one workspace: a client connected to it can only act on that workspace. */
export const workspaceMcpUrl = (publicUrl: string, workspaceId: number) => `${publicUrl.replace(/\/+$/, '')}/mcp/${workspaceId}`;
