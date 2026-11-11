#!/usr/bin/env node
// HiCulture nightly feed refresher.
//
// Fetches every source in feeds.json, parses RSS/Atom, maps items to the
// HiCulture ContentItem shape (a port of the iOS app's RSSService.swift,
// FeedStore.swift, ContentDeduplicator.swift and SourceQuality.swift), and
// writes docs/feed.json (compact) plus docs/status.json (pretty) for GitHub
// Pages. Node 20+, no npm dependencies.
//
// Usage (from the feed-refresh folder):  node scripts/refresh.mjs

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FEEDS_PATH = path.join(ROOT, "feeds.json");
const DOCS_DIR = path.join(ROOT, "docs");
const FEED_OUT = path.join(DOCS_DIR, "feed.json");
const STATUS_OUT = path.join(DOCS_DIR, "status.json");

const CONCURRENCY = 8;
const TIMEOUT_MS = 20_000;
const MAX_BYTES = 3 * 1024 * 1024;
const ITEMS_PER_FEED = 30;
const MAX_AGE_DAYS = 120;
const MAX_OUTPUT_BYTES = 3.9 * 1024 * 1024;
const USER_AGENT = "HiCulture/1.0 (iOS)";
const ACCEPT = "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";
const LOW_TRUST_HOST_SUFFIXES = ["wikipedia.org", "biography.com", "openlibrary.org"];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

// XML's five plus the HTML entities feeds commonly (and invalidly) use in XML.
const NAMED_ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  nbsp: " ", ensp: " ", emsp: " ", thinsp: " ", zwnj: "‌", zwj: "‍",
  ndash: "–", mdash: "—", minus: "−", hellip: "…", bull: "•", middot: "·",
  lsquo: "‘", rsquo: "’", sbquo: "‚", ldquo: "“", rdquo: "”", bdquo: "„",
  laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", prime: "′", Prime: "″",
  copy: "©", reg: "®", trade: "™", deg: "°", plusmn: "±", times: "×",
  divide: "÷", frac12: "½", frac14: "¼", frac34: "¾", sup1: "¹", sup2: "²",
  sup3: "³", micro: "µ", para: "¶", sect: "§", cent: "¢", pound: "£",
  euro: "€", yen: "¥", curren: "¤", iexcl: "¡", iquest: "¿", shy: "­",
  dagger: "†", Dagger: "‡", permil: "‰", larr: "←", rarr: "→", uarr: "↑",
  darr: "↓", harr: "↔", hearts: "♥", ordf: "ª", ordm: "º", macr: "¯",
  acute: "´", cedil: "¸", uml: "¨", not: "¬", brvbar: "¦",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", lambda: "λ",
  mu: "μ", pi: "π", sigma: "σ", omega: "ω", Delta: "Δ", Omega: "Ω",
  Agrave: "À", Aacute: "Á", Acirc: "Â", Atilde: "Ã", Auml: "Ä", Aring: "Å",
  AElig: "Æ", Ccedil: "Ç", Egrave: "È", Eacute: "É", Ecirc: "Ê", Euml: "Ë",
  Igrave: "Ì", Iacute: "Í", Icirc: "Î", Iuml: "Ï", ETH: "Ð", Ntilde: "Ñ",
  Ograve: "Ò", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Ouml: "Ö", Oslash: "Ø",
  Ugrave: "Ù", Uacute: "Ú", Ucirc: "Û", Uuml: "Ü", Yacute: "Ý", THORN: "Þ",
  szlig: "ß", agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä",
  aring: "å", aelig: "æ", ccedil: "ç", egrave: "è", eacute: "é", ecirc: "ê",
  euml: "ë", igrave: "ì", iacute: "í", icirc: "î", iuml: "ï", eth: "ð",
  ntilde: "ñ", ograve: "ò", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö",
  oslash: "ø", ugrave: "ù", uacute: "ú", ucirc: "û", uuml: "ü", yacute: "ý",
  thorn: "þ", yuml: "ÿ", OElig: "Œ", oelig: "œ", Scaron: "Š", scaron: "š",
  Yuml: "Ÿ", Zcaron: "Ž", zcaron: "ž", fnof: "ƒ", circ: "ˆ", tilde: "˜",
};

