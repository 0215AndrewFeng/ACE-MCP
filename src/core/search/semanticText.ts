const NON_ASCII_PATTERN = /[^\x00-\x7F]/;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const CAMEL_BOUNDARY_PATTERN = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY_PATTERN = /([A-Z]+)([A-Z][a-z])/g;

import type { SymbolInfo } from "../common/types.js";
import { generateSymbolLabels } from "./symbolLabeler.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "array",
  "async",
  "await",
  "boolean",
  "by",
  "class",
  "const",
  "def",
  "else",
  "enum",
  "export",
  "false",
  "for",
  "from",
  "function",
  "if",
  "import",
  "in",
  "interface",
  "internal",
  "let",
  "namespace",
  "new",
  "null",
  "number",
  "object",
  "of",
  "on",
  "or",
  "package",
  "private",
  "protected",
  "public",
  "record",
  "return",
  "self",
  "set",
  "static",
  "string",
  "task",
  "the",
  "this",
  "to",
  "true",
  "using",
  "var",
  "void",
  "with",
]);

const SYNONYM_GROUPS = [
  ["login", "signin", "signon", "auth", "authenticate", "authentication", "登录", "认证"],
  ["logout", "signout", "signoff", "登出"],
  ["handler", "controller", "route", "endpoint", "api", "处理器", "控制器", "接口"],
  ["service", "manager", "usecase", "服务", "管理器"],
  ["repository", "repo", "dao", "store", "仓库", "数据访问"],
  ["create", "add", "insert", "save", "创建", "添加", "保存"],
  ["delete", "remove", "删除", "移除"],
  ["update", "modify", "edit", "patch", "更新", "修改"],
  ["payment", "pay", "charge", "billing", "支付", "付款", "扣费"],
  ["refund", "reimburse", "return", "退款", "退票"],
  ["config", "configuration", "setting", "settings", "option", "options", "配置", "设置"],
  ["init", "initialize", "bootstrap", "startup", "start", "初始化", "启动"],
  ["search", "find", "lookup", "query", "搜索", "查找", "查询"],
  ["message", "event", "notification", "消息", "事件", "通知"],
  ["user", "account", "member", "profile", "用户", "账户", "会员"],
  ["order", "订单"],
  ["ticket", "出票", "票"],
  ["endorse", "改签"],
  ["void", "voided", "作废", "已作废"],
  ["flight", "航班", "机票"],
  ["itinerary", "行程"],
  ["passenger", "旅客", "乘客"],
  ["booking", "reserve", "预订", "预留"],
  ["cancel", "cancelled", "取消", "已取消"],
  ["monitor", "监控"],
  ["print", "打印"],
  ["process", "handle", "处理"],
  ["validate", "verify", "check", "校验", "验证", "检查"],
  ["cache", "缓存"],
  ["index", "索引"],
  ["sync", "同步"],
  ["async", "异步"],
  ["batch", "批量"],
  ["retry", "重试"],
  ["timeout", "超时"],
  ["callback", "webhook", "回调"],
  ["impl", "implementation", "实现"],
  ["factory", "工厂"],
  ["builder", "构建器"],
  ["adapter", "适配器"],
  ["proxy", "代理"],
  ["interceptor", "拦截器"],
  ["listener", "observer", "监听器", "观察者"],
  ["strategy", "策略"],
  ["template", "模板"],
  ["converter", "transformer", "转换器"],
  ["parser", "解析器"],
  ["validator", "校验器"],
  ["gateway", "网关"],
  ["client", "客户端"],
  ["middleware", "中间件"],
  ["entity", "实体"],
  ["model", "模型"],
  ["dto", "传输对象"],
  ["enum", "枚举"],
  ["util", "utils", "helper", "工具", "辅助"],
  ["pending", "待处理"],
  ["domestic", "国内"],
  ["international", "国际"],
  ["speed", "极速", "加速"],
  ["write", "回写", "写入"],
  ["read", "读取"],
  ["dispatch", "分发"],
  ["publish", "发布"],
  ["subscribe", "订阅"],
  ["consume", "消费"],
  ["produce", "生产"],
  ["transaction", "事务"],
  ["schedule", "调度", "班期"],
  ["encrypt", "加密"],
  ["decrypt", "解密"],
  ["migrate", "迁移"],
  ["error", "exception", "错误", "异常"],
];

