// supabase/functions/marketing-draft/index.ts
//
// Cobalt Marketing drafting engine. Takes one approved source item (usually a website Guide)
// and drafts a post for every marketing channel, following Cobalt's brand and compliance rules.
// Drafts land in mkt_posts as "draft". Nothing is published here; a human approves each post.
//
// Body: { content_id: string, channels?: string[], instruction?: string }
//   channels    : redraft only these channels (default: all channels)
//   instruction : extra direction for a redraft, e.g. "shorter" or "lead with the cash flow problem"

import { createClient } from "npm:@supabase/supabase-js@2";
import { autoFix, lint, slugify, utmUrl } from "./rules.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = ["https://cobaltcommercialcredit.github.io"];

const ALL_CHANNELS = [
  "linkedin_company", "linkedin_curtis", "linkedin_armen", "instagram", "x", "email_owners", "email_partners",
];

// Business day offset and time slot key for each channel, so one Guide rolls out over a few days
// instead of hitting every feed at once.
const ROLLOUT: Record<string, { day: number; slot: string }> = {
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

function signedInEmail(req: Request): string | null {
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const p = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return p.role === "authenticated" && p.sub ? (p.email || p.sub) : null;
  } catch {
    return null;
  }
}

const SYSTEM_PROMPT = `You are the marketing writer for Cobalt Commercial Credit, a capital execution firm that sources, structures, and places financing for privately held, owner operated businesses (roughly $2M to $20M in revenue: manufacturing, distribution, professional practices, owner occupied real estate, government contractors). Cobalt works nationwide. Its principals are Curtis Hollowell and Armen Grigorian, both Managing Partners.

You turn one source article into channel specific posts. Return ONLY a raw JSON object, no code fences, no commentary.

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

CHANNELS:
- linkedin_company: Cobalt's company page. Audience is referral partners: CPAs, attorneys, bankers, wealth advisors. Angle: what they should watch for in their clients and when to make an introduction. 120 to 220 words, short paragraphs, at most 2 hashtags at the very end. Never use the line "advice is free".
- linkedin_curtis: Curtis's personal profile, first person "I". A practitioner's observation or point of view drawn from the source, not a summary. 80 to 180 words. Do not claim personal deal history that is not in the source.
- linkedin_armen: Armen's personal profile, first person "I". A different angle from Curtis (for example, the negotiation, lender relationship, or structuring side). 80 to 180 words. Same restriction on claims.
- instagram: audience is business owners. A strong first line hook, then 50 to 110 words, end with "Full guide: link in bio." and 3 to 5 relevant hashtags. Also return image_spec for a branded text card: kicker (2 to 4 words, a label like "CASH FLOW" or "OWNER'S GUIDE"), headline (6 to 12 words, the core idea), and stat (optional, under 7 words, ONLY if a figure or fact appears in the source; otherwise empty string).
- x: one post, at most 240 characters, no hashtags or one at most. A sharp, standalone point.
- email_owners: newsletter section for clients and owner contacts. subject (under 60 characters, specific, not clickbait) and body (120 to 200 words, plain paragraphs, ends by inviting a reply to talk through their situation). "Advice is free, execution isn't" may be used here sparingly.
- email_partners: newsletter section for referral partners (CPAs, attorneys, bankers). subject and body (120 to 200 words) about how this topic shows up in their clients and how Cobalt helps when they refer. Never use the line "advice is free".

OUTPUT SHAPE (include only the channels requested):
{
  "linkedin_company": { "body": "" },
  "linkedin_curtis": { "body": "" },
  "linkedin_armen": { "body": "" },
  "instagram": { "body": "", "image_spec": { "kicker": "", "headline": "", "stat": "" } },
  "x": { "body": "" },
  "email_owners": { "subject": "", "body": "" },
  "email_partners": { "subject": "", "body": "" }
}`;

// Pulls readable article text out of a website page: prefers <main> or <article>, drops menus and scripts.
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

// Converts a wall clock time in America/Los_Angeles to a UTC ISO string, DST aware.
function laTimeToUtc(y: number, m: number, d: number, hh: number, mm: number, tz: string): string {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(guess)).map((p) => [p.type, p.value]));
  const asIfUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute);
  return new Date(guess - (asIfUtc - guess)).toISOString();
}

