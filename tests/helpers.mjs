import { randomUUID } from 'node:crypto';
import { Store } from '../skills/grouptalk/server/store.mjs';
import { Room } from '../skills/grouptalk/server/room.mjs';

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(predicate, timeout = 2000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) throw new Error('等待测试条件超时'); await delay(5); }
}
export class FakeAgent {
  constructor({ duration = 25, fail, history = [], respond = () => '已结合大家的讨论给出建议。' } = {}) {
    Object.assign(this, { duration, fail, history, respond });
    this.calls = []; this.active = 0; this.maxActive = 0;
  }
  async initialize({ threadId, sourceThreadId }) {
    this.initialization = { threadId, sourceThreadId };
    return { threadId: threadId || 'shared-thread', model: 'test-agent', history: this.history };
  }
  async run(options) {
    this.calls.push(options); this.active++; this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.fail === 'before') throw new Error('提交被拒绝');
      options.onAccepted(`turn-${this.calls.length}`);
      if (this.fail === 'uncertain') { const error = new Error('连接状态未知'); error.uncertain = true; throw error; }
      options.onProgress({ type: 'test', text: '正在核对共同观点' });
      options.onDelta('正在分析…');
      await new Promise((resolve) => { this.resolve = resolve; this.timer = setTimeout(resolve, this.duration); });
      return { status: this.interrupted ? 'cancelled' : 'completed', text: this.interrupted ? '任务已停止。' : this.respond(options), usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 40 } };
    } finally { this.active--; }
  }
  async interrupt() { this.interrupted = true; clearTimeout(this.timer); this.resolve?.(); }
  close() { clearTimeout(this.timer); this.resolve?.(); }
}
export async function fixture(options = {}) {
  const store = options.store || new Store(':memory:');
  const agent = options.agent || new FakeAgent();
  const judge = options.judge || { ready: false, evaluate: async () => { throw new Error('不应调用'); } };
  const room = new Room({ store, agent, judge, cwd: '/tmp/grouptalk-test-workspace', debounceMs: 10, maxWaitMs: 30, cooldownMs: 30, ...options });
  await room.initialize();
  const owner = room.join({ key: store.state.hostKey, name: '房主' }, { local: true });
  const alice = room.join({ key: store.state.invite, name: '小王' });
  const bob = room.join({ key: store.state.invite, name: '小李' });
  return { store, room, agent, owner: room.authenticate(owner.token), alice: room.authenticate(alice.token), bob: room.authenticate(bob.token), tokens: { owner: owner.token, alice: alice.token, bob: bob.token }, close: () => { room.close(); store.close(); } };
}
export const message = (text, mode = 'chat', extra = {}) => ({ text, mode, clientId: randomUUID(), ...extra });
