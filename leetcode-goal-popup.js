const GOAL_KEY = "leetcodeGoals";

const statusEl = document.getElementById("status");
const alertBannerEl = document.getElementById("alert-banner");
const errorDetailsEl = document.getElementById("error-details");
const errorDetailsTextEl = document.getElementById("error-details-text");
const refreshBtn = document.getElementById("refresh");

const todayCountEl = document.getElementById("today-count");
const weekCountEl = document.getElementById("week-count");
const monthCountEl = document.getElementById("month-count");

const todayDifficultyEl = document.getElementById("today-difficulty");
const weekDifficultyEl = document.getElementById("week-difficulty");
const monthDifficultyEl = document.getElementById("month-difficulty");

const goalFormEl = document.getElementById("goal-form");
const goalErrorEl = document.getElementById("goal-error");
const dailyGoalInputEl = document.getElementById("daily-goal");
const weeklyGoalInputEl = document.getElementById("weekly-goal");
const monthlyGoalInputEl = document.getElementById("monthly-goal");

const todayProgressBarEl = document.getElementById("today-progress-bar");
const weekProgressBarEl = document.getElementById("week-progress-bar");
const monthProgressBarEl = document.getElementById("month-progress-bar");

const todayProgressTextEl = document.getElementById("today-progress-text");
const weekProgressTextEl = document.getElementById("week-progress-text");
const monthProgressTextEl = document.getElementById("month-progress-text");
const todayGoalBadgeEl = document.getElementById("today-goal-badge");
const weekGoalBadgeEl = document.getElementById("week-goal-badge");
const monthGoalBadgeEl = document.getElementById("month-goal-badge");

let currentStats = null;
let currentGoals = { daily: 0, weekly: 0, monthly: 0 };
let isRefreshing = false;
let lastUpdatedAt = null;

function clearBadge() {
  chrome.action.setBadgeText({ text: "" });
}

function setLoading(isLoading) {
  refreshBtn.disabled = isLoading;
  if (isLoading) {
    statusEl.textContent = "Checking...";
  }
}

function showAlert(message) {
  if (!message) {
    alertBannerEl.textContent = "";
    alertBannerEl.classList.add("hidden");
    return;
  }
  alertBannerEl.textContent = message;
  alertBannerEl.classList.remove("hidden");
}

function showErrorDetails(details) {
  if (!details) {
    errorDetailsTextEl.textContent = "";
    errorDetailsEl.classList.add("hidden");
    errorDetailsEl.open = false;
    return;
  }
  errorDetailsTextEl.textContent = String(details);
  errorDetailsEl.classList.remove("hidden");
}

function difficultyText(byDifficulty) {
  const easy = byDifficulty?.Easy ?? 0;
  const medium = byDifficulty?.Medium ?? 0;
  const hard = byDifficulty?.Hard ?? 0;
  return `Easy: ${easy} | Medium: ${medium} | Hard: ${hard}`;
}

function formatLastUpdated(date) {
  return date.toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function setLastUpdatedStatus() {
  if (!lastUpdatedAt) {
    return;
  }
  statusEl.textContent = `Last updated at ${formatLastUpdated(lastUpdatedAt)}`;
}

function normalizeGoal(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function parseGoalInput(rawValue, label, maxValue) {
  const text = String(rawValue || "").trim();
  if (!text) {
    return { ok: true, value: 0 };
  }
  const value = Number(text);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    return { ok: false, error: `${label} must be an integer.` };
  }
  if (value < 0) {
    return { ok: false, error: `${label} must be greater than or equal to 0.` };
  }
  if (value > maxValue) {
    return { ok: false, error: `${label} must be less than or equal to ${maxValue}.` };
  }
  return { ok: true, value };
}

function showGoalError(message) {
  if (!message) {
    goalErrorEl.textContent = "";
    goalErrorEl.classList.add("hidden");
    return;
  }
  goalErrorEl.textContent = message;
  goalErrorEl.classList.remove("hidden");
}

function getGoalsFromStorage() {
  return new Promise((resolve) => {
    chrome.storage.local.get([GOAL_KEY], (data) => {
      const stored = data?.[GOAL_KEY] || {};
      resolve({
        daily: normalizeGoal(stored.daily),
        weekly: normalizeGoal(stored.weekly),
        monthly: normalizeGoal(stored.monthly)
      });
    });
  });
}

function saveGoalsToStorage(goals) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [GOAL_KEY]: goals }, resolve);
  });
}

