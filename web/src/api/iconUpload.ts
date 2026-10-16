import { apiPost, uploadToS3, type UploadTarget } from './client.ts';

/** 圖示最長邊上限(像素);列表與工作區只顯示小圖,不需要原尺寸。 */
const MAX_EDGE = 512;

/**
 * 把使用者選的圖片(PNG / JPEG / WebP)轉成 PNG 並縮到最長邊 512px。
 * 後端一律把圖示存成 icon.png;若直接上傳 JPEG / WebP 原檔,物件內容與副檔名不符,
 * 這裡先在瀏覽器轉好,讓儲存的就是真正的 PNG。
 */
export async function imageToPng(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('無法處理圖片');
    ctx.drawImage(bitmap, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('圖片轉換失敗');
    return new File([blob], 'icon.png', { type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

/** 轉 PNG → 取得上傳網址 → 直傳 S3;回傳圖示的 artifactId。 */
export async function uploadIconImage(
  file: File,
  onProgress?: (percent: number) => void,
): Promise<string> {
  const png = await imageToPng(file);
  const target = await apiPost<UploadTarget>('/uploads', { kind: 'png' });
  await uploadToS3(target.url, png, onProgress);
  return target.artifactId;
}
