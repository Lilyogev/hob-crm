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
