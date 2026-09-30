import { spawn } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, writeSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { stop } from "../delivery-command.ts";
import { createBashToolDefinition, createLocalBashOperations, type BashToolOptions } from "@earendil-works/pi-coding-agent";

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
  on?(event: "tool_result", handler: (event: {toolName:string;toolCallId:string;details?:unknown}) => {details:Record<string,unknown>} | undefined): void;
  on?(
    event: "before_provider_request",
    handler: (event: { payload: unknown }, context: { model?: { provider?: string; id?: string } }) => void | Promise<void>,
  ): void;
};

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const string = { type: "string" };
const strings = { type: "array", items: string };

type AdapterName = "source" | "logs" | "trace" | "alert" | "shell";

const INLINE_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function emitTrace(value: unknown): void {
  const fd = process.env.PI_ALERT_TRACE_FD;
  if (fd === undefined) return;
  const bytes = Buffer.from(JSON.stringify(value) + "\n");
  for (let offset = 0; offset < bytes.length;) offset += writeSync(Number(fd), bytes, offset);
}

function captureOutput(toolName: string, toolCallId: string, stream?: string) {
  const root = process.env.TMPDIR ?? tmpdir();
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(mkdtempSync(join(root, "pi-output-")), "output.txt");
  const fd = openSync(path, "wx", 0o600);
  const hash = createHash("sha256"), decoder = new StringDecoder("utf8");
  let bytes = 0, sequence = 0, closed = false;
  const emit = (data: string, rawBytesBase64?: string) => {
    if (data || rawBytesBase64) emitTrace({ type: "pi_tool_output", toolName, toolCallId, stream, sequence: sequence++, data, ...(rawBytesBase64?{rawBytesBase64}:{}) });
  };
  return {
    write(data: Buffer) {
      if (bytes + data.length > MAX_OUTPUT_BYTES) throw new Error(`Tool output exceeds ${MAX_OUTPUT_BYTES} bytes; command stopped. Partial output retained at ${path}`);
      for (let offset = 0; offset < data.length;) offset += writeSync(fd, data, offset);
      bytes += data.length; hash.update(data);
      for (let offset = 0; offset < data.length; offset += 8 * 1024) {
        const part=data.subarray(offset,offset+8*1024);
        emit(decoder.write(part),part.toString('base64'));
      }
    },
    finish() {
      if (!closed) { closed = true; closeSync(fd); emit(decoder.end()); }
    },
    details() {
      const fullOutput=bytes<=INLINE_OUTPUT_BYTES?readFileSync(path,"utf8"):undefined;
      return { fullOutputPath: path, fullOutputBytes: bytes, fullOutputSha256: hash.copy().digest("hex"),
        ...(fullOutput!==undefined&&Buffer.byteLength(fullOutput)<=INLINE_OUTPUT_BYTES?{fullOutput}:{}) };
    },
  };
}

