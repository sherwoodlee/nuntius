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
      document.querySelector('[role="log"]') ||
      document.querySelector('[role="grid"][aria-label^="Messages"]') ||
      document.querySelector('[role="grid"]') ||
      document.querySelector('main[role="main"]') ||
      document.querySelector('main') ||
      document.body
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
    const text = cleanConversationTitle(labelEl?.innerText || '');
    if (text && text.toLowerCase() !== 'messages' && text.toLowerCase() !== 'compose') return text;

    const logLabel = document.querySelector('[role="log"][aria-label]')?.getAttribute('aria-label') || '';
    const logTitle = cleanConversationTitle(logLabel);
    if (logTitle && logTitle.toLowerCase() !== 'messages') return logTitle;

    return 'Messenger chat';
  }

  function cleanText(text) {
    return String(text || '').replace(/\u200e|\u200f|\u202a|\u202c/g, '').replace(/\n{3,}/g, '\n\n').trim();
  }

  function cleanConversationTitle(text) {
    return cleanText(text)
      .replace(/^Messages in conversation with\s+/i, '')
      .replace(/^Messages in conversation titled\s+/i, '')
      .replace(/^Conversation titled\s+/i, '')
      .replace(/^Conversation with\s+/i, '')
      .replace(/^Chat with\s+/i, '')
      .replace(/[.。]\s*$/, '')
      .trim();
  }

  function normalizeAuthor(author) {
    const text = cleanConversationTitle(author);
    if (/^(you|yourself)$/i.test(text)) return 'Me';
    return text;
  }

  function parseAriaMessageText(text) {
    const normalized = cleanText(text).replace(/^["“]|["”]$/g, '');
    const patterns = [
      /^Enter,\s*Message sent\s+(.+?)\s+by\s+(.+?):\s*(.+)$/i,
      /^Message sent\s+(.+?)\s+by\s+(.+?):\s*(.+)$/i,
      /^(.+?)\s+sent\s+(.+?)\s+at\s+(.+?):\s*(.+)$/i,
      /^(.+?)\s+sent:\s*(.+)$/i,
      /^Message from\s+(.+?)(?:,\s*(.+?))?:\s*(.+)$/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (!match) continue;
      if (pattern === patterns[0] || pattern === patterns[1]) {
        return { ts: match[1].trim(), author: normalizeAuthor(match[2]), text: cleanText(match[3]) };
      }
      if (pattern === patterns[2]) {
        return { ts: match[3].trim(), author: normalizeAuthor(match[1]), text: cleanText(match[4]) };
      }
      if (pattern === patterns[3]) {
        return { ts: '', author: normalizeAuthor(match[1]), text: cleanText(match[2]) };
      }
      return { ts: match[2] || '', author: normalizeAuthor(match[1]), text: cleanText(match[3]) };
    }

    return { author: '', ts: '', text: '' };
  }

  function parseMetaLabel(label) {
    const text = cleanText(label);
    const ariaMessage = parseAriaMessageText(text);
    if (ariaMessage.author || ariaMessage.text) return ariaMessage;

    const match = text.match(/^Enter,\s*Message sent\s+(.+?)\s+by\s+(.+?):\s*/i);
    if (!match) return { author: '', ts: '', text: '' };
    return {
      ts: match[1].trim(),
      author: normalizeAuthor(match[2]),
      text: '',
    };
  }

  function splitParticipantNames(label) {
    return cleanConversationTitle(label)
      .split(/\s*(?:,| and | & )\s*/i)
      .map((name) => cleanText(name))
      .filter(Boolean);
  }

  function collectParticipantNames(root, chatLabel) {
    const names = new Set(splitParticipantNames(chatLabel));
    root.querySelectorAll('[aria-label]').forEach((el) => {
      const meta = parseMetaLabel(el.getAttribute('aria-label') || '');
      if (meta.author && meta.author !== 'Me') names.add(meta.author);
    });
    return Array.from(names).filter((name) => name && !/^(messenger chat|messages)$/i.test(name));
  }

  function looksLikeTimestamp(text) {
    return /^(today|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}:\d{2}|[a-z]{3,9}\s+\d{1,2}|sent\s+\d+\s*[mhdsw])/i.test(text || '');
  }

  function isMessengerChromeText(text, author, chatLabel, participantNames = []) {
    const value = cleanText(text);
    const lowerValue = value.toLowerCase();
    if (!value) return true;
    if (lowerValue === cleanText(author).toLowerCase()) return true;
    if (lowerValue === cleanText(chatLabel).toLowerCase()) return true;
    if (
      [...splitParticipantNames(chatLabel), ...participantNames]
        .some((name) => name.toLowerCase() === lowerValue)
    ) return true;
    if (/^Enter,\s*Message sent/i.test(value)) return true;
    if (looksLikeTimestamp(value)) return true;
    if (/^(messenger|messages|chats|search messenger|conversation information|contact information|privacy and support|customize chat|shared media|view profile|audio call|video call|start voice call|start video call|more actions|reply|forward|copy|remove|unsend|react|send a like|type a message)$/i.test(value)) return true;
    if (/^(active now|active \d+[mhd] ago|was active|end-to-end encrypted)$/i.test(value)) return true;
    return false;
  }

  function isInsideMessengerChrome(el) {
    return Boolean(el.closest('header, nav, [role="banner"], [role="navigation"], [aria-label="Thread details"], [aria-label="Conversation information"], [aria-label="Chats"]'));
  }

  function hasMessageBubbleAncestor(el) {
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      const style = getComputedStyle(cur);
      const bg = style.backgroundColor;
      const radius = parseFloat(style.borderTopLeftRadius || '0');
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent' && radius >= 6) return true;
      const aria = cur.getAttribute?.('aria-label') || '';
      if (parseMetaLabel(aria).author) return true;
      cur = cur.parentElement;
    }
    return false;
  }

  function normalizeLines(lines, author, chatLabel, participantNames) {
    return lines.filter((line) => {
      return !isMessengerChromeText(line, author, chatLabel, participantNames);
    });
  }

  function parseAccessibleTranscript(text, chatLabel, participantNames) {
    const source = cleanText(text);
    const markerRe = /Enter,\s*Message sent\s+(.+?)\s+by\s+(.+?):\s*/gi;
    const markers = [];
    let match;

    while ((match = markerRe.exec(source))) {
      markers.push({
        index: match.index,
        bodyStart: markerRe.lastIndex,
        ts: cleanText(match[1]),
        author: normalizeAuthor(match[2]),
      });
    }

    return markers.map((marker, i) => {
      const next = markers[i + 1]?.index ?? source.length;
      const textValue = cleanText(source.slice(marker.bodyStart, next));
      if (isMessengerChromeText(textValue, marker.author, chatLabel, participantNames)) return null;
      return {
        author: marker.author || 'unknown',
        ts: marker.ts,
        text: textValue,
      };
    }).filter(Boolean);
  }

  function findMessageMeta(root) {
    const candidates = [root, ...root.querySelectorAll('[aria-label], button')]
      .map((el) => el.getAttribute?.('aria-label') || el.textContent || '')
      .map(parseMetaLabel)
      .filter((meta) => meta.author || meta.text);
    return candidates[0] || { author: '', ts: '', text: '' };
  }

  function extractArticleMessage(article, chatLabel, participantNames, log) {
    if (isInsideMessengerChrome(article)) return null;

    const meta = findMessageMeta(article);
    let author = meta.author || guessAuthor(article, chatLabel, log);
    const ts = meta.ts || '';

    if (meta.text && !isMessengerChromeText(meta.text, author, chatLabel, participantNames)) {
      return {
        author: author || 'unknown',
        ts,
        text: meta.text,
      };
    }

    const visibleTextEls = Array.from(article.querySelectorAll('[dir="auto"]'))
      .filter((node) => isVisible(node) && !isInsideMessengerChrome(node));
    const bubbleTextEls = visibleTextEls.filter(hasMessageBubbleAncestor);
    const messageTextEls = bubbleTextEls.length > 0 ? bubbleTextEls : visibleTextEls;

    if (!meta.author && author === 'unknown') {
      const firstMessageEl = messageTextEls.find((node) => {
        const text = cleanText(facebookToMarkdown(node));
        return !isMessengerChromeText(text, '', chatLabel, participantNames);
      });
      author = firstMessageEl ? guessAuthor(firstMessageEl, chatLabel, log) : author;
    }

    const textNodes = messageTextEls
      .map((node) => cleanText(facebookToMarkdown(node)))
      .filter((line) => !isMessengerChromeText(line, author, chatLabel, participantNames));

    let text = cleanText(dedupeConsecutive(textNodes).join('\n'));

    if (!text) {
      const raw = facebookToMarkdown(article);
      const lines = normalizeLines(raw.split(/\r?\n/).map((s) => cleanText(s)), author, chatLabel, participantNames);
      text = cleanText(dedupeConsecutive(lines).join('\n'));
    }

    if (!text) return null;

    return {
      author: author || 'unknown',
      ts,
      text,
    };
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

  /**
   * Walk up the DOM from a message element and try to determine
   * whether the message was sent by "me" or the other participant.
   *
   * Heuristics (checked on each ancestor up to 15 levels):
   *  1. Background-color: Facebook renders self-messages with a
   *     blue/purple-ish bubble (high blue channel, low red) and
   *     other-person messages with a neutral gray.
   *  2. Flex alignment: self-messages are right-aligned (flex-end),
   *     other-person messages are left-aligned (flex-start).
   *  3. Aria labels: containers sometimes include text like
   *     "You sent" or "{Name} sent".
   */
  function guessAuthor(el, chatLabel, log) {
    let cur = el;
    for (let i = 0; i < 15 && cur && cur !== document.body; i++) {
      // Check aria-label for explicit sender info
      const aria = (cur.getAttribute('aria-label') || '').toLowerCase();
      const meta = parseMetaLabel(cur.getAttribute('aria-label') || '');
      if (meta.author) return meta.author;
      if (aria.includes('you sent') || aria.includes('sent by you') || aria.includes('your message')) return 'Me';
      if (chatLabel && aria.includes(chatLabel.toLowerCase())) return chatLabel;

      const style = getComputedStyle(cur);

      // Check flex alignment
      if (style.display === 'flex' || style.display === 'inline-flex') {
        if (style.justifyContent === 'flex-end') return 'Me';
        if (style.justifyContent === 'flex-start') return chatLabel || 'Them';
      }

      // Check background-color of the message bubble
      const bg = style.backgroundColor;
      if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
        const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          // Blue/purple bubble → self  (e.g. rgb(0,132,255), rgb(88,28,255))
          if (b > 180 && r < 120) return 'Me';
          // Neutral gray bubble → other person
          if (r > 180 && g > 180 && b > 180 && Math.abs(r - g) < 30 && Math.abs(g - b) < 30) {
            return chatLabel || 'Them';
          }
        }
      }

      cur = cur.parentElement;
    }

    const nodeRect = el.getBoundingClientRect?.();
    const logRect = log?.getBoundingClientRect?.();
    if (nodeRect && logRect && nodeRect.width > 0 && logRect.width > 0) {
      const center = nodeRect.left + (nodeRect.width / 2);
      const midpoint = logRect.left + (logRect.width / 2);
      if (center > midpoint + 24) return 'Me';
      if (center < midpoint - 24) return chatLabel || 'Them';
    }

    return 'unknown';
  }

  function scrapeChat(maxMessages) {
    const log = findConversationLog();
    if (!log) {
      return { error: 'Messenger conversation log not found. Open a conversation first.' };
    }
    const chatLabel = findChatLabel();
    const participantNames = collectParticipantNames(log, chatLabel);
    const articles = Array.from(log.querySelectorAll('article, [role="row"]')).filter(isVisible);
    let messages = [];

    if (articles.length > 0) {
      messages = articles.map((article) => extractArticleMessage(article, chatLabel, participantNames, log)).filter(Boolean);
    }

    if (messages.length === 0) {
      messages = parseAccessibleTranscript(log.innerText, chatLabel, participantNames);
    }

    if (messages.length === 0) {
      // Fallback 1: TreeWalker looking for [dir="auto"]
      const composer = findComposer();
      const walker = document.createTreeWalker(log, NodeFilter.SHOW_ELEMENT);
      let node;
      let lastText = '';
      const fallbackMessages = [];

      while ((node = walker.nextNode())) {
        if (!(node instanceof Element)) continue;
        if (!isVisible(node)) continue;
        if (composer && (node === composer || composer.contains(node))) break;
        if (isInsideMessengerChrome(node)) continue;

        if (node.matches('[dir="auto"]')) {
          const text = cleanText(facebookToMarkdown(node));
          if (isMessengerChromeText(text, '', chatLabel, participantNames)) continue;
          if (text === lastText) continue;
          if (!hasMessageBubbleAncestor(node)) continue;

          const author = guessAuthor(node, chatLabel, log);
          if (isMessengerChromeText(text, author, chatLabel, participantNames)) continue;
          fallbackMessages.push({
            author,
            ts: '',
            text,
          });
          lastText = text;
        }
      }

      const deduped = dedupeConsecutive(
        fallbackMessages
          .map((m) => ({ ...m, text: cleanText(m.text) }))
          .filter((m) => m.text)
          .map((m) => JSON.stringify(m))
      ).map((row) => JSON.parse(row));

      if (deduped.length > 0) {
        messages = deduped;
      }
    }

    if (messages.length === 0) {
      // Fallback 2: innerText
      const transcript = dedupeConsecutive(
        cleanText(log.innerText)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter((s) => !isMessengerChromeText(s, '', chatLabel, participantNames))
      );
      if (transcript.length > 0) {
        messages = transcript.map(line => ({ author: 'unknown', ts: '', text: line }));
      } else {
        return { error: 'Conversation is open but no messages were extracted. Selectors may need updating.' };
      }
    }

    const cap = Math.max(1, Math.min(200, maxMessages || 20));
    const tail = messages.slice(-cap);
    return {
      mode: 'chat',
      id: currentThreadId(),
      label: chatLabel,
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
