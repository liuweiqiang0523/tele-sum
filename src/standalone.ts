import "dotenv/config";
import fs from "fs";
import path from "path";
import { createInterface } from "readline/promises";
import { stdin as input, stdout as output } from "process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions";
import { NewMessage, NewMessageEvent } from "teleproto/events";

import { modePrompts, personAnalysisPrompt, templatePolishPrompt, unifiedSummaryPrompt } from "../plugins/sumplus.prompts";
import { providerChainLines, summarize, tokenUsageText, trimTrailingSlash } from "../plugins/sumplus.provider";
import type { SumConfig, TokenUsage } from "../plugins/sumplus.provider";
import type { ChatMessageRecord, MessageFetchResult, PreparedInput, SumMode } from "../plugins/sumplus.types";
import {
  buildLocalSummaryStats,
  buildPersonChangeStats,
  buildPersonLocalStats,
  compactText,
  formatDate,
  prepareCompareInput,
  prepareKeywordInput,
  preparePersonInput,
  prepareSpecialInput,
  prepareSummaryInput,
  sortRecords,
} from "../plugins/sumplus.prepare";

const CONFIG_PATH = process.env.TELE_SUM_CONFIG || path.join(process.cwd(), "config.json");
const DURATION_PAGE_SIZE = 100;
const MAX_DURATION_FETCH_PAGES = 24;
const MAX_DURATION_FETCH_MESSAGES = 2000;
const COMMAND_PREFIXES = (process.env.TELE_SUM_PREFIXES || ".").split(/\s+/).filter(Boolean);
const IMAGE_MODE_TOKENS = new Set(["pic", "image", "img", "图片", "海报"]);

type TelegramConfig = {
  apiId: number;
  apiHash: string;
  session?: string;
  selfCommandsOnly?: boolean;
};

type AppConfig = {
  telegram: TelegramConfig;
  sum: SumConfig;
};

type RangeSpec = {
  label: string;
  count?: number;
  startTime?: number;
  endTime?: number;
};

type SpecialRequest = {
  mode: SumMode;
  rangeToken?: string;
  target?: string;
  keyword?: string;
  title: string;
  defaultRangeToken: string;
};

type SummaryDensity = {
  label: string;
  targetLength: string;
  topicLimit: number;
  pointLimit: number;
  highlightLimit: number;
  quoteLimit: number;
  todoLimit: number;
  maxOutputLength: number;
};

function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

function writeJson(file: string, value: unknown): void {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function loadConfig(): AppConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`未找到配置文件：${CONFIG_PATH}。请复制 config.example.json 为 config.json 后填写。`);
  }
  const config = readJson<AppConfig>(CONFIG_PATH);
  if (!config.telegram?.apiId || !config.telegram?.apiHash) {
    throw new Error("config.json 缺少 telegram.apiId 或 telegram.apiHash");
  }
  if (!config.sum?.apiKey || !config.sum?.baseUrl || !config.sum?.model) {
    throw new Error("config.json 缺少 sum.apiKey/baseUrl/model");
  }
  return config;
}

function saveSession(config: AppConfig, session: string): void {
  config.telegram.session = session;
  writeJson(CONFIG_PATH, config);
}

function promptText(question: string): Promise<string> {
  const rl = createInterface({ input, output });
  return rl.question(question).finally(() => rl.close());
}

async function createClient(config: AppConfig): Promise<TelegramClient> {
  const client = new TelegramClient(
    new StringSession(config.telegram.session || ""),
    config.telegram.apiId,
    config.telegram.apiHash,
    {
      connectionRetries: Infinity,
      reconnectRetries: Infinity,
      autoReconnect: true,
      deviceModel: "Tele SumPlus",
    },
  );

  await client.start({
    phoneNumber: async () => await promptText("Enter phone number (+86...): "),
    password: async () => await promptText("Enter 2FA password (if any): "),
    phoneCode: async () => await promptText("Enter the verification code: "),
    onError: (error: Error) => console.error("Login error:", error.message),
  });

  saveSession(config, (client.session as StringSession).save());
  return client;
}

function htmlEscape(text: string): string {
  return String(text || "").replace(/[&<>"']/g, (char) => (
    {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#x27;",
    } as Record<string, string>
  )[char] || char);
}