function command(name: AdapterName): { command: string; args: string[] } | undefined {
  const raw = process.env[`PI_ALERT_${name.toUpperCase()}_TOOL`];
  if (!raw) return undefined;
  const value = JSON.parse(raw) as { command?: unknown; args?: unknown };
  if (typeof value.command !== "string" || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Invalid ${name} tool command`);
  }
  return value as { command: string; args: string[] };
}

function execute(spec: { command: string; args: string[] }, input: Record<string, unknown>, toolName: string, toolCallId: string, signal?: AbortSignal): Promise<{content:Array<{type:string;text:string}>;details:Record<string,unknown>}> {
  return new Promise((resolve, reject) => {
    const args = [...spec.args];
    if ("traceId" in input) args.push(String(input.traceId));
    if ("start" in input) args.push("--start", String(input.start));
    if ("end" in input) args.push("--end", String(input.end));
    if ("server" in input) args.push("--server", String(input.server));
    if ("query" in input && "start" in input) args.push("--query", String(input.query));
    const { PI_ALERT_API_KEY: _apiKey, ...env } = process.env;
    const output = captureOutput(toolName, toolCallId, "stdout"), errors = captureOutput(toolName, toolCallId, "stderr");
    const child = spawn(spec.command, args, { cwd: process.cwd(), env, detached:process.platform!=='win32', stdio: ["pipe", "pipe", "pipe"] });
    emitTrace({type:'pi_query_process',state:'started',pid:child.pid,ppid:process.pid});
    let failure: Error | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let exitTimer: NodeJS.Timeout | undefined, exited=false;
    const abort = () => { stop(child,"SIGTERM");killTimer??=setTimeout(()=>stop(child,"SIGKILL"),5_000);killTimer.unref(); };
    const releasePipes = () => { stop(child,"SIGKILL");child.stdout.destroy();child.stderr.destroy(); };
    const idleAfterExit = () => { if(exited){if(exitTimer)clearTimeout(exitTimer);exitTimer=setTimeout(releasePipes,100);} };
    const capture = (target: ReturnType<typeof captureOutput>, chunk: Buffer) => {
      if (failure) return;
      try { target.write(chunk); } catch (error) { failure = error as Error; abort(); }
      idleAfterExit();
    };
    child.stdout.on("data", (chunk) => capture(output, chunk));
    child.stderr.on("data", (chunk) => capture(errors, chunk));
    child.on("error", error => { failure = error; });
    child.on("exit",()=>{exited=true;idleAfterExit();});
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if(killTimer)clearTimeout(killTimer);
      if(exitTimer)clearTimeout(exitTimer);
      stop(child,"SIGKILL");
      emitTrace({type:'pi_query_process',state:'ended',pid:child.pid,ppid:process.pid});
      output.finish(); errors.finish();
      const details = output.details(), stderr = errors.details();
      if (failure) reject(failure);
      else if (signal?.aborted) reject(new Error("Query cancelled"));
      else if (code === 0) resolve({ content: [{ type: "text", text: typeof details.fullOutput === "string" ? details.fullOutput : `Output: ${details.fullOutputBytes} bytes. Read full result from ${details.fullOutputPath}` }], details });
      else reject(new Error(`${spec.command} exited ${code}; stderr: ${stderr.fullOutput ?? stderr.fullOutputPath}; stdout: ${details.fullOutputPath}`));
    });
    signal?.addEventListener("abort", abort, { once: true });
    if(signal?.aborted)abort();
    child.stdin.end(JSON.stringify(input));
  });
}

export default function register(pi: ExtensionApi): void {
  const shell = command("shell");
  const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
  const options: BashToolOptions = shell ? {
    spawnHook: (context) => ({ ...context,
      command: [shell.command, ...shell.args, "/bin/bash", "-c", context.command].map(quote).join(" "),
    }),
  } : {};
  const bash = createBashToolDefinition(process.cwd(), options);
  const operations = createLocalBashOperations();
  const outputs = new Map<string, ReturnType<typeof captureOutput>>();
  pi.registerTool({ ...bash, async execute(...args: Parameters<typeof bash.execute>) {
    const output = captureOutput("bash", args[0]);
    outputs.set(args[0], output);
    let failure: Error | undefined;
    const tool = createBashToolDefinition(process.cwd(), { ...options, operations: {
      exec: (command, cwd, execution) => {
        const controller = new AbortController();
        return operations.exec(command, cwd, { ...execution,
          signal: execution.signal ? AbortSignal.any([execution.signal, controller.signal]) : controller.signal,
          onData: (data) => {
            if (failure) return;
            try { output.write(Buffer.from(data)); execution.onData(data); }
            catch (error) { failure = error as Error; controller.abort(); }
          },
        });
      },
    } });
    try { const result = await tool.execute(...args); if (failure) throw failure; return result; }
    catch(error) { throw failure ?? error; }
    finally { output.finish(); }
  } });
  pi.on?.("tool_result", (event) => {
    const output = event.toolName === "bash" ? outputs.get(event.toolCallId) : undefined;
    if (!output) return;
    outputs.delete(event.toolCallId);
    return { details: { ...(event.details && typeof event.details === "object" ? event.details : {}),
      ...output.details(),
    } };
  });
  pi.on?.("before_provider_request", (event, context) => {
    const output = Buffer.from(`${JSON.stringify({
      type: "pi_provider_request",
      provider: context.model?.provider,
      model: context.model?.id,
      payload: event.payload,
    })}\n`);
    const fd = Number(process.env.PI_ALERT_TRACE_FD ?? process.stdout.fd);
    for (let offset = 0; offset < output.length;) offset += writeSync(fd, output, offset);
  });

  for (const [name, description, parameters] of [
    ["source", "Query the configured source-code service. The adapter receives this input as JSON on stdin.", object({ query: string, context: string }, ["query"])],
    ["logs", "Query logs for an exact time range and server. The adapter receives matching CLI flags and JSON on stdin.", object({ start: string, end: string, server: string, query: string }, ["start", "end", "server", "query"])],
    ["trace", "Query one trace by its exact trace ID.", object({ traceId: string }, ["traceId"])],
    ["alert", "Query the configured alert-detail service. The adapter receives this input as JSON on stdin.", object({ query: string, context: string }, ["query"])],
  ] as const) {
    const spec = command(name);
    if (!spec) continue;
    pi.registerTool({
      name: `query_${name}`,
      label: `Query ${name}`,
      description,
      parameters,
      async execute(_id: string, input: Record<string, unknown>, signal?: AbortSignal) {
        return execute(spec, input, `query_${name}`, _id, signal);
      },
    });
  }

  pi.registerTool({
    name: "submit_plan",
    label: "Submit repair plan",
    description: "Submit the investigation result to the alert application. Call exactly once at the end of an investigation round.",
    parameters: object(
      {
        background: string,
        diagnosis: string,
        evidence: strings,
        scope: strings,
        solution: string,
        acceptance: strings,
        risks: strings,
        summary: string,
        progress: { type: "boolean" },
      },
      ["background", "diagnosis", "evidence", "scope", "solution", "acceptance", "risks", "summary", "progress"],
    ),
    async execute() {
      return { content: [{ type: "text", text: "Plan recorded by the host application." }], details: {} };
    },
  });

  pi.registerTool({
    name: "submit_completion",
    label: "Submit execution result",
    description: "Submit the execution result to the alert application. Call exactly once at the end of an execution round.",
    parameters: object(
      {
        summary: string,
        evidence: strings,
        changedFiles: strings,
        tests: strings,
        mrUrl: string,
        noCodeChange: { type: "boolean" },
        externalAction: {type:'string',description:'Required external action or missing access that prevents completion. Omit only when no external action remains; the host blocks and notifies the Owner when set.'},
        progress: { type: "boolean" },
      },
      ["summary", "evidence", "changedFiles", "tests", "noCodeChange", "progress"],
    ),
    async execute() {
      return { content: [{ type: "text", text: "Completion recorded by the host application." }], details: {} };
    },
  });
}
