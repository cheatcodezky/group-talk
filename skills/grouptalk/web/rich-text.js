import { lexer } from '../server/vendor/marked.mjs';

export const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function inline(text) {
  return esc(text)
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
}

function prose(text) {
  return text.split(/```[^\n]*\n([\s\S]*?)```/g).map((part, index) =>
    index % 2 ? `<pre><code>${esc(part)}</code></pre>` : part.split(/\n\n+/).filter(Boolean).map((paragraph) =>
      /^#{1,4} /.test(paragraph) && !paragraph.includes('\n')
        ? `<h3>${inline(paragraph.replace(/^#{1,4} /, ''))}</h3>`
        : `<p>${inline(paragraph)}</p>`).join('')).join('');
}

function table({ header, rows, align }) {
  function row(cells, tag) {
    return '<tr>' + cells.map(({ text }, index) => {
      const alignment = align[index];
      const attributes = (tag === 'th' ? ' scope="col"' : '') +
        (alignment === 'center' || alignment === 'right' ? ` class="align-${alignment}"` : '');
      return `<${tag}${attributes}>${inline(text)}</${tag}>`;
    }).join('') + '</tr>';
  }
  const body = rows.length ? `<tbody>${rows.map((cells) => row(cells, 'td')).join('')}</tbody>` : '';
  return `<div class="message-table"><table><thead>${row(header, 'th')}</thead>${body}</table></div>`;
}

export function rich(value) {
  const text = String(value || '');
  if (!text.includes('|')) return prose(text);
  const tokens = lexer(text, { gfm: true });
  if (!tokens.some(({ type }) => type === 'table')) return prose(text);
  let html = '';
  let pending = '';
  for (const token of tokens) {
    if (token.type === 'table') {
      html += prose(pending.trim()) + table(token);
      pending = '';
    } else {
      pending += token.raw;
    }
  }
  return html + prose(pending.trim());
}
