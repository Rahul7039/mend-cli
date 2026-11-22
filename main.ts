// main.ts is mend, the CLI SPEC.md specifies (MIT). It reads a patch in one of four formats (unified diff,
// SEARCH/REPLACE blocks, V4A, JSON edits), finds the lines each edit names at the first of three matching tiers,
// and writes every change or none, printing what it changed or why it failed. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to
// runner.ts (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves an edit completed, in the patch's order: [old path, new path]. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** A file as lines: its own line break, and whether its text ends with one (SPEC.md section 3). */
interface FileModel {
  lines: string[];
  br: '\n' | '\r\n';
  final: boolean;
}

function toModel(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const fin = text.endsWith(br);
  const parts = text.split(br);
  if (fin) parts.pop();
  return { lines: parts, br, final: fin };
}

function fromModel(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

/** A line of an edit's old side or new side; ctx lines are on both (SPEC.md section 5). */
interface SideLine {
  ctx: boolean;
  text: string;
}

const trailWs = (s: string): string => s.replace(/[ \t]+$/, '');
const bothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

function lineEq(tier: number, a: string, b: string): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trailWs(a) === trailWs(b);
  return bothWs(a) === bothWs(b);
}

/** Every 0-based position at which o's lines match lines at the given tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  outer: for (let i = 0; i + o.length <= lines.length; i += 1) {
    for (let j = 0; j < o.length; j += 1) {
      if (!lineEq(tier, lines[i + j]!, o[j]!)) continue outer;
    }
    out.push(i);
  }
  return out;
}

function tiersToTry(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/**
 * The lines that replace lines[pos .. pos + o.length): a context line is written as the file's own matched line,
 * and at tier 2 every other new line is re-indented from the patch's first-line indent to the file's.
 */
