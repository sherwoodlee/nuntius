// Side panel: the UI shown alongside Slack or Teams. Detects which host the
// companion tab is on, adapts the UI, and talks to the right content script
// (via chrome.tabs.sendMessage) for DOM work. LLM calls go to background.js
// (via chrome.runtime.sendMessage).

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'nuntius';
const HISTORY_KEY = 'nuntius_history';
const HISTORY_MAX = 30;

const SLACK_URL_RE = /^https:\/\/app\.slack\.com\//;
const TEAMS_URL_RE = /^https:\/\/teams\.(microsoft\.com|cloud\.microsoft|live\.com)\//;

const ADAPTERS = {
  slack: {
    label: 'Slack',
    urlPatterns: ['https://app.slack.com/*'],
    idleLabel: 'Open a thread, channel, or DM…',
    emptyHint: 'Open a thread, channel, or DM in Slack.',
    supportsVoicePull: true,
    supportsThreadHighlight: true,
    needsReloadOnTheme: true,
    themeHint: 'To make Slack match, enable "Sync with OS" in Slack → Preferences → Themes (one-time).',
  },
  teams: {
    label: 'Teams',
    urlPatterns: ['https://teams.microsoft.com/*', 'https://teams.cloud.microsoft/*'],
    idleLabel: 'Open a Teams chat…',
    emptyHint: 'Open a chat in Teams, then click refresh.',
    supportsVoicePull: false,
    supportsThreadHighlight: false,
    needsReloadOnTheme: false,
    themeHint: 'To make Teams match, set Teams → Settings → Appearance → Follow system.',
  },
};

const MOODS = {
  default: '',
  professional: 'Style: professional, polished tone. Avoid slang.',
  casual: 'Style: casual and friendly. Use contractions. Light emoji OK if thread has them.',
  direct: 'Style: direct and terse. Cut filler. State the point first.',
  playful: 'Style: playful and lighthearted. Gentle humor is welcome if it fits.',
  empathetic: 'Style: warm and empathetic. Acknowledge feelings before substance.',
  technical: 'Style: technical and precise. Use specific terminology. Show reasoning.',
  pushback: 'Style: push back respectfully. Name what you disagree with and why.',
  oneliner: 'Style: a single short sentence. No preamble, no sign-off.',
};
const MOOD_LABELS = {
  default: 'Default',
  professional: 'Professional',
  casual: 'Casual / Friendly',
  direct: 'Direct / Terse',
  playful: 'Playful',
  empathetic: 'Empathetic',
  technical: 'Technical',
  pushback: 'Pushback',
  oneliner: 'One-liner',
};

const PALETTES = [
  { id: 'indigo', name: 'Indigo' },
  { id: 'aubergine', name: 'Aubergine' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'forest', name: 'Forest' },
  { id: 'ember', name: 'Ember' },
  { id: 'mono', name: 'Mono' },
  { id: 'sunset', name: 'Sunset' },
];
const PALETTE_IDS = new Set(PALETTES.map((p) => p.id));

const DEFAULTS = {
  provider: 'claude',
  model: 'claude-sonnet-4-6',
  effort: 'medium',
  ollamaHost: 'http://localhost:11434',
  ollamaModel: '',
  theme: 'light',
  palette: 'indigo',
  maxMessages: 20,
  lastMood: 'default',
  lastVoice: '',
  voices: [],
  userName: '',
  userBio: '',
};

let settings = { ...DEFAULTS };
let currentThread = null;
let currentHost = null;
let autoRefreshTimer = null;
const AUTO_REFRESH_MS = 2000;

// Instruction history — shell-style recall with ↑ / ↓.
let instructionHistory = [];
let historyIndex = -1;      // -1 = user's current in-progress text (not in history)
let historyDraft = '';      // what the user had typed when they entered history nav

// ---------- storage helpers ----------
async function loadSettings() {
  const raw = await chrome.storage.local.get(STORAGE_KEY);
  settings = { ...DEFAULTS, ...(raw[STORAGE_KEY] || {}) };
  document.body.dataset.theme = settings.theme || 'light';
  document.body.dataset.palette = PALETTE_IDS.has(settings.palette) ? settings.palette : 'indigo';
}
async function saveSettings(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ [STORAGE_KEY]: settings });
}

async function loadInstructionHistory() {
  const raw = await chrome.storage.local.get(HISTORY_KEY);
  const arr = raw[HISTORY_KEY];
  instructionHistory = Array.isArray(arr) ? arr : [];
}

