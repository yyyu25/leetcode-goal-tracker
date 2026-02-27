const LEETCODE_SUBMISSIONS_PATH = "/api/submissions/";
const LEETCODE_PROBLEMS_ALL_PATH = "/api/problems/all/";
const PAGE_SIZE = 20;
const MAX_PAGES = 40;
const GRAPHQL_PAGE_SIZE = 20;
const MAX_GRAPHQL_PAGES = 120;
const API_ORIGIN = window.location.origin;
const GRAPHQL_URL = new URL("/graphql/", API_ORIGIN).toString();

const DIFFICULTY_CACHE_KEY = "difficultyMapCache";
const DIFFICULTY_CACHE_MAX_ENTRIES = 1000;
const DIFFICULTY_CACHE_COMPACT_INTERVAL_MS = 60 * 60 * 1000;
const USERNAME_CACHE_TTL_MS = 60 * 1000;

const STATS_CACHE_PREFIX = "statsCache:";
const STATS_CACHE_VERSION = 3;
let usernameCache = {
  value: "",
  fetchedAt: 0
};
let lastDifficultyCompactionAt = 0;

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

function formatDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getPeriodKeys(now) {
  return {
    dayKey: formatDateKey(now),
    weekKey: formatDateKey(getWeekStart(now)),
    monthKey: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  };
}

function isSameLocalDay(unixSeconds, targetDate) {
  const d = new Date(unixSeconds * 1000);
  return (
    d.getFullYear() === targetDate.getFullYear() &&
    d.getMonth() === targetDate.getMonth() &&
    d.getDate() === targetDate.getDate()
  );
}

function isInRangeToNow(unixSeconds, rangeStart, now) {
  const t = unixSeconds * 1000;
  return t >= rangeStart.getTime() && t <= now.getTime();
}

function levelToDifficulty(level) {
  if (level === 1) return "Easy";
  if (level === 2) return "Medium";
  if (level === 3) return "Hard";
  return "Unknown";
}

function normalizeDifficultyObject(value) {
  return {
    Easy: Number(value?.Easy || 0),
    Medium: Number(value?.Medium || 0),
    Hard: Number(value?.Hard || 0),
    Unknown: Number(value?.Unknown || 0)
  };
}

function newPeriodState() {
  return {
    count: 0,
    byDifficulty: normalizeDifficultyObject(),
    seenSlugs: []
  };
}

function normalizePeriodState(state) {
  const period = state || {};
  const seen = Array.isArray(period.seenSlugs) ? period.seenSlugs : [];
  const uniqueSeen = [...new Set(seen.filter(Boolean))];
  return {
    count: Number(period.count || 0),
    byDifficulty: normalizeDifficultyObject(period.byDifficulty),
    seenSlugs: uniqueSeen
  };
}

function getStatsCacheKey(username) {
  return `${STATS_CACHE_PREFIX}${username}`;
}

function makeFreshCache(username, now) {
  return {
    version: STATS_CACHE_VERSION,
    username,
    lastCheckedTs: 0,
    monthBaselineKey: "",
    periodKeys: getPeriodKeys(now),
    today: newPeriodState(),
    week: newPeriodState(),
    month: newPeriodState()
  };
}

function normalizeStatsCache(rawCache, username, now) {
  const fresh = makeFreshCache(username, now);
  if (!rawCache || rawCache.version !== STATS_CACHE_VERSION || rawCache.username !== username) {
    return { cache: fresh, resetMonth: true };
  }

  const currentKeys = getPeriodKeys(now);
  const previousKeys = rawCache.periodKeys || {};

  const cache = {
    version: STATS_CACHE_VERSION,
    username,
    lastCheckedTs: Number(rawCache.lastCheckedTs || 0),
    monthBaselineKey: String(rawCache.monthBaselineKey || ""),
    periodKeys: currentKeys,
    today: normalizePeriodState(rawCache.today),
    week: normalizePeriodState(rawCache.week),
    month: normalizePeriodState(rawCache.month)
  };

  const resetToday = previousKeys.dayKey !== currentKeys.dayKey;
  const resetWeek = previousKeys.weekKey !== currentKeys.weekKey;
  const resetMonth = previousKeys.monthKey !== currentKeys.monthKey;

  if (resetToday) {
    cache.today = newPeriodState();
  }
  if (resetWeek) {
    cache.week = newPeriodState();
  }
  if (resetMonth) {
    cache.month = newPeriodState();
    cache.monthBaselineKey = "";
  }

  return { cache, resetMonth };
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (result) => resolve(result || {}));
  });
}

