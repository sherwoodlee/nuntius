#!/usr/bin/env node
// Native messaging host: bridges the extension to the `claude` CLI.
//
// Protocol: Chrome writes { prompt, system, model, effort } as a length-prefixed
// JSON message to our stdin. We run `claude -p`, pipe the prompt, and write the
// response back (again length-prefixed). One message in, one message out.
//
// We pass --system-prompt to fully replace Claude Code's default system prompt
// (which is tuned for software-engineering agent work and leaks preambles /
// tool-use framing into chat drafts). We also pass --tools "" to disable all
// built-in tools — the drafter never needs file/bash access.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function resolveClaudeBin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const candidates = [
    path.join(process.env.HOME || '', '.local/bin/claude'),
    '/usr/local/bin/claude',
    '/opt/homebrew/bin/claude',
  ];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch {}
  }
  return 'claude';
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

function runClaude({ prompt, system, model, effort }) {
  return new Promise((resolve, reject) => {
    const bin = resolveClaudeBin();
    const args = ['-p', '--no-session-persistence'];
    if (model) args.push('--model', model);
    if (system) args.push('--system-prompt', system);
    if (effort && VALID_EFFORT.has(effort)) args.push('--effort', effort);
    // Variadic option; keep this last so commander doesn't swallow following flags.
    args.push('--tools', '');
    const proc = spawn(bin, args, { env: process.env });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d.toString()));
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `claude exited with code ${code}`));
    });
    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

(async () => {
  try {
    const msg = await readMessage();
    const text = await runClaude({
      prompt: msg.prompt || '',
      system: msg.system || '',
      model: msg.model,
      effort: msg.effort,
    });
    writeMessage({ text });
  } catch (e) {
    writeMessage({ error: e.message });
  }
})();
