/**
 * A minimal, defensive XML reader for untrusted source exports (Tally XML). It builds an element
 * tree and nothing else:
 *
 *   - no DTD at all: a `<!DOCTYPE` or `<!ENTITY` declaration is refused, so there is no entity
 *     expansion (no "billion laughs", no external entities) and nothing is ever fetched;
 *   - only the five predefined entities and numeric character references are decoded; any other
 *     `&name;` is an error, not a silent pass-through;
 *   - hard limits on input size, element count, nesting depth, attributes and text length;
 *   - processing instructions and comments are skipped, CDATA is text.
 *
 * It is not a validating or namespace-aware parser: element names are kept as written.
 */

export class XmlError extends Error {
  constructor(message: string, public offset: number) { super(`${message} (at character ${offset})`); }
}

export interface XmlElement { name: string; attrs: Record<string, string>; children: XmlElement[]; text: string }

export interface XmlLimits { maxChars: number; maxElements: number; maxDepth: number; maxAttrs: number; maxText: number }
export const XML_LIMITS: XmlLimits = { maxChars: 8 * 1024 * 1024, maxElements: 250_000, maxDepth: 64, maxAttrs: 32, maxText: 64 * 1024 };

const NAME = /^[A-Za-z_][A-Za-z0-9_.:\-]*$/;
const PREDEFINED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

/** Decode character and predefined entity references; refuse anything else. */
export function decodeEntities(s: string, at = 0): string {
  if (!s.includes("&")) return s;
  return s.replace(/&([^;&\s]{0,12});?/g, (whole, ref: string, off: number) => {
    if (!whole.endsWith(";")) throw new XmlError("unterminated entity reference", at + off);
    if (ref.startsWith("#")) {
      const hex = ref[1] === "x" || ref[1] === "X";
      const digits = ref.slice(hex ? 2 : 1);
      if (!(hex ? /^[0-9a-fA-F]{1,6}$/ : /^[0-9]{1,7}$/).test(digits)) throw new XmlError(`bad character reference &${ref};`, at + off);
      const cp = parseInt(digits, hex ? 16 : 10);
      if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) throw new XmlError(`bad character reference &${ref};`, at + off);
      // Tally writes control characters as references (&#4; for "not applicable"): they become nothing.
      if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) return "";
      return String.fromCodePoint(cp);
    }
    const v = PREDEFINED[ref];
    if (v === undefined) throw new XmlError(`entity &${ref}; is not allowed (only the predefined XML entities are)`, at + off);
    return v;
  });
}

