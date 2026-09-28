export interface GitLabDeliveryOptions {
  apiEndpoint: string;
  token: string;
  project: string | number;
  targetBranch?: string;
  requiredChecks: string[];
  agentReviewCheck: string;
  timeoutMs?: number;
}

export interface MergeRequest {
  iid: number;
  url: string;
  state: string;
  sourceBranch: string;
  targetBranch: string;
  head: string;
}

export interface DeliveryStatus {
  mergeRequest: MergeRequest;
  currentHead: boolean;
  agentReviewStatus?: string;
  agentReviewPassed: boolean;
  checks: Record<string, string | undefined>;
  mergeable?: boolean;
  ownerRequired: boolean;
  complete: boolean;
}

export interface MergeRequestFeedback {
  id: number;
  body: string;
  author?: string;
  createdAt?: string;
  classification: 'change-request' | 'comment' | 'system';
}

type Json = Record<string, unknown>;

export class DeliveryHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function record(value: unknown, label: string): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Unexpected GitLab ${label} response`);
  return value as Json;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`GitLab response is missing ${label}`);
  return value;
}

function number(value: unknown, label: string): number {
  if (typeof value !== 'number') throw new Error(`GitLab response is missing ${label}`);
  return value;
}

export class GitLabDeliveryClient {
  readonly apiEndpoint: string;
  readonly token: string;
  readonly project: string;
  readonly targetBranch: string;
  readonly requiredChecks: string[];
  readonly agentReviewCheck: string;
  readonly timeoutMs: number;

  constructor(options: GitLabDeliveryOptions) {
    if (!options.requiredChecks.length) throw new Error('At least one required check must be configured');
    if (!options.agentReviewCheck) throw new Error('An explicit Agent review check name must be configured');
    this.apiEndpoint = options.apiEndpoint.replace(/\/$/, '');
    this.token = options.token;
    this.project = encodeURIComponent(String(options.project));
    this.targetBranch = options.targetBranch ?? 'master';
    this.requiredChecks = [...new Set(options.requiredChecks)];
    this.agentReviewCheck = options.agentReviewCheck;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  async createOrReadMergeRequest(input: { sourceBranch: string; title: string; description: string }, signal?: AbortSignal): Promise<MergeRequest> {
    const existing = await this.findExisting(input.sourceBranch, signal);
    if (existing) return existing;

    try {
      const created = await this.request('POST', 'merge_requests', {
        source_branch: input.sourceBranch,
        target_branch: this.targetBranch,
        title: input.title,
        description: input.description,
      }, signal);
      return this.mergeRequest(created);
    } catch (error) {
      const recovered = await this.findExisting(input.sourceBranch, signal);
      if (recovered) return recovered;
      throw error;
    }
  }

  async status(mrIid: number, expectedHead?: string, signal?: AbortSignal): Promise<DeliveryStatus> {
    const raw = record(await this.request('GET', `merge_requests/${mrIid}`, undefined, signal), 'merge request');
    const mergeRequest = this.mergeRequest(raw);
    const rawStatuses = await this.pages(`repository/commits/${encodeURIComponent(mergeRequest.head)}/statuses?all=true`, signal);

    const latest = new Map<string, { status: string; id: number }>();
    for (const value of rawStatuses) {
      const status = record(value, 'commit status');
      const name = typeof status.name === 'string' ? status.name : status.context;
      if (typeof name !== 'string' || typeof status.status !== 'string') continue;
      const id = typeof status.id === 'number' ? status.id : 0;
      if (!latest.has(name) || latest.get(name)!.id < id) latest.set(name, { status: status.status, id });
    }

    const checks: Record<string, string | undefined> = {};
    for (const name of this.requiredChecks) checks[name] = latest.get(name)?.status;
    const agentReviewStatus = latest.get(this.agentReviewCheck)?.status;
    const agentReviewPassed = agentReviewStatus === 'success';
    const currentHead = expectedHead === undefined || expectedHead === mergeRequest.head;
    const ownerRequired = raw.has_conflicts === true || raw.merge_status === 'cannot_be_merged' || raw.detailed_merge_status === 'conflict';
    const mergeable = typeof raw.detailed_merge_status === 'string'
      ? raw.detailed_merge_status === 'mergeable'
      : raw.merge_status === 'can_be_merged';
    const allChecksPassed = this.requiredChecks.every((name) => checks[name] === 'success');
    const complete = mergeRequest.state === 'opened' && currentHead && agentReviewPassed && allChecksPassed && mergeable && !ownerRequired;
    return { mergeRequest, currentHead, agentReviewStatus, agentReviewPassed, checks, mergeable, ownerRequired, complete };
  }

  async feedback(mrIid: number, signal?: AbortSignal): Promise<MergeRequestFeedback[]> {
    const raw = await this.pages(`merge_requests/${mrIid}/notes?sort=asc&order_by=created_at`, signal);
    return raw.map((value) => {
      const note = record(value, 'merge request note');
      const body = text(note.body, 'note.body');
      const explicit = /^\s*(?:\[change-request\]|\/request_changes\b)/i.test(body);
      const unresolvedThread = note.resolvable === true && note.resolved !== true;
      return {
        id: number(note.id, 'note.id'),
        body,
        author: note.author && typeof note.author === 'object' && typeof (note.author as Json).username === 'string'
          ? (note.author as Json).username as string
          : undefined,
        createdAt: typeof note.created_at === 'string' ? note.created_at : undefined,
        classification: note.system === true ? 'system' : explicit || unresolvedThread ? 'change-request' : 'comment',
      };
    });
  }

  private async findExisting(sourceBranch: string, signal?: AbortSignal): Promise<MergeRequest | undefined> {
    const query = new URLSearchParams({ state: 'all', source_branch: sourceBranch, target_branch: this.targetBranch, per_page: '100' });
    const raw = await this.request('GET', `merge_requests?${query}`, undefined, signal);
    if (!Array.isArray(raw)) throw new Error('Unexpected GitLab merge request list response');
    const matches = raw.filter((item) => {
      const mr = item as Json;
      return mr.source_branch === sourceBranch && mr.target_branch === this.targetBranch;
    });
    const exact = matches.find((item) => (item as Json).state === 'opened') ?? matches[0];
    return exact ? this.mergeRequest(record(exact, 'merge request')) : undefined;
  }

  private async pages(path: string, signal?: AbortSignal): Promise<unknown[]> {
    const values: unknown[] = [];
    for (let page = 1; page <= 100; page++) {
      const batch = await this.request('GET', `${path}&per_page=100&page=${page}`, undefined, signal);
      if (!Array.isArray(batch)) throw new Error('Unexpected paginated GitLab response');
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error('GitLab pagination exceeded 100 pages');
  }

  private mergeRequest(value: unknown): MergeRequest {
    const mr = record(value, 'merge request');
    const head = typeof mr.sha === 'string' && mr.sha ? mr.sha
      : mr.diff_refs && typeof mr.diff_refs === 'object' ? text((mr.diff_refs as Json).head_sha, 'diff_refs.head_sha') : text(mr.sha, 'sha');
    return {
      iid: number(mr.iid, 'iid'),
      url: text(mr.web_url, 'web_url'),
      state: text(mr.state, 'state'),
      sourceBranch: text(mr.source_branch, 'source_branch'),
      targetBranch: text(mr.target_branch, 'target_branch'),
      head,
    };
  }

  private async request(method: string, path: string, body?: Json, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.apiEndpoint}/projects/${this.project}/${path}`, {
      method,
      headers: {
        'PRIVATE-TOKEN': this.token,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new DeliveryHttpError(response.status, `GitLab ${method} ${path} failed with ${response.status}: ${await response.text()}`);
    return response.json();
  }
}
