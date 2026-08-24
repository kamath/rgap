CREATE TABLE `executable_bindings` (
	`executable_resource_id` text NOT NULL,
	`name` text NOT NULL,
	`resource_id` text NOT NULL,
	`grant_lineage` text,
	PRIMARY KEY(`executable_resource_id`, `name`),
	FOREIGN KEY (`executable_resource_id`) REFERENCES `executables`(`resource_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`resource_id`) REFERENCES `resources`(`id`) ON UPDATE no action ON DELETE no action
);
