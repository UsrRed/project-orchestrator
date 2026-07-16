ALTER TABLE "api_keys" ALTER COLUMN "encrypted_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "method" text DEFAULT 'api_key' NOT NULL;