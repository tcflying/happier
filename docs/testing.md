# Testing

This document records the repository-level test lane map and placement conventions. For workflow details, use the repo skill `skills/happier-testing` and the development guide at `apps/docs/content/docs/development/testing.mdx`.

## Top-level lanes

Canonical lanes:

- `yarn test` — fast unit lane across apps.
- `yarn test:import-cycles` — CLI runtime import-cycle guard, also enforced by the CLI unit lane.
- `yarn test:integration` — orchestration-heavy app integration lane.
- `yarn test:e2e:core:fast` — default local core e2e loop.
- `yarn test:e2e:core:slow` — long orchestration core e2e.
- `yarn test:e2e:ui` — Playwright UI/browser e2e exercising real UI + server + CLI/daemon flows.
- `yarn test:providers` — provider contracts; opt-in/flag-driven.
- `yarn test:db-contract:docker` — server DB contract via Docker.

Use the smallest relevant subset during RED/GREEN loops. Before handoff, run the touched package typecheck/build-enforcing lane and at least one broader relevant lane when shared contracts are touched.

## Lane naming and placement

- App integration tests: `*.integration.test.*`, `*.integration.spec.*`, `*.real.integration.test.*`.
- Core e2e slow tests: `packages/tests/suites/core-e2e/**/*.slow.e2e.test.ts`.
- Core e2e fast tests: other `packages/tests/suites/core-e2e/**/*.test.ts`.
- UI Playwright e2e: `packages/tests/suites/ui-e2e/**/*.spec.ts`.
- Provider/stress suites remain under `packages/tests/suites/providers` and `packages/tests/suites/stress`.

Treat `test` and `test:unit` as fast lanes. Put Dockerized dependencies, multiprocess setups, external services, real network calls, or other heavy orchestration into integration/e2e/provider lanes.

## CLI focused tests while a development service is live

Run an explicit CLI test file with `yarn --cwd apps/cli test:focused src/example.test.ts`.
This lane uses existing bundled workspace artifacts, gives Vitest a unique cache/report/temp directory, and never rebuilds the live CLI or shared `dist` directories. If the required bundled artifacts are missing, build them before starting the service; the focused lane fails with the missing paths instead of attempting a build.

The standard `yarn workspace @happier-dev/cli test:unit` lane is also read-only with respect to `packages/cli-common/dist`: global setup validates existing artifacts, and the unit wrapper hashes that directory before and after the run and fails if any file changes. CI builds shared artifacts once in an explicit pre-test step, then runs the same guarded unit command. A passing unit or focused run is test evidence only; it is not a live daemon/provider E2E.

When introducing or moving a lane/pattern, update all relevant places in the same change:

1. package-level scripts/config,
2. root `package.json` lane scripts,
3. CI workflow wiring.

## UI e2e authoring

- Prefer stable React Native `testID` selectors, queried in Playwright with `getByTestId(...)`.
- Treat e2e `testID`s as API surface; update specs when renaming/removing them.
- Wait for controls to be enabled before clicking.
- Click the real submit/confirm affordance.
- Do not rely on settings-sensitive shortcuts such as Enter-to-send unless the test explicitly configures that setting.
- UI e2e artifacts live under `packages/tests/.project/logs/e2e/ui-playwright/`.
- UI e2e runtime process logs live under `.project/logs/e2e/*ui-e2e*/`.

## Guardrails

- No `.skip`, `.todo`, `.only`, or hidden conditional skips in committed tests unless an explicit opt-in external probe documents the gate.
- No debugging logs in tests.
- No duplicate test intent.
- Evidence must come from trusted runners, not fabricated/manual output.
- Prefer contract-focused assertions over copy/formatting assertions.
