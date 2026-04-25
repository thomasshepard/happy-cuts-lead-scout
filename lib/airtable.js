const BASE_URL = 'https://api.airtable.com/v0';

const TABLE_IDS = {
  fbGroups: 'tblAVUdku1Bklu1zK',
  hcLeads:  'tblsVhLpRYk9ffBW3',
  runLog:   'tblJJVlxQfi2wTVio',
};

// Simple request queue: enforces 200ms gap between Airtable API calls (rate limit: 5 req/s)
class RequestQueue {
  constructor() {
    this._queue = [];
    this._running = false;
  }

  add(fn) {
    return new Promise((resolve, reject) => {
      this._queue.push({ fn, resolve, reject });
      this._drain();
    });
  }

  async _drain() {
    if (this._running) return;
    this._running = true;
    while (this._queue.length > 0) {
      const { fn, resolve, reject } = this._queue.shift();
      try {
        resolve(await fn());
      } catch (err) {
        reject(err);
      }
      if (this._queue.length > 0) {
        await new Promise(r => setTimeout(r, 200));
      }
    }
    this._running = false;
  }
}

const queue = new RequestQueue();

async function request(apiKey, method, url, body) {
  return queue.add(async () => {
    const opts = {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) opts.body = JSON.stringify(body);

    const res = await fetch(url, opts);
    if (!res.ok) {
      const text = await res.text().catch(() => res.status);
      throw new Error(`Airtable ${method} ${url}: ${res.status} – ${text}`);
    }
    return res.json();
  });
}

// Fetch all active FB Groups records
export async function getActiveGroups(apiKey, baseId) {
  const formula = encodeURIComponent('{Active}=1');
  const url = `${BASE_URL}/${baseId}/${TABLE_IDS.fbGroups}?filterByFormula=${formula}`;
  const data = await request(apiKey, 'GET', url);

  return (data.records || []).map(r => ({
    recordId: r.id,
    name: r.fields['Name'] || '',
    url: r.fields['Group URL'] || '',
  })).filter(g => g.url);
}

// Stamp a group's Last Scraped field
export async function updateLastScraped(apiKey, baseId, recordId, isoTimestamp) {
  const url = `${BASE_URL}/${baseId}/${TABLE_IDS.fbGroups}/${recordId}`;
  await request(apiKey, 'PATCH', url, {
    fields: { 'Last Scraped': isoTimestamp },
  });
}

// Upsert a lead keyed on Post URL; returns { isDuplicate, recordId }
export async function upsertLead(apiKey, baseId, lead) {
  // Search for existing record with this Post URL
  const formula = encodeURIComponent(`{Post URL}="${lead.postUrl}"`);
  const searchUrl = `${BASE_URL}/${baseId}/${TABLE_IDS.hcLeads}?filterByFormula=${formula}&maxRecords=1`;
  const existing = await request(apiKey, 'GET', searchUrl);

  if (existing.records && existing.records.length > 0) {
    // Duplicate: update timestamps and flag it
    const recordId = existing.records[0].id;
    const patchUrl = `${BASE_URL}/${baseId}/${TABLE_IDS.hcLeads}/${recordId}`;
    await request(apiKey, 'PATCH', patchUrl, {
      fields: {
        'Detected At': lead.detectedAt,
        'Duplicate': true,
      },
    });
    return { isDuplicate: true, recordId };
  }

  // New lead
  const createUrl = `${BASE_URL}/${baseId}/${TABLE_IDS.hcLeads}`;
  const created = await request(apiKey, 'POST', createUrl, {
    fields: {
      'Poster Name':     lead.posterName || '',
      'Post Text':       lead.postText   || '',
      'Group Name':      lead.groupName  || '',
      'Post URL':        lead.postUrl    || '',
      'Posted At':       lead.postedAt   || null,
      'Detected At':     lead.detectedAt,
      'AI Score':        lead.aiScore,
      'AI Summary':      lead.aiSummary  || '',
      'Urgency':         lead.urgency    || 'low',
      'Follow-up Status': 'New',
      'Duplicate':       false,
    },
  });

  // Cache for popup display
  await _cacheRecentLead({
    posterName: lead.posterName,
    groupName:  lead.groupName,
    aiScore:    lead.aiScore,
    urgency:    lead.urgency,
    postUrl:    lead.postUrl,
    detectedAt: lead.detectedAt,
  });

  return { isDuplicate: false, recordId: created.id };
}

async function _cacheRecentLead(lead) {
  const { recentLeads = [] } = await chrome.storage.local.get('recentLeads');
  recentLeads.unshift(lead);
  await chrome.storage.local.set({ recentLeads: recentLeads.slice(0, 5) });
}

// Write a run log record
export async function writeRunLog(apiKey, baseId, run) {
  const url = `${BASE_URL}/${baseId}/${TABLE_IDS.runLog}`;
  await request(apiKey, 'POST', url, {
    fields: {
      'Run ID':             run.runId,
      'Triggered At':       run.triggeredAt,
      'Trigger Type':       run.triggerType,
      'Groups Scanned':     run.groupsScanned,
      'Posts Seen':         run.postsSeen,
      'Keyword Matches':    run.keywordMatches,
      'Leads Logged':       run.leadsLogged,
      'Duplicates Skipped': run.duplicatesSkipped,
      'Gemini Calls':       run.geminiCalls,
      'Duration (sec)':     run.duration,
      'Top Keywords Found': run.topKeywordsFound || '',
      'Status':             run.status,
      'Error Notes':        run.errorNotes || '',
    },
  });
}
