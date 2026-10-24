import sharp from "sharp";

export const FW = 96;
export const FH = 60;

/** Decode an image (path or bytes) into a small greyscale frame. Server side only. */
export async function loadGray(src: string | Buffer, w = FW, h = FH): Promise<Uint8Array> {
  const { data } = await sharp(src).greyscale().resize(w, h, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

/** Re-encode a screenshot to a small JPEG suitable for sending to a vision model. */
export async function toJudgeJpeg(src: string | Buffer, width = 768): Promise<Buffer> {
  return sharp(src).resize({ width, withoutEnlargement: true }).jpeg({ quality: 72 }).toBuffer();
}