function markdownToTelegramHtml(text: string): string {
  const anchors: Array<{ token: string; html: string }> = [];
  let protectedText = text.replace(/\[([^\]\n]{1,80})\]\((https?:\/\/[^)\s]+)\)/g, (_match, label: string, url: string) => {
    const token = `@@LINK_${anchors.length}@@`;
    anchors.push({ token, html: `<a href="${htmlEscape(url)}">${htmlEscape(label)}</a>` });
    return token;
  });

  protectedText = htmlEscape(protectedText)
    .replace(/^###\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^##\s+(.+)$/gm, "<b>$1</b>")
    .replace(/^#\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]{1,120})\*\*/g, "<b>$1</b>");

  for (const anchor of anchors) {
    protectedText = protectedText.replace(anchor.token, anchor.html);
  }
  return protectedText;
}

function splitLongText(text: string, maxLength = 3500): string[] {
  if (text.length <= maxLength) return [text];
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > maxLength) {
    const chunk = remaining.slice(0, maxLength);
    const index = Math.max(chunk.lastIndexOf("\n\n"), chunk.lastIndexOf("\n"), chunk.lastIndexOf("。"));
    const splitAt = index > 1200 ? index : maxLength;
    parts.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

function withPartHeader(parts: string[]): string[] {
  if (parts.length <= 1) return parts;
  return parts.map((part, index) => `📄 摘要分段 ${index + 1}/${parts.length}\n\n${part}`);
}

function footerText(providerName: string, model: string, usage?: TokenUsage, inputCount?: number): string {
  return [
    "---",
    `🤖 模型：${providerName}｜${model}`,
    `📥 输入：${inputCount ?? 0} 条`,
    tokenUsageText(usage),
  ].filter(Boolean).join("\n");
}

function valueToString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && typeof (value as { toString?: unknown }).toString === "function") {
    const text = String((value as { toString: () => string }).toString());
    return text === "[object Object]" ? "" : text;
  }
  return String(value);
}

function createMessageRecord(item: unknown): ChatMessageRecord | null {
  const msg = item as any;
  if (!msg?.message && !msg?.media) return null;
  const timestamp = Number(msg.date || 0);
  if (!timestamp) return null;

  let content = String(msg.message || "").trim();
  if (!content && msg.media) content = "[媒体消息]";
  if (!content) return null;

  const senderInfo = msg.sender || {};
  const firstName = String(senderInfo.firstName || "").trim();
  const lastName = String(senderInfo.lastName || "").trim();
  const username = String(senderInfo.username || "").trim();
  const senderId =
    valueToString(msg.senderId) ||
    valueToString(senderInfo.id) ||
    valueToString(msg.fromId?.userId) ||
    "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  const sender = fullName || firstName || username || senderId || "未知用户";

  return {
    id: Number(msg.id || 0),
    timestamp,
    sender,
    senderId,
    username,
    firstName,
    lastName,
    content: compactText(content),
  };
}

