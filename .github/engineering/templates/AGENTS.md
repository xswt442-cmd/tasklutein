# Agent Guidelines

> Reusable template: replace repository-specific guidance and validation commands with facts from the target repository. Remove instructions that do not apply.

## Source of truth

- Inspect the current working tree and relevant documentation before making changes. Do not rely on earlier conversations or restore content that a user has changed or deleted.
- Describe only implemented behavior and supported interfaces. A build or test result does not prove a live deployment.
- Respect the repository's current architecture and avoid unrelated refactoring.

## Public repository documentation

- Write this `AGENTS.md` in English. Keep it machine-independent and limited to rules that apply across the repository.
- Do not put personal absolute paths, usernames, private hostnames or SSH aliases, machine-specific network settings, credentials, local deployment records, private logs, or temporary work notes in tracked files.
- Keep READMEs focused on the actual product, installation, supported platforms, usage, and limitations. Update technical documents where their authoritative content belongs; do not append development history, planned work, or acceptance notes.
- Code comments explain relevant current constraints rather than discarded implementations or troubleshooting history. Use Mermaid for diagrams when a diagram is necessary.
- Keep user-facing Simplified Chinese and English documents consistent where the repository maintains both.
- Treat `CHANGELOG.md` as the source for version-change text. Generate GitHub Release notes from the tagged version section rather than maintaining a separate copy.
- PR descriptions must describe completed changes and checks actually passed in matching Simplified Chinese and English sections. Place separate future work in Issues.
- Use relative links to tracked documentation inside this repository. Do not make public documentation depend on a developer's private files or another local checkout.
- Keep local experiments and Agent handoffs in an ignored directory such as `testplace/`, never in a public commit. Put directory-specific rules in additional local-scope `AGENTS.md` files only when useful.

## Changes, verification, and authorization

- Keep changes scoped to the requested behavior. Review the diff and run the relevant existing tests, checks, and builds. Never claim an unrun or failed check passed.
- Update the authoritative documentation and CHANGELOG entries for meaningful completed changes.
- Preserve user data, untracked files, existing release assets, and published tags.
- Do not commit, push, change branches, reset files, create tags or releases, deploy services, rotate secrets, or modify production data without explicit authorization for the current task.

## Repository-specific rules

Replace this section with the target repository's actual module boundaries, check commands, and links to its architecture and release documentation. Remove this section once those rules are integrated.