async function pushInstruction(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  if (instructionHistory[instructionHistory.length - 1] === trimmed) return;
  instructionHistory.push(trimmed);
  if (instructionHistory.length > HISTORY_MAX) {
    instructionHistory = instructionHistory.slice(-HISTORY_MAX);
  }
  await chrome.storage.local.set({ [HISTORY_KEY]: instructionHistory });
}

// ---------- host detection + tab plumbing ----------
// The sidepanel is docked in a specific browser window. Bind to that window
// on load so our tab queries stay anchored there — otherwise a second Slack
// or Teams tab in any window can hijack the panel via "most-recently-active"
// tie-breaking.
let boundWindowId = null;

async function initWindowBinding() {
  try {
    const win = await chrome.windows.getCurrent();
    boundWindowId = win?.id ?? null;
  } catch {
    boundWindowId = null;
  }
}

function hostForUrl(url) {
  if (SLACK_URL_RE.test(url || '')) return 'slack';
  if (TEAMS_URL_RE.test(url || '')) return 'teams';
  return null;
}

async function getCompanionTab() {
  // Primary: active tab in the window this panel lives in. That's the tab the
  // user is looking at right now, regardless of what other Slack/Teams tabs
  // they have open elsewhere.
  if (boundWindowId != null) {
    const [active] = await chrome.tabs.query({ active: true, windowId: boundWindowId });
    if (active && hostForUrl(active.url)) return active;
  }
  // Fallback for edge cases (window id unavailable, or active tab isn't a
  // Slack/Teams tab — e.g. panel still showing while user is on about:blank).
  const patterns = [...ADAPTERS.slack.urlPatterns, ...ADAPTERS.teams.urlPatterns];
  const tabs = await chrome.tabs.query({ url: patterns, windowId: boundWindowId ?? undefined });
  return tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0] || null;
}

async function contentSend(msg) {
  const tab = await getCompanionTab();
  if (!tab) {
    setHost(null);
    return { error: 'No Slack or Teams tab open. Open one first.' };
  }
  const host = hostForUrl(tab.url);
  if (host !== currentHost) setHost(host);
  try {
    return await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    return { error: `Couldn't reach ${ADAPTERS[host]?.label || 'host'} tab: ${e.message}. Try reloading the tab.` };
  }
}

function setHost(host) {
  const prev = currentHost;
  currentHost = host;
  const badge = $('host-badge');
  const adapter = host ? ADAPTERS[host] : null;
  badge.textContent = adapter?.label || '—';
  badge.dataset.host = host || '';
  // Reset stale rendered state if the companion swapped hosts.
  if (prev && prev !== host) {
    currentThread = null;
    const view = $('thread-view');
    view.classList.add('empty');
    view.innerHTML = '';
    $('draft-btn').disabled = true;
  }
  const view = $('thread-view');
  if (view.classList.contains('empty')) {
    view.textContent = adapter?.emptyHint || 'Open a Slack or Teams tab to get started.';
  }
  if (!currentThread) {
    $('thread-label').textContent = adapter?.idleLabel || 'Open Slack or Teams…';
  }
  // Re-render voices because Pull-from-search visibility depends on host.
  if (!$('settings-modal').classList.contains('hidden')) renderVoicesList();
}

// ---------- init ----------
document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([loadSettings(), initWindowBinding(), loadInstructionHistory()]);
  populateMoodSelect();
  populateVoiceSelect();
  $('mood-select').value = settings.lastMood || 'default';
  $('voice-select').value = settings.lastVoice || '';
  wireHandlers();
  refreshThread(true);
  startAutoRefresh();
  maybeAutoOpenSetup();
});

// ---------- provider readiness ----------
// On panel load we probe the selected provider. If it isn't ready (Claude
// native host not installed, Ollama not running / no model picked), we pop
// Settings open to the right setup box with an explanatory message.
let autoOpenedThisSession = false;

async function checkProviderReadiness() {
  if (settings.provider === 'claude') {
    try {
      const result = await chrome.runtime.sendMessage({ type: 'claude:ping' });
      if (result?.ok) return { ok: true, focus: 'claude' };
      return {
        ok: false,
        focus: 'claude',
        message: `Claude isn't connected: ${result?.error || 'native host unavailable'}. Run the command above, then click Test connection.`,
      };
    } catch (e) {
      return { ok: false, focus: 'claude', message: `Claude check failed: ${e.message}` };
    }
  }
  if (settings.provider === 'ollama') {
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ollama:listModels',
        host: settings.ollamaHost,
      });
      if (result?.error) {
        return { ok: false, focus: 'ollama', message: `Ollama didn't respond: ${result.error}. Make sure it's running.` };
      }
      const models = result?.models || [];
      if (models.length === 0) {
        return { ok: false, focus: 'ollama', message: 'Ollama is running but no models are installed. Run `ollama pull qwen3:8b`, then click ↻ to refresh.' };
      }
      if (!settings.ollamaModel || !models.some((m) => m.name === settings.ollamaModel)) {
        return { ok: false, focus: 'ollama', message: 'Pick an Ollama model above.' };
      }
      return { ok: true, focus: 'ollama' };
    } catch (e) {
      return { ok: false, focus: 'ollama', message: `Ollama check failed: ${e.message}` };
    }
  }
  return { ok: true };
}