function storageSet(data) {
  return new Promise((resolve) => {
    chrome.storage.local.set(data, resolve);
  });
}

function getUniqueNonEmptySlugs(slugs) {
  return [...new Set((Array.isArray(slugs) ? slugs : []).filter(Boolean))];
}

function compactDifficultyValues(values, preserveSlugs) {
  const source = values && typeof values === "object" ? values : {};
  const entries = Object.entries(source);
  if (entries.length <= DIFFICULTY_CACHE_MAX_ENTRIES) {
    return { values: source, changed: false };
  }

  const compacted = {};
  let count = 0;
  const preserve = getUniqueNonEmptySlugs(preserveSlugs);
  for (const slug of preserve) {
    if (source[slug]) {
      compacted[slug] = source[slug];
      count += 1;
      if (count >= DIFFICULTY_CACHE_MAX_ENTRIES) {
        break;
      }
    }
  }

  if (count < DIFFICULTY_CACHE_MAX_ENTRIES) {
    for (const [slug, difficulty] of entries) {
      if (compacted[slug]) {
        continue;
      }
      compacted[slug] = difficulty;
      count += 1;
      if (count >= DIFFICULTY_CACHE_MAX_ENTRIES) {
        break;
      }
    }
  }

  return { values: compacted, changed: true };
}

async function compactDifficultyCacheIfNeeded(preserveSlugs) {
  const now = Date.now();
  if (now - lastDifficultyCompactionAt < DIFFICULTY_CACHE_COMPACT_INTERVAL_MS) {
    return;
  }
  lastDifficultyCompactionAt = now;

  const cacheData = await storageGet([DIFFICULTY_CACHE_KEY]);
  const cached = cacheData?.[DIFFICULTY_CACHE_KEY];
  if (!cached?.values || typeof cached.values !== "object") {
    return;
  }

  const compacted = compactDifficultyValues(cached.values, preserveSlugs);
  if (!compacted.changed) {
    return;
  }

  await storageSet({
    [DIFFICULTY_CACHE_KEY]: {
      cachedAt: now,
      values: compacted.values
    }
  });
}

