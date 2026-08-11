# AdLift CRM V1 — AI Voice Agent Audit & Architecture

## Status

This document is the Phase 1 repository audit and Phase 2 architecture baseline for integrating a production AI cold-calling voice agent directly into `mansur-droid/adlift-crmV1`.

The goal is to extend the existing CRM rather than replace it.

---

## 1. Current repository architecture

### Frontend

- Vite
- React
- JavaScript / JSX
- Lucide React icons
- Main CRM UI is concentrated in `src/main.jsx`
- Styling is in `src/styles.css`

### Database and authentication

- Supabase is the existing database/authentication provider.
- Browser client is initialized in `src/supabaseClient.js`.
- Browser-visible environment variables currently used:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
- Supabase Auth is used for sessions/users.
- Roles are stored in Supabase user metadata and currently support at least:
  - `admin`
  - `freelancer`
- Row Level Security is already part of the current database design.

### Server-side/API layer

The repository already contains server-side API handlers under `api/`, including:

- `api/admin-users.js`
- `api/form-submit.js`
- `api/revenue-data.js`

These handlers use server-side environment variables and, where necessary, the Supabase service-role key.

This means the project already has a suitable pattern for privileged server-side operations. AI calling must follow that pattern rather than placing provider credentials or queue logic in the browser.

### Current data model

The main existing table is `public.crm_records`.

It uses a flexible record structure:

- `id`
- `type`
- `payload` JSONB
- `created_by`
- `created_at`
- `updated_at`

Existing logical record types include CRM entities such as leads, clients, freelancers, submissions and cold-call stats.

This JSONB model is convenient for the existing lightweight CRM, but it is not sufficient by itself for reliable concurrent call processing, event histories, callback scheduling, compliance enforcement or transcript/recording relationships.

### Current Cold Call implementation

The current Cold Call workflow is represented primarily by the `stats` record type in `src/main.jsx`.

Current cold-call statuses include:

- `dialed`
- `opener`
- `conversation`
- `pitched`
- `interested`
- `callback`
- `booked`

Cold-call records currently contain fields such as:

- prospect name
- phone number
- email
- import date
- status
- notes

CSV import logic already exists for cold-call prospect data.

The current Cold Call records should remain a source of prospect/campaign input, but the production calling engine should not use a naive loop over those records.

### Existing security worth preserving

The current project already has useful security concepts that must remain intact:

- Supabase authentication
- role-based access
- RLS policies
- server-side service-role usage
- bearer-token verification for privileged API operations
- separation between browser anon credentials and service-role credentials

The AI subsystem must strengthen this separation, not weaken it.

---

## 2. What should be reused

Reuse:

1. Existing Vite/React CRM UI.
2. Existing Supabase Auth.
3. Existing admin/freelancer role system.
4. Existing Cold Call prospect import and display workflow.
5. Existing Supabase project.
6. Existing server-side `api/` pattern for privileged operations.
7. Existing lead/prospect fields where they already represent the same business concept.
8. Existing activity/history concepts where practical.

Do not rewrite these just to support the voice agent.

---

## 3. What should NOT be used as-is for calling infrastructure

The following would be unsafe or unreliable if implemented only through `crm_records.payload` and browser code:

- call queue locking
- concurrent worker claims
- retry scheduling
- callback scheduling
- provider webhooks
- telephony credentials
- LLM/STT/TTS credentials
- compliance enforcement
- call event history
- transcript segments
- recording metadata
- provider usage accounting
- durable failure recovery

These need server-side code and dedicated relational tables.

---

## 4. Recommended production architecture

```text
Existing CRM Cold Calls UI
        |
        v
Supabase prospect/campaign data
        |
        v
Eligibility Engine (server-side)
        |
        v
Durable Call Queue / Claiming
        |
        v
Telephony Adapter
        |
        v
Real-time Voice Runtime
  |        |        |
 STT      LLM      TTS
        |
        v
Agent Tools
  - CRM lookup/update
  - qualification
  - callback creation
  - DNC/suppression
  - calendar availability
  - appointment booking
  - transfer
  - knowledge retrieval
        |
        v
Structured Call Outcome
        |
        v
Supabase
  - call attempts
  - events
  - transcript
  - recording metadata
  - qualification
  - callbacks
  - compliance logs
  - pre-call brief
        |
        v
Existing CRM UI
```

---

## 5. Runtime separation

### CRM web application

Keep the current Vite/React application responsible for:

- configuration
- campaign controls
- lead/cold-call review
- recordings/transcripts UI
- pre-call briefs
- analytics
- agent settings

### Server-side control API

Add authenticated server endpoints for:

