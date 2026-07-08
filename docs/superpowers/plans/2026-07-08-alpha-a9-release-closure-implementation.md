# ArchiveLens Desktop Alpha A9 Mandatory Release Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the A3-A8 lifecycle and release gap by making lifecycle E2E, recovery integrity, clean worktree reproducibility, and same-SHA Setup/Portable validation all pass before any alpha.9 release freeze.

**Architecture:** Keep the existing Electron main process, preload bridge, Python sidecar, and Playwright stack. Add a strictly gated E2E control surface under `ARCHIVELENS_E2E=1`, move shutdown/tray lifecycle coordination into testable modules, persist enough task/runtime state to verify resume integrity, then use the same candidate SHA for dev verification, clean worktree verification, and final package smoke.

**Tech Stack:** Electron 31, electron-vite, Playwright, Vitest, TypeScript, Python unittest, SQLite, PyInstaller, PowerShell.

## Global Constraints

- Do not add business features.
- Do not prioritize repackaging before lifecycle E2E passes.
- Do not freeze a candidate SHA before lifecycle E2E and full dev validation pass.
- Do not generate final Setup/Portable before clean worktree validation passes.
- Do not modify source inside the clean worktree.
- Keep all E2E control channels disabled unless `ARCHIVELENS_E2E=1`.
- Use Zod validation for every E2E control payload and response.
- Preserve production preload exposure limits.
- Treat any residual `ArchiveLens.exe` or `archivelens-engine.exe` as a test failure.

---

### Task 1: Map lifecycle control boundaries and lock failing tests first

**Files:**
- Modify: `apps/desktop/tests/preload.spec.ts`
- Modify: `apps/desktop/tests/contract.spec.ts`
- Create: `apps/desktop/tests/lifecycleController.spec.ts`
- Create: `apps/desktop/tests/e2eBridge.spec.ts`

**Interfaces:**
- Consumes: current preload bridge, current main shutdown flow, current sidecar event contract
- Produces: failing tests for gated E2E bridge registration, allowed action enums, timeout branch semantics, tray/window/task state queries

- [ ] **Step 1: Add preload test that production mode exposes no test bridge**
- [ ] **Step 2: Add preload test that E2E mode exposes only the approved lifecycle and tray methods**
- [ ] **Step 3: Add main-process unit tests for close actions `minimize`, `cancel`, `pause_and_quit`, `stop_and_quit`, `continue_waiting`, and `force_quit`**
- [ ] **Step 4: Add main-process unit tests for timeout branch dedupe, shutdown flow reset, and no duplicate pause requests**
- [ ] **Step 5: Run desktop Vitest target and confirm RED before implementation**

### Task 2: Extract testable lifecycle controller and tray/window state accessors

**Files:**
- Create: `apps/desktop/src/main/lifecycle/controller.ts`
- Create: `apps/desktop/src/main/lifecycle/types.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Modify: `apps/desktop/src/main/tray.ts`
- Modify: `apps/desktop/src/main/windows/main.ts`

**Interfaces:**
- Consumes: `SidecarManager`, `BrowserWindow`, `Tray`, `dialog`, app quit flow
- Produces: a testable lifecycle controller with explicit state, action selection, timeout handling, and tray/window visibility accessors

- [ ] **Step 1: Move shutdown flow state and close-action handling out of `src/main/index.ts` into a controller**
- [ ] **Step 2: Add read-only accessors for tray singleton state and window visible/focused state**
- [ ] **Step 3: Add controller support for continue waiting, cancel exit, and force quit timeout branches**
- [ ] **Step 4: Add structured logging for every E2E-visible lifecycle transition**
- [ ] **Step 5: Re-run lifecycle controller unit tests and get GREEN**

### Task 3: Add strictly gated E2E control bridge

**Files:**
- Create: `apps/desktop/src/main/ipc/e2e.ts`
- Modify: `apps/desktop/src/main/ipc/index.ts`
- Modify: `apps/desktop/src/preload/api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `packages/ipc-schema/src/index.ts`

**Interfaces:**
- Consumes: lifecycle controller, tray/window accessors, sidecar manager, task APIs
- Produces: `window.archiveLens.test.*` bridge in E2E mode only, with Zod-validated payloads and fixed method whitelist

- [ ] **Step 1: Define Zod schemas for each approved E2E method and action enum**
- [ ] **Step 2: Register E2E IPC handlers only when `ARCHIVELENS_E2E=1`**
- [ ] **Step 3: Expose preload `test.lifecycle`, `test.tray`, `test.window`, `test.engine`, and `test.task` namespaces only in E2E mode**
- [ ] **Step 4: Add production-mode regression tests proving the bridge is absent**
- [ ] **Step 5: Re-run preload and bridge tests and get GREEN**

### Task 4: Persist and surface recovery-integrity evidence from the engine

**Files:**
- Modify: `engine/src/archivelens_engine/server.py`
- Modify: `engine/src/archivelens_engine/db/store.py`
- Modify: `engine/src/archivelens_engine/runtime/task_state.py`
- Create: `engine/tests/test_lifecycle_recovery.py`

