CREATE TABLE "profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"display_name" text,
	"language" text DEFAULT 'fr' NOT NULL,
	"tone" text DEFAULT 'neutre et professionnel' NOT NULL,
	"default_project_type" "project_type" DEFAULT 'tech' NOT NULL,
	"preferred_provider" "provider",
	"default_budget_usd" numeric(12, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;