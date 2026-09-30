# פרומט להתקנת הלוח (להדבקה ב-Claude)

להעתיק את כל מה שמתחת לקו ולהדביק בצ'אט. הוא יוביל צעד-צעד.

---

אני שותפה במותג בגדים בשם House of Bais (hob). קיבלנו תיקייה עם קוד של לוח ניהול פנימי שנבנה עבורנו, ואני רוצה להעלות אותו לחשבון Cloudflare משלנו. תוביל אותי צעד אחד בכל פעם: תגיד לי מה לעשות, תחכה שאדווח מה קרה, ורק אז תמשיך. אני לא מתכנתת. אם משהו נכשל, תבקש ממני להדביק את ההודעה המלאה מהמסך ותסביר.

## מה זה
- תיקיית `hob-crm` במחשב שלי (חולצה מ-ZIP). בפנים: `START-HERE.md`, `DEPLOY.md`, `SHOPIFY.md`, `wrangler.jsonc`, תיקיות `src`, `migrations`, `scripts`.
- טכנולוגיה: אפליקציית TanStack Start (React) שרצה כ-Cloudflare Worker בשם `hob-crm`, עם מסד נתונים D1 בשם `hob-crm-db`, דלי R2 בשם `hob-crm-files`, Durable Object אחד ו-Workers AI. הכל בתוכנית החינמית.
- סודות שנזין: `VAPID_PRIVATE_JWK` (התראות לטלפון, נוצר עם `node scripts/vapid-keys.mjs`; המפתח הציבורי נכנס ל-`wrangler.jsonc` תחת vars), `ANTHROPIC_API_KEY` (העוזרת הובי; מפתח מ-https://console.anthropic.com), ואופציונלי לשופיפיי `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET` (לפי `SHOPIFY.md`, אפשר אחר כך).

## מה צריך במחשב
Node.js 22 ומעלה (https://nodejs.org). לבדוק איתי עם `node -v`. חשבון Cloudflare (https://dash.cloudflare.com/sign-up, חינמי).

## השלבים
1. לפתוח טרמינל בתוך תיקיית `hob-crm` (תסביר לי איך: במק Terminal, בווינדוס PowerShell, ו-`cd` לתיקייה).
2. `npm install`.
3. `npx wrangler login`: נפתח דפדפן, מאשרים. לוודא עם `npx wrangler whoami`.
4. `npx wrangler d1 create hob-crm-db`. הפלט מכיל `database_id`. תסביר לי איך לפתוח את `wrangler.jsonc` בעורך טקסט ולהחליף את שורת האפסים `00000000-0000-0000-0000-000000000000` ב-id הזה.
5. `npx wrangler r2 bucket create hob-crm-files`.
6. `npm run db:migrate:remote`.
7. `node scripts/vapid-keys.mjs`. את הערך של VAPID_PUBLIC_KEY שמים ב-`wrangler.jsonc` בשורה `"VAPID_PUBLIC_KEY": ""` בין המרכאות. ואז `npx wrangler secret put VAPID_PRIVATE_JWK` ומדביקים את ה-JSON כשמתבקש.
8. `npx wrangler secret put ANTHROPIC_API_KEY` (אם אין מפתח עדיין, אפשר לדלג; הלוח עובד, רק הובי כבויה).
9. `npm run deploy`. בסוף מודפסת כתובת כמו `https://hob-crm.<שם>.workers.dev`. זו הכתובת של הלוח.
10. משתמשות: `node scripts/create-user.mjs avia "אביה" 'סיסמה-חזקה' > u.sql` ואז `npx wrangler d1 execute hob-crm-db --remote --file=u.sql`. אותו דבר עם `lior "ליאור"`. למחוק את `u.sql`.
11. בדיקה: לפתוח את הכתובת, לבחור אביה, להכניס סיסמה. בטלפון: "הוסף למסך הבית". בהגדרות: למלא רקע על המותג ולהפעיל התראות.
12. (אחר כך, לא חובה) שופיפיי לפי `SHOPIFY.md`.

בכל שלב אם לא ברור לי איפה להקליד, תסביר בפשטות. בוא נתחיל מבדיקת Node.
