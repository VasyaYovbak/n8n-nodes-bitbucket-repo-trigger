# Bitbucket Repository PR Trigger for n8n

Self-hosted n8n community triggers for **Bitbucket Cloud** pull requests:

- **Bitbucket Repository PR Poll** checks open PRs on a schedule; it does not
  require a public n8n URL or webhook permissions.
- **Bitbucket Repository PR Trigger** receives signed webhooks and requires a
  public n8n URL reachable by Bitbucket Cloud.
- **Bitbucket Repository** provides read-only PR operations, including
  **Pull Request → Get Context** for PR details, diff and comments.

All nodes use a repository access token rather than a personal API token; none
requests `/user` nor lists the user's workspaces. Enter the workspace and
repository slugs explicitly. None runs OpenCode or publishes comments.

## Requirements

- A self-hosted n8n installation. The package is built against `n8n-workflow`
  2.46.5 and declares compatibility with 2.16.x–2.x; test it against your exact
  n8n version before deployment.
- A repository access token for the target repository with **Pull requests:
  Read** (and Repository: Read where required). Polling and PR context only
  need outbound HTTPS access to Bitbucket.
- For the webhook node only: **Webhooks: Read and write**, any other scopes
  required by the selected events, and an HTTPS webhook URL reachable from
  Bitbucket Cloud. Repository: Read may also be required by Bitbucket. See
  [Bitbucket's webhook scope rules](https://developer.atlassian.com/cloud/bitbucket/bitbucket-cloud-rest-api-scopes/).

## Install from npm

In self-hosted n8n, open **Settings → Community nodes → Install** and enter
`n8n-nodes-bitbucket-repo-trigger`. The polling node requires `0.2.x` or later;
the read-only PR action requires `0.3.0` or later. Event selection and agent
mentions in the polling node require `0.4.0` or later.

## Build and test

```sh
npm ci
npm test
```

`npm test` compiles the node and runs local tests with mocked Bitbucket/n8n
interfaces. It does not contact Bitbucket or install the node into n8n.

## Install without publishing (Docker)

This follows [n8n's private node installation](https://docs.n8n.io/connect/create-nodes/deploy-your-node/install-private-nodes/).
Build the package first and use the same n8n version as your existing instance:

```sh
npm ci
npm run build
docker build --build-arg N8N_VERSION=2.46.6 -t local/n8n-bitbucket-pr:2.46.6 .
```

The Dockerfile adds only the compiled node to the official image and configures
`N8N_CUSTOM_EXTENSIONS` and `NODE_PATH`. The latter points at the location used
by the official n8n image and must be rechecked when changing image versions.
Start a **separate test instance** using this image and a separate data volume;
do not overwrite the configuration or data volume of your existing n8n instance.
The existing instance can later be updated by its administrator after testing.

For a non-Docker installation, consult n8n's private-node instructions and make
the compiled `dist/nodes` and `dist/credentials` available to n8n, with
`n8n-workflow` resolvable from the n8n installation. Restart n8n after installing.

## Configure polling

1. Create or reuse a **Bitbucket Repository Token** credential containing the
   repository access token. The webhook signing secret is not required for polling.
2. Add **Bitbucket Repository PR Poll**, enter the workspace and repository
   slugs, and configure n8n's **Poll Times** (for example, every 5 minutes).
3. Select one or more **Events**. The defaults are PR created and PR updated;
   enable **Agent Mentioned in Comment** if needed. For mentions, enter an
   **Agent Name**, an **Agent Atlassian Account ID**, or both.
4. Publish/activate the workflow. By default, the first automatic poll records
   existing open PRs without emitting them. New open PRs and source or
   destination commit changes are emitted on later polls. Enable **Include
   Existing PRs on First Run** explicitly if you want all currently open PRs.
5. A manual test returns one open PR as a `poll:test` sample without saving the
   polling state. If there are no open PRs, it returns no items. A test execution
   can still run downstream nodes, so use a dry-run reviewer while testing. It
   does not test comment mentions; use an active workflow to test those.

### Polling events and mentions

| Event | When emitted |
| --- | --- |
| `pullrequest:created` | A PR appears in the open PR list, including a reopened PR |
| `pullrequest:updated` | The source or destination commit changes; metadata-only edits do not count |
| `pullrequest:comment:mention` | A new comment mentions the agent, or an existing comment is edited to add the mention |

For a textual command like `@agent`, set **Agent Name** to `agent` or `@agent`.
Matching is case-insensitive and checks the raw comment text, including code or
quoted text; it is not proof that a real Bitbucket user was tagged.

To detect an actual Bitbucket account mention, set **Agent Atlassian Account
ID**. Bitbucket stores it in raw comments as `@{account-id}`, not necessarily as
the visible display name. The account ID is not the display name, nickname or
repository token; obtain it separately with appropriate permissions. See
[Atlassian's mention documentation](https://support.atlassian.com/bitbucket-cloud/kb/how-to-mention-users-in-pull-request-comments-through-the-bitbucket-cloud-rest-api/).
Setting both fields matches either form. General, inline and reply comments are
included; deleted or pending comments are ignored until active.

On the first automatic poll, or after enabling mentions or changing the target,
existing comments are recorded without emitting mentions. The **Include Existing
PRs on First Run** option applies only to PR creation events, not old comments.
A later change to a comment that already mentioned the agent does not retrigger
unless the mention was removed and subsequently added again. Comments visible
when a newly discovered PR first appears can emit mention events; this includes
old comments on a reopened PR. A PR opened and closed between polls, or a
mention added and removed between polls, can be missed.

Mention events include the full matching comment in `body.comment`, the PR in
`body.pullrequest`, and an `event_key` based on PR ID, comment ID and update
timestamp. Use `event_key` to deduplicate mention events; `revision_key` alone
is shared by multiple mentions on the same PR revision. The node does not filter
by comment author: if the agent posts comments containing its own mention,
filter those downstream to prevent loops.

When mentions are enabled, each poll fetches every visible comment on every open
PR, up to 100 pages per PR, and stores comment IDs and match states in workflow
static data. This adds API calls and memory use. Any failed or invalid page fails
the poll without advancing state. Account permissions determine which comments
are visible. Polling and deduplication are best-effort, not exactly-once delivery.

Each item contains `event`, a deterministic `revision_key`, and the PR under
`body.pullrequest`. Metadata-only edits do not trigger an update. Polling reports
the **current** open state: a PR opened and closed between polls or intermediate
commits between polls can be missed. Changes to the target commit also count as
an update. State is stored in n8n node static data; it is not an exactly-once
guarantee and may be unreliable under concurrent/high-frequency polling or after
a crash. Downstream actions should be idempotent, deduplicate PR events using
`revision_key` and mention events using `event_key`, and confirm the PR and
commits are current before acting.

Bitbucket Cloud PR payloads may contain abbreviated 12-character commit hashes.
The `revision_key` normalizes hashes to 12-character prefixes; it is useful for
best-effort deduplication, not for securely identifying a full commit. Before
reviewing or publishing findings, resolve the actual full commit hashes and
verify them against the current PR. Prefix collisions are possible.

Polling fetches all pages, up to 100 pages of 50 PRs, before updating state.
Invalid responses or incomplete pagination fail the poll without advancing state.
Changing the workspace or repository starts a new baseline for that repository.

## Read PR context and comments

Add **Bitbucket Repository** after the polling trigger (or another node), select
**Pull Request → Get Context**, and provide the workspace slug, repository slug
and numeric PR ID. For example, the polling node's ID is available via the
expression `{{ $json.body.pullrequest.id }}`. Reuse the **Bitbucket Repository
Token** credential.

Each incoming item produces one output item, preserving its n8n item pairing:

| Field | Contents |
| --- | --- |
| `pull_request` | The complete PR object returned by Bitbucket, including description, branches and participants |
| `diff` | The full unified diff text returned by Bitbucket |
| `comments` | All pages of comments visible to the token, including general, inline and reply records, without filtering the returned fields |
| `commits` | All pages of commit records returned by Bitbucket |
| `changed_files` | All pages of Bitbucket's diffstat records, including file paths and status |
| `retrieval.commit_prefixes_unchanged` | Whether source and destination hashes were present and their visible prefixes matched before and after retrieval |

The node keeps each returned PR, comment, commit and diffstat object intact.
The diff describes changed lines; it is not the complete contents of every
file. Other endpoints such as PR activity, tasks and build statuses are not
included. API access controls still determine which comments are visible.

Comments, commits and diffstat are fully paginated, up to 100 pages each. If a
request fails, a page is malformed or the page limit is reached, the operation
fails rather than presenting incomplete data as complete. Large diffs and
comment histories can consume significant n8n memory. Bitbucket's diff and
diffstat endpoints redirect: only redirects and pagination inside the requested
Bitbucket repository are followed.

The PR is fetched again after the other data. A changed state or commit prefix
fails the operation rather than returning a known mixed result. This is a
best-effort check, not an atomic snapshot: comments and metadata can change during
retrieval, and matching abbreviated commit prefixes are not proof of full commit
identity. Resolve full commit hashes and revalidate the PR before reviewing or
publishing findings. If commit hashes are unavailable, `commit_prefixes_unchanged`
is false and must not be treated as verification.

## Configure the webhook trigger

1. Create a **Bitbucket Repository Token** credential. Enter the repository
   token, and a **separate** high-entropy webhook signing secret of at least 32
   characters. For example, generate one with `openssl rand -hex 32`; store it
   only in the n8n credential. Use a different secret for each workflow, and do
   not reuse the access token as the secret.
2. Add **Bitbucket Repository PR Trigger** to a workflow. Choose the credential,
   enter the workspace slug and repository slug from the Bitbucket URL, and
   select the PR events. The defaults are PR Created and PR Updated.
3. Use n8n's test/listen mode or activate the workflow. The node registers an
   active webhook in that repository with the signing secret. The token must
   have sufficient permissions to create, inspect, and delete webhooks.
4. Create or update a test PR and inspect the execution. The node outputs
   `event`, `delivery` and the Bitbucket payload under `body`; for example,
   `{{$json.body.pullrequest.id}}`.
5. Deactivate the workflow before changing the repository, events, webhook URL,
   token, or signing secret. The node deletes only its own tracked webhook. If
   n8n loses its static workflow data or deletion fails, inspect repository
   **Settings → Webhooks** and remove any orphan manually.

Test and production webhooks have distinct URLs; disable the test listener when
finished. If your n8n URL is not reachable by Bitbucket, webhook registration or
delivery may fail. Bitbucket may retry failed deliveries; downstream workflows
must deduplicate and confirm the current PR and its commits before taking action.

## Security and limitations

All nodes send the repository token as a Bearer token. The webhook trigger registers each
webhook with the credential's signing secret. It verifies `X-Hub-Signature`
against the exact raw request bytes and checks the tracked webhook ID before
starting the workflow; missing/invalid signatures are rejected. It does not
reconstruct a raw request from parsed JSON. The stored workflow state contains
the hook ID and a settings fingerprint, not the token or secret.

Bitbucket signs the **body**, not the headers: `event` and `delivery` are
provided for convenience and are not independently authenticated. HMAC alone
does not prevent replay or duplicate deliveries. Use HTTPS, restrict access to
n8n credentials, and re-fetch/validate PR data from Bitbucket before running an
agent or executing any consequential action. Do not execute PR-provided code
with these credentials.

The nodes support repository-level PR events only, not workspace hooks or
Bitbucket Server/Data Center. No real Bitbucket/n8n end-to-end run has been
performed for polling yet. The npm package is unverified; n8n Cloud does not
support unverified community nodes.
