import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const host = fileURLToPath(new URL('./crash-host.ts', import.meta.url));

type HostMessage = {
  type: string;
  error?: string;
  pid?: number;
  capture?: string;
  task?: { id: number; status: string; runId: string | null; fence: number };
  workspacePath?: string;
  sessionId?: string;
};

function startHost(dataDir: string): ChildProcess {
  return spawn(process.execPath, [host, dataDir], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
}

async function next(child: ChildProcess, type: string, timeoutMs = 9_000): Promise<HostMessage> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for host ${type}`)), timeoutMs);
    const onMessage = (value: unknown) => {
      const message = value as HostMessage;
      if (message.type === 'error') { cleanup(); reject(new Error(message.error)); }
      else if (message.type === type) { cleanup(); resolve(message); }
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => { cleanup(); reject(new Error(`Host exited before ${type}: ${code ?? signal}`)); };
    const cleanup = () => { clearTimeout(timeout); child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage); child.on('exit', onExit);
  });
}

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 300; attempt++) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

test('hard crash releases the writer and recovers the same durable Pi task', { timeout: 20_000 }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'pi-alert-crash-'));
  const children = new Set<ChildProcess>();
  const launch = () => { const child = startHost(dataDir); children.add(child); child.once('exit', () => children.delete(child)); return child; };
  try {
    const first = launch();
    await next(first, 'boot');
    first.send({ type: 'start' });
    const before = await next(first, 'running');
    assert.equal(before.task?.status, 'running');
    assert.equal(before.task?.id, 1);
    assert.ok(before.task.runId);
    assert.ok(before.sessionId);
    assert.ok(before.workspacePath);

    const contender = launch();
    const contenderExit = once(contender, 'exit');
    const rejected = await next(contender, 'error', 2_000).catch((error: Error) => ({ type: 'error', error: error.message }));
    assert.match(rejected.error ?? '', /Another service process is active/);
    await contenderExit;

    const firstExit = once(first, 'exit');
    first.kill('SIGKILL');
    await firstExit;
    await waitFor(`${before.capture}.terminated`);

    const second = launch();
    const recovered = await next(second, 'boot');
    assert.equal(recovered.task?.id, before.task.id);
    assert.equal(recovered.task?.status, 'queued');
    assert.equal(recovered.task?.runId, null);
    assert.ok(recovered.task!.fence > before.task.fence);
    assert.equal(recovered.workspacePath, before.workspacePath);

    second.send({ type: 'start' });
    const after = await next(second, 'running');
    assert.equal(after.task?.id, before.task.id);
    assert.equal(after.task?.status, 'running');
    assert.notEqual(after.task?.runId, before.task.runId);
    assert.ok(after.task!.fence > before.task.fence);
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.workspacePath, before.workspacePath);

    const secondExit = once(second, 'exit');
    second.send({ type: 'stop' });
    await next(second, 'stopped', 3_000);
    await secondExit;
  } finally {
    for (const child of children) child.kill('SIGKILL');
    await Promise.allSettled([...children].map((child) => once(child, 'exit')));
    await rm(dataDir, { recursive: true, force: true });
  }
});