function isSumSelfNoiseRecord(record: ChatMessageRecord): boolean {
  const content = record.content.trim().replace(/^#+\s*/, "");
  if (!content) return true;
  if (content.startsWith("⏳ 正在读取消息并生成摘要")) return true;
  if (content.startsWith("⏳ 正在读取消息并生成图片摘要")) return true;
  if (content.startsWith("🎨 正在获取头像并排版")) return true;
  if (content.startsWith("❌ 摘要失败")) return true;
  return [
    "📊 群聊消息摘要",
    "📋 @",
    "🔥 争议雷达",
    "🏅 群聊贡献榜",
    "🔗 链接与资源整理",
    "✅ 待办 / 需要关注",
    "🍬 今日互动嗑糖榜",
    "🧙 今日群友职业分配",
  ].some((heading) => content.startsWith(heading));
}

async function safeGetMessages(client: TelegramClient, entity: unknown, params: Record<string, unknown>): Promise<unknown[]> {
  try {
    const result = await (client as any).getMessages(entity, params);
    if (Array.isArray(result)) return result;
    return result ? [result] : [];
  } catch (error) {
    const message = String((error as Error)?.message || error || "");
    if (message.includes("Cannot read properties of undefined") && message.includes("reading 'date'")) {
      return [];
    }
    throw error;
  }
}

async function getChatMessageRecords(client: TelegramClient, peer: unknown, count: number): Promise<MessageFetchResult> {
  const messages = await safeGetMessages(client, peer, { limit: count });
  const records = messages
    .map(createMessageRecord)
    .filter((record): record is ChatMessageRecord => Boolean(record))
    .filter((record) => !isSumSelfNoiseRecord(record));
  return {
    records: sortRecords(records),
    fetchedPages: messages.length ? 1 : 0,
    reachedFetchLimit: false,
    reachedTimeBoundary: true,
  };
}

async function getChatMessageRecordsByTimeRange(
  client: TelegramClient,
  peer: unknown,
  startTime: number,
  endTime: number,
): Promise<MessageFetchResult> {
  const records: ChatMessageRecord[] = [];
  let offsetId = 0;
  let fetchedPages = 0;
  let reachedFetchLimit = false;
  let reachedTimeBoundary = false;
  const seenIds = new Set<number>();

  while (true) {
    if (fetchedPages >= MAX_DURATION_FETCH_PAGES || records.length >= MAX_DURATION_FETCH_MESSAGES) {
      reachedFetchLimit = true;
      break;
    }
    const batch = await safeGetMessages(client, peer, { limit: DURATION_PAGE_SIZE, offsetId, addOffset: 0 });
    if (!batch.length) break;
    fetchedPages += 1;

    let reachedOlderThanRange = false;
    for (const item of batch) {
      const msg = item as any;
      const id = Number(msg.id || 0);
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      const msgTime = Number(msg.date || 0);
      if (!msgTime) continue;
      if (msgTime < startTime) {
        reachedOlderThanRange = true;
        continue;
      }
      if (msgTime > endTime) continue;
      const record = createMessageRecord(msg);
      if (record && !isSumSelfNoiseRecord(record)) records.push(record);
    }

    const last = batch[batch.length - 1] as any;
    const nextOffsetId = Number(last?.id || 0);
    if (!nextOffsetId || nextOffsetId === offsetId || reachedOlderThanRange) {
      reachedTimeBoundary = reachedOlderThanRange;
      break;
    }
    offsetId = nextOffsetId;
  }

  return { records: sortRecords(records), fetchedPages, reachedFetchLimit, reachedTimeBoundary };
}

function parseDurationToken(token: string): number | null {
  const match = token.match(/^(\d+)(m|h|d)$/i);
  if (!match) return null;
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0) return null;
  if (unit === "m") return value;
  if (unit === "h") return value * 60;
  return value * 24 * 60;
}

function resolveRangeToken(token?: string, defaultToken = "100"): RangeSpec {
  const now = new Date();
  const end = Math.floor(now.getTime() / 1000);
  const value = token || defaultToken;
  const duration = parseDurationToken(value);
  if (duration) return { label: `最近 ${value}`, startTime: end - duration * 60, endTime: end };
  if (/^\d+$/.test(value)) return { label: `最近 ${value} 条`, count: Number(value) };
  if (value === "day" || value === "today") {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return { label: "今天", startTime: Math.floor(start.getTime() / 1000), endTime: end };
  }
  if (value === "yesterday") {
    const start = new Date(now);
    start.setDate(start.getDate() - 1);
    start.setHours(0, 0, 0, 0);
    const stop = new Date(start);
    stop.setHours(23, 59, 59, 999);
    return { label: "昨天", startTime: Math.floor(start.getTime() / 1000), endTime: Math.floor(stop.getTime() / 1000) };
  }
  if (value === "week") {
    const start = new Date(now);
    const day = start.getDay() || 7;
    start.setDate(start.getDate() - day + 1);
    start.setHours(0, 0, 0, 0);
    return { label: "本周", startTime: Math.floor(start.getTime() / 1000), endTime: end };
  }
  return { label: "最近 100 条", count: 100 };
}

function parseRangeAndRest(args: string[], defaultRangeToken: string): { rangeToken: string; rest: string[] } {
  if (!args.length) return { rangeToken: defaultRangeToken, rest: [] };
  const first = args[0];
  if (/^\d+$/.test(first) || parseDurationToken(first) || ["day", "today", "yesterday", "week"].includes(first)) {
    return { rangeToken: first, rest: args.slice(1) };
  }
  return { rangeToken: defaultRangeToken, rest: args };
}

