import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ancestors, buildSnapshot, calendarDays, dayInLondon, orderGoals, summarize } from "./model.mjs";
import { build, fetchIssues } from "./build.mjs";

function issue(number, overrides = {}) {
  return {
    number, title: `Issue ${number}`, parent: null,
    state: "OPEN", stateReason: null, closedAt: null,
    labels: { nodes: [], pageInfo: { hasNextPage: false } },
    ...overrides,
  };
}
const done = { state: "CLOSED", stateReason: "COMPLETED", closedAt: "2026-11-02T10:00:00Z" };
const goal = issue(1, { labels: { nodes: [{ name: "goal" }] } });
const raw = [
  goal,
  issue(2, { parent: { number: 1 }, ...done }),
  issue(3, { parent: { number: 2 }, ...done }),
  issue(4, { parent: { number: 1 }, state: "CLOSED", stateReason: "NOT_PLANNED", closedAt: done.closedAt }),
  issue(5, { parent: { number: 1 }, closedAt: done.closedAt }),
  issue(6, { ...done }),
];
function page(nodes, hasNextPage = false, endCursor = null) {
  return { ok: true, json: async () => ({ data: { repository: { issues: {
    nodes, pageInfo: { hasNextPage, endCursor },
  } } } }) };
}

test("publishes only aggregate activity and goal names, not grouping tasks", () => {
  const snapshot = buildSnapshot(raw.map(i => ({
    ...i, body: "PRIVATE EMAIL", comments: ["PRIVATE CONTACT"], url: "PRIVATE URL",
  })));
  assert.equal(snapshot.version, 3);
  assert.deepEqual(Object.keys(snapshot).sort(), ["days", "generatedAt", "goals", "timeZone", "version"]);
  assert.deepEqual(snapshot.goals.map(i => i.number), [1]);
  for (const published of snapshot.goals) {
    assert.deepEqual(Object.keys(published).sort(), ["days", "number", "title"]);
    for (const day of published.days) assert.deepEqual(Object.keys(day).sort(), ["count", "date"]);
  }
  for (const day of snapshot.days) assert.deepEqual(Object.keys(day).sort(), ["count", "date"]);
  assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE|Issue [23456]|closedAt|completedOn/);
});

test("counts completed issues, not cancelled or reopened issues", () => {
  assert.deepEqual(buildSnapshot(raw).days, [{ date: "2026-11-02", count: 2 }]);
});

test("rolls descendants up once while treating parent closure as a separate milestone", () => {
  const snapshot = buildSnapshot(raw);
  assert.equal(summarize(snapshot, null, 2026).count, 2);
  assert.equal(summarize(snapshot, 1, 2026).count, 2);
  const result = summarize(snapshot, 1, 2026);
  assert.equal(result.activeDays, 1);
  assert.equal(result.byDay.get("2026-11-02"), 2);
  assert.equal(summarize(snapshot, 1, 2025).count, 0);
  assert.throws(() => summarize(snapshot, 2, 2026), /Unknown dashboard goal/);
});

test("includes nested goals without double counting overall completions", () => {
  const snapshot = buildSnapshot([
    goal,
    issue(2, { parent: { number: 1 }, labels: { nodes: [{ name: "goal" }] }, ...done }),
    issue(3, { parent: { number: 2 }, ...done }),
  ]);
  assert.deepEqual(snapshot.goals.map(goal => goal.number), [1, 2]);
  assert.equal(summarize(snapshot, null, 2026).count, 2);
  assert.equal(summarize(snapshot, 1, 2026).count, 2);
  assert.equal(summarize(snapshot, 2, 2026).count, 2);
});

test("includes goals with no completions without exposing their tasks", () => {
  const snapshot = buildSnapshot([goal, issue(2, { parent: { number: 1 } })]);
  assert.equal(snapshot.goals.length, 1);
  assert.deepEqual(snapshot.days, []);
  assert.deepEqual(snapshot.goals[0].days, []);
  assert.equal(summarize(snapshot, 1, 2026).activeDays, 0);
  assert.doesNotMatch(JSON.stringify(snapshot), /Issue 2/);
});

test("excludes hidden goals and their entire subtree from the public snapshot", () => {
  for (const parent of [null, { number: 1 }]) {
    const snapshot = buildSnapshot([
      goal,
      issue(57, {
        title: "Hidden goal",
        parent,
        labels: { nodes: [{ name: "goal" }, { name: "dashboard-hidden" }] },
        ...done,
      }),
      issue(58, { parent: { number: 57 }, ...done }),
      issue(59, {
        title: "Nested hidden goal",
        parent: { number: 58 },
        labels: { nodes: [{ name: "goal" }] },
        ...done,
      }),
      issue(60, { parent: { number: 59 }, ...done }),
      issue(2, { parent: { number: 1 }, ...done }),
    ]);
    assert.deepEqual(snapshot.goals.map(entry => entry.number), [1]);
    assert.deepEqual(snapshot.days, [{ date: "2026-11-02", count: 1 }]);
    assert.deepEqual(snapshot.goals[0].days, snapshot.days);
    assert.doesNotMatch(JSON.stringify(snapshot), /Hidden goal|Nested hidden goal|dashboard-hidden/);
  }
});

test("excludes hidden non-goal branches while retaining their visible goal", () => {
  const snapshot = buildSnapshot([
    ...raw,
    issue(7, {
      parent: { number: 1 },
      labels: { nodes: [{ name: "dashboard-hidden" }] },
      ...done,
    }),
    issue(8, { parent: { number: 7 }, ...done }),
  ]);
  assert.deepEqual(snapshot.days, buildSnapshot(raw).days);
  assert.deepEqual(snapshot.goals, buildSnapshot(raw).goals);
});

