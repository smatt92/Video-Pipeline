-- 0051 — Trend relevance for a channel, and the voice overflow switch.
--
-- Forward-only. Two columns on trend_signals, two on channel_policy, two new tables. No row is
-- rewritten: relevance starts NULL everywhere (never scored — not "irrelevant"), and
-- voice_overflow defaults to false, which is exactly today's behaviour (wait out the limit).
--
-- ── Relevance (Prompt O5 B) ──────────────────────────────────────────────────
--
-- /trends listed raw signals — celebrities, stock tickers, phone unboxings — none of which a
-- science-explainer channel can use. Each term is now embedded ONCE (trend_term_embeddings,
-- keyed by the term's text, so the same headline seen by two channels or on four runs a day
-- is one embedding) and scored by cosine similarity against the channel's niche vector
-- (channel_niche_vectors: the bible premise + its series + the topic calendar's topics,
-- re-embedded only when that text changes, never per page view).
--
-- NULL relevance means the term could not be scored (no embedder, the vendor refused, the
-- niche could not be built) and is never written as 0 — 0 is a measurement ("orthogonal to
-- the niche"), NULL is its absence. The CHECK keeps the value a cosine.
--
-- ── Voice overflow (Prompt O5 D) ─────────────────────────────────────────────
--
-- When the main voice model's daily limit is reached, re-voice the WHOLE episode on the
-- second model instead of waiting. Per channel, off by default.

alter table trend_signals
  add column relevance           numeric check (relevance between -1 and 1),
  add column relevance_scored_at timestamptz;

comment on column trend_signals.relevance is
  'Cosine similarity of this term''s embedding to the channel''s niche vector (channel_niche_vectors), '
  'written by runTrends. NULL = not scored (no embedder / vendor refused / no niche vector) — never 0.';

create index trend_signals_channel_relevance on trend_signals (channel_id, relevance desc nulls last);

create table trend_term_embeddings (
  term       text primary key,
  model      text not null,
  embedding  extensions.vector(768) not null,
  created_at timestamptz not null default now()
);
comment on table trend_term_embeddings is
  'One embedding per distinct trend term text, so a term is embedded once however many runs '
  'and channels see it. Written by runTrends; service role only.';
alter table trend_term_embeddings enable row level security;

create table channel_niche_vectors (
  channel_id   uuid primary key references channels(id) on delete cascade,
  model        text not null,
  embedding    extensions.vector(768) not null,
  -- sha256 of the texts the vector was built from; a run rebuilds only when it changes.
  source_hash  text not null,
  source_count int  not null check (source_count > 0),
  source_texts jsonb not null check (jsonb_typeof(source_texts) = 'array'),
  built_at     timestamptz not null default now()
);
comment on table channel_niche_vectors is
  'The channel''s niche as one unit vector: the normalised mean of the embeddings of its bible '
  'premise, its series and its topic calendar''s topics. Rebuilt by runTrends when source_hash '
  'changes; read by runTrends to score signals. Service role only.';
alter table channel_niche_vectors enable row level security;

alter table channel_policy
  add column relevance_threshold numeric not null default 0.65 check (relevance_threshold between 0 and 1),
  add column voice_overflow      boolean not null default false;

comment on column channel_policy.relevance_threshold is
  'Trends: a signal at or above this relevance is "for this channel" on /trends and is shown to '
  'stage 2 first. Settings → Generation.';
comment on column channel_policy.voice_overflow is
  'Voice: when the main TTS model''s daily limit is reached, re-voice the whole episode on the '
  'second model instead of waiting (never mixed within an episode). Settings → Generation.';

-- What the relevance pass said on each run ({scored, unscored, detail, embedded, nicheRebuilt}),
-- so /trends can say "not scored: the vendor refused" rather than showing blank scores.
alter table trend_runs add column relevance jsonb;
