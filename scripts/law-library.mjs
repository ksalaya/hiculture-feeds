#!/usr/bin/env node
// HiCulture Law Library refresher.
//
// Writes docs/law-library.json (compact) and docs/law-status.json (pretty):
//   updates           nightly  (port of LawUpdateService.swift)
//   juryInstructions  nightly  (port of JuryInstructionService.swift)
//   statutes          weekly   (port of StatuteService.swift, list in scripts/statute-list.json)
//   rules             weekly   (port of RuleService.swift, list in scripts/rule-list.json)
//
// Anything that fails keeps the previous night's data. Node 20+, no npm deps.
// Usage (from the feed-refresh folder):  node scripts/law-library.mjs
// Set FORCE_LAW_REFRESH=1 to refetch every statute and rule regardless of age.

import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { stripHTML, fetchText, FetchError } from "./refresh.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DOCS_DIR = path.join(ROOT, "docs");
const OUT = path.join(DOCS_DIR, "law-library.json");
const STATUS_OUT = path.join(DOCS_DIR, "law-status.json");
const STATUTE_LIST = path.join(ROOT, "scripts", "statute-list.json");
const RULE_LIST = path.join(ROOT, "scripts", "rule-list.json");

const HTML_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const APP_HEADERS = { "User-Agent": "HiCulture/1.0 (iOS)", Accept: HTML_ACCEPT };
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15",
  Accept: HTML_ACCEPT,
  "Accept-Language": "en-US,en;q=0.9",
};
const THROTTLE_MS = 1000; // leginfo / rules pages: at most 1 request per second
const BODY_LIMIT = 12_000;
const MAX_OUTPUT_BYTES = 3 * 1024 * 1024;
const WEEK_MS = 7 * 86_400_000;
const CHALLENGE_BREAKER = 3; // stop hitting a host after this many bot-challenge blocks in a row

const LAW_CODES = {
  BPC: { label: "Business & Professions", prefix: "Bus. & Prof. Code" },
  CIV: { label: "Civil Code", prefix: "Civ. Code" },
  CCP: { label: "Code of Civil Procedure", prefix: "Code Civ. Proc." },
  CORP: { label: "Corporations Code", prefix: "Corp. Code" },
  EVID: { label: "Evidence Code", prefix: "Evid. Code" },
  FAM: { label: "Family Code", prefix: "Fam. Code" },
  GOV: { label: "Government Code", prefix: "Gov. Code" },
  HSC: { label: "Health & Safety", prefix: "Health & Saf. Code" },
  LAB: { label: "Labor Code", prefix: "Lab. Code" },
  PEN: { label: "Penal Code", prefix: "Pen. Code" },
  PROB: { label: "Probate Code", prefix: "Prob. Code" },
  VEH: { label: "Vehicle Code", prefix: "Veh. Code" },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function isBotChallenge(text) {
  return /<title>\s*Just a moment\.\.\.|challenge-platform|cf-chl-|Attention Required! \| Cloudflare|cf_chl_opt/i.test(
    text.slice(0, 20_000),
  );
}

class BlockedError extends Error {}

/**
 * Fetches HTML with the app's User-Agent. On HTTP 403 or a bot-challenge page,
 * retries once with a browser-like User-Agent (some government sites reject
 * unknown agents). Returns { html, ua: "app" | "browser" }.
 */
async function fetchHTML(url, { browserFallback = true } = {}) {
  const attempt = async (headers) => {
    try {
      const { text } = await fetchText(url, headers);
      if (isBotChallenge(text)) throw new BlockedError("bot challenge page (Cloudflare)");
      return text;
    } catch (err) {
      if (err instanceof FetchError && err.status === 403) {
        throw new BlockedError(isBotChallenge(err.body) ? "HTTP 403 Cloudflare bot challenge" : "HTTP 403");
      }
      throw err;
    }
  };
  try {
    return { html: await attempt(APP_HEADERS), ua: "app" };
  } catch (err) {
    if (!(err instanceof BlockedError) || !browserFallback) throw err;
    try {
      return { html: await attempt(BROWSER_HEADERS), ua: "browser" };
    } catch (err2) {
      if (err2 instanceof BlockedError) throw new BlockedError(`${err2.message} (app and browser User-Agents)`);
      throw err2;
    }
  }
}

/** Serializes requests to one host with a minimum gap between request starts. */
function makeThrottle(gapMs) {
  let last = 0;
  return async () => {
    const wait = last + gapMs - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
  };
}

// ---------------------------------------------------------------------------
// Shared parsing helpers (ports of the private helpers in the Swift services)
// ---------------------------------------------------------------------------

function decodeHref(href) {
  return href.replace(/&amp;/gi, "&").replace(/&#0*38;/g, "&");
}

/** <a href="...">text</a> anchors, like the Swift NSRegularExpression. Keeps the raw href for context search. */
function extractAnchors(html, { allowEmptyText = false } = {}) {
  const re = /<a\s+[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html))) {
    const rawHref = m[1];
    const text = stripHTML(m[2]);
    if (!rawHref) continue;
    if (!text && !allowEmptyText) continue;
    out.push({ rawHref, href: decodeHref(rawHref), text });
  }
  return out;
}

