// supabase/functions/marketing-draft/index.ts
//
// Cobalt Marketing drafting engine. Turns one source (a website Guide, an anonymized deal story,
// or a quick note) into a spread of posts across every channel, following Cobalt's brand and
// compliance rules. Drafts land in mkt_posts as "draft". Nothing is published here; a team member
// approves each post in Cobalt Marketing.
//
// Callers
//   Signed-in team member (Cobalt Marketing):
//     { content_id }                         draft the full set for a source
//     { content_id, redraft: true, instruction? }   replace every open draft for the source
//     { content_id, post_id, instruction? }  replace one post, keeping its time slot
//     { content_id, fill: true }             write only the posts a channel is short on
//   Scheduler (pg_cron hourly, header x-cron-secret):
//     { action: "discover" }  find Guides newly published on the website and draft them

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { autoFix, lint, slugify, utmUrl } from "./rules.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = ["https://cobaltcommercialcredit.github.io"];
const MODEL = "claude-sonnet-5";

const ALL_CHANNELS = [
  "linkedin_company", "linkedin_curtis", "linkedin_armen", "instagram", "x", "email_owners", "email_partners",
];

const DEFAULT_COUNTS: Record<string, Record<string, number>> = {
  guide: { linkedin_company: 2, linkedin_curtis: 2, linkedin_armen: 1, instagram: 4, x: 7, email_owners: 1, email_partners: 1 },
  deal_story: { linkedin_company: 2, linkedin_curtis: 2, linkedin_armen: 1, instagram: 4, x: 7, email_owners: 1, email_partners: 1 },
  note: { linkedin_company: 1, linkedin_curtis: 1, instagram: 2, x: 3 },
};
const DEFAULT_SPAN: Record<string, number> = { guide: 10, deal_story: 10, note: 5 };

// Business day each channel starts on, and which default time slot it uses.
const START: Record<string, { day: number; slot: string }> = {
  linkedin_company: { day: 0, slot: "linkedin" },
  x: { day: 0, slot: "x" },
  linkedin_curtis: { day: 1, slot: "linkedin" },
  instagram: { day: 1, slot: "instagram" },
  linkedin_armen: { day: 2, slot: "linkedin" },
  email_owners: { day: 3, slot: "email" },
  email_partners: { day: 3, slot: "email" },
};

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

