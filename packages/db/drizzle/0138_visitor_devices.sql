-- Durable device id -> principal mapping (visitor analytics layer 2, opt-in).
-- The principal soft link is set when the device engages and re-pointed by
-- the anonymous-to-identified merge; no FK so device rows outlive principals.
CREATE TABLE "visitor_devices" (
	"device_id" text PRIMARY KEY NOT NULL,
	"principal_id" uuid,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_country" text
);
--> statement-breakpoint
CREATE INDEX "visitor_devices_principal_idx" ON "visitor_devices" ("principal_id") WHERE "principal_id" IS NOT NULL;