async function fetchSubmissionPage(offset) {
  const url = new URL(LEETCODE_SUBMISSIONS_PATH, API_ORIGIN);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("limit", String(PAGE_SIZE));
  const csrfToken = getCookieValue("csrftoken");

  const res = await fetch(url.toString(), {
    method: "GET",
    credentials: "include",
    headers: {
      "x-csrftoken": csrfToken,
      "x-requested-with": "XMLHttpRequest"
    }
  });

  if (!res.ok) {
    const err = new Error(`Submissions API HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
}

function getCookieValue(name) {
  const pattern = `${name}=`;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const cookie = part.trim();
    if (cookie.startsWith(pattern)) {
      return decodeURIComponent(cookie.slice(pattern.length));
    }
  }
  return "";
}

async function graphqlRequest(query, variables = {}) {
  const csrfToken = getCookieValue("csrftoken");
  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
      "x-csrftoken": csrfToken,
      "x-requested-with": "XMLHttpRequest"
    },
    body: JSON.stringify({ query, variables })
  });

  if (!res.ok) {
    throw new Error(`GraphQL HTTP ${res.status}`);
  }

  const data = await res.json();
  if (Array.isArray(data?.errors) && data.errors.length > 0) {
    throw new Error(data.errors[0]?.message || "GraphQL error");
  }

  return data?.data || {};
}

async function fetchCurrentUsername() {
  const now = Date.now();
  if (usernameCache.value && now - usernameCache.fetchedAt < USERNAME_CACHE_TTL_MS) {
    return usernameCache.value;
  }

  const userQuery = `
    query userStatus {
      userStatus {
        username
      }
    }
  `;
  const userData = await graphqlRequest(userQuery);
  const username = userData?.userStatus?.username;
  if (!username) {
    throw new Error("Unable to determine current LeetCode username");
  }

  usernameCache = {
    value: username,
    fetchedAt: now
  };

  return username;
}

async function fetchLoginStatus() {
  try {
    const username = await fetchCurrentUsername();
    return { loggedIn: true, username };
  } catch {
    usernameCache = { value: "", fetchedAt: 0 };
    return { loggedIn: false, username: "" };
  }
}

function normalizeGraphQLSubmission(rawSubmission) {
  return {
    title: rawSubmission?.title || "",
    titleSlug: rawSubmission?.titleSlug || rawSubmission?.title_slug || "",
    timestamp: rawSubmission?.timestamp,
    statusDisplay: rawSubmission?.statusDisplay || rawSubmission?.status_display || ""
  };
}

async function fetchGraphQLSubmissionPage(username, offset, lastKey) {
  const variants = [
    {
      source: "graphql_submission_list_username",
      query: `
        query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $username: String!) {
          submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, username: $username) {
            lastKey
            hasNext
            submissions {
              title
              titleSlug
              timestamp
              statusDisplay
            }
          }
        }
      `,
      variables: {
        username,
        offset,
        limit: GRAPHQL_PAGE_SIZE,
        lastKey
      }
    },
    {
      source: "graphql_submission_list_default",
      query: `
        query submissionList($offset: Int!, $limit: Int!, $lastKey: String) {
          submissionList(offset: $offset, limit: $limit, lastKey: $lastKey) {
            lastKey
            hasNext
            submissions {
              title
              titleSlug
              timestamp
              statusDisplay
            }
          }
        }
      `,
      variables: {
        offset,
        limit: GRAPHQL_PAGE_SIZE,
        lastKey
      }
    },
    {
      source: "graphql_submission_list_status",
      query: `
        query submissionList($offset: Int!, $limit: Int!, $lastKey: String, $status: Int) {
          submissionList(offset: $offset, limit: $limit, lastKey: $lastKey, status: $status) {
            lastKey
            hasNext
            submissions {
              title
              titleSlug
              timestamp
              statusDisplay
            }
          }
        }
      `,
      variables: {
        offset,
        limit: GRAPHQL_PAGE_SIZE,
        lastKey,
        status: 10
      }
    }
  ];

  const errors = [];

  for (const variant of variants) {
    try {
      const data = await graphqlRequest(variant.query, variant.variables);
      const page = data?.submissionList;
      if (page && typeof page === "object") {
        return { pageData: page, source: variant.source };
      }
      if (page == null) {
        return {
          pageData: { submissions: [], hasNext: false, lastKey: null },
          source: variant.source
        };
      }
      errors.push(`${variant.source}: unexpected payload`);
    } catch (error) {
      errors.push(`${variant.source}: ${error?.message || String(error)}`);
    }
  }

  throw new Error(`GraphQL submissionList variants failed: ${errors.join(" | ")}`);
}

async function fetchRecentAcceptedWithGraphQL(username, sinceTs) {
  const query = `
    query recentAcSubmissionList($username: String!) {
      recentAcSubmissionList(username: $username) {
        title
        titleSlug
        timestamp
      }
    }
  `;

  const data = await graphqlRequest(query, { username });
  const list = Array.isArray(data?.recentAcSubmissionList) ? data.recentAcSubmissionList : [];
  const accepted = [];
  const seen = new Set();

  for (const raw of list) {
    const submission = normalizeGraphQLSubmission(raw);
    const unixSeconds = Number(submission.timestamp);
    if (!Number.isFinite(unixSeconds) || unixSeconds <= sinceTs) {
      continue;
    }
    const slug = submission.titleSlug || submission.title;
    if (!slug) {
      continue;
    }
    pushAcceptedIfNew(accepted, seen, { slug, timestamp: unixSeconds });
  }

  return accepted;
}

async function fetchDifficultyMap(requiredSlugs) {
  const neededSlugs = getUniqueNonEmptySlugs(requiredSlugs);
  if (!neededSlugs.length) {
    return new Map();
  }

  const cacheData = await storageGet([DIFFICULTY_CACHE_KEY]);
  const cached = cacheData?.[DIFFICULTY_CACHE_KEY];
  const values = cached?.values && typeof cached.values === "object" ? { ...cached.values } : {};
  const missingSlugs = neededSlugs.filter((slug) => !values[slug]);

  if (missingSlugs.length > 0) {
    const missingSet = new Set(missingSlugs);
    const res = await fetch(new URL(LEETCODE_PROBLEMS_ALL_PATH, API_ORIGIN).toString(), {
      method: "GET",
      credentials: "include"
    });

    if (!res.ok) {
      throw new Error(`Problems API HTTP ${res.status}`);
    }

    const data = await res.json();
    const pairs = Array.isArray(data?.stat_status_pairs) ? data.stat_status_pairs : [];
    for (const pair of pairs) {
      const slug = pair?.stat?.question__title_slug;
      if (!slug || !missingSet.has(slug)) {
        continue;
      }
      const level = Number(pair?.difficulty?.level);
      values[slug] = levelToDifficulty(level);
      missingSet.delete(slug);
      if (!missingSet.size) {
        break;
      }
    }

    const compacted = compactDifficultyValues(values, neededSlugs);
    const persistedValues = compacted.changed ? compacted.values : values;
    await storageSet({
      [DIFFICULTY_CACHE_KEY]: {
        cachedAt: Date.now(),
        values: persistedValues
      }
    });

    return new Map(
      neededSlugs.map((slug) => [slug, persistedValues[slug]]).filter(([, difficulty]) => Boolean(difficulty))
    );
  }

  return new Map(neededSlugs.map((slug) => [slug, values[slug]]).filter(([, difficulty]) => Boolean(difficulty)));
}

function pushAcceptedIfNew(list, seen, item) {
  const key = `${item.slug}:${item.timestamp}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  list.push(item);
}

