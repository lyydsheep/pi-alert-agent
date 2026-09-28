# Workspace and MR delivery adapter

`GitWorkspaceManager` creates one deterministic `bugfix/faizili_<task-id>` or `feature/faizili_<task-id>` branch and worktree per task. A new branch starts at the latest fetched remote `master`; retries reuse the registered worktree or existing local branch without resetting it. For a task with an existing MR, resumption checks that its remote source branch still matches the observed MR HEAD. A clean worktree behind that HEAD fast-forwards; local commits ahead of it are retained. Dirty or diverged work requiring synchronization blocks for Owner reconciliation without resetting or rebasing. A changed remote HEAD also blocks rather than running against an unobserved revision. `push()` first checks the remote branch, then uses a normal non-force push. `cleanup()` only removes a clean worktree at least seven days after completion and retains its local branch and commits for restoration.

`GitLabDeliveryClient` uses the GitLab-compatible HTTP API configured by `apiEndpoint`, `token`, and `project`. `createOrReadMergeRequest()` searches the exact source/target branch pair in any state before creation and searches again after an uncertain create failure, so recovery keeps the same MR and never replaces a closed or merged MR. Supply the endpoint including its API prefix, for example `https://gitlab.example/api/v4`; `project` can be a numeric ID or path.

Delivery completes only while the MR is open, its current SHA matches the expected local HEAD when provided, the exact configured `agentReviewCheck` has a successful commit status on that SHA, every `requiredChecks` entry has a successful status on that SHA, and the API reports the MR mergeable with no conflict. Platform mergeability therefore keeps required repository approvals and unresolved discussions effective. Missing or unfamiliar fields and checks fail closed. Conflicts set `ownerRequired`; the adapter does not modify another task or resolve cross-MR conflicts.

`feedback()` classifies system notes, unresolved resolvable notes, and explicit `[change-request]` or `/request_changes` notes. Other notes remain ordinary comments and do not reopen work automatically. Closed and merged MRs never satisfy delivery completion.

Private forges can use a local command bridge instead of exposing forge logic here. Configure `delivery` with `command`, optional `args` and `timeoutMs`, plus explicit `project`, `requiredChecks`, and `agentReviewCheck`. The executable is invoked directly without a shell. It receives one JSON object on stdin and must write one JSON value to stdout:

- `{ "operation": "createOrReadMergeRequest", "project": "...", "sourceBranch": "...", "title": "...", "description": "..." }` returns `MergeRequest`.
- `{ "operation": "status", "project": "...", "mrIid": 7, "expectedHead": "..." }` returns `DeliveryStatus`.
- `{ "operation": "ensureAgentReview", "project": "...", "mrIid": 7, "expectedHead": "..." }` returns `{ "mrIid": 7, "head": "..." }`.
- `{ "operation": "feedback", "project": "...", "mrIid": 7 }` returns `MergeRequestFeedback[]`.

The canonical field names are the exported TypeScript types in `src/delivery.ts`. Output is limited to 1 MiB and must be a single JSON value. Timeout or cancellation terminates the process tree. Exit errors never include stderr. For status, the adapter ignores claimed `complete`, `currentHead`, and `agentReviewPassed` values: it recomputes them from the returned MR head, exact configured check names, Agent review status, mergeability, and owner-required flag. Missing evidence fails closed.

When Agent review is missing or pending for the current open MR head, the service may repeat `ensureAgentReview` after restarts or on later polls. The bridge must make that operation durably idempotent for the `(project, mrIid, expectedHead)` tuple. The adapter accepts a receipt only when its MR and head match the request. Closed, merged, conflicting, paused, rejected, or superseded task state does not trigger the operation.

Tests use local Git repositories and a local HTTP server. The real private GitLab/Gongfeng host, its credentials, API field compatibility, required check names, and Agent review status name still require test-group validation before rollout.

Git commands default to a five-minute timeout, with `GitWorkspaceOptions.timeoutMs` available for host-specific limits. A one-minute limit interrupted concurrent full monorepo checkouts during deployment acceptance. Cancellation still stops the command; a retry restores the retained task branch rather than resetting its base.

New branches map logical `fix`/`feat` kinds to Gongfeng-compatible `bugfix`/`feature` prefixes. Existing `fix`/`feat` branches remain recoverable without changing their commits. Servers that reject these legacy prefixes require an explicit branch migration before pushing; recovery does not silently rename an existing MR source branch.
