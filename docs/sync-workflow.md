# Talker Family — Git Synchronization Workflow

**Status:** Reviewed runbook; initial local setup approved 2026-10-11
**Policy:** Release-level adoption downstream; selective feature promotion upstream
**Companion document:** `docs/talker-architecture.md`

## 1. Safety preflight (every structural or sync operation)

1. Identify the repository and branch. Inspect `git status`, `git remote -v`, branches, tags, and recent Git history.
2. Confirm that the working tree is clean, or explicitly agree how outstanding changes will be handled. Preserve user work.
3. Confirm the exact source release/commit and destination repository. Check ancestry before merging.
4. Create a descriptive temporary integration branch. Avoid operations directly on a protected main branch.
5. Confirm how to build, test, and locally run the application; check whether existing Talker deployments are automatically triggered by merges/pushes.
6. Do not push or change deployments without explicit permission.

Read-only example inspection commands (adjust to the actual repository and PowerShell environment):

```bash
git status --short --branch
git remote -v
git branch -avv
git tag --list
git log -6 --oneline --decorate
```

## 2. Initial setup: separate Vanilla without disturbing Talker

**Do not execute until a project-specific plan is reviewed.** Codex should first verify:

- Which current Talker commit is the known-good starting revision.
- Whether the working tree has local or uncommitted changes.
- How existing `origin`, branches, tags, CI, deployment hooks, and Git history are configured.
- Whether any files or history contain credentials or deployment-specific material.
- Whether `AGENTS.md` and project documentation already exist, so instructions can be **merged**, not overwritten.

Expected result of the approved setup:

1. A separate local **Vanilla Talker** Git repository with a **full-history clone**, not a GitHub template or unrelated `git init` history. Do not use a shallow clone.
2. An initial validated annotated release tag, suggested `vanilla/v1.0.0`, on the agreed working-baseline commit.
3. A clean, independent Vanilla `main` with its own development future. Critically, its push remote must **not** point back to Talker's existing repository.
4. Existing Talker stays where it is, with its previous `origin` and deployment unaffected.
5. Add a fetch remote named `vanilla` to Talker only when approved; it may point to the local Vanilla path. No GitHub remote is mandatory.
6. Verify shared ancestry, that both applications can run locally, and that no unapproved pushes or deployments occurred.

Do **not** overwrite the original Talker repository in order to make Vanilla. Don't reset, rebase, or rewrite its commits to establish the relationship. A fresh full-history copy is sufficient to create common ancestry.

## 3. Release Vanilla

1. Finish accepted general-purpose work on Vanilla and integrate it into Vanilla's main branch.
2. Run automated checks available in this repository; build and smoke-test the local app.
3. Review breaking changes, descendant extension points, and any necessary migrations.
4. Prepare brief release notes.
5. Create an **annotated** tag such as `vanilla/v1.1.0` pointing to the validated release commit.
6. Treat the tag as immutable. Pushing or publishing it needs authorization if a hosted remote is later configured.

Illustrative command (only once validated):

```bash
git tag -a vanilla/v1.1.0 -m "Vanilla Talker v1.1.0"
```

## 4. Adopt a full Vanilla release in one descendant

1. Choose the desired Vanilla release; read notes and migration requirements.
2. Verify status is clean and fetch the selected release tag from the `vanilla` remote.
3. Create an integration branch from the descendant's own current main branch.
4. **Merge the tagged release** (not arbitrary Vanilla `main`, and not a list of hand-picked upstream commits).
5. Handle merge conflicts manually and preserve descendant-specific behavior. If conflicts are complex, stop and request review.
6. Build, test, and smoke-test the descendant, particularly specializations and interfaces touched by upstream.
7. Review the diff, then merge the integration branch to the descendant's main **only after approval**. Pushing may trigger the existing app's deployment; require separate authorization.
8. Record the adopted release in the integration PR/merge commit or a short documented compatibility record.

Illustrative Git sequence (placeholders; **not a command to run now**):

```bash
# From the descendant's working tree; after confirming clean state.
# The explicit namespaced tag refspec avoids collisions with the descendant's tags.
git fetch vanilla --no-tags "refs/tags/vanilla/v1.1.0:refs/tags/vanilla/v1.1.0"
git switch -c integrate/vanilla-v1.1.0
git merge --no-ff refs/tags/vanilla/v1.1.0
# Run the project's actual build/tests, inspect diff, request approval.
```

If the tag was already fetched, first verify it still points at the expected immutable release. Do not overwrite a conflicting tag. Branch creation/merge behavior must be adapted to the actual branch protection settings.

