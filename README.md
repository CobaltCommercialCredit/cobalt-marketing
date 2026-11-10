# Cobalt Marketing

One source in, every channel out. A website Guide (or an anonymized deal story) is drafted into posts for LinkedIn (Cobalt page, Curtis, Armen), Instagram, X, and two email audiences. Nothing posts until a team member approves it here.

Live: https://cobaltcommercialcredit.github.io/cobalt-marketing/

## How it works

| Step | Where |
|---|---|
| Add a source (paste text or give the Guide's web address) | Sources, or + New source |
| Drafts for every channel, checked against brand and compliance rules | `marketing-draft` Edge Function (Claude) |
| Review, edit, approve. Red rule flags block approval | Review tab |
| About 20 minutes before each post's time, it is handed to Buffer (social) or MailerLite (email) | `marketing-publish`, run every 15 minutes by `pg_cron` job `cobalt-marketing-publish` |
| Sent and failed status syncs back; every action is recorded | Calendar, Results |

Social posts stay editable and can be pulled back right up until hand off. Once handed off, cancel in Buffer or MailerLite.

Every link carries `utm_source`, `utm_medium`, `utm_campaign` (source title) and `utm_content` (channel and post id).

## Rules enforced on every draft and again at hand off

Blocks approval: restricted names, "debt relief/settlement/consolidation", promised approval or terms, over the channel's length limit.
Warns: em or en dashes (one click fix), hyphenated words, California specific wording, "advice is free" on partner channels, product names in the first sentence, clickable link wording on Instagram, "loan broker".

## Keys and settings

Buffer and MailerLite API keys are pasted on the Settings tab and stored encrypted in Supabase Vault. They can be replaced but never read back from the browser; only the publish function reads them.

MailerLite only accepts full HTML email through its API on the Advanced plan. On other plans the campaign is created with subject, sender and audience set, and the email text is pasted in MailerLite's editor (Calendar shows a Copy email text button).

## Tables

`mkt_content`, `mkt_posts`, `mkt_channels`, `mkt_config`, `mkt_log` (append only record). Storage bucket `mkt-media` holds generated Instagram cards (public, so Buffer can fetch them). Same Supabase project and sign-in as every other Cobalt tool (`cobalt_session`). RLS requires an authenticated user.

The Edge Function source in `supabase/functions` is a copy for the record; deploy changes to Supabase as well.
