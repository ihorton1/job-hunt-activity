import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
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
  assert.equal(snapshot.version, 4);
  assert.deepEqual(Object.keys(snapshot).sort(), ["days", "generatedAt", "goals", "timeZone", "version"]);
  assert.deepEqual(snapshot.goals.map(i => i.number), [1]);
  for (const published of snapshot.goals) {
    assert.deepEqual(Object.keys(published).sort(), ["completed", "days", "number", "title"]);
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

test("goal completion follows the goal issue, not descendants, cancellation or past closure", () => {
  for (const [overrides, completed] of [
    [{}, false],
    [done, true],
    [{ ...done, stateReason: "NOT_PLANNED" }, false],
    [{ ...done, state: "OPEN", stateReason: null }, false],
  ]) {
    const snapshot = buildSnapshot([
      { ...goal, ...overrides },
      issue(2, { parent: { number: 1 }, ...done }),
    ]);
    assert.equal(snapshot.goals[0].completed, completed);
  }
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
    { number: 9, completed: false, days: [{ date: "2025-01-01", count: 10 }] },
    { number: 4, completed: false, days: [{ date: "2026-01-01", count: 1 }, { date: "2026-01-02", count: 1 }] },
    { number: 2, completed: false, days: [{ date: "2026-01-01", count: 2 }] },
    { number: 1, completed: false, days: [] },
    { number: 6, completed: false, days: [{ date: "2026-01-01", count: 3 }] },
  ] };
  assert.deepEqual(orderGoals(snapshot, 2026).map(goal => goal.number), [6, 2, 4, 1, 9]);
  assert.deepEqual(orderGoals(snapshot, 2025).map(goal => goal.number), [9, 1, 2, 4, 6]);
  assert.deepEqual(orderGoals(snapshot, 2024).map(goal => goal.number), [1, 2, 4, 6, 9]);
  assert.deepEqual(snapshot.goals.map(goal => goal.number), [9, 4, 2, 1, 6]);
});

test("completed goals sort last in every year, retaining ranking and ties within each group", () => {
  const snapshot = buildSnapshot([
    goal,
    issue(2, { labels: { nodes: [{ name: "goal" }] }, ...done }),
    issue(3, { labels: { nodes: [{ name: "goal" }] }, ...done }),
    issue(4, { parent: { number: 3 }, ...done }),
    issue(5, { labels: { nodes: [{ name: "goal" }] } }),
  ]);
  assert.deepEqual(orderGoals(snapshot, 2026).map(goal => goal.number), [1, 5, 3, 2]);
  assert.deepEqual(orderGoals(snapshot, 2025).map(goal => goal.number), [1, 5, 2, 3]);
  assert.deepEqual(snapshot.goals.map(goal => goal.number), [1, 2, 3, 5]);
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
      ".nojekyll", "activity.json", "app.mjs", "index.html", "model.mjs", "styles.css", "theme.js",
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

const themeSource = await readFile(new URL("./theme.js", import.meta.url), "utf8");

function themePage({ saved = null, dark = false, readError = false, writeError = false } = {}) {
  const listeners = {};
  const attributes = {};
  const warnings = [];
  const button = {
    hidden: true,
    setAttribute: (name, value) => { attributes[name] = value; },
    addEventListener: (name, listener) => { listeners[name] = listener; },
  };
  const status = { hidden: true };
  const root = { dataset: {} };
  const system = {
    matches: dark,
    addEventListener: (name, listener) => { listeners.systemChange = listener; },
  };
  const storage = new Map(saved === null ? [] : [["activity-dashboard-theme", saved]]);
  runInNewContext(themeSource, {
    document: {
      documentElement: root,
      getElementById: id => listeners.ready
        ? ({ "theme-toggle": button, "theme-status": status })[id] : null,
      addEventListener: (name, listener) => { listeners.ready = listener; },
    },
    matchMedia: () => system,
    localStorage: {
      getItem: key => {
        if (readError) throw new Error("Storage blocked");
        return storage.get(key) ?? null;
      },
      setItem: (key, value) => {
        if (writeError) throw new Error("Storage full");
        storage.set(key, value);
      },
    },
    console: { warn: (...args) => warnings.push(args) },
  });
  const initialTheme = root.dataset.theme;
  listeners.ready();
  return { root, button, status, attributes, warnings, storage, listeners, system, initialTheme };
}

test("theme follows the system before rendering and until explicitly toggled", () => {
  for (const dark of [false, true]) {
    const page = themePage({ dark });
    assert.equal(page.initialTheme, dark ? "dark" : "light");
    assert.equal(page.button.hidden, false);
    assert.equal(page.attributes["aria-pressed"], String(dark));
    page.system.matches = !dark;
    page.listeners.systemChange();
    assert.equal(page.root.dataset.theme, dark ? "light" : "dark");
    page.listeners.click();
    assert.equal(page.root.dataset.theme, dark ? "dark" : "light");
    assert.equal(page.attributes["aria-pressed"], String(dark));
    assert.equal(page.button.textContent, `Dark mode: ${dark ? "on" : "off"}`);
    page.system.matches = !dark;
    page.listeners.systemChange();
    assert.equal(page.root.dataset.theme, dark ? "dark" : "light");
  }
});

test("saved theme overrides system preference and persists both toggle directions", () => {
  for (const saved of ["light", "dark"]) {
    const page = themePage({ saved, dark: saved === "light" });
    assert.equal(page.initialTheme, saved);
    page.listeners.click();
    const next = saved === "dark" ? "light" : "dark";
    assert.equal(page.storage.get("activity-dashboard-theme"), next);
    assert.equal(themePage({ saved: next }).initialTheme, next);
    page.listeners.click();
    assert.equal(page.storage.get("activity-dashboard-theme"), saved);
  }
  assert.equal(themePage({ saved: "invalid", dark: true }).initialTheme, "dark");
});

test("storage failures are reported without preventing theme changes", () => {
  const page = themePage({ readError: true, writeError: true });
  assert.equal(page.status.hidden, false);
  assert.match(page.status.textContent, /cannot be saved/);
  assert.equal(page.warnings.length, 1);
  page.listeners.click();
  assert.equal(page.root.dataset.theme, "dark");
  assert.equal(page.warnings.length, 2);
  const writeOnly = themePage({ writeError: true });
  assert.equal(writeOnly.status.hidden, true);
  writeOnly.listeners.click();
  assert.equal(writeOnly.status.hidden, false);
});
