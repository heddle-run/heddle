export type {
  Mount,
  MountMode,
  Workspace,
  WorkspaceFactory,
  WorkspaceGrant,
} from './types.js';
export { createScratchWorkspace, createWorkspaceFactory } from './factory.js';
export type { WorkspaceFactoryOptions } from './factory.js';
export { RESERVED_DIR, ScopeWorkspace } from './workspace.js';
export { workspaceEnv } from './env.js';
export { createWorkspace, removeDir } from './dir.js';