- campaign start/pause/stop
- eligibility checks
- queue claiming
- call creation
- call status callbacks/webhooks
- agent configuration
- knowledge retrieval
- call result persistence
- appointments
- transfers
- usage/cost controls

### Real-time voice worker

Do not attempt to run the continuous bidirectional media pipeline inside the browser.

Use a separate long-running voice worker/runtime for:

- telephony media stream
- voice activity detection
- interruption/barge-in
- STT streaming
- LLM streaming
- TTS streaming
- tool execution
- graceful failure handling

A framework such as Pipecat is a strong candidate because the architecture explicitly needs interchangeable STT/LLM/TTS components and real-time conversation handling.

The CRM should communicate with this runtime through authenticated server-side interfaces and database events/jobs.

---

## 6. Provider abstraction boundaries

Create interfaces around every replaceable external component.

### Telephony

`TelephonyProvider`

Responsibilities:

- place outbound call
- terminate call
- transfer call
- detect/update call state
- expose provider call ID
- handle media streaming
- expose recording controls if supported

Initial likely provider: Twilio or another programmable US telephony carrier.

### Speech-to-text

`STTProvider`

Responsibilities:

- consume streaming caller audio
- produce interim/final transcript text
- expose timing metadata

### LLM

`LLMProvider`

Responsibilities:

- consume structured conversation context
- generate short conversational responses
- request approved tools
- produce structured extraction after calls

### Text-to-speech

`TTSProvider`

Responsibilities:

- synthesize streaming audio
- allow cancellation when caller interrupts
- expose voice/model configuration

### Calendar

`CalendarProvider`

Responsibilities:

- query actual availability
- create appointment
- confirm appointment exists
- avoid double booking

### Recording/storage

`CallStorageProvider`

Responsibilities:

- recording references
- transcript persistence
- retention/deletion
- signed/private access where appropriate

---

## 7. Database direction

Do not force all AI-call state into the existing `crm_records.payload` object.

Keep `crm_records` for existing CRM entities while introducing dedicated tables for transactional voice-agent data.

Recommended tables:

### `ai_call_campaigns`

Campaign configuration and runtime state.

Important fields:

- `id`
- `name`
- `status`
- `enabled`
- `calling_window_start`
- `calling_window_end`
- `max_attempts`
- `max_calls_per_day`
- `max_connected_minutes_per_day`
- `max_concurrent_calls`
- `recording_enabled`
- `transfer_enabled`
- `created_by`
- timestamps

### `ai_call_attempts`

One row per actual call attempt.

Important fields:

- `id`
- `campaign_id`
- CRM prospect reference
- phone number snapshot
- provider call ID
- status/outcome
- attempt number
- claimed/locked state
- started/answered/ended timestamps
- duration
- failure reason
- cost metadata

### `ai_call_events`

Append-only operational timeline.

Examples:

- queued
- claimed
- initiated
- ringing
- connected
- transcript segment
- tool call
- callback requested
- DNC requested
- transfer attempted
- recording started
- appointment booked
- failed
- ended

### `ai_callbacks`

Durable callback scheduling with timezone/context.

### `ai_suppressions`

Cross-campaign Do Not Call and suppression data.

### `ai_transcript_segments`

Timestamped speaker-attributed transcript rows to support traceability.

### `ai_recordings`

Recording reference, consent/disclosure metadata, retention and deletion state.

### `ai_call_outcomes`

Structured post-call extraction:

- interest
- qualification
- objections
- pain points
- previous experience
- current solution
- next action
- appointment data

### `ai_pre_call_briefs`

Structured booked-lead brief with transcript evidence references.

### `ai_knowledge_items`

Company/business knowledge entries.

### `ai_regulations`

Hard company rules/restrictions separate from flexible guidance.

### `ai_campaign_instructions`

Campaign-level objectives, audience and conversational guidance.

### `ai_provider_settings`

Non-secret provider configuration only. Secrets remain environment/server-side secret storage.

---

## 8. Knowledge architecture

Do not create one massive hardcoded system prompt.

Use four logical layers:

1. Hard company regulations
2. Verified company knowledge
3. Campaign instructions
4. Lead/conversation context

The runtime context builder must preserve this priority order.

Hard regulations must be injected as non-negotiable constraints.

Knowledge items should be searchable/retrievable by topic so the model only receives relevant facts for the current question.

Every business claim that may be stated to a prospect should come from verified knowledge or explicitly approved campaign configuration.

---

## 9. Eligibility engine

A lead may enter the queue only after a server-side eligibility check.

Minimum checks:

- campaign active
- AI calling enabled for lead/campaign
- valid phone number
- not suppressed / DNC
- previous attempt count below limit
- callback scheduling rules
- lead-local calling window
- required compliance metadata
- no active call already in progress for the same lead
- no worker lock held by another worker
- daily/campaign cost and volume limits

