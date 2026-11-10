// supabase/functions/marketing-publish/index.ts
//
// Cobalt Marketing publisher. Two callers:
//   1. The scheduler (pg_cron every 15 min) with header x-cron-secret: {"action":"sweep"}
//   2. A signed-in team member from the Cobalt Marketing tool:
//        {"action":"publish_now","post_id":"..."}   push one approved post immediately
//        {"action":"buffer_channels"}              list Buffer channels for the settings page
//        {"action":"mailerlite_groups"}            list MailerLite groups for the settings page
//        {"action":"test"}                         check both API keys
//
// Social posts stay inside Cobalt Marketing (editable, cancellable) until about 20 minutes before
// their scheduled time, then get handed to Buffer with that exact time. Email campaigns are handed
// to MailerLite as soon as they are approved.

import { createClient, SupabaseClient } from "npm:@supabase/supabase-js@2";
import { hasBlock, lint } from "./rules.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ALLOWED_ORIGINS = ["https://cobaltcommercialcredit.github.io"];
const HANDOFF_WINDOW_MIN = 20;
const BUFFER_URL = "https://api.buffer.com";
const ML_URL = "https://connect.mailerlite.com/api";

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

type Post = {
  id: string; content_id: string; channel: string; body: string; subject: string | null;
  image_url: string | null; link_url: string | null; status: string; scheduled_for: string | null;
  external_id: string | null;
};

// ---------- secrets ----------
async function secret(db: SupabaseClient, name: string): Promise<string | null> {
  const { data } = await db.rpc("mkt_get_secret", { p_name: name });
  return (data as string) || null;
}

