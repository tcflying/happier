# Happier Direct Session CLI Ensure Implementation Plan

> **For implementation:** Use `superpowers:executing-plans` to execute this plan task by task. Follow RED-GREEN-REFACTOR and commit after each completed task.

**Goal:** Add a stable, machine-readable `happier direct-session ensure --uri <native-session-uri> --json` command that discovers an existing Codex, Claude Code, or OpenCode session on the connected Windows daemon, idempotently links it into Happier, and returns the canonical Happier session URL and identifiers.

**Architecture:** Keep discovery, credentials, provider-specific parsing, and link creation inside the authenticated Happier daemon. The CLI parses only the public command surface and calls a new authenticated local control endpoint. The daemon reuses the existing Direct Session provider catalog and `ensureDirectSessionLink`; no transcript is copied into Fusion and no second Happier database is introduced. The first implementation is scoped to the daemon machine running the command. An optional `--machine-id` is an exact guard, not an unimplemented remote-machine router.

**Tech stack:** TypeScript, Commander-style Happier CLI registry, Fastify daemon control server, Zod Direct Session protocol types, Vitest, Yarn workspaces.

**Source design:** `G:\codex-project\fusion\.worktrees\happier-runtime\docs\superpowers\specs\2026-07-15-happier-existing-session-task-binding-design.md`

---

## Public contract and invariants

The command must accept these canonical URI forms:

```text
codex://threads/<thread-id>
claude://sessions/<session-id>
opencode://sessions/<session-id>
```

Success is a single JSON envelope on stdout:

```json
{
  "v": 1,
  "ok": true,
  "kind": "direct_session_ensure",
  "data": {
    "providerId": "codex",
    "remoteSessionId": "019f22f6-6581-7781-bb37-84cf4d63d81d",
    "machineId": "machine-id",
    "sessionId": "happier-session-id",
    "serverId": "server-profile-id",
    "created": false,
    "openUrl": "http://127.0.0.1:18287/session/happier-session-id?serverId=server-profile-id"
  }
}
```

Errors use the existing JSON envelope and one of these stable codes:

```text
invalid_uri
unsupported_provider
daemon_unavailable
machine_mismatch
auth_required
candidate_not_found
candidate_ambiguous
link_failed
```

Required invariants:

- stdout contains only the JSON envelope when `--json` is supplied; diagnostics go to stderr.
- The exact native session ID is matched. A fuzzy search result is never accepted as identity proof.
- Repeating the same ensure request returns the same Happier `sessionId`; `created` changes from `true` to `false` as appropriate.
- `openUrl` is built from the active Happier web URL and server profile at response time. It is not stored as durable session state.
- The command never sends a prompt, starts a model turn, changes the native session, or creates a new native session.
- `--machine-id` must equal the local daemon's registered machine ID. Remote routing is outside this change.

## Task 1: Lock the URI, candidate-selection, and URL contracts

**Files:**

- Create: `apps/cli/src/cli/commands/directSession/contract.ts`
- Create: `apps/cli/src/cli/commands/directSession/contract.test.ts`

### Step 1: Write the failing contract tests

Cover all three providers, malformed URIs, unsupported schemes, exact candidate selection, zero/multiple exact matches, machine mismatch, URL encoding, and stable error codes.

The tests should exercise a public contract shaped like:

```ts
export type DirectSessionTarget = {
  providerId: 'codex' | 'claude' | 'opencode';
  remoteSessionId: string;
  source: DirectSessionsSource;
};

export function parseDirectSessionUri(uri: string): DirectSessionTarget;

export function selectExactDirectSessionCandidate(input: {
  candidates: DirectSessionCandidate[];
  remoteSessionId: string;
}): DirectSessionCandidate;

export function assertRequestedMachine(input: {
  requestedMachineId?: string;
  daemonMachineId: string;
}): void;

export function buildDirectSessionOpenUrl(input: {
  webappUrl: string;
  serverId: string;
  sessionId: string;
}): string;
```

Provider defaults must be explicit:

```ts
codex    -> { kind: 'codexHome', home: 'user' }
claude   -> { kind: 'claudeConfig' }
opencode -> { kind: 'opencodeServer' }
```

