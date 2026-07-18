ALTER TABLE "api_keys" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "api_keys" CASCADE;--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "provider" SET DATA TYPE text USING "provider"::text;--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "engine";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "engine_cli";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "boost";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "planned_level";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "planner";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "source_kind";--> statement-breakpoint
ALTER TABLE "autonomous_runs" DROP COLUMN "draft";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "preferred_provider";--> statement-breakpoint
ALTER TABLE "profiles" DROP COLUMN "source_order";--> statement-breakpoint
DROP TYPE "public"."provider";