// ---------- Buffer ----------
async function buffer(key: string, query: string, variables: Record<string, unknown> = {}) {
  const res = await fetch(BUFFER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
    body: JSON.stringify({ query, variables }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || out.errors) throw new Error(`Buffer: ${JSON.stringify(out.errors || out).slice(0, 400)}`);
  return out.data;
}

function composeSocial(p: Post): string {
  if (p.channel === "instagram" || !p.link_url) return p.body;
  return `${p.body}\n\n${p.link_url}`;
}

async function pushToBuffer(key: string, p: Post, channelId: string): Promise<{ id: string }> {
  const due = p.scheduled_for ? new Date(p.scheduled_for) : new Date();
  const now = Date.now();
  const input: Record<string, unknown> = {
    text: composeSocial(p),
    channelId,
    schedulingType: "automatic",
  };
  if (due.getTime() > now + 2 * 60 * 1000) {
    input.mode = "customScheduled";
    input.dueAt = due.toISOString();
  } else {
    input.mode = "shareNow";
  }
  if (p.channel === "instagram" && !p.image_url) throw new Error("Instagram post has no image. Open it in Cobalt Marketing and approve it again to build the card.");
  if (p.image_url) input.assets = [{ image: { url: p.image_url } }];
  if (p.channel === "instagram") {
    input.metadata = { instagram: { type: "post", shouldShareToFeed: true } };
  }
  const data = await buffer(
    key,
    `mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id dueAt } }
        ... on MutationError { message }
      }
    }`,
    { input },
  );
  const r = data?.createPost;
  if (!r?.post?.id) throw new Error(`Buffer rejected the post: ${r?.message || "no post id returned"}`);
  return { id: r.post.id };
}

async function bufferPostIdsByStatus(key: string, orgId: string, channelIds: string[], status: string): Promise<Set<string>> {
  // Built inline (not as typed variables) because the input type names are not documented.
  // status is a GraphQL enum, so it is written unquoted; it is only ever "sent" or "error" from this file.
  if (!/^[a-z]+$/.test(status)) throw new Error("bad status");
  const data = await buffer(
    key,
    `query {
      posts(first: 100, input: { organizationId: ${JSON.stringify(orgId)}, filter: { status: ${status}, channelIds: ${JSON.stringify(channelIds)} } }) {
        edges { node { id } }
      }
    }`,
  );
  return new Set((data?.posts?.edges || []).map((e: { node: { id: string } }) => e.node.id));
}

// ---------- MailerLite ----------
async function ml(key: string, path: string, init: RequestInit = {}) {
  const res = await fetch(`${ML_URL}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", "Accept": "application/json", "Authorization": `Bearer ${key}`, ...(init.headers || {}) },
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`MailerLite ${res.status}: ${JSON.stringify(out).slice(0, 400)}`);
  return out;
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function emailHtml(p: Post): string {
  const paras = p.body.split(/\n{2,}/).map((x) => `<p style="margin:0 0 16px;font:16px/1.6 Arial,Helvetica,sans-serif;color:#1d2433">${escapeHtml(x).replace(/\n/g, "<br>")}</p>`).join("");
  const link = p.link_url
    ? `<p style="margin:24px 0"><a href="${p.link_url}" style="background:#0047AB;color:#fff;text-decoration:none;padding:12px 20px;border-radius:4px;font:600 15px Arial,Helvetica,sans-serif">Read the full guide</a></p>`
    : "";
  const footer = `<p style="margin:32px 0 0;font:12px/1.5 Arial,Helvetica,sans-serif;color:#6b7280">Cobalt Commercial Credit, 23 Corporate Plaza, Ste 150, Newport Beach, CA 92660, United States.<br><a href="{$unsubscribe}" style="color:#6b7280">Unsubscribe</a></p>`;
  return `<!doctype html><html><body style="margin:0;background:#f5f7fa"><table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px"><table width="600" cellpadding="0" cellspacing="0" style="background:#fff;padding:32px;border-top:4px solid #002347"><tr><td>${paras}${link}${footer}</td></tr></table></td></tr></table></body></html>`;
}

function laParts(iso: string, tz: string) {
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hours: p.hour, minutes: p.minute };
}

async function pushToMailerLite(
  key: string, p: Post, groupIds: string[], cfg: Record<string, any>,
): Promise<{ id: string; status: string; url: string }> {
  const from = cfg.email_from || { name: "Cobalt Commercial Credit", address: "contact@cobaltcommercialcredit.com" };
  const customHtml = cfg.mailerlite_custom_html === true;
  const email: Record<string, unknown> = { subject: p.subject || "Cobalt Commercial Credit", from_name: from.name, from: from.address };
  if (customHtml) email.content = emailHtml(p);
  const created = await ml(key, "/campaigns", {
    method: "POST",
    body: JSON.stringify({ name: `Cobalt Marketing: ${p.subject || p.id.slice(0, 8)}`, type: "regular", emails: [email], groups: groupIds }),
  });
  const id = String(created?.data?.id || "");
  if (!id) throw new Error("MailerLite did not return a campaign id");
  const url = `https://dashboard.mailerlite.com/campaigns/${id}/edit`;

  if (!customHtml) {
    // The MailerLite plan does not accept HTML through the API. The campaign is created as a draft
    // with subject, sender and audience set; the body is pasted in MailerLite's editor.
    return { id, status: "needs_finish", url };
  }
  const tz = (cfg.default_times && cfg.default_times.tz) || "America/Los_Angeles";
  const when = p.scheduled_for && new Date(p.scheduled_for).getTime() > Date.now() + 10 * 60 * 1000 ? p.scheduled_for : null;
  const body = when
    ? { delivery: "scheduled", schedule: laParts(when, tz) }
    : { delivery: "instant" };
  await ml(key, `/campaigns/${id}/schedule`, { method: "POST", body: JSON.stringify(body) });
  return { id, status: "scheduled", url };
}

// ---------- CRM to MailerLite list sync ----------
// Each person lands in exactly one list. Profession wins: a CPA, attorney, wealth advisor or active COI
// goes to the partner list even if their company is also a client.
const PARTNER_ROLES = ["COI", "CPA", "Attorney", "Wealth advisor"];
const BLOCKED_STATUSES = ["Do Not Contact", "Dead"];
type Member = { email: string; list: "owners" | "partners"; contact_id: string; name: string; first: string; last: string; company: string };

async function computeLists(db: SupabaseClient, rules: Record<string, any>) {
  const clientStatuses: string[] = rules.client_statuses || ["Client", "Qualified", "Working", "Nurture"];
  const includeLenders = rules.include_lenders === true;
  const [{ data: contacts }, { data: companies }] = await Promise.all([
    db.from("crm_contacts").select("id, company_id, first_name, last_name, email, roles, referral_partner_id, do_not_contact, email_opt_out"),
    db.from("crm_companies").select("id, name, status, kind, do_not_contact, conflict_flag"),
  ]);
  const coById = new Map((companies || []).map((c) => [c.id, c]));
  const out = new Map<string, Member>();
  const skipped: Record<string, number> = { no_email: 0, opted_out: 0, blocked: 0, prospect_or_other: 0 };
  for (const c of contacts || []) {
    const email = String(c.email || "").trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) { skipped.no_email++; continue; }
    if (c.email_opt_out) { skipped.opted_out++; continue; }
    const co: any = c.company_id ? coById.get(c.company_id) : null;
    if (c.do_not_contact || co?.do_not_contact || co?.conflict_flag || (co && BLOCKED_STATUSES.includes(co.status))) { skipped.blocked++; continue; }
    const roles: string[] = Array.isArray(c.roles) ? c.roles : [];
    const isLender = roles.includes("Lender") || co?.kind === "lender";
    const isPartner = !!c.referral_partner_id || roles.some((r) => PARTNER_ROLES.includes(r)) || (includeLenders && isLender);
    let list: "owners" | "partners" | null = null;
    if (isPartner) list = "partners";
    else if (!isLender && co && (co.kind || "company") === "company" && clientStatuses.includes(co.status)) list = "owners";
    if (!list) { skipped.prospect_or_other++; continue; }
    if (out.has(email)) { if (list === "partners") out.get(email)!.list = "partners"; continue; }
    const first = c.first_name || "", last = c.last_name || "";
    out.set(email, { email, list, contact_id: c.id, first, last, name: `${first} ${last}`.trim(), company: co?.name || "" });
  }
  return { members: [...out.values()], skipped };
}

