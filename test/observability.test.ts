import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { createObserver } from '../src/observability.ts';
import { createPhoenixGateway } from '../src/phoenix-gateway.ts';

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

async function requestBody(request: IncomingMessage): Promise<string> {
  let value = '';
  for await (const chunk of request) value += chunk;
  return value;
}

async function requestBytes(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

type WireValue = bigint | Buffer;
function wireFields(bytes: Buffer): Map<number, WireValue[]> {
  const result = new Map<number, WireValue[]>();
  let offset = 0;
  const readVarint = () => {
    let value = 0n;
    let shift = 0n;
    while (offset < bytes.length) {
      const byte = bytes[offset++]!;
      value |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return value;
      shift += 7n;
    }
    throw new Error('truncated protobuf varint');
  };
  while (offset < bytes.length) {
    const tag = readVarint();
    const number = Number(tag >> 3n);
    const wire = Number(tag & 7n);
    let value: WireValue;
    if (wire === 0) value = readVarint();
    else if (wire === 1) { value = bytes.subarray(offset, offset += 8); }
    else if (wire === 2) { const length = Number(readVarint()); value = bytes.subarray(offset, offset += length); }
    else throw new Error(`unsupported protobuf wire type ${wire}`);
    const values = result.get(number) ?? [];
    values.push(value);
    result.set(number, values);
  }
  return result;
}

const buffers = (fields: Map<number, WireValue[]>, number: number) => (fields.get(number) ?? []) as Buffer[];
const firstBuffer = (fields: Map<number, WireValue[]>, number: number) => buffers(fields, number)[0];
function decodeAttribute(bytes: Buffer) {
  const fields = wireFields(bytes);
  const value = wireFields(firstBuffer(fields, 2)!);
  return {
    key: firstBuffer(fields, 1)!.toString(),
    value: firstBuffer(value, 1) ? { stringValue: firstBuffer(value, 1)!.toString() } : { intValue: String(value.get(3)?.[0] ?? 0n) },
  };
}

function decodeSpan(bytes: Buffer): Record<string, unknown> {
  const fields = wireFields(bytes);
  const decodeEvent = (eventBytes: Buffer) => {
    const event = wireFields(eventBytes);
    return { attributes: buffers(event, 3).map(decodeAttribute) };
  };
  const status = wireFields(firstBuffer(fields, 15)!);
  return {
    traceId: firstBuffer(fields, 1)!.toString('hex'),
    spanId: firstBuffer(fields, 2)!.toString('hex'),
    parentSpanId: firstBuffer(fields, 4)?.toString('hex'),
    name: firstBuffer(fields, 5)!.toString(),
    startTimeUnixNano: String(firstBuffer(fields, 7)!.readBigUInt64LE()),
    endTimeUnixNano: String(firstBuffer(fields, 8)!.readBigUInt64LE()),
    attributes: buffers(fields, 9).map(decodeAttribute),
    events: buffers(fields, 11).map(decodeEvent),
    status: { code: Number(status.get(3)?.[0]), ...(firstBuffer(status, 2) ? { message: firstBuffer(status, 2)!.toString() } : {}) },
  };
}

function decodeSpans(bytes: Buffer): Record<string, unknown>[] {
  const request = wireFields(bytes);
  return buffers(request, 1).flatMap((resourceSpans) => {
    const resource = wireFields(resourceSpans);
    return buffers(resource, 2).flatMap((scopeSpans) => buffers(wireFields(scopeSpans), 2).map(decodeSpan));
  });
}

function attributes(span: Record<string, unknown>) {
  return Object.fromEntries((span.attributes as { key: string; value: { stringValue?: string; intValue?: string } }[]).map(({ key, value }) => [key, value.stringValue ?? value.intValue]));
}

function rawEvents(spans: Record<string, unknown>[]): Record<string, unknown>[] {
  const complete: Record<string, unknown>[] = [];
  const fragments = new Map<string, { count: number; parts: Buffer[] }>();
  for (const span of spans) for (const event of span.events as Record<string, unknown>[]) {
    const attrs = attributes(event);
    if (attrs['pi.event.encoding'] === 'base64-json') {
      const id = attrs['pi.event.id']!;
      const value = fragments.get(id) ?? { count: Number(attrs['pi.event.fragments']), parts: [] };
      value.parts[Number(attrs['pi.event.fragment'])] = Buffer.from(attrs['pi.event']!, 'base64');
      fragments.set(id, value);
    } else complete.push(JSON.parse(attrs['pi.event']!));
  }
  for (const value of fragments.values()) {
    assert.equal(value.parts.filter(Boolean).length, value.count);
    complete.push(JSON.parse(Buffer.concat(value.parts).toString()));
  }
  return complete;
}

test('exports complete Pi events as correlated OTLP/OpenInference spans without blocking callers', async () => {
  const requests: { authorization?: string; contentType?: string; spans: Record<string, unknown>[] }[] = [];
  const collector = await listen(async (request, response) => {
    requests.push({
      authorization: request.headers.authorization,
      contentType: request.headers['content-type'],
      spans: decodeSpans(await requestBytes(request)),
    });
    response.writeHead(200).end('{}');
  });

  const spoolDir = mkdtempSync(join(tmpdir(), 'phoenix-spool-'));
  try {
    const observer = createObserver({ endpoint: `${collector.url}/v1/traces`, apiKey: 'collector-key', spoolDir });
    const large = 'x'.repeat(20_000);
    const providerPayload = { system: 'full system prompt', messages: [{ role: 'user', content: large }], tools: [{ name: 'query_logs' }] };
    observer.event('task-1', 'run-1', { type: 'session', id: 'session-1' });
    observer.event('task-1', 'run-1', { type: 'agent_start' });
    observer.event('task-1', 'run-1', { type: 'pi_provider_request', provider: 'test-provider', model: 'test-model', payload: providerPayload });
    observer.event('task-1', 'run-1', { type: 'message_start', message: { role: 'assistant', content: [] } });
    observer.event('task-1', 'run-1', { type: 'message_update', usage: { input: 999, output: 999 }, delta: 'partial' });
    observer.event('task-1', 'run-1', { type: 'message_end', message: { role: 'assistant', provider: 'test-provider', model: 'test-model', usage: { input: 4, output: 2 }, content: large } });
    observer.event('task-1', 'run-1', { type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'query_logs', args: { query: large } });
    observer.event('task-1', 'run-1', { type: 'tool_execution_update', toolCallId: 'call-1', partialResult: 'partial' });
    observer.event('task-1', 'run-1', { type: 'tool_execution_end', toolCallId: 'call-1', result: { text: 'failed', details: {fullOutput: large.repeat(10)} }, isError: true });
    observer.event('task-1', 'run-1', { type: 'agent_settled' });
    observer.event('task-1', 'run-1', { type: 'run_end' });
    observer.event('task-2', 'run-2', { type: 'agent_start' });
    observer.event('task-2', 'run-2', { type: 'run_end', cancelled: true });
    await observer.close();

    assert.ok(requests.length >= 1);
    assert.ok(requests.every((request) => request.authorization === 'Bearer collector-key'));
    assert.ok(requests.every((request) => request.contentType === 'application/x-protobuf'));
    const spans = requests.flatMap((request) => request.spans);
    assert.equal(spans.filter((span) => ['pi.run', 'pi.llm', 'pi.tool.query_logs'].includes(span.name as string)).length, 4);
    assert.equal(new Set(spans.map((span) => span.traceId)).size, 2);
    assert.equal(rawEvents(spans).length, 12, 'every source event is retained once; duplicate terminal signal is ignored');

    const llm = attributes(spans.find((span) => span.name === 'pi.llm')!);
    assert.equal(llm['session.id'], 'session-1');
    assert.equal(llm['llm.token_count.prompt'], '4');
    assert.equal(llm['llm.token_count.completion'], '2');
    assert.equal(llm['llm.system'], 'test-provider');
    assert.deepEqual(JSON.parse(llm['input.value']!), providerPayload);
    const finalMessage = rawEvents(spans).find((event) => event.type === 'message_end') as { message: { content: string } };
    assert.equal(finalMessage.message.content.length, large.length);
    assert.ok(BigInt(spans.find((span) => span.name === 'pi.llm')!.endTimeUnixNano as string) > BigInt(spans.find((span) => span.name === 'pi.llm')!.startTimeUnixNano as string));
    const tool = attributes(spans.find((span) => span.name === 'pi.tool.query_logs')!);
    assert.equal((JSON.parse(tool['input.value']!) as { query: string }).query.length, large.length);
    assert.ok(JSON.parse(tool['output.value']!).details.fullOutput===large.repeat(10),'full bash output survives OTLP encoding');
    assert.deepEqual(spans.find((span) => span.name === 'pi.tool.query_logs')?.status, { code: 2, message: 'tool execution failed' });
    assert.deepEqual(spans.find((span) => span.name === 'pi.run' && (span.status as { code: number }).code === 2)?.status, { code: 2, message: 'cancelled' });
  } finally {
    collector.server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
});

test('public gateway injects only its Viewer key and permits only explicit reads', async () => {
  const seen: { path: string; method?: string; authorization?: string; cookie?: string; body: string }[] = [];
  const upstream = await listen(async (request, response) => {
    const value = { path: request.url!, method: request.method, authorization: request.headers.authorization, cookie: request.headers.cookie, body: await requestBody(request) };
    seen.push(value);
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(value));
  });
  const gateway = await listen(createPhoenixGateway({ upstream: upstream.url, viewerKey: 'viewer-only' }));

  try {
    const read = await fetch(`${gateway.url}/v1/projects`, { headers: { authorization: 'Bearer attacker', cookie: 'session=attacker' } });
    assert.equal(read.status, 200);
    assert.deepEqual(await read.json(), { path: '/v1/projects', method: 'GET', authorization: 'Bearer viewer-only', body: '' });
    assert.equal((await fetch(`${gateway.url}/assets/app.js`)).status, 200);

    const query = await fetch(`${gateway.url}/graphql`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'query Read { project(name: "mutation is text") { id } }' }),
    });
    assert.equal(query.status, 200);
    assert.match((await query.json() as { body: string }).body, /query Read/);

    for (const [path, init] of [
      ['/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'mutation Write { deleteProject(id: "1") { id } }' }) }],
      ['/v1/traces', { method: 'POST', body: '{}' }],
      ['/v1/users', {}],
      ['/auth/login', {}],
      ['/settings', {}],
    ] as const) {
      assert.equal((await fetch(`${gateway.url}${path}`, init)).status, 403, path);
    }
    assert.equal(seen.length, 3, 'denied operations never reach Phoenix');
  } finally {
    gateway.server.close();
    upstream.server.close();
  }
});

