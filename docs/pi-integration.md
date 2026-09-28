# Pi integration

`PiRunner` starts one isolated Pi JSON-mode child process per execution round. The main service supplies the task, run, worktree, phase, prompt, cancellation signal, and a task-specific session directory. Pi exits after the round, while `--session-id` restores the same conversation on the next round.

The runner requires `@earendil-works/pi-coding-agent` 0.87.1 or a compatible release exposing the current CLI. The former `@mariozechner/pi-coding-agent` package is deprecated. Pi's official [CLI integration](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/cli-integration.md) and [JSON event](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/json.md) references define the process protocol.

Configure one explicit provider and model. A custom endpoint also requires its Pi API implementation name, such as `openai-responses`; the runner does not infer protocol from the URL. It writes `models.json` with an environment-variable reference and sends the key only in the child environment.

```ts
const runner = new PiRunner({
  command: "./node_modules/.bin/pi",
  agentDir: "/var/lib/pi-alert/pi",
  model: {
    provider: "internal",
    id: "model-id",
    api: "openai-responses",
    endpoint: "https://model.example/v1",
    apiKey: process.env.MODEL_API_KEY!,
  },
  tools: {
    trace: { command: process.execPath, args: ["/private/tdocs-trace-query/scripts/query.mjs"] },
    logs: { command: process.execPath, args: ["/private/tdocs-trace-query/scripts/query-log.mjs"] },
  },
  skills: ["/private/skills/tdocs-trace-query"],
});
```

Tool adapters execute configured commands directly without a shell. `query_trace` appends the trace ID as a positional argument. `query_logs` appends `--start`, `--end`, `--server`, and `--query`. Source and alert adapters receive JSON on stdin. Credentials remain the external tool's environment concern; no enterprise script or secret belongs in this repository.

Each configured `skills` path is passed to Pi with `--skill`. This loads independently maintained private skills in place while normal workspace `AGENTS.md` and context discovery remain enabled.

An investigation normally calls `submit_plan`, but may call `submit_completion` with `noCodeChange=true` when evidence shows that no repair is needed. An execution normally calls `submit_completion`, but calls `submit_plan` when the necessary work materially exceeds the authorized plan. The runner validates and returns that structured payload plus a stable `progressKey` digest. The model's `progress` flag is only a claim; the main service compares `progressKey` and external check state with prior rounds when counting no-progress rounds. The main service remains authoritative for authorization, stale `runId` or plan-version rejection, persistence, retry counting, and delivery state.

`AbortSignal` and the configured deadline first terminate the Pi process group, then force-kill it after the grace period. A small IPC supervisor applies the same cleanup when the main-service process disappears, preventing an orphaned Pi round from writing beside a recovered round. Each raw JSON event is also delivered to `onEvent`; observation failures are ignored so Phoenix outages do not block task execution.

Immediately before every provider request, the extension emits `{type:"pi_provider_request", provider, model, payload}`. `payload` is the complete JSON request body, including the actual system prompt, conversation, and tools; API headers and credentials are not part of this event. Tool continuations and retries emit additional events because each is a separate provider request. Provider events use a dedicated inherited pipe; the supervisor forwards complete records from that pipe and native Pi stdout through one writer. This avoids partial writes or interleaved records corrupting JSONL when model inputs are large. A 2 MiB trace regression and a real saved-session replay cover the transport. On malformed output, the runner waits for the Pi process and supervisor to exit before reporting failure, so a retry cannot race their writes.

Execution rounds edit, test, and commit in the task worktree. They do not push or create an MR; the main service owns those externally visible, recoverable delivery steps.

## Verified compatibility

Verified locally against the published `@earendil-works/pi-coding-agent` 0.87.1 package:

- `--mode json`, `--session-dir`, and `--session-id` persist and resume a task session.
- `--no-extensions --extension <path>` loads the application extension and exposes its result tools.
- `tool_execution_start.args` contains the validated result-tool payload used by the runner.
- A `models.json` custom `openai-completions` endpoint works with the configured provider and model.
- `before_provider_request` exposes the exact request body sent to the compatible endpoint, including system context, messages, and tools.

The automated compatibility check uses a local synthetic OpenAI-compatible endpoint. It proves CLI, extension, event, endpoint, and session wiring without claiming that a real model or production credential was tested.

## Shared host shell resources

Configure `tools.shell` with a command and arguments that prefix `/bin/bash -c <exact command>`. Pi's built-in bash implementation still owns output handling, timeout and cancellation; the extension only supplies its native spawn hook. All prefix arguments and the original command are individually shell-quoted. Use absolute paths because execution cwd is the task worktree.

On Linux, `scripts/limited-shell.sh SHARED_LOCK JOBS` uses host `flock` to allow one shell command at a time across tasks. Set the same lock path for every Pi runner; its parent directory must exist. Model calls and read/write tools remain concurrent. All shell commands use the slot, including nested scripts, avoiding fragile build-command classification. The lock is released by the OS when the process tree exits; queued cancellation and cancellation while holding the lock are tested. This is resource scheduling, not task dependency tracking or a permission sandbox.

The wrapper sets worker defaults for Make, CMake, Cargo and Go; explicit command-line overrides can supersede build-tool environment settings. The model is instructed to respect the limit and supply an equivalent limit for tools such as Bazel. Tests should use task-local temporary artifacts, ephemeral ports and independent data. Current AnyDev configuration uses one shell slot and two workers per build. The wrapper requires Linux `flock`; other hosts must provide an equivalent configured wrapper.
