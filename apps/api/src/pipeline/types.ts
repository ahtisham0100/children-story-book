/** The steps a session reports progress for over SSE. */
export type PipelineStep = "validate" | "render";

export interface FaceBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ValidationResult {
  width: number;
  height: number;
  faceBox: FaceBox;
}

/** One child, as the engine needs them: which drawn slot, and their photo. */
export interface CharacterInput {
  slot: string;
  /** Signed URL or data URI of the child's photo — the face source. */
  photoUrl: string;
}
