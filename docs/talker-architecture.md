# Talker Family — Architecture and Decision Record

**Status:** Agreed design; local implementation approved 2026-10-11
**Decision date:** 2026-10-11
**Owner:** Project owner
**Scope:** Talker, Vanilla Talker, and future Talker-derived applications

## 1. Purpose

Maintain one reliable, general-purpose **Vanilla Talker** application that can serve as the starting point for multiple related applications. Descendants must be able to incorporate selected **whole Vanilla releases** without accepting every new release immediately. Reusable innovations developed inside a descendant may be promoted back into Vanilla.

This document describes the **agreed target architecture**, not a claim that repositories or Git remotes have already been changed.

## 2. Terms

- **Vanilla Talker / Vanilla:** A new, separate Git repository containing the living, general-purpose foundation. It is itself a complete, locally runnable and testable application.
- **Talker:** The already-existing application and repository, including its existing deployment. It becomes the first descendant, without losing its independent identity or changing its deployment as part of this initiative.
- **Descendant:** An independently versioned application repository, created with shared Git ancestry from a known Vanilla baseline/release and specializing the foundation.
- **Promotion:** Taking a general-purpose improvement developed in a descendant, adapting it if needed, and integrating it into Vanilla.
- **Adoption:** Merging a complete tagged Vanilla release into a descendant at a deliberately chosen time.

## 3. Decisions already made

| Topic | Decision |
| --- | --- |
| Current Talker | **Keep** its existing repository, identity, and deployment unchanged. |
| Vanilla creation | Create a **new, separate repository**, based on the agreed working Talker revision and **preserving full Git history**. |
| Vanilla lifecycle | A **living** foundation: continue maintaining and improving it. |
| Vanilla releases | Preserve stable snapshots through **immutable annotated Git release tags**. |
| Vanilla run mode | **Local only**; no separate Netlify/Render deployment at this stage. Local-only does not, by itself, determine whether a private backup remote may be used later. |
| Vanilla nature | A **complete, functioning application**, not just a library or framework. |
| Generality boundary | **Vanilla owns generally useful capabilities; descendants own specialized behavior.** |
| Descendant architecture | Mostly additive extensions. Give descendants **very little freedom to modify Vanilla's core**. |
| Descendant updates | **Opt-in, release-level synchronization**, not automatic updates and not routine commit-by-commit picking. |
| Direction of reuse | **Both directions:** Vanilla releases flow to descendants; reusable descendant improvements can flow back into Vanilla. |
| Shared code extraction | Do **not** introduce shared packages or a plugin framework prematurely. Extract when actual repeated maintenance justifies it. |

## 4. Repository shape

```text
                         Vanilla Talker
                    new canonical foundation
                    locally runnable and tested
                    release: vanilla/v1.0.0, ...
                              |
              choose a tagged release to merge
                  ____________|____________
                 |            |            |
              Talker      Super Talker   Future Talker
           existing app   future app      future app
           deploy stays   independent     independent
           unchanged      repository      repository
```

- All repositories develop independently but retain a common ancestor.
- Vanilla is the **source of shared features**, not the deployment parent of other applications.
- The existing Talker repository retains its normal `origin`. A separate Git remote named `vanilla` can be configured there for intentional fetches and merges.
- The new Vanilla repository must **not** retain a push-capable `origin` accidentally pointing back to the existing Talker repository. A local repository is enough initially; hosting/backup is a separate decision.
- Do not equate the `vanilla` remote with Git's branch-tracking setting called "upstream". The descendant's `main` may continue tracking its own `origin/main`.

## 5. Design rules

1. **Keep Vanilla runnable.** A general-purpose feature accepted into Vanilla must actually work there; do not promote unintegrated scaffolding as a release feature.
2. **Favor extension over modification.** Descendants add components, routes, services, configuration, and specialized workflows without editing core code whenever reasonable.
3. **Improve core at the source.** When a generally useful core change is needed, preferably implement it in Vanilla first, publish a release, and adopt that release in the descendant.
4. **Handle exceptions deliberately.** A descendant may change core code if unavoidable, but the change must be explained and its future merge cost evaluated. This convention is not automatically enforced by Git.
5. **No premature architecture.** Prefer composition and small extension points where needed. Do not invent a heavy plugin system or split out libraries until requirements warrant it.
6. **Promotions are selective; releases are inclusive.** A feature promoted *into* Vanilla can be selected individually. A descendant adopting a Vanilla release merges the full changes included up to that tag.
7. **Preserve independently deployable descendants.** Vanilla modifications do not directly trigger descendant deployments.

