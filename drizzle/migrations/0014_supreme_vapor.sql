ALTER TABLE "autonomous_runs" ALTER COLUMN "engine" SET DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "max_iterations" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "max_iterations" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "max_cost_usd" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "planned_level" integer;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "plan_reason" text;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "planner" text;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "source_kind" text;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "source_label" text;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD COLUMN "timeout_min" integer;--> statement-breakpoint
ALTER TABLE "profiles" ADD COLUMN "source_order" text;