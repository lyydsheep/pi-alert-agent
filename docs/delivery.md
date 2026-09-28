# Workspace and MR delivery adapter

`GitWorkspaceManager` creates one deterministic `fix/faizili_<task-id>` or `feat/faizili_<task-id>` branch and worktree per task. A new branch starts at the latest fetched remote `master`; retries reuse the registered worktree or existing local branch without resetting it. `push()` first checks the remote branch, then uses a normal non-force push. `cleanup()` only removes a clean worktree at least seven days after completion and retains its local branch and commits for restoration.

`GitLabDeliveryClient` uses the GitLab-compatible HTTP API configured by `apiEndpoint`, `token`, and `project`. `createOrReadMergeRequest()` searches the exact source/target branch pair in any state before creation and searches again after an uncertain create failure, so recovery keeps the same MR and never replaces a closed or merged MR. Supply the endpoint including its API prefix, for example `https://gitlab.example/api/v4`; `project` can be a numeric ID or path.

Delivery completes only while the MR is open, its current SHA matches the expected local HEAD when provided, the exact configured `agentReviewCheck` has a successful commit status on that SHA, every `requiredChecks` entry has a successful status on that SHA, and the API reports the MR mergeable with no conflict. Platform mergeability therefore keeps required repository approvals and unresolved discussions effective. Missing or unfamiliar fields and checks fail closed. Conflicts set `ownerRequired`; the adapter does not modify another task or resolve cross-MR conflicts.

`feedback()` classifies system notes, unresolved resolvable notes, and explicit `[change-request]` or `/request_changes` notes. Other notes remain ordinary comments and do not reopen work automatically. Closed and merged MRs never satisfy delivery completion.

Tests use local Git repositories and a local HTTP server. The real private GitLab/Gongfeng host, its credentials, API field compatibility, required check names, and Agent review status name still require test-group validation before rollout.
