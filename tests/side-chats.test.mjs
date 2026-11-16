import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture, FakeAgent, message, until } from './helpers.mjs';
import { Store } from '../skills/grouptalk/server/store.mjs';
import { serve } from '../skills/grouptalk/server/http.mjs';

function create(room, author, anchorId) {
  return room.sideChats.create(author, { clientId: 'side-topic', title: '缓存边界', anchorId });
}
function context(prompt) {
  return JSON.parse(prompt.slice(prompt.indexOf('\n') + 1));
}

test('侧聊继承开启时的群聊、引用和记录，独立于正在运行的主任务', async (t) => {
  const mainAgent = new FakeAgent({ duration: 1000 });
  const sideAgent = new FakeAgent({ duration: 10, respond: () => '侧聊独有建议：先查租户边界。' });
  const { room, owner, alice, bob, close } = await fixture({ agent: mainAgent, sideAgentFactory: () => sideAgent });
  t.after(close);
  const main = room.post(owner, message('验证一下主任务', 'execute')).task;
  await until(() => main.status === 'running');
  const initial = room.post(alice, message('TTL 设为 137 秒')).message;
  room.post(bob, message('需要租户隔离'));
  room.addNote(alice, { kind: 'decision', text: '首版只支持文字' });
  const side = create(room, alice, initial.id);
  room.post(bob, message('侧聊开启之后的新群聊'));
  const mainCutoff = room.state.deliveredSeq;
  const mainMessageCount = room.state.messages.length;
  const question = room.sideChats.post(bob, side.id, message('两个约束如何兼顾？'));
  await until(() => question.status === 'completed');
  assert.equal(main.status, 'running');
  assert.equal(mainAgent.active, 1);
  assert.equal(sideAgent.calls[0].mode, 'ask');
  const data = context(sideAgent.calls[0].prompt);
  assert.match(data.anchor.text, /137 秒/);
  assert.ok(data.discussion.some((entry) => entry.text === '需要租户隔离'));
  assert.equal(data.notes[0].text, '首版只支持文字');
  assert.doesNotMatch(JSON.stringify(data), /侧聊开启之后的新群聊/);
  assert.equal(room.state.deliveredSeq, mainCutoff);
  assert.equal(room.state.messages.length, mainMessageCount);
  assert.equal(room.state.tasks.length, 1);
  assert.equal(room.snapshot(owner).sideChats[0].questions[0].answer, question.answer);

  const followUp = room.sideChats.post(alice, side.id, message('还有别的建议吗？'));
  await until(() => followUp.status === 'completed');
  assert.equal(context(sideAgent.calls[1].prompt).history[0].answer, question.answer);
  const forwarded = room.sideChats.share(bob, side.id, question.id);
  assert.equal(forwarded.authorName, bob.name);
  assert.equal(forwarded.sideChat.title, side.title);
  assert.equal(forwarded.text, question.answer);
  assert.equal(room.sideChats.share(alice, side.id, question.id).id, forwarded.id);
  assert.equal(room.state.messages.length, mainMessageCount + 1);
  assert.equal(room.state.tasks.length, 1);
});

test('侧聊问题去重，权限限制停止操作，房间重启保留记录且不重跑请求', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'grouptalk-side-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'room.sqlite');
  const { room, alice, bob, close } = await fixture({
    store: new Store(path), sideAgentFactory: () => new FakeAgent({ duration: 500 }),
  });
  const side = create(room, alice);
  assert.equal(create(room, alice).id, side.id);
  const input = message('请解释缓存边界');
  const question = room.sideChats.post(alice, side.id, input);
  assert.equal(room.sideChats.post(alice, side.id, input).id, question.id);
  await until(() => question.status === 'running');
  assert.throws(() => room.sideChats.cancel(bob, side.id, question.id), /只能停止自己/);
  assert.throws(() => room.sideChats.share(bob, side.id, question.id), /已完成/);
  const queued = room.sideChats.post(bob, side.id, message('这条会在重启时结束'));
  room.sideChats.cancel(alice, side.id, question.id);
  assert.equal(question.status, 'cancelled');
  close();
  const reopened = new Store(path);
  t.after(() => reopened.close());
  assert.equal(reopened.state.sideChats[0].questions.find((entry) => entry.id === queued.id).status, 'failed');
  assert.equal(reopened.state.queuePaused, false);
});

test('两个成员通过 HTTP 和事件流共享侧聊，匿名访问被拒绝', async (t) => {
  const f = await fixture({ sideAgentFactory: () => new FakeAgent({ respond: () => '共享侧聊答复' }) });
  const web = await serve({ room: f.room, host: '127.0.0.1', port: 0 });
  const controller = new AbortController();
  t.after(async () => { controller.abort(); await web.close(); f.close(); });
  const base = `http://127.0.0.1:${web.port}`;
  const post = (path, token, body) => fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
  const createInput = { clientId: 'side-topic', title: '共享侧聊' };
  assert.equal((await post('/api/side-chats', null, createInput)).status, 401);
  const response = await post('/api/side-chats', f.tokens.alice, createInput);
  assert.equal(response.status, 201);
  const { id } = await response.json();
  const stream = await fetch(base + '/api/events', {
    headers: { authorization: `Bearer ${f.tokens.bob}` }, signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  const reply = await post(`/api/side-chats/${id}/messages`, f.tokens.alice, message('问题'));
  assert.equal(reply.status, 201);
  let prepared = false;
  let buffer = '';
  const timeout = setTimeout(() => controller.abort(), 2000);
  try {
    while (!prepared) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split('\n\n');
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split('\n').find((entry) => entry.startsWith('data: '));
        if (!line) continue;
        const snapshot = JSON.parse(line.slice(6));
        assert.equal(snapshot.me.name, '小李');
        assert.equal(snapshot.sideChats[0].title, '共享侧聊');
        const question = snapshot.sideChats[0].questions[0];
        if (question?.status === 'completed') {
          assert.equal(question.answer, '共享侧聊答复');
          assert.equal(snapshot.messages.length, 0);
          prepared = true;
        }
      }
    }
    assert.ok(prepared);
  } finally { clearTimeout(timeout); controller.abort(); }
});