function codePointToString(cp) {
  if (!Number.isFinite(cp) || cp <= 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
  // Windows-1252 code points mis-encoded as numeric references (e.g. &#146;).
  if (cp >= 0x80 && cp <= 0x9f) {
    const cp1252 = {
      0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
      0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
      0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
      0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
    };
    if (cp1252[cp]) cp = cp1252[cp];
  }
  return String.fromCodePoint(cp);
}

/** Decodes numeric (&#123; &#x1F;) and known named entities; unknown ones stay as written. */
function decodeEntities(text) {
  if (text.indexOf("&") === -1) return text;
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, body) => {
    if (body[0] === "#") {
      const cp = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return codePointToString(cp);
    }
    const named = NAMED_ENTITIES[body];
    return named !== undefined ? named : whole;
  });
}

// ---------------------------------------------------------------------------
// Tolerant streaming XML tokenizer
// ---------------------------------------------------------------------------
//
// A hand-written scanner (not regex soup): walks the document once, emitting
// start / text / cdata / end events. It tolerates the things real feeds do:
// CDATA sections, comments, processing instructions, DOCTYPE with internal
// subsets, undeclared HTML entities, unquoted attributes, mismatched or
// stray end tags (closed against the open-element stack), and truncation.

const NAME_END = /[\s/>]/;

function parseAttributes(src) {
  const attrs = {};
  let i = 0;
  const n = src.length;
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (i >= n) break;
    let start = i;
    while (i < n && !/[\s=]/.test(src[i])) i++;
    const name = src.slice(start, i);
    while (i < n && /\s/.test(src[i])) i++;
    let value = "";
    if (src[i] === "=") {
      i++;
      while (i < n && /\s/.test(src[i])) i++;
      const q = src[i];
      if (q === '"' || q === "'") {
        const close = src.indexOf(q, i + 1);
        const end = close === -1 ? n : close;
        value = src.slice(i + 1, end);
        i = end + 1;
      } else {
        start = i;
        while (i < n && !/\s/.test(src[i])) i++;
        value = src.slice(start, i);
      }
    }
    if (name && name !== "/") attrs[name] = decodeEntities(value);
  }
  return attrs;
}

/** Finds the '>' that ends a tag starting at `from`, skipping quoted attribute values. */
function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i++) {
    const c = xml[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === ">") {
      return i;
    } else if (c === "<" && i > from) {
      // A '<' before any '>' outside quotes means a broken tag; stop here.
      return -1;
    }
  }
  return -1;
}

function tokenizeXML(xml, handler) {
  const stack = [];
  let i = 0;
  const n = xml.length;
  if (xml.charCodeAt(0) === 0xfeff) i = 1;

  while (i < n) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      handler.text(decodeEntities(xml.slice(i)));
      break;
    }
    if (lt > i) handler.text(decodeEntities(xml.slice(i, lt)));

    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      const stop = end === -1 ? n : end;
      handler.text(xml.slice(lt + 9, stop)); // CDATA is literal: no entity decoding
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      i = end === -1 ? n : end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      // DOCTYPE / other declarations, possibly with an internal subset [...]
      let depth = 0;
      let j = lt + 2;
      for (; j < n; j++) {
        const c = xml[j];
        if (c === "[") depth++;
        else if (c === "]") depth--;
        else if (c === ">" && depth <= 0) break;
      }
      i = j + 1;
      continue;
    }
    if (xml[lt + 1] === "/") {
      const gt = xml.indexOf(">", lt + 2);
      const end = gt === -1 ? n : gt;
      const name = xml.slice(lt + 2, end).trim().toLowerCase();
      i = gt === -1 ? n : gt + 1;
      // Close against the open-element stack; ignore stray end tags.
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        while (stack.length > idx) handler.end(stack.pop());
      }
      continue;
    }
    // Start tag
    const next = xml[lt + 1];
    if (next === undefined || /[\s<>=]/.test(next)) {
      // A bare '<' in text (invalid XML, but it happens): treat it as text.
      handler.text("<");
      i = lt + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    if (gt === -1) {
      handler.text("<");
      i = lt + 1;
      continue;
    }
    let inner = xml.slice(lt + 1, gt);
    let selfClosing = false;
    if (inner.endsWith("/")) {
      selfClosing = true;
      inner = inner.slice(0, -1);
    }
    let k = 0;
    while (k < inner.length && !NAME_END.test(inner[k])) k++;
    const name = inner.slice(0, k).toLowerCase();
    const attrs = parseAttributes(inner.slice(k));
    handler.start(name, attrs);
    if (selfClosing) handler.end(name);
    else stack.push(name);
    i = gt + 1;
  }
  while (stack.length) handler.end(stack.pop());
}

