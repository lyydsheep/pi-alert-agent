import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';

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

  try {
    const observer = createObserver({ endpoint: `${collector.url}/v1/traces`, apiKey: 'collector-key' });
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
    assert.equal(spans.length, 4);
    assert.equal(new Set(spans.map((span) => span.traceId)).size, 2);
    assert.equal(spans.reduce((count, span) => count + (span.events as unknown[]).length, 0), 12, 'every source event is retained once; duplicate terminal signal is ignored');

    const attributes = (span: Record<string, unknown>) => Object.fromEntries(
      (span.attributes as { key: string; value: { stringValue?: string; intValue?: string } }[])
        .map(({ key, value }) => [key, value.stringValue ?? value.intValue]),
    );
    const llm = attributes(spans.find((span) => span.name === 'pi.llm')!);
    assert.equal(llm['session.id'], 'session-1');
    assert.equal(llm['llm.token_count.prompt'], '4');
    assert.equal(llm['llm.token_count.completion'], '2');
    assert.equal(llm['llm.system'], 'test-provider');
    assert.deepEqual(JSON.parse(llm['input.value']!), providerPayload);
    const llmEvents = spans.find((span) => span.name === 'pi.llm')!.events as { attributes: { key: string; value: { stringValue: string } }[] }[];
    const finalMessage = JSON.parse(llmEvents.at(-1)!.attributes[0].value.stringValue) as { message: { content: string } };
    assert.equal(finalMessage.message.content.length, large.length);
    assert.ok(BigInt(spans.find((span) => span.name === 'pi.llm')!.endTimeUnixNano as string) > BigInt(spans.find((span) => span.name === 'pi.llm')!.startTimeUnixNano as string));
    const tool = attributes(spans.find((span) => span.name === 'pi.tool.query_logs')!);
    assert.equal((JSON.parse(tool['input.value']!) as { query: string }).query.length, large.length);
    assert.ok(JSON.parse(tool['output.value']!).details.fullOutput===large.repeat(10),'full bash output survives OTLP encoding');
    assert.deepEqual(spans.find((span) => span.name === 'pi.tool.query_logs')?.status, { code: 2, message: 'tool execution failed' });
    assert.deepEqual(spans.find((span) => span.name === 'pi.run' && (span.status as { code: number }).code === 2)?.status, { code: 2, message: 'cancelled' });
  } finally {
    collector.server.close();
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
  try{
    const observer=createObserver({endpoint:collector.url});
    observer.event('signed','run',{type:'message_start',message:{role:'assistant'}});
    observer.event('signed','run',{type:'message_end',message:{role:'assistant',usage:{input:-1,output:2},content:'synthetic signed value'}});
    observer.event('signed','run',{type:'run_end'});
    await observer.close();
    const attrs=decodeSpans(Buffer.concat(bodies)).flatMap(s=>s.attributes as Array<{key:string;value:{intValue?:string}}>);
    assert.equal(attrs.find(a=>a.key==='llm.token_count.prompt')?.value.intValue,String(BigInt.asUintN(64,-1n)));
  }finally{collector.server.close();}
});
