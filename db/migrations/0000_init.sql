-- 迁移 0000_init
-- 由 db/generate-migration.ts 生成，请勿手工编辑。
-- 对应方案：动态网站平台化执行方案.md §6.1~§6.6（7 张业务表）

CREATE TABLE "audit_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"summary" text DEFAULT '' NOT NULL,
	"body_md" text DEFAULT '' NOT NULL,
	"body_html" text,
	"publish_status" text DEFAULT 'draft' NOT NULL,
	"featured" boolean DEFAULT false NOT NULL,
	"sort_order" integer DEFAULT 999 NOT NULL,
	"published_at" timestamp with time zone,
	"display_date" date,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	CONSTRAINT "entries_kind_check" CHECK ("entries"."kind" in ('blog', 'diary', 'projects', 'goals')),
	CONSTRAINT "entries_publish_status_check" CHECK ("entries"."publish_status" in ('draft', 'scheduled', 'published', 'archived')),
	CONSTRAINT "entries_version_positive_check" CHECK ("entries"."version" >= 1)
);

--> statement-breakpoint
CREATE TABLE "entry_revisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"change_note" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "entry_tags" (
	"entry_id" uuid NOT NULL,
	"tag_id" bigint NOT NULL,
	CONSTRAINT "entry_tags_entry_id_tag_id_pk" PRIMARY KEY("entry_id","tag_id")
);

--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"url" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"alt" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
CREATE TABLE "redirects" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"source_path" text NOT NULL,
	"target_path" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "redirects_status_code_check" CHECK ("redirects"."status_code" in (301, 302, 307, 308)),
	CONSTRAINT "redirects_no_self_check" CHECK ("redirects"."source_path" <> "redirects"."target_path")
);

--> statement-breakpoint
CREATE TABLE "tags" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);

--> statement-breakpoint
ALTER TABLE "entry_revisions" ADD CONSTRAINT "entry_revisions_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_entry_id_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."entries"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "entry_tags" ADD CONSTRAINT "entry_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "audit_logs_entity_idx" ON "audit_logs" USING btree ("entity_type","entity_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "entries_kind_slug_idx" ON "entries" USING btree ("kind","slug");
--> statement-breakpoint
CREATE INDEX "entries_public_idx" ON "entries" USING btree ("kind","publish_status","published_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "entry_revisions_entry_version_idx" ON "entry_revisions" USING btree ("entry_id","version");
--> statement-breakpoint
CREATE UNIQUE INDEX "media_path_idx" ON "media" USING btree ("path");
--> statement-breakpoint
CREATE UNIQUE INDEX "redirects_source_path_idx" ON "redirects" USING btree ("source_path");
--> statement-breakpoint
CREATE UNIQUE INDEX "tags_slug_idx" ON "tags" USING btree ("slug");