function createSubmissionsApiAdapter() {
  return {
    source: "submissions_api",
    maxPages: MAX_PAGES,
    initialCursor() {
      return { offset: 0 };
    },
    async list({ sinceTs, cursor }) {
      const offset = Number(cursor?.offset || 0);
      const data = await fetchSubmissionPage(offset);
      const submissions = Array.isArray(data?.submissions_dump) ? data.submissions_dump : [];
      if (!submissions.length) {
        return { events: [], done: true, nextCursor: null };
      }

      const events = [];
      let reachedOld = false;
      for (const submission of submissions) {
        const unixSeconds = Number(submission?.timestamp);
        if (!Number.isFinite(unixSeconds)) {
          continue;
        }
        if (unixSeconds <= sinceTs) {
          reachedOld = true;
          break;
        }
        if (submission?.status_display !== "Accepted") {
          continue;
        }
        const slug = submission?.title_slug || submission?.title;
        if (!slug) {
          continue;
        }
        events.push({ slug, timestamp: unixSeconds });
      }

      const done = reachedOld || data?.has_next === false || submissions.length < PAGE_SIZE;
      const nextCursor = done ? null : { offset: offset + PAGE_SIZE };
      return { events, done, nextCursor };
    }
  };
}

function createGraphQLSubmissionListAdapter(username) {
  const seenLastKeys = new Set();
  return {
    source: "graphql_submission_list",
    maxPages: MAX_GRAPHQL_PAGES,
    initialCursor() {
      return { offset: 0, lastKey: null };
    },
    async list({ sinceTs, cursor }) {
      const offset = Number(cursor?.offset || 0);
      const currentLastKey = cursor?.lastKey || null;
      const result = await fetchGraphQLSubmissionPage(username, offset, currentLastKey);
      const pageData = result?.pageData || null;
      const source = result?.source || "graphql_submission_list";
      const submissions = Array.isArray(pageData?.submissions) ? pageData.submissions : [];
      if (!submissions.length) {
        return { source, events: [], done: true, nextCursor: null };
      }

      const events = [];
      let reachedOld = false;
      for (const raw of submissions) {
        const submission = normalizeGraphQLSubmission(raw);
        const unixSeconds = Number(submission.timestamp);
        if (!Number.isFinite(unixSeconds)) {
          continue;
        }
        if (unixSeconds <= sinceTs) {
          reachedOld = true;
          break;
        }
        if (submission.statusDisplay !== "Accepted") {
          continue;
        }
        const slug = submission.titleSlug || submission.title;
        if (!slug) {
          continue;
        }
        events.push({ slug, timestamp: unixSeconds });
      }

      if (reachedOld) {
        return { source, events, done: true, nextCursor: null };
      }

      const hasNext = Boolean(pageData?.hasNext);
      const nextLastKey = pageData?.lastKey || null;
      if (!hasNext && !nextLastKey) {
        return { source, events, done: true, nextCursor: null };
      }

      // Cursor-first pagination: prefer lastKey, use offset only when cursor is unavailable.
      if (nextLastKey) {
        if (nextLastKey === currentLastKey || seenLastKeys.has(nextLastKey)) {
          return { source, events, done: true, nextCursor: null };
        }
        seenLastKeys.add(nextLastKey);
        return { source, events, done: false, nextCursor: { offset, lastKey: nextLastKey } };
      }

      return { source, events, done: false, nextCursor: { offset: offset + GRAPHQL_PAGE_SIZE, lastKey: null } };
    }
  };
}

