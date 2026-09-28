import { spawn, type ChildProcess } from 'node:child_process';

import type { DeliveryStatus, MergeRequest, MergeRequestFeedback } from './delivery.ts';

export interface CommandDeliveryOptions {
  command: string;
  args?: string[];
  project: string;
  requiredChecks: string[];
  agentReviewCheck: string;
  timeoutMs?: number;
}

export interface AgentReviewReceipt {
  mrIid: number;
  head: string;
}

type Json = Record<string, unknown>;
const MAX_OUTPUT_BYTES = 1024 * 1024;

function record(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Delivery command returned invalid ${label}`);
  return value as Json;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Delivery command result is missing ${label}`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`Delivery command result is missing ${label}`);
  return value;
}

function mergeRequest(value: unknown): MergeRequest {
  const mr = record(value, 'merge request');
  return {
    iid: number(mr.iid, 'mergeRequest.iid'),
    url: text(mr.url, 'mergeRequest.url'),
    state: text(mr.state, 'mergeRequest.state'),
    sourceBranch: text(mr.sourceBranch, 'mergeRequest.sourceBranch'),
    targetBranch: text(mr.targetBranch, 'mergeRequest.targetBranch'),
    head: text(mr.head, 'mergeRequest.head'),
  };
}

function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

export class CommandDeliveryClient {
  readonly command: string;
  readonly args: string[];
  readonly project: string;
  readonly requiredChecks: string[];
  readonly agentReviewCheck: string;
  readonly timeoutMs: number;

  constructor(options: CommandDeliveryOptions) {
    if (!options.command) throw new Error('An explicit delivery command must be configured');
    if (!options.project) throw new Error('An explicit delivery project must be configured');
    if (!options.requiredChecks.length) throw new Error('At least one required check must be configured');
    if (!options.agentReviewCheck) throw new Error('An explicit Agent review check name must be configured');
    this.command = options.command;
    this.args = options.args ?? [];
    this.project = options.project;
    this.requiredChecks = [...new Set(options.requiredChecks)];
    this.agentReviewCheck = options.agentReviewCheck;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createOrReadMergeRequest(input: { sourceBranch: string; title: string; description: string }, signal?: AbortSignal): Promise<MergeRequest> {
    return mergeRequest(await this.request({ operation: 'createOrReadMergeRequest', project: this.project, ...input }, signal));
  }

  async status(mrIid: number, expectedHead?: string, signal?: AbortSignal): Promise<DeliveryStatus> {
    const raw = record(await this.request({ operation: 'status', project: this.project, mrIid, expectedHead }, signal), 'status');
    const mr = mergeRequest(raw.mergeRequest);
    const rawChecks = record(raw.checks, 'checks');
    const checks: Record<string, string | undefined> = {};
    for (const name of this.requiredChecks) checks[name] = typeof rawChecks[name] === 'string' ? rawChecks[name] : undefined;
    const agentReviewStatus = typeof raw.agentReviewStatus === 'string' ? raw.agentReviewStatus : undefined;
    const agentReviewPassed = agentReviewStatus === 'success';
    const currentHead = expectedHead === undefined || expectedHead === mr.head;
    const mergeable = raw.mergeable === true;
    const ownerRequired = raw.ownerRequired !== false;
    const complete = mr.state === 'opened' && currentHead && agentReviewPassed
      && this.requiredChecks.every((name) => checks[name] === 'success') && mergeable && !ownerRequired;
    return { mergeRequest: mr, currentHead, agentReviewStatus, agentReviewPassed, checks, mergeable, ownerRequired, complete };
  }

  async ensureAgentReview(mrIid: number, expectedHead: string, signal?: AbortSignal): Promise<AgentReviewReceipt> {
    const raw = record(await this.request({ operation: 'ensureAgentReview', project: this.project, mrIid, expectedHead }, signal), 'Agent review receipt');
    const receipt = { mrIid: number(raw.mrIid, 'mrIid'), head: text(raw.head, 'head') };
    if (receipt.mrIid !== mrIid || receipt.head !== expectedHead) throw new Error('Delivery command returned mismatched Agent review receipt');
    return receipt;
  }

  async feedback(mrIid: number, signal?: AbortSignal): Promise<MergeRequestFeedback[]> {
    const raw = await this.request({ operation: 'feedback', project: this.project, mrIid }, signal);
    if (!Array.isArray(raw)) throw new Error('Delivery command returned invalid feedback');
    return raw.map((value) => {
      const item = record(value, 'feedback item');
      if (!['change-request', 'comment', 'system'].includes(String(item.classification))) throw new Error('Delivery command returned invalid feedback classification');
      return {
        id: number(item.id, 'feedback.id'),
        body: text(item.body, 'feedback.body'),
        author: typeof item.author === 'string' ? item.author : undefined,
        createdAt: typeof item.createdAt === 'string' ? item.createdAt : undefined,
        classification: item.classification as MergeRequestFeedback['classification'],
      };
    });
  }

  private request(input: Json, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Delivery command cancelled'));
      const child = spawn(this.command, this.args, { detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'ignore'] });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let failure: string | undefined;
      const terminate = (message: string) => {
        if (failure) return;
        failure = message;
        stop(child, 'SIGTERM');
        setTimeout(() => stop(child, 'SIGKILL'), 1_000).unref();
      };
      const timer = setTimeout(() => terminate('Delivery command timed out'), this.timeoutMs).unref();
      const abort = () => terminate('Delivery command cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) terminate('Delivery command output exceeded 1 MiB');
        else chunks.push(chunk);
      });
      child.stdin.on('error', () => {});
      child.on('error', () => terminate('Delivery command could not be started'));
      child.on('close', (code) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (failure) return reject(new Error(failure));
        if (code !== 0) return reject(new Error(`Delivery command exited with code ${code ?? 'unknown'}`));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
        catch { reject(new Error('Delivery command returned invalid JSON')); }
      });
      child.stdin.end(`${JSON.stringify(input)}\n`);
    });
  }
}
