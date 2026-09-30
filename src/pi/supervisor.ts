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
const queryGroups=new Set<number>();

function forwardLines(stream: NodeJS.ReadableStream, extension=false): Promise<void> {
  let buffer = "";
  let bufferBytes = 0;
  let waiting = false, ended = false;
  let complete!:()=>void;
  const done=new Promise<void>(resolve=>{complete=resolve;});
  stream.setEncoding("utf8");
  const flush = () => {
    if(waiting)return;
    for (;;) {
      const end = buffer.indexOf("\n");
      if(end<0&&!ended) {
        if(bufferBytes>8*1024*1024){process.stderr.write("Pi event exceeds 8 MiB transport limit\n");buffer="";bufferBytes=0;stop("SIGKILL");}
        return;
      }
      if(!buffer){if(ended)complete();return;}
      const size=end<0?buffer.length:end+1, line=buffer.slice(0,size);
      const bytes=Buffer.byteLength(line);
      if(bytes>8*1024*1024){process.stderr.write("Pi event exceeds 8 MiB transport limit\n");buffer="";bufferBytes=0;stop("SIGKILL");return;}
      buffer=buffer.slice(size);
      bufferBytes-=bytes;
      if(extension&&line.includes('"pi_query_process"')){
        try{
          const event=JSON.parse(line);
          if(event.type==='pi_query_process'&&event.ppid===child.pid&&Number.isSafeInteger(event.pid)&&event.pid>1&&event.pid!==child.pid){
            if(event.state==='started')queryGroups.add(event.pid);
            else if(event.state==='ended')queryGroups.delete(event.pid);
          }
        }catch{}
      }
      if(!process.stdout.write(line)) {
        waiting=true;stream.pause();
        process.stdout.once("drain",()=>{waiting=false;flush();if(!waiting)stream.resume();});
        return;
      }
    }
  };
  stream.on("data", (chunk: string) => { buffer += chunk;bufferBytes+=Buffer.byteLength(chunk);flush(); });
  stream.on("end", () => { ended=true;flush(); });
  return done;
}

const forwarding=[forwardLines(child.stdout!),forwardLines(child.stdio[3]! as NodeJS.ReadableStream,true)];
child.stderr!.pipe(process.stderr);

let stopping = false;
function kill(signal: NodeJS.Signals): void {
  for(const pid of queryGroups){
    try{if(process.platform!=='win32')process.kill(-pid,signal);else process.kill(pid,signal);}catch{}
  }
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
  kill("SIGKILL");
  void Promise.all(forwarding).then(()=>process.stdout.write("", () => process.exit(code ?? (signal ? 1 : 0))));
});
if (!process.connected) stop();
