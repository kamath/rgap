CREATE TABLE `executables` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`runtime` text NOT NULL,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