async function fetchAcceptedWithAdapter(adapter, sinceTs) {
  const accepted = [];
  const seen = new Set();
  let cursor = adapter.initialCursor();
  let resolvedSource = adapter.source || "unknown";

  for (let page = 0; page < adapter.maxPages; page += 1) {
    const pageResult = await adapter.list({ sinceTs, cursor, page });
    if (pageResult?.source && (page === 0 || resolvedSource === adapter.source)) {
      resolvedSource = pageResult.source;
    }

    const events = Array.isArray(pageResult?.events) ? pageResult.events : [];
    for (const event of events) {
      if (!event?.slug) {
        continue;
      }
      const unixSeconds = Number(event.timestamp);
      if (!Number.isFinite(unixSeconds)) {
        continue;
      }
      pushAcceptedIfNew(accepted, seen, { slug: event.slug, timestamp: unixSeconds });
    }

    if (pageResult?.done || !pageResult?.nextCursor) {
      return { accepted, source: resolvedSource, pageLimitReached: false };
    }

    cursor = pageResult.nextCursor;
  }

  return { accepted, source: resolvedSource, pageLimitReached: true };
}

async function fetchNewAcceptedWithSubmissionsApi(sinceTs) {
  const adapter = createSubmissionsApiAdapter();
  return fetchAcceptedWithAdapter(adapter, sinceTs);
}

async function fetchNewAcceptedWithGraphQL(username, sinceTs) {
  try {
    const adapter = createGraphQLSubmissionListAdapter(username);
    return fetchAcceptedWithAdapter(adapter, sinceTs);
  } catch (error) {
    const accepted = await fetchRecentAcceptedWithGraphQL(username, sinceTs);
    return {
      accepted,
      source: "graphql_recent_ac_submission_list",
      fallbackReason: error?.message || String(error),
      pageLimitReached: true
    };
  }
}

async function fetchNewAcceptedSince(sinceTs, username) {
  try {
    const result = await fetchNewAcceptedWithSubmissionsApi(sinceTs);
    return {
      accepted: Array.isArray(result?.accepted) ? result.accepted : [],
      source: "submissions_api",
      pageLimitReached: Boolean(result?.pageLimitReached)
    };
  } catch (error) {
    if (error?.status === 403 || String(error?.message || "").includes("HTTP 403")) {
      return fetchNewAcceptedWithGraphQL(username, sinceTs);
    }
    throw error;
  }
}