async function maybeAutoOpenSetup() {
  if (autoOpenedThisSession) return;
  const check = await checkProviderReadiness();
  if (check.ok) return;
  autoOpenedThisSession = true;
  await openSettings();
  surfaceReadiness(check);
}

function surfaceReadiness(check) {
  if (!check || check.ok) return;
  if (check.focus === 'claude') {
    setClaudeSetupStatus(check.message, 'error');
    $('test-claude-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (check.focus === 'ollama') {
    setOllamaSetupStatus(check.message, 'error');
    $('test-ollama-btn')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function startAutoRefresh() {
  if (autoRefreshTimer) clearInterval(autoRefreshTimer);
  autoRefreshTimer = setInterval(() => {
    // Skip polling while a draft is in flight to avoid racing the UI.
    if ($('draft-btn').dataset.busy === 'true') return;
    refreshThread(true);
  }, AUTO_REFRESH_MS);
  // React immediately when the user switches tabs inside our window — don't
  // make them wait up to 2 s for the next poll to notice.
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (boundWindowId == null || windowId !== boundWindowId) return;
    if ($('draft-btn').dataset.busy === 'true') return;
    refreshThread(true);
  });
}

function populateMoodSelect() {
  const sel = $('mood-select');
  sel.innerHTML = Object.keys(MOODS)
    .map((id) => `<option value="${id}">${escapeHtml(MOOD_LABELS[id] || id)}</option>`)
    .join('');
}
function populateVoiceSelect() {
  const sel = $('voice-select');
  const opts = ['<option value="">Me (default)</option>']
    .concat(
      (settings.voices || []).map((v) => {
        const hasSamples = (v.samples?.length || 0) > 0;
        const suffix = hasSamples ? '' : ' (no samples)';
        return `<option value="${escapeHtml(v.id)}">${escapeHtml(v.name || v.handle)}${suffix}</option>`;
      })
    );
  sel.innerHTML = opts.join('');
}

// ---------- wire buttons ----------
function wireHandlers() {
  $('pull-btn').addEventListener('click', () => refreshThread(false));
  $('draft-btn').addEventListener('click', draftReply);
  $('settings-btn').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-modal').addEventListener('click', (e) => {
    if (e.target.id === 'settings-modal') closeSettings();
  });
  $('add-voice-btn').addEventListener('click', addNewVoice);
  $('new-voice-handle').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addNewVoice();
  });
  $('instruction').addEventListener('keydown', handleInstructionKeydown);
  $('instruction').addEventListener('input', () => {
    // Any user typing exits history mode so further ↑ starts fresh from
    // the user's current text on the next press.
    historyIndex = -1;
  });
}

function cursorLineInfo(el) {
  const pos = el.selectionStart ?? 0;
  return {
    onFirstLine: !el.value.substring(0, pos).includes('\n'),
    onLastLine: !el.value.substring(pos).includes('\n'),
  };
}

