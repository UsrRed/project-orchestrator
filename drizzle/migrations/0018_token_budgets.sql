ALTER TABLE "budgets" RENAME COLUMN "limit_usd" TO "limit_tokens";--> statement-breakpoint
ALTER TABLE "budgets" ALTER COLUMN "limit_tokens" SET DATA TYPE integer USING round("limit_tokens")::integer;--> statement-breakpoint
ALTER TABLE "budgets" DROP COLUMN "spent_usd";--> statement-breakpoint
ALTER TABLE "profiles" RENAME COLUMN "default_budget_usd" TO "default_budget_tokens";--> statement-breakpoint
ALTER TABLE "profiles" ALTER COLUMN "default_budget_tokens" SET DATA TYPE integer USING round("default_budget_tokens")::integer;--> statement-breakpoint
ALTER TABLE "autonomous_runs" RENAME COLUMN "max_cost_usd" TO "max_tokens";--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "max_tokens" SET DATA TYPE integer USING round("max_tokens")::integer;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "max_tokens" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "autonomous_runs" RENAME COLUMN "spent_usd" TO "spent_tokens";--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "spent_tokens" SET DATA TYPE integer USING round("spent_tokens")::integer;--> statement-breakpoint
ALTER TABLE "autonomous_runs" ALTER COLUMN "spent_tokens" SET DEFAULT 0;