function buildFetchWarning(source, pageLimitReached, baselinePerformed) {
  if (source === "graphql_recent_ac_submission_list") {
    return baselinePerformed
      ? "This month may be incomplete because LeetCode fallback only returned recent accepted submissions."
      : "Stats may be incomplete because LeetCode fallback only returned recent accepted submissions.";
  }
  if (!pageLimitReached) {
    return "";
  }
  return baselinePerformed
    ? "This month may be incomplete due to API pagination limits."
    : "Stats may be incomplete due to API pagination limits.";
}

function applyAcceptedToPeriods(cache, acceptedSubmissions, now, weekStart, monthStart, slugToDifficulty) {
  if (!Array.isArray(acceptedSubmissions) || acceptedSubmissions.length === 0) {
    return;
  }

  const todaySeen = new Set(cache.today.seenSlugs);
  const weekSeen = new Set(cache.week.seenSlugs);
  const monthSeen = new Set(cache.month.seenSlugs);

  let newestTs = Number(cache.lastCheckedTs || 0);

  for (const submission of acceptedSubmissions) {
    const unixSeconds = Number(submission.timestamp);
    if (!Number.isFinite(unixSeconds)) {
      continue;
    }

    if (unixSeconds > newestTs) {
      newestTs = unixSeconds;
    }

    const slug = submission.slug;
    if (!slug) {
      continue;
    }

    const difficulty = slugToDifficulty.get(slug) || "Unknown";

    if (isInRangeToNow(unixSeconds, monthStart, now) && !monthSeen.has(slug)) {
      monthSeen.add(slug);
      cache.month.count += 1;
      cache.month.byDifficulty[difficulty] += 1;
    }

    if (isInRangeToNow(unixSeconds, weekStart, now) && !weekSeen.has(slug)) {
      weekSeen.add(slug);
      cache.week.count += 1;
      cache.week.byDifficulty[difficulty] += 1;
    }

    if (isSameLocalDay(unixSeconds, now) && !todaySeen.has(slug)) {
      todaySeen.add(slug);
      cache.today.count += 1;
      cache.today.byDifficulty[difficulty] += 1;
    }
  }

  cache.today.seenSlugs = [...todaySeen];
  cache.week.seenSlugs = [...weekSeen];
  cache.month.seenSlugs = [...monthSeen];
  cache.lastCheckedTs = newestTs;
}

function buildRangeStats(periodState) {
  return {
    count: Number(periodState.count || 0),
    byDifficulty: normalizeDifficultyObject(periodState.byDifficulty)
  };
}

