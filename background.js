import { KEYWORDS } from './config/keywords.js';
import { getActiveGroups, updateLastScraped, upsertLead, writeRunLog } from './lib/airtable.js';
import { scorePostsBatch } from './lib/gemini.js';

const AIRTABLE_BASE_ID = 'appZOi48qf8SzyOml';
const ALARM_NAME       = 'hc-lead-scout-run';
const MAX_DAILY_RUNS   = 6;
const GROUP_DELAY_MIN  = 30_000;  // 30 s
const GROUP_DELAY_MAX  = 90_000;  // 90 s
const TAB_LOAD_TIMEOUT = 60_000;  // 60 s
const MSG_TIMEOUT      = 45_000;  // 45 s

// ── Date helpers ──────────────────────────────────────────────────────────────

function getCentralDateKey() {
  // en-CA gives YYYY-MM-DD; America/Chicago = Central Time
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  return `cap_${date}`;
}

// ── Daily cap ─────────────────────────────────────────────────────────────────

async function getDailyRunCount() {
  const key = getCentralDateKey();
  const data = await chrome.storage.local.get(key);
  return data[key] || 0;
}

async function canRunToday() {
  return (await getDailyRunCount()) < MAX_DAILY_RUNS;
}

async function incrementDailyCount() {
  const key = getCentralDateKey();
  const data = await chrome.storage.local.get(key);
  await chrome.storage.local.set({ [key]: (data[key] || 0) + 1 });
}

// ── Utilities ─────────────────────────────────────────────────────────────────

function randomDelay() {
  const ms = GROUP_DELAY_MIN + Math.random() * (GROUP_DELAY_MAX - GROUP_DELAY_MIN);
  return new Promise(r => setTimeout(r, ms));
}