const SYSTEM_PROMPT = `You are the marketing writer for Cobalt Commercial Credit, a capital execution firm that sources, structures, and places financing for privately held, owner operated businesses (roughly $2M to $20M in revenue: manufacturing, distribution, professional practices, owner occupied real estate, government contractors). Cobalt works nationwide. Its principals are Curtis Hollowell and Armen Grigorian, both Managing Partners.

You turn one source into channel specific posts that roll out over the next two weeks. Return ONLY a raw JSON object, no code fences, no commentary.

HARD RULES (breaking any of these makes the draft unusable):
1. Never use dashes of any kind as punctuation: no em dash, no en dash, no spaced hyphen. Avoid hyphenated compounds too (write "asset based", "owner operated", "sale leaseback").
2. Never invent facts. No deal results, client names, dollar figures, rates, timelines, or statistics that are not in the source. If the source gives an illustrative example, keep it clearly illustrative ("for example", "consider a business that...").
3. Never promise approval, rates, terms, or speed.
4. Never say "debt relief", "debt settlement", or "debt consolidation". For merchant cash advance topics say "refinancing" or "replacement financing".
5. Never mention any specific client, and never mention Access Capital.
6. Nothing California specific. Cobalt is nationwide.
7. Do not describe Cobalt as a loan broker or a lender. Cobalt "sources, structures, and places" capital.
8. Lead with the business owner's problem or decision, not a product name. Products (ABL, SBA, factoring, sale leaseback) can appear later in the text.
9. Sale leaseback is always framed as a financing decision (cost of capital, lease terms acting like covenants, balance sheet impact), never as a real estate or tax play.
10. No emojis. No hype words ("game changer", "unlock", "skyrocket"). Plain, confident, operator voice.
11. Do not include URLs in any body. The system adds tracked links itself.
12. When a channel asks for several posts, each one must make a DIFFERENT point from the source (a different mistake, question, number, or consequence). Never the same idea reworded. Order them so they build over the two weeks.

CHANNEL STYLES:
- linkedin_company: Cobalt's company page. Audience is referral partners: CPAs, attorneys, bankers, wealth advisors. Angle: what they should watch for in their clients and when to make an introduction. 120 to 220 words, short paragraphs, at most 2 hashtags at the very end. Never use the line "advice is free".
- linkedin_curtis: Curtis's personal profile, first person "I". A practitioner's observation or point of view drawn from the source, not a summary. 80 to 180 words. Do not claim personal deal history that is not in the source.
- linkedin_armen: Armen's personal profile, first person "I". A different angle from Curtis (the negotiation, lender relationship, or structuring side). 80 to 180 words. Same restriction on claims.
- instagram: audience is business owners. A strong first line hook, then 50 to 110 words, end with "Full guide: link in bio." and 3 to 5 relevant hashtags.
- x: at most 240 characters each, no hashtags or one at most. Sharp, standalone points.
- email_owners: newsletter section for clients and owner contacts. subject (under 60 characters, specific, not clickbait) and body (120 to 200 words, plain paragraphs, ends by inviting a reply to talk through their situation). "Advice is free, execution isn't" may be used here sparingly.
- email_partners: newsletter section for referral partners (CPAs, attorneys, bankers). subject and body (120 to 200 words) about how this topic shows up in their clients and how Cobalt helps when they refer. Never use the line "advice is free".

PICTURES: every linkedin_company, linkedin_curtis, linkedin_armen, instagram and x post ALSO has image_spec for a branded picture card (no photos of people except the partner headshot, no stock imagery):
- kicker: 2 to 4 words, a label such as "CASH FLOW", "OWNER'S GUIDE", "FOR ADVISORS".
- headline: 6 to 12 words, the single idea of THAT post, written to stop the scroll. For linkedin_curtis and linkedin_armen it is a first person line in that partner's voice, shown as a quote beside his photo.
- stat: under 8 words, ONLY a figure or fact stated in the source, ideally starting with the number (e.g. "80% advance on eligible receivables"); otherwise empty string. Never invent a number.
- template: "number" when stat starts with a figure, otherwise "navy" or "light" (vary them across a channel's posts). Leave it empty for linkedin_curtis and linkedin_armen.

OUTPUT SHAPE: an object whose keys are the requested channels, each an array with EXACTLY the requested number of posts:
{
  "linkedin_company": [ { "body": "", "image_spec": { "kicker": "", "headline": "", "stat": "", "template": "" } } ],
  "instagram": [ { "body": "", "image_spec": { "kicker": "", "headline": "", "stat": "", "template": "" } } ],
  "email_owners": [ { "subject": "", "body": "" } ]
}`;

// ---------- auth ----------
async function authorize(req: Request, db: SupabaseClient): Promise<{ actor: string; cron: boolean } | null> {
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await db.rpc("mkt_check_cron_secret", { p_value: cronSecret });
    return ok ? { actor: "scheduler", cron: true } : null;
  }
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const { data } = await db.auth.getUser(token);
  return data?.user?.email ? { actor: data.user.email, cron: false } : null;
}