async function syncLists(db: SupabaseClient, key: string, ctx: Awaited<ReturnType<typeof loadContext>>, apply: boolean) {
  const rules = ctx.cfg.list_rules || {};
  const { members, skipped } = await computeLists(db, rules);
  const groupOf = (k: string) => String(ctx.chMap[k]?.external_ref || "").split(",").map((s) => s.trim()).filter(Boolean)[0] || null;
  const groups: Record<string, string | null> = { owners: groupOf("email_owners"), partners: groupOf("email_partners") };
  const { data: existing } = await db.from("mkt_list_members").select("*");
  const prev = new Map((existing || []).map((m) => [m.email, m]));
  const want = new Map(members.map((m) => [m.email, m]));
  const toAdd = members.filter((m) => !prev.has(m.email) || prev.get(m.email)!.list !== m.list);
  const toRemove = (existing || []).filter((m) => !want.has(m.email));
  const summary = {
    owners: members.filter((m) => m.list === "owners").map((m) => ({ name: m.name, company: m.company })),
    partners: members.filter((m) => m.list === "partners").map((m) => ({ name: m.name, company: m.company })),
    adding: toAdd.length, removing: toRemove.length, skipped,
    groups_linked: !!(groups.owners && groups.partners),
    unsubscribed: 0, errors: [] as string[],
  };
  if (!apply) return summary;
  if (!summary.groups_linked) throw new Error("Link both email channels to a MailerLite group in Settings first");

  // People who unsubscribed in MailerLite: mark them opted out in the CRM and drop them.
  for (const m of existing || []) {
    try {
      const s = await ml(key, `/subscribers/${encodeURIComponent(m.email)}`);
      const st = s?.data?.status;
      if (st === "unsubscribed" || st === "bounced" || st === "junk") {
        if (m.contact_id) await db.from("crm_contacts").update({ email_opt_out: true }).eq("id", m.contact_id);
        await db.from("mkt_list_members").delete().eq("email", m.email);
        want.delete(m.email); summary.unsubscribed++;
      }
    } catch { /* not found in MailerLite; it will be re-added below if still wanted */ }
  }

  for (const m of toAdd) {
    if (!want.has(m.email)) continue;
    try {
      const old = prev.get(m.email);
      // Status is never sent, so MailerLite keeps anyone who unsubscribed unsubscribed.
      const r = await ml(key, "/subscribers", {
        method: "POST",
        body: JSON.stringify({ email: m.email, fields: { name: m.first, last_name: m.last, company: m.company }, groups: [groups[m.list]] }),
      });
      const sid = String(r?.data?.id || old?.ml_subscriber_id || "");
      if (old && old.list !== m.list && sid && groups[old.list]) {
        await ml(key, `/subscribers/${sid}/groups/${groups[old.list]}`, { method: "DELETE" }).catch(() => {});
      }
      await db.from("mkt_list_members").upsert({ email: m.email, list: m.list, contact_id: m.contact_id, name: m.name, ml_subscriber_id: sid || null, synced_at: new Date().toISOString() });
    } catch (e) { summary.errors.push(`${m.email}: ${String(e).slice(0, 120)}`); }
  }
  for (const m of toRemove) {
    try {
      if (m.ml_subscriber_id && groups[m.list]) await ml(key, `/subscribers/${m.ml_subscriber_id}/groups/${groups[m.list]}`, { method: "DELETE" });
      await db.from("mkt_list_members").delete().eq("email", m.email);
    } catch (e) { summary.errors.push(`${m.email}: ${String(e).slice(0, 120)}`); }
  }
  const last = { at: new Date().toISOString(), owners: summary.owners.length, partners: summary.partners.length, added: summary.adding, removed: summary.removing, unsubscribed: summary.unsubscribed, errors: summary.errors.length };
  await db.from("mkt_config").upsert({ key: "list_sync_last", value: last });
  await db.from("mkt_log").insert({ event: "lists_synced", actor: "sync", detail: last });
  return summary;
}