function replacement(lines: string[], pos: number, o: SideLine[], n: SideLine[], tier: number): string[] {
  const ctxAt: number[] = [];
  o.forEach((it, idx) => {
    if (it.ctx) ctxAt.push(idx);
  });
  let seen = 0;
  let fileIndent = '';
  let patchIndent = '';
  if (tier === 2) {
    fileIndent = /^[ \t]*/.exec(lines[pos] ?? '')![0];
    patchIndent = /^[ \t]*/.exec(o[0]?.text ?? '')![0];
  }
  return n.map((it) => {
    if (it.ctx) {
      const oi = ctxAt[seen]!;
      seen += 1;
      return lines[pos + oi]!;
    }
    if (tier === 2 && it.text.trim() !== '' && it.text.startsWith(patchIndent)) {
      return fileIndent + it.text.slice(patchIndent.length);
    }
    return it.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const model = toModel(before);
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, fromModel(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A line of a hunk or chunk body; rawEmpty marks a line that was empty in the patch (a context line). */
interface BodyLine {
  kind: 'ctx' | 'old' | 'new' | 'bs';
  text: string;
  rawEmpty: boolean;
}

interface Hunk {
  a: number;
  body: BodyLine[];
}

interface Section {
  gitOld?: string;
  gitNew?: string;
  minus?: string;
  plus?: string;
  renameFrom?: string;
  renameTo?: string;
  newFile: boolean;
  delFile: boolean;
  hunks: Hunk[];
}

/** The path a `--- ` or `+++ ` line names: after the four characters, up to a tab, spaces removed, a/ b/ removed. */
function headerPath(line: string): string {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

/** Whether the body line at index k is followed, in its body, by a `\` line, counting from the last line of a kind. */
function backslashAfter(body: BodyLine[], kinds: ('ctx' | 'new')[]): boolean {
  for (let k = body.length - 1; k >= 0; k -= 1) {
    if (kinds.includes(body[k]!.kind as 'ctx' | 'new')) return body[k + 1]?.kind === 'bs';
  }
  return false;
}

/** Apply one section's hunks, in order, to a file model; a hunk that finds nothing fails the whole edit. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const o: SideLine[] = [];
    const n: SideLine[] = [];
    for (const b of h.body) {
      if (b.kind === 'ctx') {
        o.push({ ctx: true, text: b.text });
        n.push({ ctx: true, text: b.text });
      } else if (b.kind === 'old') o.push({ ctx: false, text: b.text });
      else if (b.kind === 'new') n.push({ ctx: false, text: b.text });
    }
    if (o.length === 0) {
      if (n.length === 0) continue;
      const at = Math.max(0, Math.min(h.a + d, model.lines.length));
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...n.map((x) => x.text));
      if (atEnd) model.final = !backslashAfter(h.body, ['new']);
      d += n.length;
      continue;
    }
    const oTexts = o.map((x) => x.text);
    let placed: { tier: number; pos: number } | null = null;
    for (const tier of tiersToTry(strict)) {
      const occ = occurrences(model.lines, oTexts, tier);
      if (occ.length === 0) continue;
      const target = h.a - 1 + d;
      let best = occ[0]!;
      for (const p of occ) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      placed = { tier, pos: best };
      break;
    }
    if (placed === null) throw new Fail('no-match', path);
    const repl = replacement(model.lines, placed.pos, o, n, placed.tier);
    const runsToEnd = placed.pos + o.length === model.lines.length;
    model.lines.splice(placed.pos, o.length, ...repl);
    if (runsToEnd) model.final = !backslashAfter(h.body, ['ctx', 'new']);
    d += n.length - o.length;
  }
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const oldPath = s.minus ?? s.renameFrom ?? s.gitOld;
  const newPath = s.plus ?? s.renameTo ?? s.gitNew;
  const isCreate = s.minus === '/dev/null' || s.newFile;
  const isDelete = s.plus === '/dev/null' || s.delFile;
  return (tree) => {
    for (const p of [oldPath, newPath]) {
      if (p !== undefined && p !== '/dev/null' && !safe(p)) throw new Fail('unsafe', p);
    }
    if (isCreate) {
      const target = newPath!;
      if (tree.get(target) !== null) throw new Fail('exists', target);
      const texts: string[] = [];
      let lastNewBody: BodyLine[] | null = null;
      for (const h of s.hunks) {
        let has = false;
        for (const b of h.body) {
          if (b.kind === 'new') {
            texts.push(b.text);
            has = true;
          }
        }
        if (has) lastNewBody = h.body;
      }
      const fin = texts.length > 0 && !(lastNewBody !== null && backslashAfter(lastNewBody, ['new']));
      tree.now.set(target, fromModel({ lines: texts, br: '\n', final: fin }));
      return;
    }
    if (isDelete) {
      const target = oldPath!;
      if (tree.get(target) === null) throw new Fail('missing', target);
      tree.now.set(target, null);
      return;
    }
    if (oldPath !== newPath) {
      const from = oldPath!;
      const to = newPath!;
      const before = tree.get(from);
      if (before === null) throw new Fail('missing', from);
      if (tree.get(to) !== null) throw new Fail('exists', to);
      const model = toModel(before);
      applyHunks(model, s.hunks, strict, from);
      tree.now.set(to, fromModel(model));
      tree.now.set(from, null);
      tree.moves.push([from, to]);
      return;
    }
    const target = oldPath!;
    const before = tree.get(target);
    if (before === null) throw new Fail('missing', target);
    const model = toModel(before);
    applyHunks(model, s.hunks, strict, target);
    tree.now.set(target, fromModel(model));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHeader = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, delFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && cur.minus === undefined) {
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
      } else {
        cur = { newFile: false, delFile: false, hunks: [], minus: headerPath(line), plus: headerPath(lines[i + 1]!) };
        sections.push(cur);
        inHeader = true;
      }
      i += 2;
      continue;
    }
    if (cur !== null && inHeader && line.startsWith('--- ')) {
      throw new Exit2(`error: parse ${i + 2}`);
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const body: BodyLine[] = [];
      i += 1;
      while (i < lines.length) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        const c0 = bl[0];
        if (bl === '') body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (c0 === ' ') body.push({ kind: 'ctx', text: bl.slice(1), rawEmpty: false });
        else if (c0 === '-') body.push({ kind: 'old', text: bl.slice(1), rawEmpty: false });
        else if (c0 === '+') body.push({ kind: 'new', text: bl.slice(1), rawEmpty: false });
        else if (c0 === '\\') body.push({ kind: 'bs', text: '', rawEmpty: false });
        else break;
        i += 1;
      }
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
      cur.hunks.push({ a: Number.parseInt(m[1]!, 10), body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('+++ ')) cur.plus = headerPath(line);
      else if (line.startsWith('rename from ')) cur.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
    }
    i += 1;
  }
  return sections.map((s) => unifiedEdit(s, strict));
}

interface SRBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function srEdit(b: SRBlock, strict: boolean): Edit {
  return (tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, fromModel({ lines: [...b.newLines], br: '\n', final: b.newLines.length > 0 }));
      return;
    }
    const before = tree.get(b.path);
    if (before === null) throw new Fail('missing', b.path);
    const model = toModel(before);
    for (const tier of tiersToTry(strict)) {
      const occ = occurrences(model.lines, b.oldLines, tier);
      if (occ.length === 0) continue;
      if (occ.length > 1) throw new Fail('ambiguous', b.path);
      const pos = occ[0]!;
      const o: SideLine[] = b.oldLines.map((text) => ({ ctx: false, text }));
      const n: SideLine[] = b.newLines.map((text) => ({ ctx: false, text }));
      const repl = replacement(model.lines, pos, o, n, tier);
      model.lines.splice(pos, b.oldLines.length, ...repl);
      tree.now.set(b.path, fromModel(model));
      return;
    }
    throw new Fail('no-match', b.path);
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const blocks: SRBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const s = i;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  return blocks.map((b) => srEdit(b, strict));
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

type VSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: VChunk[] };

function v4aEdit(s: VSection, strict: boolean): Edit {
  return (tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      tree.now.set(s.path, fromModel({ lines: [...s.lines], br: '\n', final: s.lines.length > 0 }));
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    if (s.moveTo !== null && !safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo !== null && tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    const model = toModel(before);
    let cursor = 0;
    for (const chunk of s.chunks) {
      if (chunk.anchor !== null) {
        let at = -1;
        for (const tier of tiersToTry(strict)) {
          const occ = occurrences(model.lines, [chunk.anchor], tier).filter((p) => p >= cursor);
          if (occ.length > 0) {
            at = occ[0]!;
            break;
          }
        }
        if (at < 0) throw new Fail('no-match', s.path);
        cursor = at + 1;
      }
      const o: SideLine[] = [];
      const n: SideLine[] = [];
      for (const b of chunk.body) {
        if (b.kind === 'ctx') {
          o.push({ ctx: true, text: b.text });
          n.push({ ctx: true, text: b.text });
        } else if (b.kind === 'old') o.push({ ctx: false, text: b.text });
        else if (b.kind === 'new') n.push({ ctx: false, text: b.text });
      }
      if (o.length === 0) {
        const at = chunk.eof ? model.lines.length : Math.min(cursor, model.lines.length);
        model.lines.splice(at, 0, ...n.map((x) => x.text));
        cursor = at + n.length;
        continue;
      }
      const oTexts = o.map((x) => x.text);
      let placed: { tier: number; pos: number } | null = null;
      for (const tier of tiersToTry(strict)) {
        const occ = occurrences(model.lines, oTexts, tier).filter(
          (p) => p >= cursor && (!chunk.eof || p + oTexts.length === model.lines.length),
        );
        if (occ.length > 0) {
          placed = { tier, pos: occ[0]! };
          break;
        }
      }
      if (placed === null) throw new Fail('no-match', s.path);
      const repl = replacement(model.lines, placed.pos, o, n, placed.tier);
      model.lines.splice(placed.pos, o.length, ...repl);
      cursor = placed.pos + repl.length;
    }
    if (s.moveTo !== null) {
      tree.now.set(s.moveTo, fromModel(model));
      tree.now.set(s.path, null);
      tree.moves.push([s.path, s.moveTo]);
    } else {
      tree.now.set(s.path, fromModel(model));
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const secStart = (line: string): 'add' | 'delete' | 'update' | null =>
    line.startsWith('*** Add File:')
      ? 'add'
      : line.startsWith('*** Delete File:')
        ? 'delete'
        : line.startsWith('*** Update File:')
          ? 'update'
          : null;
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = secStart(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    if (kind === 'add') {
      const path = line.slice('*** Add File:'.length).trim();
      const content: string[] = [];
      i += 1;
      while (i < last && (lines[i]!.startsWith('+') || lines[i] === '')) {
        content.push(lines[i]!.startsWith('+') ? lines[i]!.slice(1) : '');
        i += 1;
      }
      while (content.length > 0 && content[content.length - 1] === '') content.pop();
      sections.push({ kind, path, lines: content });
      continue;
    }
    if (kind === 'delete') {
      sections.push({ kind, path: line.slice('*** Delete File:'.length).trim() });
      i += 1;
      continue;
    }
    const path = line.slice('*** Update File:'.length).trim();
    const secLine = i + 1;
    i += 1;
    let moveTo: string | null = null;
    if (i < last && lines[i]!.startsWith('*** Move to:')) {
      moveTo = lines[i]!.slice('*** Move to:'.length).trim();
      i += 1;
    }
    const chunks: VChunk[] = [];
    let cur: VChunk | null = null;
    while (i < last) {
      const bl = lines[i]!;
      if (secStart(bl) !== null) break;
      if (bl.startsWith('@@')) {
        const at = bl.slice(2).trim();
        cur = { anchor: at === '' ? null : at, eof: false, body: [] };
        chunks.push(cur);
        i += 1;
        continue;
      }
      if (bl === '*** End of File') {
        if (cur === null) {
          cur = { anchor: null, eof: true, body: [] };
          chunks.push(cur);
        } else cur.eof = true;
        cur = null;
        i += 1;
        continue;
      }
      const c0 = bl[0];
      if (bl === '' || c0 === ' ' || c0 === '-' || c0 === '+') {
        if (cur === null) {
          cur = { anchor: null, eof: false, body: [] };
          chunks.push(cur);
        }
        if (bl === '') cur.body.push({ kind: 'ctx', text: '', rawEmpty: true });
        else if (c0 === ' ') cur.body.push({ kind: 'ctx', text: bl.slice(1), rawEmpty: bl.trim() === '' });
        else if (c0 === '-') cur.body.push({ kind: 'old', text: bl.slice(1), rawEmpty: false });
        else cur.body.push({ kind: 'new', text: bl.slice(1), rawEmpty: false });
        i += 1;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    if (chunks.length > 0) {
      const body = chunks[chunks.length - 1]!.body;
      while (body.length > 0 && body[body.length - 1]!.rawEmpty) body.pop();
    }
    if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
    sections.push({ kind, path, moveTo, chunks });
  }
  return sections.map((s) => v4aEdit(s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'search-replace') edits = srEdits(lines, strict);
    else edits = v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const [o, n] of tree.moves) {
    const wasO = tree.original(o);
    const nowO = tree.now.has(o) ? tree.now.get(o)! : wasO;
    const wasN = tree.original(n);
    const nowN = tree.now.has(n) ? tree.now.get(n)! : wasN;
    if (wasO !== null && nowO === null && wasN === null && nowN !== null && !movedFrom.has(o) && !movedTo.has(n)) {
      rows.push({ key: n, line: `R ${o} -> ${n}` });
      movedFrom.add(o);
      movedTo.add(n);
    }
  }
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (!movedFrom.has(p) && !movedTo.has(p)) {
      rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    }
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