**Skipping releases:** A descendant can adopt `vanilla/v1.3.0` even if it currently only includes the history through `vanilla/v1.0.0`; the merge takes in the intervening Vanilla work too. Review the combined changes and migration notes.

## 5. Promote a descendant feature to Vanilla

1. Identify a **general-purpose** improvement. Keep the specialized behavior in the descendant.
2. Locate the smallest coherent change set; prefer focused commits and independent code over mixed feature bundles.
3. Create a Vanilla promotion branch from current Vanilla main.
4. Depending on coupling, cherry-pick the relevant commit(s) **or** reimplement/adapt the functionality in Vanilla. Git history is not a guarantee of clean transfer.
5. Verify Vanilla runs independently, with appropriate tests; update release notes and any relevant extension documentation.
6. Review and integrate the promotion into Vanilla; publish it through a future Vanilla release.
7. Record source commit(s) or source PR in the Vanilla commit or review notes. For clean cross-repo cherry-picks `git cherry-pick -x <commit>` can preserve origin information, but ancestry is **not** shared for the newly created commit.
8. When the originating descendant later adopts the Vanilla release, inspect for logically duplicated changes, possible conflicts, or empty/redundant patches. Do not assume Git will reconcile them automatically.

## 6. Conflict and recovery discipline

- Do not force a merge with `-X ours` or `-X theirs` without examining every consequence.
- No `git reset --hard`, forced pushes, tag rewrites, or deleting user's work as an automatic conflict-resolution strategy.
- If a merge conflicts, collect the file list and explain the alternatives. Resolve in the integration branch with tests, or abort the attempted merge when appropriate and authorized.
- When conflicts recur, improve extension points in Vanilla rather than adding brittle automatic resolution scripts.
- Preserve a clear record of adopted Vanilla releases, especially after promotions from a descendant.

## 7. Versioning and change types

- **Patch:** compatible bug fixes.
- **Minor:** compatible new general-purpose features and extension points.
- **Major:** intentional incompatible changes, with migration guidance.
- The version is not a promise that a descendant with extensive core modifications will upgrade conflict-free.

## 8. Codex operating contract

Codex must read `AGENTS.md` and the architecture document before changing structure or synchronization procedures. For any repository action, describe the intent, exact target, impact, verification, and recovery option. The initial read-only audit is complete; the owner approved its local implementation plan on 2026-10-11. Later operations still require authorization appropriate to their scope.

## 9. Approved initial setup: inspected paths and commands

- Talker: `C:\Users\szala\Combine\Talker`; local `main` tracks `origin/main`, with origin `https://github.com/szlaci3/talker.git`.
- Application starting revision: `8c36eab99fe407e275ace4f30c3e5a6a0bc62aaa`; 76 reachable commits, non-shallow, no existing release tags. Only `talker-handoff/` was untracked at inspection.
- Vanilla: `C:\Users\szala\Combine\VanillaTalker`; independent local `main`, no hosted remote, no deployment.
- Remote freshness and GitHub's default branch were not established: the read-only remote lookup failed. Local origin/main is an inspection snapshot, not proof of current remote state. Hosted deployment hooks were not inspected.
- No application code, dependency versions, or deployment configuration changes are part of this setup. No push is authorized; this overrides the ordinary Talker end-of-turn push rule for foundation setup.

Integrate the permanent documents once on `codex/talker-foundation-docs`, preserving existing agent instructions and README content. Clone that branch with `git clone --no-local --no-checkout --no-tags --origin seed --branch codex/talker-foundation-docs <Talker-path> <Vanilla-path>`, remove only Vanilla's newly created `seed` remote, rename its cloned branch to `main`, and check it out. `--no-local` uses Git transport to create independent object storage; do not use a shallow clone, alternates, or a directory copy. Never copy ignored `.env`, virtual environments, node_modules, or build output.

Vanilla adds clearly scoped role/status/release notes; inherited Talker deployment reports are historical, not Vanilla verification. Keep the family architecture and this runbook aligned in both repositories. The temporary handoff README must not replace the application README, and `codex-first-task.md` is onboarding material rather than permanent operating guidance.

Validate independently with fresh dependencies:

```powershell
# In Vanilla/frontend, then in the corresponding disposable adoption clone.
npm ci
npm test
npm run build

# In Vanilla/backend, using its fresh virtual environment.
python -m pip install -r requirements.txt
python -B -m unittest -v test_speech
```

