CREATE TYPE "public"."run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TABLE "autonomous_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"goal" text NOT NULL,
	"status" "run_status" DEFAULT 'queued' NOT NULL,
	"max_iterations" integer DEFAULT 5 NOT NULL,
	"max_cost_usd" numeric(12, 6) DEFAULT '0.500000' NOT NULL,
	"timeout_at" timestamp with time zone,
	"kill_requested" boolean DEFAULT false NOT NULL,
	"iterations" integer DEFAULT 0 NOT NULL,
	"spent_usd" numeric(12, 6) DEFAULT '0' NOT NULL,
	"locked_at" timestamp with time zone,
	"stop_reason" text,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ADD CONSTRAINT "autonomous_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;