function rolloutTimes(times: Record<string, string>, tz: string): Record<string, string> {
  // Day 0 is the next business day in the team's time zone.
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const [y, m, d] = fmt.format(now).split("-").map(Number);
  const businessDays: Date[] = [];
  const cursor = new Date(Date.UTC(y, m - 1, d, 12));
  while (businessDays.length < 6) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const dow = cursor.getUTCDay();
    if (dow !== 0 && dow !== 6) businessDays.push(new Date(cursor));
  }
  const out: Record<string, string> = {};
  for (const ch of ALL_CHANNELS) {
    const r = ROLLOUT[ch];
    const day = businessDays[r.day];
    const [hh, mm] = (times[r.slot] || "09:00").split(":").map(Number);
    out[ch] = laTimeToUtc(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hh, mm, tz);
  }
  return out;
}

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403);
  const actor = signedInEmail(req);
  if (!actor) return json({ error: "Sign in to Cobalt Marketing to draft posts" }, 401);
  if (!ANTHROPIC_API_KEY) return json({ error: "Server misconfigured: ANTHROPIC_API_KEY is not set" }, 500);

  let input: { content_id?: string; channels?: string[]; instruction?: string };
  try { input = await req.json(); } catch { return json({ error: "Request body must be JSON" }, 400); }
  if (!input.content_id) return json({ error: "Missing content_id" }, 400);

  const channels = (input.channels && input.channels.length ? input.channels : ALL_CHANNELS)
    .filter((c) => ALL_CHANNELS.includes(c));
  if (!channels.length) return json({ error: "No valid channels requested" }, 400);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const { data: content, error: cErr } = await db.from("mkt_content").select("*").eq("id", input.content_id).single();
  if (cErr || !content) return json({ error: "Content item not found" }, 404);

  // Do not overwrite posts that a human already approved or that went out.
  const { data: existing } = await db.from("mkt_posts").select("id, channel, status").eq("content_id", content.id);
  const locked = new Set((existing || []).filter((p) => p.status !== "draft" && p.status !== "rejected").map((p) => p.channel));
  const toDraft = channels.filter((c) => !locked.has(c));
  if (!toDraft.length) {
    return json({ error: "Every requested channel already has an approved or sent post for this item." }, 409);
  }

  await db.from("mkt_content").update({ status: "generating", generation_error: null }).eq("id", content.id);

  // No pasted text: read the Guide from the Cobalt website and keep the text on the record.
  if ((content.body || "").trim().length < 200 && content.source_url) {
    try {
      const u = new URL(content.source_url);
      if (!/^(www\.)?cobaltcommercialcredit\.com$/i.test(u.hostname)) throw new Error("Source must be a page on cobaltcommercialcredit.com");
      const page = await fetch(u.toString(), { headers: { "User-Agent": "CobaltMarketing/1.0" } });
      if (!page.ok) throw new Error(`Website returned ${page.status}`);
      const text = htmlToText(await page.text());
      if (text.length < 200) throw new Error("Could not find the article text on that page. Paste it instead.");
      content.body = text.slice(0, 40000);
      await db.from("mkt_content").update({ body: content.body }).eq("id", content.id);
    } catch (err) {
      await db.from("mkt_content").update({ status: "draft", generation_error: String(err instanceof Error ? err.message : err) }).eq("id", content.id);
      return json({ error: String(err instanceof Error ? err.message : err) }, 422);
    }
  }

  const userMsg = [
    `Title: ${content.title}`,
    `Source type: ${content.source_type}`,
    `Primary audience: ${content.audience}`,
    `Channels to write: ${toDraft.join(", ")}`,
    input.instruction ? `Extra direction from Curtis for this draft: ${input.instruction}` : "",
    "",
    "SOURCE:",
    content.body,
  ].filter(Boolean).join("\n");

  let drafted: Record<string, { body?: string; subject?: string; image_spec?: Record<string, string> }>;
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-5",
        max_tokens: 4000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: userMsg }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${await res.text()}`);
    const out = await res.json();
    const text = (out.content || []).find((b: { type: string }) => b.type === "text")?.text || "";
    drafted = JSON.parse(text.replace(/^```(?:json)?\s*|```\s*$/g, "").trim());
  } catch (err) {
    await db.from("mkt_content").update({ status: "draft", generation_error: String(err).slice(0, 500) }).eq("id", content.id);
    return json({ error: "Drafting failed", detail: String(err) }, 502);
  }

  const { data: cfgRows } = await db.from("mkt_config").select("key, value");
  const cfg = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  const times = cfg.default_times || {};
  const tz = times.tz || "America/Los_Angeles";
  const schedule = rolloutTimes(times, tz);
  const linkBase = content.source_url || cfg.site_base_url || "https://cobaltcommercialcredit.com";
  const campaign = content.campaign_slug || slugify(content.title);

  // Replace prior drafts for these channels, then insert the new ones.
  const staleIds = (existing || []).filter((p) => toDraft.includes(p.channel) && (p.status === "draft" || p.status === "rejected")).map((p) => p.id);
  if (staleIds.length) await db.from("mkt_posts").delete().in("id", staleIds);

  const rows = [];
  const missing: string[] = [];
  for (const ch of toDraft) {
    const d = drafted[ch];
    if (!d || !d.body) { missing.push(ch); continue; }
    const id = crypto.randomUUID();
    const body = autoFix(d.body);
    const subject = d.subject ? autoFix(d.subject) : null;
    const spec = d.image_spec
      ? { kicker: autoFix(d.image_spec.kicker || ""), headline: autoFix(d.image_spec.headline || ""), stat: autoFix(d.image_spec.stat || "") }
      : null;
    rows.push({
      id,
      content_id: content.id,
      channel: ch,
      body,
      subject,
      image_spec: spec,
      link_url: ch === "instagram" ? null : utmUrl(linkBase, ch, campaign, id),
      lint_flags: lint(ch, body, subject),
      status: "draft",
      scheduled_for: schedule[ch],
    });
  }

  if (rows.length) {
    const { error: insErr } = await db.from("mkt_posts").insert(rows);
    if (insErr) return json({ error: "Could not save drafts", detail: insErr.message }, 500);
  }

  await db.from("mkt_content").update({ status: "in_review", campaign_slug: campaign }).eq("id", content.id);
  await db.from("mkt_log").insert({
    content_id: content.id, event: "drafted", actor,
    detail: { channels: rows.map((r) => r.channel), missing, instruction: input.instruction || null },
  });

  return json({ drafted: rows.length, missing, posts: rows.map((r) => ({ id: r.id, channel: r.channel })) });
});