/** Parse `text` into its root element. Throws XmlError on anything malformed or over a limit. */
export function parseXml(text: string, limits: XmlLimits = XML_LIMITS): XmlElement {
  if (text.length > limits.maxChars) throw new XmlError(`document is larger than ${limits.maxChars} characters`, 0);
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const n = text.length;
  const root: XmlElement = { name: "#document", attrs: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  let elements = 0;
  const top = () => stack[stack.length - 1]!;
  const addText = (raw: string, at: number) => {
    const t = top();
    if (t === root) { if (raw.trim()) throw new XmlError("text outside the root element", at); return; }
    const v = decodeEntities(raw, at);
    if (t.text.length + v.length > limits.maxText) throw new XmlError(`text of <${t.name}> is longer than ${limits.maxText} characters`, at);
    t.text += v;
  };
  while (i < n) {
    const lt = text.indexOf("<", i);
    if (lt < 0) { addText(text.slice(i), i); break; }
    if (lt > i) addText(text.slice(i, lt), i);
    i = lt;
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) throw new XmlError("unterminated comment", i);
      i = end + 3; continue;
    }
    if (text.startsWith("<![CDATA[", i)) {
      const end = text.indexOf("]]>", i + 9);
      if (end < 0) throw new XmlError("unterminated CDATA section", i);
      const t = top();
      if (t === root) throw new XmlError("CDATA outside the root element", i);
      if (t.text.length + (end - i - 9) > limits.maxText) throw new XmlError(`text of <${t.name}> is too long`, i);
      t.text += text.slice(i + 9, end);
      i = end + 3; continue;
    }
    if (text.startsWith("<!", i)) {
      // DOCTYPE, ENTITY, ELEMENT, ATTLIST: no DTDs, so no entity expansion of any kind.
      throw new XmlError("document type declarations are not accepted (no DTD, no entities)", i);
    }
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) throw new XmlError("unterminated processing instruction", i);
      i = end + 2; continue;
    }
    if (text.startsWith("</", i)) {
      const end = text.indexOf(">", i + 2);
      if (end < 0) throw new XmlError("unterminated end tag", i);
      const name = text.slice(i + 2, end).trim();
      const t = top();
      if (t === root || t.name !== name) throw new XmlError(`end tag </${name}> does not close <${t.name}>`, i);
      stack.pop();
      i = end + 1; continue;
    }
    // start tag: name, attributes, optional self-close
    let j = i + 1;
    while (j < n && !/[\s/>]/.test(text[j]!)) j++;
    const name = text.slice(i + 1, j);
    if (!NAME.test(name)) throw new XmlError(`bad element name ${JSON.stringify(name.slice(0, 40))}`, i);
    const attrs: Record<string, string> = {};
    let count = 0, selfClose = false;
    for (;;) {
      while (j < n && /\s/.test(text[j]!)) j++;
      if (j >= n) throw new XmlError(`unterminated start tag <${name}>`, i);
      if (text[j] === ">") { j++; break; }
      if (text[j] === "/" && text[j + 1] === ">") { selfClose = true; j += 2; break; }
      const eq = text.indexOf("=", j);
      if (eq < 0) throw new XmlError(`attribute without a value in <${name}>`, j);
      const an = text.slice(j, eq).trim();
      if (!NAME.test(an)) throw new XmlError(`bad attribute name in <${name}>`, j);
      let k = eq + 1;
      while (k < n && /\s/.test(text[k]!)) k++;
      const q = text[k];
      if (q !== '"' && q !== "'") throw new XmlError(`attribute ${an} of <${name}> is not quoted`, k);
      const close = text.indexOf(q, k + 1);
      if (close < 0) throw new XmlError(`unterminated attribute ${an} in <${name}>`, k);
      const raw = text.slice(k + 1, close);
      if (raw.includes("<")) throw new XmlError(`"<" in attribute ${an} of <${name}>`, k);
      if (++count > limits.maxAttrs) throw new XmlError(`<${name}> has more than ${limits.maxAttrs} attributes`, j);
      if (Object.prototype.hasOwnProperty.call(attrs, an)) throw new XmlError(`duplicate attribute ${an} in <${name}>`, j);
      attrs[an] = decodeEntities(raw, k + 1);
      j = close + 1;
    }
    if (++elements > limits.maxElements) throw new XmlError(`more than ${limits.maxElements} elements`, i);
    const t = top();
    if (t === root && root.children.length) throw new XmlError("more than one root element", i);
    const el: XmlElement = { name, attrs, children: [], text: "" };
    t.children.push(el);
    if (!selfClose) {
      stack.push(el);
      if (stack.length - 1 > limits.maxDepth) throw new XmlError(`nesting deeper than ${limits.maxDepth}`, i);
    }
    i = j;
  }
  if (stack.length > 1) throw new XmlError(`<${top().name}> is not closed`, n);
  const r = root.children[0];
  if (!r) throw new XmlError("no root element", 0);
  return r;
}

// ------------------------------------------------------------------ helpers for readers
/** Direct children named `name` (case-sensitive). */
export const kids = (e: XmlElement, name: string) => e.children.filter((c) => c.name === name);
/** Trimmed text of the first direct child named `name`, or "". */
export const childText = (e: XmlElement, name: string) => (e.children.find((c) => c.name === name)?.text ?? "").trim();
/** Every descendant named `name`, in document order (not descending into matches). */
export function findAll(e: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  for (const c of e.children) { if (c.name === name) out.push(c); else findAll(c, name, out); }
  return out;
}
