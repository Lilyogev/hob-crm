# העלאה לענן של hob (Cloudflare של אביה וליאור)

כל המשאבים כאן חדשים ושייכים ל-hob. **לא משתמשים באף מזהה של segula-board או של shay-crm.**
מומלץ: חשבון Cloudflare נפרד של השותפות (חינם מספיק לגרסה הראשונה).

## הכנה חד-פעמית
```bash
npm install
npx wrangler login                          # בחשבון של hob

# 1. מסד נתונים + דלי קבצים
npx wrangler d1 create hob-crm-db           # להעתיק את database_id לתוך wrangler.jsonc
npx wrangler r2 bucket create hob-crm-files

# 2. טבלאות
npm run db:migrate:remote

# 3. מפתחות להתראות בטלפון
node scripts/vapid-keys.mjs
#   VAPID_PUBLIC_KEY  → wrangler.jsonc תחת "vars"
#   VAPID_PRIVATE_JWK → סוד:
npx wrangler secret put VAPID_PRIVATE_JWK

# 4. הובי (העוזרת): מפתח Anthropic. בלי זה הכל עובד, רק הצ'אט וקריאת הקבלות כבויים.
npx wrangler secret put ANTHROPIC_API_KEY

# 5. שופיפיי (אופציונלי בהתחלה, ראו SHOPIFY.md)
npx wrangler secret put SHOPIFY_CLIENT_ID
npx wrangler secret put SHOPIFY_CLIENT_SECRET
npx wrangler secret put SHOPIFY_WEBHOOK_SECRET   # החתימה של ה-webhook (ראו SHOPIFY.md)

# 6. העלאה
npm run deploy

# 7. שתי המשתמשות. הסיסמה לא עוברת דרך git.
node scripts/create-user.mjs avia "אביה" 'סיסמה-ארוכה-וחזקה' > /tmp/u.sql
npx wrangler d1 execute hob-crm-db --remote --file=/tmp/u.sql && rm /tmp/u.sql
node scripts/create-user.mjs lior "ליאור" 'סיסמה-אחרת-ארוכה' > /tmp/u.sql
npx wrangler d1 execute hob-crm-db --remote --file=/tmp/u.sql && rm /tmp/u.sql
```
אחרי הכניסה הראשונה: הגדרות → למלא את שם החנות, כתובת החנות, תיאור המותג (הובי קוראת אותו), ולהפעיל התראות בטלפון (באייפון: קודם "הוסף למסך הבית").

## דומיין משלכן
Cloudflare → Workers → hob-crm → Settings → Domains → למשל `board.houseofbais.com`.
לינקים למשפיעניות יוצאים מהכתובת שרשומה בהגדרות (`collab_domain`); אם היא ריקה, מהכתובת של הלוח.

## גיבוי
כל לילה ב-03:00 (שעון ישראל) נשמר עותק JSON של כל הנתונים ל-R2: `hob-crm-files/backups/hob-backup-YYYY-MM-DD.json`. נשמרים 45 יום.
העותק לא כולל סיסמאות. בנוסף ל-D1 יש Time Travel (שחזור לכל דקה ב-30 הימים האחרונים): `npx wrangler d1 time-travel restore hob-crm-db --timestamp=...`.

## עדכון גרסה
```bash
git pull
npm install
npm run db:migrate:remote     # קודם הטבלאות
npm run deploy                # ואז הקוד
```

## הדגמה מקומית
```bash
npm run db:migrate:local
npm run db:seed:local   # כמה משימות ומוצרים לדוגמה, בלי כסף
npm run dev             # http://localhost:3000
```
**לא מריצים את הדמו על --remote**: הוא מוחק את כל הנתונים.

## העברה לחשבון Cloudflare של השותפות (כשמגיע הזמן)
הלוח יכול לעלות קודם בחשבון של יוגב ולעבור אחר כך לחשבון של אביה וליאור בלי לאבד נתונים. כשעה עבודה.

1. **חשבון חדש:** אחת מהן פותחת חשבון ב-https://dash.cloudflare.com/sign-up ומוסיפה את יוגב כחבר: Manage Account → Members → Invite (תפקיד Administrator). ככה יוגב מריץ את ההעברה, והחשבון נשאר שלהן.
2. **גיבוי מהחשבון הישן** (במחשב של יוגב, בתוך תיקיית הפרויקט, מחובר לחשבון הישן):
   ```bash
   npx wrangler d1 export hob-crm-db --remote --output=hob-data.sql --no-schema
   ```
   קבלות ותמונות מ-R2: להוריד את דלי `hob-crm-files` (Cloudflare → R2 → הדלי → Download, או `npx wrangler r2 object get` לכל קובץ). לגרסה הראשונה זה בדרך כלל כמה עשרות קבצים.
3. **הקמה בחשבון החדש:** `npx wrangler logout && npx wrangler login` (לבחור את החשבון של hob), ואז שלבים 1 עד 6 מ"הכנה חד-פעמית" למעלה. ה-database_id החדש נכנס ל-`wrangler.jsonc`.
4. **טעינת הנתונים:**
   ```bash
   npx wrangler d1 execute hob-crm-db --remote --file=hob-data.sql
   ```
   ואת הקבצים מעלים לדלי החדש באותו נתיב (`receipts/...`, `backups/...`).
5. **סודות מחדש:** ANTHROPIC_API_KEY, SHOPIFY_*, VAPID (אפשר לייצר זוג חדש; אז ההתראות בטלפון מופעלות מחדש מההגדרות).
6. **שופיפיי:** לעדכן את כתובת ה-webhook לכתובת החדשה של ה-Worker (SHOPIFY.md, שלב ה-webhook).
7. **דומיין:** אם היה דומיין מותאם, מחברים אותו ל-Worker החדש ומנתקים מהישן. אחרי שהכל עובד: `npx wrangler delete` בחשבון הישן.

המשתמשות והסיסמאות עוברות עם הנתונים (טבלת users), אין צורך ליצור מחדש.
