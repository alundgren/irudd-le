# Issue tracker: GitHub

Issues and specs for this repo live as GitHub issues. Use the `gh` CLI for all operations.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --comments`, filtering comments by `jq` and also fetching labels.
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Comment on an issue**: `gh issue comment <number> --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --comment "..."`

Infer the repo from `git remote -v` — `gh` does this automatically when run inside a clone.

## What to work on next

Issues are the source of truth. Work order is derived, never hand-maintained:

- **Hierarchy** is GitHub sub-issues. Every issue belonging to an epic is nested under it, directly or transitively.
- **Order** is GitHub's native issue dependencies (`blocked_by`). An issue is ready when it has no _open_ blockers.
- **Containers** carry the `epic` label and are not worked directly.

The ready list — open, unblocked, unclaimed, excluding containers:

```sh
gh api --paginate "repos/{owner}/{repo}/issues?state=open&per_page=100" \
  --jq '.[] | select(.pull_request == null)
        | select(.issue_dependencies_summary.blocked_by == 0)
        | select(.assignee == null)
        | select([.labels[].name] | index("epic") | not)
        | "#\(.number)\t\(.title)"'
```

`issue_dependencies_summary.blocked_by` counts only open blockers, so the list re-derives itself as issues close. Claim with `gh issue edit <n> --add-assignee @me`, which drops it from the ready list.

To see the tree instead of the flat list, open the epic, or filter the issues tab with `no:parent-issue` for top-level issues only. Sub-issues always remain in the main issue list; nesting is a relationship, not a move.

## Project board

Project **1**, `Last Epoch Overlay` (user-owned, linked to this repo): <https://github.com/users/alundgren/projects/1>

The board tracks one thing only — `Status` (`Todo` / `In Progress` / `Done`). Hierarchy and ordering stay on the issues; the board does not duplicate them. Projects cannot filter on `blocked_by`, so readiness always comes from the query above, never from a board column.

```sh
# Board state
gh project item-list 1 --owner alundgren --format json \
  --jq '.items[] | "\(.status // "none")\t#\(.content.number)\t\(.title)"'

# Move an issue (find its item id in the listing above)
gh project item-edit --id <item-id> --project-id PVT_kwHOAAbLO84BgIJz \
  --field-id PVTSSF_lAHOAAbLO84BgIJzzhaWE1I --single-select-option-id <option-id>

# Option ids
gh project field-list 1 --owner alundgren --format json \
  --jq '.fields[] | select(.name=="Status") | .options[] | "\(.name)\t\(.id)"'
```

New issues are **not** added automatically — `gh project` has no workflow command, so either add them with `gh project item-add 1 --owner alundgren --url <issue-url>` or enable the built-in auto-add workflow once in the project's UI settings.

Agents should prefer plain `gh issue` / `gh api` for anything except `Status`; the board is a view for the human, not a source of truth.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view <number> --comments` and `gh pr diff <number>` for the diff.
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
