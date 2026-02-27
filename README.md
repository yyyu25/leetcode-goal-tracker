# LeetCode Goal Tracker

`leetcode-goal-tracker` is a Chrome extension that tracks your **unique accepted LeetCode problems** for:

- Today
- This Week (Monday to Sunday, until now)
- This Month (from day 1, until now)

It also shows difficulty breakdown for each period: **Easy / Medium / Hard**.

## What This Extension Solves

- You can quickly see progress for daily/weekly/monthly goals.
- Repeated accepted submissions for the same problem are counted once per period.
- The popup is compact and refreshes automatically when opened.

## Core Features

- Unique solved counting by problem slug (not by submission count)
- Daily / Weekly / Monthly goals
- Progress bars + goal status badges:
  - `No Goal`
  - `Behind`
  - `On Track`
  - `Achieved`
- Auto refresh on popup open
- Manual refresh via `Refresh Stats`
- Last updated timestamp
- Friendly login prompt if LeetCode tab/session is unavailable
- Debug panel hidden for normal users
- Toolbar badge disabled by design

## How Counting Works

- Time boundaries use your **browser local timezone**.
- `Today`: local calendar day.
- `This Week`: from local Monday 00:00 to now.
- `This Month`: from local month start 00:00 to now.
- Counting rule: **unique solved per period by problem slug**.

## Data Sources and Fallback

Primary source:
- `GET https://leetcode.com/api/submissions/`

Fallback chain:
- GraphQL `submissionList`
- GraphQL `recentAcSubmissionList`

Difficulty source:
- `GET https://leetcode.com/api/problems/all/`

## Performance and Storage Design

- Incremental cache per username in `chrome.storage.local`
- Automatic reset at day/week/month boundaries
- Monthly baseline rebuild when month changes
- Short username cache to reduce repeated login queries
- Difficulty cache is compacted and size-limited for lower memory usage
- Skip `storage.set` when no cache changes

## Goal Input Limits

- Daily: `0 ~ 50`
- Weekly: `0 ~ 300`
- Monthly: `0 ~ 1000`

## Project Structure

- `manifest.json`: Chrome extension manifest (MV3)
- `leetcode-goal-popup.html`: popup UI
- `leetcode-goal-popup.css`: popup styles
- `leetcode-goal-popup.js`: popup logic and goal handling
- `leetcode-goal-content.js`: LeetCode page data fetch + incremental stats engine
- `leetcode-goal-background.js`: background logic (badge/cache helpers)
- `icons/icon.png`: extension icon

## Local Installation Tutorial

1. Open Chrome `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select this project folder
5. Pin the extension if needed

## How To Use

1. Log in to [LeetCode](https://leetcode.com/) and keep at least one LeetCode tab open.
2. Click the extension icon.
3. Set Daily / Weekly / Monthly goals and click `Save Goals`.
4. The popup auto-refreshes stats each time you open it.
5. Click `Refresh Stats` if you want an immediate manual refresh.

## Troubleshooting

- Message: `Please log in to LeetCode first...`
  - Make sure you are logged in on LeetCode and at least one LeetCode tab is open.
- Data seems old:
  - Click `Refresh Stats`, or reopen popup.
- First load after installing:
  - Refresh the opened LeetCode tab once, then retry.

## Privacy Notes

- All goals and caches are stored locally in your browser via `chrome.storage.local`.
- No external analytics or custom telemetry is sent by this project.

## Limitations

- Focuses on current active periods (today/week/month) and monthly baseline behavior.
- Uses LeetCode endpoints that may change in the future.
