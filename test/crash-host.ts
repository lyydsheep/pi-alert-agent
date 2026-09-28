import { access, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Config } from '../src/config.ts';
import { acquireServiceLock } from '../src/lock.ts';
import { PiRunner } from '../src/pi/index.ts';
import { AlertService } from '../src/service.ts';
import { Store } from '../src/store.ts';

const dataDir = process.argv[2];
const capture = join(dataDir, `pi-${process.pid}.json`);
const fixture = fileURLToPath(new URL('./pi-fixture.mjs', import.meta.url));

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

function send(message: unknown): void {
  process.send?.(message);
}

try {
  const release = await acquireServiceLock(dataDir);
  const store = new Store(join(dataDir, 'tasks.sqlite'));
  const workspacePath = join(dataDir, 'worktrees', '1');
  const config: Config = {
    dataDir, repositoryPath: dataDir, host: '127.0.0.1', port: 8080,
    concurrency: 1, waitMs: 30 * 60_000, runTimeoutMs: 60 * 60_000,
    groups: { group: { owners: ['owner'], webhook: 'https://example.test/hook' } },
    bot: { id: 'bot', secret: 'secret' },
    model: { provider: 'fixture', id: 'fixture', apiKey: 'secret', endpoint: 'http://localhost/v1', api: 'openai-responses' },
    delivery: { apiEndpoint: 'https://git.test', token: 'token', project: 'p', requiredChecks: ['build'], agentReviewCheck: 'Agent Review' },
  };
  const service = new AlertService(config, {
    runner: new PiRunner({
      command: process.execPath, args: [fixture, '--capture', capture], agentDir: join(dataDir, 'pi'),
      model: config.model, timeoutMs: config.runTimeoutMs, killGraceMs: 100,
    }),
    git: {
      prepare: async (taskId) => {
        await mkdir(workspacePath, { recursive: true });
        return { taskId, path: workspacePath, branch: `fix/faizili_${taskId}`, head: 'base-head', resumed: true };
      },
      push: async () => ({ head: 'head-1', alreadyPresent: true }),
      head: async () => 'base-head',
      cleanup: async () => false,
    },
    delivery: {
      createOrReadMergeRequest: async () => ({ iid: 1, url: 'https://git.test/mr/1', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' }),
      status: async () => ({ mergeRequest: { iid: 1, url: 'https://git.test/mr/1', state: 'opened', sourceBranch: 'fix/faizili_1', targetBranch: 'master', head: 'head-1' }, currentHead: true, agentReviewPassed: false, checks: {}, ownerRequired: false, complete: false }),
      feedback: async () => [],
    },
    notify: async () => undefined,
  }, store);
  service.engine.recoverRuns();

  const snapshot = async (type: string) => {
    const task = service.engine.listTasks()[0];
    const runtime = task ? store.get<{ workspace: string | null }>('SELECT workspace FROM runtime WHERE task_id=?', task.id) : undefined;
    let sessionId: string | undefined;
    try {
      const args = JSON.parse(await readFile(capture, 'utf8')) as string[];
      sessionId = args[args.indexOf('--session-id') + 1];
    } catch { /* no active Pi yet */ }
    send({ type, pid: process.pid, capture, task: task && { id: task.id, status: task.status, runId: task.runId, fence: task.runFence },
      workspacePath: runtime?.workspace ? (JSON.parse(runtime.workspace) as { path: string }).path : undefined, sessionId });
  };

  await snapshot('boot');
  process.on('message', (value: unknown) => void (async () => {
    const command = (value as { type?: string })?.type;
    if (command === 'start') {
      if (!service.engine.listTasks().length) {
        await service.receive({ messageId: 'alert-1', groupId: 'group', senderId: 'bot', text: '[告警:test:hard-crash] [hang]', quote: '' });
      }
      await service.pump();
      await waitFor(capture);
      await snapshot('running');
    } else if (command === 'stop') {
      await service.shutdown();
      store.close();
      await release();
      send({ type: 'stopped' });
      process.disconnect?.();
    }
  })().catch((error) => send({ type: 'error', error: error instanceof Error ? error.stack : String(error) })));
} catch (error) {
  send({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  setTimeout(() => process.exit(1), 10);
}