// ---------------------------------------------------------------------------
// RSS / Atom parser (port of RSSParser in RSSService.swift)
// ---------------------------------------------------------------------------

function newBuilder() {
  return {
    title: "", link: "", linkPriority: 0, summaryPieces: [], contentPieces: [],
    published: "", guid: "", categories: [],
  };
}

function considerLink(b, candidate, rel) {
  const trimmed = (candidate || "").trim();
  if (!trimmed) return;
  const r = rel == null ? "" : String(rel).trim().toLowerCase();
  const priority = r === "alternate" ? 2 : r === "" ? 1 : 0;
  if (!(b.link === "" || priority > b.linkPriority)) return;
  b.link = trimmed;
  b.linkPriority = priority;
}

export function parseFeed(xml) {
  const items = [];
  const frames = []; // { name, text }
  let builder = null;

  tokenizeXML(xml, {
    start(name, attrs) {
      frames.push({ name, text: "" });
      if (name === "item" || name === "entry") {
        builder = newBuilder();
        return;
      }
      if (name === "link" && builder && attrs.href !== undefined) {
        considerLink(builder, attrs.href, attrs.rel);
      }
    },
    text(t) {
      if (frames.length) frames[frames.length - 1].text += t;
    },
    end(name) {
      const frame = frames.pop();
      if (frames.length && frame) frames[frames.length - 1].text += frame.text;
      const text = (frame ? frame.text : "").trim();
      if (!builder) return;
      switch (name) {
        case "title":
          if (text) builder.title = text;
          break;
        case "link":
          if (text) considerLink(builder, text, null);
          break;
        case "description":
        case "summary":
          if (text) builder.summaryPieces.push(text);
          break;
        case "content:encoded":
        case "content":
          if (text) builder.contentPieces.push(text);
          break;
        case "pubdate":
        case "published":
        case "dc:date":
        case "prism:publicationdate":
        case "prism:coverdate":
          if (text) builder.published = text;
          break;
        case "updated":
        case "dc:modified":
          // Prefer an explicit publication date; fall back to the update time.
          if (text && !builder.published) builder.published = text;
          break;
        case "guid":
        case "id":
          if (text) builder.guid = text;
          break;
        case "category":
          if (text) builder.categories.push(text);
          break;
        case "item":
        case "entry": {
          const content = builder.contentPieces.join(" ");
          const summary = content || builder.summaryPieces.join(" ");
          const guid = builder.guid || builder.link;
          if (builder.title && builder.link) {
            items.push({
              title: builder.title,
              link: builder.link,
              summary,
              publishedAt: parseDate(builder.published),
              guid,
              categories: builder.categories,
            });
          }
          builder = null;
          break;
        }
        default:
          break;
      }
    },
  });
  return items;
}

// ---------------------------------------------------------------------------
// Dates (port of RSSDateParser)
// ---------------------------------------------------------------------------

const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
  january: 0, february: 1, march: 2, april: 3, june: 5, july: 6, august: 7, september: 8,
  october: 9, november: 10, december: 11,
};

const ZONES = {
  z: 0, ut: 0, utc: 0, gmt: 0, wet: 0, west: 60, bst: 60, cet: 60, cest: 120, eet: 120, eest: 180,
  est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420,
  akst: -540, akdt: -480, hst: -600, ist: 330, jst: 540, kst: 540, aest: 600, aedt: 660,
  acst: 570, acdt: 630, awst: 480, nzst: 720, nzdt: 780,
};

