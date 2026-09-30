# hob | הלוח של House of Bais

לוח ניהול לשותפות אביה וליאור: משימות (משותף / אביה / ליאור), מלאי לפי מיקום, כספים עם סימולטור דרופ, משפיעניות, והובי, העוזרת הדיגיטלית.

- מתחילות כאן: `START-HERE.md` (ופרומט מוכן לקלוד ב-`SETUP-PROMPT.md`)
- התקנה והעלאה לענן: `DEPLOY.md` (כולל העברה לחשבון אחר; פרומט מוכן לשותפות ב-`MIGRATE-PROMPT.md`)
- חיבור לשופיפיי: `SHOPIFY.md`
- החלטות ארכיטקטורה (למפתחים ולסוכני AI): `CLAUDE.md`

```bash
npm install
npm run db:migrate:local && npm run db:seed:local
npm run dev
```