## 6. Releases and compatibility

- Recommended tag namespace: `vanilla/vMAJOR.MINOR.PATCH` (for example `vanilla/v1.0.0`). This keeps Vanilla tags distinct from descendants' own version tags when repositories exchange tags. The underlying version uses semantic-versioning principles.
- `vanilla/v1.0.0` is the initial agreed **working baseline** after Codex verifies which commit is suitable and the project is reproducible. Do not assume any uncommitted working-tree changes belong to it.
- Releases are **immutable**. Never move or overwrite a published release tag.
- Before a Vanilla release: run available automated tests, build checks, and a local smoke test. Document failures or missing checks; do not claim that nonexistent tests passed.
- Maintain concise release notes describing features, fixes, changes to extension points, migration instructions, and known compatibility issues.
- For breaking changes, bump the major version when appropriate and provide an explicit descendant upgrade plan. Avoid breaking extension points unnecessarily.

## 7. Adoption and promotion policy

### Vanilla to descendant — release-level adoption

- No automatic synchronization.
- Choose a specific stable Vanilla release, inspect its release notes, and merge **that release tag** into an integration branch of the descendant.
- Verify tests, local operation, and descendant-specific behavior before merging the integration branch into the descendant's main branch.
- Skipping intermediate releases is allowed. Merging a later release includes the cumulative Vanilla changes leading to that release.
- Merges may conflict even with shared Git ancestry; never promise conflict-free upgrades.

### Descendant to Vanilla — selective promotion

- Decide if an improvement is general-purpose rather than specialized.
- Transfer a focused commit/feature into a Vanilla integration branch (cherry-pick with provenance when appropriate, or adapt/reimplement when tightly coupled to descendant-specific code).
- Test in Vanilla independently, document the change, and include it in a future Vanilla release.
- A subsequent Vanilla release may contain the same logical change that was already developed in its originating descendant. Review and reconcile such duplicate patches on adoption; Git does not automatically equate differently authored commits.
- Avoid promoting special-purpose UI or behavior to Vanilla just because it is useful in one descendant.

## 8. Safety and existing deployment

- **Do not modify the existing Talker deployment, Git remote, branches, or history during the planning phase.**
- Inspect dirty working trees, untracked local files, Git tags, branch topology, remote URLs, CI/deployment integration, secret handling, and existing `AGENTS.md` before proposing execution steps.
- Do not copy credentials or ignored local environment files into a new repository. Note that *committed* secrets, if any, can be preserved by copying full history; check for them before any publication or sharing.
- No force-push, history rewrite, destructive reset, tag overwrite, new remote push, or deletion without explicit authorization.

## 9. Deferred decisions (not blockers for the initial plan)

- Private Git backup approved 2026-10-11: Vanilla uses its own `origin` at `https://github.com/szlaci3/vanilla-talker.git`. The owner authorized connecting it and pushing Vanilla main plus the immutable `vanilla/v1.0.0` tag. Application execution remains local; no deployment is authorized. Future Vanilla pushes still require authorization. Talker keeps its existing origin and local vanilla fetch remote.
- Specific extension points, determined from inspection of the real Talker codebase.
- Whether common libraries/packages are eventually extracted, based on demonstrated repetition.
- Exact CI commands and compatibility tests, determined by examining the repository.

## 10. Implementation readiness

The read-only audit and project-specific local implementation plan were reviewed and approved on 2026-10-11. The approved application starting revision is Talker `8c36eab99fe407e275ace4f30c3e5a6a0bc62aaa`; untracked `talker-handoff/` content is excluded from application history. The permanent documents are integrated before cloning so both repositories share their ancestry.

Approval covers a separate local `C:\Users\szala\Combine\VanillaTalker` repository, independent validation, an annotated `vanilla/v1.0.0` release after validation, a new local `vanilla` fetch remote in Talker, and a disposable release-adoption rehearsal. It does not authorize pushes, hosted repository creation, deployments, actual Vanilla-release adoption into Talker main, or removal of the temporary handoff directory. See the companion workflow for exact operating conventions; Vanilla-specific validation and release records live in Vanilla.
