export const TIME_ZONE = "Europe/London";

export function dayInLondon(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(date);
}

export function ancestors(issue, byNumber) {
  const result = [];
  const seen = new Set([issue.number]);
  let number = issue.parent;
  while (number !== null) {
    if (seen.has(number)) throw new Error(`Cycle in issue hierarchy at #${number}`);
    seen.add(number);
    const parent = byNumber.get(number);
    if (!parent) throw new Error(`Missing parent #${number} for #${issue.number}`);
    result.push(number);
    number = parent.parent;
  }
  return result;
}

export function buildSnapshot(rawIssues, generatedAt = new Date().toISOString()) {
  const byNumber = new Map();
  for (const raw of rawIssues) {
    if (!Number.isInteger(raw.number) || raw.number < 1 || typeof raw.title !== "string"
      || !["OPEN", "CLOSED"].includes(raw.state) || !Array.isArray(raw.labels?.nodes)) {
      throw new Error("Invalid issue returned by GitHub");
    }
    if (byNumber.has(raw.number)) throw new Error(`Duplicate issue #${raw.number}`);
    let completedOn = null;
    if (raw.state === "CLOSED" && raw.stateReason === "COMPLETED") {
      if (!raw.closedAt) throw new Error(`Completed issue #${raw.number} has no closedAt`);
      completedOn = dayInLondon(raw.closedAt);
    }
    byNumber.set(raw.number, {
      number: raw.number,
      title: raw.title,
      parent: raw.parent?.number ?? null,
      isGoal: raw.labels.nodes.some(label => label.name === "goal"),
      isHidden: raw.labels.nodes.some(label => label.name === "dashboard-hidden"),
      completedOn,
    });
  }
  const issues = [...byNumber.values()].filter(issue => {
    const lineage = ancestors(issue, byNumber);
    if (issue.isHidden || lineage.some(number => byNumber.get(number).isHidden)) return false;
    return issue.isGoal || lineage.some(number => byNumber.get(number).isGoal);
  }).sort((a, b) => a.number - b.number);
  const goalIssues = issues.filter(issue => issue.isGoal);
  const completions = issues.filter(issue => issue.completedOn);
  const aggregate = entries => {
    const counts = new Map();
    for (const issue of entries) {
      counts.set(issue.completedOn, (counts.get(issue.completedOn) || 0) + 1);
    }
    return [...counts].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));
  };
  const goals = goalIssues.map(issue => ({
    number: issue.number,
    title: issue.title,
    days: aggregate(completions.filter(entry => entry.number === issue.number
      || ancestors(entry, byNumber).includes(issue.number))),
  }));
  return {
    version: 3,
    generatedAt: new Date(generatedAt).toISOString(),
    timeZone: TIME_ZONE,
    days: aggregate(completions),
    goals,
  };
}

export function calendarDays(year) {
  if (!Number.isInteger(year) || year < 2000 || year > 9999) throw new Error("Invalid calendar year");
  const days = [];
  const date = new Date(Date.UTC(year, 0, 1));
  while (date.getUTCFullYear() === year) {
    days.push(date.toISOString().slice(0, 10));
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return days;
}

export function summarize(snapshot, goal, year) {
  const selected = goal === null ? snapshot : snapshot.goals.find(entry => entry.number === goal);
  if (!selected) throw new Error(`Unknown dashboard goal: ${goal}`);
  const byDay = new Map(selected.days.filter(day => day.date.startsWith(`${year}-`))
    .map(day => [day.date, day.count]));
  return {
    count: [...byDay.values()].reduce((sum, count) => sum + count, 0),
    byDay,
    activeDays: byDay.size,
  };
}

export function orderGoals(snapshot, year) {
  return snapshot.goals
    .map(goal => ({ goal, count: summarize(snapshot, goal.number, year).count }))
    .sort((a, b) => b.count - a.count || a.goal.number - b.goal.number)
    .map(entry => entry.goal);
}
