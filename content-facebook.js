// Content script: lives inside facebook.com/messages/* and handles DOM
// scraping + draft paste for Messenger on the web.

(function () {
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  }

  function facebookToMarkdown(el) {
    if (!el) return '';
    const root = el.cloneNode(true);

    root.querySelectorAll('pre').forEach((n) => {
      if (!n.parentNode) return;
      const code = (n.textContent || '').replace(/\s+$/, '');
      n.replaceWith(document.createTextNode('\n```\n' + code + '\n```\n'));
    });
    root.querySelectorAll('code').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('`' + (n.textContent || '') + '`'));
    });
    root.querySelectorAll('a[href]').forEach((n) => {
      if (!n.parentNode) return;
      const href = n.getAttribute('href') || '';
      const text = (n.textContent || '').trim();
      const md = !text || text === href ? href : `[${text}](${href})`;
      n.replaceWith(document.createTextNode(md));
    });
    root.querySelectorAll('b, strong').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('**' + (n.textContent || '') + '**'));
    });
    root.querySelectorAll('i, em').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('_' + (n.textContent || '') + '_'));
    });
    root.querySelectorAll('s, del').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode('~~' + (n.textContent || '') + '~~'));
    });
    root.querySelectorAll('img[alt]').forEach((n) => {
      if (!n.parentNode) return;
      n.replaceWith(document.createTextNode(n.getAttribute('alt') || ''));
    });

    return (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function currentThreadId() {
    const match = location.pathname.match(/\/messages\/(?:e2ee\/)?t\/([^/?#]+)/);
    return match ? match[1] : location.pathname;
  }

  function findConversationLog() {
    return (
      document.querySelector('[role="log"][aria-label^="Messages in conversation titled "]') ||
      document.querySelector('[role="log"]')
    );
  }

  function findComposer() {
    const candidates = Array.from(document.querySelectorAll('[role="textbox"]')).filter(isVisible);
    for (const box of candidates) {
      const aria = (box.getAttribute('aria-label') || '').toLowerCase();
      if (aria.startsWith('write to ')) return box;
    }
    return candidates[0] || null;
  }

  function findChatLabel() {
    const labelEl =
      document.querySelector('main [role="region"] h3') ||
      document.querySelector('main h3') ||
      document.querySelector('h3');
    const text = (labelEl?.innerText || '').trim();
    if (text && text.toLowerCase() !== 'messages' && text.toLowerCase() !== 'compose') return text;
    return 'Messenger chat';
  }

  function cleanText(text) {
    return String(text || '').replace(/\u200e|\u200f|\u202a|\u202c/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function parseMetaLabel(label) {
    const text = cleanText(label);
    const match = text.match(/^Enter,\s*Message sent\s+(.+?)\s+by\s+(.+?):\s*/i);
    if (!match) return { author: '', ts: '' };
    return {
      ts: match[1].trim(),
      author: match[2].trim(),
    };
  }

  function normalizeLines(lines, author) {
    return lines.filter((line) => {
      if (!line) return false;
      if (line === author) return false;
      if (/^Enter,\s*Message sent/i.test(line)) return false;
      if (/^Sent\s+\d+\s*[mhdsw]/i.test(line)) return false;
      return true;
    });
  }

  function extractArticleMessage(article) {
    const metaBtn =
      article.querySelector('button[aria-label]') ||
      Array.from(article.querySelectorAll('button')).find((b) => /Message sent/i.test(b.getAttribute('aria-label') || b.textContent || ''));
    const metaLabel = metaBtn?.getAttribute('aria-label') || metaBtn?.textContent || '';
    const { author, ts } = parseMetaLabel(metaLabel);

    const bodyRoot =
      article.querySelector('[role="button"]') ||
      article.querySelector('[aria-label^="At "]') ||
      article;
    const raw = facebookToMarkdown(bodyRoot);
    const lines = normalizeLines(raw.split(/\r?\n/).map((s) => cleanText(s)), author);
    const text = cleanText(lines.join('\n'));
    if (!text) return null;

    return {
      author: author || 'unknown',
      ts,
      text,
    };
  }

  function scrapeChat(maxMessages) {
    const log = findConversationLog();
    if (!log) {
      return { error: 'Messenger conversation log not found. Open a conversation first.' };
    }
    const articles = Array.from(log.querySelectorAll('article')).filter(isVisible);
    if (articles.length === 0) {
      return { error: 'Conversation is open but no message articles were found. Selectors may need updating.' };
    }

    const messages = articles
      .map(extractArticleMessage)
      .filter(Boolean);

    if (messages.length === 0) {
      return { error: 'Conversation is open but no messages were extracted. Selectors may need updating.' };
    }

    const cap = Math.max(1, Math.min(200, maxMessages || 20));
    const tail = messages.slice(-cap);
    return {
      mode: 'chat',
      id: currentThreadId(),
      label: findChatLabel(),
      messages: tail,
      count: tail.length,
    };
  }

  async function pasteDraft(text) {
    const box = findComposer();
    if (!box) return { error: 'Messenger composer not found. Open a conversation first.' };
    box.focus();

    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(ev);
      if (ev.defaultPrevented) return { ok: true };
    } catch (e) {
      console.warn('[nuntius] messenger paste event failed:', e);
    }

    try {
      const before = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: text,
        bubbles: true,
        cancelable: true,
      });
      box.dispatchEvent(before);
      if (!before.defaultPrevented) {
        box.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText',
          data: text,
          bubbles: true,
        }));
        if (typeof document.execCommand === 'function') {
          document.execCommand('insertText', false, text);
        }
      }
    } catch (e) {
      return { error: `Paste failed: ${e.message}` };
    }

    const settled = (box.innerText || box.textContent || '').trim();
    if (!settled.includes(text.slice(0, 20))) {
      try {
        await navigator.clipboard.writeText(text);
        return { error: 'Messenger rejected the synthetic paste — text copied to your clipboard instead. Press Cmd+V in the composer.' };
      } catch {
        return { error: 'Messenger rejected the synthetic paste. Open the side panel console to grab the draft text.' };
      }
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'host:probe') {
      sendResponse({ host: 'facebook' });
      return;
    }
    if (msg?.type === 'scrape') {
      sendResponse(scrapeChat(msg.maxMessages));
      return;
    }
    if (msg?.type === 'paste') {
      pasteDraft(msg.text || '').then(sendResponse);
      return true;
    }
  });
})();
