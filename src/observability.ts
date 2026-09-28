import { createHash, randomBytes } from 'node:crypto';

export interface Observer {
  event(taskId: string, runId: string, event: unknown): void;
  close(): Promise<void>;
}

type Attribute = { key: string; value: { stringValue?: string; intValue?: string } };
type SpanEvent = { timeUnixNano: string; name: string; attributes: Attribute[] };
type Span = Record<string, unknown>;
type OpenSpan = { spanId: string; name: string; kind: 'AGENT' | 'LLM' | 'TOOL'; start: string; attributes: Attribute[]; events: SpanEvent[]; failed?: string };
type Run = { taskId: string; runId: string; traceId: string; sessionId: string; root: OpenSpan; pendingMessage?: OpenSpan; message?: OpenSpan; tools: Map<string, OpenSpan> };

const MAX_BUFFERED_EVENTS = 512;
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

function rawEvent(value: unknown): SpanEvent {
  return { timeUnixNano: nanos(), name: 'pi.raw', attributes: [attribute('pi.event', JSON.stringify(value))] };
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

function eventCount(span: Span): number { return Array.isArray(span.events) ? span.events.length : 0; }

function lossSpan(count: number): Span {
  const time = nanos();
  return {
    traceId: randomBytes(16).toString('hex'), spanId: randomBytes(8).toString('hex'), name: 'pi.observability.loss', kind: 1,
    startTimeUnixNano: time, endTimeUnixNano: time,
    attributes: [attribute('openinference.span.kind', 'CHAIN'), attribute('pi.observability.dropped_events', count)], events: [],
    status: { code: 2, message: `${count} complete Pi events were dropped` },
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

function encodeExportRequest(spans: Span[]): Buffer {
  const resource = messageField(1, encodeAttribute(attribute('service.name', 'pi-alert-agent')));
  const scope = Buffer.concat([stringField(1, 'pi-alert-agent'), stringField(2, '1')]);
  const scopeSpans = Buffer.concat([messageField(1, scope), ...spans.map((span) => messageField(2, encodeSpan(span)))]);
  return messageField(1, Buffer.concat([messageField(1, resource), messageField(2, scopeSpans)]));
}

export function createObserver(options: { endpoint: string; apiKey?: string }): Observer {
  const endpoint = new URL(options.endpoint).toString();
  const runs = new Map<string, Run>();
  const closedRuns = new Set<string>();
  const closedOrder: string[] = [];
  const queue: Span[] = [];
  let bufferedEvents = 0;
  let dropped = 0;
  let sending: Promise<void> | undefined;
  let closed = false;

  const enqueue = (span: Span) => {
    if (queue.length >= MAX_BUFFERED_EVENTS) {
      const count = eventCount(span);
      bufferedEvents -= count;
      dropped += count;
    } else queue.push(span);
  };

  const exportBatch = async (spans: Span[]) => {
    const payload = new Uint8Array(encodeExportRequest(spans));
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf', ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}) },
      body: payload,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`Phoenix OTLP export returned ${response.status}`);
  };

  const pump = (): Promise<void> => {
    if (sending) return sending;
    sending = (async () => {
      while (queue.length || dropped) {
        const lossCount = dropped;
        if (lossCount) { queue.unshift(lossSpan(lossCount)); dropped = 0; }
        const batch = queue.splice(0, BATCH_SIZE);
        const batchEvents = batch.reduce((sum, span) => sum + eventCount(span), 0);
        try {
          await exportBatch(batch);
          bufferedEvents -= batchEvents;
        } catch (error) {
          const queuedEvents = queue.reduce((sum, span) => sum + eventCount(span), 0);
          dropped = lossCount + batchEvents + queuedEvents;
          bufferedEvents -= batchEvents + queuedEvents;
          queue.length = 0;
          process.stderr.write(`Phoenix trace export failed; ${dropped} complete event(s) not exported: ${String(error)}\n`);
          break;
        }
      }
    })().finally(() => { sending = undefined; });
    return sending;
  };

  const attach = (span: OpenSpan, value: unknown) => {
    if (bufferedEvents >= MAX_BUFFERED_EVENTS) dropped++;
    else { span.events.push(rawEvent(value)); bufferedEvents++; }
  };

  const closeMessage = (run: Run, event?: Record<string, unknown>, unfinishedReason?: string) => {
    if (!run.message && run.pendingMessage) {
      run.message = run.pendingMessage;
      run.pendingMessage = undefined;
    }
    if (!run.message) return;
    const message = record(event?.message);
    if (message) {
      run.message.attributes.push(attribute('output.value', JSON.stringify(message)), attribute('output.mime_type', 'application/json'));
      const usage = record(message.usage);
      const input = numeric(usage, ['input', 'inputTokens', 'input_tokens', 'prompt', 'promptTokens']);
      const output = numeric(usage, ['output', 'outputTokens', 'output_tokens', 'completion', 'completionTokens']);
      const total = numeric(usage, ['total', 'totalTokens', 'total_tokens']) ?? (input !== undefined && output !== undefined ? input + output : undefined);
      if (input !== undefined) run.message.attributes.push(attribute('llm.token_count.prompt', input));
      if (output !== undefined) run.message.attributes.push(attribute('llm.token_count.completion', output));
      if (total !== undefined) run.message.attributes.push(attribute('llm.token_count.total', total));
      for (const [source, target] of [['provider', 'llm.system'], ['model', 'llm.model_name']] as const) if (typeof message[source] === 'string') run.message.attributes.push(attribute(target, message[source]));
      if (message.stopReason === 'error' || typeof message.errorMessage === 'string') run.message.failed = String(message.errorMessage ?? 'model error');
    }
    if (!message && unfinishedReason) run.message.failed ??= unfinishedReason;
    enqueue(finish(run, run.message, run.root.spanId));
    run.message = undefined;
  };

  const closeTools = (run: Run, reason: string) => {
    for (const tool of run.tools.values()) { tool.failed ??= reason; enqueue(finish(run, tool, run.root.spanId)); }
    run.tools.clear();
  };

  const closeRun = (run: Run) => {
    closeMessage(run, undefined, 'provider request ended without message_end');
    closeTools(run, 'tool ended without tool_execution_end');
    enqueue(finish(run, run.root));
    const key = `${run.taskId}\0${run.runId}`;
    runs.delete(key);
    closedRuns.add(key);
    closedOrder.push(key);
    if (closedOrder.length > 1_024) closedRuns.delete(closedOrder.shift()!);
  };

  return {
    event(taskId, runId, value) {
      if (closed) return;
      const key = `${taskId}\0${runId}`;
      const event = record(value);
      const type = typeof event?.type === 'string' ? event.type : 'unknown';
      if (closedRuns.has(key)) return;
      let run = runs.get(key);
      if (!run) {
        run = { taskId, runId, traceId: traceId(taskId, runId), sessionId: taskId, root: open('pi.run', 'AGENT'), tools: new Map() };
        runs.set(key, run);
      }
      if (type === 'session' && typeof event?.id === 'string') run.sessionId = event.id;

      try {
        if (type === 'pi_provider_request') {
          closeMessage(run, undefined, 'provider request was superseded before message_end');
          const request = open('pi.llm', 'LLM');
          request.attributes.push(attribute('input.value', JSON.stringify(event?.payload)), attribute('input.mime_type', 'application/json'));
          if (typeof event?.provider === 'string') request.attributes.push(attribute('llm.system', event.provider));
          if (typeof event?.model === 'string') request.attributes.push(attribute('llm.model_name', event.model));
          attach(request, value);
          run.pendingMessage = request;
        } else if (type === 'message_start' && record(event?.message)?.role === 'assistant') {
          if (run.message) closeMessage(run, undefined, 'assistant message was superseded before message_end');
          run.message = run.pendingMessage ?? open('pi.llm', 'LLM', [attribute('llm.system', 'pi')]);
          run.pendingMessage = undefined;
          attach(run.message, value);
        } else if ((type === 'message_update' || type === 'message_end') && run.message) {
          attach(run.message, value);
          if (type === 'message_end') closeMessage(run, event);
        } else if (type === 'tool_execution_start' && typeof event?.toolCallId === 'string') {
          const tool = open(`pi.tool.${typeof event.toolName === 'string' ? event.toolName : 'unknown'}`, 'TOOL');
          if (typeof event.toolName === 'string') tool.attributes.push(attribute('tool.name', event.toolName));
          if (event.args !== undefined) tool.attributes.push(attribute('input.value', JSON.stringify(event.args)), attribute('input.mime_type', 'application/json'));
          attach(tool, value);
          run.tools.set(event.toolCallId, tool);
        } else if (type.startsWith('tool_execution_') && typeof event?.toolCallId === 'string' && run.tools.has(event.toolCallId)) {
          const tool = run.tools.get(event.toolCallId)!;
          attach(tool, value);
          if (type === 'tool_execution_end') {
            if (event.result !== undefined) tool.attributes.push(attribute('output.value', JSON.stringify(event.result)), attribute('output.mime_type', 'application/json'));
            if (event.isError === true) tool.failed = 'tool execution failed';
            enqueue(finish(run, tool, run.root.spanId));
            run.tools.delete(event.toolCallId);
          }
        } else attach(run.root, value);
        const eventError = event?.error;
        if (type.includes('error') || eventError !== undefined) run.root.failed = typeof eventError === 'string' ? eventError : eventError === undefined ? type : JSON.stringify(eventError);
        if (event?.cancelled === true) run.root.failed ??= 'cancelled';
        if (type === 'agent_settled' || type === 'run_end') closeRun(run);
      } catch (error) {
        dropped++;
        process.stderr.write(`Phoenix could not serialize one Pi event: ${String(error)}\n`);
      }
      void pump();
    },
    async close() {
      closed = true;
      for (const run of [...runs.values()]) closeRun(run);
      await sending;
      if (queue.length || dropped) await pump();
      if (dropped) process.stderr.write(`Phoenix observer closed with ${dropped} unexported complete event(s)\n`);
    },
  };
}
