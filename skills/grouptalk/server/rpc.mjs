import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync } from 'node:fs';

export function preferredCodexBinary() {
  if (process.env.GROUPTALK_CODEX_BIN) return process.env.GROUPTALK_CODEX_BIN;
  // Desktop and a globally installed CLI can advertise different model catalogs.
  const desktop = [
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/Codex.app/Contents/Resources/codex-cli/bin/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    '/Applications/Codex.app/Contents/Resources/codex',
  ].find((path) => existsSync(path));
  return desktop || 'codex';
}

// Independent JSON-RPC client; Codex Share's stdio integration informed this transport.
export class CodexRpc extends EventEmitter {
  constructor({ cwd, binary = preferredCodexBinary(), args = [] } = {}) {
    super();
    this.pending = new Map();
    this.nextId = 1;
    this.stopped = false;
    this.child = spawn(binary, ['app-server', '--stdio', ...args], { cwd, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.exited = new Promise((resolve) => {
      this.child.once('exit', resolve);
      this.child.once('close', resolve);
    });
    this.child.on('error', (error) => this.fail(error));
    this.child.on('exit', (code, signal) => this.fail(new Error(`Codex 进程结束（${signal || code}）`)));
    this.child.stderr.on('data', (data) => this.emit('log', String(data)));
    this.child.stdin.on('error', (error) => this.fail(error));
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.id !== undefined && !message.method) {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
      } else if (message.id !== undefined) this.emit('request', message);
      else this.emit('notification', message);
    });
  }
  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'grouptalk', title: 'GroupTalk', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized' });
  }
  send(message) {
    if (this.stopped || !this.child.stdin.writable) throw new Error('Codex 连接已关闭');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}, timeout = 90_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 响应超时，请检查运行时状态`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.send({ id, method, params }); } catch (error) {
        clearTimeout(timer); this.pending.delete(id); reject(error);
      }
    });
  }
  respond(id, result) { this.send({ id, result }); }
  reject(id, message) { this.send({ id, error: { code: -32601, message } }); }
  fail(error) {
    if (this.stopped) return;
    this.stopped = true;
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    this.emit('disconnected', error);
  }
  close() {
    if (!this.closing) {
      this.closing = true;
      this.fail(new Error('GroupTalk 已停止'));
      if (this.child.kill('SIGTERM')) {
        const force = setTimeout(() => this.child.kill('SIGKILL'), 2500);
        void this.exited.then(() => clearTimeout(force));
      }
    }
    return this.exited;
  }
}