test('signed token attributes encode without hanging the exporter',async()=>{
  const bodies:Buffer[]=[];
  const collector=await listen(async(request,response)=>{bodies.push(await requestBytes(request));response.end();});
  const spoolDir=mkdtempSync(join(tmpdir(),'phoenix-spool-'));
  try{
    const observer=createObserver({endpoint:collector.url,spoolDir});
    observer.event('signed','run',{type:'message_start',message:{role:'assistant'}});
    observer.event('signed','run',{type:'message_end',message:{role:'assistant',usage:{input:-1,output:2},content:'synthetic signed value'}});
    observer.event('signed','run',{type:'run_end'});
    await observer.close();
    const attrs=decodeSpans(Buffer.concat(bodies)).flatMap(s=>s.attributes as Array<{key:string;value:{intValue?:string}}>);
    assert.equal(attrs.find(a=>a.key==='llm.token_count.prompt')?.value.intValue,String(BigInt.asUintN(64,-1n)));
  }finally{collector.server.close();rmSync(spoolDir,{recursive:true,force:true});}
});

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) return;
    await delay(20);
  }
  assert.ok(condition(), 'collector/spool did not reach expected state');
}

test('503 retains over 512 events on disk and startup replays the exact spans in bounded batches', async (t) => {
  const spoolDir = mkdtempSync(join(tmpdir(), 'phoenix-replay-'));
  let available = false;
  let attempts = 0;
  const accepted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  t.mock.method(process.stderr, 'write', (value: unknown) => { errors.push(String(value)); return true; });
  const collector = await listen(async (request, response) => {
    const body = await requestBytes(request);
    attempts++;
    const spans = decodeSpans(body);
    assert.ok(body.length <= 64 * 1024);
    assert.ok(spans.length <= 50);
    if (available) accepted.push(...spans);
    response.writeHead(available ? 200 : 503).end();
  });
  let observer = createObserver({ endpoint: collector.url, spoolDir, retryMs: 20, maxBatchBytes: 64 * 1024 });
  try {
    const events = Array.from({ length: 600 }, (_, sequence) => ({ type: 'progress', sequence, data: `exact-${sequence}-汉字` }));
    for (const event of events) observer.event('replay-task', 'replay-run', event);
    observer.event('replay-task', 'replay-run', { type: 'run_end' });
    await observer.close();
    const files = readdirSync(spoolDir);
    assert.ok(files.length > 512);
    assert.ok(files.every((file) => file.endsWith('.span')), 'atomic writes leave no temporary files');
    const persisted = files.map((file) => decodeSpan(readFileSync(join(spoolDir, file))));
    const attemptsAtClose = attempts;
    await delay(60);
    assert.equal(attempts, attemptsAtClose, 'close clears idle retry timer');
    assert.ok(errors.some((error) => error.includes('503') && error.includes('retained')));
    available = true;
    observer = createObserver({ endpoint: collector.url, spoolDir, retryMs: 20, maxBatchBytes: 64 * 1024 });
    await until(() => readdirSync(spoolDir).length === 0);
    const sort = (spans: Record<string, unknown>[]) => spans.sort((a, b) => String(a.spanId).localeCompare(String(b.spanId)));
    assert.deepEqual(sort(accepted), sort(persisted), 'restart sends exact completed span bytes and IDs');
    const recovered = rawEvents(accepted).filter((event) => event.type === 'progress').sort((a, b) => Number(a.sequence) - Number(b.sequence));
    assert.deepEqual(recovered, events);
  } finally {
    await observer.close();
    collector.server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
});

test('idle retry recovers full ordered tool output while its parent run remains open', async (t) => {
  const spoolDir = mkdtempSync(join(tmpdir(), 'phoenix-idle-'));
  let available = false;
  let attempts = 0;
  const accepted: Record<string, unknown>[] = [];
  t.mock.method(process.stderr, 'write', () => true);
  const collector = await listen(async (request, response) => {
    const spans = decodeSpans(await requestBytes(request));
    attempts++;
    if (available) accepted.push(...spans);
    response.writeHead(available ? 200 : 503).end();
  });
  const observer = createObserver({ endpoint: collector.url, spoolDir, retryMs: 20, maxActiveBytes: 512 });
  try {
    observer.event('idle-task', 'idle-run', { type: 'tool_execution_start', toolCallId: 'bash-1', toolName: 'bash', args: { command: 'synthetic' } });
    const data = '汉字\\n"'.repeat(3000);
    const chunks = Array.from({ length: 10 }, (_, sequence) => ({ type: 'pi_tool_output', toolCallId: 'bash-1', toolName: 'bash', sequence, data }));
    for (const chunk of chunks) observer.event('idle-task', 'idle-run', chunk);
    const result = { text: 'model view', details: { fullOutputPath: '/task/output.txt', fullOutputBytes: Buffer.byteLength(data) * chunks.length, fullOutputSha256: 'synthetic-sha256' } };
    observer.event('idle-task', 'idle-run', { type: 'tool_execution_end', toolCallId: 'bash-1', result });
    const late = { ...chunks[0]!, sequence: chunks.length, data: 'late final pipe chunk' };
    chunks.push(late);
    observer.event('idle-task', 'idle-run', late);
    const unknown = { type: 'pi_tool_output', toolCallId: 'unmatched', toolName: 'bash', sequence: 0, data: 'unmatched pipe chunk' };
    observer.event('idle-task', 'idle-run', unknown);
    await until(() => attempts > 0);
    assert.ok(readdirSync(spoolDir).length > 0);
    available = true;
    await until(() => readdirSync(spoolDir).length === 0);
    const output = rawEvents(accepted).filter((event) => event.type === 'pi_tool_output' && event.toolCallId === 'bash-1').sort((a, b) => Number(a.sequence) - Number(b.sequence));
    assert.deepEqual(output, chunks);
    const tool = accepted.find((span) => span.name === 'pi.tool.bash')!;
    assert.ok(tool);
    assert.ok(accepted.filter((span) => span.name === 'pi.tool.output' && attributes(span)['tool.call_id'] === 'bash-1').every((span) => span.parentSpanId === tool.spanId));
    assert.deepEqual(rawEvents(accepted).find((event) => event.toolCallId === 'unmatched'), unknown);
    assert.equal(attributes(accepted.find((span) => attributes(span)['tool.call_id'] === 'unmatched')!)['pi.output.parent_missing'], 'true');
    assert.deepEqual(JSON.parse(attributes(tool)['output.value']!), result);
    assert.equal(accepted.some((span) => span.name === 'pi.run'), false, 'raw events export before a long run ends');
    observer.event('idle-task', 'idle-run', { type: 'run_end' });
    const afterRun = { ...unknown, sequence: 1, data: 'final chunk after terminal event' };
    observer.event('idle-task', 'idle-run', afterRun);
    await until(() => readdirSync(spoolDir).length === 0);
    assert.deepEqual(rawEvents(accepted).find((event) => event.data === afterRun.data), afterRun);
    const root = accepted.find((span) => span.name === 'pi.run')!;
    const fallback = accepted.find((span) => attributes(span)['tool.call_id'] === 'unmatched' && attributes(span)['pi.output.sequence'] === '1')!;
    assert.equal(fallback.parentSpanId, root.spanId);
  } finally {
    await observer.close();
    collector.server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
});

test('spool quota and storage failures are explicit and never escape event()', async (t) => {
  const errors: string[] = [];
  t.mock.method(process.stderr, 'write', (value: unknown) => { errors.push(String(value)); return true; });
  const collector = await listen((_request, response) => response.writeHead(503).end());
  const spoolDir = mkdtempSync(join(tmpdir(), 'phoenix-quota-'));
  let observer = createObserver({ endpoint: collector.url, spoolDir, maxSpoolBytes: 1 });
  try {
    assert.doesNotThrow(() => observer.event('quota', 'run', { type: 'progress', data: 'retained-or-explicit-error' }));
    assert.ok(errors.some((error) => error.includes('spool quota exceeded') && error.includes('not persisted')));
    await observer.close();
    observer = createObserver({ endpoint: collector.url, spoolDir });
    await delay(0);
    rmSync(spoolDir, { recursive: true });
    writeFileSync(spoolDir, 'storage unavailable');
    assert.doesNotThrow(() => observer.event('storage', 'run', { type: 'progress' }));
    assert.ok(errors.some((error) => error.includes('could not persist') && error.includes('ENOTDIR')));
  } finally {
    await observer.close();
    collector.server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
});

test('terminal cleanup survives full quota and ignores late non-output events after recovery', async (t) => {
  const spoolDir = mkdtempSync(join(tmpdir(), 'phoenix-terminal-'));
  let available = false;
  const accepted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  t.mock.method(process.stderr, 'write', (value: unknown) => { errors.push(String(value)); return true; });
  const collector = await listen(async (request, response) => {
    const spans = decodeSpans(await requestBytes(request));
    if (available) accepted.push(...spans);
    response.writeHead(available ? 200 : 503).end();
  });
  const observer = createObserver({ endpoint: collector.url, spoolDir, retryMs: 20, maxSpoolBytes: 2000 });
  try {
    observer.event('finished', 'run', { type: 'message_start', message: { role: 'assistant' } });
    observer.event('finished', 'run', { type: 'tool_execution_start', toolCallId: 'tool-1', toolName: 'bash' });
    observer.event('finished', 'run', { type: 'tool_execution_start', toolCallId: 'tool-2', toolName: 'bash' });
    for (let sequence = 0; sequence < 10; sequence++) observer.event('finished', 'run', { type: 'progress', sequence });
    observer.event('finished', 'run', { type: 'run_end', data: 'x'.repeat(10_000) });
    assert.ok(errors.some((error) => error.includes('/run/run_end') && error.includes('quota exceeded')));
    assert.ok(errors.some((error) => error.includes('closing message')));
    assert.equal(errors.filter((error) => error.includes('closing tool')).length, 2, 'all remaining tools get a persistence attempt');
    assert.ok(errors.some((error) => error.includes('closing run')));
    available = true;
    await until(() => readdirSync(spoolDir).length === 0);
    for (const type of ['progress', 'message_end', 'tool_execution_end', 'run_end']) {
      observer.event('finished', 'run', { type, toolCallId: 'tool-1', data: 'must remain ignored', message: { role: 'assistant' } });
    }
    observer.event('healthy', 'run', { type: 'progress', data: 'recovered' });
    await observer.close();
    const events = rawEvents(accepted);
    assert.ok(events.some((event) => event.data === 'recovered'));
    assert.equal(events.some((event) => event.data === 'must remain ignored'), false, 'finished run cannot resurrect after disk recovery');
  } finally {
    await observer.close();
    collector.server.close();
    rmSync(spoolDir, { recursive: true, force: true });
  }
});