async function buildStatsIncremental(username) {
  const now = new Date();
  const weekStart = getWeekStart(now);
  const monthStart = getMonthStart(now);

  const cacheKey = getStatsCacheKey(username);
  const cacheData = await storageGet([cacheKey]);
  const normalized = normalizeStatsCache(cacheData?.[cacheKey], username, now);
  const cache = normalized.cache;
  const cacheBefore = JSON.stringify(cache);
  await compactDifficultyCacheIfNeeded(cache.month.seenSlugs);

  let sinceTs = Number(cache.lastCheckedTs || 0);
  const lastCheckedBefore = sinceTs;
  if (!sinceTs || normalized.resetMonth) {
    sinceTs = Math.floor(monthStart.getTime() / 1000) - 1;
    cache.lastCheckedTs = sinceTs;
  }

  const monthKey = cache?.periodKeys?.monthKey || getPeriodKeys(now).monthKey;
  const needsMonthBaseline = cache.monthBaselineKey !== monthKey;

  let acceptedSubmissions = [];
  let fetchSource = "unknown";
  let fallbackReason = "";
  let baselinePerformed = false;
  let baselineSource = "";
  let baselineFallbackReason = "";
  let pageLimitReached = false;

  if (needsMonthBaseline) {
    baselinePerformed = true;
    const baselineSinceTs = Math.floor(monthStart.getTime() / 1000) - 1;
    const baselineResult = await fetchNewAcceptedSince(baselineSinceTs, username);
    acceptedSubmissions = Array.isArray(baselineResult?.accepted) ? baselineResult.accepted : [];
    fetchSource = baselineResult?.source || "unknown";
    fallbackReason = baselineResult?.fallbackReason || "";
    pageLimitReached = Boolean(baselineResult?.pageLimitReached);
    baselineSource = fetchSource;
    baselineFallbackReason = fallbackReason;

    cache.today = newPeriodState();
    cache.week = newPeriodState();
    cache.month = newPeriodState();
    cache.lastCheckedTs = baselineSinceTs;
    sinceTs = baselineSinceTs;
  } else {
    const fetchResult = await fetchNewAcceptedSince(sinceTs, username);
    acceptedSubmissions = Array.isArray(fetchResult?.accepted) ? fetchResult.accepted : [];
    fetchSource = fetchResult?.source || "unknown";
    fallbackReason = fetchResult?.fallbackReason || "";
    pageLimitReached = Boolean(fetchResult?.pageLimitReached);
  }

  let slugToDifficulty = new Map();
  if (acceptedSubmissions.length > 0) {
    const acceptedSlugs = getUniqueNonEmptySlugs(acceptedSubmissions.map((item) => item?.slug));
    slugToDifficulty = await fetchDifficultyMap(acceptedSlugs);
  }

  applyAcceptedToPeriods(cache, acceptedSubmissions, now, weekStart, monthStart, slugToDifficulty);
  if (needsMonthBaseline) {
    cache.monthBaselineKey = monthKey;
  }

  const cacheAfter = JSON.stringify(cache);
  if (cacheAfter !== cacheBefore) {
    await storageSet({ [cacheKey]: cache });
  }

  let earliestFetchedTs = 0;
  for (const item of acceptedSubmissions) {
    const ts = Number(item?.timestamp || 0);
    if (!ts) {
      continue;
    }
    if (!earliestFetchedTs || ts < earliestFetchedTs) {
      earliestFetchedTs = ts;
    }
  }

  const warning = buildFetchWarning(fetchSource, pageLimitReached, baselinePerformed);

  return {
    today: buildRangeStats(cache.today),
    week: {
      ...buildRangeStats(cache.week),
      weekStartISO: weekStart.toISOString()
    },
    month: {
      ...buildRangeStats(cache.month),
      monthStartISO: monthStart.toISOString()
    },
    warning,
    debug: {
      source: fetchSource,
      acceptedFetchedCount: acceptedSubmissions.length,
      earliestFetchedTs,
      sinceTs,
      lastCheckedBefore,
      lastCheckedAfter: Number(cache.lastCheckedTs || 0),
      periodKeys: cache.periodKeys,
      pageLimitReached,
      fallbackReason,
      baselinePerformed,
      baselineSource,
      baselineFallbackReason
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "GET_TODAY_SOLVED_COUNT") {
    return false;
  }

  fetchLoginStatus()
    .then(async (login) => {
      if (!login.loggedIn) {
        sendResponse({
          ok: false,
          error: "Please log in to LeetCode first and keep the LeetCode tab open, then refresh.",
          details: "Unable to determine current LeetCode username",
          login
        });
        return;
      }

      try {
        const stats = await buildStatsIncremental(login.username);
        sendResponse({ ok: true, ...stats, login });
      } catch (error) {
        const details = error?.message || String(error);
        const lowered = String(details).toLowerCase();
        const isAuthError =
          lowered.includes("unable to determine current leetcode username") ||
          lowered.includes("submissions api http 401") ||
          lowered.includes("submissions api http 403") ||
          lowered.includes("graphql http 401") ||
          lowered.includes("graphql http 403") ||
          lowered.includes("login") ||
          lowered.includes("signin");

        sendResponse({
          ok: false,
          error: isAuthError
            ? "Please log in to LeetCode first and keep the LeetCode tab open, then refresh."
            : "Could not fetch submissions. Refresh the LeetCode tab and try again.",
          details,
          login
        });
      }
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: "Could not fetch submissions. Refresh the LeetCode tab and try again.",
        details: error?.message || String(error),
        login: { loggedIn: false, username: "" }
      });
    });

  return true;
});