Run:

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/cli/commands/directSession/contract.test.ts
```

Expected RED: Vitest fails because `contract.ts` and its exports do not exist.

### Step 2: Implement the smallest pure contract

Implement a typed `DirectSessionEnsureError` carrying the stable code and an operator-readable message. Normalize trailing slashes in `webappUrl`, and URL-encode both path and query values.

Do not accept aliases such as bare UUIDs or provider names in this first contract. Reject whitespace-only or pathless URIs.

### Step 3: Re-run the focused test

Run the same command.

Expected GREEN: all contract tests pass with no snapshot updates.

### Step 4: Commit

```powershell
rtk git add apps/cli/src/cli/commands/directSession/contract.ts apps/cli/src/cli/commands/directSession/contract.test.ts
rtk git commit -m "feat(cli): define direct session ensure contract"
```

## Task 2: Add the daemon-owned ensure service

**Files:**

- Create: `apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.ts`
- Create: `apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.test.ts`
- Reference: `apps/cli/src/api/machine/rpcHandlers.directSessions.ts`
- Reference: `apps/cli/src/api/directSessions/linking/ensureDirectSessionLink.ts`
- Reference: `apps/cli/src/backends/catalog.ts`

### Step 1: Write failing service tests

Inject provider discovery and linking dependencies so the unit test does not need a live daemon or provider. Pin these behaviors:

- parses URI and queries only its provider;
- searches by the exact native ID, then rejects non-exact fuzzy results;
- maps zero exact matches to `candidate_not_found`;
- maps more than one exact match to `candidate_ambiguous` and includes only safe candidate metadata;
- forwards the selected provider, source, native ID, title, and directory hint to `ensureDirectSessionLink`;
- returns the daemon machine ID and the link result;
- calls the link function exactly once;
- a repeated ensure delegates to the existing idempotent link function rather than creating a second link;
- never invokes provider start/send methods.

Use an injectable function boundary:

```ts
export type EnsureDirectSessionFromUriDeps = {
  listCandidates: (input: {
    providerId: DirectSessionProviderId;
    source: DirectSessionsSource;
    searchTerm: string;
  }) => Promise<DirectSessionCandidate[]>;
  ensureLink: typeof ensureDirectSessionLink;
};

export async function ensureDirectSessionFromUri(
  input: {
    uri: string;
    requestedMachineId?: string;
    machineId: string;
    credentials: Credentials;
    codexBackendMode: CodexBackendMode;
  },
  deps?: EnsureDirectSessionFromUriDeps,
): Promise<DirectSessionEnsureServiceResult>;
```

Run:

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/api/directSessions/ensure/ensureDirectSessionFromUri.test.ts
```

Expected RED: module not found or missing service export.

### Step 2: Implement by reusing existing Direct Session internals

Use `getDirectSessionProviderOps(providerId).listCandidates(...)` for the default discovery dependency and `ensureDirectSessionLink(...)` for linking. Reuse the same credential, runtime descriptor, title hint, and directory hint semantics already used by `rpcHandlers.directSessions.ts`.

The implementation must not duplicate provider transcript parsing, encryption, API calls, or link tag generation. Candidate metadata must stay in memory and must not be emitted unless needed for a typed ambiguity error.

### Step 3: Re-run the service test

Expected GREEN: every provider and failure branch passes.

### Step 4: Run adjacent Direct Session tests

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/api/machine/rpcHandlers.directSessions.test.ts src/api/directSessions/linking/ensureDirectSessionLink.test.ts src/api/directSessions/ensure/ensureDirectSessionFromUri.test.ts
```

Expected GREEN: `rpcHandlers.directSessions.test.ts`, `ensureDirectSessionLink.test.ts`, and the new service test all pass without changing existing snapshots.

### Step 5: Commit

```powershell
rtk git add apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.ts apps/cli/src/api/directSessions/ensure/ensureDirectSessionFromUri.test.ts
rtk git commit -m "feat(cli): ensure existing direct sessions in daemon"
```

## Task 3: Expose an authenticated daemon control endpoint and client

**Files:**

- Modify: `apps/cli/src/daemon/controlServer.ts`
- Modify: `apps/cli/src/daemon/controlClient.ts`
- Modify: `apps/cli/src/daemon/startDaemon.ts`
- Create: `apps/cli/src/daemon/controlServer.directSessionEnsure.test.ts`
- Create: `apps/cli/src/daemon/controlClient.directSessionEnsure.test.ts`

### Step 1: Write failing control-server tests

Add a `POST /direct-session/ensure` contract protected by the existing control token. Test:

- no token returns the existing unauthorized response;
- invalid body returns a typed 400 response;
- valid `{uri, machineId?}` calls the injected handler once;
- stable service errors preserve their error code and map to a non-500 status;
- unexpected errors become `link_failed` without a stack trace or credentials;
- response contains no prompt/transcript body.

The injected server dependency should be explicit:

```ts
ensureDirectSession: (input: {
  uri: string;
  requestedMachineId?: string;
}) => Promise<DirectSessionEnsureControlResult>;
```

Run:

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/daemon/controlServer.directSessionEnsure.test.ts
```

