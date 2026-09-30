-- Only CRM admins may delete website audit submissions.
grant delete on public.audit_requests to authenticated;

drop policy if exists audit_requests_crm_admin_delete on public.audit_requests;
create policy audit_requests_crm_admin_delete
on public.audit_requests
for delete to authenticated
using (lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', '')) = 'admin');
