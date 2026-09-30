# פרומט להעברת הלוח לחשבון Cloudflare של השותפות

להעתיק את כל מה שמתחת לקו ולהדביק בצ'אט של Claude (או כל עוזר AI) במחשב של אביה או ליאור. הוא יוביל צעד-צעד.

---

אני שותפה במותג בגדים בשם House of Bais (hob). יש לנו לוח ניהול פנימי שנבנה עבורנו ורץ כרגע בחשבון Cloudflare של מישהו אחר. אני רוצה להעביר אותו לחשבון Cloudflare משלנו, בלי לאבד נתונים. תוביל אותי צעד אחד בכל פעם: תגיד לי מה לעשות, תחכה שאדווח מה קרה, ורק אז תמשיך. אני לא מתכנתת. אם משהו נכשל, תבקש ממני להדביק את ההודעה המלאה מהמסך ותסביר מה לעשות.

## מה זה הלוח
- קוד: https://github.com/Lilyogev/hob-crm (ריפו פרטי בגיטהאב; יש לי גישה, או קיבלתי ZIP).
- טכנולוגיה: אפליקציית TanStack Start (React) שרצה כ-Cloudflare Worker בשם `hob-crm`, עם מסד נתונים D1 בשם `hob-crm-db`, דלי R2 בשם `hob-crm-files`, Durable Object אחד, ו-Workers AI. הכל בתוכנית החינמית של Cloudflare.
- בתוך הריפו יש `DEPLOY.md` (הקמה מאפס והעברה בין חשבונות) ו-`SHOPIFY.md` (חיבור לחנות). תבקש ממני להדביק לך את התוכן שלהם אם אתה צריך פרטים.
- סודות שהלוח צריך (נזין מחדש בחשבון החדש): `ANTHROPIC_API_KEY` (העוזרת הובי), `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET` (אם שופיפיי מחובר), `VAPID_PRIVATE_JWK` (התראות בטלפון; אפשר לייצר זוג חדש עם `node scripts/vapid-keys.mjs`, והמפתח הציבורי נכנס ל-`wrangler.jsonc` תחת vars).

## מה יש לי ביד
- קובץ `hob-data.sql` שקיבלתי מהחשבון הישן (יוצא עם `npx wrangler d1 export hob-crm-db --remote --output=hob-data.sql --no-schema`). אם אין לי אותו, תגיד לי לבקש אותו.
- תיקייה עם הקבצים מהדלי הישן (קבלות ותמונות), אם היו.
- חשבון Cloudflare חדש שלנו (או שתעזור לי לפתוח ב-https://dash.cloudflare.com/sign-up).

## מה צריך להיות מותקן במחשב
Node.js גרסה 22 ומעלה (https://nodejs.org) ו-Git (https://git-scm.com/downloads). תבדוק איתי עם `node -v` ו-`git --version`.

## השלבים (תעבור עליהם אחד-אחד)
1. להוריד את הקוד: `git clone https://github.com/Lilyogev/hob-crm` ואז `cd hob-crm` ו-`npm install`.
2. `npx wrangler login`: נפתח דפדפן, מאשרים את החשבון החדש שלנו. לוודא עם `npx wrangler whoami` שזה החשבון הנכון.
3. `npx wrangler d1 create hob-crm-db`. הפקודה מדפיסה `database_id`. תסביר לי איך לפתוח את `wrangler.jsonc` בעורך טקסט ולהחליף את שורת האפסים ב-id החדש.
4. `npx wrangler r2 bucket create hob-crm-files`.
5. `npm run db:migrate:remote` (יוצר את הטבלאות).
6. `npx wrangler d1 execute hob-crm-db --remote --file=hob-data.sql` (טוען את כל הנתונים הישנים: משימות, מלאי, כספים, משפיעניות, משתמשות וסיסמאות).
7. התראות: `node scripts/vapid-keys.mjs`, המפתח הציבורי לתוך `wrangler.jsonc` תחת `"VAPID_PUBLIC_KEY"`, והפרטי: `npx wrangler secret put VAPID_PRIVATE_JWK` (מדביקים את ה-JSON כשמתבקש).
8. סודות: `npx wrangler secret put ANTHROPIC_API_KEY`, ואם שופיפיי מחובר גם `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `SHOPIFY_WEBHOOK_SECRET`.
9. `npm run deploy`. בסוף מודפסת כתובת (משהו כמו `https://hob-crm.<שם>.workers.dev`). זו הכתובת החדשה של הלוח.
10. קבצים: להעלות את הקבצים מהדלי הישן לדלי החדש באותם נתיבים (Cloudflare → R2 → hob-crm-files → Upload). אפשר לדלג אם לא היו קבצים.
11. בדיקה: נכנסים לכתובת החדשה עם אותם שם משתמשת וסיסמה כמו קודם, מוודאים שהמשימות והמלאי שם. בטלפון: פותחים את הכתובת, "הוסף למסך הבית", ובהגדרות מפעילים התראות מחדש.
12. שופיפיי (אם מחובר): בממשק שופיפיי, Settings → Notifications → Webhooks, לעדכן את כתובת ה-webhook לכתובת החדשה `https://<הכתובת החדשה>/api/shopify-webhook`.
13. דומיין (אם היה): Cloudflare → Workers → hob-crm → Settings → Domains, מחברים את הדומיין ל-Worker החדש.
14. רק אחרי שהכל עובד יומיים: להודיע למי שמחזיק את החשבון הישן שאפשר למחוק שם את ה-Worker הישן.

בכל שלב, אם אני לא מבינה איפה להקליד או מה פתוח על המסך, תסביר בפשטות (טרמינל = "Terminal" במק, "PowerShell" בווינדוס). בוא נתחיל משלב הבדיקה של Node ו-Git.