function handleInstructionKeydown(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!$('draft-btn').disabled) $('draft-btn').click();
    return;
  }
  const el = e.target;
  const inHistory = historyIndex !== -1;
  if (e.key === 'ArrowUp') {
    // Don't hijack Up when the user is editing within a multi-line draft.
    if (!inHistory && !cursorLineInfo(el).onFirstLine) return;
    if (historyIndex >= instructionHistory.length - 1) return; // already at oldest
    if (!inHistory) historyDraft = el.value;
    e.preventDefault();
    historyIndex++;
    el.value = instructionHistory[instructionHistory.length - 1 - historyIndex];
    el.setSelectionRange(0, 0);
    return;
  }
  if (e.key === 'ArrowDown') {
    if (!inHistory) return;
    if (!cursorLineInfo(el).onLastLine) return;
    e.preventDefault();
    historyIndex--;
    el.value = historyIndex === -1
      ? historyDraft
      : instructionHistory[instructionHistory.length - 1 - historyIndex];
    el.setSelectionRange(el.value.length, el.value.length);
    return;
  }
  if (e.key === 'Escape' && inHistory) {
    e.preventDefault();
    historyIndex = -1;
    el.value = historyDraft;
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

// ---------- thread refresh ----------
async function refreshThread(silent) {
  if (!silent) setStatus('Refreshing…');
  const result = await contentSend({ type: 'scrape', maxMessages: settings.maxMessages });
  if (!result || result.error) {
    if (!silent) setStatus(result?.error || 'Refresh failed.', 'error');
    return;
  }
  // Dedup: only re-render when the identity or message count changes.
  const newKey = `${result.mode || ''}:${result.id || ''}:${result.count}:${result.messages.at(-1)?.ts || ''}`;
  const oldKey = currentThread
    ? `${currentThread.mode || ''}:${currentThread.id || ''}:${currentThread.count}:${currentThread.messages.at(-1)?.ts || ''}`
    : null;
  if (newKey === oldKey) return;

  const switched =
    !currentThread ||
    currentThread.mode !== result.mode ||
    currentThread.id !== result.id;
  if (switched) $('instruction').value = '';

  currentThread = result;
  renderConversation(result);
  $('draft-btn').disabled = false;
  if (!silent || switched) {
    setStatus(`Loaded ${result.count} message${result.count === 1 ? '' : 's'}.`);
  }
}

// ---------- draft + paste ----------
async function draftReply() {
  if (!currentThread) {
    setStatus('Refresh first so I know what to draft.', 'error');
    return;
  }
  const btn = $('draft-btn');
  btn.disabled = true;
  btn.dataset.busy = 'true';
  setStatus('Drafting reply…');

  const mood = $('mood-select').value;
  const voiceId = $('voice-select').value || '';
  const voice = voiceId ? (settings.voices || []).find((v) => v.id === voiceId) : null;
  const instruction = $('instruction').value.trim();
  const name = (settings.userName || '').trim();
  const bio = (settings.userBio || '').trim();
  const me = name ? { name, bio } : null;

  const { system, user } = buildPrompt(currentThread, instruction, { mood, voice, me, host: currentHost });

  try {
    const reply = await chrome.runtime.sendMessage({
      type: 'draft',
      payload: {
        system,
        prompt: user,
        provider: settings.provider,
        host: settings.ollamaHost,
        model: settings.provider === 'ollama' ? settings.ollamaModel : settings.model,
        effort: settings.provider === 'claude' ? settings.effort : undefined,
      },
    });
    if (!reply || reply.error) {
      setStatus(reply?.error || 'Draft failed.', 'error');
      return;
    }
    const text = (reply.text || '').trim();
    if (!text) {
      setStatus('Model returned empty text.', 'error');
      return;
    }
    const paste = await contentSend({ type: 'paste', text, mode: currentThread.mode });
    if (!paste || paste.error) {
      setStatus(paste?.error || 'Paste failed.', 'error');
      return;
    }
    await pushInstruction(instruction);
    $('instruction').value = '';
    historyIndex = -1;
    historyDraft = '';
    await saveSettings({ lastMood: mood, lastVoice: voiceId });
    const appLabel = ADAPTERS[currentHost]?.label || 'the app';
    setStatus(`Draft placed in ${appLabel}. Review and press Enter to send.`, 'ok');
  } catch (e) {
    setStatus(`Draft error: ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.dataset.busy = 'false';
  }
}

function buildSystemPrompt(me, host) {
  const appName = host === 'teams' ? 'Microsoft Teams' : 'Slack';
  const lines = [
    `You draft short replies for ${appName}.`,
    'You will be given a conversation where the user (posting as "Me") is preparing their next message. Write the reply the user should send.',
  ];
  if (me?.name) {
    const bio = me.bio ? ` ${me.bio}` : '';
    // Users can enter either a single identifier or a comma-separated list
    // like "Alice Chen, achen" to cover both a display name and a handle.
    const names = me.name.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length > 1) {
      const list = names.map((n) => `"${n}"`).join(' or ');
      lines.push(
        '',
        `The user ("Me") is known as ${list} — messages addressed to, @mentioning, or referring to any of these are about them.${bio}`
      );
    } else if (names.length === 1) {
      lines.push(
        '',
        `The user ("Me") is "${names[0]}" — messages addressed to, @mentioning, or referring to this name/alias are about them.${bio}`
      );
    }
  }
  lines.push(
    '',
    'Rules:',
    '- Write in first person from "Me"\'s perspective — never narrate about Me in third person.',
    '- Output ONLY the reply text. No preamble, no quotes, no markdown headers, no sign-off unless asked.',
    '- Keep it concise — one short paragraph unless the instruction says otherwise.',
    '- Reply in the same language as the most recent messages in the conversation.',
    '- If a specific fact (name, number, date, link) is not in the conversation, use a [bracketed placeholder] rather than inventing it.',
    '- If the <instruction> conflicts with the style guidance, follow the instruction.',
  );
  return lines.join('\n');
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;',
  }[c]));
}

// Render a timestamp: Slack's "<epoch_seconds>.<microseconds>" → "HH:MM" (today)
// or "MMM D HH:MM" (otherwise). Anything that's not a plausible epoch passes
// through unchanged — Teams uses human-readable strings.
function formatTs(raw) {
  if (!raw) return '';
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 1e9 || n > 1e11) return String(raw);
  const d = new Date(n * 1000);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (sameDay) return time;
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

function buildPrompt(thread, instruction, { mood, voice, me, host } = {}) {
  const messages = thread.messages || [];
  // Timestamps are noisy and inconsistent; only include them when ordering
  // alone isn't enough context.
  const keepTs = messages.length > 15;
  const body = messages
    .map((m) => {
      const ts = keepTs && m.ts ? ` @ ${formatTs(m.ts)}` : '';
      return `${m.author || 'unknown'}${ts}\n${m.text || ''}`;
    })
    .join('\n---\n');

  const styleLines = [];
  const moodText = mood && MOODS[mood];
  if (moodText) styleLines.push(moodText);

  const samples = (voice?.samples || []).map((s) => s.trim()).filter(Boolean);
  let voiceBlock = '';
  if (voice && samples.length > 0) {
    styleLines.push(
      `Mimic the writing style of ${voice.name || voice.handle}: cadence, vocabulary, sentence length. Do not lift their phrases verbatim — only their style.`
    );
    voiceBlock = `<style-samples author="${escapeAttr(voice.name || voice.handle)}">\n${samples
      .map((s, i) => `<sample n="${i + 1}">${s}</sample>`)
      .join('\n')}\n</style-samples>`;
  } else if (!moodText) {
    styleLines.push('Match the tone of the conversation.');
  }

  const where =
    thread.mode === 'thread'
      ? `mode="thread"`
      : `chat="${escapeAttr(thread.label || 'chat')}"`;

  const parts = [`<conversation ${where}>\n${body}\n</conversation>`];
  if (styleLines.length > 0) parts.push(`<style>\n${styleLines.join('\n')}\n</style>`);
  if (voiceBlock) parts.push(voiceBlock);
  if (instruction) parts.push(`<instruction>${instruction}</instruction>`);

  return { system: buildSystemPrompt(me, host), user: parts.join('\n\n') };
}

// ---------- settings modal ----------
async function openSettings() {
  await loadSettings();

  $('user-name').value = settings.userName || '';
  $('user-name').onchange = async () => {
    await saveSettings({ userName: $('user-name').value.trim() });
  };
  $('user-bio').value = settings.userBio || '';
  $('user-bio').onchange = async () => {
    await saveSettings({ userBio: $('user-bio').value.trim() });
  };

  $('theme-select').value = settings.theme || 'light';
  const themeHint = $('theme-hint');
  themeHint.textContent = ADAPTERS[currentHost]?.themeHint || '';
  $('theme-select').onchange = async () => {
    await saveSettings({ theme: $('theme-select').value });
    document.body.dataset.theme = settings.theme;
    // Slack reads prefers-color-scheme once at page load and caches it — our
    // matchMedia spoof only lands on a fresh load. Reload on Slack so the new
    // theme takes effect there too. Teams doesn't need a reload.
    if (ADAPTERS[currentHost]?.needsReloadOnTheme) {
      const tab = await getCompanionTab();
      if (tab?.id) {
        try {
          await chrome.tabs.reload(tab.id);
          setStatus(`Theme set to ${settings.theme}. Reloading Slack…`, 'ok');
        } catch {}
      }
    }
  };

  renderPaletteGrid();

  $('provider-select').value = settings.provider || 'claude';
  applyProviderVisibility(settings.provider);
  $('provider-select').onchange = async () => {
    await saveSettings({ provider: $('provider-select').value });
    applyProviderVisibility(settings.provider);
    if (settings.provider === 'ollama') refreshOllamaModels();
    // Surface any setup gap for the newly-selected provider so the user
    // doesn't discover it at draft time.
    const check = await checkProviderReadiness();
    surfaceReadiness(check);
  };

  $('model-select').value = settings.model;
  $('model-select').onchange = async () => {
    await saveSettings({ model: $('model-select').value });
  };

  $('effort-select').value = settings.effort || 'medium';
  $('effort-select').onchange = async () => {
    await saveSettings({ effort: $('effort-select').value });
  };

  wireClaudeSetup();

  $('ollama-host').value = settings.ollamaHost;
  $('ollama-host').onchange = async () => {
    await saveSettings({ ollamaHost: $('ollama-host').value.trim() || DEFAULTS.ollamaHost });
    await refreshOllamaModels();
  };
  $('ollama-refresh-btn').onclick = (e) => {
    e.preventDefault();
    refreshOllamaModels();
  };
  renderOllamaModelSelect(null);
  if (settings.provider === 'ollama') refreshOllamaModels();

  wireOllamaSetup();

  $('max-messages').value = settings.maxMessages || 20;
  $('max-messages').onchange = async () => {
    const n = Math.max(1, Math.min(200, parseInt($('max-messages').value, 10) || 20));
    $('max-messages').value = n;
    await saveSettings({ maxMessages: n });
  };

  renderVoicesList();
  $('settings-modal').classList.remove('hidden');
}
function closeSettings() {
  $('settings-modal').classList.add('hidden');
  populateVoiceSelect();
  $('voice-select').value = settings.lastVoice || '';
}

function wireOllamaSetup() {
  $('copy-ollama-cmd').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('ollama-pull-cmd').textContent);
      setOllamaSetupStatus('Command copied to clipboard.', 'ok');
    } catch {
      setOllamaSetupStatus("Couldn't copy — select the text manually.", 'error');
    }
  };
  $('test-ollama-btn').onclick = async () => {
    setOllamaSetupStatus('Testing Ollama…');
    try {
      const result = await chrome.runtime.sendMessage({
        type: 'ollama:listModels',
        host: settings.ollamaHost,
      });
      if (result?.error) {
        setOllamaSetupStatus(`Ollama didn't respond: ${result.error}. Is it running?`, 'error');
        return;
      }
      const n = result.models.length;
      if (n === 0) {
        setOllamaSetupStatus('Ollama is running but no models are installed. Run the pull command above.', 'error');
        return;
      }
      setOllamaSetupStatus(`Connected. ${n} model${n === 1 ? '' : 's'} available.`, 'ok');
    } catch (e) {
      setOllamaSetupStatus(`Test failed: ${e.message}`, 'error');
    }
  };
  setOllamaSetupStatus('');
}

