import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PiPhase = "investigate" | "execute";

export type PiModelConfig = {
  provider: string;
  id: string;
  apiKey: string;
  endpoint?: string;
  /** Pi API implementation name, for example `openai-responses`. Required for a custom model. */
  api?: string;
};

export type PiToolCommand = { command: string; args?: string[] };

export type PiRunnerConfig = {
  command?: string;
  args?: string[];
  agentDir: string;
  model: PiModelConfig;
  timeoutMs?: number;
  killGraceMs?: number;
  /** Private or public skill files/directories loaded by Pi without copying them into this repository. */
  skills?: string[];
  tools?: { source?: PiToolCommand; logs?: PiToolCommand; trace?: PiToolCommand; alert?: PiToolCommand; shell?: PiToolCommand };
};

export type PiRunInput = {
  taskId: string;
  runId: string;
  cwd: string;
  /** Directory dedicated to this task's Pi JSONL sessions. */
  sessionPath: string;
  prompt: string;
  phase: PiPhase;
  planVersion?: number;
  signal?: AbortSignal;
  onEvent?: (event: unknown) => void;
};

export type RepairPlan = {
  background: string;
  diagnosis: string;
  evidence: string[];
  scope: string[];
  solution: string;
  acceptance: string[];
  risks: string[];
};

export type Completion = {
  summary: string;
  evidence: string[];
  changedFiles: string[];
  tests: string[];
  mrUrl?: string;
  noCodeChange: boolean;
  externalAction?: string;
};

type RunMetadata = {
  taskId: string;
  runId: string;
  sessionId: string;
  durationMs: number;
  summary: string;
  /** Stable digest for the main service to compare with the previous complete round. */
  progressKey: string;
  progress: boolean;
  usage?: unknown;
};

export type PiRunResult =
  | (RunMetadata & { status: "plan"; plan: RepairPlan })
  | (RunMetadata & { status: "completed"; completion: Completion });

export type PiRunErrorKind = "cancelled" | "timed_out" | "spawn" | "protocol" | "exit" | "missing_result";

export class PiRunError extends Error {
  readonly kind: PiRunErrorKind;
  readonly stderr: string;

  constructor(
    kind: PiRunErrorKind,
    message: string,
    stderr = "",
  ) {
    super(message);
    this.name = "PiRunError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

type EventRecord = Record<string, unknown>;

const extensionSourcePath = fileURLToPath(new URL("./extension.ts", import.meta.url));
const extensionPath = existsSync(extensionSourcePath) ? extensionSourcePath : fileURLToPath(new URL("./extension.js", import.meta.url));
const supervisorSourcePath = fileURLToPath(new URL("./supervisor.ts", import.meta.url));
const supervisorPath = existsSync(supervisorSourcePath) ? supervisorSourcePath : fileURLToPath(new URL("./supervisor.js", import.meta.url));

function sessionId(taskId: string): string {
  const hex = createHash("sha256").update(taskId).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16], 16) & 3) | 8).toString(16);
  return `${hex.slice(0, 8).join("")}-${hex.slice(8, 12).join("")}-${hex.slice(12, 16).join("")}-${hex.slice(16, 20).join("")}-${hex.slice(20).join("")}`;
}

function progressKey(value: RepairPlan | Completion): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as EventRecord).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is { type: "text"; text: string } => !!part && typeof part === "object" && (part as EventRecord).type === "text" && typeof (part as EventRecord).text === "string")
    .map((part) => part.text)
    .join("\n");
}

function validateStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new PiRunError("protocol", `Invalid ${field} in Pi result`);
  return value;
}

function requiredString(record: EventRecord, field: string): string {
  const value = record[field];
  if (typeof value !== "string") throw new PiRunError("protocol", `Invalid ${field} in Pi result`);
  return value;
}

function parsePlan(value: unknown): { plan: RepairPlan; summary: string; progress: boolean } {
  if (!value || typeof value !== "object") throw new PiRunError("protocol", "Invalid submit_plan arguments");
  const record = value as EventRecord;
  if (typeof record.progress !== "boolean") throw new PiRunError("protocol", "Invalid progress in Pi result");
  return {
    plan: {
      background: requiredString(record, "background"),
      diagnosis: requiredString(record, "diagnosis"),
      evidence: validateStrings(record.evidence, "evidence"),
      scope: validateStrings(record.scope, "scope"),
      solution: requiredString(record, "solution"),
      acceptance: validateStrings(record.acceptance, "acceptance"),
      risks: validateStrings(record.risks, "risks"),
    },
    summary: requiredString(record, "summary"),
    progress: record.progress,
  };
}

