-- Phase 4 admin/configuration additions.
-- Add only fields required by the CRM editor; no telephony integration.

begin;

alter table public.ai_call_campaigns
  add column if not exists description text;

alter table public.ai_company_knowledge
  add column if not exists enabled boolean not null default true;

-- Expand structured campaign guidance types instead of collapsing everything into one textarea.
alter table public.ai_campaign_instructions
  drop constraint if exists ai_campaign_instructions_instruction_type_check;

alter table public.ai_campaign_instructions
  add constraint ai_campaign_instructions_instruction_type_check
  check (instruction_type in (
    'objective','audience','personality','opening','discovery','qualification',
    'objection','closing','transfer','appointment','guidance'
  ));

create index if not exists ai_company_knowledge_enabled_status_idx
  on public.ai_company_knowledge(enabled,status,category);

commit;
