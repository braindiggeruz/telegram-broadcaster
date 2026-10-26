import { PHOTO_MAX_BYTES, PHOTO_SOURCE_MAX_BYTES } from "@shared/media";

const MAX_PIXELS = 40_000_000;
const MAX_EDGE = 16_384;
const OUTPUT_EDGE = 2560;

export type PreparedPhoto = {
  name: string;
  mimeType: "image/jpeg" | "image/png";
  dataBase64: string;
  previewUrl: string;
  size: number;
  width: number;
  height: number;
};

/** Read dimensions before decoding, so a tiny compressed file cannot request a huge canvas. */
export function photoSourceInfo(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const text = (start: number, length: number) =>
    String.fromCharCode(...bytes.subarray(start, start + length));
  if (
    bytes.length >= 24 &&
    bytes[0] === 137 &&
    text(1, 3) === "PNG" &&
    text(12, 4) === "IHDR"
  )
    return {
      mimeType: "image/png" as const,
      width: view.getUint32(16),
      height: view.getUint32(20),
    };
  if (bytes.length >= 12 && text(0, 4) === "RIFF" && text(8, 4) === "WEBP") {
    for (let offset = 12; offset + 8 <= bytes.length; ) {
      const type = text(offset, 4),
        size = view.getUint32(offset + 4, true),
        body = offset + 8;
      if (body + size > bytes.length) break;
      if (type === "VP8X" && size >= 10) {
        const uint24 = (at: number) =>
          bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
        return {
          mimeType: "image/webp" as const,
          width: 1 + uint24(body + 4),
          height: 1 + uint24(body + 7),
        };
      }
      if (
        type === "VP8 " &&
        size >= 10 &&
        bytes[body + 3] === 0x9d &&
        bytes[body + 4] === 1 &&
        bytes[body + 5] === 0x2a
      )
        return {
          mimeType: "image/webp" as const,
          width: view.getUint16(body + 6, true) & 0x3fff,
          height: view.getUint16(body + 8, true) & 0x3fff,
        };
      if (type === "VP8L" && size >= 5 && bytes[body] === 0x2f) {
        const packed = view.getUint32(body + 1, true);
        return {
          mimeType: "image/webp" as const,
          width: (packed & 0x3fff) + 1,
          height: ((packed >>> 14) & 0x3fff) + 1,
        };
      }
      offset = body + size + (size % 2);
    }
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const size = view.getUint16(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if (
        [
          0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd,
          0xce, 0xcf,
        ].includes(marker) &&
        size >= 8
      )
        return {
          mimeType: "image/jpeg" as const,
          width: view.getUint16(offset + 5),
          height: view.getUint16(offset + 3),
        };
      offset += size;
    }
  }
  throw new Error(
    "Выберите изображение JPEG, PNG или WebP. Этот файл не удалось распознать."
  );
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(
        new Error("Не удалось прочитать изображение. Выберите файл ещё раз.")
      );
    reader.readAsDataURL(blob);
  });
}

async function decodeImage(blob: Blob): Promise<{
  image: CanvasImageSource;
  width: number;
  height: number;
  close: () => void;
}> {
  if (typeof createImageBitmap === "function") {
    const image = await createImageBitmap(blob);
    return {
      image,
      width: image.width,
      height: image.height,
      close: () => image.close(),
    };
  }
  const image = new Image();
  image.src = await dataUrl(blob);
  await image.decode();
  return {
    image,
    width: image.naturalWidth,
    height: image.naturalHeight,
    close: () => {
      image.src = "";
    },
  };
}

export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!file.size || file.size > PHOTO_SOURCE_MAX_BYTES)
    throw new Error("Выберите изображение размером до 20 МБ.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = photoSourceInfo(bytes);
  if (
    !source.width ||
    !source.height ||
    source.width > MAX_EDGE ||
    source.height > MAX_EDGE ||
    source.width * source.height > MAX_PIXELS
  )
    throw new Error(
      "Изображение слишком большое: максимум 40 мегапикселей и 16 384 пикселя по стороне."
    );
  if (Math.max(source.width / source.height, source.height / source.width) > 20)
    throw new Error(
      "Картинка слишком узкая или вытянутая. Выберите изображение с соотношением сторон до 20:1."
    );
  let decoded: Awaited<ReturnType<typeof decodeImage>>;
  try {
    decoded = await decodeImage(new Blob([bytes], { type: source.mimeType }));
  } catch {
    throw new Error(
      "Изображение повреждено или не поддерживается браузером. Попробуйте другой файл."
    );
  }
  try {
    if (
      !decoded.width ||
      !decoded.height ||
      decoded.width * decoded.height > MAX_PIXELS ||
      decoded.width > MAX_EDGE ||
      decoded.height > MAX_EDGE
    )
      throw new Error("Изображение слишком большое для безопасной обработки.");
    const ratio = Math.min(
      1,
      OUTPUT_EDGE / Math.max(decoded.width, decoded.height)
    );
    let width = Math.max(1, Math.round(decoded.width * ratio)),
      height = Math.max(1, Math.round(decoded.height * ratio));
    let result: Blob;
    let mimeType: "image/png" | "image/jpeg";
    if (
      source.mimeType === "image/png" &&
      file.size <= PHOTO_MAX_BYTES &&
      ratio === 1
    ) {
      result = new Blob([bytes], { type: "image/png" });
      mimeType = "image/png";
    } else {
      mimeType = "image/jpeg";
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context)
        throw new Error("Не удалось подготовить изображение в этом браузере.");
      result = new Blob();
      for (let attempt = 0; attempt < 12; attempt++) {
        canvas.width = width;
        canvas.height = height;
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(decoded.image, 0, 0, width, height);
        result = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            blob =>
              blob
                ? resolve(blob)
                : reject(new Error("Не удалось сжать изображение.")),
            "image/jpeg",
            Math.max(0.58, 0.88 - attempt * 0.1)
          )
        );
        if (result.size <= PHOTO_MAX_BYTES) break;
        if (attempt >= 2) {
          width = Math.max(1, Math.round(width * 0.8));
          height = Math.max(1, Math.round(height * 0.8));
        }
      }
      canvas.width = canvas.height = 0;
      if (!result.size || result.size > PHOTO_MAX_BYTES)
        throw new Error(
          "Не удалось уменьшить изображение до 1 МБ. Попробуйте другой файл."
        );
    }
    const previewUrl = await dataUrl(result);
    return {
      name: `${file.name.replace(/\.[^.]+$/, "").slice(0, 140) || "photo"}.${mimeType === "image/png" ? "png" : "jpg"}`,
      mimeType,
      dataBase64: previewUrl.slice(previewUrl.indexOf(",") + 1),
      previewUrl,
      size: result.size,
      width,
      height,
    };
  } finally {
    decoded.close();
  }
}

export function photoSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} МБ`
    : `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}
