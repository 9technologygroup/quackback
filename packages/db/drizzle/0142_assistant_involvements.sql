-- Assistant involvement record: one row per conversation the in-product AI
-- agent (Quinn) engages. The audit/KPI reporting spine — trigger, terminal
-- status, structured hand-off reason, cited sources, and CSAT rating. Cascades
-- with its conversation.
CREATE TABLE "assistant_involvements" (
  "id" uuid PRIMARY KEY NOT NULL,
  "conversation_id" uuid NOT NULL,
  "triggered_by" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "handoff_reason" text,
  "sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rating" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "assistant_involvements"
  ADD CONSTRAINT "assistant_involvements_conversation_id_conversations_id_fk"
  FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id")
  ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "assistant_involvements_conversation_id_idx"
  ON "assistant_involvements" USING btree ("conversation_id");
