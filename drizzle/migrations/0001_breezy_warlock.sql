ALTER TABLE "agent_executions" ALTER COLUMN "task_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ALTER COLUMN "mode" SET DEFAULT 'manual';--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "user_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "task_label" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD COLUMN "tier" text;--> statement-breakpoint
ALTER TABLE "agent_executions" ADD CONSTRAINT "agent_executions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;