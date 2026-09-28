import { spawn } from "node:child_process";
import { writeSync } from "node:fs";

type ExtensionApi = {
  registerTool(tool: Record<string, unknown>): void;
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

type AdapterName = "source" | "logs" | "trace" | "alert";

function command(name: AdapterName): { command: string; args: string[] } | undefined {
  const raw = process.env[`PI_ALERT_${name.toUpperCase()}_TOOL`];
  if (!raw) return undefined;
  const value = JSON.parse(raw) as { command?: unknown; args?: unknown };
  if (typeof value.command !== "string" || !Array.isArray(value.args) || value.args.some((arg) => typeof arg !== "string")) {
    throw new Error(`Invalid ${name} tool command`);
  }
  return value as { command: string; args: string[] };
}

function execute(spec: { command: string; args: string[] }, input: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [...spec.args];
    if ("traceId" in input) args.push(String(input.traceId));
    if ("start" in input) args.push("--start", String(input.start));
    if ("end" in input) args.push("--end", String(input.end));
    if ("server" in input) args.push("--server", String(input.server));
    if ("query" in input && "start" in input) args.push("--query", String(input.query));
    const { PI_ALERT_API_KEY: _apiKey, ...env } = process.env;
    const child = spawn(spec.command, args, { cwd: process.cwd(), env, stdio: ["pipe", "pipe", "pipe"] });
    const output: Buffer[] = [];
    const errors: Buffer[] = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      const stderr = Buffer.concat(errors).toString("utf8");
      if (code === 0) resolve(Buffer.concat(output).toString("utf8"));
      else reject(new Error(`${spec.command} exited ${code}${stderr ? `: ${stderr}` : ""}`));
    });
    const abort = () => child.kill("SIGTERM");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdin.end(JSON.stringify(input));
  });
}

export default function register(pi: ExtensionApi): void {
  pi.on?.("before_provider_request", (event, context) => {
    const line = JSON.stringify({
      type: "pi_provider_request",
      provider: context.model?.provider,
      model: context.model?.id,
      payload: event.payload,
    });
    // Pi redirects process.stdout.write() to stderr in print mode. Writing the
    // inherited stdout descriptor preserves this event in the JSONL stream.
    writeSync(process.stdout.fd, `${line}\n`);
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
        return { content: [{ type: "text", text: await execute(spec, input, signal) }], details: {} };
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