function parseSummaryRequest(firstArg?: string, restArgs: string[] = []): { rangeToken?: string; target: string } {
  if (!firstArg) return { rangeToken: "100", target: "" };
  if (firstArg === "user" || firstArg === "person" || firstArg === "人物") {
    const parsed = parseRangeAndRest(restArgs, "24h");
    return { rangeToken: parsed.rangeToken, target: parsed.rest.join(" ").trim() };
  }
  if (/^\d+$/.test(firstArg) || parseDurationToken(firstArg) || ["day", "today", "yesterday", "week"].includes(firstArg)) {
    return { rangeToken: firstArg, target: restArgs.join(" ").trim() };
  }
  return { rangeToken: "24h", target: [firstArg, ...restArgs].join(" ").trim() };
}

function parseSpecialRequest(sub: string, args: string[]): SpecialRequest | null {
  const normalized = sub.toLowerCase();
  const aliases: Record<string, { mode: SumMode; title: string; defaultRangeToken: string }> = {
    hot: { mode: "hot", title: "争议雷达", defaultRangeToken: "24h" },
    rank: { mode: "rank", title: "贡献榜", defaultRangeToken: "24h" },
    links: { mode: "links", title: "链接整理", defaultRangeToken: "24h" },
    todo: { mode: "todo", title: "待办整理", defaultRangeToken: "12h" },
    catchup: { mode: "catchup", title: "补课", defaultRangeToken: "8h" },
    vibe: { mode: "vibe", title: "气氛小剧场", defaultRangeToken: "12h" },
    meme: { mode: "meme", title: "热梗榜", defaultRangeToken: "24h" },
    melon: { mode: "melon", title: "吃瓜速报", defaultRangeToken: "24h" },
    quotes: { mode: "quotes", title: "金句收藏", defaultRangeToken: "24h" },
    roast: { mode: "roast", title: "槽点日报", defaultRangeToken: "24h" },
    cp: { mode: "cp", title: "互动嗑糖榜", defaultRangeToken: "24h" },
    abstract: { mode: "abstract", title: "抽象指数", defaultRangeToken: "24h" },
    award: { mode: "award", title: "颁奖典礼", defaultRangeToken: "24h" },
    mood: { mode: "mood", title: "情绪天气", defaultRangeToken: "24h" },
    npc: { mode: "npc", title: "职业分配", defaultRangeToken: "24h" },
    map: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    relation: { mode: "relation", title: "人物关系网", defaultRangeToken: "24h" },
    story: { mode: "story", title: "剧情线", defaultRangeToken: "day" },
    compare: { mode: "compare", title: "今日对比", defaultRangeToken: "day" },
    track: { mode: "track", title: "争议追踪", defaultRangeToken: "24h" },
    about: { mode: "about", title: "关键词追踪", defaultRangeToken: "24h" },
  };
  const item = aliases[normalized];
  if (!item) return null;
  if (item.mode === "about") {
    const parsed = parseRangeAndRest(args, item.defaultRangeToken);
    return { ...item, rangeToken: parsed.rangeToken, keyword: parsed.rest.join(" ").trim() };
  }
  const parsed = parseRangeAndRest(args, item.defaultRangeToken);
  return { ...item, rangeToken: parsed.rangeToken, target: parsed.rest.join(" ").trim() };
}

function getDensity(records: ChatMessageRecord[], mode: SumMode): SummaryDensity {
  const count = records.length;
  const isEntertainment = ["roast", "cp", "award", "npc", "meme", "abstract", "mood"].includes(mode);
  if (count <= 30) {
    return {
      label: "短消息模式",
      targetLength: isEntertainment ? "约 300-600 中文字" : "约 250-500 中文字",
      topicLimit: Math.min(2, Math.max(1, count)),
      pointLimit: 1,
      highlightLimit: 1,
      quoteLimit: 1,
      todoLimit: 2,
      maxOutputLength: 1000,
    };
  }
  if (count >= 900) {
    return {
      label: "长消息模式",
      targetLength: isEntertainment ? "约 900-1300 中文字" : "约 1300-1800 中文字",
      topicLimit: isEntertainment ? 5 : 5,
      pointLimit: 2,
      highlightLimit: 4,
      quoteLimit: 3,
      todoLimit: 3,
      maxOutputLength: 2600,
    };
  }
  return {
    label: "标准模式",
    targetLength: isEntertainment ? "约 650-1000 中文字" : count >= 500 ? "约 900-1300 中文字" : "约 550-850 中文字",
    topicLimit: isEntertainment ? (count >= 500 ? 4 : 3) : count >= 500 ? 4 : 3,
    pointLimit: 2,
    highlightLimit: 3,
    quoteLimit: 2,
    todoLimit: 3,
    maxOutputLength: count >= 500 ? 2000 : 1400,
  };
}

