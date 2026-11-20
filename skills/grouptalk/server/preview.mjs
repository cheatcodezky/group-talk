import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Marked } from './vendor/marked.mjs';

const PREVIEW_TTL_MS = 60_000;

export function createPreviewAccess() {
  const secret = randomBytes(32);
  const sign = (path, expires) => createHmac('sha256', secret).update(`${path}:${expires}`).digest();
  return {
    url(path) {
      const expires = Date.now() + PREVIEW_TTL_MS;
      return `${path}?ticket=${expires}.${sign(path, expires).toString('base64url')}`;
    },
    allows(path, ticket) {
      const match = ticket?.match(/^(\d{13})\.([\w-]{43})$/);
      return Boolean(match && Number(match[1]) >= Date.now() &&
        timingSafeEqual(sign(path, match[1]), Buffer.from(match[2], 'base64url')));
    },
  };
}

export function previewPolicy(kind) {
  const permissions = kind === 'html' ? "script-src 'unsafe-inline'; sandbox allow-scripts" :
    "script-src 'none'; sandbox allow-popups allow-popups-to-escape-sandbox";
  return `default-src 'none'; ${permissions}; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; frame-ancestors 'self'; base-uri 'none'; form-action 'none'`;
}

const escape = (value) => String(value).replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

const markdown = new Marked({
  renderer: {
    html({ text }) { return escape(text); },
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      if (!/^https?:\/\//i.test(href)) return label;
      return `<a href="${escape(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
    },
    image({ href, text }) {
      const alt = escape(text);
      if (!/^data:image\/(?:png|jpeg|gif|webp);base64,/i.test(href)) return alt;
      return `<img src="${escape(href)}" alt="${alt}">`;
    },
  },
});

export function renderMarkdown(text, name) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(name)}</title>
  <style>
    body { margin: 0 auto; padding: 28px clamp(16px, 4vw, 44px) 52px; max-width: 900px; color: #252334; background: white; font: 16px/1.65 system-ui, "Microsoft YaHei UI", sans-serif; overflow-wrap: anywhere; }
    h1,h2,h3,h4 { line-height: 1.3; } h2 { margin-top: 1.5em; } a { color: #5144a0; }
    code { background: #f1f0f7; border-radius: 4px; padding: .15em .3em; }
    pre { background: #f1f0f7; border-radius: 8px; padding: 14px; overflow: auto; }
    pre code { padding: 0; } img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; } th,td { border: 1px solid #dedbe8; padding: .45em .65em; } th { background: #f4f2f9; text-align: left; }
    blockquote { border-left: 3px solid #ccc5e4; margin-left: 0; padding-left: 1em; color: #625b72; }
  </style><body>${markdown.parse(text)}</body></html>`;
}