function normalizeURL(href, base) {
  if (href.startsWith("http://") || href.startsWith("https://")) return href;
  if (href.startsWith("//")) return "https:" + href;
  const b = new URL(base);
  if (href.startsWith("/")) return `${b.protocol}//${b.host}${href}`;
  if (/^(mailto|javascript|tel):/i.test(href) || href.startsWith("#")) return null;
  // Foundation's appendingPathComponent: base path + "/" + href
  return `${b.protocol}//${b.host}${b.pathname.replace(/\/$/, "")}/${href}`;
}

function windowAround(html, token, size) {
  const i = html.indexOf(token);
  if (i === -1) return null;
  return html.slice(Math.max(0, i - size), Math.min(html.length, i + token.length + size));
}

/** Strips a context window to text, dropping tag fragments cut off at either edge. */
function windowText(win) {
  if (!win) return "";
  let w = win;
  const gt = w.indexOf(">");
  const lt = w.indexOf("<");
  if (gt !== -1 && (lt === -1 || gt < lt)) w = w.slice(gt + 1); // starts inside a tag
  w = w.replace(/<[^>]*$/, ""); // ends inside a tag
  return stripHTML(w);
}

function uniqueBy(list, key) {
  const seen = new Set();
  return list.filter((x) => {
    const k = key(x);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_NAMES = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

// Calendar dates are kept as { y, m, d } and serialized at 12:00 UTC so they
// show the same calendar day in every U.S. time zone.
function calendarDate(y, m, d) {
  if (m < 0 || m > 11 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m, d, 12));
  if (dt.getUTCMonth() !== m) return null;
  return { y, m, d };
}
const isoOf = (c) => (c ? new Date(Date.UTC(c.y, c.m, c.d, 12)).toISOString() : null);
const dayOf = (c) => (c ? `${c.y}-${String(c.m + 1).padStart(2, "0")}-${String(c.d).padStart(2, "0")}` : null);
const longOf = (c) => `${MONTH_NAMES[c.m]} ${c.d}, ${c.y}`; // DateFormatter "MMMM d, yyyy"

/** "MMMM d, yyyy" */
function parseLongDate(s) {
  const m = /^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})$/.exec(s.trim());
  if (!m) return null;
  const mi = MONTHS.indexOf(m[1].toLowerCase());
  return mi === -1 ? null : calendarDate(+m[3], mi, +m[2]);
}

const LONG_DATE_RE = /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/g;

function extractLongDates(text) {
  return [...text.matchAll(LONG_DATE_RE)].map((m) => parseLongDate(m[1])).filter(Boolean);
}

/** "M/d/yy" or "M/d/yyyy" */
function extractShortDate(text) {
  const m = /\b(\d{1,2})\/(\d{1,2})\/(\d{2,4})\b/.exec(text);
  if (!m) return null;
  let y = +m[3];
  if (m[3].length === 2) y += y < 70 ? 2000 : 1900;
  else if (m[3].length === 3) return null;
  return calendarDate(y, +m[1] - 1, +m[2]);
}