// ---------- core ----------
async function loadContext(db: SupabaseClient) {
  const [{ data: channels }, { data: cfgRows }] = await Promise.all([
    db.from("mkt_channels").select("*"),
    db.from("mkt_config").select("key, value"),
  ]);
  const chMap = Object.fromEntries((channels || []).map((c) => [c.key, c]));
  const cfg = Object.fromEntries((cfgRows || []).map((r) => [r.key, r.value]));
  return { chMap, cfg };
}

async function log(db: SupabaseClient, p: Post | null, event: string, actor: string, detail: Record<string, unknown> = {}) {
  await db.from("mkt_log").insert({ post_id: p?.id || null, content_id: p?.content_id || null, event, actor, detail });
}

async function publishOne(db: SupabaseClient, p: Post, actor: string, keys: { buffer: string | null; ml: string | null }, ctx: Awaited<ReturnType<typeof loadContext>>) {
  const ch = ctx.chMap[p.channel];
  try {
    // Re-check rules at hand off time in case a post was edited after approval.
    const flags = lint(p.channel, p.body, p.subject);
    if (hasBlock(flags)) throw new Error("Blocked by brand or compliance rules: " + flags.filter((f) => f.level === "block").map((f) => f.message).join(" "));
    if (!ch || !ch.enabled) throw new Error(`Channel ${p.channel} is not enabled in Settings`);
    if (!ch.external_ref && ch.provider !== "manual") throw new Error(`Channel ${p.channel} is not linked to an account in Settings`);

    if (ch.provider === "manual") {
      // Personal profiles: the person posts it themselves. It shows in Needs attention with Copy text and Mark posted.
      await db.from("mkt_posts").update({ status: "needs_finish", error: null }).eq("id", p.id);
      await log(db, p, "ready_to_post_by_hand", actor, { due: p.scheduled_for });
    } else if (ch.provider === "buffer") {
      if (!keys.buffer) throw new Error("Buffer API key is not set in Settings");
      const r = await pushToBuffer(keys.buffer, p, ch.external_ref);
      await db.from("mkt_posts").update({ status: "scheduled", external_id: r.id, error: null }).eq("id", p.id);
      await log(db, p, "handed_to_buffer", actor, { buffer_post_id: r.id, due: p.scheduled_for });
    } else {
      if (!keys.ml) throw new Error("MailerLite API key is not set in Settings");
      const groups = String(ch.external_ref).split(",").map((s) => s.trim()).filter(Boolean);
      const r = await pushToMailerLite(keys.ml, p, groups, ctx.cfg);
      await db.from("mkt_posts").update({ status: r.status, external_id: r.id, external_url: r.url, error: null }).eq("id", p.id);
      await log(db, p, r.status === "needs_finish" ? "mailerlite_draft_created" : "handed_to_mailerlite", actor, { campaign_id: r.id });
    }
    return { id: p.id, ok: true };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 800);
    await db.from("mkt_posts").update({ status: "failed", error: msg }).eq("id", p.id);
    await log(db, p, "publish_failed", actor, { error: msg });
    return { id: p.id, ok: false, error: msg };
  }
}

