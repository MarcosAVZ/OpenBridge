ALTER TABLE "integration_idea" ADD COLUMN "key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "integration_idea_repository_key_idx" ON "integration_idea" USING btree ("repository_id","key");