The database claim operation must be atomic so two workers cannot dial the same prospect.

---

## 10. Call lifecycle

Recommended state flow:

```text
eligible
-> queued
-> claimed
-> initiating
-> ringing
-> connected
-> active_conversation
-> completed
```

Alternative terminal states include:

```text
no_answer
voicemail
callback_requested
not_interested
qualified
appointment_booked
transferred
do_not_call
invalid_number
provider_failed
agent_failed
```

The existing human-facing cold-call status can remain simpler while detailed machine state lives in dedicated tables.

---

## 11. Tool-driven agent behavior

The voice model should not receive unrestricted database access.

Expose narrow tools such as:

- `get_lead_context`
- `search_company_knowledge`
- `create_callback`
- `mark_do_not_call`
- `check_calendar_availability`
- `book_appointment`
- `attempt_transfer`
- `record_qualification`

Each tool validates authorization and business rules server-side.

The LLM chooses conversational wording, but the server determines whether sensitive actions are actually permitted.

---

## 12. Pre-call brief traceability

Every important brief fact should be able to point back to one or more transcript segment IDs.

Example structured fact:

```json
{
  "category": "main_objection",
  "value": "Previously received low-quality Facebook leads",
  "evidence_segment_ids": ["..."],
  "source_type": "explicit"
}
```

Inferences must use a different `source_type` and be visibly labelled in the CRM.

---

## 13. Existing project changes to avoid

Do not:

- replace Supabase Auth
- replace the entire CRM frontend
- move provider secrets into Vite environment variables exposed to the browser
- remove RLS to simplify development
- put queue processing in `src/main.jsx`
- use client-side timers as the production scheduler
- put live telephony media streaming in ordinary browser UI code
- use the single JSONB CRM table as the only transactional voice-call database

---

## 14. External services / infrastructure

### Unavoidable

A real PSTN telephony provider is required to place calls to US phone numbers.

We should keep telephony behind an adapter so the provider can later be replaced.

### AI components

STT, LLM and TTS should each be independently replaceable.

Open-source/self-hosted components can be evaluated where they are genuinely good enough. Commercial providers can be used selectively where latency/voice quality/reliability justify the cost.

### Long-running runtime

The current project pattern is suitable for short API requests, but a real-time media worker requires infrastructure capable of maintaining long-lived connections and continuously processing call audio.

That worker should be deployable separately while remaining part of the same CRM system.

---

## 15. Implementation sequence

### Phase 1 — COMPLETE baseline audit

- inspect repository architecture
- identify Cold Call implementation
- identify Supabase/Auth architecture
- identify server-side API pattern
- identify reuse boundaries

### Phase 2 — CURRENT

- formalize architecture
- define provider interfaces
- define data ownership and security boundary
- define call lifecycle
- define knowledge hierarchy

### Phase 3 — Database foundation

Create migrations for:

- campaigns
- attempts
- events
- callbacks
- suppressions
- transcripts
- recordings
- outcomes
- pre-call briefs
- knowledge
- regulations
- campaign instructions

Add RLS and indexes before connecting real providers.

### Phase 4 — CRM configuration UI

Add an admin-only AI Calling section integrated with the existing design.

Initial functionality should configure data only. Buttons must not pretend to place calls until telephony is actually connected.

### Phase 5 — Eligibility + queue

Build server-side eligibility checks and atomic claiming.

### Phase 6 — Telephony adapter

Connect a real carrier and test calls only to approved test numbers.

### Phase 7 — Real-time voice runtime

Implement STT -> LLM -> TTS with barge-in and cancellation.

### Phase 8 — Agent knowledge and tools

Connect verified company knowledge, regulations and CRM tools.

### Phase 9 — Post-call extraction

Persist outcome, summary, qualification, objections and next action.

### Phase 10 — Calendar and callbacks

Implement durable callback scheduling and real appointment booking.

### Phase 11 — Transfers

Implement configurable live transfer with graceful fallback.

### Phase 12 — Recording/transcripts

Enable only under configured recording/compliance conditions.

### Phase 13 — Pre-call brief

Generate traceable booked-lead intelligence.

### Phase 14 — Cost/compliance controls

Enforce limits and audit events.

### Phase 15 — Controlled production testing

Test progression:

- unit tests
- simulated conversations
- own/test phone numbers
- tiny controlled outbound batch
- review calls/transcripts
- correct behavior
- gradual scale

---

## 16. Immediate next implementation milestone

The next code milestone should be the database foundation plus server-side domain interfaces, without connecting a real telephony provider yet.

That gives the CRM a safe foundation for campaigns, queueing, suppression, knowledge, attempts, events and future provider integrations without faking any operational calling functionality.
