const MESSAGE_TYPE = "GET_TODAY_SOLVED_COUNT";
const LAST_STATS_KEY = "lastBadgeStats";

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getWeekStart(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diffToMonday);
  return d;
}

function getPeriodKeys(now = new Date()) {
  const dayKey = formatDateKey(now);
  const weekKey = formatDateKey(getWeekStart(now));
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  return { dayKey, weekKey, monthKey };
}

function withCacheMeta(stats) {
  return {
    ...stats,
    _cacheMeta: {
      ...getPeriodKeys(),
      cachedAt: new Date().toISOString()
    }
  };
}

function getEmptyRangeStats() {
  return {
    count: 0,
    byDifficulty: { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 }
  };
}

function normalizeCachedStats(storedStats) {
  if (!storedStats?.ok) {
    return storedStats;
  }

  const current = getPeriodKeys();
  const cached = storedStats?._cacheMeta || {};
  let changed = false;

  const normalized = {
    ...storedStats,
    today: { ...storedStats.today },
    week: { ...storedStats.week },
    month: { ...storedStats.month },
    _cacheMeta: {
      ...current,
      cachedAt: new Date().toISOString()
    }
  };

  if (cached.dayKey !== current.dayKey) {
    normalized.today = { ...normalized.today, ...getEmptyRangeStats() };
    changed = true;
  }
  if (cached.weekKey !== current.weekKey) {
    normalized.week = { ...normalized.week, ...getEmptyRangeStats() };
    changed = true;
  }
  if (cached.monthKey !== current.monthKey) {
    normalized.month = { ...normalized.month, ...getEmptyRangeStats() };
    changed = true;
  }

  return { normalized, changed };
}

function isLeetCodeUrl(url) {
  try {
    const hostname = new URL(url).hostname;
    return hostname === "leetcode.com" || hostname.endsWith(".leetcode.com");
  } catch {
    return false;
  }
}

function setIdleBadge() {
  chrome.action.setBadgeText({ text: "" });
  chrome.action.setTitle({ title: "LeetCode Goal Tracker" });
}

function setErrorBadge() {
  chrome.action.setBadgeText({ text: "!" });
  chrome.action.setBadgeBackgroundColor({ color: "#7f1d1d" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
  chrome.action.setTitle({ title: "LeetCode Goal Tracker: refresh failed" });
}

function setBadgeFromStats(stats) {
  const today = Number(stats?.today?.count ?? 0);
  const week = Number(stats?.week?.count ?? 0);
  const month = Number(stats?.month?.count ?? 0);
  const text = today > 999 ? "999+" : String(Math.max(0, today));

  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: "#166534" });
  chrome.action.setBadgeTextColor({ color: "#ffffff" });
  chrome.action.setTitle({ title: `Today: ${today} | Week: ${week} | Month: ${month}` });
}

function saveLastStats(stats) {
  chrome.storage.local.set({ [LAST_STATS_KEY]: withCacheMeta(stats) });
}

async function loadLastStats() {
  return new Promise((resolve) => {
    chrome.storage.local.get([LAST_STATS_KEY], (data) => {
      resolve(data?.[LAST_STATS_KEY] || null);
    });
  });
}

async function requestStatsFromTab(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPE });
    if (!response) {
      throw new Error("No response from content script");
    }
    return response;
  } catch {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["leetcode-goal-content.js"]
    });

    const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPE });
    if (!response) {
      throw new Error("No response after reinjection");
    }
    return response;
  }
}

async function refreshBadgeFromTab(tabId, tabUrl) {
  if (!tabId || !isLeetCodeUrl(tabUrl)) {
    return false;
  }
  try {
    const response = await requestStatsFromTab(tabId);
    if (response?.ok) {
      setBadgeFromStats(response);
      saveLastStats(response);
      return true;
    } else {
      setErrorBadge();
      return false;
    }
  } catch {
    setErrorBadge();
    return false;
  }
}

async function initBadge() {
  const lastStats = await loadLastStats();
  const normalized = normalizeCachedStats(lastStats);
  if (normalized?.normalized?.ok) {
    setBadgeFromStats(normalized.normalized);
    if (normalized.changed) {
      chrome.storage.local.set({ [LAST_STATS_KEY]: normalized.normalized });
    }
  } else {
    setIdleBadge();
  }
}

chrome.runtime.onInstalled.addListener(() => {
  initBadge();
});

chrome.runtime.onStartup.addListener(() => {
  initBadge();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "UPDATE_BADGE_FROM_STATS") {
    if (message?.stats?.ok) {
      setBadgeFromStats(message.stats);
      saveLastStats(message.stats);
      sendResponse({ ok: true });
    } else {
      sendResponse({ ok: false });
    }
    return true;
  }

  if (message?.type === "REFRESH_BADGE") {
    const tabId = sender?.tab?.id;
    const tabUrl = sender?.tab?.url;
    refreshBadgeFromTab(tabId, tabUrl)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