function parseCompletion(value: unknown): { completion: Completion; summary: string; progress: boolean } {
  if (!value || typeof value !== "object") throw new PiRunError("protocol", "Invalid submit_completion arguments");
  const record = value as EventRecord;
  if (typeof record.noCodeChange !== "boolean" || typeof record.progress !== "boolean") {
    throw new PiRunError("protocol", "Invalid completion flags in Pi result");
  }
  const summary = requiredString(record, "summary");
  const mrUrl = record.mrUrl;
  if (mrUrl !== undefined && typeof mrUrl !== "string") throw new PiRunError("protocol", "Invalid mrUrl in Pi result");
  if (record.externalAction !== undefined && (typeof record.externalAction !== 'string' || !record.externalAction.trim())) throw new PiRunError('protocol', 'Invalid externalAction in Pi result');
  return {
    completion: {
      summary,
      evidence: validateStrings(record.evidence, "evidence"),
      changedFiles: validateStrings(record.changedFiles, "changedFiles"),
      tests: validateStrings(record.tests, "tests"),
      ...(mrUrl ? { mrUrl } : {}),
      noCodeChange: record.noCodeChange,
      ...(typeof record.externalAction === 'string' ? {externalAction:record.externalAction} : {}),
    },
    summary,
    progress: record.progress,
  };
}

