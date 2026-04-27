// Content script: lives inside instagram.com/direct/* and handles DOM scraping
// + draft paste for Instagram web DMs.

(function () {
  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
  }

  function instagramToMarkdown(el) {
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
    root.querySelectorAll('button, svg').forEach((n) => n.remove());

    return (root.innerText || '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function currentThreadId() {
    const match = location.pathname.match(/\/direct\/t\/([^/?#]+)/);
    return match ? match[1] : location.pathname;
  }

  function findComposer() {
    const roleBox = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (roleBox && isVisible(roleBox)) return roleBox;

    const candidates = [...document.querySelectorAll('div[contenteditable="true"]')];
    for (const box of candidates) {
      if (!isVisible(box)) continue;
      const aria = (box.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (box.getAttribute('placeholder') || '').toLowerCase();
      if (aria.includes('message') || placeholder.includes('message')) return box;
    }
    return candidates.find(isVisible) || null;
  }

  function findConversationRoot() {
    return (
      document.querySelector('[aria-label^="Conversation with "]') ||
      document.querySelector('[aria-label*="Conversation with "]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
    );
  }

  function findChatLabel(root) {
    const labelEl =
      root.querySelector('h1, h2') ||
      document.querySelector('header h1, header h2');
    return (labelEl?.innerText || '').trim() || 'Instagram chat';
  }

  function looksLikeTimestamp(text) {
    return /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2}|[a-z]{3,9}\s+\d{1,2})/i.test(text || '');
  }

  function isControlText(text) {
    return /^(audio call|video call|conversation information|choose an emoji|voice clip|add photo or video|choose a gif or sticker|message\.\.\.)$/i.test(text || '');
  }

  function cleanText(text) {
    return String(text || '').replace(/\u200e|\u200f|\u202a|\u202c/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function dedupeConsecutive(arr) {
    const out = [];
    for (const value of arr) {
      if (!value) continue;
      if (out[out.length - 1] === value) continue;
      out.push(value);
    }
    return out;
  }

  function scrapeChat(maxMessages) {
    const root = findConversationRoot();
    if (!root || !isVisible(root)) {
      return { error: 'Instagram conversation not found. Open a DM thread in Instagram first.' };
    }

    const label = findChatLabel(root);
    const profileHref = root.querySelector('a[href^="/"]')?.getAttribute('href') || '';
    const participantHandle = profileHref.replace(/\//g, '').trim();
    const composer = findComposer();

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    const messages = [];
    let lastText = '';
    let pendingAuthor = '';
    let pendingTs = '';
    let started = false;
    let node;

    while ((node = walker.nextNode())) {
      if (!(node instanceof Element)) continue;
      if (!isVisible(node)) continue;
      if (composer && (node === composer || composer.contains(node))) break;

      if (node.matches('a[href^="/"]')) {
        const href = node.getAttribute('href') || '';
        if (participantHandle && href.replace(/\//g, '').trim() === participantHandle) {
          pendingAuthor = label;
          continue;
        }
      }

      if (node.matches('[dir="auto"], button')) {
        const text = cleanText(instagramToMarkdown(node));
        if (!text || isControlText(text)) continue;
        if (text === label || text === participantHandle) continue;
        if (text === lastText) continue;

        if (looksLikeTimestamp(text)) {
          started = true;
          pendingTs = text;
          lastText = text;
          continue;
        }

        started = true;
        messages.push({
          author: pendingAuthor || 'Me',
          ts: pendingTs,
          text,
        });
        lastText = text;
        pendingAuthor = '';
        pendingTs = '';
      }
    }

    const deduped = dedupeConsecutive(
      messages
        .map((m) => ({ ...m, text: cleanText(m.text) }))
        .filter((m) => m.text && !looksLikeTimestamp(m.text))
        .map((m) => JSON.stringify(m))
    ).map((row) => JSON.parse(row));

    if (deduped.length === 0) {
      // Fallback: if the DOM structure shifts again, at least return a parsed
      // transcript from the visible conversation container instead of failing
      // hard.
      const transcript = dedupeConsecutive(
        cleanText(root.innerText)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => s && !isControlText(s) && s !== label && s !== participantHandle)
      );
      const fallbackMessages = [];
      let ts = '';
      for (const line of transcript) {
        if (looksLikeTimestamp(line)) {
          ts = line;
          continue;
        }
        fallbackMessages.push({ author: 'unknown', ts, text: line });
      }
      const cap = Math.max(1, Math.min(200, maxMessages || 20));
      return {
        mode: 'chat',
        id: currentThreadId(),
        label,
        messages: fallbackMessages.slice(-cap),
        count: fallbackMessages.slice(-cap).length,
      };
    }

    const cap = Math.max(1, Math.min(200, maxMessages || 20));
    const tail = deduped.slice(-cap);
    return {
      mode: 'chat',
      id: currentThreadId(),
      label,
      messages: tail,
      count: tail.length,
    };
  }

  async function pasteDraft(text) {
    const box = findComposer();
    if (!box) {
      return { error: 'Instagram composer not found. Open a DM thread first.' };
    }
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
      console.warn('[nuntius] instagram paste event failed:', e);
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
        return { error: 'Instagram rejected the synthetic paste — text copied to your clipboard instead. Press Cmd+V in the composer.' };
      } catch {
        return { error: 'Instagram rejected the synthetic paste. Open the side panel console to grab the draft text.' };
      }
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'host:probe') {
      sendResponse({ host: 'instagram' });
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