Expected RED: the route returns 404 or the server dependency is not accepted.

### Step 2: Implement the server route and daemon wiring

In `startDaemon.ts`, build the injected handler from the live machine ID, credentials, backend mode, and `ensureDirectSessionFromUri`. Keep the route under the control server's existing `requireAuth` hook.

Do not start a separate HTTP server or expose the endpoint beyond the current daemon control listener.

### Step 3: Write the failing control-client tests

Add:

```ts
export async function ensureDaemonDirectSession(input: {
  uri: string;
  machineId?: string;
}): Promise<DirectSessionEnsureControlResult>;
```

Test exact POST path/body, control token use through `daemonPost`, unavailable-daemon mapping, typed server errors, and successful JSON parsing.

Run:

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/daemon/controlClient.directSessionEnsure.test.ts
```

Expected RED: missing export.

### Step 4: Implement the client through `daemonPost`

Do not read daemon state or token a second way. Reuse `daemonPost` so token, timeout, and daemon-unavailable behavior remain consistent with `listDaemonSessions` and `spawnDaemonSession`.

### Step 5: Run focused server/client tests

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/daemon/controlServer.directSessionEnsure.test.ts src/daemon/controlClient.directSessionEnsure.test.ts src/daemon/controlServer.list.test.ts src/daemon/controlServer.spawnSession.test.ts
```

Expected GREEN: new endpoint and adjacent control routes pass.

### Step 6: Commit

```powershell
rtk git add apps/cli/src/daemon/controlServer.ts apps/cli/src/daemon/controlClient.ts apps/cli/src/daemon/startDaemon.ts apps/cli/src/daemon/controlServer.directSessionEnsure.test.ts apps/cli/src/daemon/controlClient.directSessionEnsure.test.ts
rtk git commit -m "feat(daemon): expose direct session ensure endpoint"
```

## Task 4: Register the public CLI command and JSON output

**Files:**

- Create: `apps/cli/src/cli/commands/directSession.ts`
- Create: `apps/cli/src/cli/commands/directSession.test.ts`
- Modify: `apps/cli/src/cli/commandRegistry.ts`
- Modify: `apps/cli/src/cli/commandSurfaceManifest.ts`
- Modify: `apps/cli/src/cli/commandSurfaceManifest.test.ts`
- Modify: `apps/cli/src/cli/commandRegistry.installSelfUpdate.test.ts`

### Step 1: Write failing command tests

Pin the command grammar:

```text
happier direct-session ensure --uri <uri> [--machine-id <id>] --json
```

Test:

- missing subcommand and missing `--uri` produce usage exit code 2;
- `--json` success writes exactly one `direct_session_ensure` envelope to stdout;
- human mode prints provider, native ID, Happier ID, machine ID, and open URL without secrets;
- stable control errors map to JSON error envelopes and exit code 1;
- server/profile flags continue to be handled by `applyServerSelectionFromArgs`;
- root help lists `direct-session`;
- `allowTmux` is false;
- registry tests include the new command without changing install/self-update behavior.