/** Returns the offset in minutes, or null if unrecognized. Undefined/empty -> 0 (UTC). */
function zoneOffset(zone) {
  if (!zone) return 0;
  const z = zone.trim();
  const m = /^(?:GMT|UTC|UT)?([+-])(\d{1,2}):?(\d{2})?$/i.exec(z);
  if (m) {
    const sign = m[1] === "-" ? -1 : 1;
    return sign * (parseInt(m[2], 10) * 60 + parseInt(m[3] || "0", 10));
  }
  const named = ZONES[z.toLowerCase()];
  return named === undefined ? null : named;
}

function utcDate(y, mo, d, h = 0, mi = 0, s = 0, ms = 0, offsetMinutes = 0) {
  if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 24 || mi > 59 || s > 60) return null;
  const t = Date.UTC(y, mo, d, h, mi, s, ms) - offsetMinutes * 60_000;
  const date = new Date(t);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Offset (minutes) of America/New_York at the given UTC instant. */
function easternOffsetAt(utcMillis) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hourCycle: "h23",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMillis));
  const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUTC - utcMillis) / 60_000);
}

function easternDate(y, mo, d, h, mi) {
  const guess = Date.UTC(y, mo, d, h, mi);
  let offset = easternOffsetAt(guess - 5 * 3_600_000);
  offset = easternOffsetAt(guess - offset * 60_000);
  return new Date(guess - offset * 60_000);
}

function twoDigitYear(y) {
  // Matches Foundation's default two-digit-year window closely enough for feeds.
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

export function parseDate(value) {
  const s = (value || "").trim().replace(/\s+/g, " ");
  if (!s) return null;
  let m;

  // ISO 8601 / RFC 3339 (with or without fractional seconds, offset, or time).
  m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2})?|[A-Za-z]{1,5})?)?$/.exec(s);
  if (m) {
    const off = zoneOffset(m[8]);
    if (off === null) return null;
    const ms = m[7] ? Math.round(parseFloat("0." + m[7]) * 1000) : 0;
    return utcDate(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), ms, off);
  }

  // RFC 822 / 2822: "[EEE, ]d MMM yy[yy] HH:mm[:ss] [zone]"
  m = /^(?:[A-Za-z]{2,9},? )?(\d{1,2})[ -]([A-Za-z]{3,9})\.?[ -](\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?: ?([A-Za-z]{1,5}|(?:GMT|UTC)?[+-]\d{1,2}:?\d{2}))?$/.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    const off = zoneOffset(m[7]);
    if (mo === undefined || off === null) return null;
    return utcDate(twoDigitYear(+m[3]), mo, +m[1], +m[4], +m[5], +(m[6] || 0), 0, off);
  }

  // Drupal (nih.gov etc.): "Wed, 10/14/2026 - 11:00", U.S. Eastern time.
  m = /^(?:[A-Za-z]{2,9},? )?(\d{1,2})\/(\d{1,2})\/(\d{4}) - (\d{1,2}):(\d{2})$/.exec(s);
  if (m) {
    const mo = +m[1] - 1, d = +m[2], h = +m[4], mi = +m[5];
    if (mo < 0 || mo > 11 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
    return easternDate(+m[3], mo, d, h, mi);
  }

  // "MM/dd/yyyy"
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return utcDate(+m[3], +m[1] - 1, +m[2]);

  // "MMMM d, yyyy" / "MMM d, yyyy"
  m = /^([A-Za-z]{3,9})\.? (\d{1,2}), (\d{4})$/.exec(s);
  if (m) {
    const mo = MONTHS[m[1].toLowerCase()];
    if (mo === undefined) return null;
    return utcDate(+m[3], mo, +m[2]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text helpers (ports of HTMLStripper, ExtractiveSummarizer, ReadTimeEstimator)
// ---------------------------------------------------------------------------

export function stripHTML(text) {
  const withoutTags = String(text || "").replace(/<[^>]+>/g, " ");
  // The iOS stripper decodes &nbsp; &amp; &quot; &apos;; we decode all numeric
  // and common named entities so the web page never shows "&#8217;".
  return decodeEntities(withoutTags).replace(/\s+/g, " ").trim();
}

export function summarize(text, maxSentences = 2, maxLength = 220) {
  const clean = stripHTML(text);
  if (!clean) return "";
  const sentences = clean
    .replace(/!/g, ".")
    .replace(/\?/g, ".")
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const summary = sentences.slice(0, maxSentences).join(". ");
  const chars = Array.from(summary);
  const capped = chars.length > maxLength ? chars.slice(0, maxLength).join("") : summary;
  return capped.endsWith(".") ? capped : capped + ".";
}

export function estimateReadTime(text) {
  const words = stripHTML(text).split(/[ \n]/).filter((w) => w.length > 0);
  return `${Math.max(1, Math.round(words.length / 200))} min`;
}

// ---------------------------------------------------------------------------
// URL helpers, quality, dedupe (ports of SourceQuality / ContentDeduplicator)
// ---------------------------------------------------------------------------

function normalizedHost(urlString) {
  try {
    const host = new URL(urlString).hostname.toLowerCase();
    return host.startsWith("www.") ? host.slice(4) : host;
  } catch {
    return "";
  }
}

function matchesAnyHost(host, suffixes) {
  if (!host) return false;
  return suffixes.some((s) => host === s || host.endsWith("." + s));
}

function isLowTrust(url) {
  return matchesAnyHost(normalizedHost(url), LOW_TRUST_HOST_SUFFIXES);
}

function normalizedURLKey(urlString) {
  try {
    const u = new URL(urlString);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return urlString;
  }
}

const STOP_WORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "into", "over", "under", "about",
  "after", "before", "their", "there", "which", "while", "where", "what", "when", "your",
  "yours", "they", "them", "then", "than", "been", "were", "was", "are", "but", "not",
  "you", "his", "her", "its", "our", "out", "how", "why", "new", "all", "who", "too",
  "can", "will", "may", "more", "most", "some", "such", "via", "case",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/[ \n\t]/)
    .filter((t) => t.length > 2 && !STOP_WORDS.has(t));
}

function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  return union > 0 ? inter / union : 0;
}