function waitForTabLoad(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Tab ${tabId} load timeout`));
    }, TAB_LOAD_TIMEOUT);

    function listener(id, changeInfo) {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function waitForTabMessage(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      reject(new Error(`Tab ${tabId} message timeout`));
    }, MSG_TIMEOUT);

    function listener(message, sender) {
      if (sender.tab?.id === tabId && message.type === 'POSTS_RESULT') {
        clearTimeout(timer);
        chrome.runtime.onMessage.removeListener(listener);
        resolve(message.posts || []);
      }
    }
    chrome.runtime.onMessage.addListener(listener);
  });
}

// ── Scrape one Facebook group ─────────────────────────────────────────────────

async function scrapeGroup(groupUrl) {
  const tab = await chrome.tabs.create({ url: groupUrl, active: false });

  try {
    await waitForTabLoad(tab.id);

    // Brief pause for React to hydrate after initial load signal
    await new Promise(r => setTimeout(r, 2000));

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });

    return await waitForTabMessage(tab.id);
  } finally {
    chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// ── Keyword filter ────────────────────────────────────────────────────────────

function filterByKeywords(posts) {
  const keywordsFound = new Set();
  const matched = posts.filter(post => {
    const text = (post.postText || '').toLowerCase();
    const hits = KEYWORDS.filter(kw => text.includes(kw.toLowerCase()));
    hits.forEach(kw => keywordsFound.add(kw));
    return hits.length > 0;
  });
  return { matched, keywordsFound };
}

// ── Main scan orchestration ───────────────────────────────────────────────────

async function runScan(triggerType = 'Scheduled') {
  const now        = new Date();
  const runId      = `run_${now.toISOString().replace(/[-:.TZ]/g, '').slice(0, 15)}`;
  const startTime  = Date.now();

  let groupsScanned    = 0;
  let postsSeen        = 0;
  let keywordMatches   = 0;
  let leadsLogged      = 0;
  let duplicatesFound  = 0;
  let geminiCalls      = 0;
  const errors         = [];
  const allKeywords    = new Set();

  await chrome.storage.local.set({ isRunning: true, lastRunStart: now.toISOString() });

  try {
    // Enforce daily cap for scheduled runs only
    if (triggerType === 'Scheduled') {
      if (!(await canRunToday())) {
        console.log('[HC Lead Scout] Daily cap reached, skipping scheduled run.');
        await chrome.storage.local.set({ isRunning: false });
        return;
      }
      await incrementDailyCount();
    }

    const { airtableKey } = await chrome.storage.local.get('airtableKey');
    if (!airtableKey) throw new Error('Airtable API key not configured. Enter it in the popup settings.');

    const { geminiKey } = await chrome.storage.local.get('geminiKey');
    if (!geminiKey) throw new Error('Gemini API key not configured. Enter it in the popup settings.');

    const groups = await getActiveGroups(airtableKey, AIRTABLE_BASE_ID);

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];

      // Randomized inter-group delay (skip before first group)
      if (i > 0) await randomDelay();

      try {
        const lastRunKey = `last_run_${btoa(group.url).replace(/=/g, '')}`;
        const stored     = await chrome.storage.local.get(lastRunKey);
        const lastRun    = stored[lastRunKey] || null;

        const rawPosts = await scrapeGroup(group.url);
        groupsScanned++;

        // Only process posts newer than the last run for this group
        const newPosts = lastRun
          ? rawPosts.filter(p => p.postedAt && new Date(p.postedAt) > new Date(lastRun))
          : rawPosts;

        postsSeen += newPosts.length;

        // Record last_run and update Airtable timestamp
        const runTimestamp = new Date().toISOString();
        await chrome.storage.local.set({ [lastRunKey]: runTimestamp });
        await updateLastScraped(airtableKey, AIRTABLE_BASE_ID, group.recordId, runTimestamp);

        const { matched, keywordsFound } = filterByKeywords(newPosts);
        keywordsFound.forEach(kw => allKeywords.add(kw));
        keywordMatches += matched.length;

        if (matched.length === 0) continue;

        // Score in batches of 5
        for (let j = 0; j < matched.length; j += 5) {
          const batch  = matched.slice(j, j + 5);
          let scores;

          try {
            scores = await scorePostsBatch(geminiKey, batch);
            geminiCalls++;
          } catch (err) {
            errors.push(`Gemini batch error: ${err.message}`);
            continue;
          }

          for (let k = 0; k < batch.length; k++) {
            const post  = batch[k];
            const score = scores[k];

            if (!score?.is_lead) continue;

            try {
              const result = await upsertLead(airtableKey, AIRTABLE_BASE_ID, {
                posterName: post.posterName,
                postText:   post.postText,
                groupName:  group.name,
                postUrl:    post.postUrl,
                postedAt:   post.postedAt || null,
                detectedAt: new Date().toISOString(),
                aiScore:    score.score,
                aiSummary:  score.summary,
                urgency:    score.urgency,
              });

              if (result.isDuplicate) {
                duplicatesFound++;
              } else {
                leadsLogged++;
              }
            } catch (err) {
              errors.push(`Airtable upsert error: ${err.message}`);
            }
          }
        }
      } catch (err) {
        errors.push(`Group "${group.name}": ${err.message}`);
      }
    }
  } catch (err) {
    errors.push(err.message);
  } finally {
    const duration = Math.round((Date.now() - startTime) / 1000);
    const status   = errors.length === 0 ? 'Success' : (leadsLogged > 0 ? 'Partial' : 'Error');

    try {
      const { airtableKey } = await chrome.storage.local.get('airtableKey');
      if (airtableKey) {
        await writeRunLog(airtableKey, AIRTABLE_BASE_ID, {
          runId,
          triggeredAt:      now.toISOString(),
          triggerType,
          groupsScanned,
          postsSeen,
          keywordMatches,
          leadsLogged,
          duplicatesSkipped: duplicatesFound,
          geminiCalls,
          duration,
          topKeywordsFound:  [...allKeywords].join(', '),
          status,
          errorNotes:        errors.join('\n'),
        });
      }
    } catch (logErr) {
      console.error('[HC Lead Scout] Failed to write run log:', logErr);
    }

    await chrome.storage.local.set({
      isRunning:          false,
      lastRun:            new Date().toISOString(),
      lastRunTriggerType: triggerType,
    });
  }
}

// ── Alarm listener ────────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ALARM_NAME) runScan('Scheduled').catch(console.error);
});

// ── Message listener (popup → background) ────────────────────────────────────
// Note: POSTS_RESULT messages from content.js are handled by per-tab listeners
// inside waitForTabMessage; they are intentionally not handled here.

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RUN_NOW') {
    runScan('Manual')
      .then(() => sendResponse({ success: true }))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (message.type === 'SET_SCHEDULE') {
    const { intervalMinutes } = message;
    chrome.alarms.clear(ALARM_NAME, () => {
      if (intervalMinutes > 0) {
        chrome.alarms.create(ALARM_NAME, { periodInMinutes: intervalMinutes });
      }
    });
    chrome.storage.local.set({ scheduleInterval: intervalMinutes });
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_STATUS') {
    // Only respond to popup messages (no sender.tab)
    if (!sender.tab) {
      Promise.all([
        chrome.storage.local.get(['isRunning', 'lastRun', 'scheduleInterval']),
        getDailyRunCount(),
      ]).then(([data, count]) => {
        sendResponse({ ...data, dailyRunCount: count });
      });
      return true;
    }
  }
});

// ── Restore alarm on browser startup / extension reload ──────────────────────

async function restoreAlarm() {
  const { scheduleInterval } = await chrome.storage.local.get('scheduleInterval');
  if (scheduleInterval > 0) {
    chrome.alarms.create(ALARM_NAME, { periodInMinutes: scheduleInterval });
  }
}

chrome.runtime.onStartup.addListener(restoreAlarm);
chrome.runtime.onInstalled.addListener(restoreAlarm);