function setOllamaSetupStatus(msg, kind = '') {
  const el = $('ollama-setup-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `section-sub ${kind}`;
}

function wireClaudeSetup() {
  const cmd = `./native-host/install.sh ${chrome.runtime.id}`;
  $('claude-install-cmd').textContent = cmd;
  $('copy-install-cmd').onclick = async () => {
    try {
      await navigator.clipboard.writeText(cmd);
      setClaudeSetupStatus('Command copied to clipboard.', 'ok');
    } catch {
      setClaudeSetupStatus("Couldn't copy — select the text manually.", 'error');
    }
  };
  $('test-claude-btn').onclick = async () => {
    setClaudeSetupStatus('Testing native host…');
    try {
      const result = await chrome.runtime.sendMessage({ type: 'claude:ping' });
      if (result?.ok) {
        setClaudeSetupStatus("Native host responded. You're good.", 'ok');
      } else {
        setClaudeSetupStatus(`Not connected: ${result?.error || 'unknown error'}`, 'error');
      }
    } catch (e) {
      setClaudeSetupStatus(`Test failed: ${e.message}`, 'error');
    }
  };
  setClaudeSetupStatus('');
}

function setClaudeSetupStatus(msg, kind = '') {
  const el = $('claude-setup-status');
  if (!el) return;
  el.textContent = msg;
  el.className = `section-sub ${kind}`;
}

function applyProviderVisibility(provider) {
  document.querySelectorAll('.provider-group').forEach((el) => {
    el.style.display = el.getAttribute('data-for') === provider ? '' : 'none';
  });
}

function renderPaletteGrid() {
  const root = $('palette-grid');
  if (!root) return;
  const current = PALETTE_IDS.has(settings.palette) ? settings.palette : 'indigo';
  root.innerHTML = PALETTES.map((p) => `
    <button type="button" class="palette-swatch${p.id === current ? ' selected' : ''}" data-palette="${p.id}">
      <span class="palette-preview" data-preview="${p.id}"></span>
      <span class="palette-name">${escapeHtml(p.name)}</span>
    </button>
  `).join('');
  root.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.palette;
      if (!PALETTE_IDS.has(id)) return;
      await saveSettings({ palette: id });
      document.body.dataset.palette = id;
      root.querySelectorAll('button').forEach((b) => {
        b.classList.toggle('selected', b.dataset.palette === id);
      });
    });
  });
}