// ---------- website ----------
function htmlToText(html: string): string {
  const pick = html.match(/<main[\s\S]*?<\/main>/i)?.[0] || html.match(/<article[\s\S]*?<\/article>/i)?.[0] || html;
  return pick
    .replace(/<(script|style|nav|header|footer|form|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|h[1-6]|li|div|section|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, "\"").replace(/&#39;|&rsquo;|&lsquo;/g, "'").replace(/&ldquo;|&rdquo;/g, "\"").replace(/&[a-z]+;/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

function pageTitle(html: string): string {
  const t = html.match(/<title>([^<]*)<\/title>/i)?.[1] || "";
  return t.replace(/\s*\|\s*Cobalt Commercial Credit\s*$/i, "").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "'").trim();
}

function isCobaltUrl(url: string): boolean {
  try { return /^(www\.)?cobaltcommercialcredit\.com$/i.test(new URL(url).hostname); } catch { return false; }
}

function normUrl(url: string): string {
  try { const u = new URL(url); return (u.hostname.replace(/^www\./, "") + u.pathname).toLowerCase(); } catch { return url.toLowerCase(); }
}

async function fetchPage(url: string): Promise<{ title: string; text: string }> {
  if (!isCobaltUrl(url)) throw new Error("Source must be a page on cobaltcommercialcredit.com");
  const res = await fetch(url, { headers: { "User-Agent": "CobaltMarketing/1.0" } });
  if (!res.ok) throw new Error(`Website returned ${res.status} for ${url}`);
  const html = await res.text();
  return { title: pageTitle(html), text: htmlToText(html) };
}

// ---------- scheduling ----------
function laTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): string {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}

function localDate(iso: string, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
}

function businessDays(tz: string, count: number): Date[] {
  const [y, m, d] = localDate(new Date().toISOString(), tz).split("-").map(Number);
  const out: Date[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, d, 12));
  while (out.length < count) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(new Date(cursor));
  }
  return out;
}

// Spreads n posts per channel across the rollout window, skipping days that channel is already busy.
function planSlots(
  counts: Record<string, number>, span: number, times: Record<string, string>, tz: string, busy: Set<string>,
): Record<string, string[]> {
  const days = businessDays(tz, span + 30);
  const out: Record<string, string[]> = {};
  for (const ch of Object.keys(counts)) {
    const n = counts[ch];
    if (!n) continue;
    const start = START[ch] || { day: 0, slot: "linkedin" };
    const [hh, mm] = (times[start.slot] || "09:00").split(":").map(Number);
    out[ch] = [];
    for (let i = 0; i < n; i++) {
      let idx = Math.min(start.day + Math.floor((i * span) / n), days.length - 1);
      let key = "";
      while (idx < days.length) {
        const day = days[idx];
        key = `${ch}|${day.toISOString().slice(0, 10)}`;
        if (!busy.has(key)) break;
        idx++;
      }
      busy.add(key);
      const day = days[Math.min(idx, days.length - 1)];
      out[ch].push(laTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz));
    }
  }
  return out;
}

// ---------- model ----------
type Draft = { body?: string; subject?: string; image_spec?: Record<string, string> };

