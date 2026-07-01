---
name: DistiBench post-merge DB tables
description: Tables that drizzle-kit push won't auto-create in non-TTY CI merges — must be created manually.
---

# Tables requiring manual creation after merges

Drizzle-kit push requires an interactive TTY for any destructive or ambiguous migration. In the Replit post-merge script there is no TTY, so these tables must be created manually via `executeSql` after a merge that introduces them.

## user_sessions
Managed by `connect-pg-simple`, not Drizzle. Also: the build bundles with esbuild and `connect-pg-simple` looks for `table.sql` relative to `dist/`. Fixed in `build.mjs` to copy the file after each build. If the table is ever dropped, recreate it:

```sql
CREATE TABLE IF NOT EXISTS "user_sessions" (
  "sid" varchar NOT NULL COLLATE "default",
  "sess" json NOT NULL,
  "expire" timestamp(6) NOT NULL,
  CONSTRAINT "session_pkey" PRIMARY KEY ("sid") NOT DEFERRABLE INITIALLY IMMEDIATE
) WITH (OIDS=FALSE);
CREATE INDEX IF NOT EXISTS "IDX_session_expire" ON "user_sessions" ("expire");
```

## password_reset_tokens
Drizzle schema in `lib/db/src/schema/password_reset_tokens.ts`. If missing after a merge:

```sql
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id" serial PRIMARY KEY,
  "user_id" integer NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" text NOT NULL UNIQUE,
  "expires_at" timestamp with time zone NOT NULL,
  "used_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "idx_prt_token" ON "password_reset_tokens" ("token");
CREATE INDEX IF NOT EXISTS "idx_prt_user_id" ON "password_reset_tokens" ("user_id");
```

**Why:** The post-merge script (`scripts/post-merge.sh`) runs `drizzle-kit push` non-interactively. When the push encounters a new table that it thinks conflicts with something (or tries to drop user_sessions), it prompts and fails. The table is left uncreated.

**How to apply:** After any merge that adds a new schema file, check the post-merge stderr for TTY errors. If found, create the missing tables manually via `executeSql` in code_execution.