function stop(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.connected) {
    child.send?.({ type: "stop", signal });
    return;
  }
  try {
    if (child.pid) process.kill(child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export class PiRunner {
  private readonly config: PiRunnerConfig;
  private modelReady?: Promise<void>;

  constructor(config: PiRunnerConfig) {
    if (!config.model.provider || !config.model.id || !config.model.apiKey) throw new TypeError("Pi provider, model, and API key are required");
    if (config.model.endpoint && !config.model.api) throw new TypeError("Pi API protocol is required with a custom endpoint");
    this.config = config;
  }

  async run(input: PiRunInput): Promise<PiRunResult> {
    if (input.signal?.aborted) throw new PiRunError("cancelled", "Pi run cancelled before start");
    const tempDir = resolve(input.sessionPath, 'tmp');
    await Promise.all([mkdir(tempDir, { recursive: true }), this.modelReady ??= this.writeModelConfig().catch(error => { this.modelReady = undefined; throw error; })]);

    const id = sessionId(input.taskId);
    const args = [
      ...(this.config.command ? [] : [fileURLToPath(new URL('./bundle/cli.js', import.meta.resolve('@earendil-works/pi-coding-agent')))]),
      ...(this.config.args ?? []),
      "--mode", "json",
      "--no-extensions",
      "--extension", extensionPath,
      ...(this.config.skills ?? []).flatMap((skill) => ["--skill", skill]),
      "--provider", this.config.model.provider,
      "--model", this.config.model.id,
      "--session-dir", resolve(input.sessionPath),
      "--session-id", id,
      this.prompt(input),
    ];
    const env = {
      ...process.env,
      TMPDIR: tempDir,
      TMP: tempDir,
      TEMP: tempDir,
      PI_CODING_AGENT_DIR: resolve(this.config.agentDir),
      PI_ALERT_API_KEY: this.config.model.apiKey,
      PI_OFFLINE: "1",
      ...(this.config.tools?.source ? { PI_ALERT_SOURCE_TOOL: JSON.stringify({ ...this.config.tools.source, args: this.config.tools.source.args ?? [] }) } : {}),
      ...(this.config.tools?.logs ? { PI_ALERT_LOGS_TOOL: JSON.stringify({ ...this.config.tools.logs, args: this.config.tools.logs.args ?? [] }) } : {}),
      ...(this.config.tools?.trace ? { PI_ALERT_TRACE_TOOL: JSON.stringify({ ...this.config.tools.trace, args: this.config.tools.trace.args ?? [] }) } : {}),
      ...(this.config.tools?.alert ? { PI_ALERT_ALERT_TOOL: JSON.stringify({ ...this.config.tools.alert, args: this.config.tools.alert.args ?? [] }) } : {}),
      ...(this.config.tools?.shell ? { PI_ALERT_SHELL_TOOL: JSON.stringify({ ...this.config.tools.shell, args: this.config.tools.shell.args ?? [] }) } : {}),
      PI_ALERT_CHILD_COMMAND: this.config.command ?? process.execPath,
      PI_ALERT_CHILD_ARGS: JSON.stringify(args),
      PI_ALERT_CHILD_CWD: input.cwd,
      PI_ALERT_KILL_GRACE_MS: String(this.config.killGraceMs ?? 5_000),
      PI_ALERT_TRACE_FD: "3",
    };
    const started = Date.now();
    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [supervisorPath], { cwd: input.cwd, env, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    } catch (error) {
      throw new PiRunError("spawn", `Could not start Pi: ${String(error)}`);
    }

    return await new Promise<PiRunResult>((resolveRun, rejectRun) => {
      let buffer = "";
      let stderr = "";
      let finalText = "";
      let usage: unknown;
      let plan: unknown;
      let completion: unknown;
      let failure: PiRunError | undefined;
      let reason: "cancelled" | "timed_out" | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      const timeout = setTimeout(() => terminate("timed_out"), this.config.timeoutMs ?? 3_600_000);

      const terminate = (nextReason: "cancelled" | "timed_out") => {
        if (reason) return;
        reason = nextReason;
        stop(child, "SIGTERM");
        killTimer = setTimeout(() => stop(child, "SIGKILL"), Math.max(0, this.config.killGraceMs ?? 5_000));
        killTimer.unref();
      };
      const onAbort = () => terminate("cancelled");
      input.signal?.addEventListener("abort", onAbort, { once: true });

      const fail = (error: PiRunError) => {
        if (failure) return;
        failure = error;
        stop(child, "SIGKILL");
      };
      const consume = (line: string) => {
        if (failure) return;
        let event: EventRecord;
        try {
          event = JSON.parse(line) as EventRecord;
        } catch {
          fail(new PiRunError("protocol", "Pi emitted invalid JSON", stderr));
          return;
        }
        try { input.onEvent?.(event); } catch { /* tracing must not stop task execution */ }
        if (event.type === "message_update" && event.usage) usage = event.usage;
        if (event.type === "message_end" && (event.message as EventRecord | undefined)?.role === "assistant") finalText = text(event.message);
        if (event.type === "tool_execution_start") {
          if (event.toolName === "submit_plan") plan = event.args;
          if (event.toolName === "submit_completion") completion = event.args;
        }
      };
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        buffer += chunk;
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) break;
          const line = buffer.slice(0, end).replace(/\r$/, "");
          buffer = buffer.slice(end + 1);
          if (line) consume(line);
        }
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
      child.on("error", (error) => fail(new PiRunError("spawn", `Could not start Pi: ${error.message}`, stderr)));
      child.on("close", (code, signal) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        input.signal?.removeEventListener("abort", onAbort);
        if (buffer.trim()) consume(buffer.replace(/\r$/, ""));
        if (failure) return rejectRun(failure);
        if (reason) return rejectRun(new PiRunError(reason, reason === "timed_out" ? "Pi run timed out" : "Pi run cancelled", stderr));
        if (code !== 0) return rejectRun(new PiRunError("exit", `Pi exited with ${code ?? signal ?? "unknown status"}`, stderr));
        const common = { taskId: input.taskId, runId: input.runId, sessionId: id, durationMs: Date.now() - started, usage };
        try {
          if (!!plan === !!completion) throw new PiRunError("missing_result", `Pi did not submit exactly one result${finalText ? `: ${finalText}` : ""}`, stderr);
          if (plan) {
            const parsed = parsePlan(plan);
            return resolveRun({ status: "plan", ...common, ...parsed, progressKey: progressKey(parsed.plan) });
          }
          const parsed = parseCompletion(completion);
          if (input.phase === "investigate" && !parsed.completion.noCodeChange && !parsed.completion.externalAction) {
            throw new PiRunError("protocol", "Investigation may submit completion only when no code change is needed", stderr);
          }
          resolveRun({ status: "completed", ...common, ...parsed, progressKey: progressKey(parsed.completion) });
        } catch (error) {
          rejectRun(error);
        }
      });
    });
  }

  private prompt(input: PiRunInput): string {
    const expected = input.phase === "investigate"
      ? "Call submit_plan, or call submit_completion with noCodeChange=true when the evidence shows no code repair is needed."
      : "Call submit_completion, or call submit_plan when the required repair materially exceeds the authorized plan.";
    return [
      `Alert task ${input.taskId}; run ${input.runId}; phase ${input.phase}; plan version ${input.planVersion ?? "none"}.`,
      input.phase === "investigate"
        ? "Investigate and validate the cause. Do not make product changes in this round."
        : "Execute only the authorized plan, test it, and commit the resulting code. Do not push or create an MR; the main service owns delivery. Report the actual state without claiming unverified success.",
      "Keep test artifacts in the task TMPDIR. Tests needing network listeners must bind ephemeral ports and isolated test data; never reuse another task workspace.",
      ...(this.config.tools?.shell ? ["Shell commands share a host resource slot. Respect the wrapper worker limits; for build tools that ignore its environment (for example Bazel), pass the matching worker limit explicitly. Do not detach background build processes."] : []),
      "所有面向 Owner 的自然语言必须使用简体中文，包括 summary、background、diagnosis、evidence、scope、solution、acceptance、risks、conclusion 与 externalAction；代码、标识符、原始日志和引用保持原文。保留不确定性，不把假设写成已确认根因。",
      input.prompt,
      `Finish with exactly one result tool. ${expected} Its structured arguments are the authoritative round result.`,
    ].join("\n\n");
  }

  private async writeModelConfig(): Promise<void> {
    const { provider, id, endpoint, api } = this.config.model;
    const providerConfig: EventRecord = { apiKey: "$PI_ALERT_API_KEY" };
    if (endpoint) providerConfig.baseUrl = endpoint;
    if (api) {
      providerConfig.api = api;
      providerConfig.models = [{ id }];
    }
    const path = resolve(this.config.agentDir, "models.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ providers: { [provider]: providerConfig } }, null, 2)}\n`, { mode: 0o600 });
  }
}