async function sweep(db: SupabaseClient) {
  const keys = { buffer: await secret(db, "BUFFER_API_KEY"), ml: await secret(db, "MAILERLITE_API_KEY") };
  const ctx = await loadContext(db);
  const cutoff = new Date(Date.now() + HANDOFF_WINDOW_MIN * 60 * 1000).toISOString();
  const results: unknown[] = [];

  // 1. Hand off approved posts that are due (social) or any approved email.
  const { data: due } = await db.from("mkt_posts").select("*").eq("status", "approved").is("external_id", null);
  for (const p of (due || []) as Post[]) {
    const isEmail = p.channel.startsWith("email");
    if (!isEmail && p.scheduled_for && p.scheduled_for > cutoff) continue;
    results.push(await publishOne(db, p, "scheduler", keys, ctx));
  }

  // 2. Sync Buffer status for posts already handed off. Once an hour (the first sweep after the hour),
  //    which keeps well inside Buffer's daily API limits on any plan.
  const orgId = ctx.cfg.buffer_org_id;
  if (keys.buffer && orgId && new Date().getUTCMinutes() < 15) {
    const { data: pending } = await db.from("mkt_posts").select("*").eq("status", "scheduled").not("external_id", "is", null);
    const social = ((pending || []) as Post[]).filter((p) => !p.channel.startsWith("email"));
    if (social.length) {
      const channelIds = [...new Set(social.map((p) => ctx.chMap[p.channel]?.external_ref).filter(Boolean))] as string[];
      try {
        const sent = await bufferPostIdsByStatus(keys.buffer, orgId, channelIds, "sent");
        let errored = new Set<string>();
        try { errored = await bufferPostIdsByStatus(keys.buffer, orgId, channelIds, "error"); } catch { /* status name may differ; sent sync still works */ }
        for (const p of social) {
          if (sent.has(p.external_id!)) {
            await db.from("mkt_posts").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", p.id);
            await log(db, p, "sent", "buffer");
          } else if (errored.has(p.external_id!)) {
            await db.from("mkt_posts").update({ status: "failed", error: "Buffer reported a publishing error. Check the channel connection in Buffer." }).eq("id", p.id);
            await log(db, p, "publish_failed", "buffer");
          }
        }
      } catch (err) {
        results.push({ sync_error: String(err).slice(0, 300) });
      }
    }
  }

  // 3. Sync MailerLite campaigns.
  if (keys.ml) {
    const { data: mails } = await db.from("mkt_posts").select("*").in("status", ["scheduled", "needs_finish"]).like("channel", "email%").not("external_id", "is", null);
    for (const p of (mails || []) as Post[]) {
      try {
        const c = await ml(keys.ml, `/campaigns/${p.external_id}`);
        const st = c?.data?.status;
        if (st === "sent") {
          await db.from("mkt_posts").update({ status: "sent", sent_at: c?.data?.finished_at || new Date().toISOString() }).eq("id", p.id);
          await log(db, p, "sent", "mailerlite");
        } else if (st === "ready" && p.status === "needs_finish") {
          await db.from("mkt_posts").update({ status: "scheduled" }).eq("id", p.id);
          await log(db, p, "finished_in_mailerlite", "mailerlite");
        }
      } catch (err) {
        results.push({ id: p.id, sync_error: String(err).slice(0, 300) });
      }
    }
  }

  // 4. Once a day (first sweep after 7am Pacific), refresh the email lists from the CRM.
  const laHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "numeric", hourCycle: "h23" }).format(new Date()));
  if (keys.ml && (ctx.cfg.list_rules || {}).auto_sync !== false && laHour === 7 && new Date().getUTCMinutes() < 15) {
    try {
      const r = await syncLists(db, keys.ml, ctx, true);
      results.push({ lists: { owners: r.owners.length, partners: r.partners.length, errors: r.errors.length } });
    } catch (err) {
      results.push({ list_sync_error: String(err).slice(0, 300) });
    }
  }

  // 5. Mark source items done when every post is sent or rejected.
  const { data: open } = await db.from("mkt_content").select("id").eq("status", "in_review");
  for (const c of open || []) {
    const { data: ps } = await db.from("mkt_posts").select("status").eq("content_id", c.id);
    if (ps && ps.length && ps.every((x) => x.status === "sent" || x.status === "rejected")) {
      await db.from("mkt_content").update({ status: "done" }).eq("id", c.id);
    }
  }
  return results;
}