function buildSystemPrompt(configPrompt: string | undefined): string {
  const prompt = String(configPrompt || "").trim();
  if (!prompt || prompt === unifiedSummaryPrompt.trim()) return `${unifiedSummaryPrompt}${templatePolishPrompt}`;
  return `${unifiedSummaryPrompt}${templatePolishPrompt}\n\n【自定义补充要求】\n${prompt}`;
}

function buildModePrompt(mode: SumMode, keyword?: string): string {
  if (mode === "summary") return `${unifiedSummaryPrompt}${templatePolishPrompt}`;
  if (mode === "person") return `${personAnalysisPrompt}${templatePolishPrompt}`;
  const prompt = modePrompts[mode] || unifiedSummaryPrompt;
  return `${prompt}${templatePolishPrompt}${keyword ? `\n\n本次关键词：${keyword}` : ""}`;
}

function buildUserPrompt(params: {
  chatName: string;
  mode: SumMode;
  rangeLabel: string;
  records: ChatMessageRecord[];
  prepared: PreparedInput;
  target?: string;
  keyword?: string;
}): string {
  const density = getDensity(params.records, params.mode);
  return [
    `群名：${params.chatName}`,
    `摘要范围：${params.rangeLabel}`,
    `模式：${params.mode}`,
    params.target ? `重点分析对象：${params.target}` : "",
    params.keyword ? `关键词：${params.keyword}` : "",
    `输出密度：${density.label}`,
    `目标长度：${density.targetLength}`,
    `重点话题上限：${density.topicLimit}`,
    `每个话题要点上限：${density.pointLimit}`,
    `亮点上限：${density.highlightLimit}`,
    `金句上限：${density.quoteLimit}`,
    `待办上限：${density.todoLimit}`,
    `本地输入说明：${params.prepared.note}`,
    "",
    ...(params.mode === "summary" ? buildLocalSummaryStats(params.records, params.prepared) : []),
    "",
    "聊天消息：",
    ...params.prepared.lines,
  ].filter(Boolean).join("\n");
}

async function getChatName(client: TelegramClient, peer: unknown): Promise<string> {
  try {
    const entity = await (client as any).getEntity(peer);
    return String(entity?.title || [entity?.firstName, entity?.lastName].filter(Boolean).join(" ") || entity?.username || "当前聊天");
  } catch {
    return "当前聊天";
  }
}

async function fetchByRange(client: TelegramClient, peer: unknown, range: RangeSpec): Promise<MessageFetchResult> {
  if (range.startTime && range.endTime) {
    return await getChatMessageRecordsByTimeRange(client, peer, range.startTime, range.endTime);
  }
  return await getChatMessageRecords(client, peer, range.count || 100);
}

async function fetchPreviousRange(client: TelegramClient, peer: unknown, range: RangeSpec): Promise<{ label: string; result: MessageFetchResult }> {
  if (range.startTime && range.endTime) {
    const span = range.endTime - range.startTime;
    const previousEnd = range.startTime - 1;
    const previousStart = previousEnd - span;
    return {
      label: `对照 ${formatDate(new Date(previousStart * 1000))} 至 ${formatDate(new Date(previousEnd * 1000))}`,
      result: await getChatMessageRecordsByTimeRange(client, peer, previousStart, previousEnd),
    };
  }
  const count = range.count || 100;
  return {
    label: `对照最近 ${count} 条之前的约 ${count} 条`,
    result: await getChatMessageRecords(client, peer, Math.min(count * 2, 2000)),
  };
}

