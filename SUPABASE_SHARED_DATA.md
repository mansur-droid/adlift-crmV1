# Supabase shared CRM data setup

This upgrade moves CRM records out of browser localStorage and into a shared Supabase table called `crm_records`.

## Before merging/deploying

Run the SQL file in Supabase:

`supabase/crm-records.sql`

Steps:

1. Open Supabase.
2. Go to SQL Editor.
3. Set the SQL role to `postgres`, not `authenticated`.
4. Paste the contents of `supabase/crm-records.sql`.
5. Run it.

## What changes

- Admins can read, create, update, and delete all CRM records.
- Freelancers can only read, create, and update their own `submissions` and `stats` records.
- Freelancers cannot delete records.
- Admins can import/export JSON backups.
- All data is now shared through Supabase instead of being stuck in one browser.

## Important

If the table is not created before this code is deployed, the app will load but show a Supabase error saying the `crm_records` table does not exist.