function fillGoalInputs(goals) {
  dailyGoalInputEl.value = goals.daily ? String(goals.daily) : "";
  weeklyGoalInputEl.value = goals.weekly ? String(goals.weekly) : "";
  monthlyGoalInputEl.value = goals.monthly ? String(goals.monthly) : "";
}

function clamp(number, min, max) {
  return Math.max(min, Math.min(number, max));
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diffToMonday);
  return d;
}

function getMonthStart(date) {
  const d = new Date(date);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  return d;
}

function getPeriodElapsedRatio(period) {
  const now = new Date();
  let start = new Date(now);
  let end = new Date(now);

  if (period === "daily") {
    start.setHours(0, 0, 0, 0);
    end = new Date(start);
    end.setDate(end.getDate() + 1);
  } else if (period === "weekly") {
    start = getWeekStart(now);
    end = new Date(start);
    end.setDate(end.getDate() + 7);
  } else {
    start = getMonthStart(now);
    end = new Date(start);
    end.setMonth(end.getMonth() + 1);
  }

  const total = end.getTime() - start.getTime();
  const elapsed = now.getTime() - start.getTime();
  if (total <= 0) {
    return 0;
  }
  return clamp(elapsed / total, 0, 1);
}

function getGoalBadgeState(period, count, goal) {
  if (!goal) {
    return { label: "No Goal", className: "badge-neutral" };
  }

  if (count >= goal) {
    return { label: "Achieved", className: "badge-achieved" };
  }

  const elapsedRatio = getPeriodElapsedRatio(period);
  const expected = goal * elapsedRatio;
  if (count >= expected) {
    return { label: "On Track", className: "badge-on-track" };
  }

  return { label: "Behind", className: "badge-behind" };
}

function renderGoalBadge(element, state) {
  element.textContent = state.label;
  element.className = `goal-badge ${state.className}`;
}

function renderGoalBadges() {
  const dailyCount = currentStats?.today?.count ?? 0;
  const weeklyCount = currentStats?.week?.count ?? 0;
  const monthlyCount = currentStats?.month?.count ?? 0;

  renderGoalBadge(todayGoalBadgeEl, getGoalBadgeState("daily", dailyCount, currentGoals.daily));
  renderGoalBadge(weekGoalBadgeEl, getGoalBadgeState("weekly", weeklyCount, currentGoals.weekly));
  renderGoalBadge(monthGoalBadgeEl, getGoalBadgeState("monthly", monthlyCount, currentGoals.monthly));
}

function renderProgress(count, goal, barEl, textEl) {
  if (!goal) {
    barEl.style.width = "0%";
    textEl.textContent = "Goal not set";
    return;
  }

  const ratio = Math.min(count / goal, 1);
  const percent = Math.round(ratio * 100);
  barEl.style.width = `${percent}%`;
  textEl.textContent = `${count}/${goal} (${percent}%)`;
}

function renderProgressCards() {
  if (!currentStats) {
    renderProgress(0, currentGoals.daily, todayProgressBarEl, todayProgressTextEl);
    renderProgress(0, currentGoals.weekly, weekProgressBarEl, weekProgressTextEl);
    renderProgress(0, currentGoals.monthly, monthProgressBarEl, monthProgressTextEl);
    renderGoalBadges();
    return;
  }

  renderProgress(currentStats.today.count, currentGoals.daily, todayProgressBarEl, todayProgressTextEl);
  renderProgress(currentStats.week.count, currentGoals.weekly, weekProgressBarEl, weekProgressTextEl);
  renderProgress(currentStats.month.count, currentGoals.monthly, monthProgressBarEl, monthProgressTextEl);
  renderGoalBadges();
}

