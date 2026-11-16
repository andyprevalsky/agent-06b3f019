-- A project row is a left-bar folder, a repository, or both. Every existing row
-- was a left-bar folder, so the default keeps them all folders.
-- AlterTable
ALTER TABLE "Project" ADD COLUMN "isFolder" BOOLEAN NOT NULL DEFAULT true;
