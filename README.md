# HC Lead Scout

A Chrome Extension (Manifest V3) that monitors Facebook groups for posts requesting lawn mowing or yard care services. Posts are detected via keyword matching, scored by Gemini AI, and logged as leads to the Happy Cuts Airtable base for rapid follow-up.

**Speed is the goal.** A lead should appear in Airtable within minutes of being posted so Happy Cuts can respond before competitors do.

---

## What It Does

1. **Reads** the active FB Groups list from Airtable on each run.
2. **Opens** each group URL as a background (inactive) tab.
3. **Scrapes** posts — expands "See More" text, performs a single 500 px micro-scroll, extracts poster name / post text / URL / timestamp.
4. **Keyword-filters** posts against a configurable list (`config/keywords.js`).
5. **Scores** matched posts in batches via Gemini 2.5 Flash-Lite.
6. **Logs** every `is_lead: true` post to the HC Leads Airtable table (upsert by Post URL to prevent duplicates).
7. **Writes** a Run Log record with counts, timing, and top keywords for every run.

---

## Installation

### 1. Generate icons (one-time)
```bash
node scripts/create-icon.js
```
This writes `icons/icon16.png`, `icon32.png`, `icon48.png`, and `icon128.png`.

### 2. Load the extension in Chrome
1. Open `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked** and select this folder
4. The HC Lead Scout icon will appear in your toolbar

---

## Configuration

### API Keys (Popup → Settings)
Open the extension popup and expand **Settings**:

| Field | Where to get it |
|---|---|
| **Gemini API Key** | [Google AI Studio](https://aistudio.google.com/app/apikey) |
| **Airtable API Key** | [Airtable account page](https://airtable.com/create/tokens) — create a personal access token with `data.records:read`, `data.records:write`, and `schema.bases:read` scopes for base `appZOi48qf8SzyOml` |

Keys are stored in `chrome.storage.local` on your device only.

### Adding Facebook Groups
Open **Configure FB Groups in Airtable** (popup → Settings) and add a row:

| Field | Value |
|---|---|
| Name | A label, e.g. "Hip Cookeville" |
| Group URL | Full Facebook group URL |
| Active | Check to enable scraping |

No code changes needed — the extension reads this table on every run.

---

## Schedule Options

| Setting | Behaviour |
|---|---|
| Off | Manual runs only |
| Every 2 hours | Alarm fires every 120 min |
| Every 4 hours | Alarm fires every 240 min |
| Every 6 hours | Alarm fires every 360 min |

**Daily cap:** Scheduled runs are limited to **6 per day** (resets at midnight Central Time). Manual "Run Now" always works regardless of cap.

---

## Facebook Safety Design

The extension is intentionally gentle to avoid account flags:

- **Randomized delay** — 30–90 seconds between each group (random per run)
- **Single micro-scroll** — 500 px once per page; no scroll loops
- **Inactive tabs** — scrape tabs are never brought to the foreground
- **Tab closed immediately** after content.js reports back
- **Deduplication** — Post URLs are upserted; no record is ever written twice
- **`last_run` per group** — only posts newer than the last scrape are processed
- **Airtable rate limiting** — 200 ms gap between every API call

---

## Airtable Tables

| Table | ID | Purpose |
|---|---|---|
| FB Groups | `tblAVUdku1Bklu1zK` | Source-of-truth for which groups to scan |
| HC Leads  | `tblsVhLpRYk9ffBW3` | One record per lead |
| Run Log   | `tblJJVlxQfi2wTVio` | One record per scan run |

### Run Log fields
`Run ID`, `Triggered At`, `Trigger Type`, `Groups Scanned`, `Posts Seen`, `Keyword Matches`, `Leads Logged`, `Duplicates Skipped`, `Gemini Calls`, `Duration (sec)`, `Top Keywords Found`, `Status`, `Error Notes`

If **Leads Logged** is consistently 0 but **Posts Seen** is non-zero, check **Top Keywords Found** in the run log to see what text is being matched. Adjust `config/keywords.js` if needed.

---

## Keyword Tuning

Edit `config/keywords.js` and reload the extension in `chrome://extensions`. The current list covers common ways locals ask for lawn services; you can add neighbourhood-specific terms (e.g. local slang or street names).

---

## Known Limitations

- **Chrome must remain open** — the service worker fires Chrome Alarms; if the browser is closed, scheduled scans won't run.
- **Facebook login required** — the extension uses your existing Facebook session. If you're logged out, scrape tabs will return a login page and produce 0 posts (the run still completes cleanly).
- **Facebook DOM changes** — Facebook occasionally restructures its HTML. If post extraction drops to 0 for a group that has active posts, the `content.js` selectors may need updating.
- **Gemini 2.5 Flash-Lite** — used for cost efficiency. Occasional JSON formatting quirks are handled automatically (markdown fence stripping).
