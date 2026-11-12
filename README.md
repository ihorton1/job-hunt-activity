# Goal activity

A small, dependency-free static dashboard of GitHub issue completions.

**[View the dashboard](https://ihorton1.github.io/job-hunt-activity/)**

## What it shows

- An All goals calendar, followed by one calendar per goal.
- Goal sections ranked by completions in the selected year.
- Daily green boxes, completion counts and active-day counts.
- London-time dates, year selection and responsive horizontal calendars.

Issues labelled `goal` define the goals. Their descendants contribute to the
daily totals. Only issues currently closed as **completed** count; not-planned
and reopened issues do not. Parent closures count as separate milestones.
Each issue counts once in the All goals total, including with nested goals.
Ties in goal ranking use issue number.

Label an issue `dashboard-hidden` to exclude it and its entire descendant subtree
from the public snapshot, including goal calendars and All goals totals. A hidden
goal can keep its `goal` label for private tracking. Descendant goals are hidden
too, even when nested beneath a visible goal.

These are completion dates, not work-session dates. Reopening an issue removes
its contribution until it is completed again. Historical migrations and
retrospective updates appear on their GitHub closure dates.

## Public data boundary

The generated snapshot contains only goal numbers and names, daily aggregate
counts, a schema version, refresh time and time zone. It contains no task or
sub-task titles, individual completion records, issue bodies, comments,
contact details or credentials.

`main` contains this source code. The `site` branch contains only the generated
static website and is the GitHub Pages publishing source. No private source
repository history is copied into either branch.

The public repository does **not** hold a private-repository access token.
The source repository runs the generator with its built-in `GITHUB_TOKEN` and
pushes the sanitized site using a deploy key restricted to this repository.
Issue changes, a daily schedule and manual runs refresh the site. Source code
used by the publisher is pinned to a reviewed commit in this repository.

## Development

Requires Node 20 or newer. No packages need installing.

```powershell
node --test tools\activity-dashboard\dashboard.test.mjs
$env:GITHUB_REPOSITORY = 'owner/source-repository'
$env:GH_TOKEN = & 'C:\Program Files\GitHub CLI\gh.exe' auth token
try {
    node tools\activity-dashboard\build.mjs
} finally {
    Remove-Item Env:\GH_TOKEN -ErrorAction SilentlyContinue
}
node tools\activity-dashboard\preview.mjs
```

Open <http://127.0.0.1:4173>. The localhost-only preview serves the generated
dashboard, not the source repository. `dist` is ignored by git.
The build takes an optional output-directory argument.

GitHub API errors, incomplete pagination and invalid hierarchies fail the build
rather than publishing misleading empty activity. Titles are rendered as text,
not HTML. There are no third-party assets, analytics, write controls or database.

The test suite covers aggregation, privacy boundaries, cancelled/reopened
issues, nested goals, London dates, leap years, ranking, pagination and failures.
Pull requests run the tests without fetching private issue data.