Run:

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/cli/commands/directSession.test.ts src/cli/commandSurfaceManifest.test.ts src/cli/commandRegistry.installSelfUpdate.test.ts
```

Expected RED: command/manifest entry missing.

### Step 2: Implement the command handler

Follow the dependency-injection and output patterns in `apps/cli/src/cli/commands/machine.ts`:

```ts
export async function handleDirectSessionCliCommand(
  context: DirectSessionCliCommandContext,
  deps: DirectSessionCliCommandDeps = defaultDeps,
): Promise<void>;
```

Call `ensureDaemonDirectSession`, then enrich the daemon result with:

- `configuration.activeServerId` as `serverId`;
- `configuration.webappUrl` and `buildDirectSessionOpenUrl(...)` as `openUrl`.

Use `printJsonEnvelope` and `mapUnknownErrorToControlError`. Never prepend logs to JSON stdout.

### Step 3: Register the command surface

Add `'direct-session'` to `commandRegistry.ts` and the root manifest with `allowTmux: false`. Preserve the current root command ordering convention.

### Step 4: Run the focused tests

Run the Step 1 command again.

Expected GREEN: command, help surface, tmux policy, and registry tests pass.

### Step 5: Commit

```powershell
rtk git add apps/cli/src/cli/commands/directSession.ts apps/cli/src/cli/commands/directSession.test.ts apps/cli/src/cli/commandRegistry.ts apps/cli/src/cli/commandSurfaceManifest.ts apps/cli/src/cli/commandSurfaceManifest.test.ts apps/cli/src/cli/commandRegistry.installSelfUpdate.test.ts
rtk git commit -m "feat(cli): add direct-session ensure command"
```

## Task 5: Verify the complete Happier CLI surface

**Files:**

- Modify only if failures prove necessary: files changed in Tasks 1-4

### Step 1: Run focused Direct Session and command tests

```powershell
rtk corepack yarn workspace @happier-dev/cli vitest run --config vitest.config.ts src/cli/commands/directSession src/api/directSessions/ensure src/daemon/controlServer.directSessionEnsure.test.ts src/daemon/controlClient.directSessionEnsure.test.ts src/cli/commandSurfaceManifest.test.ts src/cli/commandRegistry.installSelfUpdate.test.ts
```

Expected: all selected tests pass.

### Step 2: Run CLI type checking and import-cycle checks

```powershell
rtk corepack yarn workspace @happier-dev/cli typecheck
rtk corepack yarn workspace @happier-dev/cli test:import-cycles
```

Expected: both commands exit 0 with no TypeScript errors or new import cycle.

### Step 3: Run the CLI unit suite

```powershell
rtk corepack yarn workspace @happier-dev/cli test:unit
```

Expected: suite exits 0. Record any pre-existing unrelated failure separately; do not weaken or skip the new tests.

### Step 4: Verify public help and invalid-input JSON manually

Use the repository's normal CLI dev entrypoint, then run:

```powershell
rtk happier direct-session --help
rtk happier direct-session ensure --uri invalid://value --json
```

Expected:

- help shows `ensure`, `--uri`, `--machine-id`, and `--json`;
- invalid URI produces one JSON error envelope with `invalid_uri` and non-zero exit;
- there is no daemon mutation for invalid input.

### Step 5: Route any failure back to its owning task

No verification-only commit is planned. If a command fails, return to Task 1, 2, 3, or 4, add a focused regression test, make the minimum correction in that task's named files, repeat that task's test command, and use that task's scoped `git add` list. Do not create an empty commit.

## Task 6: Perform the real Windows idempotency proof

**Files/evidence:**

- Create: `docs/superpowers/evidence/2026-07-15-direct-session-cli-ensure.md`

### Step 1: Preflight the real local service

```powershell
rtk happier doctor --json
rtk happier auth status --json
```

Expected: active server/profile and authenticated account are explicit; daemon control is reachable. If not, start the repository's existing Windows development service and repeat. Do not switch servers or rewrite credentials silently.

### Step 2: Ensure the exact target session twice

```powershell
rtk happier direct-session ensure --uri codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d --json
rtk happier direct-session ensure --uri codex://threads/019f22f6-6581-7781-bb37-84cf4d63d81d --json
```

Expected:

- both envelopes are successful;
- `providerId=codex` and `remoteSessionId` exactly equal the requested values;
- both return the same `machineId`, `serverId`, `sessionId`, and `openUrl`;
- the first may return `created=true`; the second must return `created=false` once the link already exists;
- no prompt is sent and the native task state is unchanged.

### Step 3: Verify the returned browser route

Open exactly the returned `openUrl`. Confirm that Happier shows the target native Codex transcript and that the URL contains the returned Happier `sessionId` and `serverId`.

Do not claim same-session proof from URL shape alone: record the visible native session identifier or provider metadata from the Happier UI/API.

### Step 4: Record evidence without secrets

Create the evidence file with:

- China Standard Time timestamp;
- Git commit SHA;
- command and exit code;
- provider/native/machine/server/Happier session IDs;
- first/second `created` values;
- exact open URL with no token;
- proof that no prompt was sent;
- any blocker with original error text.

### Step 5: Commit the evidence

```powershell
rtk git add docs/superpowers/evidence/2026-07-15-direct-session-cli-ensure.md
rtk git commit -m "test(cli): prove direct session ensure idempotency"
```

## Completion gate

This plan is complete only when all of the following are true:

- the three URI forms and all stable errors are unit-tested;
- the daemon endpoint is authenticated and owns discovery/linking;
- the CLI emits a clean JSON envelope and appears in root help;
- focused tests, typecheck, import-cycle checks, and the CLI suite pass;
- the exact target Codex URI is ensured twice with the same Happier session ID;
- the returned Happier page visibly corresponds to that native session;
- no native prompt or unrelated project work was triggered.
