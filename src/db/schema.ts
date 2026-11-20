import type { Db } from './client.js';

/** Tables that hold one workspace's data. Each gets a row-level security policy. */
const SCOPED_TABLES = [
  'pulls',
  'pull_chunks',
  'raw_replies',
  'datasets',
  'dataset_rows',
  'dataset_columns',
  'files',
  'judging_batches',
];

const TABLES = `
create table if not exists workspaces (
  id text primary key,
  key_hash text not null unique,
  key_cipher text not null,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);

create table if not exists oauth_grants (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  client_id text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists oauth_tokens (
  token_hash text primary key,
  grant_id text not null references oauth_grants(id) on delete cascade,
  kind text not null check (kind in ('access', 'refresh')),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists oauth_codes_used (
  code_hash text primary key,
  used_at timestamptz not null default now()
);

create table if not exists pulls (
  id bigserial primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  kind text not null,
  request jsonb not null default '{}',
  status text not null default 'running',
  total int not null default 0,
  done int not null default 0,
  failed int not null default 0,
  credits numeric not null default 0,
  dataset_id bigint,
  note text,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);

create table if not exists pull_chunks (
  id bigserial primary key,
  pull_id bigint not null references pulls(id) on delete cascade,
  workspace_id text not null,
  work jsonb not null,
  size int not null default 0,
  status text not null default 'pending',
  tries int not null default 0,
  not_before timestamptz,
  locked_until timestamptz,
  error text,
  updated_at timestamptz not null default now()
);
create index if not exists pull_chunks_ready on pull_chunks (status, pull_id);

create table if not exists raw_replies (
  id bigserial primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  pull_id bigint,
  request_hash text not null,
  method text not null,
  path text not null,
  request jsonb,
  status int not null,
  ok boolean not null default false,
  response jsonb,
  response_text text,
  credits_used numeric not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists raw_replies_reuse on raw_replies (pull_id, request_hash);
create index if not exists raw_replies_ws on raw_replies (workspace_id, created_at);

create table if not exists datasets (
  id bigserial primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  name text not null,
  kind text not null,
  source jsonb not null default '{}',
  row_count int not null default 0,
  day date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists datasets_ws on datasets (workspace_id, created_at);

create table if not exists dataset_rows (
  dataset_id bigint not null references datasets(id) on delete cascade,
  workspace_id text not null,
  row_no int not null,
  key text,
  data jsonb not null default '{}',
  extra jsonb not null default '{}',
  primary key (dataset_id, row_no)
);
create index if not exists dataset_rows_key on dataset_rows (dataset_id, key);

create table if not exists dataset_columns (
  dataset_id bigint not null references datasets(id) on delete cascade,
  workspace_id text not null,
  name text not null,
  kind text not null,
  definition jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (dataset_id, name)
);

create table if not exists files (
  id text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  dataset_id bigint,
  name text not null,
  path text not null,
  bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists judging_batches (
  id bigserial primary key,
  workspace_id text not null,
  dataset_id bigint not null references datasets(id) on delete cascade,
  column_name text not null,
  row_nos int[] not null,
  reserved_until timestamptz not null,
  status text not null default 'open',
  created_at timestamptz not null default now()
);

create table if not exists uploads (
  token_hash text primary key,
  workspace_id text not null references workspaces(id) on delete cascade,
  dataset_id bigint not null,
  expires_at timestamptz not null,
  used_at timestamptz
);

-- A number from text, or null when the text is not a number. Formulas never fail on bad data.
-- A trailing % is dropped, so "4.5%" compares as 4.5.
create or replace function safe_num(x text) returns numeric language sql immutable as $fn$
  select case when x ~ '^\\s*-?[0-9]+(\\.[0-9]+)?([eE][-+]?[0-9]+)?\\s*%?\\s*$' then rtrim(btrim(x), '% ')::numeric end
$fn$;

-- One line per CreatorDB call, with the charge CreatorDB reported.
create or replace view credit_record as
  select id, workspace_id, pull_id, method, path, status, credits_used, created_at from raw_replies;
`;

function policies(): string {
  const parts = [
    `do $do$ begin
       if not exists (select from pg_roles where rolname = 'app_user') then
         create role app_user nologin;
       end if;
     end $do$;`,
    // On managed Postgres the owner is not a superuser, so it needs membership to switch roles.
    'grant app_user to current_user;',
    'grant usage on schema public to app_user;',
    'grant select, insert, update, delete on all tables in schema public to app_user;',
    'grant usage, select on all sequences in schema public to app_user;',
    'grant execute on function safe_num(text) to app_user;',
    // Sign-in tables never go through the workspace role. Neither does the credit view: a view
    // reads with its owner's rights, so it would skip the row-level rules below.
    'revoke all on workspaces, oauth_grants, oauth_tokens, oauth_codes_used, uploads, credit_record from app_user;',
  ];
  for (const table of SCOPED_TABLES) {
    parts.push(
      `alter table ${table} enable row level security;`,
      `drop policy if exists workspace_only on ${table};`,
      `create policy workspace_only on ${table}
         using (workspace_id = current_setting('app.workspace_id', true))
         with check (workspace_id = current_setting('app.workspace_id', true));`,
    );
  }
  return parts.join('\n');
}

/** Creates the tables and the row-level security rules. Safe to run on every start. */
export async function migrate(db: Db): Promise<void> {
  for (const statement of splitStatements(TABLES + policies())) {
    await db.query(statement);
  }
}

/** Splits on semicolons that are outside dollar-quoted bodies. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let current = '';
  let tag: string | null = null;
  const tokens = sql.split(/(\$[a-z]*\$|;)/);
  for (const token of tokens) {
    if (tag === null && /^\$[a-z]*\$$/.test(token)) {
      tag = token;
      current += token;
    } else if (tag !== null && token === tag) {
      tag = null;
      current += token;
    } else if (token === ';' && tag === null) {
      if (current.trim()) out.push(current.trim());
      current = '';
    } else {
      current += token;
    }
  }
  if (current.trim()) out.push(current.trim());
  return out.filter((s) => !/^(--[^\n]*\n?\s*)+$/.test(s));
}
