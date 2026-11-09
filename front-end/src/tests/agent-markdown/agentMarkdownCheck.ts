/**
 * Agent markdown structure check (C16).
 *
 * Given the markdown an agent wrote and the DOM a Rose surface rendered for it,
 * list every place a reader would see markdown syntax instead of structure:
 * a GFM table that is not a <table> with header cells inside a horizontal
 * scroll container, a fenced block that is not a <pre>, inline code that is
 * not a <code>, or literal table rules / backticks / ** in the visible text.
 *
 * Expectations come from the source text itself, so the check runs against any
 * reply (blackbox fixtures and finished benchmark runs alike). Used by
 * src/tests/blackbox/agent-markdown-rendering.blackbox.tsx and by the benchmark
 * CLI scripts/check-agent-markdown.tsx.
 */

export interface MarkdownExpectations {
  /** One entry per GFM table, in order: its column count (delimiter-row cells). */
  tables: number[];
  /** Fenced code blocks. */
  fences: number;
  /** Inline code spans outside fences. */
  inlineCode: number;
  /** **strong** spans outside fences and inline code. */
  strong: number;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const DELIMITER_ROW = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const INLINE_CODE = /`[^`\n]+`/g;
const STRONG = /\*\*[^*\n]+\*\*/g;
/** A GFM delimiter row (`|---|`, `| :--- |`) that leaked into visible text. */
const LEAKED_RULE = /\|\s*:?-{3,}/;

/** Markdown structures the source text declares (fences, tables, code, strong). */
export function expectedMarkdown(source: string): MarkdownExpectations {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const expectations: MarkdownExpectations = { tables: [], fences: 0, inlineCode: 0, strong: 0 };
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const marker = FENCE.exec(line)?.[1];
    if (fence !== null) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      expectations.fences += 1;
      continue;
    }
    const next = lines[i + 1];
    if (line.includes('|') && next !== undefined && DELIMITER_ROW.test(next)) {
      expectations.tables.push(
        next
          .replace(/^\s*\|/, '')
          .replace(/\|\s*$/, '')
          .split('|').length,
      );
    }
    const withoutCode = line.replace(INLINE_CODE, () => {
      expectations.inlineCode += 1;
      return '';
    });
    expectations.strong += withoutCode.match(STRONG)?.length ?? 0;
  }
  return expectations;
}

/** Visible text outside <pre>/<code> (where markdown syntax must never show). */
function proseText(root: ParentNode): string {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      parts.push(node.textContent ?? '');
      return;
    }
    const tag = (node as Element).tagName?.toLowerCase();
    if (tag === 'pre' || tag === 'code' || tag === 'style' || tag === 'script') return;
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  return parts.join('');
}

/**
 * Violations for one rendered reply. `root` is the element holding exactly that
 * reply's rendered markdown; an empty list means it renders as structure.
 */
export function agentMarkdownViolations(root: ParentNode, source: string): string[] {
  const expected = expectedMarkdown(source);
  const violations: string[] = [];
  const tables = Array.from(root.querySelectorAll('table'));
  expected.tables.forEach((columns, index) => {
    const table = tables[index];
    if (!table) {
      violations.push(`table ${index + 1}: no <table> rendered (${columns} columns expected)`);
      return;
    }
    const headers = table.querySelectorAll('thead th').length;
    if (headers !== columns) {
      violations.push(`table ${index + 1}: ${headers} header cells, expected ${columns}`);
    }
    if (table.querySelector('tbody tr td') === null) {
      violations.push(`table ${index + 1}: no body cells`);
    }
    const scroller = table.parentElement;
    if (!scroller?.hasAttribute('data-markdown-table-scroll')) {
      violations.push(`table ${index + 1}: not inside a horizontal scroll container`);
    }
  });
  const pres = root.querySelectorAll('pre').length;
  if (pres < expected.fences) {
    violations.push(`${pres} <pre> blocks for ${expected.fences} fenced code blocks`);
  }
  const inline = Array.from(root.querySelectorAll('code')).filter((c) => !c.closest('pre')).length;
  if (inline < expected.inlineCode) {
    violations.push(`${inline} inline <code> for ${expected.inlineCode} code spans`);
  }
  const strong = root.querySelectorAll('strong, b').length;
  if (strong < expected.strong) {
    violations.push(`${strong} <strong> for ${expected.strong} **bold** spans`);
  }
  const text = proseText(root);
  if (LEAKED_RULE.test(text)) violations.push('literal table rule (|---|) in visible text');
  if (text.includes('```')) violations.push('literal ``` fence in visible text');
  if (expected.inlineCode > 0 && text.includes('`')) {
    violations.push('literal backtick in visible text');
  }
  if (expected.strong > 0 && text.includes('**')) violations.push('literal ** in visible text');
  return violations;
}
