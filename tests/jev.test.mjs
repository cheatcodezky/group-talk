import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { JevJudge } from '../server/jev.mjs';

test('Jev 使用官方 Noul 协议、只在服务端发送密钥并读取 Token 用量', async (t) => {
  let received;
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { auth: req.headers.authorization, data: JSON.parse(Buffer.concat(chunks)) };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'jev-1.14.0', answers: { information_gap: { type: 'noul', noul: 0.93 }, needs_clarification: { type: 'noul', noul: 0.2 } }, usage: { input_tokens: 1500 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const judge = new JevJudge({ key: 'test-server-key', endpoint: `http://127.0.0.1:${server.address().port}` });
  const result = await judge.evaluate({ messages: [{ text: '讨论内容' }] });
  assert.equal(received.auth, 'Bearer test-server-key');
  assert.equal(received.data.questions.information_gap.type, 'noul');
  assert.equal(received.data.model, 'jev-1.14.0');
  assert.equal(result.gap, 0.93); assert.equal(result.tokens, 1500);
});

test('Jev 对缺密钥、错误 HTTP、无效概率与超时返回明确错误', async (t) => {
  await assert.rejects(new JevJudge({ key: '' }).evaluate({}), /TYPESAFE_API_KEY/);
  await assert.rejects(new JevJudge({ key: 'test', fetcher: async () => new Response('{}', { status: 402 }) }).evaluate({}), /402/);
  await assert.rejects(new JevJudge({ key: 'test', fetcher: async () => Response.json({ answers: { information_gap: { noul: 1.4 }, needs_clarification: { noul: 0 } } }) }).evaluate({}), /格式/);
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const judge = new JevJudge({ key: 'test', timeout: 20, endpoint: `http://127.0.0.1:${server.address().port}` });
  await assert.rejects(judge.evaluate({}), /timeout|aborted/i);
});
