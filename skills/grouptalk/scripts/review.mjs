import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { parseArgs } from 'node:util';

async function run() {
  const { values, positionals } = parseArgs({
    options: { comment: { type: 'boolean' }, agent: { type: 'string' }, model: { type: 'string' } },
    allowPositionals: true,
  });
  const [argument, file] = positionals;
  const link = new URL(argument || process.env.GROUPTALK_REVIEW_LINK);
  const local = ['127.0.0.1', '[::1]', 'localhost'].includes(link.hostname);
  const ticket = new URLSearchParams(link.hash.slice(1)).get('review');
  if ((link.protocol !== 'https:' && !(link.protocol === 'http:' && local)) ||
      link.username || link.password || link.pathname !== '/' || link.search || !/^[A-Za-z0-9_-]{32}$/.test(ticket || '')) {
    throw new Error('请提供 GroupTalk 专用评审链接。局域网地址须使用 HTTPS。');
  }
  if (positionals.length > 2 || (!values.comment && (file !== undefined || values.agent !== undefined || values.model !== undefined))) {
    throw new Error('用法：<评审链接> [--comment [文本文件] [--agent 名称] [--model 模型]]。');
  }
  const headers = { authorization: `Bearer ${ticket}` };
  let body;
  if (values.comment) {
    const input = file ? createReadStream(file, { encoding: 'utf8' }) : process.stdin.setEncoding('utf8');
    let text = '';
    for await (const chunk of input) {
      text += chunk;
      if (text.length > 6000) throw new Error('评审意见最多 6000 字符。');
    }
    if (!text.trim()) throw new Error('请从标准输入提供评审意见。');
    body = JSON.stringify({ text, requestId: randomUUID(), agent: values.agent, model: values.model });
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(new URL('/api/review', link.origin), {
    method: body ? 'POST' : 'GET', headers, body, redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error(`评审服务返回 HTTP ${response.status}。请确认链接范围、有效期和访问地址。`);
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 64_000) throw new Error('评审服务返回的内容过大。');
    chunks.push(Buffer.from(chunk));
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (body ? typeof result?.id !== 'string' || typeof result?.authorName !== 'string'
    : typeof result?.context !== 'string' || typeof result?.reviewId !== 'string') {
    throw new Error('服务返回的评审格式不正确。');
  }
  console.log(JSON.stringify(result, null, 2));
}

try { await run(); }
catch (error) {
  console.error(`GroupTalk: ${error.code === 'ERR_INVALID_URL' ? '请提供有效的评审链接。' : error.message}`);
  process.exitCode = 1;
}
