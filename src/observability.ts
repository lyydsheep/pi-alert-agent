import { createHash, randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, opendirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface Observer {
  event(taskId: string, runId: string, event: unknown): void;
  close(): Promise<void>;
}

type Attribute = { key: string; value: { stringValue?: string; intValue?: string } };
type SpanEvent = { timeUnixNano: string; name: string; attributes: Attribute[] };
type Span = Record<string, unknown>;
type OpenSpan = { spanId: string; name: string; kind: 'AGENT' | 'LLM' | 'TOOL' | 'CHAIN'; start: string; attributes: Attribute[]; events: SpanEvent[]; failed?: string };
type Run = { taskId: string; runId: string; traceId: string; sessionId: string; root: OpenSpan; pendingMessage?: OpenSpan; message?: OpenSpan; tools: Map<string, OpenSpan>; toolParents: Map<string, string> };

const MAX_ACTIVE_BYTES = 512 * 1024;
const MAX_BATCH_BYTES = 1024 * 1024;
const MAX_SPOOL_BYTES = 1024 * 1024 * 1024;
const RAW_CHUNK_BYTES = 32 * 1024;
const BATCH_SIZE = 50;
const TIMEOUT_MS = 5_000;
const EPOCH_OFFSET = BigInt(Date.now()) * 1_000_000n - process.hrtime.bigint();

function attribute(key: string, value: string | number): Attribute {
  return typeof value === 'number' ? { key, value: { intValue: String(Math.trunc(value)) } } : { key, value: { stringValue: value } };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function numeric(source: Record<string, unknown> | undefined, names: string[]): number | undefined {
  for (const name of names) {
    const value = source?.[name];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function nanos(): string { return String(EPOCH_OFFSET + process.hrtime.bigint()); }
function traceId(taskId: string, runId: string): string { return createHash('sha256').update(`${taskId}\0${runId}`).digest('hex').slice(0, 32); }

function open(name: string, kind: OpenSpan['kind'], attributes: Attribute[] = []): OpenSpan {
  return { spanId: randomBytes(8).toString('hex'), name, kind, start: nanos(), attributes, events: [] };
}

function rawEvent(serialized: string): SpanEvent {
  return { timeUnixNano: nanos(), name: 'pi.raw', attributes: [attribute('pi.event', serialized)] };
}

function finish(run: Run, value: OpenSpan, parentSpanId?: string): Span {
  return {
    traceId: run.traceId, spanId: value.spanId, ...(parentSpanId ? { parentSpanId } : {}), name: value.name, kind: 1,
    startTimeUnixNano: value.start, endTimeUnixNano: nanos(),
    attributes: [attribute('task.id', run.taskId), attribute('run.id', run.runId), attribute('session.id', run.sessionId), attribute('openinference.span.kind', value.kind), ...value.attributes],
    events: value.events,
    status: value.failed ? { code: 2, message: value.failed } : { code: 1 },
  };
}

function varint(value: bigint): Buffer {
  value = BigInt.asUintN(64, value);
  const bytes: number[] = [];
  do {
    const next = Number(value & 0x7fn);
    value >>= 7n;
    bytes.push(value ? next | 0x80 : next);
  } while (value);
  return Buffer.from(bytes);
}

function fieldTag(number: number, wireType: number): Buffer { return varint(BigInt(number * 8 + wireType)); }
function bytesField(number: number, value: Uint8Array): Buffer { return Buffer.concat([fieldTag(number, 2), varint(BigInt(value.length)), value]); }
function stringField(number: number, value: string): Buffer { return bytesField(number, Buffer.from(value)); }
function messageField(number: number, value: Buffer): Buffer { return bytesField(number, value); }
function enumField(number: number, value: number): Buffer { return Buffer.concat([fieldTag(number, 0), varint(BigInt(value))]); }
function fixed64Field(number: number, value: string): Buffer {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64LE(BigInt(value));
  return Buffer.concat([fieldTag(number, 1), bytes]);
}

function encodeAttribute(item: Attribute): Buffer {
  const value = item.value.stringValue !== undefined
    ? stringField(1, item.value.stringValue)
    : Buffer.concat([fieldTag(3, 0), varint(BigInt(item.value.intValue ?? '0'))]);
  return Buffer.concat([stringField(1, item.key), messageField(2, value)]);
}

function encodeEvent(event: SpanEvent): Buffer {
  return Buffer.concat([
    fixed64Field(1, event.timeUnixNano), stringField(2, event.name),
    ...event.attributes.map((item) => messageField(3, encodeAttribute(item))),
  ]);
}

function encodeSpan(span: Span): Buffer {
  const status = span.status as { code: number; message?: string };
  const statusBytes = Buffer.concat([
    ...(status.message ? [stringField(2, status.message)] : []),
    enumField(3, status.code),
  ]);
  return Buffer.concat([
    bytesField(1, Buffer.from(span.traceId as string, 'hex')),
    bytesField(2, Buffer.from(span.spanId as string, 'hex')),
    ...(span.parentSpanId ? [bytesField(4, Buffer.from(span.parentSpanId as string, 'hex'))] : []),
    stringField(5, span.name as string), enumField(6, span.kind as number),
    fixed64Field(7, span.startTimeUnixNano as string), fixed64Field(8, span.endTimeUnixNano as string),
    ...(span.attributes as Attribute[]).map((item) => messageField(9, encodeAttribute(item))),
    ...(span.events as SpanEvent[]).map((event) => messageField(11, encodeEvent(event))),
    messageField(15, statusBytes),
  ]);
}

function encodeExportRequest(spans: Buffer[]): Buffer {
  const resource = messageField(1, encodeAttribute(attribute('service.name', 'pi-alert-agent')));
  const scope = Buffer.concat([stringField(1, 'pi-alert-agent'), stringField(2, '1')]);
  const scopeSpans = Buffer.concat([messageField(1, scope), ...spans.map((span) => messageField(2, span))]);
  return messageField(1, Buffer.concat([messageField(1, resource), messageField(2, scopeSpans)]));
}

export function createObserver(options: { endpoint: string; apiKey?: string; spoolDir: string; retryMs?: number; maxSpoolBytes?: number; maxBatchBytes?: number; maxActiveBytes?: number }): Observer {
  const endpoint = new URL(options.endpoint).toString();
  const maxBatchBytes = options.maxBatchBytes ?? MAX_BATCH_BYTES;
  const maxActiveBytes = options.maxActiveBytes ?? MAX_ACTIVE_BYTES;
  const maxSpoolBytes = options.maxSpoolBytes ?? MAX_SPOOL_BYTES;
  for (const size of [maxBatchBytes, maxActiveBytes, maxSpoolBytes, options.retryMs ?? 1_000]) {
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Phoenix spool limits must be positive integers');
  }
  mkdirSync(options.spoolDir, { recursive: true, mode: 0o700 });
  const runs = new Map<string, Run>();
  const closedRuns = new Set<string>();
  const closedParents = new Map<string, { spanId: string; sessionId: string }>();
  const closedOrder: string[] = [];
  let spoolBytes = 0;
  let sending: Promise<void> | undefined;
  let closed = false;
  let sequence = 0;

  // ponytail: one observer owns this directory; use a locked spool for multiple writers.
  const files = function* (includeTemporary = false) {
    const directory = opendirSync(options.spoolDir);
    try {
      let item;
      while ((item = directory.readSync())) if (item.isFile() && (item.name.endsWith('.span') || includeTemporary && item.name.endsWith('.span.tmp'))) yield join(options.spoolDir, item.name);
    } finally { directory.closeSync(); }
  };
  for (const file of files(true)) {
    spoolBytes += statSync(file).size;
    if (file.endsWith('.tmp')) process.stderr.write(`Phoenix incomplete spool file retained for inspection: ${file}\n`);
  }

  const enqueue = (span: Span) => {
    const payload = encodeSpan(span);
    if (payload.length + 512 > maxBatchBytes) throw new Error(`Phoenix span exceeds export byte budget (${payload.length} bytes)`);
    if (spoolBytes + payload.length > maxSpoolBytes) throw new Error(`Phoenix spool quota exceeded (${spoolBytes}/${maxSpoolBytes} bytes); span not persisted`);
    const file = join(options.spoolDir, `${Date.now()}-${sequence++}-${span.spanId}.span`);
    const temporary = `${file}.tmp`;
    try {
      writeFileSync(temporary, payload, { flag: 'wx', mode: 0o600, flush: true });
      renameSync(temporary, file);
      spoolBytes += payload.length;
      const directory = openSync(options.spoolDir, 'r');
      try { fsyncSync(directory); } finally { closeSync(directory); }
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Already renamed or not created. */ }
      throw error;
    }
  };

  const exportBatch = async (payload: Buffer) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: new Uint8Array(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Phoenix OTLP export returned ${response.status}`);
    const responseBody = Buffer.from(await response.arrayBuffer());
    // OTLP success may include partial_success (protobuf field 1); keep the batch for replay.
    if (responseBody.length && response.headers.get('content-type')?.includes('protobuf')) throw new Error('Phoenix OTLP acknowledgement contains partial success; batch retained');
  };

  const pump = (): Promise<void> => {
    if (sending) return sending;
    sending = (async () => {
      try {
        while (true) {
          const batch: { file: string; payload: Buffer }[] = [];
          let bytes = 256;
          for (const file of files()) {
            const size = statSync(file).size;
            if (size + 512 > maxBatchBytes) throw new Error(`Phoenix persisted span exceeds export byte budget: ${file}`);
            if (batch.length === BATCH_SIZE || bytes + size + 16 > maxBatchBytes) break;
            batch.push({ file, payload: readFileSync(file) });
            bytes += size + 16;
          }
          if (!batch.length) break;
          const payload = encodeExportRequest(batch.map((item) => item.payload));
          if (payload.length > maxBatchBytes) throw new Error('Phoenix export batch exceeds byte budget');
          await exportBatch(payload);
          for (const item of batch) { unlinkSync(item.file); spoolBytes -= item.payload.length; }
        }
      } catch (error) {
        process.stderr.write(`Phoenix trace export failed; persisted spans retained (${spoolBytes} bytes): ${String(error)}\n`);
      }
    })().finally(() => { sending = undefined; });
    return sending;
  };

  const attach = (run: Run, span: Pick<OpenSpan, 'spanId'>, value: unknown) => {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.from(serialized);
    const count = Math.ceil(bytes.length / RAW_CHUNK_BYTES);
    const eventId = randomBytes(8).toString('hex');
    for (let index = 0; index < count; index++) {
      const child = open(record(value)?.type === 'pi_tool_output' ? 'pi.tool.output' : 'pi.event', 'CHAIN');
      const event = record(value);
      if (typeof event?.toolCallId === 'string') child.attributes.push(attribute('tool.call_id', event.toolCallId));
      if (typeof event?.sequence === 'number') child.attributes.push(attribute('pi.output.sequence', event.sequence));
      if (typeof event?.toolName === 'string') child.attributes.push(attribute('tool.name', event.toolName));
      if (typeof event?.stream === 'string') child.attributes.push(attribute('pi.output.stream', event.stream));
      if (event?.type === 'pi_tool_output' && span.spanId === run.root.spanId) child.attributes.push(attribute('pi.output.parent_missing', 'true'));
      if (count === 1) child.events.push(rawEvent(serialized));
      else child.events.push({ timeUnixNano: nanos(), name: 'pi.raw.fragment', attributes: [
        attribute('pi.event', bytes.subarray(index * RAW_CHUNK_BYTES, (index + 1) * RAW_CHUNK_BYTES).toString('base64')),
        attribute('pi.event.encoding', 'base64-json'), attribute('pi.event.id', eventId),
        attribute('pi.event.fragment', index), attribute('pi.event.fragments', count),
      ] });
      enqueue(finish(run, child, span.spanId));
    }
  };

  const setValue = (run: Run, span: OpenSpan, key: string, value: unknown) => {
    const serialized = JSON.stringify(value);
    const bytes = Buffer.byteLength(serialized);
    const activeBytes = Buffer.byteLength(JSON.stringify(span.attributes));
    if (bytes + activeBytes <= maxActiveBytes) span.attributes.push(attribute(key, serialized), attribute(key.replace('.value', '.mime_type'), 'application/json'));
    else {
      attach(run, span, { type: 'pi_span_value', key, value });
      span.attributes.push(attribute(key + '.bytes', bytes), attribute(key + '.sha256', createHash('sha256').update(serialized).digest('hex')), attribute(key + '.storage', 'pi_span_value child events'));
    }
  };

  const closeMessage = (run: Run, event?: Record<string, unknown>, unfinishedReason?: string) => {
    const span = run.message ?? run.pendingMessage;
    run.message = undefined;
    run.pendingMessage = undefined;
    if (!span) return;
    const message = record(event?.message);
    if (message) {
      setValue(run, span, 'output.value', message);
      const usage = record(message.usage);
      const input = numeric(usage, ['input', 'inputTokens', 'input_tokens', 'prompt', 'promptTokens']);
      const output = numeric(usage, ['output', 'outputTokens', 'output_tokens', 'completion', 'completionTokens']);
      const total = numeric(usage, ['total', 'totalTokens', 'total_tokens']) ?? (input !== undefined && output !== undefined ? input + output : undefined);
      if (input !== undefined) span.attributes.push(attribute('llm.token_count.prompt', input));
      if (output !== undefined) span.attributes.push(attribute('llm.token_count.completion', output));
      if (total !== undefined) span.attributes.push(attribute('llm.token_count.total', total));
      for (const [source, target] of [['provider', 'llm.system'], ['model', 'llm.model_name']] as const) if (typeof message[source] === 'string') span.attributes.push(attribute(target, message[source]));
      if (message.stopReason === 'error' || typeof message.errorMessage === 'string') span.failed = String(message.errorMessage ?? 'model error');
    }
    if (!message && unfinishedReason) span.failed ??= unfinishedReason;
    enqueue(finish(run, span, run.root.spanId));
  };

  const closeTools = (run: Run, reason: string) => {
    const tools = [...run.tools.values()];
    run.tools.clear();
    for (const tool of tools) {
      tool.failed ??= reason;
      try { enqueue(finish(run, tool, run.root.spanId)); }
      catch (error) { process.stderr.write(`Phoenix could not persist closing tool: ${String(error)}\n`); }
    }
  };

  const closeRun = (run: Run) => {
    try {
      try { closeMessage(run, undefined, 'provider request ended without message_end'); }
      catch (error) { process.stderr.write(`Phoenix could not persist closing message: ${String(error)}\n`); }
      closeTools(run, 'tool ended without tool_execution_end');
      try { enqueue(finish(run, run.root)); }
      catch (error) { process.stderr.write(`Phoenix could not persist closing run: ${String(error)}\n`); }
    } finally {
      const key = `${run.taskId}\0${run.runId}`;
      runs.delete(key);
      closedRuns.add(key);
      closedParents.set(key, { spanId: run.root.spanId, sessionId: run.sessionId });
      closedOrder.push(key);
      if (closedOrder.length > 1_024) {
        const oldest = closedOrder.shift()!;
        closedRuns.delete(oldest);
        closedParents.delete(oldest);
      }
    }
  };

  const retry = setInterval(() => { void pump(); }, options.retryMs ?? 1_000);
  retry.unref();
  void pump();

  return {
    event(taskId, runId, value) {
      if (closed) return;
      const key = `${taskId}\0${runId}`;
      const event = record(value);
      const type = typeof event?.type === 'string' ? event.type : 'unknown';
      let run = runs.get(key);
      if (closedRuns.has(key)) {
        if (type !== 'pi_tool_output') return;
        const parent = closedParents.get(key)!;
        const root = open('pi.run', 'AGENT');
        root.spanId = parent.spanId;
        run = { taskId, runId, traceId: traceId(taskId, runId), sessionId: parent.sessionId, root, tools: new Map(), toolParents: new Map() };
      }
      if (!run) {
        run = { taskId, runId, traceId: traceId(taskId, runId), sessionId: taskId, root: open('pi.run', 'AGENT'), tools: new Map(), toolParents: new Map() };
        runs.set(key, run);
      }
      if (type === 'session' && typeof event?.id === 'string') run.sessionId = event.id;

      try {
        if (type === 'pi_provider_request') {
          closeMessage(run, undefined, 'provider request was superseded before message_end');
          const request = open('pi.llm', 'LLM');
          setValue(run, request, 'input.value', event?.payload);
          if (typeof event?.provider === 'string') request.attributes.push(attribute('llm.system', event.provider));
          if (typeof event?.model === 'string') request.attributes.push(attribute('llm.model_name', event.model));
          attach(run, request, value);
          run.pendingMessage = request;
        } else if (type === 'message_start' && record(event?.message)?.role === 'assistant') {
          if (run.message) closeMessage(run, undefined, 'assistant message was superseded before message_end');
          run.message = run.pendingMessage ?? open('pi.llm', 'LLM', [attribute('llm.system', 'pi')]);
          run.pendingMessage = undefined;
          attach(run, run.message, value);
        } else if ((type === 'message_update' || type === 'message_end') && run.message) {
          try { attach(run, run.message, value); }
          finally { if (type === 'message_end') closeMessage(run, event); }
        } else if (type === 'tool_execution_start' && typeof event?.toolCallId === 'string') {
          const tool = open(`pi.tool.${typeof event.toolName === 'string' ? event.toolName : 'unknown'}`, 'TOOL');
          if (typeof event.toolName === 'string') tool.attributes.push(attribute('tool.name', event.toolName));
          if (event.args !== undefined) setValue(run, tool, 'input.value', event.args);
          attach(run, tool, value);
          run.tools.set(event.toolCallId, tool);
          run.toolParents.set(event.toolCallId, tool.spanId);
          if (run.toolParents.size > 1_024) run.toolParents.delete(run.toolParents.keys().next().value!);
        } else if (type === 'pi_tool_output' && typeof event?.toolCallId === 'string') {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > RAW_CHUNK_BYTES || !Number.isSafeInteger(event.sequence) || (event.sequence as number) < 0) throw new Error('Invalid pi_tool_output chunk: expected sequence and at most 32KiB data');
          attach(run, { spanId: run.toolParents.get(event.toolCallId) ?? run.root.spanId }, value);
        } else if (type.startsWith('tool_execution_') && typeof event?.toolCallId === 'string' && run.tools.has(event.toolCallId)) {
          const tool = run.tools.get(event.toolCallId)!;
          try { attach(run, tool, value); }
          finally {
            if (type === 'tool_execution_end') {
              run.tools.delete(event.toolCallId);
              if (event.result !== undefined) setValue(run, tool, 'output.value', event.result);
              if (event.isError === true) tool.failed = 'tool execution failed';
              enqueue(finish(run, tool, run.root.spanId));
            }
          }
        } else attach(run, run.root, value);
        const eventError = event?.error;
        if (type.includes('error') || eventError !== undefined) run.root.failed = typeof eventError === 'string' ? eventError : eventError === undefined ? type : JSON.stringify(eventError);
        if (event?.cancelled === true) run.root.failed ??= 'cancelled';
      } catch (error) {
        process.stderr.write(`Phoenix could not persist Pi event (${taskId}/${runId}/${type}): ${String(error)}\n`);
      } finally {
        if (type === 'agent_settled' || type === 'run_end') closeRun(run);
      }
      void pump();
    },
    async close() {
      closed = true;
      clearInterval(retry);
      for (const run of [...runs.values()]) {
        try { closeRun(run); } catch (error) { process.stderr.write(`Phoenix could not persist closing run: ${String(error)}\n`); }
      }
      await sending;
      await pump();
      if (spoolBytes) process.stderr.write(`Phoenix observer closed with ${spoolBytes} bytes pending on disk\n`);
    },
  };
}
