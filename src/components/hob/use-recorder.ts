// הקלטה קצרה ותמלול בשרת (Whisper דרך /api/transcribe). לחיצה מתחילה, לחיצה
// שנייה עוצרת ומחזירה טקסט. עוצרת לבד אחרי 90 שניות.
import { useEffect, useRef, useState } from "react";

export function useRecorder(onText: (text: string) => void, onError: (message: string) => void) {
  const recRef = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    setSupported(typeof MediaRecorder !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia));
    return () => {
      if (recRef.current && recRef.current.state !== "inactive") recRef.current.stop();
    };
  }, []);

  async function toggle() {
    if (recording) {
      recRef.current?.stop();
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      onError("אין גישה למיקרופון. אשרו אותה בהגדרות הדפדפן.");
      return;
    }
    const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    chunks.current = [];
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.current.push(e.data);
    };
    rec.onstop = async () => {
      if (timer.current) window.clearTimeout(timer.current);
      stream.getTracks().forEach((t) => t.stop());
      setRecording(false);
      const blob = new Blob(chunks.current, { type: rec.mimeType || mime || "audio/mp4" });
      if (blob.size < 1500) return;
      setBusy(true);
      try {
        const res = await fetch("/api/transcribe", { method: "POST", headers: { "content-type": blob.type }, body: blob });
        if (res.status === 401) {
          onError("unauthorized");
          return;
        }
        const data = (await res.json().catch(() => null)) as { text?: string } | null;
        const text = (data?.text ?? "").trim();
        if (!res.ok || !text) onError("לא הצלחתי להבין את ההקלטה. נסו שוב, קרוב יותר למיקרופון.");
        else onText(text);
      } catch {
        onError("התמלול נכשל. בדקו חיבור ונסו שוב.");
      } finally {
        setBusy(false);
      }
    };
    recRef.current = rec;
    rec.start();
    setRecording(true);
    timer.current = window.setTimeout(() => rec.state !== "inactive" && rec.stop(), 90_000);
  }
  return { supported, recording, busy, toggle };
}
