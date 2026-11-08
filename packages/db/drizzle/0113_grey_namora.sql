CREATE TABLE `thread_lifecycle_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at` integer NOT NULL,
	`consumed_at` integer,
	`issued_at` integer NOT NULL,
	`source_kind` text NOT NULL,
	`source_ref` text NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `thread_lifecycle_approvals_thread_idx` ON `thread_lifecycle_approvals` (`thread_id`);--> statement-breakpoint
ALTER TABLE `threads` ADD `creation_provenance` text;