function firstGroup(text, re) {
  const m = re.exec(text);
  return m && m[1] !== undefined ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Law updates (LawUpdateService.swift)
// ---------------------------------------------------------------------------

function lawItem({ id, title, url, source, summary, publishedAt, caseNumber = null, court = null, disposition = null }) {
  return {
    id, title, url, source, summary,
    publishedAt: isoOf(publishedAt),
    date: dayOf(publishedAt),
    detail: summary,
    caseNumber, court, disposition,
  };
}

function extractCourtInfo(context) {
  const cleaned = context.replace(/\s+/g, " ");
  const m = firstGroup(cleaned, /([0-9A-Za-z ,]+Court of Appeal[^.]*?)(?:Published Opinion|Filed|$)/);
  const court = m ? m.trim().replace(/[\s•·|,;:-]+$/u, "") : "";
  return court || null;
}

function extractDisposition(context) {
  const lower = context.toLowerCase();
  for (const w of ["Affirmed", "Reversed", "Dismissed", "Modified", "Remanded", "Vacated", "Denied", "Granted"]) {
    if (lower.includes(w.toLowerCase())) return w;
  }
  return lower.includes("published opinion") ? "Published Opinion" : null;
}

async function enrichOpinion(item) {
  try {
    return { item: await enrichOpinionInner(item), blocked: false };
  } catch (err) {
    return { item, blocked: err instanceof BlockedError };
  }
}

async function enrichOpinionInner(item) {
  const { html } = await fetchHTML(item.url, { browserFallback: false });
  const plain = stripHTML(html).replace(/\s+/g, " ");
  const caseNumber =
    firstGroup(plain, /Case Number\s*:?\s*([A-Za-z0-9-]+)/) ?? firstGroup(plain, /Case No\.?\s*:?\s*([A-Za-z0-9-]+)/);
  const courtMatch = firstGroup(plain, /(Court of Appeal[^,.]*\b|Supreme Court of California|Superior Court[^,.]*)/);
  const disp =
    firstGroup(plain, /Disposition\s*:?\s*([A-Za-z ,.-]{3,80})/) ?? firstGroup(plain, /Result\s*:?\s*([A-Za-z ,.-]{3,80})/);
  return {
    ...item,
    caseNumber: caseNumber ?? item.caseNumber,
    court: courtMatch ? courtMatch.trim() : item.court,
    disposition: disp ? disp.trim() : item.disposition,
  };
}

async function fetchPublishedOpinions() {
  const base = "https://courts.ca.gov/opinions/publishedcitable-opinions";
  const { html } = await fetchHTML(base);
  const items = [];
  for (const a of extractAnchors(html)) {
    const lowered = a.text.toLowerCase();
    if (!(lowered.includes(" v.") || lowered.includes("in re") || lowered.includes("in the matter"))) continue;
    if (!(a.href.includes("appellatecases.courtinfo.ca.gov") || a.href.includes("/opinions/"))) continue;
    const url = normalizeURL(a.href, base);
    if (!url) continue;
    const context = windowText(windowAround(html, a.rawHref || a.text, 400));
    const publishedAt = extractShortDate(a.text) ?? extractLongDates(context)[0] ?? null;
    // The Swift extractCaseNumber patterns have no capture group, so it always
    // yields nil; the case number comes from the case-info page instead.
    // The case number is in the case-info URL (query_caseNumber=H052967).
    let caseNumber = null;
    try {
      caseNumber = new URL(url).searchParams.get("query_caseNumber") || null;
    } catch {}
    const court = extractCourtInfo(context);
    const disposition = extractDisposition(context);
    const pieces = [
      caseNumber && `Case ${caseNumber}.`,
      court && `${court}.`,
      publishedAt && `Filed ${longOf(publishedAt)}.`,
      disposition && `Disposition: ${disposition}.`,
    ].filter(Boolean);
    items.push({
      id: url, title: a.text, url, source: "Published Opinions",
      summary: pieces.length ? pieces.join(" ") : "New published or citable opinion.",
      publishedAt, caseNumber, court, disposition,
    });
  }
  const unique = uniqueBy(items, (x) => x.url);
  // Enrich the newest 12 from their case-info pages (skipped once that host blocks us).
  const head = [];
  let blocked = false;
  for (const item of unique.slice(0, 12)) {
    if (blocked || !item.url.includes("appellatecases.courtinfo.ca.gov")) {
      head.push(item);
      continue;
    }
    const r = await enrichOpinion(item);
    blocked = r.blocked;
    head.push(r.item);
    await sleep(500);
  }
  return {
    id: "published-opinions",
    title: "Published Opinions",
    items: [...head, ...unique.slice(12)].map(lawItem),
  };
}

async function fetchRulesUpdates() {
  const base = "https://courts.ca.gov/forms-rules/rules-court/new-amended-rules";
  const { html } = await fetchHTML(base);
  const items = [];
  for (const a of extractAnchors(html)) {
    const lowered = a.text.toLowerCase();
    // Swift: text contains "rule"/"rules"/"amend". Newer entries read
    // "Adopted by ... on <date>, effective <date>", so "adopted" is accepted too,
    // and sidebar/breadcrumb links (no date, not a PDF) are skipped.
    if (!(lowered.includes("rule") || lowered.includes("amend") || lowered.includes("adopted"))) continue;
    const url = normalizeURL(a.href, base);
    if (!url || !url.includes("courts.ca.gov")) continue;
    const dates = extractLongDates(a.text);
    if (!dates.length && !/\.pdf(\?|#|$)/i.test(url)) continue;
    const summary = !dates.length
      ? "New or amended rule materials."
      : dates.length >= 2
        ? `Adopted ${longOf(dates[0])}. Effective ${longOf(dates[1])}.`
        : `Adopted ${longOf(dates[0])}.`;
    items.push({ id: url, title: a.text, url, source: "Rules of Court", summary, publishedAt: dates[0] ?? null });
  }
  return {
    id: "rules-updates",
    title: "Rules & Amendments",
    items: uniqueBy(items, (x) => x.url).slice(0, 10).map(lawItem),
  };
}

async function fetchNewsroomUpdates() {
  const base = "https://newsroom.courts.ca.gov/news";
  const { html } = await fetchHTML(base);
  const items = [];
  for (const a of extractAnchors(html)) {
    const len = Array.from(a.text).length;
    if (!a.href.includes("/news/")) continue;
    if (len < 10 || len > 160) continue;
    if (["next", "previous"].includes(a.text.toLowerCase())) continue;
    const url = normalizeURL(a.href, base);
    if (!url) continue;
    const win = windowAround(html, a.rawHref || a.text, 300);
    const dateStr = win ? firstGroup(win, /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/) : null;
    const publishedAt = dateStr ? parseLongDate(dateStr) : null;
    // Category links ("/news/supreme-court") carry no date; stories always do.
    if (!publishedAt) continue;
    items.push({
      id: url, title: a.text, url, source: "Judicial Branch News",
      summary: `Posted ${longOf(publishedAt)}.`, publishedAt,
    });
  }
  return {
    id: "newsroom-updates",
    title: "Judicial Branch News",
    items: uniqueBy(items, (x) => x.url).slice(0, 8).map(lawItem),
  };
}

// ---------------------------------------------------------------------------
// Jury instructions (JuryInstructionService.swift)
// ---------------------------------------------------------------------------

const JURY_CATEGORIES = [
  { id: "civil", label: "Civil (CACI)", url: "https://courts.ca.gov/advisory-body/civil-jury-instructions-advisory-committee" },
  { id: "criminal", label: "Criminal (CALCRIM)", url: "https://courts.ca.gov/advisory-body/criminal-jury-instructions-advisory-committee" },
];

function juryDetail(context) {
  const lower = context.toLowerCase();
  for (const marker of ["as adopted", "approved"]) {
    const i = lower.indexOf(marker);
    if (i !== -1) return context.slice(i).trim();
  }
  const chars = Array.from(context);
  return chars.length > 160 ? chars.slice(0, 160).join("") + "…" : context;
}

async function fetchJury(category) {
  const { html } = await fetchHTML(category.url);
  const docs = [];
  for (const a of extractAnchors(html, { allowEmptyText: true })) {
    if (!a.href.toLowerCase().includes(".pdf")) continue;
    const url = normalizeURL(a.href, category.url);
    if (!url) continue;
    // Prefer the text right after this link (up to the next link): the Swift
    // window also looks 220 chars back, which picks up the previous edition's
    // "as adopted" line. Fall back to the Swift window when nothing follows.
    let detail = "";
    const at = html.indexOf(a.rawHref);
    const close = at === -1 ? -1 : html.indexOf("</a>", at);
    if (close !== -1) {
      const nextA = html.indexOf("<a ", close);
      const after = windowText(html.slice(close + 4, Math.min(close + 4 + 300, nextA === -1 ? Infinity : nextA)));
      const lower = after.toLowerCase();
      const mi = [lower.indexOf("as adopted"), lower.indexOf("approved")].filter((x) => x !== -1);
      if (mi.length) detail = after.slice(Math.min(...mi)).trim();
    }
    if (!detail) detail = juryDetail(windowText(windowAround(html, a.rawHref || a.text, 220)));
    const ds = firstGroup(detail, /([A-Z][a-z]+\s+\d{1,2},\s+\d{4})/);
    const publishedAt = ds ? parseLongDate(ds) : null;
    docs.push({
      id: url,
      title: a.text || "Jury Instructions PDF",
      detail,
      category: category.id,
      categoryLabel: category.label,
      url,
      publishedAt: isoOf(publishedAt),
      date: dayOf(publishedAt),
    });
  }
  return uniqueBy(docs, (d) => d.url);
}

// ---------------------------------------------------------------------------
// Statutes (StatuteService.swift) and Rules of Court (RuleService.swift)
// ---------------------------------------------------------------------------

function removeNonContent(html) {
  return html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ");
}

/** Returns the outer HTML of the element whose start tag matches `startRe`, balancing nested tags of that name. */
function extractElement(html, startRe) {
  const m = startRe.exec(html);
  if (!m) return null;
  const tag = /^<([a-z0-9]+)/i.exec(m[0])[1].toLowerCase();
  const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
  re.lastIndex = m.index + m[0].length;
  let depth = 1;
  let t;
  while ((t = re.exec(html))) {
    depth += t[1] ? -1 : 1;
    if (depth === 0) return html.slice(m.index, t.index + t[0].length);
  }
  return html.slice(m.index);
}

function truncateBody(body, limit) {
  const chars = Array.from(body);
  if (chars.length <= limit) return { body, truncated: false };
  let cut = chars.slice(0, limit).join("");
  const sp = cut.lastIndexOf(" ");
  if (sp > limit * 0.8) cut = cut.slice(0, sp);
  return {
    body: `${cut} … [Text truncated at ${limit.toLocaleString("en-US")} characters; read the full text at the source link.]`,
    truncated: true,
  };
}

function cutAtFirst(text, words, caseInsensitive) {
  const hay = caseInsensitive ? text.toLowerCase() : text;
  const idx = words
    .map((w) => hay.indexOf(caseInsensitive ? w.toLowerCase() : w))
    .filter((i) => i !== -1);
  return idx.length ? text.slice(0, Math.min(...idx)).trim() : text;
}

function parseStatute(html, lawCode, section) {
  const prefix = LAW_CODES[lawCode]?.prefix ?? lawCode;
  const title = `${prefix} § ${section}`;
  const cleanHTML = removeNonContent(html);
  // leginfo renders the section inside <div id="codeLawSectionNoHead">.
  const scoped = extractElement(cleanHTML, /<div[^>]*\bid="codeLawSectionNoHead"[^>]*>/i);
  let body;
  if (scoped) {
    body = stripHTML(scoped);
  } else {
    // Faithful Swift fallback: text after the first "SECTION", cut at history markers.
    const clean = stripHTML(cleanHTML).replace(/ /g, " ");
    const i = clean.toLowerCase().indexOf("section");
    body = i === -1 ? clean : clean.slice(i + "section".length).trim();
    body = cutAtFirst(body, ["HISTORY", "Legislative Counsel", "Legislative", "Hist.", "Former Section", "CREDIT"], true);
  }
  return { title, body: body.replace(/\s+/g, " ").trim() };
}

const RULE_TITLE_SEGMENTS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten" };

function ruleCandidates(ruleNumber) {
  const lead = parseInt(ruleNumber.split(".")[0], 10);
  const segs = [];
  if (RULE_TITLE_SEGMENTS[lead]) segs.push(RULE_TITLE_SEGMENTS[lead]);
  for (const s of Object.values(RULE_TITLE_SEGMENTS).sort()) if (!segs.includes(s)) segs.push(s);
  return segs.map((s) => `https://courts.ca.gov/cms/rules/index/${s}/rule${ruleNumber.replace(/\./g, "_")}`);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseRule(html, ruleNumber) {
  const cleanHTML = removeNonContent(html);
  const h1 = /<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(cleanHTML);
  const h1Text = h1 ? stripHTML(h1[1]) : "";
  const content = extractElement(cleanHTML, /<div[^>]*class="[^"]*\broc__rule__content\b[^"]*"[^>]*>/i);
  if (content) {
    const title = new RegExp(`^Rule\\s+${escapeRe(ruleNumber)}\\b`, "i").test(h1Text) ? h1Text : `Rule ${ruleNumber}`;
    const body = cutAtFirst(stripHTML(content), ["Advisory Committee Comment"], false);
    return { title, body: body.replace(/\s+/g, " ").trim() };
  }
  // Faithful Swift fallback.
  const cleaned = stripHTML(cleanHTML);
  const t = new RegExp(`(Rule\\s+${escapeRe(ruleNumber)}[^\\n]{0,120})`, "i").exec(cleaned);
  const title = t ? t[1].trim() : `Rule ${ruleNumber}`;
  const at = cleaned.toLowerCase().indexOf(`rule ${ruleNumber}`.toLowerCase());
  let body = at === -1 ? cleaned : cleaned.slice(at + `rule ${ruleNumber}`.length).trim();
  body = cutAtFirst(body, ["History", "Advisory Committee Comment", "Committee Comment", "Authority", "References"], true);
  return { title, body: body.replace(/\s+/g, " ").trim() };
}

/**
 * Weekly refresher for keyed entries. Fetches an entry when it is missing,
 * older than 7 days, today is Sunday (UTC), or FORCE_LAW_REFRESH=1. Failures
 * keep the previous entry. Requests are throttled; each failure is retried
 * once; repeated bot-challenge blocks trip a breaker for the rest of the run.
 */
async function refreshKeyed({ label, entries, previous, now, fetchEntry }) {
  const force = process.env.FORCE_LAW_REFRESH === "1";
  const sunday = new Date(now).getUTCDay() === 0;
  const throttle = makeThrottle(THROTTLE_MS);
  const out = {};
  const stats = { listed: entries.length, due: 0, ok: 0, failed: 0, skipped: 0, keptPrevious: 0, notDue: 0, userAgent: { app: 0, browser: 0 } };
  const failures = [];
  let consecutiveBlocks = 0;
  let breaker = null;

  for (const e of entries) {
    const prev = previous[e.key];
    const age = prev?.fetchedAt ? now - Date.parse(prev.fetchedAt) : Infinity;
    const due = force || sunday || !prev || !(age < WEEK_MS);
    if (!due) {
      out[e.key] = prev;
      stats.notDue++;
      continue;
    }
    stats.due++;
    if (breaker) {
      stats.skipped++;
      if (prev) { out[e.key] = prev; stats.keptPrevious++; }
      failures.push({ key: e.key, error: `skipped: ${breaker}` });
      continue;
    }
    let result = null;
    let lastErr = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      await throttle();
      try {
        result = await fetchEntry(e);
      } catch (err) {
        lastErr = err;
        if (err instanceof BlockedError) break; // the browser-UA retry already happened
      }
    }
    if (result) {
      consecutiveBlocks = 0;
      stats.ok++;
      stats.userAgent[result.ua]++;
      out[e.key] = result.entry;
    } else {
      stats.failed++;
      const msg = lastErr?.message ?? String(lastErr);
      failures.push({ key: e.key, error: msg });
      if (prev) { out[e.key] = prev; stats.keptPrevious++; }
      if (lastErr instanceof BlockedError) {
        consecutiveBlocks++;
        if (consecutiveBlocks >= CHALLENGE_BREAKER) {
          breaker = `${label} host is blocking automated requests (${msg}); stopped after ${CHALLENGE_BREAKER} blocks in a row`;
          console.warn(`  ${breaker}`);
        }
      } else {
        consecutiveBlocks = 0;
      }
    }
  }
  return { entries: out, stats, failures, blocked: breaker };
}

async function fetchStatute({ lawCode, section }) {
  const sourceURL = `https://leginfo.legislature.ca.gov/faces/codes_displaySection.xhtml?lawCode=${encodeURIComponent(lawCode)}&sectionNum=${encodeURIComponent(section)}`;
  const { html, ua } = await fetchHTML(sourceURL);
  const parsed = parseStatute(html, lawCode, section);
  if (parsed.body.length < 24) throw new Error("could not find statute text on the page");
  const { body, truncated } = truncateBody(parsed.body, BODY_LIMIT);
  const entry = { lawCode, section, title: parsed.title, body, sourceURL, fetchedAt: new Date().toISOString() };
  if (truncated) entry.truncated = true;
  return { entry, ua };
}

async function fetchRule({ ruleNumber }) {
  let lastErr = null;
  for (const url of ruleCandidates(ruleNumber)) {
    try {
      const { html, ua } = await fetchHTML(url);
      const parsed = parseRule(html, ruleNumber);
      if (parsed.body.length <= 24) continue;
      const { body, truncated } = truncateBody(parsed.body, BODY_LIMIT);
      const entry = { id: `${ruleNumber}-${url}`, ruleNumber, title: parsed.title, body, sourceURL: url, fetchedAt: new Date().toISOString() };
      if (truncated) entry.truncated = true;
      return { entry, ua };
    } catch (err) {
      lastErr = err;
      if (err instanceof FetchError && err.status === 404) {
        await sleep(THROTTLE_MS); // still polite while walking fallback titles
        continue;
      }
      throw err;
    }
  }
  throw lastErr ?? new Error("rule not found under any title");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function readJSON(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    console.warn(`Could not read ${path.basename(file)}: ${err.message}`);
    return fallback;
  }
}

async function writeAtomic(file, contents) {
  await writeFile(`${file}.tmp`, contents);
  await rename(`${file}.tmp`, file);
}

async function main() {
  const started = Date.now();
  const now = Date.now();
  const previous = await readJSON(OUT, {});
  const statuteList = (await readJSON(STATUTE_LIST, { statutes: [] })).statutes;
  const ruleList = (await readJSON(RULE_LIST, { rules: [] })).rules;

  // --- Nightly: updates
  console.log("Law updates...");
  const sectionFetchers = [fetchPublishedOpinions, fetchRulesUpdates, fetchNewsroomUpdates];
  const sectionIds = ["published-opinions", "rules-updates", "newsroom-updates"];
  const prevSections = new Map((previous.updates || []).map((s) => [s.id, s]));
  const updates = [];
  const updatesStatus = [];
  for (let i = 0; i < sectionFetchers.length; i++) {
    try {
      const section = await sectionFetchers[i]();
      if (!section.items.length) throw new Error("no items found (page layout changed?)");
      updates.push(section);
      updatesStatus.push({ id: section.id, ok: true, count: section.items.length });
    } catch (err) {
      const prev = prevSections.get(sectionIds[i]);
      if (prev) updates.push(prev);
      updatesStatus.push({ id: sectionIds[i], ok: false, count: prev?.items.length ?? 0, error: err.message, keptPrevious: !!prev });
    }
  }

  // --- Nightly: jury instructions
  console.log("Jury instructions...");
  const juryInstructions = [];
  const juryStatus = [];
  for (const cat of JURY_CATEGORIES) {
    try {
      const docs = await fetchJury(cat);
      if (!docs.length) throw new Error("no PDF links found (page layout changed?)");
      juryInstructions.push(...docs);
      juryStatus.push({ id: cat.id, ok: true, count: docs.length });
    } catch (err) {
      const prev = (previous.juryInstructions || []).filter((d) => d.category === cat.id);
      juryInstructions.push(...prev);
      juryStatus.push({ id: cat.id, ok: false, count: prev.length, error: err.message, keptPrevious: prev.length > 0 });
    }
  }

  // --- Weekly: statutes
  const statuteEntries = statuteList
    .filter((s) => s && s.lawCode && s.section)
    .map((s) => ({ key: `${s.lawCode}-${s.section}`, lawCode: s.lawCode, section: String(s.section) }));
  console.log(`Statutes (${statuteEntries.length} listed)...`);
  const statutes = await refreshKeyed({
    label: "leginfo.legislature.ca.gov", entries: statuteEntries, previous: previous.statutes || {}, now, fetchEntry: fetchStatute,
  });

  // --- Weekly: rules of court
  const ruleEntries = ruleList.map((r) => String(r).replace(/^rule\s*/i, "").trim()).filter(Boolean)
    .map((r) => ({ key: r, ruleNumber: r }));
  console.log(`Rules of Court (${ruleEntries.length} listed)...`);
  const rules = await refreshKeyed({
    label: "courts.ca.gov", entries: ruleEntries, previous: previous.rules || {}, now, fetchEntry: fetchRule,
  });

  const status = {
    updates: updatesStatus,
    juryInstructions: juryStatus,
    statutes: { ...statutes.stats, blocked: statutes.blocked },
    rules: { ...rules.stats, blocked: rules.blocked },
  };
  const build = () =>
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date(now).toISOString(),
      status,
      updates,
      juryInstructions,
      statutes: statutes.entries,
      rules: rules.entries,
    });
  let json = build();
  // Size guard: shorten the longest bodies until the file fits.
  for (const limit of [8000, 5000, 3000]) {
    if (Buffer.byteLength(json) <= MAX_OUTPUT_BYTES) break;
    for (const bag of [statutes.entries, rules.entries]) {
      for (const [k, v] of Object.entries(bag)) {
        if (Array.from(v.body).length > limit + 200) {
          const t = truncateBody(v.body.replace(/ … \[Text truncated[^\]]*\]$/, ""), limit);
          bag[k] = { ...v, body: t.body, truncated: true };
        }
      }
    }
    json = build();
  }

  await mkdir(DOCS_DIR, { recursive: true });
  await writeAtomic(OUT, json);
  const report = {
    generatedAt: new Date(now).toISOString(),
    durationSeconds: Math.round((Date.now() - started) / 100) / 10,
    lawLibraryJsonBytes: Buffer.byteLength(json),
    ...status,
    statuteFailures: statutes.failures,
    ruleFailures: rules.failures,
  };
  await writeAtomic(STATUS_OUT, JSON.stringify(report, null, 2) + "\n");

  console.log(
    `Updates: ${updatesStatus.map((s) => `${s.id}=${s.ok ? s.count : "FAILED"}`).join(", ")}\n` +
      `Jury: ${juryStatus.map((s) => `${s.id}=${s.ok ? s.count : "FAILED"}`).join(", ")}\n` +
      `Statutes: ${statutes.stats.ok} ok, ${statutes.stats.failed} failed, ${statutes.stats.skipped} skipped, ${statutes.stats.notDue} not due, ${Object.keys(statutes.entries).length} stored${statutes.blocked ? `\n  ${statutes.blocked}` : ""}\n` +
      `Rules: ${rules.stats.ok} ok, ${rules.stats.failed} failed, ${rules.stats.skipped} skipped, ${rules.stats.notDue} not due, ${Object.keys(rules.entries).length} stored${rules.blocked ? `\n  ${rules.blocked}` : ""}\n` +
      `law-library.json: ${(Buffer.byteLength(json) / 1024).toFixed(0)} KB`,
  );

  if (!updatesStatus.some((s) => s.ok) && !juryStatus.some((s) => s.ok)) {
    console.error("All nightly law sources failed.");
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exitCode = 1;
});
