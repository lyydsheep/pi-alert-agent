import { writeFile } from "node:fs/promises";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const capture = value("--capture");
const prompt = args.at(-1);

if (prompt.includes("[hang]")) {
  process.on("SIGTERM", async () => {
    if (capture) await writeFile(`${capture}.terminated`, "SIGTERM");
    process.exit(0);
  });
  setInterval(() => {}, 1_000);
  if (capture) await writeFile(capture, JSON.stringify(args));
} else {
  if (capture) await writeFile(capture, JSON.stringify(args));
  if (capture) await writeFile(`${capture}.tmp`, process.env.TMPDIR ?? '');
  let evidence = ["fixture evidence"];
  if (prompt.includes("adapter-trace")) {
    const extension = await import(value("--extension"));
    const tools = new Map();
    extension.default({ registerTool: (tool) => tools.set(tool.name, tool) });
    const result = await tools.get("query_trace").execute("call", { traceId: "trace-123" });
    evidence = [result.content[0].text.trim()];
  }
  const plan = {
    background: "alert",
    diagnosis: "root cause",
    evidence,
    scope: ["service/a"],
    solution: "change one guard",
    acceptance: ["test passes"],
    risks: ["none known"],
    summary: "investigated",
    progress: true,
  };
  const completion = {
    summary: "fixed",
    evidence,
    changedFiles: ["a.ts"],
    tests: ["node --test"],
    mrUrl: "https://example.test/mr/1",
    noCodeChange: false,
    progress: true,
  };
  if (prompt.includes("no-code")) completion.noCodeChange = true;
  const toolName = prompt.includes("no-code")
    ? "submit_completion"
    : prompt.includes("expanded-plan")
      ? "submit_plan"
      : prompt.includes("phase investigate") ? "submit_plan" : "submit_completion";
  const toolArgs = toolName === "submit_plan" ? plan : completion;
  process.stdout.write(`${JSON.stringify({ type: "session", id: value("--session-id") })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_update", usage: { input: 4, output: 2 } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolName, args: toolArgs })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } })}\n`);
  process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
}
