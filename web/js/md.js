// Markdown → sanitized HTML, with code highlighting and @mention chips.
import { Marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import hljs from '/vendor/hljs.js';

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function highlight(code, lang) {
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
  } catch (e) {}
  return escapeHtml(code);
}

const marked = new Marked({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }) {
      const l = (lang || '').trim().split(/\s+/)[0];
      return '<pre><code class="hljs' + (l ? ' language-' + escapeHtml(l) : '') + '">' + highlight(text, l) + '</code></pre>';
    },
  },
});

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
});

// Mark @handles outside code spans and fences.
function mentions(text) {
  return text.split(/(```[\s\S]*?```|`[^`\n]*`)/g).map((part, i) => (i % 2
    ? part
    : part.replace(/(^|[\s(])@([\p{L}\p{N}_-]+)/gu, '$1<span class="mention">@$2</span>'))).join('');
}

// YAML front matter (skills, agents, docs) reads better as a code block than as a heading.
function frontMatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  return m ? '```yaml\n' + m[1] + '\n```\n\n' + text.slice(m[0].length) : text;
}

export function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(mentions(frontMatter(String(text || '')))), { ADD_ATTR: ['target'] });
}

export function languageOf(ext) {
  const map = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', rs: 'rust', go: 'go', java: 'java', cs: 'csharp', kt: 'kotlin', php: 'php', sh: 'bash', bash: 'bash', ps1: 'powershell', psm1: 'powershell', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', html: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', css: 'css', scss: 'scss', sql: 'sql', md: 'markdown', c: 'c', h: 'c', cpp: 'cpp', hpp: 'cpp', swift: 'swift', dockerfile: 'dockerfile', diff: 'diff' };
  return map[ext] || null;
}
