{
  const key = "activity-dashboard-theme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  let preference = null;
  let storageError = false;

  try {
    const saved = localStorage.getItem(key);
    if (saved === "light" || saved === "dark") preference = saved;
  } catch (error) {
    console.warn("Could not read dashboard theme preference", error);
    storageError = true;
  }

  function applyTheme() {
    const dark = preference === "dark" || (preference === null && system.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const button = document.getElementById("theme-toggle");
    if (button) {
      button.setAttribute("aria-pressed", String(dark));
      button.textContent = `Dark mode: ${dark ? "on" : "off"}`;
    }
  }

  function reportStorageError() {
    const status = document.getElementById("theme-status");
    status.textContent = "Theme preferences cannot be saved in this browser. Your choice will apply to this page only.";
    status.hidden = false;
  }

  applyTheme();
  system.addEventListener("change", () => {
    if (preference === null) applyTheme();
  });
  document.addEventListener("DOMContentLoaded", () => {
    const button = document.getElementById("theme-toggle");
    applyTheme();
    button.hidden = false;
    if (storageError) reportStorageError();
    button.addEventListener("click", () => {
      preference = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      applyTheme();
      try {
        localStorage.setItem(key, preference);
      } catch (error) {
        console.warn("Could not save dashboard theme preference", error);
        reportStorageError();
      }
    });
  });
}
