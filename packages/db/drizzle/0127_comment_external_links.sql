CREATE TABLE "comment_external_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"comment_id" uuid NOT NULL,
	"integration_id" uuid,
	"integration_type" varchar(50) NOT NULL,
	"external_id" text NOT NULL,
	"external_url" text,
	"direction" varchar(10) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "comment_external_links_type_external_unique" UNIQUE("integration_type","external_id")
);
--> statement-breakpoint
ALTER TABLE "comment_external_links" ADD CONSTRAINT "comment_external_links_comment_fk" FOREIGN KEY ("comment_id") REFERENCES "public"."comments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "comment_external_links" ADD CONSTRAINT "comment_external_links_integration_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "comment_external_links_comment_id_idx" ON "comment_external_links" USING btree ("comment_id");
