export const PHOTO_MAX_BYTES = 1024 * 1024;
export const PHOTO_SOURCE_MAX_BYTES = 20 * 1024 * 1024;
export const PHOTO_CAPTION_MAX_LENGTH = 1024;
export const PHOTO_OWNER_QUOTA_BYTES = 16 * 1024 * 1024;

export interface PhotoAttachment {
  id: string;
  name: string;
  mimeType: "image/jpeg" | "image/png";
  size: number;
  width: number;
  height: number;
  sha256: string;
  url: string;
}