function renderResult(payload) {
  if (!payload?.ok) {
    currentStats = null;
    todayCountEl.textContent = "-";
    weekCountEl.textContent = "-";
    monthCountEl.textContent = "-";
    todayDifficultyEl.textContent = "Easy: - | Medium: - | Hard: -";
    weekDifficultyEl.textContent = "Easy: - | Medium: - | Hard: -";
    monthDifficultyEl.textContent = "Easy: - | Medium: - | Hard: -";
    const baseError = payload?.error || "Failed to fetch data.";
    statusEl.textContent = baseError;
    showAlert(baseError);
    showErrorDetails(payload?.details || "");
    renderProgressCards();
    return;
  }

  currentStats = payload;
  showAlert("");
  showErrorDetails("");

  todayCountEl.textContent = String(payload.today.count);
  weekCountEl.textContent = String(payload.week.count);
  monthCountEl.textContent = String(payload.month.count);

  todayDifficultyEl.textContent = difficultyText(payload.today.byDifficulty);
  weekDifficultyEl.textContent = difficultyText(payload.week.byDifficulty);
  monthDifficultyEl.textContent = difficultyText(payload.month.byDifficulty);

  lastUpdatedAt = new Date();
  setLastUpdatedStatus();

  renderProgressCards();
}

async function queryActiveTab() {
  if (isRefreshing) {
    return;
  }
  isRefreshing = true;
  setLoading(true);

  try {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const activeHostname = activeTab?.url ? new URL(activeTab.url).hostname : "";
    const activeIsLeetCode = activeHostname === "leetcode.com" || activeHostname.endsWith(".leetcode.com");

    let targetTab = activeIsLeetCode ? activeTab : null;
    if (!targetTab) {
      const leetCodeTabs = await chrome.tabs.query({
        currentWindow: true,
        url: ["*://leetcode.com/*", "*://*.leetcode.com/*"]
      });
      targetTab = leetCodeTabs[0] || null;
    }

    if (!targetTab?.id) {
      renderResult({
        ok: false,
        error: "Please log in to LeetCode first and keep at least one LeetCode tab open."
      });
      return;
    }

    let response;

    try {
      response = await chrome.tabs.sendMessage(targetTab.id, { type: "GET_TODAY_SOLVED_COUNT" });
      if (!response) {
        throw new Error("No response from content script");
      }
    } catch (firstError) {
      await chrome.scripting.executeScript({
        target: { tabId: targetTab.id },
        files: ["leetcode-goal-content.js"]
      });

      response = await chrome.tabs.sendMessage(targetTab.id, { type: "GET_TODAY_SOLVED_COUNT" });
      if (!response) {
        throw new Error("No response after reinjection");
      }
    }

    renderResult(response);
  } catch (error) {
    renderResult({
      ok: false,
      error: "Unable to refresh stats. Open a LeetCode page and make sure you are logged in.",
      details: error?.message || String(error)
    });
  } finally {
    isRefreshing = false;
    refreshBtn.disabled = false;
  }
}

async function initializeGoals() {
  currentGoals = await getGoalsFromStorage();
  fillGoalInputs(currentGoals);
  renderProgressCards();
}

goalFormEl.addEventListener("submit", async (event) => {
  event.preventDefault();

  const daily = parseGoalInput(dailyGoalInputEl.value, "Daily goal", 50);
  const weekly = parseGoalInput(weeklyGoalInputEl.value, "Weekly goal", 300);
  const monthly = parseGoalInput(monthlyGoalInputEl.value, "Monthly goal", 1000);
  const invalid = [daily, weekly, monthly].find((item) => !item.ok);
  if (invalid) {
    showGoalError(invalid.error);
    return;
  }

  currentGoals = {
    daily: daily.value,
    weekly: weekly.value,
    monthly: monthly.value
  };

  await saveGoalsToStorage(currentGoals);
  fillGoalInputs(currentGoals);
  renderProgressCards();
  showGoalError("");
  showAlert("");
  showErrorDetails("");
  statusEl.textContent = "Goals saved.";
  if (lastUpdatedAt) {
    statusEl.textContent += ` Last updated at ${formatLastUpdated(lastUpdatedAt)}`;
  }
});

[dailyGoalInputEl, weeklyGoalInputEl, monthlyGoalInputEl].forEach((input) => {
  input.addEventListener("input", () => showGoalError(""));
});

refreshBtn.addEventListener("click", queryActiveTab);

(async function boot() {
  clearBadge();
  await initializeGoals();
  await queryActiveTab();
})();
