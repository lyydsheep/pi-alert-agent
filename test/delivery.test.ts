import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

import { GitLabDeliveryClient } from '../src/delivery.ts';

async function jsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body);
}

function send(response: ServerResponse, value: unknown): void {
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

test('recovers the same MR after a lost create response and binds completion to current HEAD', async () => {
  const mergeRequests: Record<string, unknown>[] = [];
  let loseCreateResponse = true;
  let conflict = false;
  let draft = false;
  let statuses: Record<string, unknown>[] = [{ id: 1, name: 'build', status: 'success' }];
  const notes = [
    { id: 1, body: 'looks good', system: false, resolvable: false },
    { id: 2, body: '[change-request] handle the nil case', system: false, resolvable: false },
    { id: 3, body: 'changed title', system: true, resolvable: false },
  ];

  const server = createServer(async (request, response) => {
    assert.equal(request.headers['private-token'], 'secret');
    const url = new URL(request.url!, 'http://localhost');
    if (request.method === 'GET' && url.pathname.endsWith('/merge_requests')) {
      return send(response, mergeRequests.filter((mr) => mr.source_branch === url.searchParams.get('source_branch')));
    }
    if (request.method === 'POST' && url.pathname.endsWith('/merge_requests')) {
      const body = await jsonBody(request);
      mergeRequests.push({ iid: 7, web_url: 'https://git.example/mr/7', state: 'opened', sha: 'head-1', ...body });
      if (loseCreateResponse) {
        loseCreateResponse = false;
        request.socket.destroy();
        return;
      }
    }
    if (request.method === 'GET' && url.pathname.endsWith('/merge_requests/7')) {
      return send(response, { ...mergeRequests[0], draft, has_conflicts: conflict, detailed_merge_status: conflict ? 'conflict' : draft ? 'draft_status' : 'mergeable' });
    }
    if (request.method === 'GET' && url.pathname.includes('/repository/commits/head-1/statuses')) return send(response, statuses);
    if (request.method === 'GET' && url.pathname.endsWith('/merge_requests/7/notes')) return send(response, notes);
    response.statusCode = 404;
    send(response, { error: 'not found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const client = new GitLabDeliveryClient({
      apiEndpoint: `http://127.0.0.1:${address.port}/api/v4`,
      token: 'secret',
      project: 'group/project',
      requiredChecks: ['build'],
      agentReviewCheck: 'Agent Review',
    });

    const mr = await client.createOrReadMergeRequest({ sourceBranch: 'fix/faizili_task-1', title: 'Fix', description: 'Body' });
    assert.equal(mr.iid, 7);
    assert.equal(mergeRequests.length, 1);
    assert.equal(mergeRequests[0].title, 'Draft: Fix');

    assert.equal((await client.status(7, 'head-1')).complete, false, 'missing Agent review fails closed');
    statuses = [...statuses, { id: 2, name: 'Agent Review', status: 'success' }];
    assert.equal((await client.status(7, 'old-head')).complete, false, 'old HEAD cannot complete');
    assert.equal((await client.status(7, 'head-1')).complete, true);
    draft=true;
    const waitingOwner=await client.status(7,'head-1');
    assert.equal(waitingOwner.complete,false);
    assert.equal(waitingOwner.ownerRequired,true);
    assert.match(waitingOwner.ownerAction!,/Draft/);
    draft=false;
    conflict = true;
    const conflicted = await client.status(7, 'head-1');
    assert.equal(conflicted.ownerRequired, true);
    assert.equal(conflicted.complete, false);

    assert.deepEqual((await client.feedback(7)).map((note) => note.classification), ['comment', 'change-request', 'system']);

    mergeRequests[0].state = 'closed';
    assert.equal((await client.createOrReadMergeRequest({ sourceBranch: 'fix/faizili_task-1', title: 'Retry', description: 'Retry' })).state, 'closed');
    assert.equal(mergeRequests.length, 1, 'a closed MR is retained instead of replaced');
  } finally {
    server.close();
  }
});

test('rejects delivery configuration without required checks or explicit Agent review', () => {
  assert.throws(() => new GitLabDeliveryClient({ apiEndpoint: 'http://x', token: 'x', project: 1, requiredChecks: [], agentReviewCheck: 'Agent Review' }));
  assert.throws(() => new GitLabDeliveryClient({ apiEndpoint: 'http://x', token: 'x', project: 1, requiredChecks: ['build'], agentReviewCheck: '' }));
});