async function sendText(client: TelegramClient, peer: unknown, text: string, editMessage?: any): Promise<void> {
  const parts = withPartHeader(splitLongText(text)).map(markdownToTelegramHtml);
  if (editMessage) {
    try {
      await editMessage.edit({ text: parts[0], parseMode: "html" });
    } catch {
      await (client as any).sendMessage(peer, { message: parts[0], parseMode: "html" });
    }
  } else {
    await (client as any).sendMessage(peer, { message: parts[0], parseMode: "html" });
  }
  for (const part of parts.slice(1)) {
    await (client as any).sendMessage(peer, { message: part, parseMode: "html" });
  }
}

async function sendImage(client: TelegramClient, peer: unknown, pages: Buffer[]): Promise<void> {
  const file = pages[0] as (Buffer & { name?: string }) | undefined;
  if (!file) throw new Error("图片渲染结果为空");
  file.name = `sumplus-${Date.now()}.png`;
  await (client as any).sendFile(peer, { file, forceDocument: false });
}

function summaryImageTitle(mode: SumMode, chatName: string, specialTitle?: string): string {
  if (mode === "summary") {
    if (specialTitle === "群聊日报") return `📆 群聊日报｜${chatName}`;
    if (specialTitle === "昨日群聊日报") return `📜 昨日群聊日报｜${chatName}`;
    if (specialTitle === "群聊周报") return `🗓️ 群聊周报｜${chatName}`;
    return `📊 群聊消息摘要｜${chatName}`;
  }
  const titles: Partial<Record<SumMode, string>> = {
    hot: "🔥 群聊争议雷达", rank: "🏆 今日话唠榜", links: "🔗 链接资源整理", todo: "✅ 群聊待办清单",
    catchup: "🧭 错过消息补课", vibe: "🎭 群聊小剧场", about: "🔎 关键词追踪", meme: "🧨 今日热梗榜",
    relation: "🕸️ 人物关系网", story: "🎬 群聊剧情线", compare: "📈 昨日今日对比", track: "🛰️ 争议追踪",
    quotes: "💬 金句收藏夹", melon: "🍉 今日吃瓜速报", roast: "😏 今日槽点日报", cp: "🍬 今日互动嗑糖榜",
    abstract: "🌀 今日抽象指数", award: "🏆 群聊颁奖典礼", mood: "🌦️ 今日群聊天气", npc: "🧙 群友职业分配",
  };
  return `${titles[mode] || "📊 群聊消息摘要"}｜${chatName}`;
}

function helpText(): string {
  return [
    "# SumPlus Standalone",
    "",
    ".sum - 最近 100 条摘要",
    ".sum 200 - 最近 200 条",
    ".sum 6h - 最近 6 小时",
    ".sum day / yesterday / week",
    ".sum hot 6h / rank 24h / links 24h",
    ".sum cp 24h / npc 24h / roast 24h",
    ".sum day pic - 图片版；其他命令也可在末尾加 pic",
    ".sum about AI 24h",
    ".sum user 24h 张三",
  ].join("\n");
}

