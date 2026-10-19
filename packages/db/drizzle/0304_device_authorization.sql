-- @contract: additive
-- RFC 8628 device authorization grant: one row per pending device sign-in,
-- written by Better Auth's device-authorization plugin (extended by the OAuth
-- provider with the client and resource a code is bound to). Rows are
-- short-lived and consumed on redemption.
CREATE TABLE IF NOT EXISTS "device_code" (
  "id" text PRIMARY KEY NOT NULL,
  "device_code" text NOT NULL,
  "user_code" text NOT NULL,
  "user_id" uuid REFERENCES "user"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "last_polled_at" timestamptz,
  "polling_interval" integer,
  "client_id" text,
  "scope" text,
  "resources" text[],
  "oauth_client_id" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_code_device_code_idx" ON "device_code" ("device_code");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "device_code_user_code_idx" ON "device_code" ("user_code");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_code_user_id_idx" ON "device_code" ("user_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "device_code_expires_at_idx" ON "device_code" ("expires_at");
