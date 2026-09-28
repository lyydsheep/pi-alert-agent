import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { GitWorkspaceManager } from '../src/git.ts';

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

test('creates from remote master, resumes, safely pushes, cleans, and restores', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });

  const workspace = await manager.prepare('task-1');
  assert.equal(workspace.branch, 'fix/faizili_task-1');
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
  assert.ok(git(fixture.repo, 'show-ref', '--verify', 'refs/heads/fix/faizili_task-1'));

  const restored = await manager.prepare('task-1');
  assert.equal(restored.resumed, true);
  assert.equal(restored.head, pushedHead);
});

test('refuses cleanup when committed restoration would lose work', async () => {
  const fixture = await repository();
  const manager = new GitWorkspaceManager({ repositoryPath: fixture.repo, worktreeRoot: fixture.worktrees });
  const workspace = await manager.prepare('dirty');
  await writeFile(join(workspace.path, 'dirty.txt'), 'uncommitted\n');
  await assert.rejects(() => manager.cleanup(workspace, 0, 8 * 24 * 60 * 60 * 1_000), /uncommitted changes/);
});