async function handleSumCommand(client: TelegramClient, config: AppConfig, message: any, args: string[]): Promise<void> {
  const peer = message.inputChat || message.peerId || message.chatId;
  if (!peer) return;
  const imageMode = args.some((item) => IMAGE_MODE_TOKENS.has(item.toLowerCase()));
  const effectiveArgs = imageMode ? args.filter((item) => !IMAGE_MODE_TOKENS.has(item.toLowerCase())) : args;
  const sub = effectiveArgs[0]?.toLowerCase() || "";
  if (sub === "help" || sub === "menu") {
    await sendText(client, peer, helpText(), message.out ? message : undefined);
    return;
  }
  if (sub === "status") {
    await sendText(client, peer, [
      "# SumPlus 状态",
      "",
      ...providerChainLines(config.sum),
    ].join("\n"), message.out ? message : undefined);
    return;
  }

  await sendText(client, peer, imageMode ? "⏳ 正在读取消息并生成图片摘要..." : "⏳ 正在读取消息并生成摘要...", message.out ? message : undefined);

  const special = parseSpecialRequest(sub, effectiveArgs.slice(1));
  const request = special
    ? { mode: special.mode, rangeToken: special.rangeToken, target: special.target || "", keyword: special.keyword || "" }
    : { mode: "summary" as SumMode, ...parseSummaryRequest(effectiveArgs[0], effectiveArgs.slice(1)), keyword: "" };
  const range = resolveRangeToken(request.rangeToken, special?.defaultRangeToken || "100");
  const chatName = await getChatName(client, peer);
  const fetchResult = await fetchByRange(client, peer, range);
  if (!fetchResult.records.length) {
    await sendText(client, peer, "没有找到可总结的文本消息。", message.out ? message : undefined);
    return;
  }

  let prepared: PreparedInput;
  if (request.mode === "compare") {
    const previous = await fetchPreviousRange(client, peer, range);
    prepared = prepareCompareInput(fetchResult.records, previous.result.records, range.label, previous.label);
  } else if (request.mode === "person" || request.target) {
    prepared = preparePersonInput(fetchResult.records, request.target || "");
  } else if (request.mode === "about") {
    prepared = prepareKeywordInput(fetchResult.records, request.keyword || "");
  } else if (request.mode === "summary") {
    prepared = prepareSummaryInput(fetchResult.records);
  } else {
    prepared = prepareSpecialInput(request.mode, fetchResult.records, request.keyword || "");
  }

  const extraStats = request.mode === "person" || request.target
    ? [
      "",
      ...buildPersonLocalStats(fetchResult.records, request.target || "", prepared),
      ...buildPersonChangeStats(fetchResult.records, null, request.target || "", range.label, ""),
    ]
    : [];
  const userPrompt = `${buildUserPrompt({
    chatName,
    mode: request.mode === "person" || request.target ? "person" : request.mode,
    rangeLabel: range.label,
    records: fetchResult.records,
    prepared,
    target: request.target,
    keyword: request.keyword,
  })}${extraStats.length ? `\n${extraStats.join("\n")}` : ""}`;
  const systemPrompt = request.mode === "summary"
    ? buildSystemPrompt(config.sum.prompt)
    : buildModePrompt(request.mode === "person" || request.target ? "person" : request.mode, request.keyword);
  const density = getDensity(fetchResult.records, request.mode === "person" || request.target ? "person" : request.mode);
  const result = await summarize({
    ...config.sum,
    prompt: systemPrompt,
    maxOutputLength: Math.min(config.sum.maxOutputLength || density.maxOutputLength, density.maxOutputLength),
  }, userPrompt);
  const text = `${result.content.trim()}\n${footerText(result.provider.name, result.provider.model, result.usage, fetchResult.records.length)}`;

  if (imageMode) {
    try {
      await sendText(client, peer, "🎨 正在获取头像并排版...", message.out ? message : undefined);
      const { renderSummaryImages } = await import("../plugins/sumplus.image");
      const imageResult = await renderSummaryImages({
        client,
        chatName,
        title: summaryImageTitle(request.mode, chatName, special?.title),
        mode: request.mode,
        summary: text,
        records: fetchResult.records,
        providerName: result.provider.name,
        model: result.provider.model,
      });
      await sendImage(client, peer, imageResult.pages);
      if (message.out) await message.delete({ revoke: true });
      return;
    } catch (error) {
      console.warn("image render failed, falling back to text:", error);
    }
  }

  await sendText(client, peer, text, message.out ? message : undefined);
}

function parseCommandText(text: string): string[] | null {
  const trimmed = text.trim();
  for (const prefix of COMMAND_PREFIXES) {
    const command = `${prefix}sum`;
    if (trimmed === command) return [];
    if (trimmed.startsWith(`${command} `)) return trimmed.slice(command.length).trim().split(/\s+/).filter(Boolean);
  }
  return null;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const client = await createClient(config);
  console.log("Tele SumPlus standalone started.");
  console.log(`Commands: ${COMMAND_PREFIXES.map((prefix) => `${prefix}sum`).join(", ")}`);

  client.addEventHandler(async (event: NewMessageEvent) => {
    const message = event.message as any;
    if (config.telegram.selfCommandsOnly !== false && !message.out) return;
    const text = String(message.message || "");
    const args = parseCommandText(text);
    if (!args) return;
    try {
      await handleSumCommand(client, config, message, args);
    } catch (error) {
      const peer = message.inputChat || message.peerId || message.chatId;
      const detail = error instanceof Error ? error.message : String(error);
      console.error("sum command failed:", error);
      if (peer) await sendText(client, peer, `❌ 摘要失败：${detail}`, message.out ? message : undefined);
    }
  }, new NewMessage({}));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
