import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes, randomUUID, createHash } from 'node:crypto';

export const secret = () => randomBytes(24).toString('base64url');
export const digest = (value) => createHash('sha256').update(String(value)).digest('hex');
export const DEFAULT_ROOM_TOPIC = '分享背景、提出不同看法，再一起邀请 Codex 参与。';

export class Store {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS room (id INTEGER PRIMARY KEY CHECK(id = 1), body TEXT NOT NULL)');
    const saved = this.db.prepare('SELECT body FROM room WHERE id = 1').get();
    this.state = saved ? JSON.parse(saved.body) : {
      id: randomUUID(), title: '一起把想法做成方案', topic: DEFAULT_ROOM_TOPIC,
      invite: secret(), hostKey: secret(), createdAt: Date.now(), members: [], messages: [], tasks: [], decisions: [],
      seq: 0, deliveredSeq: 0, sourceThreadId: null, threadId: null, sourceImported: false,
      queuePaused: false, settings: { jevEnabled: false, allowExecution: false },
      judge: { status: 'off', calls: 0, inputTokens: 0, cost: 0, lastSeq: 0, lastSpokeAt: 0, note: '' },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    };
    for (const task of this.state.tasks) {
      if (['starting', 'running'].includes(task.status)) {
        task.status = 'needs_review';
        task.error = '上次服务在任务执行中结束。请房主检查执行结果后恢复队列；系统不会自动重跑。';
        this.state.queuePaused = true;
      }
    }
    this.state.sideChats ??= [];
    this.state.coreItems ??= [];
    for (const chat of this.state.sideChats) {
      for (const question of chat.questions) {
        if (!['queued', 'running'].includes(question.status)) continue;
        question.status = 'failed';
        question.error = '房间已重启。可以重新发送这个问题。';
      }
    }
    this.save();
  }
  save() {
    this.db.prepare('INSERT INTO room(id, body) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET body = excluded.body').run(JSON.stringify(this.state));
  }
  addMessage(data) {
    const message = { id: randomUUID(), seq: ++this.state.seq, createdAt: Date.now(), ...data };
    this.state.messages.push(message);
    return message;
  }
  close() { this.db.close(); }
}