test("orders goals by selected-year completions, with stable issue-number ties and no mutation", () => {
  const snapshot = { goals: [
    { number: 9, days: [{ date: "2025-01-01", count: 10 }] },
    { number: 4, days: [{ date: "2026-01-01", count: 1 }, { date: "2026-01-02", count: 1 }] },
    { number: 2, days: [{ date: "2026-01-01", count: 2 }] },
    { number: 1, days: [] },
    { number: 6, days: [{ date: "2026-01-01", count: 3 }] },
  ] };
  assert.deepEqual(orderGoals(snapshot, 2026).map(goal => goal.number), [6, 2, 4, 1, 9]);
  assert.deepEqual(orderGoals(snapshot, 2025).map(goal => goal.number), [9, 1, 2, 4, 6]);
  assert.deepEqual(orderGoals(snapshot, 2024).map(goal => goal.number), [1, 2, 4, 6, 9]);
  assert.deepEqual(snapshot.goals.map(goal => goal.number), [9, 4, 2, 1, 6]);
});

test("respects London time, DST, and year boundaries", () => {
  assert.equal(dayInLondon("2026-07-01T23:30:00Z"), "2026-07-02");
  assert.equal(dayInLondon("2026-12-31T23:30:00Z"), "2026-12-31");
  assert.equal(dayInLondon("2026-10-25T01:30:00Z"), "2026-10-25");
  assert.throws(() => dayInLondon("not a date"), /Invalid date/);
});

test("calendar includes leap days and exactly one full year", () => {
  assert.equal(calendarDays(2024).length, 366);
  assert.ok(calendarDays(2024).includes("2024-02-29"));
  assert.equal(calendarDays(2026).length, 365);
  assert.equal(calendarDays(2026).at(-1), "2026-12-31");
  assert.throws(() => calendarDays(1.5), /Invalid calendar/);
});

test("fails explicitly for duplicate issues, missing parents, cycles, and missing completion dates", () => {
  assert.throws(() => buildSnapshot([goal, goal]), /Duplicate/);
  assert.throws(() => buildSnapshot([goal, issue(2, { parent: { number: 99 } })]), /Missing parent/);
  assert.throws(() => buildSnapshot([
    issue(1, { parent: { number: 2 } }), issue(2, { parent: { number: 1 } }),
  ]), /Cycle/);
  assert.throws(() => buildSnapshot([issue(2, { ...done, closedAt: null })]), /no closedAt/);
  assert.throws(() => ancestors({ number: 1, parent: 99 }, new Map()), /Missing parent/);
});

test("fetches every issue page without requesting bodies or comments", async () => {
  const calls = [];
  const request = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    return calls.length === 1 ? page([goal], true, "next") : page([issue(2)]);
  };
  assert.equal((await fetchIssues("owner/repo", "test-token", request)).length, 2);
  assert.equal(calls[0].variables.after, null);
  assert.equal(calls[1].variables.after, "next");
  assert.doesNotMatch(calls[0].query, /\b(body|comments|email)\b/);
});

test("rejects authentication, API, pagination and truncation failures", async () => {
  await assert.rejects(fetchIssues("bad", "token"), /owner\/repository/);
  await assert.rejects(fetchIssues("owner/repo", ""), /required/);
  await assert.rejects(fetchIssues("owner/repo", "token", async () => ({ ok: false, status: 403 })), /403/);
  await assert.rejects(fetchIssues("owner/repo", "token", async () => ({
    ok: true, json: async () => ({ errors: [{ message: "Denied" }] }),
  })), /Denied/);
  await assert.rejects(fetchIssues("owner/repo", "token", async () => page([], true, "same")), /cursor/);
  await assert.rejects(fetchIssues("owner/repo", "token", async () => page([
    issue(2, { labels: { nodes: [], pageInfo: { hasNextPage: true } } }),
  ])), /truncated/);
  await assert.rejects(fetchIssues("owner/repo", "token", async () => ({
    ok: true, json: async () => ({ data: { repository: null } }),
  })), /valid issue page/);
});

test("build output contains only static assets and sanitized snapshot, never credentials", async () => {
  const output = await mkdtemp(join(tmpdir(), "job-hunt-dashboard-test-"));
  try {
    await build({
      repository: "owner/repo", token: "secret-test-token", output,
      request: async () => page(raw),
    });
    assert.deepEqual((await readdir(output)).sort(), [
      ".nojekyll", "activity.json", "app.mjs", "index.html", "model.mjs", "styles.css",
    ]);
    for (const file of await readdir(output)) {
      assert.doesNotMatch(await readFile(join(output, file), "utf8"), /secret-test-token/);
    }
    const snapshot = JSON.parse(await readFile(join(output, "activity.json"), "utf8"));
    assert.equal(snapshot.goals.length, 1);
    for (const file of await readdir(output)) {
      assert.doesNotMatch(await readFile(join(output, file), "utf8"),
        /Issue [23456]|id="scope"|activity-list|Recent completions|Completions, not hours worked|Each issue counts once/);
    }
    await assert.rejects(build({
      repository: "owner/repo", token: "token", output,
      request: async () => page([issue(1)]),
    }), /No goal-labelled/);
  } finally {
    await rm(output, { recursive: true });
  }
});
