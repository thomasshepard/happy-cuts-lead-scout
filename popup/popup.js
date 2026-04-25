// Airtable deep-link constants
const BASE_ID        = 'appZOi48qf8SzyOml';
const TABLE_LEADS    = 'tblsVhLpRYk9ffBW3';
const TABLE_FB_GROUPS = 'tblAVUdku1Bklu1zK';
const TABLE_RUN_LOG  = 'tblJJVlxQfi2wTVio';

const AT_BASE        = `https://airtable.com/${BASE_ID}`;

// ── Utilities ─────────────────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return 'never';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60)     return 'just now';
  if (diff < 3600)   return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400)  return `${Math.floor(diff / 3600)} hr ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function getCentralDateKey() {
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago' }).format(new Date());
  return `cap_${date}`;
}

// ── DOM refs ──────────────────────────────────────────────────────────────

const statusDot    = document.getElementById('statusDot');
const runNowBtn    = document.getElementById('runNow');
const scheduleEl   = document.getElementById('schedule');
const lastRunEl    = document.getElementById('lastRunText');
const runCountEl   = document.getElementById('runCountText');
const feedEl       = document.getElementById('leadsFeed');
const geminiInput  = document.getElementById('geminiKey');
const airtableInput = document.getElementById('airtableKey');

document.getElementById('linkLeads').href    = `${AT_BASE}/${TABLE_LEADS}`;
document.getElementById('linkFBGroups').href = `${AT_BASE}/${TABLE_FB_GROUPS}`;
document.getElementById('linkRunLog').href   = `${AT_BASE}/${TABLE_RUN_LOG}`;

// ── Render helpers ─────────────────────────────────────────────────────────

function renderStatus(isRunning) {
  if (isRunning) {
    statusDot.className = 'status-dot running';
    statusDot.title     = 'Running…';
    runNowBtn.disabled  = true;
    runNowBtn.textContent = 'Running…';
  } else {
    statusDot.className = 'status-dot';
    statusDot.title     = 'Idle';
    runNowBtn.disabled  = false;
    runNowBtn.textContent = 'Run Now';
  }
}

function renderLeads(leads) {
  if (!leads || leads.length === 0) {
    feedEl.innerHTML = '<div class="no-leads">No leads found yet.</div>';
    return;
  }

  feedEl.innerHTML = '';
  for (const lead of leads) {
    const urgency = (lead.urgency || 'low').toLowerCase();
    const scoreClass = urgency === 'high' ? 'high' : urgency === 'medium' ? 'medium' : 'low';

    const card = document.createElement('a');
    card.className = 'lead-card';
    card.href      = lead.postUrl || '#';
    card.target    = '_blank';
    card.rel       = 'noopener noreferrer';
    card.title     = `Open post in new tab`;

    card.innerHTML = `
      <div class="lead-score ${scoreClass}">${lead.aiScore || '—'}</div>
      <div class="lead-info">
        <div class="lead-poster">${escHtml(lead.posterName || 'Unknown')}</div>
        <div class="lead-meta">${escHtml(lead.groupName || '')} · ${timeAgo(lead.detectedAt)}</div>
      </div>
    `;

    feedEl.appendChild(card);
  }
}

function escHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Load state from storage ────────────────────────────────────────────────

async function loadState() {
  const capKey = getCentralDateKey();
  const keys   = ['isRunning', 'lastRun', 'scheduleInterval', 'recentLeads',
                  'geminiKey', 'airtableKey', capKey];
  const data   = await chrome.storage.local.get(keys);

  renderStatus(data.isRunning || false);

  lastRunEl.textContent   = `Last run: ${timeAgo(data.lastRun || null)}`;
  const count             = data[capKey] || 0;
  runCountEl.textContent  = `${count} / 6 runs today`;

  const interval = data.scheduleInterval || 0;
  scheduleEl.value = String(interval);

  renderLeads(data.recentLeads || []);

  if (data.geminiKey)   geminiInput.value   = data.geminiKey;
  if (data.airtableKey) airtableInput.value = data.airtableKey;
}

// ── Event handlers ─────────────────────────────────────────────────────────

runNowBtn.addEventListener('click', async () => {
  runNowBtn.disabled  = true;
  runNowBtn.textContent = 'Running…';
  statusDot.className   = 'status-dot running';

  try {
    await chrome.runtime.sendMessage({ type: 'RUN_NOW' });
  } catch (err) {
    console.error('Run error:', err);
  }

  // Reload state after a short delay to pick up any immediate changes
  setTimeout(loadState, 1500);
});

scheduleEl.addEventListener('change', async () => {
  const intervalMinutes = parseInt(scheduleEl.value, 10);
  await chrome.runtime.sendMessage({ type: 'SET_SCHEDULE', intervalMinutes });
  await chrome.storage.local.set({ scheduleInterval: intervalMinutes });
});

function saveKey(storageKey, inputEl) {
  inputEl.addEventListener('change', async () => {
    await chrome.storage.local.set({ [storageKey]: inputEl.value.trim() });
  });
  inputEl.addEventListener('blur', async () => {
    await chrome.storage.local.set({ [storageKey]: inputEl.value.trim() });
  });
}

saveKey('geminiKey',   geminiInput);
saveKey('airtableKey', airtableInput);

// Poll for isRunning changes while popup is open (service worker updates storage)
let pollInterval = null;

function startPolling() {
  pollInterval = setInterval(async () => {
    const { isRunning, recentLeads, lastRun } = await chrome.storage.local.get(
      ['isRunning', 'recentLeads', 'lastRun']
    );
    renderStatus(isRunning || false);
    lastRunEl.textContent = `Last run: ${timeAgo(lastRun || null)}`;
    renderLeads(recentLeads || []);
  }, 3000);
}

window.addEventListener('unload', () => {
  if (pollInterval) clearInterval(pollInterval);
});

// ── Init ──────────────────────────────────────────────────────────────────

loadState().then(startPolling);
