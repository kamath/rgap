CREATE TABLE `executable_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`resource_id` text NOT NULL,
	`runtime` text NOT NULL,
	`program` text NOT NULL,
	`input_schema` text,
	`output_schema` text,
	`binding_schema` text NOT NULL,
	`limits` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `executables` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`active_revision_id` text,
	`deleted_at` text,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`active_revision_id`) REFERENCES `executable_revisions`(`id`) ON UPDATE no action ON DELETE no action
);