**Interfaces:**
- Consumes: existing task store, slowfake loop, event emission, task control
- Produces: queryable processed page ids, occurrence ids, checkpoint page, task status, worker status, engine pid, heartbeat, event sequence, and recoverable status on crash/force-quit

- [ ] **Step 1: Add failing engine tests for processed page ids, event sequence monotonicity, and recoverable crash/force-quit status**
- [ ] **Step 2: Extend slowfake runtime to persist processed page ids and deterministic occurrence ids**
- [ ] **Step 3: Add task/query handlers needed by the E2E bridge without opening arbitrary engine methods**
- [ ] **Step 4: Mark sidecar crash and shutdown edge cases with stable error codes**
- [ ] **Step 5: Run focused Python unittest targets and get GREEN**

### Task 5: Build lifecycle Playwright suite for stage A

**Files:**
- Replace: `apps/desktop/e2e/vertical.spec.ts`
- Create: `apps/desktop/e2e/helpers/appHarness.ts`
- Create: `apps/desktop/e2e/helpers/assertions.ts`
- Modify: `apps/desktop/playwright.config.ts`

**Interfaces:**
- Consumes: gated preload E2E bridge, real desktop window, real tray lifecycle, slowfake engine mode
- Produces: 5 main lifecycle scenarios, 3 timeout branches, pause-at-1/3/10/19 resume matrix, and crash resume coverage with retained evidence on failure

- [ ] **Step 1: Set Playwright evidence policy to `trace: retain-on-failure`, `screenshot: only-on-failure`, `video: retain-on-failure`**
- [ ] **Step 2: Add shared Electron harness that launches with isolated `userData`, `ARCHIVELENS_E2E=1`, slowfake parameters, and log capture**
- [ ] **Step 3: Write failing tests for tray minimize/restore, cancel close, pause-exit-recover, stop-exit, and sidecar crash recover**
- [ ] **Step 4: Add timeout branch tests and pause-point parameterized restart-resume tests**
- [ ] **Step 5: Run stage A Playwright suite, iterate until all lifecycle assertions pass**

### Task 6: Run full dev-worktree validation and only then bump alpha.9

**Files:**
- Modify: version-bearing files after validation only
- Modify: any docs/scripts touched by lifecycle release chain work

**Interfaces:**
- Consumes: passing stage A suite and existing build/test scripts
- Produces: validated dev worktree, version `0.1.0-alpha.9`, clean candidate SHA

- [ ] **Step 1: Run Python compile/unit tests, TS typecheck/lint/unit/contract/build, lifecycle E2E, HTML smoke, OCR shutdown, concurrency, and rollback regressions**
- [ ] **Step 2: Search and update runtime references from `alpha.8` to `alpha.9` only after all dev validations pass**
- [ ] **Step 3: Re-run targeted validation for version metadata and release naming**
- [ ] **Step 4: Confirm clean working tree and freeze `ALPHA9_CANDIDATE_SHA`**

### Task 7: Reproduce from a clean worktree without source edits

**Files:**
- Modify: `scripts/verify-release-chain.ps1`
- Modify: build/smoke scripts as needed in the dev worktree before candidate freeze

**Interfaces:**
- Consumes: candidate SHA, worktree tooling, clean dependency installs
- Produces: same-SHA clean worktree verification, clean Engine SHA, clean win-unpacked SHA, same-hash packaged engine

- [ ] **Step 1: Create `../ArchiveLens-alpha9-clean` at the frozen candidate SHA**
- [ ] **Step 2: Reinstall Node and Python dependencies from lock files only**
- [ ] **Step 3: Run the full clean source validation matrix with lifecycle E2E and HTML smoke**
- [ ] **Step 4: Build clean Engine and clean win-unpacked, record hashes, and verify embedded commit metadata**
- [ ] **Step 5: Stop immediately on any failure, return to dev worktree for fixes, and re-freeze a new candidate**

### Task 8: Generate Setup/Portable once and verify the full release chain

**Files:**
- Modify: `scripts/smoke-installer.ps1`
- Modify: `scripts/smoke-portable.ps1`
- Modify: `scripts/generate-manifest.py`
- Modify: `scripts/verify-release-chain.ps1`

**Interfaces:**
- Consumes: clean worktree pass, clean Engine SHA, clean win-unpacked SHA, frozen candidate SHA
- Produces: one same-SHA Setup, one same-SHA Portable, release manifest, release-chain verification, final package smoke evidence

- [ ] **Step 1: Generate NSIS setup and portable only after clean gate success**
- [ ] **Step 2: Expand installer and portable smoke to cover packaged OCR, tray minimize/restore, pause-exit, restart recover, review persistence, JSON export, HTML export, and uninstall/exit residue**
- [ ] **Step 3: Verify setup/portable embedded engine hash equals clean engine hash**
- [ ] **Step 4: Run release-chain verification and fail on commit or hash mismatch**
- [ ] **Step 5: Record final evidence paths and report PASS only if every gate succeeds**
