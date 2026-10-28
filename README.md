# Gorani bot (JavaScript + Lavalink)

دوو سێرڤیس لە Railway پێویستە:

```
gorani-js/
├── bot/        ← بۆتی Discord (Node.js)
└── lavalink/   ← سێرڤەری میوزیک (Lavalink 4)
```

## هەنگاوەکان

1. هەردوو فۆڵدەرەکە بخەرە GitHub (یان دوو repo ی جیا).
2. لە Railway، **سێرڤیسی یەکەم** دروست بکە لە فۆڵدەری `lavalink`
   (Settings → Root Directory = `lavalink`).
   - Variable: `LAVALINK_SERVER_PASSWORD` = وشەی نهێنییەک.
   - پۆرت: 2333.
3. **سێرڤیسی دووەم** دروست بکە لە فۆڵدەری `bot` (Root Directory = `bot`).
   Variables:
   - `DISCORD_TOKEN` = تۆکنی بۆتەکە
   - `LAVALINK_HOST` = `ناوی-سێرڤیسی-lavalink.railway.internal`
   - `LAVALINK_PORT` = `2333`
   - `LAVALINK_PASSWORD` = هەمان وشەی نهێنی سێرڤیسی Lavalink
4. سێرڤیسی Lavalink یەکەم دەست پێبکات، دواتر بۆتەکە.
5. لە لۆگی بۆتەکە دەبێت ببینیت: `[lavalink] node "main" connected`.

## گرنگ
- Lavalink دەبێت **4.2.0 یان نوێتر** بێت (DAVE). Dockerfile ـەکە `:4` بەکاردەهێنێت.
- یوتیوب هێشتا لەوانەیە بلۆک بێت (IPـی Railway). بۆتەکە بە خۆکاری SoundCloud تاقی دەکاتەوە.
- بۆتەکە دوای تەواوبوونی گۆرانییەکان لە ڤۆیس دەمێنێتەوە تا دیسکۆنێکتی بکەیت.
- ئەگەر دەنگ نەهات، لۆگی بۆتەکە (`[voice] socket closed ... code`) و لۆگی Lavalink ببینە.