Run backend tests before creating a local `.env` so dotenv cannot load inherited credentials. Local smoke configuration uses newly generated invitation/session values, `CHAT_PROVIDER=mock`, no Google key, `DIALOG_FREE_TIER_CONFIRMED=false`, `PORT=8081`, and `ALLOWED_ORIGINS=http://127.0.0.1:5174`. For the frontend use `VITE_API_URL=http://127.0.0.1:8081` and `npm.cmd run dev -- --host 127.0.0.1 --port 5174 --strictPort`. On Windows PowerShell, invoke `npm.cmd` explicitly: the `npm.ps1` wrapper selected by `npm` does not forward the flag separator correctly in the inspected environment. Mock chat does not verify live providers or speech. Browser interaction is unavailable to Codex in this environment; keep manual microphone, playback, appearance, and native-WebMCP checks explicit. Live Antigravity testing remains a separate opt-in local check with the existing seven-request rolling-minute cap.

After successful automated and local HTTP/server smoke checks, document results and limitations and commit Vanilla's role/status notes. Tag that validated commit with `git tag -a vanilla/v1.0.0 <release-commit> -m "Vanilla Talker v1.0.0: validated initial local foundation"`; do not tag the raw starting revision prematurely.

In Talker, add only the new remote with `git remote add --no-tags vanilla C:/Users/szala/Combine/VanillaTalker`, and set `git config remote.vanilla.pushurl disabled://vanilla` to block ordinary accidental pushes through it. This is an accident guard, not an access-control boundary. Preserve origin and main's existing tracking. Fetch the exact tag with the non-forcing refspec `git fetch --no-tags vanilla refs/tags/vanilla/v1.0.0:refs/tags/vanilla/v1.0.0`. Verify both the peeled commit and annotated tag object match the source, and verify the documentation commit is an ancestor of the release.

Rehearse adoption in a fresh disposable clone under the system temporary directory, with its source remote removed. Create `codex/verify-vanilla-v1.0.0`, fetch the same exact release tag, and use `git merge --no-ff --no-commit refs/tags/vanilla/v1.0.0`. Review even a clean merge: Vanilla-only role notes can apply without conflicts and must not change the descendant's identity or claim Vanilla checks describe Talker. Preserve Talker's agent, README, and brief role statements after examining those specific changes. Keep general release changes intact. Run the build, tests, and local smoke checks before `git merge --abort`; retain the disposable clone/report until deliberate cleanup.

After successful setup, fast-forward only the reviewed Talker documentation branch into local main. Do not merge the Vanilla release into Talker main, push, or trigger deployments. Verify origin URL, main tracking, application/deployment-file equality to the starting revision, and the final working trees. Remind the user to remove `talker-handoff/` after successful integration; leave it untracked and do not automatically delete it.

## 10. Recovery for the initial local setup

If validation fails, leave work on its named local branches and do not release/tag it. Abort an active rehearsal merge in the disposable clone. Do not reset main or delete user files. Once documentation is integrated into main, use a reviewed revert commit if needed; do not rewrite history. Removing the newly introduced fetch remote, disposable clone, or Vanilla directory requires deliberate authorization and path verification. Never move an existing release tag; fixes after release use a new version. No rollback of hosted state is needed because setup makes no push or deployment.

## 11. Private backup remote: approved 2026-10-11

After the local setup, the owner provided the empty private repository `https://github.com/szlaci3/vanilla-talker.git` and authorized connecting Vanilla origin and pushing its main branch plus the existing annotated `vanilla/v1.0.0` tag. This supplements the initial local-only setup authorization above; it does not authorize a Talker push, release adoption, application deployment, or automatic future Vanilla pushes.

Inspect the destination visibility and refs, verify the working tree and tracked history for accidental credentials, and preserve the release tag object. Add origin only if absent; do not overwrite another remote. Review the documentation-only commit recording this decision, then use explicit non-forcing refspecs:

```powershell
# In Vanilla only; after confirming the inspected destination and clean state.
git push --dry-run --atomic origin refs/heads/main:refs/heads/main refs/tags/vanilla/v1.0.0:refs/tags/vanilla/v1.0.0
git push --atomic --set-upstream origin refs/heads/main:refs/heads/main refs/tags/vanilla/v1.0.0:refs/tags/vanilla/v1.0.0
```

Verify remote main matches the local commit and both annotated tag object and peeled release commit match. Set Vanilla main to track its own origin/main; Talker's main continues tracking its own origin/main and its vanilla remote remains the local fetch source with accidental pushes disabled. Commit synchronized family-document changes in Talker locally without pushing them under this authorization. Do not move the existing release tag to include later backup documentation. A private Git remote backs up tracked history and tags; ignored local configuration and dependencies remain local.