// ---------- Ollama model list ----------
async function refreshOllamaModels() {
  const hint = $('ollama-hint');
  hint.textContent = 'Fetching models from Ollama…';
  try {
    const result = await chrome.runtime.sendMessage({
      type: 'ollama:listModels',
      host: settings.ollamaHost,
    });
    if (result.error) {
      hint.textContent = `Couldn't reach Ollama: ${result.error}. Make sure it's running.`;
      renderOllamaModelSelect([]);
      return;
    }
    renderOllamaModelSelect(result.models);
    hint.textContent = result.models.length === 0
      ? 'No models. Run `ollama pull qwen3:8b` then refresh.'
      : `${result.models.length} model${result.models.length === 1 ? '' : 's'} available.`;
  } catch (e) {
    hint.textContent = `Error: ${e.message}`;
    renderOllamaModelSelect([]);
  }
}
function renderOllamaModelSelect(models) {
  const sel = $('ollama-model-select');
  if (!models || models.length === 0) {
    sel.innerHTML = '<option value="">(no models available)</option>';
    return;
  }
  sel.innerHTML = models
    .map((m) => `<option value="${escapeHtml(m.name)}">${escapeHtml(m.name)}</option>`)
    .join('');
  const current = settings.ollamaModel || '';
  if (current && models.some((m) => m.name === current)) {
    sel.value = current;
  } else {
    sel.value = models[0].name;
    saveSettings({ ollamaModel: sel.value });
  }
  sel.onchange = async () => {
    await saveSettings({ ollamaModel: sel.value });
  };
}

