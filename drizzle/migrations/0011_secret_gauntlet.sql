ALTER TYPE "public"."provider" ADD VALUE 'claude_cli';--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'gemini_cli';--> statement-breakpoint
ALTER TYPE "public"."provider" ADD VALUE 'opencode_cli';--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "engine" text DEFAULT 'llm' NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "engine_cli" text;