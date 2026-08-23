import type { ElementNode } from './tree.js';

const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

const ATTR_NAME_ALIASES: Record<string, string> = {
  className: 'class',
  htmlFor: 'for',
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderAttrs(props: Record<string, unknown>): string {
  let out = '';
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    const name = ATTR_NAME_ALIASES[key] ?? key;
    if (value === true) {
      out += ` ${name}`;
      continue;
    }
    out += ` ${name}="${escapeHtml(String(value))}"`;
  }
  return out;
}

export function isVoidTag(tag: string): boolean {
  return VOID_TAGS.has(tag);
}

export function openTag(node: ElementNode): string {
  const attrs = renderAttrs(node.props);
  return isVoidTag(node.tag) ? `<${node.tag}${attrs}/>` : `<${node.tag}${attrs}>`;
}

export function closeTag(node: ElementNode): string {
  return isVoidTag(node.tag) ? '' : `</${node.tag}>`;
}
