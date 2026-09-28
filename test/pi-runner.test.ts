import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { PiRunError, PiRunner, type PiRunnerConfig } from "../src/pi/runner.ts";

const fixture = fileURLToPath(new URL("./pi-fixture.mjs", import.meta.url));
const adapter = fileURLToPath(new URL("./pi-adapter.mjs", import.meta.url));
const supervisor = fileURLToPath(new URL("../src/pi/supervisor.ts", import.meta.url));

async function waitFor(path: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { await access(path); return; } catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function setup(overrides: Partial<PiRunnerConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-runner-"));
  const capture = join(root, "args.json");
  const config: PiRunnerConfig = {
    command: process.execPath,
    args: [fixture, "--capture", capture],
    agentDir: join(root, "agent"),
    model: { provider: "test", id: "fixture", apiKey: "secret", endpoint: "http://localhost/v1", api: "openai-responses" },
    timeoutMs: 2_000,
    killGraceMs: 10,
    ...overrides,
  };
  return { root, capture, runner: new PiRunner(config), config };
}

test("returns a structured plan and reuses a stable task session", async () => {
  const { root, capture, runner, config } = await setup({ skills: ["/private/skills/trace"] });
  try {
    const input = { taskId: "task-1", runId: "run-1", cwd: root, sessionPath: join(root, "sessions"), prompt: "inspect", phase: "investigate" as const };
    const first = await runner.run(input);
    const second = await runner.run({ ...input, runId: "run-2" });
    assert.equal(first.status, "plan");
    assert.equal(first.plan.diagnosis, "root cause");
    assert.equal(first.sessionId, second.sessionId);
    assert.equal(first.runId, "run-1");
    const args = JSON.parse(await readFile(capture, "utf8")) as string[];
    assert.equal(args[args.indexOf("--session-id") + 1], first.sessionId);
    assert.equal(args[args.indexOf("--skill") + 1], "/private/skills/trace");
    assert.equal(await readFile(`${capture}.tmp`, 'utf8'), join(input.sessionPath, 'tmp'));
    const models = await readFile(join(config.agentDir, "models.json"), "utf8");
    assert.match(models, /http:\/\/localhost\/v1/);
    assert.match(models, /\$PI_ALERT_API_KEY/);
    assert.doesNotMatch(models, /secret/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("returns completion fields from an execution round", async () => {
  const { root, runner } = await setup();
  try {
    const result = await runner.run({ taskId: "task-2", runId: "run-2", cwd: root, sessionPath: join(root, "sessions"), prompt: "fix", phase: "execute" });
    assert.equal(result.status, "completed");
    assert.equal(result.completion.noCodeChange, false);
    assert.deepEqual(result.completion.tests, ["node --test"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("supports no-code investigation completion and expanded execution plans", async () => {
  const { root, runner } = await setup();
  try {
    const noCode = await runner.run({ taskId: "task-no-code", runId: "run-1", cwd: root, sessionPath: join(root, "no-code-session"), prompt: "no-code", phase: "investigate" });
    assert.equal(noCode.status, "completed");
    assert.equal(noCode.completion.noCodeChange, true);

    const expanded = await runner.run({ taskId: "task-expanded", runId: "run-2", cwd: root, sessionPath: join(root, "expanded-session"), prompt: "expanded-plan", phase: "execute" });
    assert.equal(expanded.status, "plan");
    assert.equal(expanded.plan.solution, "change one guard");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("passes trace IDs to a configured private CLI adapter", async () => {
  const { root, runner } = await setup({ tools: { trace: { command: process.execPath, args: [adapter] } } });
  try {
    const result = await runner.run({ taskId: "task-3", runId: "run-3", cwd: root, sessionPath: join(root, "sessions"), prompt: "adapter-trace", phase: "investigate" });
    assert.equal(result.status, "plan");
    assert.deepEqual(result.plan.evidence, ["trace:trace-123"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("classifies deadline and caller cancellation separately", async () => {
  const timed = await setup({ timeoutMs: 20 });
  try {
    await assert.rejects(
      timed.runner.run({ taskId: "task-4", runId: "run-4", cwd: timed.root, sessionPath: join(timed.root, "sessions"), prompt: "[hang]", phase: "investigate" }),
      (error: unknown) => error instanceof PiRunError && error.kind === "timed_out",
    );
  } finally {
    await rm(timed.root, { recursive: true, force: true });
  }

  const cancelled = await setup();
  const controller = new AbortController();
  try {
    const run = cancelled.runner.run({ taskId: "task-5", runId: "run-5", cwd: cancelled.root, sessionPath: join(cancelled.root, "sessions"), prompt: "[hang]", phase: "investigate", signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(run, (error: unknown) => error instanceof PiRunError && error.kind === "cancelled");
  } finally {
    await rm(cancelled.root, { recursive: true, force: true });
  }
});

test("supervisor terminates Pi when its parent IPC connection disappears", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-supervisor-"));
  const capture = join(root, "args.json");
  const child = spawn(process.execPath, [supervisor], {
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      ...process.env,
      PI_ALERT_CHILD_COMMAND: process.execPath,
      PI_ALERT_CHILD_ARGS: JSON.stringify([fixture, "--capture", capture, "phase investigate [hang]"]),
      PI_ALERT_CHILD_CWD: root,
      PI_ALERT_KILL_GRACE_MS: "1000",
    },
  });
  try {
    await waitFor(capture);
    const exited = once(child, "exit");
    child.disconnect();
    await exited;
    assert.equal(await readFile(`${capture}.terminated`, "utf8"), "SIGTERM");
  } finally {
    if (!child.killed) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

test("installed Pi package exposes its supported subprocess client", async () => {
  const packageName = "@earendil-works/pi-coding-agent";
  const pi = await import(packageName);
  assert.equal(typeof pi.RpcClient, "function");
});

test("installed Pi CLI loads the extension and resumes a session against a mock compatible endpoint", { timeout: 20_000 }, async () => {
  const requests: Array<Record<string, any>> = [];
  const plan = {
    background: "synthetic alert",
    diagnosis: "synthetic cause",
    evidence: ["mock endpoint evidence"],
    scope: ["fixture"],
    solution: "synthetic fix",
    acceptance: ["synthetic check"],
    risks: [],
    summary: "synthetic plan",
    progress: true,
  };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, any>;
    requests.push(body);
    const messages = body.messages as Array<{ role: string }>;
    const afterTool = messages.at(-1)?.role === "tool";
    const chunk = afterTool
      ? { id: "chat-2", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
      : { id: "chat-1", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${requests.length}`, type: "function", function: { name: "submit_plan", arguments: JSON.stringify(plan) } }] }, finish_reason: "tool_calls" }] };
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");

  const root = await mkdtemp(join(tmpdir(), "pi-real-"));
  const providerEvents: Array<Record<string, any>> = [];
  const seenEventTypes: unknown[] = [];
  const runner = new PiRunner({
    agentDir: join(root, "agent"),
    model: { provider: "fixture", id: "fixture", apiKey: "test-key", endpoint: `http://127.0.0.1:${address.port}/v1`, api: "openai-completions" },
    timeoutMs: 10_000,
    killGraceMs: 100,
  });
  try {
    const input = {
      taskId: "real-pi-task",
      runId: "run-1",
      cwd: root,
      sessionPath: join(root, "sessions"),
      prompt: "Use the synthetic result tool.",
      phase: "investigate" as const,
      onEvent(event: unknown) {
        seenEventTypes.push(event && typeof event === "object" ? (event as { type?: unknown }).type : undefined);
        if (event && typeof event === "object" && (event as { type?: unknown }).type === "pi_provider_request") providerEvents.push(event as Record<string, any>);
      },
    };
    const first = await runner.run(input);
    const second = await runner.run({ ...input, runId: "run-2" });
    assert.equal(first.status, "plan");
    assert.equal(second.status, "plan");
    assert(requests.length >= 4);
    assert.equal(providerEvents.length, requests.length, `seen events: ${JSON.stringify(seenEventTypes)}`);
    assert.equal(providerEvents[0].provider, "fixture");
    assert.equal(providerEvents[0].model, "fixture");
    for (let index = 0; index < requests.length; index += 1) assert.deepEqual(providerEvents[index].payload, requests[index]);
    assert((providerEvents[0].payload.messages as Array<{ role: string }>).some((message) => message.role === "system"));
    assert((providerEvents[0].payload.tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === "submit_plan"));
    assert((requests[0].tools as Array<{ function: { name: string } }>).some((tool) => tool.function.name === "submit_plan"));
    assert((requests[2].messages as unknown[]).length > (requests[0].messages as unknown[]).length, "second run should include the persisted session");
  } finally {
    server.close();
    await once(server, "close");
    await rm(root, { recursive: true, force: true });
  }
});

test('one runner starts four tasks with distinct sessions concurrently',async()=>{
  const {root,runner}=await setup();
  try{
    const results=await Promise.all([1,2,3,4].map(id=>runner.run({taskId:`parallel-${id}`,runId:`run-${id}`,cwd:root,sessionPath:join(root,`session-${id}`),phase:'investigate',prompt:'inspect'})));
    assert.equal(new Set(results.map(value=>value.sessionId)).size,4);
    assert.ok(results.every(value=>value.status==='plan'));
  }finally{await rm(root,{recursive:true,force:true});}
});
