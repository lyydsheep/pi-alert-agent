import { execFile } from 'node:child_process';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface GitWorkspace {
  taskId: string;
  path: string;
  branch: string;
  head: string;
  resumed: boolean;
}

export interface PushResult {
  head: string;
  alreadyPresent: boolean;
}

export interface GitWorkspaceOptions {
  repositoryPath: string;
  worktreeRoot: string;
  remote?: string;
  targetBranch?: string;
  timeoutMs?: number;
}

export class GitWorkspaceConflictError extends Error {
  override name = 'GitWorkspaceConflictError';
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;

function run(command: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<string> {
  return new Promise((accept, reject) => {
    execFile(command, args, { cwd, encoding: 'utf8', timeout: timeoutMs, signal, maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(' ')} failed: ${stderr.trim() || error.message}`, { cause: error }));
      } else {
        accept(stdout.trim());
      }
    });
  });
}

function taskPart(taskId: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) throw new Error(`Unsafe task id: ${taskId}`);
  return taskId;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}

export class GitWorkspaceManager {
  readonly repositoryPath: string;
  readonly worktreeRoot: string;
  readonly remote: string;
  readonly targetBranch: string;
  readonly timeoutMs: number;

  constructor(options: GitWorkspaceOptions) {
    this.repositoryPath = resolve(options.repositoryPath);
    this.worktreeRoot = resolve(options.worktreeRoot);
    this.remote = options.remote ?? 'origin';
    this.targetBranch = options.targetBranch ?? 'master';
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async prepare(taskId: string, kind: 'fix' | 'feat' = 'fix', signal?: AbortSignal, expectedHead?: string): Promise<GitWorkspace> {
    const id = taskPart(taskId);
    const branch = `${kind}/faizili_${id}`;
    const path = join(this.worktreeRoot, id);
    const registered = await this.worktrees(signal);
    const pathExists = await exists(path);
    const current = registered.get(await canonical(path));

    if (current) {
      if (current !== branch) throw new Error(`Worktree ${path} is attached to ${current}, expected ${branch}`);
      if (expectedHead) await this.syncExpectedHead(path, branch, expectedHead, signal);
      return { taskId, path, branch, head: await this.head(path, signal), resumed: true };
    }

    if (pathExists) throw new Error(`Workspace path already exists but is not a registered worktree: ${path}`);
    await mkdir(this.worktreeRoot, { recursive: true });

    if (await this.localBranchExists(branch, signal)) {
      await this.git(['worktree', 'add', path, branch], signal);
      if (expectedHead) await this.syncExpectedHead(path, branch, expectedHead, signal);
      return { taskId, path, branch, head: await this.head(path, signal), resumed: true };
    }

    if (expectedHead) throw new GitWorkspaceConflictError(`Cannot resume ${branch}: the local branch is missing`);

    await this.git(['fetch', this.remote, this.targetBranch], signal);
    await this.git(['worktree', 'add', '-b', branch, path, 'FETCH_HEAD'], signal);
    return { taskId, path, branch, head: await this.head(path, signal), resumed: false };
  }

  head(workspacePath: string, signal?: AbortSignal): Promise<string> {
    return run('git', ['rev-parse', 'HEAD'], workspacePath, this.timeoutMs, signal);
  }

  status(workspacePath: string): Promise<string> {
    return run('git', ['status', '--porcelain'], workspacePath, this.timeoutMs);
  }

  async push(workspace: Pick<GitWorkspace, 'path' | 'branch'>, signal?: AbortSignal): Promise<PushResult> {
    const branch = workspace.branch;
    if (!/^(fix|feat)\/faizili_[A-Za-z0-9._-]+$/.test(branch)) throw new Error(`Refusing to push unexpected branch: ${branch}`);
    const currentBranch = await run('git', ['branch', '--show-current'], workspace.path, this.timeoutMs, signal);
    if (currentBranch !== branch) throw new Error(`Refusing to push ${currentBranch || 'detached HEAD'} as ${branch}`);
    const head = await this.head(workspace.path, signal);
    const remote = await run('git', ['ls-remote', '--heads', this.remote, `refs/heads/${branch}`], workspace.path, this.timeoutMs, signal);
    const remoteHead = remote.split(/\s+/)[0] || undefined;
    if (remoteHead === head) return { head, alreadyPresent: true };

    await run('git', ['push', '--set-upstream', this.remote, `HEAD:refs/heads/${branch}`], workspace.path, this.timeoutMs, signal);
    return { head, alreadyPresent: false };
  }

  async cleanup(workspace: Pick<GitWorkspace, 'path' | 'branch'>, completedAt: number, now = Date.now(), signal?: AbortSignal): Promise<boolean> {
    if (now - completedAt < WEEK_MS) return false;
    const registeredBranch = (await this.worktrees(signal)).get(await canonical(workspace.path));
    if (registeredBranch !== workspace.branch) throw new Error(`Refusing to clean unowned worktree: ${workspace.path}`);
    const status = await run('git', ['status', '--porcelain'], workspace.path, this.timeoutMs, signal);
    if (status) throw new Error(`Refusing to clean a worktree with uncommitted changes: ${workspace.path}`);
    await this.head(workspace.path, signal);
    await this.git(['show-ref', '--verify', `refs/heads/${workspace.branch}`], signal);
    await this.git(['worktree', 'remove', workspace.path], signal);
    return true;
  }

  private git(args: string[], signal?: AbortSignal): Promise<string> {
    return run('git', args, this.repositoryPath, this.timeoutMs, signal);
  }

  private async localBranchExists(branch: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await this.git(['show-ref', '--verify', `refs/heads/${branch}`], signal);
      return true;
    } catch {
      return false;
    }
  }

  private async syncExpectedHead(path: string, branch: string, expectedHead: string, signal?: AbortSignal): Promise<void> {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(expectedHead)) throw new GitWorkspaceConflictError(`Invalid expected MR HEAD: ${expectedHead}`);
    const fetchedRef = `refs/pi-alert-agent/mr/${branch}`;
    try {
      await this.git(['fetch', '--no-write-fetch-head', this.remote, `+refs/heads/${branch}:${fetchedRef}`], signal);
    } catch (error) {
      throw new GitWorkspaceConflictError(`Cannot fetch MR branch ${branch}`, { cause: error });
    }
    const fetchedHead = await this.git(['rev-parse', fetchedRef], signal);
    if (fetchedHead !== expectedHead.toLowerCase()) {
      throw new GitWorkspaceConflictError(`MR branch ${branch} moved from expected HEAD ${expectedHead} to ${fetchedHead}`);
    }

    const localHead = await this.head(path, signal);
    if (localHead === fetchedHead || await this.isAncestor(fetchedHead, localHead, path, signal)) return;
    if (!await this.isAncestor(localHead, fetchedHead, path, signal)) {
      throw new GitWorkspaceConflictError(`Local branch ${branch} diverged from expected MR HEAD ${expectedHead}`);
    }
    if (await run('git', ['status', '--porcelain'], path, this.timeoutMs, signal)) {
      throw new GitWorkspaceConflictError(`Local branch ${branch} is behind expected MR HEAD ${expectedHead} and has uncommitted changes`);
    }
    await run('git', ['merge', '--ff-only', fetchedHead], path, this.timeoutMs, signal);
  }

  private async isAncestor(ancestor: string, descendant: string, cwd: string, signal?: AbortSignal): Promise<boolean> {
    try {
      await run('git', ['merge-base', '--is-ancestor', ancestor, descendant], cwd, this.timeoutMs, signal);
      return true;
    } catch (error) {
      if ((error as Error & { cause?: { code?: string | number } }).cause?.code === 1) return false;
      throw error;
    }
  }

  private async worktrees(signal?: AbortSignal): Promise<Map<string, string>> {
    const output = await this.git(['worktree', 'list', '--porcelain'], signal);
    const result = new Map<string, string>();
    let path: string | undefined;
    for (const line of output.split('\n')) {
      if (line.startsWith('worktree ')) path = await canonical(line.slice(9));
      if (path && line.startsWith('branch refs/heads/')) result.set(path, line.slice('branch refs/heads/'.length));
      if (!line) path = undefined;
    }
    return result;
  }
}
