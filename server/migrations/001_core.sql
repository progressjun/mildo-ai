-- MILDO OS Cloud 기반 스키마 (docs/SAAS_SPEC.md §2)
-- 스키마 이름을 하드코딩하지 않는다 (테스트는 파일마다 임시 스키마에서 실행).

-- ---------- 테넌시 ----------
CREATE TABLE organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,40}$'),
  name text NOT NULL,
  brand_name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Seoul',
  plan text NOT NULL DEFAULT 'pro',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'archived')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text,
  real_name boolean NOT NULL DEFAULT true,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower ON users (lower(email));

CREATE TABLE memberships (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'pm', 'ae', 'client', 'viewer')),
  title text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE sessions (
  id text PRIMARY KEY,                 -- 세션 토큰의 SHA-256 (토큰 원문은 쿠키에만)
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  ip text,
  user_agent text
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL CHECK (role IN ('admin', 'pm', 'ae', 'client', 'viewer')),
  token_hash text NOT NULL UNIQUE,
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE password_resets (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

-- ---------- 감사 ----------
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor text NOT NULL,                 -- 사람 이름 · 'system' · 'worker'
  action text NOT NULL,                -- 'change.approve', 'connection.create' ...
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_ws_at ON audit_log (workspace_id, at DESC);

-- ---------- 잡 큐 ----------
CREATE TABLE jobs (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  run_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  dedupe_key text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX jobs_claim ON jobs (status, run_at);
CREATE UNIQUE INDEX jobs_dedupe ON jobs (dedupe_key) WHERE status IN ('queued', 'running') AND dedupe_key IS NOT NULL;

-- ---------- 커넥션 · 수집 ----------
CREATE TABLE connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL,              -- naver_sa · google_ads · meta · kakao_moment · naver_gfa · naver_commerce · coupang · cafe24 · ohouse · csv · demo
  kind text NOT NULL CHECK (kind IN ('media', 'sales', 'other')),
  channel text,                        -- MediaId 또는 SalesChannelId
  label text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'error', 'disabled')),
  credentials_enc text,                -- AES-256-GCM (lib/crypto.ts)
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  write_mode text NOT NULL DEFAULT 'dry_run' CHECK (write_mode IN ('off', 'dry_run', 'live')),
  priority int NOT NULL DEFAULT 100,   -- 같은 매체에 출처가 여럿이면 높은 쪽 사용
  last_test_at timestamptz,
  last_sync_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX connections_ws ON connections (workspace_id);

CREATE TABLE ingest_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES connections(id) ON DELETE CASCADE,
  job text NOT NULL,                   -- daily · intraday · backfill · upload
  range_from date,
  range_to date,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
  rows_in int NOT NULL DEFAULT 0,
  rows_written int NOT NULL DEFAULT 0,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,   -- 데이터 품질 검사 결과
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX ingest_runs_ws ON ingest_runs (workspace_id, started_at DESC);

CREATE TABLE uploads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  connection_id uuid REFERENCES connections(id) ON DELETE SET NULL,
  template text NOT NULL,              -- media_daily · media_hourly · sales_daily · keyword_daily · search_term_daily · entities
  filename text NOT NULL,
  bytes int NOT NULL,
  mapping jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received', 'imported', 'failed')),
  summary jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- 웨어하우스 (src/core/types.ts Dataset과 1:1) ----------
CREATE TABLE wh_media_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  media text NOT NULL,
  source text NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  conversions numeric(14,2) NOT NULL DEFAULT 0,
  revenue numeric(18,2) NOT NULL DEFAULT 0,
  new_customers numeric(14,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, media, source)
);

CREATE TABLE wh_media_hourly (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  hour smallint NOT NULL CHECK (hour BETWEEN 0 AND 23),
  media text NOT NULL,
  source text NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  conversions numeric(14,2) NOT NULL DEFAULT 0,
  revenue numeric(18,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, hour, media, source)
);

CREATE TABLE wh_sales_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  channel text NOT NULL,
  source text NOT NULL,
  visitors bigint NOT NULL DEFAULT 0,
  detail_views bigint NOT NULL DEFAULT 0,
  carts bigint NOT NULL DEFAULT 0,
  orders bigint NOT NULL DEFAULT 0,
  revenue numeric(18,2) NOT NULL DEFAULT 0,
  ad_attributed_revenue numeric(18,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, channel, source)
);

CREATE TABLE wh_keyword_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  keyword_id text NOT NULL,
  source text NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  conversions numeric(14,2) NOT NULL DEFAULT 0,
  revenue numeric(18,2) NOT NULL DEFAULT 0,
  avg_rank numeric(6,2),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, keyword_id, source)
);