// ---------- voices ----------
function renderVoicesList() {
  const root = $('voices-list');
  const voices = settings.voices || [];
  if (voices.length === 0) {
    root.innerHTML = '<div class="muted" style="font-size:12px; padding:6px 0;">No voices yet. Add one below.</div>';
    return;
  }
  const allowPull = !!ADAPTERS[currentHost]?.supportsVoicePull;
  root.innerHTML = voices
    .map((v) => {
      const pullBtn = allowPull
        ? '<button class="ghost" data-action="pull" title="Pull from visible Slack search results">↓ Pull from search</button>'
        : '';
      return `
      <div class="voice-card" data-id="${escapeHtml(v.id)}">
        <div class="voice-head">
          <div><strong>${escapeHtml(v.name || v.handle)}</strong> <span class="muted">@${escapeHtml(v.handle)}</span></div>
          <div class="voice-actions">
            ${pullBtn}
            <button class="ghost danger" data-action="delete" title="Remove voice">✕</button>
          </div>
        </div>
        <textarea class="voice-samples" rows="4" placeholder="One sample message per line."
          data-action="edit-samples">${escapeHtml((v.samples || []).join('\n'))}</textarea>
        <div class="voice-meta muted" data-action="meta">${v.samples?.length || 0} samples</div>
      </div>`;
    })
    .join('');

  root.querySelectorAll('.voice-card').forEach((card) => {
    const id = card.getAttribute('data-id');
    const samplesEl = card.querySelector('[data-action="edit-samples"]');
    const metaEl = card.querySelector('[data-action="meta"]');

    samplesEl.addEventListener('blur', async () => {
      const samples = samplesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
      const list = (settings.voices || []).map((v) => (v.id === id ? { ...v, samples } : v));
      await saveSettings({ voices: list });
      metaEl.textContent = `${samples.length} samples`;
    });

    const pullEl = card.querySelector('[data-action="pull"]');
    if (pullEl) {
      pullEl.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        const originalText = btn.textContent;
        btn.textContent = 'Scrolling & scraping…';
        try {
          const result = await contentSend({ type: 'voice:scrape' });
          if (!result || result.error || !Array.isArray(result.samples)) {
            setStatus(result?.error || 'Pull failed. Did you run a search in Slack first?', 'error');
            return;
          }
          const existing = samplesEl.value.split('\n').map((s) => s.trim()).filter(Boolean);
          const seen = new Set(existing);
          const added = [];
          for (const s of result.samples) {
            if (!seen.has(s)) { seen.add(s); added.push(s); }
          }
          const merged = existing.concat(added);
          samplesEl.value = merged.join('\n');
          const list = (settings.voices || []).map((v) => (v.id === id ? { ...v, samples: merged } : v));
          await saveSettings({ voices: list });
          metaEl.textContent = `${merged.length} samples`;
          setStatus(`Pulled ${result.samples.length} results (${added.length} new) for @${id}.`, 'ok');
        } catch (err) {
          setStatus(`Pull error: ${err.message}`, 'error');
        } finally {
          btn.disabled = false;
          btn.textContent = originalText;
        }
      });
    }

    card.querySelector('[data-action="delete"]').addEventListener('click', async () => {
      if (!confirm(`Remove voice @${id}?`)) return;
      const list = (settings.voices || []).filter((v) => v.id !== id);
      await saveSettings({ voices: list });
      renderVoicesList();
    });
  });
}

