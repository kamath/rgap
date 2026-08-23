CREATE TABLE `audit` (
	`seq` integer PRIMARY KEY NOT NULL,
	`id` text NOT NULL,
	`at` text NOT NULL,
	`action` text NOT NULL,
	`target` text NOT NULL,
	`result` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `audit_id_unique` ON `audit` (`id`);--> statement-breakpoint
CREATE TABLE `executables` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `grant_resources` (
	`grant_id` text NOT NULL,
	`position` integer NOT NULL,
	`id` text,
	`path` text,
	PRIMARY KEY(`grant_id`, `position`),
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "grant_resources_target_check" CHECK(("grant_resources"."id" is not null and "grant_resources"."path" is null)
        or ("grant_resources"."id" is null and "grant_resources"."path" is not null))
);
--> statement-breakpoint
CREATE TABLE `grant_resource_permissions` (
	`grant_id` text NOT NULL,
	`position` integer NOT NULL,
	`permission` text NOT NULL,
	PRIMARY KEY(`grant_id`, `position`, `permission`),
	FOREIGN KEY (`grant_id`,`position`) REFERENCES `grant_resources`(`grant_id`,`position`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `grants` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`parent_id` text,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`parent_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `resources` (
	`id` text PRIMARY KEY NOT NULL,
	`parent_id` text,
	`name` text NOT NULL,
	`deleted_at` text,
	FOREIGN KEY (`parent_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`grant_id` text NOT NULL,
	`label` text NOT NULL,
	`hash` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	FOREIGN KEY (`grant_id`) REFERENCES `grants`(`id`) ON UPDATE no action ON DELETE no action
);