const SYNONYM_MAP = new Map<string, string[]>(
  SYNONYM_GROUPS.flatMap((group) => group.map((term) => [term, group.filter((candidate) => candidate !== term)] as const)),
);

function normalizeToken(token: string): string {
  return token.normalize("NFKC").trim().toLowerCase();
}

function isMeaningfulToken(token: string): boolean {
  if (token.length === 0 || STOP_WORDS.has(token)) {
    return false;
  }

  const codePointLength = [...token].length;
  if (NON_ASCII_PATTERN.test(token)) {
    return codePointLength >= 1;
  }

  return codePointLength >= 2;
}

function splitSegment(rawSegment: string): string[] {
  const normalized = rawSegment
    .normalize("NFKC")
    .replace(CAMEL_BOUNDARY_PATTERN, "$1 $2")
    .replace(ACRONYM_BOUNDARY_PATTERN, "$1 $2")
    .replace(/[_./\\#:-]+/g, " ");

  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .map(normalizeToken)
    .filter(isMeaningfulToken);
}

function buildAdjacentAsciiPairs(parts: string[]): string[] {
  const pairs: string[] = [];
  for (let index = 0; index < parts.length - 1; index += 1) {
    const left = parts[index];
    const right = parts[index + 1];
    if (!left || !right || NON_ASCII_PATTERN.test(left) || NON_ASCII_PATTERN.test(right)) {
      continue;
    }

    const combined = `${left}${right}`;
    if (isMeaningfulToken(combined)) {
      pairs.push(combined);
    }
  }

  return pairs;
}

function buildCjkBigrams(token: string): string[] {
  if (!CJK_PATTERN.test(token) || [...token].length < 2) {
    return [];
  }

  const chars = [...token];
  const bigrams: string[] = [];
  for (let index = 0; index < chars.length - 1; index += 1) {
    const value = `${chars[index]}${chars[index + 1]}`;
    if (isMeaningfulToken(value)) {
      bigrams.push(value);
    }
  }

  return bigrams;
}

function expandSynonyms(tokens: string[]): string[] {
  const expanded = new Set(tokens);
  for (const token of tokens) {
    for (const synonym of SYNONYM_MAP.get(token) ?? []) {
      for (const part of splitSegment(synonym)) {
        expanded.add(part);
      }
    }
  }

  return [...expanded];
}

export function buildSemanticTerms(text: string): string[] {
  const rawSegments = text
    .normalize("NFKC")
    .split(/[\s"'`()[\]{}<>|=+*&!?;,]+/u)
    .map((segment) => segment.trim())
    .filter(Boolean);

  const collected = new Set<string>();
  for (const segment of rawSegments) {
    const parts = splitSegment(segment);
    for (const token of parts) {
      collected.add(token);
      for (const bigram of buildCjkBigrams(token)) {
        collected.add(bigram);
      }
    }

    for (const pair of buildAdjacentAsciiPairs(parts)) {
      collected.add(pair);
    }
  }

  return expandSynonyms([...collected]).filter(isMeaningfulToken);
}

export function buildSemanticText(relativePath: string, content: string, symbolNames: string[], symbols?: SymbolInfo[]): string {
  const baseTerms = [...new Set(buildSemanticTerms([relativePath, ...symbolNames, content].join("\n")))];

  // v4.4.0: Inject Chinese semantic labels from symbol metadata
  if (symbols && symbols.length > 0) {
    const chineseLabels = generateSymbolLabels(symbols);
    for (const label of chineseLabels) {
      baseTerms.push(label);
    }
  }

  return [...new Set(baseTerms)].join(" ");
}

export function buildSemanticFtsQuery(terms: string[]): string | null {
  const filtered = [...new Set(terms.flatMap(splitSegment).filter(isMeaningfulToken))].slice(0, 8);
  return filtered.length > 0 ? filtered.map((term) => `${term}*`).join(" OR ") : null;
}
