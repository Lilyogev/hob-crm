# hob | הלוח של House of Bais: איך מתחילים

היי אביה וליאור. בתיקייה הזאת נמצא כל הקוד של הלוח שלכן. הוא רץ בענן של Cloudflare (חינם), על חשבון שלכן. ההתקנה היא פעם אחת, כ-20 דקות, ולא צריך לדעת לתכנת.

## הדרך הקלה: לתת ל-Claude להוביל
1. פותחות https://claude.ai (או ChatGPT) במחשב.
2. פותחות את הקובץ `SETUP-PROMPT.md` שבתיקייה הזאת, מעתיקות את כל הטקסט מתחת לקו ומדביקות בצ'אט.
3. הוא שואל, אתן עונות, צעד אחרי צעד. בסוף יש לכן כתובת של הלוח ושתי סיסמאות.

## הדרך הישירה: הפקודות בעצמכן
מתקינות פעם אחת: Node.js (https://nodejs.org, גרסה 22 ומעלה). פותחות טרמינל (במק: Terminal, בווינדוס: PowerShell) בתוך התיקייה הזאת, ומריצות שורה-שורה:
```
npm install
npx wrangler login                          # נפתח דפדפן, מאשרות את חשבון Cloudflare שלכן
npx wrangler d1 create hob-crm-db           # מדפיס database_id: להעתיק לתוך wrangler.jsonc במקום האפסים
npx wrangler r2 bucket create hob-crm-files
npm run db:migrate:remote
node scripts/vapid-keys.mjs                 # VAPID_PUBLIC_KEY לתוך wrangler.jsonc תחת vars
npx wrangler secret put VAPID_PRIVATE_JWK   # מדביקות את ה-JSON שהודפס
npx wrangler secret put ANTHROPIC_API_KEY   # מפתח מ-https://console.anthropic.com (בשביל הובי)
npm run deploy                              # מדפיס את הכתובת של הלוח
node scripts/create-user.mjs avia "אביה" 'סיסמה-של-אביה' > u.sql
npx wrangler d1 execute hob-crm-db --remote --file=u.sql
node scripts/create-user.mjs lior "ליאור" 'סיסמה-של-ליאור' > u.sql
npx wrangler d1 execute hob-crm-db --remote --file=u.sql
```
ומוחקות את `u.sql`. הפירוט המלא: `DEPLOY.md`. חיבור לשופיפיי: `SHOPIFY.md`.

## אחרי הכניסה הראשונה
- בטלפון: פותחות את הכתובת → שיתוף → "הוסף למסך הבית".
- הגדרות → "רקע על המותג" ו"רקע עליכן" (הובי קוראת את זה), ולהפעיל התראות.
- מלאי → להוסיף את הפריטים והכמויות, או לכתוב להובי "תוסיפי למלאי 10 חולצות לבנות M אצל אביה".

## מה יש בלוח
משותף / אביה / ליאור (משימות) · מלאי לפי מי מחזיקה · כספים עם סימולטור דרופ · משפיעניות עם קודי הנחה · הובי, העוזרת בצ'אט (טקסט, קול, צילום קבלה) · הגדרות.
