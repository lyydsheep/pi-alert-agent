import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitWorkspaceConflictError, GitWorkspaceManager } from '../src/git.ts';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function repository(): Promise<{ root: string; repo: string; worktrees: string }> {
  const root = await mkdtemp(join(tmpdir(), 'pi-alert-git-'));
  const remote = join(root, 'remote.git');
  const seed = join(root, 'seed');
  const repo = join(root, 'repo');
  const worktrees = join(root, 'worktrees');
  await mkdir(seed);
  git(root, 'init', '--bare', remote);
  git(seed, 'init', '-b', 'master');
  git(seed, 'config', 'user.email', 'test@example.com');
  git(seed, 'config', 'user.name', 'Test');
  await writeFile(join(seed, 'README.md'), 'base\n');
  git(seed, 'add', 'README.md');
  git(seed, 'commit', '-m', 'base');
  git(seed, 'remote', 'add', 'origin', remote);
  git(seed, 'push', '-u', 'origin', 'master');
  git(root, 'clone', remote, repo);
  return { root, repo, worktrees };
}

function configure(cwd: string): void {
  git(cwd, 'config', 'user.email', 'test@example.com');
  git(cwd, 'config', 'user.name', 'Test');
}

async function advanceRemote(root: string, branch: string, name: string): Promise<string> {
  const peer = join(root, `peer-${name}`);
  git(root, 'clone', join(root, 'remote.git'), peer);
  configure(peer);
  git(peer, 'checkout', branch);
  await writeFile(join(peer, `${name}.txt`), `${name}\n`);
  git(peer, 'add', `${name}.txt`);
  git(peer, 'commit', '-m', name);
  git(peer, 'push', 'origin', branch);
  return git(peer, 'rev-parse', 'HEAD');
}

async function pushedWorkspace(fixture: Awaited<ReturnType<typeof repository>>, taskId: string) {
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });
  const workspace = await manager.prepare(taskId);
  configure(workspace.path);
  await writeFile(join(workspace.path, 'initial.txt'), 'initial\n');
  git(workspace.path, 'add', 'initial.txt');
  git(workspace.path, 'commit', '-m', 'initial');
  await manager.push(workspace);
  return { manager, workspace, head: git(workspace.path, 'rev-parse', 'HEAD') };
}

test('creates from remote master, resumes, safely pushes, cleans, and restores', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });

  const workspace = await manager.prepare('task-1');
  assert.equal(workspace.branch, 'bugfix/faizili_task-1');
  assert.equal(workspace.resumed, false);
  assert.equal(await manager.prepare('task-1').then((value) => value.resumed), true);

  git(workspace.path, 'config', 'user.email', 'test@example.com');
  git(workspace.path, 'config', 'user.name', 'Test');
  await writeFile(join(workspace.path, 'fix.txt'), 'fixed\n');
  git(workspace.path, 'add', 'fix.txt');
  git(workspace.path, 'commit', '-m', 'fix');

  const pushedHead = git(workspace.path, 'rev-parse', 'HEAD');
  assert.equal((await manager.push(workspace)).alreadyPresent, false);
  assert.equal((await manager.push(workspace)).alreadyPresent, true);
  assert.equal(await manager.cleanup(workspace, 0, 7 * 24 * 60 * 60 * 1_000 - 1), false);
  assert.equal(await manager.cleanup(workspace, 0, 7 * 24 * 60 * 60 * 1_000), true);
  assert.ok(git(fixture.repo, 'show-ref', '--verify', 'refs/heads/bugfix/faizili_task-1'));

  const restored = await manager.prepare('task-1');
  assert.equal(restored.resumed, true);
  assert.equal(restored.head, pushedHead);
});

test('maps new logical kinds to Gongfeng branch prefixes', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });

  assert.equal((await manager.prepare('fix-kind', 'fix')).branch, 'bugfix/faizili_fix-kind');
  assert.equal((await manager.prepare('feat-kind', 'feat')).branch, 'feature/faizili_feat-kind');
});

test('resumes registered and retained legacy branches', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });
  await mkdir(fixture.worktrees);
  git(fixture.repo, 'branch', 'master', 'origin/master');
  git(fixture.repo, 'worktree', 'add', '-b', 'fix/faizili_registered', join(fixture.worktrees, 'registered'), 'master');
  git(fixture.repo, 'branch', 'feat/faizili_retained', 'master');

  assert.equal((await manager.prepare('registered', 'fix')).branch, 'fix/faizili_registered');
  const retained = await manager.prepare('retained', 'feat');
  assert.equal(retained.branch, 'feat/faizili_retained');
  assert.equal((await manager.push(retained)).alreadyPresent, false);
  assert.ok(git(fixture.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/feat/faizili_retained'));
});