async function callModel(content: Record<string, any>, counts: Record<string, number>, instruction?: string): Promise<Record<string, Draft[]>> {
  const ask = Object.entries(counts).filter(([, n]) => n > 0).map(([ch, n]) => `${ch}: ${n} post${n > 1 ? "s" : ""}`).join("\n");
  const userMsg = [
    `Title: ${content.title}`,
    `Source type: ${content.source_type}`,
    `Primary audience: ${content.audience}`,
    "Write exactly these posts:",
    ask,
    instruction ? `Extra direction from Curtis for this draft: ${instruction}` : "",
    "",
    "SOURCE:",
    content.body,
  ].filter(Boolean).join("\n");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_API_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 8000, system: SYSTEM_PROMPT, messages: [{ role: "user", content: userMsg }] }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const out = await res.json();
  const text = (out.content || []).find((b: { type: string }) => b.type === "text")?.text || "";
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*|```\s*$/g, "").trim());
  // Accept the shapes models drift into: plain strings, "text"/"post" instead of "body",
  // "twitter" for x, or the arrays wrapped in a "posts" object.
  const root = parsed && typeof parsed === "object" && parsed.posts && typeof parsed.posts === "object" && !Array.isArray(parsed.posts) ? parsed.posts : parsed;
  const alias: Record<string, string> = { twitter: "x", x_twitter: "x", "x/twitter": "x" };
  const norm: Record<string, Draft[]> = {};
  for (const [rawKey, v] of Object.entries(root || {})) {
    const ch = alias[rawKey.toLowerCase()] || rawKey;
    const list = Array.isArray(v) ? v : [v];
    norm[ch] = list.map((item: any) => {
      if (typeof item === "string") return { body: item };
      if (item && typeof item === "object" && !item.body) return { ...item, body: item.text || item.post || item.content || "" };
      return item as Draft;
    });
  }
  return norm;
}

// Two smaller requests in parallel (long form channels, short form channels) keep each call fast.
async function draftAll(content: Record<string, any>, counts: Record<string, number>, instruction?: string) {
  const longForm: Record<string, number> = {}, shortForm: Record<string, number> = {};
  for (const [ch, n] of Object.entries(counts)) {
    if (!n) continue;
    (ch === "instagram" || ch === "x" ? shortForm : longForm)[ch] = n;
  }
  const jobs: Promise<Record<string, Draft[]>>[] = [];
  if (Object.keys(longForm).length) jobs.push(callModel(content, longForm, instruction));
  if (Object.keys(shortForm).length) jobs.push(callModel(content, shortForm, instruction));
  const results = await Promise.all(jobs);
  return Object.assign({}, ...results) as Record<string, Draft[]>;
}

// ---------- core drafting ----------
async function draftContent(
  db: SupabaseClient, contentId: string, actor: string,
  opts: { postId?: string; redraft?: boolean; fill?: boolean; instruction?: string },
) {
  const { data: content } = await db.from("mkt_content").select("*").eq("id", contentId).single();
  if (!content) throw Object.assign(new Error("Content item not found"), { status: 404 });

  const { data: cfgRows } = await db.from("mkt_config").select("key, value");
  const cfg = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  const times = cfg.default_times || {};
  const tz = times.tz || "America/Los_Angeles";
  const type = content.source_type in DEFAULT_COUNTS ? content.source_type : "guide";
  const fullCounts: Record<string, number> = { ...DEFAULT_COUNTS[type], ...((cfg.post_counts || {})[type] || {}) };
  const span = (cfg.rollout_days || {})[type] || DEFAULT_SPAN[type];

  const { data: existing } = await db.from("mkt_posts").select("id, channel, status, scheduled_for").eq("content_id", content.id);
  const open = (existing || []).filter((p) => p.status === "draft" || p.status === "rejected");

  // Work out what to write and which time slots it gets.
  let counts: Record<string, number> = {};
  let reuse: Record<string, string[]> | null = null;
  let replaceIds: string[] = [];
  if (opts.postId) {
    const p = open.find((x) => x.id === opts.postId);
    if (!p) throw Object.assign(new Error("Only a draft or rejected post can be redrafted"), { status: 409 });
    counts = { [p.channel]: 1 };
    reuse = { [p.channel]: [p.scheduled_for] };
    replaceIds = [p.id];
  } else if ((existing || []).length && opts.fill) {
    // Only write what is missing; leave every existing draft alone.
    for (const [ch, want] of Object.entries(fullCounts)) {
      const have = (existing || []).filter((p) => p.channel === ch && p.status !== "rejected").length;
      if (want > have) counts[ch] = want - have;
    }
    if (!Object.keys(counts).length) throw Object.assign(new Error("Nothing is missing for this source."), { status: 409 });
  } else if ((existing || []).length && opts.redraft) {
    reuse = {};
    for (const p of open) {
      counts[p.channel] = (counts[p.channel] || 0) + 1;
      (reuse[p.channel] = reuse[p.channel] || []).push(p.scheduled_for);
    }
    for (const ch of Object.keys(reuse)) reuse[ch].sort();
    replaceIds = open.map((p) => p.id);
    // Top up any channel that came back short last time (new time slots are planned for the extras).
    for (const [ch, want] of Object.entries(fullCounts)) {
      const have = (existing || []).filter((p) => p.channel === ch && p.status !== "rejected").length
        - open.filter((p) => p.channel === ch && p.status !== "rejected").length;
      const need = Math.max(0, want - have);
      if (need > (counts[ch] || 0)) counts[ch] = need;
    }
    if (!Object.values(counts).some((n) => n > 0)) throw Object.assign(new Error("Nothing open to redraft. Every post is approved or sent."), { status: 409 });
  } else if ((existing || []).length) {
    throw Object.assign(new Error("This source already has posts. Use Redraft instead."), { status: 409 });
  } else {
    counts = fullCounts;
  }

  await db.from("mkt_content").update({ status: "generating", generation_error: null }).eq("id", content.id);
  try {
    // Read the Guide from the website when no text was pasted.
    if ((content.body || "").trim().length < 200 && content.source_url) {
      const page = await fetchPage(content.source_url);
      if (page.text.length < 200) throw new Error("Could not find the article text on that page. Paste it instead.");
      content.body = page.text.slice(0, 40000);
      await db.from("mkt_content").update({ body: content.body }).eq("id", content.id);
    }
    if (!(content.body || "").trim()) throw new Error("This source has no text. Paste it or give the Guide's web address.");

    const drafted = await draftAll(content, counts, opts.instruction);

    // Reuse freed time slots first; plan new ones for anything beyond them.
    const slots: Record<string, string[]> = {};
    const extra: Record<string, number> = {};
    for (const [ch, n] of Object.entries(counts)) {
      const keep = (reuse && reuse[ch]) || [];
      slots[ch] = keep.slice(0, n);
      if (n > keep.length) extra[ch] = n - keep.length;
    }
    if (Object.keys(extra).length) {
      const { data: future } = await db.from("mkt_posts").select("id, channel, scheduled_for")
        .in("status", ["draft", "approved", "scheduled"]).gte("scheduled_for", new Date().toISOString());
      const busy = new Set((future || []).filter((f) => f.scheduled_for && !replaceIds.includes((f as any).id)).map((f) => `${f.channel}|${localDate(f.scheduled_for, tz)}`));
      const planned = planSlots(extra, span, times, tz, busy);
      for (const ch of Object.keys(planned)) slots[ch] = [...slots[ch], ...planned[ch]];
    }

    const linkBase = content.source_url || cfg.site_base_url || "https://cobaltcommercialcredit.com";
    const campaign = content.campaign_slug || slugify(content.title);
    const rows: Record<string, unknown>[] = [];
    const missing: string[] = [];
    for (const [ch, n] of Object.entries(counts)) {
      const list = (drafted[ch] || []).filter((d) => d && d.body);
      if (list.length < n) missing.push(`${ch} (${list.length} of ${n})`);
      list.slice(0, n).forEach((d, i) => {
        const id = crypto.randomUUID();
        const body = autoFix(d.body!);
        const subject = d.subject ? autoFix(d.subject) : null;
        const spec = d.image_spec
          ? { kicker: autoFix(d.image_spec.kicker || ""), headline: autoFix(d.image_spec.headline || ""), stat: autoFix(d.image_spec.stat || ""),
              ...(["navy", "number", "light"].includes(String(d.image_spec.template || "")) && !/curtis|armen/.test(ch) ? { template: d.image_spec.template } : {}) }
          : null;
        rows.push({
          id, content_id: content.id, channel: ch, body, subject, image_spec: spec,
          link_url: ch === "instagram" ? null : utmUrl(linkBase, ch, campaign, id),
          lint_flags: lint(ch, body, subject), status: "draft",
          scheduled_for: (slots[ch] || [])[i] || null,
        });
      });
    }
    if (!rows.length) throw new Error("The model returned no usable drafts. Try again.");

    if (replaceIds.length) await db.from("mkt_posts").delete().in("id", replaceIds);
    const { error: insErr } = await db.from("mkt_posts").insert(rows);
    if (insErr) throw new Error(`Could not save drafts: ${insErr.message}`);

    await db.from("mkt_content").update({ status: "in_review", campaign_slug: campaign, generation_error: missing.length ? `Short on: ${missing.join(", ")}` : null }).eq("id", content.id);
    await db.from("mkt_log").insert({
      content_id: content.id, event: opts.postId ? "redrafted_post" : opts.fill ? "filled_missing" : opts.redraft ? "redrafted" : "drafted", actor,
      detail: { posts: rows.length, missing, instruction: opts.instruction || null },
    });
    return { drafted: rows.length, missing };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    const back = (existing || []).length ? "in_review" : "draft";
    await db.from("mkt_content").update({ status: back, generation_error: msg }).eq("id", content.id);
    throw err;
  }
}

// ---------- discovery ----------
// Finds Guides published on the website that Cobalt Marketing has not seen, adds them as sources,
// and drafts the first one. Any others are drafted on following runs, one per run.
async function discover(db: SupabaseClient) {
  const { data: cfgRows } = await db.from("mkt_config").select("key, value");
  const cfg = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  const sitemap = cfg.website_sitemap || "https://www.cobaltcommercialcredit.com/sitemap.xml";
  const res = await fetch(sitemap, { headers: { "User-Agent": "CobaltMarketing/1.0" } });
  if (!res.ok) throw new Error(`Sitemap returned ${res.status}`);
  const xml = await res.text();
  const urls = [...xml.matchAll(/<loc>([^<]*\/guide-[a-z0-9-]+\.html)<\/loc>/gi)].map((m) => m[1].trim());

  const { data: known } = await db.from("mkt_content").select("id, source_url, status, origin");
  const seen = new Set((known || []).filter((k) => k.source_url).map((k) => normUrl(k.source_url)));
  const added: string[] = [];
  for (const url of urls) {
    if (seen.has(normUrl(url))) continue;
    let title = url.split("/").pop()!.replace(/^guide-|\.html$/g, "").replace(/-/g, " ");
    try { title = (await fetchPage(url)).title || title; } catch { /* keep slug title */ }
    const { data: ins } = await db.from("mkt_content").insert({
      title, source_type: "guide", source_url: url, body: "", audience: "both", status: "draft", origin: "website", created_by: "website",
    }).select("id").single();
    if (ins) { added.push(url); await db.from("mkt_log").insert({ content_id: ins.id, event: "guide_found", actor: "scheduler", detail: { url } }); }
  }

  // Draft one waiting website Guide per run. Guides listed at setup (created_by 'website' before this
  // feature) are drafted only on request; they carry origin 'website' but were inserted with status
  // 'draft' and no log entry, so only sources with a guide_found log entry are drafted automatically.
  const { data: found } = await db.from("mkt_log").select("content_id").eq("event", "guide_found");
  const autoIds = new Set((found || []).map((f) => f.content_id));
  const { data: waiting } = await db.from("mkt_content").select("id, created_at").eq("origin", "website").eq("status", "draft").order("created_at");
  const next = (waiting || []).find((w) => autoIds.has(w.id));
  let drafted: unknown = null;
  if (next) {
    const { count } = await db.from("mkt_posts").select("id", { count: "exact", head: true }).eq("content_id", next.id);
    if (!count) drafted = { content_id: next.id, ...(await draftContent(db, next.id, "scheduler", {})) };
  }
  return { guides_on_site: urls.length, added, drafted };
}

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403);
  if (!ANTHROPIC_API_KEY) return json({ error: "Server misconfigured: ANTHROPIC_API_KEY is not set" }, 500);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  const who = await authorize(req, db);
  if (!who) return json({ error: "Sign in to Cobalt Marketing to draft posts" }, 401);

  let input: { action?: string; content_id?: string; post_id?: string; redraft?: boolean; fill?: boolean; instruction?: string };
  try { input = await req.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }

  try {
    if (input.action === "discover") return json(await discover(db));
    if (!input.content_id) return json({ error: "Missing content_id" }, 400);
    const r = await draftContent(db, input.content_id, who.actor, {
      postId: input.post_id, redraft: !!input.redraft, fill: !!input.fill, instruction: input.instruction,
    });
    return json(r);
  } catch (err) {
    const status = (err as { status?: number }).status || 502;
    return json({ error: String(err instanceof Error ? err.message : err) }, status);
  }
});
