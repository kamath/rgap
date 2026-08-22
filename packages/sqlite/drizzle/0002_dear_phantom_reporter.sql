CREATE TABLE `secret_envelopes` (
	`resource_id` text PRIMARY KEY NOT NULL,
	`ciphertext` text NOT NULL,
	`nonce` text NOT NULL,
	`tag` text NOT NULL,
	`version` text NOT NULL,
	`updated_at` text NOT NULL
);