test('refuses cleanup when committed restoration would lose work', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });
  const workspace = await manager.prepare('dirty');
  await writeFile(join(workspace.path, 'dirty.txt'), 'uncommitted\n');
  assert.match(await manager.status(workspace.path), /dirty\.txt/);
  await assert.rejects(() => manager.cleanup(workspace, 0, 8 * 24 * 60 * 60 * 1_000), /uncommitted changes/);
});

test('fast-forwards an existing MR workspace to its observed remote HEAD', async () => {
  const fixture = await repository();
  const { manager, workspace } = await pushedWorkspace(fixture, 'fast-forward');
  const expectedHead = await advanceRemote(fixture.root, workspace.branch, 'remote');

  const resumed = await manager.prepare('fast-forward', 'fix', undefined, expectedHead);

  assert.equal(resumed.head, expectedHead);
  assert.equal(await readFile(join(workspace.path, 'remote.txt'), 'utf8'), 'remote\n');
});

test('preserves local commits ahead of the observed MR HEAD', async () => {
  const fixture = await repository();
  const { manager, workspace, head: expectedHead } = await pushedWorkspace(fixture, 'ahead');
  await writeFile(join(workspace.path, 'ahead.txt'), 'ahead\n');
  git(workspace.path, 'add', 'ahead.txt');
  git(workspace.path, 'commit', '-m', 'ahead');
  const localHead = git(workspace.path, 'rev-parse', 'HEAD');

  const resumed = await manager.prepare('ahead', 'fix', undefined, expectedHead);

  assert.equal(resumed.head, localHead);
  assert.equal(await readFile(join(workspace.path, 'ahead.txt'), 'utf8'), 'ahead\n');
});

test('blocks a dirty workspace that is behind without changing its work', async () => {
  const fixture = await repository();
  const { manager, workspace, head: localHead } = await pushedWorkspace(fixture, 'dirty-behind');
  const expectedHead = await advanceRemote(fixture.root, workspace.branch, 'remote-dirty');
  await writeFile(join(workspace.path, 'draft.txt'), 'keep me\n');

  await assert.rejects(
    () => manager.prepare('dirty-behind', 'fix', undefined, expectedHead),
    GitWorkspaceConflictError,
  );
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), localHead);
  assert.equal(await readFile(join(workspace.path, 'draft.txt'), 'utf8'), 'keep me\n');
});

test('blocks diverged history without changing either local commit or files', async () => {
  const fixture = await repository();
  const { manager, workspace } = await pushedWorkspace(fixture, 'diverged');
  const expectedHead = await advanceRemote(fixture.root, workspace.branch, 'remote-diverged');
  await writeFile(join(workspace.path, 'local.txt'), 'local\n');
  git(workspace.path, 'add', 'local.txt');
  git(workspace.path, 'commit', '-m', 'local');
  const localHead = git(workspace.path, 'rev-parse', 'HEAD');

  await assert.rejects(
    () => manager.prepare('diverged', 'fix', undefined, expectedHead),
    GitWorkspaceConflictError,
  );
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), localHead);
  assert.equal(await readFile(join(workspace.path, 'local.txt'), 'utf8'), 'local\n');
});

test('restores a retained branch and fast-forwards it to the observed MR HEAD', async () => {
  const fixture = await repository();
  const { manager, workspace } = await pushedWorkspace(fixture, 'restored');
  await manager.cleanup(workspace, 0, 7 * 24 * 60 * 60 * 1_000);
  const expectedHead = await advanceRemote(fixture.root, workspace.branch, 'remote-restored');

  const restored = await manager.prepare('restored', 'fix', undefined, expectedHead);

  assert.equal(restored.resumed, true);
  assert.equal(restored.head, expectedHead);
  assert.equal(await readFile(join(restored.path, 'remote-restored.txt'), 'utf8'), 'remote-restored\n');
});

test('blocks when the remote branch no longer matches the observed MR HEAD', async () => {
  const fixture = await repository();
  const { manager, workspace, head: expectedHead } = await pushedWorkspace(fixture, 'moved');
  await advanceRemote(fixture.root, workspace.branch, 'remote-moved');

  await assert.rejects(
    () => manager.prepare('moved', 'fix', undefined, expectedHead),
    GitWorkspaceConflictError,
  );
  assert.equal(git(workspace.path, 'rev-parse', 'HEAD'), expectedHead);
  assert.equal(await readFile(join(workspace.path, 'initial.txt'), 'utf8'), 'initial\n');
});

test('does not create a missing local branch when an MR HEAD is expected', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });
  const masterHead = git(fixture.root, '--git-dir', join(fixture.root, 'remote.git'), 'rev-parse', 'master');

  await assert.rejects(
    () => manager.prepare('missing', 'fix', undefined, masterHead),
    GitWorkspaceConflictError,
  );
  assert.throws(() => git(fixture.repo, 'show-ref', '--verify', 'refs/heads/bugfix/faizili_missing'));
});