function compareDatesDesc(a, b) {
  // Dated items first (newest first), undated last.
  if (a && b) return a < b ? 1 : a > b ? -1 : 0;
  if (a && !b) return -1;
  if (!a && b) return 1;
  return 0;
}

/** Port of ContentDeduplicator.deduplicate: quality, then recency, then URL + near-duplicate text. */
function deduplicate(items, qualityBySourceName, similarityThreshold = 0.68) {
  const quality = (item) => {
    const known = qualityBySourceName.get(item.source);
    if (known !== undefined) return Math.min(Math.max(known, 0.85), 1.25);
    const host = normalizedHost(item.url);
    if (matchesAnyHost(host, LOW_TRUST_HOST_SUFFIXES)) return 0.9;
    if (host.endsWith(".edu") || host.endsWith(".gov")) return 1.2;
    return 0.95;
  };
  const sorted = items
    .map((item) => ({ item, q: quality(item) }))
    .sort((l, r) => {
      if (Math.abs(l.q - r.q) > 0.001) return r.q - l.q;
      const byDate = compareDatesDesc(l.item.publishedAt, r.item.publishedAt);
      if (byDate !== 0) return byDate;
      if (!l.item.publishedAt && !r.item.publishedAt) {
        return l.item.title < r.item.title ? -1 : l.item.title > r.item.title ? 1 : 0;
      }
      return 0;
    })
    .map((x) => x.item);

  const buckets = new Map();
  const seenURLs = new Set();
  const output = [];
  let duplicates = 0;
  for (const item of sorted) {
    const urlKey = normalizedURLKey(item.url);
    if (urlKey && seenURLs.has(urlKey)) {
      duplicates++;
      continue;
    }
    const tokens = tokenize(`${item.title} ${item.summary}`);
    if (tokens.length) {
      const key = tokens.slice(0, 4).join("-");
      const tokenSet = new Set(tokens);
      const clusters = buckets.get(key) || [];
      if (clusters.some((c) => jaccard(c, tokenSet) >= similarityThreshold)) {
        duplicates++;
        continue;
      }
      clusters.push(tokenSet);
      buckets.set(key, clusters);
    }
    output.push(item);
    if (urlKey) seenURLs.add(urlKey);
  }
  return { items: output, duplicates };
}

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

