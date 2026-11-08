ALTER TABLE `thread_lifecycle_approvals` ADD `payload_hash` text;--> statement-breakpoint
ALTER TABLE `thread_lifecycle_approvals` ADD `expected_revision` integer;--> statement-breakpoint
ALTER TABLE `thread_lifecycle_approvals` ADD `requester_id` text;--> statement-breakpoint
ALTER TABLE `thread_lifecycle_approvals` ADD `audience` text;--> statement-breakpoint
ALTER TABLE `thread_lifecycle_approvals` ADD `revoked_at` integer;--> statement-breakpoint
ALTER TABLE `threads` ADD `pin_source` text;--> statement-breakpoint
ALTER TABLE `threads` ADD `human_pin_protected` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `manual_unpin` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `threads` ADD `mutation_revision` integer DEFAULT 0 NOT NULL;