import test from 'node:test';
import assert from 'node:assert/strict';
import { rich } from '../skills/grouptalk/web/rich-text.js';

test('聊天渲染 GitHub 风格的 Markdown 表格和单元格格式', () => {
  const html = rich([
    '### 功能进展', '',
    '| 功能 | 进度 |',
    '| --- | ---: |',
    '| **文档** \\| 预览 | `3` |', '',
    '后续待验收。',
  ].join('\n'));
  assert.match(html, /^<h3>功能进展<\/h3><div class="message-table"><table>/);
  assert.match(html, /<th scope="col" class="align-right">进度<\/th>/);
  assert.match(html, /<td><strong>文档<\/strong> \| 预览<\/td><td class="align-right"><code>3<\/code><\/td>/);
  assert.match(html, /<\/table><\/div><p>后续待验收。<\/p>$/);
});

test('代码块中的 Markdown 表格保持为源代码', () => {
  const html = rich('```markdown\n| A | B |\n| --- | --- |\n| x | y |\n```');
  assert.match(html, /^<pre><code>\| A \| B \|/);
  assert.doesNotMatch(html, /<table>/);
});

test('表格单元格沿用聊天文本的 HTML 转义和链接限制', () => {
  const html = rich('| 功能 | 状态 |\n| --- | --- |\n| <b>文字</b> | [说明](javascript:alert%281%29) |');
  assert.match(html, /<td>&lt;b&gt;文字&lt;\/b&gt;<\/td>/);
  assert.doesNotMatch(html, /<a\b|<b>/);
});
