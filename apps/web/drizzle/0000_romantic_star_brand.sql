CREATE TABLE "audit_events" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"target" text,
	"decision" text,
	"metadata" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_capabilities" (
	"grant_id" text NOT NULL,
	"position" text NOT NULL,
	"resource_id" text NOT NULL,
	"permissions" jsonb NOT NULL,
	"constraints" jsonb NOT NULL,
	"descendant_policy" text NOT NULL,
	"relocation_policy" text NOT NULL,
	CONSTRAINT "grant_capabilities_grant_id_position_pk" PRIMARY KEY("grant_id","position")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_grant_id" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_resource_id" text,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"move_policy" text NOT NULL,
	"delete_policy" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
ALTER TABLE "grant_capabilities" ADD CONSTRAINT "grant_capabilities_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_capabilities" ADD CONSTRAINT "grant_capabilities_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_parent_grant_id_grants_id_fk" FOREIGN KEY ("parent_grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_resource_id_resources_id_fk" FOREIGN KEY ("parent_resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "audit_events_target_idx" ON "audit_events" USING btree ("target");--> statement-breakpoint
CREATE INDEX "grant_capabilities_resource_idx" ON "grant_capabilities" USING btree ("resource_id");--> statement-breakpoint
CREATE INDEX "grants_parent_idx" ON "grants" USING btree ("parent_grant_id");--> statement-breakpoint
CREATE INDEX "resources_parent_idx" ON "resources" USING btree ("parent_resource_id");--> statement-breakpoint
CREATE INDEX "tokens_grant_idx" ON "tokens" USING btree ("grant_id");