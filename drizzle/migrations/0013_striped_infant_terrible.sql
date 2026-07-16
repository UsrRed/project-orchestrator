CREATE TABLE "claude_usage_samples" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"captured_at" timestamp with time zone DEFAULT now() NOT NULL,
	"limits" jsonb NOT NULL,
	"active_runs" integer DEFAULT 0 NOT NULL
);
