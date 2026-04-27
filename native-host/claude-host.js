#!/usr/bin/env node
// Native messaging host: bridges the extension to local AI CLIs.
//
// Protocol: Chrome writes { action, provider, prompt, system, model, effort }
// as a length-prefixed JSON message to our stdin. We run the selected CLI and
// write the response back (again length-prefixed). One message in, one message out.
//
// We pass --system-prompt to fully replace Claude Code's default system prompt
// (which is tuned for software-engineering agent work and leaks preambles /
// tool-use framing into chat drafts). We also pass --tools "" to disable all
// built-in tools — the drafter never needs file/bash access.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function resolveBin(provider) {
  const envVar =
    provider === 'claude' ? 'CLAUDE_BIN'
    : provider === 'gemini' ? 'GEMINI_BIN'
    : provider === 'chatgpt' ? 'CODEX_BIN'
    : null;
  if (envVar && process.env[envVar]) return process.env[envVar];
  const command =
    provider === 'claude' ? 'claude'
    : provider === 'gemini' ? 'gemini'
    : provider === 'chatgpt' ? 'codex'
    : null;
  if (!command) throw new Error(`Unsupported provider: ${provider}`);
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin', command),
    '/usr/local/bin/' + command,
    '/opt/homebrew/bin/' + command,
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return command;
}

function readMessage() {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(4);
    let headerRead = 0;
    let bodyLen = 0;
    let body = Buffer.alloc(0);
    const onData = (chunk) => {
      while (chunk.length > 0) {
        if (headerRead < 4) {
          const take = Math.min(4 - headerRead, chunk.length);
          chunk.copy(header, headerRead, 0, take);
          headerRead += take;
          chunk = chunk.subarray(take);
          if (headerRead === 4) {
            const len = header.readUInt32LE(0);
            if (len > 10 * 1024 * 1024) {
              reject(new Error(`message too large: ${len}`));
              return;
            }
            bodyLen = len;
            body = Buffer.alloc(0);
          }
        }
        if (headerRead === 4) {
          const take = Math.min(bodyLen - body.length, chunk.length);
          body = Buffer.concat([body, chunk.subarray(0, take)]);
          chunk = chunk.subarray(take);
          if (body.length === bodyLen) {
            process.stdin.removeListener('data', onData);
            try { resolve(JSON.parse(body.toString('utf8'))); } catch (e) { reject(e); }
            return;
          }
        }
      }
    };
    process.stdin.on('data', onData);
    process.stdin.on('end', () => reject(new Error('stdin closed before message received')));
  });
}

function writeMessage(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(header);
  process.stdout.write(body);
}

const VALID_EFFORT = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function runProcess(bin, args, { input = '', cwd } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, {
      env: process.env,
      cwd: cwd || process.env.HOME || os.tmpdir(),
    });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout: out.trim(), stderr: err.trim() });
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });
    proc.stdin.write(input);
    proc.stdin.end();
  });
}

function buildHeadlessPrompt({ system, prompt }) {
  const parts = [];
  if (system) parts.push(`<system>\n${system}\n</system>`);
  if (prompt) parts.push(`<user>\n${prompt}\n</user>`);
  parts.push('Return only the final reply text with no preamble, quotes, or markdown fences.');
  return parts.join('\n\n');
}

function pingProvider(provider) {
  const bin = resolveBin(provider);
  return runProcess(bin, ['--version']).then(({ stdout, stderr }) => stdout || stderr || 'ok');
}

function runClaude({ prompt, system, model, effort }) {
  const bin = resolveBin('claude');
  const args = ['-p', '--no-session-persistence'];
  if (model) args.push('--model', model);
  if (system) args.push('--system-prompt', system);
  if (effort && VALID_EFFORT.has(effort)) args.push('--effort', effort);
  // Variadic option; keep this last so commander doesn't swallow following flags.
  args.push('--tools', '');
  return runProcess(bin, args, { input: prompt }).then(({ stdout }) => stdout);
}

function runGemini({ prompt, system, model }) {
  const bin = resolveBin('gemini');
  const args = [];
  if (model) args.push('-m', model);
  args.push('-p', buildHeadlessPrompt({ system, prompt }));
  return runProcess(bin, args).then(({ stdout }) => stdout);
}

function runChatgpt({ prompt, system, model }) {
  const bin = resolveBin('chatgpt');
  const args = ['exec', '--skip-git-repo-check'];
  if (model) args.push('-m', model);
  args.push(buildHeadlessPrompt({ system, prompt }));
  return runProcess(bin, args).then(({ stdout }) => stdout);
}

async function runDraft({ provider, prompt, system, model, effort }) {
  if (provider === 'claude') return runClaude({ prompt, system, model, effort });
  if (provider === 'gemini') return runGemini({ prompt, system, model });
  if (provider === 'chatgpt') return runChatgpt({ prompt, system, model });
  throw new Error(`Unsupported provider: ${provider}`);
}

(async () => {
  try {
    const msg = await readMessage();
    if (msg.action === 'ping') {
      const version = await pingProvider(msg.provider);
      writeMessage({ ok: true, version });
      return;
    }
    const text = await runDraft({
      provider: msg.provider || 'claude',
      prompt: msg.prompt || '',
      system: msg.system || '',
      model: msg.model,
      effort: msg.effort,
    });
    writeMessage({ text: (text || '').trim() });
  } catch (e) {
    writeMessage({ error: e.message });
  }
})();
