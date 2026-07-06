# Tele SumPlus

SumPlus is a TeleBox group chat summary plugin.

It keeps the Telegram command as `.sum`, but the plugin file is named `sumplus.ts` so it can be maintained separately from the official TeleBox `sum.ts`.

## Features

- Daily, weekly, catch-up and keyword summaries
- Person analysis with local identity matching
- Rank, links, todo, hot, vibe, meme, quotes, roast and CP modes
- Telegram-friendly output formatting
- OpenAI-compatible and Gemini-compatible providers
- Ordered fallback providers
- Model and token usage footer

## Install Into TeleBox

On a server that already has TeleBox:

```bash
git clone https://github.com/liuweiqiang0523/tele-sum.git
cd tele-sum
bash scripts/install-telebox.sh /root/telebox
pm2 restart telebox --update-env
```

The installer copies:

- `plugins/sumplus.ts`
- `plugins/sumplus.prepare.ts`
- `plugins/sumplus.provider.ts`
- `plugins/sumplus.prompts.ts`
- `plugins/sumplus.types.ts`

It does not overwrite `assets/sum/config.json`.

## Configure

In Telegram:

```text
.sum type openai
.sum url https://your-openai-compatible-endpoint/v1
.sum key sk-xxxx
.sum model your-model
.sum menu
```

For provider fallback, edit TeleBox's `assets/sum/config.json` and use `fallbacks`.

See `assets/sum/config.example.json`.

## Commands

The short version:

```text
.sum menu
.sum
.sum 200
.sum 6h
.sum day
.sum yesterday
.sum week
.sum catchup 8h
.sum hot 6h
.sum rank 24h
.sum links 24h
.sum todo 12h
.sum about AI 24h
.sum 6h @username
.sum user 200 张三
.sum cp 24h
.sum npc 24h
```

## Current Scope

This repository is currently the TeleBox plugin version.

The later goal is a standalone userbot version that can run without installing the full TeleBox project.