Deno.serve(async (req: Request) => {
  const CORS = corsHeaders(req);
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });
  let body: { action?: string; post_id?: string } = {};
  try { body = await req.json(); } catch { /* empty body */ }

  // Scheduler path
  const cronSecret = req.headers.get("x-cron-secret");
  if (cronSecret) {
    const { data: ok } = await db.rpc("mkt_check_cron_secret", { p_value: cronSecret });
    if (!ok) return json({ error: "Bad scheduler secret" }, 401);
    const results = await sweep(db);
    return json({ swept: true, results });
  }

  // Team member path: verify the session token with Supabase Auth.
  const origin = req.headers.get("origin");
  if (origin && !ALLOWED_ORIGINS.includes(origin)) return json({ error: "Origin not allowed" }, 403);
  const token = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const { data: userData } = await db.auth.getUser(token);
  const actor = userData?.user?.email;
  if (!actor) return json({ error: "Sign in to Cobalt Marketing first" }, 401);

  try {
    switch (body.action) {
      case "publish_now": {
        if (!body.post_id) return json({ error: "Missing post_id" }, 400);
        const { data: p } = await db.from("mkt_posts").select("*").eq("id", body.post_id).single();
        if (!p) return json({ error: "Post not found" }, 404);
        if (p.status !== "approved") return json({ error: "Only approved posts can be published" }, 409);
        const keys = { buffer: await secret(db, "BUFFER_API_KEY"), ml: await secret(db, "MAILERLITE_API_KEY") };
        const r = await publishOne(db, { ...p, scheduled_for: new Date().toISOString() }, actor, keys, await loadContext(db));
        return json(r, r.ok ? 200 : 502);
      }
      case "buffer_channels": {
        const key = await secret(db, "BUFFER_API_KEY");
        if (!key) return json({ error: "Save your Buffer API key first" }, 400);
        const orgs = await buffer(key, `query { account { organizations { id name } } }`);
        const list = orgs?.account?.organizations || [];
        if (!list.length) return json({ error: "No Buffer organization found on this key" }, 404);
        const orgId = list[0].id;
        await db.from("mkt_config").upsert({ key: "buffer_org_id", value: orgId });
        const ch = await buffer(
          key,
          `query GetChannels($organizationId: OrganizationId!) { channels(input: { organizationId: $organizationId }) { id name service } }`,
          { organizationId: orgId },
        );
        return json({ organization: list[0], channels: ch?.channels || [] });
      }
      case "mailerlite_groups": {
        const key = await secret(db, "MAILERLITE_API_KEY");
        if (!key) return json({ error: "Save your MailerLite API key first" }, 400);
        const g = await ml(key, "/groups?limit=100");
        return json({ groups: (g?.data || []).map((x: any) => ({ id: String(x.id), name: x.name, active_count: x.active_count })) });
      }
      case "test": {
        const out: Record<string, string> = {};
        const bk = await secret(db, "BUFFER_API_KEY");
        const mk = await secret(db, "MAILERLITE_API_KEY");
        try { if (bk) { await buffer(bk, `query { account { id } }`); out.buffer = "ok"; } else out.buffer = "not set"; } catch (e) { out.buffer = String(e).slice(0, 200); }
        try { if (mk) { await ml(mk, "/groups?limit=1"); out.mailerlite = "ok"; } else out.mailerlite = "not set"; } catch (e) { out.mailerlite = String(e).slice(0, 200); }
        return json(out);
      }
      case "list_preview":
      case "list_sync": {
        const key = await secret(db, "MAILERLITE_API_KEY");
        if (!key && body.action === "list_sync") return json({ error: "Save your MailerLite API key first" }, 400);
        const r = await syncLists(db, key || "", await loadContext(db), body.action === "list_sync");
        return json(r);
      }
      case "sweep": {
        const results = await sweep(db);
        return json({ swept: true, results });
      }
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    return json({ error: String(err instanceof Error ? err.message : err).slice(0, 800) }, 502);
  }
});
