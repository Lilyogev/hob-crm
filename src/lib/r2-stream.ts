// R2 מחזיר ReadableStream מההגדרות של Cloudflare (workers-types), ו-Response מצפה ל-
// ReadableStream של הדפדפן (lib.dom). בזמן ריצה זה אותו אובייקט, אבל הטיפוסים לא תואמים
// (read() מחזיר value אופציונלי ב-done). במקום cast, עוטפים בזרם DOM שמושך מהקורא של R2:
// הזרימה נשמרת (בלי לטעון את כל הקובץ לזיכרון), ו-tsc בודק את הכל.
import type { R2ObjectBody } from "@cloudflare/workers-types";

export function domStream(body: R2ObjectBody["body"]): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value instanceof Uint8Array ? value : new Uint8Array(value));
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}
