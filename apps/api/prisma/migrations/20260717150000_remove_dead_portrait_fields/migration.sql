-- Removes noBgKey/portraitKey: dead columns from the deleted portrait/remove_bg
-- pipeline (see git history for portrait.ts, removeBg.ts). Nothing writes them
-- since the face-swap pivot; the 2 non-null values that existed were from
-- sessions created before that pivot.
ALTER TABLE "Character" DROP COLUMN "noBgKey",
DROP COLUMN "portraitKey";
