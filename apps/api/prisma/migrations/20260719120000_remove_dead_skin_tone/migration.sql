-- The skin-tone step was dead compute: `skinToneHex` was sampled from the
-- upload, written here, and passed into the pipeline, but no stage ever read it.
-- Skin tone is handled entirely by the repaint prompt, which matches the child's
-- tone across all visible skin because the model sees the photograph directly.
ALTER TABLE "Character" DROP COLUMN "skinToneHex";