function charsetFrom(contentType, bytes) {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 512));
  const decl = /<\?xml[^>]*encoding\s*=\s*["']([A-Za-z0-9._-]+)["']/i.exec(head);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  if (decl) return decl[1].toLowerCase();
  const ct = /charset\s*=\s*["']?([A-Za-z0-9._-]+)/i.exec(contentType || "");
  return ct ? ct[1].toLowerCase() : "utf-8";
}

function decodeBody(bytes, contentType) {
  const label = charsetFrom(contentType, bytes);
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export class FetchError extends Error {
  constructor(message, retryable = false, status = 0, body = "") {
    super(message);
    this.retryable = retryable;
    this.status = status;
    this.body = body;
  }
}

const FEED_HEADERS = { "User-Agent": USER_AGENT, Accept: ACCEPT };

async function fetchOnce(url, headers = FEED_HEADERS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(url, {
        headers,
        redirect: "follow",
        signal: controller.signal,
      });
    } catch (err) {
      if (controller.signal.aborted) throw new FetchError(`timeout after ${TIMEOUT_MS / 1000}s`);
      const cause = err && err.cause ? err.cause.code || err.cause.message : "";
      throw new FetchError(`network error${cause ? ` (${cause})` : ""}`, true);
    }
    if (res.status < 200 || res.status >= 300) {
      // Keep a little of the error body so callers can recognize bot-challenge pages.
      const snippet = await res.text().then((t) => t.slice(0, 4000)).catch(() => "");
      throw new FetchError(`HTTP ${res.status}`, res.status === 429 || res.status >= 500, res.status, snippet);
    }
    const declared = parseInt(res.headers.get("content-length") || "0", 10);
    if (declared > MAX_BYTES) {
      res.body?.cancel().catch(() => {});
      throw new FetchError(`response too large (${declared} bytes)`);
    }
    const chunks = [];
    let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        let chunk;
        try {
          chunk = await reader.read();
        } catch {
          if (controller.signal.aborted) throw new FetchError(`timeout after ${TIMEOUT_MS / 1000}s`);
          throw new FetchError("connection dropped while reading", true);
        }
        if (chunk.done) break;
        total += chunk.value.byteLength;
        if (total > MAX_BYTES) {
          reader.cancel().catch(() => {});
          throw new FetchError(`response exceeds ${MAX_BYTES} bytes`);
        }
        chunks.push(chunk.value);
      }
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) {
      bytes.set(c, off);
      off += c.byteLength;
    }
    return { text: decodeBody(bytes, res.headers.get("content-type")), contentType: res.headers.get("content-type") || "" };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch with timeout, size cap, charset detection, and one retry on transient errors. */
export async function fetchText(url, headers = FEED_HEADERS) {
  try {
    return await fetchOnce(url, headers);
  } catch (err) {
    if (!(err instanceof FetchError) || !err.retryable) throw err;
    await new Promise((r) => setTimeout(r, 2000));
    return await fetchOnce(url, headers);
  }
}

const fetchFeed = (url) => fetchText(url);

// ---------------------------------------------------------------------------
// Mapping (port of FeedIngestor.fetchSource / map)
// ---------------------------------------------------------------------------

function sortNewestFirst(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((l, r) => compareDatesDesc(l.item.publishedAt, r.item.publishedAt) || l.index - r.index)
    .map((x) => x.item);
}

// Journal feeds mix real articles with front matter and notices that make
// poor reading ("Issue Information", "Correction to ..."). Mirrors FeedStore.swift.
const HOUSEKEEPING_PREFIXES = [
  "issue information", "correction", "corrigendum", "erratum", "errata",
  "retraction", "expression of concern", "publisher correction",
  "author correction", "cover image", "front cover", "back cover",
  "table of contents", "masthead", "editorial board",
];
function isJournalHousekeeping(title) {
  const lowered = title.toLowerCase();
  return HOUSEKEEPING_PREFIXES.some((p) => lowered.startsWith(p));
}

