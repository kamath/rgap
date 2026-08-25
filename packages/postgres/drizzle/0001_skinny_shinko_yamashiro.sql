CREATE TABLE "audit" (
	"seq" integer PRIMARY KEY NOT NULL,
	"id" text NOT NULL,
	"at" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"result" text NOT NULL,
	"detail" text NOT NULL,
	CONSTRAINT "audit_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "executable_bindings" (
	"executable_resource_id" text NOT NULL,
	"name" text NOT NULL,
	"resource_id" text NOT NULL,
	"grant_lineage" text,
	CONSTRAINT "executable_bindings_executable_resource_id_name_pk" PRIMARY KEY("executable_resource_id","name")
);
--> statement-breakpoint
CREATE TABLE "executables" (
	"resource_id" text PRIMARY KEY NOT NULL,
	"runtime" text NOT NULL,
	"input" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "grant_binding_permissions" (
	"grant_id" text NOT NULL,
	"position" integer NOT NULL,
	"permission" text NOT NULL,
	CONSTRAINT "grant_binding_permissions_grant_id_position_permission_pk" PRIMARY KEY("grant_id","position","permission")
);
--> statement-breakpoint
CREATE TABLE "grant_bindings" (
	"grant_id" text NOT NULL,
	"position" integer NOT NULL,
	"id" text NOT NULL,
	CONSTRAINT "grant_bindings_grant_id_position_pk" PRIMARY KEY("grant_id","position")
);
--> statement-breakpoint
CREATE TABLE "grants" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"parent_id" text,
	"expires_at" text,
	"revoked_at" text
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_id" text,
	"name" text NOT NULL,
	"deleted_at" text
);
--> statement-breakpoint
CREATE TABLE "tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"grant_id" text NOT NULL,
	"label" text NOT NULL,
	"hash" text NOT NULL,
	"expires_at" text,
	"revoked_at" text
);
--> statement-breakpoint
ALTER TABLE "executable_bindings" ADD CONSTRAINT "executable_bindings_executable_resource_id_executables_resource_id_fk" FOREIGN KEY ("executable_resource_id") REFERENCES "public"."executables"("resource_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executable_bindings" ADD CONSTRAINT "executable_bindings_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "executables" ADD CONSTRAINT "executables_resource_id_resources_id_fk" FOREIGN KEY ("resource_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_binding_permissions" ADD CONSTRAINT "grant_binding_permissions_grant_id_position_grant_bindings_grant_id_position_fk" FOREIGN KEY ("grant_id","position") REFERENCES "public"."grant_bindings"("grant_id","position") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_bindings" ADD CONSTRAINT "grant_bindings_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grant_bindings" ADD CONSTRAINT "grant_bindings_id_resources_id_fk" FOREIGN KEY ("id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "grants" ADD CONSTRAINT "grants_parent_id_grants_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_parent_id_resources_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."resources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_grant_id_grants_id_fk" FOREIGN KEY ("grant_id") REFERENCES "public"."grants"("id") ON DELETE no action ON UPDATE no action;