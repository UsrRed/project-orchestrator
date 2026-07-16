CREATE TYPE "public"."repo_mode" AS ENUM('local', 'github');--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_mode" "repo_mode" DEFAULT 'local' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_full_name" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "repo_private" boolean DEFAULT true NOT NULL;