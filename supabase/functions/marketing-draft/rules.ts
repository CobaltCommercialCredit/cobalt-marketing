// Cobalt Marketing brand and compliance rules.
// The same rules run in the browser (index.html keeps a mirrored copy) so edits are re-checked live.
// "block" flags stop approval. "warn" flags are shown but do not stop approval.

export type Flag = { level: "block" | "warn"; code: string; message: string };

export const CHANNEL_LIMITS: Record<string, number> = {
  linkedin_company: 3000,
  linkedin_curtis: 3000,
  linkedin_armen: 3000,
  instagram: 2200,
  x: 250, // body only; the link is appended by the publisher and counts as 23 more characters on X
  email_owners: 20000,
  email_partners: 20000,
};

export const PARTNER_CHANNELS = ["linkedin_company", "linkedin_curtis", "linkedin_armen", "email_partners"];

// Replace em and en dashes with commas. Plain hyphens are only flagged, never auto changed.
export function autoFix(text: string): string {
  if (!text) return text;
  return text
    .replace(/\s*[—–]\s*/g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/ {2,}/g, " ")
    .trim();
}

export function lint(channel: string, body: string, subject?: string | null): Flag[] {
  const flags: Flag[] = [];
  const text = `${subject || ""}\n${body || ""}`;

  if (/access\s+capital|redmount/i.test(text)) {
    flags.push({ level: "block", code: "restricted_name", message: "Mentions a restricted name. Remove it." });
  }
  if (/debt\s+(relief|settlement|consolidation)/i.test(text)) {
    flags.push({ level: "block", code: "debt_relief", message: "Use \"refinancing\" or \"replacement financing\", never debt relief or settlement language." });
  }
  if (/guarantee(d)?\s+(approval|funding|rate|financing)|approval\s+guaranteed/i.test(text)) {
    flags.push({ level: "block", code: "guarantee", message: "Promises approval or terms. Remove the guarantee." });
  }
  if (/\bloan\s+broker\b/i.test(text)) {
    flags.push({ level: "warn", code: "broker_label", message: "Public copy does not describe Cobalt as a loan broker." });
  }
  if (/[—–]/.test(text)) {
    flags.push({ level: "warn", code: "dash", message: "Contains an em or en dash. Auto fix will replace it." });
  }
  if (/\b[A-Za-z]+-[A-Za-z]+\b/.test(text.replace(/https?:\/\/\S+/g, ""))) {
    flags.push({ level: "warn", code: "hyphen", message: "Contains a hyphenated word. House style avoids dashes." });
  }
  if (/\bcalifornia\b|\borange county\b|\bsouthern california\b|\bsocal\b|\bnewport beach\b/i.test(text)) {
    flags.push({ level: "warn", code: "geo", message: "California specific wording. Cobalt copy is nationwide." });
  }
  if (PARTNER_CHANNELS.includes(channel) && /advice is free/i.test(text)) {
    flags.push({ level: "warn", code: "tagline_partner", message: "\"Advice is free\" lands badly with CPA and attorney partners." });
  }
  if (channel === "instagram" && /click (the )?link|link below|https?:\/\//i.test(body || "")) {
    flags.push({ level: "warn", code: "ig_link", message: "Links are not clickable in Instagram captions. Say \"link in bio\"." });
  }
  const limit = CHANNEL_LIMITS[channel];
  if (limit && (body || "").length > limit) {
    flags.push({ level: "block", code: "too_long", message: `Over the ${limit} character limit for this channel (${(body || "").length}).` });
  }
  if (channel.startsWith("email") && subject && subject.length > 70) {
    flags.push({ level: "warn", code: "subject_long", message: "Subject is long and may be cut off on phones." });
  }
  const firstSentence = (body || "").split(/[.!?\n]/)[0] || "";
  if (/\b(SBA|ABL|asset based|factoring|MCA|sale leaseback|sale-leaseback|equipment finance)\b/i.test(firstSentence)) {
    flags.push({ level: "warn", code: "product_lead", message: "Leads with a product name. Lead with the business problem." });
  }
  return flags;
}

export function hasBlock(flags: Flag[]): boolean {
  return flags.some((f) => f.level === "block");
}

export function utmUrl(base: string, channel: string, campaign: string, postId: string): string {
  const source: Record<string, string> = {
    linkedin_company: "linkedin", linkedin_curtis: "linkedin", linkedin_armen: "linkedin",
    instagram: "instagram", x: "x", email_owners: "mailerlite", email_partners: "mailerlite",
  };
  const medium = channel.startsWith("email") ? "email" : "social";
  try {
    const u = new URL(base);
    u.searchParams.set("utm_source", source[channel] || channel);
    u.searchParams.set("utm_medium", medium);
    u.searchParams.set("utm_campaign", campaign);
    u.searchParams.set("utm_content", `${channel}_${postId.slice(0, 8)}`);
    return u.toString();
  } catch {
    return base;
  }
}

export function slugify(s: string): string {
  return (s || "content").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 48);
}
