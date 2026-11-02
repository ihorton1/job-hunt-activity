import { calendarDays, dayInLondon, orderGoals, summarize } from "./model.mjs";

const get = id => document.getElementById(id);
let snapshot;

function renderCalendar(panel, goal, year) {
  const title = goal === null ? "All goals" : goal.title;
  const summary = summarize(snapshot, goal?.number ?? null, year);
  const heading = panel.querySelector(".calendar-title");
  heading.id = goal === null ? "calendar-all-title" : `calendar-${goal.number}-title`;
  heading.textContent = title;
  panel.setAttribute("aria-labelledby", heading.id);
  const count = summary.count;
  panel.querySelector(".totals").textContent = `${count} completion${count === 1 ? "" : "s"} across ${summary.activeDays} active day${summary.activeDays === 1 ? "" : "s"} in ${year}`;
  const calendar = panel.querySelector(".calendar");
  calendar.setAttribute("aria-label", `${title}: daily completions`);
  const days = calendarDays(year);
  const offset = (new Date(`${days[0]}T00:00:00Z`).getUTCDay() + 6) % 7;
  for (let i = 0; i < offset; i++) {
    const blank = document.createElement("span");
    blank.className = "blank";
    calendar.append(blank);
  }
  const today = dayInLondon(new Date());
  for (const [index, day] of days.entries()) {
    if (day.endsWith("-01")) {
      const month = document.createElement("span");
      month.textContent = new Intl.DateTimeFormat("en-GB", { month: "short", timeZone: "UTC" })
        .format(new Date(`${day}T00:00:00Z`));
      month.style.gridColumn = `${Math.floor((index + offset) / 7) + 1}`;
      panel.querySelector(".months").append(month);
    }
    const count = summary.byDay.get(day) || 0;
    const box = document.createElement("span");
    box.className = "day";
    box.dataset.level = Math.min(count, 4);
    box.classList.toggle("future", day > today);
    box.tabIndex = count > 0 && day <= today ? 0 : -1;
    box.title = `${day}: ${count} completion${count === 1 ? "" : "s"}`;
    box.setAttribute("role", "img");
    box.setAttribute("aria-label", box.title);
    calendar.append(box);
  }
  const scroll = panel.querySelector(".calendar-scroll");
  scroll.scrollLeft = scroll.scrollWidth;
}

function render() {
  const year = Number(get("year").value);
  const container = get("calendars");
  container.replaceChildren();
  for (const goal of [null, ...orderGoals(snapshot, year)]) {
    const panel = get("calendar-template").content.firstElementChild.cloneNode(true);
    container.append(panel);
    renderCalendar(panel, goal, year);
  }
}

try {
  const response = await fetch("./activity.json", { cache: "no-store" });
  if (!response.ok) throw new Error(`Snapshot request failed (HTTP ${response.status})`);
  snapshot = await response.json();
  if (snapshot.version !== 3 || snapshot.timeZone !== "Europe/London"
    || !Array.isArray(snapshot.goals) || !Array.isArray(snapshot.days)
    || !Number.isFinite(new Date(snapshot.generatedAt).getTime())) {
    throw new Error("Unsupported or invalid activity snapshot");
  }
  const currentYear = Number(dayInLondon(new Date()).slice(0, 4));
  const firstYear = Math.min(currentYear, ...snapshot.days.map(day => Number(day.date.slice(0, 4))));
  for (let year = currentYear; year >= firstYear; year--) {
    const option = document.createElement("option");
    option.value = year;
    option.textContent = year;
    get("year").append(option);
  }
  get("refreshed").textContent = `Updated ${new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium", timeStyle: "short", timeZone: "Europe/London",
  }).format(new Date(snapshot.generatedAt))} (London)`;
  get("year").addEventListener("change", render);
  get("status").hidden = true;
  get("dashboard").hidden = false;
  render();
} catch (error) {
  console.error(error);
  get("dashboard").hidden = true;
  get("status").setAttribute("role", "alert");
  get("status").textContent = `Could not load activity: ${error.message}. Try refreshing; the published snapshot may need rebuilding.`;
}
