import { spawn } from "node:child_process";

const command = process.env.PI_ALERT_CHILD_COMMAND;
const args = JSON.parse(process.env.PI_ALERT_CHILD_ARGS ?? "[]") as unknown;
const cwd = process.env.PI_ALERT_CHILD_CWD;
const graceMs = Number(process.env.PI_ALERT_KILL_GRACE_MS ?? 5_000);
if (!command || !cwd || !Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid Pi supervisor configuration");

const {
  PI_ALERT_CHILD_COMMAND: _command,
  PI_ALERT_CHILD_ARGS: _args,
  PI_ALERT_CHILD_CWD: _cwd,
  PI_ALERT_KILL_GRACE_MS: _grace,
  ...env
} = process.env;
const child = spawn(command, args as string[], { cwd, env, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe", "pipe"] });

function forwardLines(stream: NodeJS.ReadableStream): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      process.stdout.write(buffer.slice(0, end + 1));
      buffer = buffer.slice(end + 1);
    }
  });
  stream.on("end", () => { if (buffer) process.stdout.write(buffer); });
}

forwardLines(child.stdout!);
forwardLines(child.stdio[3]! as NodeJS.ReadableStream);
child.stderr!.pipe(process.stderr);

let stopping = false;
function kill(signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function stop(signal: NodeJS.Signals = "SIGTERM"): void {
  if (stopping && signal !== "SIGKILL") return;
  stopping = true;
  kill(signal);
  if (signal !== "SIGKILL") setTimeout(() => kill("SIGKILL"), graceMs).unref();
}

process.on("message", (message: unknown) => {
  if (message && typeof message === "object" && (message as { type?: unknown }).type === "stop") {
    stop((message as { signal?: NodeJS.Signals }).signal ?? "SIGTERM");
  }
});
process.on("disconnect", () => stop());
child.on("error", (error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
child.on("close", (code, signal) => {
  process.stdout.write("", () => process.exit(code ?? (signal ? 1 : 0)));
});
if (!process.connected) stop();