function mapItem(rss, source) {
  const title = stripHTML(rss.title);
  if (!title || isJournalHousekeeping(title)) return null;
  const summarySource = rss.summary ? rss.summary : title;
  return {
    id: rss.guid || rss.link,
    sourceId: source.id,
    title,
    subtitle: "",
    summary: summarize(summarySource),
    category: source.category,
    kind: source.kind,
    source: source.name,
    url: rss.link,
    tags: rss.categories.slice(0, 4).map((c) => stripHTML(c).toLowerCase()).filter((t) => t),
    readTime: estimateReadTime(summarySource),
    era: "Current",
    publishedAt: rss.publishedAt ? rss.publishedAt.toISOString() : null,
    locationName: source.region ?? null,
    latitude: source.latitude ?? null,
    longitude: source.longitude ?? null,
    isDynamic: true,
  };
}

/** Keeps at most ITEMS_PER_FEED, dropping >120-day-old items unless the feed has nothing newer. */
function applySourceLimits(items, nowMs) {
  const cutoff = nowMs - MAX_AGE_DAYS * 86_400_000;
  const ordered = sortNewestFirst(items);
  const hasRecent = ordered.some((it) => it.publishedAt && Date.parse(it.publishedAt) >= cutoff);
  const kept = hasRecent
    ? ordered.filter((it) => !it.publishedAt || Date.parse(it.publishedAt) >= cutoff)
    : ordered;
  return { items: kept.slice(0, ITEMS_PER_FEED), droppedOld: ordered.length - kept.length };
}

function looksLikeHTML(text) {
  return /^\s*(<!doctype html|<html)/i.test(text.slice(0, 1000));
}

async function processSource(source) {
  if (!source.rssURL) throw new Error("missing rssURL");
  const { text, contentType } = await fetchFeed(source.rssURL);
  const parsed = parseFeed(text);
  if (parsed.length === 0) {
    if (looksLikeHTML(text)) throw new Error("got an HTML page, not a feed (bot block or moved feed?)");
    throw new Error(`no items parsed${contentType ? ` (content-type ${contentType.split(";")[0]})` : ""}`);
  }
  const mapped = sortNewestFirst(parsed)
    .slice(0, ITEMS_PER_FEED)
    .map((rss) => mapItem(rss, source))
    .filter(Boolean);
  if (mapped.length === 0) throw new Error("items had no usable titles");
  return mapped;
}