CREATE TABLE wh_search_term_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  term text NOT NULL,
  source text NOT NULL,
  impressions bigint NOT NULL DEFAULT 0,
  clicks bigint NOT NULL DEFAULT 0,
  cost numeric(18,2) NOT NULL DEFAULT 0,
  conversions numeric(14,2) NOT NULL DEFAULT 0,
  revenue numeric(18,2) NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, term, source)
);

CREATE TABLE wh_brand_search_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  date date NOT NULL,
  source text NOT NULL,
  volume bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, date, source)
);

-- 엔티티 스냅샷: keyword · campaign · account · product · promotion (문서 = src/core/types.ts 형태)
CREATE TABLE wh_entities (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  entity_type text NOT NULL CHECK (entity_type IN ('keyword', 'campaign', 'account', 'product', 'promotion')),
  external_id text NOT NULL,
  source text NOT NULL,
  channel text,
  doc jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, entity_type, external_id, source)
);

-- ---------- 운영 ----------
CREATE TABLE change_requests (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  module text NOT NULL,
  kind text NOT NULL,
  target text NOT NULL,
  target_id text,
  before jsonb,
  after jsonb,
  change_pct numeric,
  reason text NOT NULL DEFAULT '',
  requested_by text NOT NULL,
  requested_by_user uuid REFERENCES users(id) ON DELETE SET NULL,
  approver text NOT NULL CHECK (approver IN ('AE', 'PM', 'CLIENT')),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'applied', 'rejected', 'rolled_back', 'held')),
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  execution jsonb,                     -- { mode: dry_run|live, connectionId, request, response, ok, at, error }
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX change_requests_ws ON change_requests (workspace_id, created_at DESC);

CREATE TABLE incidents (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id text NOT NULL,
  severity text NOT NULL CHECK (severity IN ('P1', 'P2', 'P3')),
  status text NOT NULL CHECK (status IN ('open', 'ack', 'action', 'resolved')),
  doc jsonb NOT NULL,                  -- src/core/types.ts Incident (+ 모듈 확장 필드)
  detected_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX incidents_ws_open ON incidents (workspace_id, status, severity);

CREATE TABLE comments (
  id text NOT NULL,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  target text NOT NULL,
  author text NOT NULL,
  author_user uuid REFERENCES users(id) ON DELETE SET NULL,
  text text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  resolved boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE notification_channels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('slack', 'email', 'webhook')),
  name text NOT NULL,
  config_enc text NOT NULL,            -- 웹훅 URL · 수신자 등 (암호화)
  min_severity text NOT NULL DEFAULT 'P2' CHECK (min_severity IN ('P1', 'P2', 'P3')),
  events text[] NOT NULL DEFAULT ARRAY['incident', 'sla', 'report']::text[],
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES notification_channels(id) ON DELETE SET NULL,
  event text NOT NULL,
  ref_id text,
  status text NOT NULL CHECK (status IN ('sent', 'failed', 'skipped')),
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_ws ON notifications (workspace_id, at DESC);

CREATE TABLE reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('daily', 'weekly', 'monthly', 'issue', 'value')),
  period_start date,
  period_end date,
  generated_at timestamptz NOT NULL DEFAULT now(),
  title text NOT NULL,
  markdown text NOT NULL,
  messenger text,
  ae_comment text,
  delivered jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'generated' CHECK (status IN ('generated', 'delivered', 'failed'))
);
CREATE INDEX reports_ws ON reports (workspace_id, generated_at DESC);

CREATE TABLE impact_ledger (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_type text NOT NULL CHECK (source_type IN ('change', 'incident', 'automation')),
  source_id text NOT NULL,
  label text NOT NULL,
  occurred_at timestamptz NOT NULL,
  window_days int NOT NULL DEFAULT 7,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'measured', 'insufficient', 'excluded')),
  baseline jsonb,
  observed jsonb,
  control jsonb,
  estimate jsonb,                      -- { revenue, cost, profit, ci: [lo, hi], method, assumptions[] }
  measured_at timestamptz,
  UNIQUE (workspace_id, source_type, source_id)
);

CREATE TABLE ai_usage (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  model text NOT NULL,
  purpose text,
  input_tokens int NOT NULL DEFAULT 0,
  output_tokens int NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_ws ON ai_usage (workspace_id, at DESC);

-- 모듈 로컬 입력(Lab 기준값 · Watch 진행 · TF 입력 등)의 서버 보관
CREATE TABLE workspace_state (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb NOT NULL,
  updated_by uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, key)
);
