-- 迁移 0001_entry_tag_order
-- 由 db/generate-migration.ts 生成，请勿手工编辑。
-- 对应方案：动态网站平台化执行方案.md §6.1~§6.6（7 张业务表）

ALTER TABLE "entry_tags" ADD COLUMN "tag_order" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX "entry_tags_entry_order_idx" ON "entry_tags" USING btree ("entry_id","tag_order");
