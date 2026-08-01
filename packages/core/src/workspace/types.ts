/**
 * Where a node's tools work, and what is in there when they start.
 *
 * A workspace is not a sandbox. A sandbox answers *what may this program
 * touch*; a workspace answers *where does it work*. The two were one thing
 * until now only because the only code that ever made a directory happened to
 * live in `sandbox/` — which meant "does this node have a workspace at all?"
 * was answered by "is `--safe` on?", and a plugin node behaved differently
 * depending on a flag it is not supposed to know about.
 *
 * So this module owns the directory and the sandbox is handed one. The
 * dependency runs one way and must keep running one way: **nothing here may
 * import from `sandbox/`.** The sandbox imports `Workspace` and asks it what to
 * permit; if that ever inverts, the two concepts have been merged again.
 *
 * Without `--safe` a workspace is a convention rather than a boundary — a tool
 * can `cd ..` out of it and heddle will not stop it. `$HEDDLE_WORKSPACE` says
 * where the work happens; `$HEDDLE_SANDBOX` says whether anything is stopping
 * you.
 */

/** Whether what a mount put in the workspace comes back out again. */
export type MountMode = 'ro' | 'rw';

export interface Mount {
  /**
   * Where it lands, relative to the workspace root.
   *
   * Never absolute, never climbs, never under `.heddle` — checked once when the
   * mount is parsed, so a bad one fails before the run starts rather than at
   * whichever node reaches it first.
   */
  dest: string;
  /** An absolute host path, already resolved and checked. */
  source: string;
  mode: MountMode;
  /** Who asked for it — `--mount`, or a plugin's name. Read when two collide. */
  origin: string;
}

/**
 * What a confinement backend has to permit, and on what terms.
 *
 * The one place a workspace and a sandbox have to agree, and the reason it is
 * data rather than a call: a workspace does not know that bubblewrap binds and
 * seatbelt writes a profile, and neither backend knows why a path is on the
 * list.
 *
 * **Order is significant.** A grant may nest inside an earlier one — the
 * read-only `.heddle` inside the writable root is the case this exists for —
 * and both backends resolve a nested grant by taking the later of the two.
 */
export interface WorkspaceGrant {
  path: string;
  access: 'read' | 'write';
}

/**
 * A tool as a workspace sees it: a name, and something to put behind it.
 *
 * Deliberately not `ToolDef`. The tool layer builds on this module, so taking
 * its type here would close a cycle — and a workspace needs two of a `ToolDef`'s
 * fields, which is a good sign it should say so rather than take the whole
 * thing.
 */
export interface WorkspaceTool {
  name: string;
  /** The real path, for a tool that is a program heddle runs. */
  target?: string;
  /** The plugin that answers it, when there is no program to link. */
  servedBy?: string;
}

/**
 * One node scope's working directory.
 *
 * `root` is `$HEDDLE_WORKSPACE`, the cwd every tool is given, and the whole of
 * what a tool may write. One name is reserved inside it and it is hidden:
 * `.heddle`, which holds `bin`. Hidden because the model lists this directory
 * constantly and what it is looking for is its own files.
 */
export interface Workspace {
  readonly root: string;
  /** `<root>/.heddle/bin`. Last on `$PATH`, and read-only. */
  readonly bin: string;
  grants(): WorkspaceGrant[];
  /**
   * Host directories outside the workspace that its contents point into.
   *
   * The directories the `bin` symlinks resolve to. Separate from `grants()`
   * because these are not nested in the root and carry none of that list's
   * ordering meaning: a backend adds them where it already adds `--tools-dir`,
   * which is the honest place for "a path the tools need to be able to read".
   */
  toolPaths(): string[];
  /**
   * Copies `rw` mounts back, then removes the root unless it was given.
   *
   * Never throws. It runs in the `finally` of a node's execution, where a
   * failure of its own would mask the run's — so a copy-back that cannot
   * complete is reported through the factory's `onWarn` and nothing else.
   */
  dispose(): void;
}

/**
 * What makes a workspace, and the reason there is one at all.
 *
 * Built once — from what the operator mounted and what the loaded plugins ship
 * — and consulted per node scope. Read-only mounts are assembled into a
 * template at construction and copied per scope; read-write ones are copied
 * from the host per scope, so a node that starts after another finished sees
 * what it wrote back.
 *
 * `create` is synchronous, and that is load-bearing rather than incidental.
 * `Executor.beginScope` is synchronous, so a workspace cannot be provisioned by
 * asking anything that lives behind a pipe — which is exactly the per-call IPC
 * the plugin system keeps deciding it does not want, here forbidden by a
 * signature instead of by discipline.
 */
export interface WorkspaceFactory {
  /**
   * `tools` are put in `bin` and go on `$PATH`, so a tool can reach a peer by
   * the name the model uses for it. They arrive per scope rather than
   * being held here, because on a server the tool registry is per run.
   */
  create(label: string, tools?: WorkspaceTool[]): Workspace;
  /**
   * A factory mounting everything this one mounts, plus `mounts` — and owning
   * none of this one's directories.
   *
   * What lets a server take files in a request body. This factory is built once
   * at startup from what the operator mounted, because what is in the working
   * directory of every node of every run is the operator's to decide; a run
   * layers its own caller's bytes onto a copy of it and disposes the copy when
   * it ends. The parent's assembled template is *shared* rather than rebuilt —
   * it is the same bytes for every run, and copying the operator's mounts again
   * per request would pay for them per request.
   *
   * Which is also why disposing the child must not dispose the parent's
   * template: `dispose` is how a run removes what it brought, and a run must
   * not remove what it found.
   *
   * A mount that collides with one the parent already holds is refused here
   * rather than shadowing it, for the reason `PluginRegistry.extend` carries
   * names over: request content must not be able to take a workspace path the
   * operator already claimed.
   */
  extend(mounts: Mount[]): WorkspaceFactory;
  dispose(): void;
}