async function runPool(tasks, limit) {
  const results = new Array(tasks.length);
  let next = 0;
  async function worker() {
    while (next < tasks.length) {
      const index = next++;
      results[index] = await tasks[index]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function loadPrevious() {
  if (!existsSync(FEED_OUT)) return [];
  try {
    const prev = JSON.parse(await readFile(FEED_OUT, "utf8"));
    return Array.isArray(prev.items) ? prev.items : [];
  } catch (err) {
    console.warn(`Could not read previous feed.json (${err.message}); no carry-forward this run.`);
    return [];
  }
}

async function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, contents);
  await rename(tmp, file);
}

async function main() {
  const startedAt = Date.now();
  const config = JSON.parse(await readFile(FEEDS_PATH, "utf8"));
  const sources = Array.isArray(config) ? config : config.feeds;
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("feeds.json has no feeds");

  const qualityBySourceName = new Map();
  for (const s of sources) {
    qualityBySourceName.set(s.name, Math.max(qualityBySourceName.get(s.name) ?? 0, s.qualityScore ?? 0));
  }

  const previousItems = await loadPrevious();
  const previousBySource = new Map();
  const sourceIdByName = new Map(sources.map((s) => [s.name, s.id]));
  for (const item of previousItems) {
    const id = item.sourceId || sourceIdByName.get(item.source);
    if (!id) continue;
    if (!previousBySource.has(id)) previousBySource.set(id, []);
    previousBySource.get(id).push(item);
  }

  console.log(`Fetching ${sources.length} feeds (concurrency ${CONCURRENCY}, timeout ${TIMEOUT_MS / 1000}s)...`);
  const results = await runPool(
    sources.map((source) => async () => {
      try {
        const items = await processSource(source);
        return { source, ok: true, items };
      } catch (err) {
        return { source, ok: false, items: [], error: err && err.message ? err.message : String(err) };
      }
    }),
    CONCURRENCY,
  );

  const now = Date.now();
  const sourceStatus = [];
  const failures = [];
  let all = [];
  let droppedLowTrust = 0;
  let droppedOld = 0;
  let carriedTotal = 0;

  for (const r of results) {
    let items = r.items;
    let carried = 0;
    if (!r.ok) {
      items = (previousBySource.get(r.source.id) || []).filter((i) => !isJournalHousekeeping(i.title || ""));
      carried = items.length;
      carriedTotal += carried;
    }
    const before = items.length;
    items = items.filter((it) => !isLowTrust(it.url));
    droppedLowTrust += before - items.length;
    const limited = applySourceLimits(items, now);
    droppedOld += limited.droppedOld;
    items = limited.items;
    all = all.concat(items);

    const status = { id: r.source.id, ok: r.ok, count: items.length };
    if (!r.ok) {
      status.error = r.error;
      status.carriedForward = carried;
      failures.push({ id: r.source.id, name: r.source.name, url: r.source.rssURL, error: r.error, carriedForward: carried });
    }
    sourceStatus.push(status);
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount === 0) {
    console.error("Every feed failed (network outage?). Leaving the existing docs/ untouched.");
    process.exitCode = 1;
    return;
  }

  const deduped = deduplicate(all, qualityBySourceName);
  let items = deduped.items;

  const build = (list) =>
    JSON.stringify({ schemaVersion: 1, generatedAt: new Date(now).toISOString(), sourceStatus, items: list });
  let json = build(items);

  // Size guard: shrink the per-source cap until the file fits.
  let perSourceCap = ITEMS_PER_FEED;
  while (Buffer.byteLength(json) > MAX_OUTPUT_BYTES && perSourceCap > 5) {
    perSourceCap -= 5;
    const counts = new Map();
    items = sortNewestFirst(deduped.items).filter((it) => {
      const c = (counts.get(it.sourceId) || 0) + 1;
      counts.set(it.sourceId, c);
      return c <= perSourceCap;
    });
    const keep = new Set(items);
    items = deduped.items.filter((it) => keep.has(it)); // restore dedupe ordering
    json = build(items);
  }
  if (perSourceCap !== ITEMS_PER_FEED) {
    const countBySource = new Map();
    for (const it of items) countBySource.set(it.sourceId, (countBySource.get(it.sourceId) || 0) + 1);
    for (const s of sourceStatus) s.count = Math.min(s.count, countBySource.get(s.id) || 0);
    json = build(items);
  }

  await mkdir(DOCS_DIR, { recursive: true });
  await writeAtomic(FEED_OUT, json);

  const bytes = Buffer.byteLength(json);
  const status = {
    generatedAt: new Date(now).toISOString(),
    durationSeconds: Math.round((Date.now() - startedAt) / 100) / 10,
    feedsTotal: sources.length,
    feedsOk: okCount,
    feedsFailed: sources.length - okCount,
    itemsTotal: items.length,
    itemsCarriedForward: carriedTotal,
    droppedDuplicates: deduped.duplicates,
    droppedLowTrust,
    droppedOlderThan120Days: droppedOld,
    perSourceCap,
    feedJsonBytes: bytes,
    failures,
  };
  await writeAtomic(STATUS_OUT, JSON.stringify(status, null, 2) + "\n");

  console.log(`OK ${okCount}/${sources.length} feeds, ${items.length} items, ${(bytes / 1024).toFixed(0)} KB`);
  for (const f of failures) console.log(`  FAILED ${f.id}: ${f.error} (carried forward ${f.carriedForward})`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exitCode = 1;
  });
}
