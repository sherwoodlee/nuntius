// Service worker: routes LLM calls and native-messaging requests for the side
// panel. The side panel calls here via chrome.runtime.sendMessage so that
// fetch/nativeMessaging happen in the extension's privileged context, not the
// Slack/Teams/Instagram page context.

const OLLAMA_DEFAULT_HOST = 'http://localhost:11434';
const CLI_NATIVE_HOST = 'com.nuntius.claude';
const CLI_PROVIDERS = new Set(['claude', 'gemini', 'chatgpt']);

const SLACK_URL_RE = /^https:\/\/app\.slack\.com\//;
const TEAMS_URL_RE = /^https:\/\/teams\.(microsoft\.com|cloud\.microsoft|live\.com)\//;
const INSTAGRAM_URL_RE = /^https:\/\/www\.instagram\.com\/direct\//;
const FACEBOOK_URL_RE = /^https:\/\/www\.facebook\.com\/messages\//;

function hostForUrl(url) {
  if (SLACK_URL_RE.test(url || '')) return 'slack';
  if (TEAMS_URL_RE.test(url || '')) return 'teams';
  if (INSTAGRAM_URL_RE.test(url || '')) return 'instagram';
  if (FACEBOOK_URL_RE.test(url || '')) return 'facebook';
  return null;
}

async function applyPanelOptions(tab) {
  if (!tab?.id) return;
  const enabled = !!hostForUrl(tab.url);
  await chrome.sidePanel
    .setOptions({
      tabId: tab.id,
      path: 'sidepanel/sidepanel.html',
      enabled,
    })
    .catch(() => {});
}

async function resetAllTabs() {
  // Turn off the global default, then per-tab-enable only on matching tabs.
  // Needed because manifest's default_path otherwise shows the panel on any
  // tab our listeners haven't touched yet (e.g. tabs open at install time).
  await chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) await applyPanelOptions(tab);
}

chrome.runtime.onInstalled.addListener(resetAllTabs);
chrome.runtime.onStartup.addListener(resetAllTabs);

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab) await applyPanelOptions(tab);
});
chrome.tabs.onUpdated.addListener((_tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === 'complete') applyPanelOptions(tab);
});

// Clicking the toolbar icon on a supported chat tab opens the panel; on other
// tabs it no-ops (we don't want a panel dangling over unrelated sites).
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (hostForUrl(tab.url)) {
    await chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'draft') {
    handleDraft(msg.payload).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === 'ollama:listModels') {
    listOllamaModels(msg.host).then(sendResponse).catch((e) => sendResponse({ error: e.message }));
    return true;
  }
  if (msg?.type === 'provider:ping') {
    pingCliProvider(msg.provider).then(sendResponse).catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }
  return false;
});

async function handleDraft({ prompt, system, provider, host, model, effort }) {
  if (provider === 'ollama') {
    return ollamaDraft({ prompt, system }, { host: host || OLLAMA_DEFAULT_HOST, model });
  }
  if (CLI_PROVIDERS.has(provider)) {
    return cliDraft({ prompt, system }, { provider, model, effort });
  }
  throw new Error(`Unknown provider: ${provider}`);
}

async function ollamaDraft({ prompt, system }, { host, model }) {
  if (!model) throw new Error('No Ollama model selected. Open nuntius settings to pick one.');
  // /api/chat with role-separated messages gives instruction-tuned models
  // noticeably better adherence than /api/generate with a flat string.
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama ${res.status}: ${body.slice(0, 200) || res.statusText}`);
  }
  const data = await res.json();
  return { text: (data.message?.content || '').trim() };
}

async function listOllamaModels(host) {
  const base = host || OLLAMA_DEFAULT_HOST;
  const res = await fetch(`${base}/api/tags`);
  if (!res.ok) throw new Error(`Ollama ${res.status} ${res.statusText}`);
  const data = await res.json();
  return { models: (data.models || []).map((m) => ({ name: m.name })) };
}

// Bridges to local AI CLIs via a Node native-messaging host.
// Protocol: send { action, provider, prompt, system, model, effort }, receive
// { text } or { ok, version } / { error }.
function connectCliHost() {
  try {
    return chrome.runtime.connectNative(CLI_NATIVE_HOST);
  } catch (e) {
    throw new Error(`Native host unavailable: ${e.message}. Run the installer from nuntius settings.`);
  }
}

function pingCliProvider(provider) {
  return new Promise((resolve) => {
    const port = connectCliHost();
    let settled = false;
    port.onMessage.addListener((msg) => {
      settled = true;
      port.disconnect();
      if (msg?.error) resolve({ ok: false, error: msg.error });
      else resolve({ ok: true, version: msg?.version || '' });
    });
    port.onDisconnect.addListener(() => {
      if (settled) return;
      settled = true;
      const err = chrome.runtime.lastError?.message;
      resolve({ ok: false, error: err || 'native host disconnected' });
    });
    port.postMessage({ action: 'ping', provider });
  });
}

function cliDraft({ prompt, system }, { provider, model, effort }) {
  return new Promise((resolve, reject) => {
    const port = connectCliHost();
    port.onMessage.addListener((msg) => {
      port.disconnect();
      if (msg?.error) reject(new Error(msg.error));
      else resolve({ text: (msg?.text || '').trim() });
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError?.message;
      if (err) reject(new Error(`Native host disconnected: ${err}`));
    });
    port.postMessage({ action: 'draft', provider, prompt, system, model, effort });
  });
}