async function addNewVoice() {
  const raw = $('new-voice-handle').value.trim();
  const handle = raw.replace(/^@/, '');
  if (!handle) return;
  const existing = settings.voices || [];
  if (existing.some((v) => v.id === handle)) {
    setStatus(`Voice @${handle} already exists.`, 'error');
    return;
  }
  const list = [...existing, { id: handle, handle, name: handle, samples: [] }];
  await saveSettings({ voices: list });
  $('new-voice-handle').value = '';
  renderVoicesList();
  const pullHint = ADAPTERS[currentHost]?.supportsVoicePull
    ? ' Paste samples, or run a Slack search and click "Pull from search".'
    : ' Paste sample messages to teach their style.';
  setStatus(`Added voice @${handle}.${pullHint}`, 'ok');
}

// ---------- render ----------
function renderConversation(data) {
  const isThread = data.mode === 'thread';
  const label = isThread ? `Thread · ${data.label || 'Thread'}` : `Chat · ${data.label || 'Chat'}`;
  $('thread-label').textContent = `${label} (${data.count})`;
  const root = $('thread-view');
  root.classList.remove('empty');
  const items = data.messages || [];
  const highlightParent = isThread && !!ADAPTERS[currentHost]?.supportsThreadHighlight;
  root.innerHTML = items
    .map((m, i) => `
      <div class="msg ${highlightParent && i === 0 ? 'parent' : ''}">
        <div class="msg-header">
          <strong>${escapeHtml(m.author || 'unknown')}</strong>
          <span class="ts">${escapeHtml(formatTs(m.ts))}</span>
        </div>
        <div class="msg-body">${renderMarkdown(m.text || '')}</div>
      </div>`)
    .join('');
  root.scrollTop = root.scrollHeight;
}

function setStatus(msg, kind = '') {
  const el = $('status');
  el.textContent = msg;
  el.className = `status ${kind}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Render a (trusted-for-structure) markdown string to HTML for display.
// The source is our own toMarkdown output; we still escape carefully so
// pasted message content can't inject HTML/JS into the side panel.
function renderMarkdown(src) {
  if (!src) return '';

  const codeBlocks = [];
  let s = src.replace(/```([\s\S]*?)```/g, (_, body) => {
    codeBlocks.push(body.replace(/^\n|\n$/g, ''));
    return ` §CB${codeBlocks.length - 1}§ `;
  });
  const inlineCode = [];
  s = s.replace(/`([^`\n]+)`/g, (_, body) => {
    inlineCode.push(body);
    return ` §IC${inlineCode.length - 1}§ `;
  });

  s = escapeHtml(s);

  s = s.replace(/ §CB(\d+)§ /g, (_, i) => `<pre><code>${escapeHtml(codeBlocks[+i])}</code></pre>`);
  s = s.replace(/ §IC(\d+)§ /g, (_, i) => `<code>${escapeHtml(inlineCode[+i])}</code>`);

  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)/g,
    (_, text, href) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');

  s = s.replace(/(^|\n)((?:&gt; [^\n]*(?:\n|$))+)/g, (_m, lead, block) => {
    const inner = block.replace(/(^|\n)&gt; /g, '$1').replace(/\n$/, '').replace(/\n/g, '<br>');
    return `${lead}<blockquote>${inner}</blockquote>`;
  });
  s = s.replace(/(^|\n)((?:- [^\n]*(?:\n|$))+)/g, (_m, lead, block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^- /, '')}</li>`).join('');
    return `${lead}<ul>${items}</ul>`;
  });
  s = s.replace(/(^|\n)((?:\d+\. [^\n]*(?:\n|$))+)/g, (_m, lead, block) => {
    const items = block.trim().split('\n').map((l) => `<li>${l.replace(/^\d+\. /, '')}</li>`).join('');
    return `${lead}<ol>${items}</ol>`;
  });

  return s;
}
