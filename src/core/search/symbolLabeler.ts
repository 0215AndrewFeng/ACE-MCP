/**
 * v4.4.0: Symbol-level semantic labeler.
 * Generates Chinese labels from English symbol names (class, method, etc.)
 * so that chunk_semantic_fts can be searched with Chinese terms without LLM calls.
 *
 * Strategy:
 * 1. Split camelCase/PascalCase into words
 * 2. Translate each word via a local code-domain dictionary
 * 3. Combine translated words into Chinese phrases
 */

import type { SymbolInfo } from "../common/types.js";

// ── Code-domain English → Chinese dictionary ──
// Covers common patterns in Java/.NET/Python/JS naming conventions.
// Each English key maps to one or more Chinese equivalents.
const CODE_DICT = new Map<string, string[]>([
  // ── Business domain ──
  ["order", ["订单"]],
  ["ticket", ["票", "出票"]],
  ["flight", ["航班", "机票"]],
  ["endorse", ["改签"]],
  ["refund", ["退票", "退款"]],
  ["payment", ["支付", "付款"]],
  ["pay", ["支付"]],
  ["charge", ["收费", "扣费"]],
  ["billing", ["账单"]],
  ["invoice", ["发票"]],
  ["itinerary", ["行程"]],
  ["passenger", ["旅客", "乘客"]],
  ["booking", ["预订"]],
  ["reserve", ["预留"]],
  ["cancel", ["取消"]],
  ["void", ["作废"]],
  ["voided", ["已作废"]],
  ["print", ["打印"]],
  ["monitor", ["监控"]],
  ["trade", ["交易"]],
  ["price", ["价格"]],
  ["fee", ["费用"]],
  ["coupon", ["优惠券"]],
  ["discount", ["折扣"]],
  ["insurance", ["保险"]],
  ["ancillary", ["附加", "辅营"]],
  ["cabin", ["舱位"]],
  ["segment", ["航段"]],
  ["route", ["航线", "路由"]],
  ["schedule", ["班期", "计划"]],
  ["departure", ["出发"]],
  ["arrival", ["到达"]],
  ["airport", ["机场"]],
  ["carrier", ["承运人"]],
  ["supplier", ["供应商"]],
  ["channel", ["渠道"]],
  ["merchant", ["商户"]],
  ["customer", ["客户"]],
  ["member", ["会员"]],
  ["account", ["账户"]],
  ["user", ["用户"]],
  ["admin", ["管理"]],
  ["agent", ["代理"]],
  ["stock", ["库存"]],
  ["inventory", ["库存"]],

  // ── CRUD / Actions ──
  ["create", ["创建"]],
  ["add", ["添加"]],
  ["insert", ["插入"]],
  ["save", ["保存"]],
  ["update", ["更新", "修改"]],
  ["modify", ["修改"]],
  ["edit", ["编辑"]],
  ["patch", ["补丁"]],
  ["delete", ["删除"]],
  ["remove", ["移除"]],
  ["query", ["查询"]],
  ["search", ["搜索"]],
  ["find", ["查找"]],
  ["get", ["获取"]],
  ["set", ["设置"]],
  ["list", ["列表"]],
  ["fetch", ["拉取"]],
  ["load", ["加载"]],
  ["send", ["发送"]],
  ["push", ["推送"]],
  ["pull", ["拉取"]],
  ["submit", ["提交"]],
  ["commit", ["提交"]],
  ["rollback", ["回滚"]],
  ["revert", ["回退"]],
  ["sync", ["同步"]],
  ["async", ["异步"]],
  ["batch", ["批量"]],
  ["import", ["导入"]],
  ["export", ["导出"]],
  ["upload", ["上传"]],
  ["download", ["下载"]],
  ["parse", ["解析"]],
  ["format", ["格式化"]],
  ["convert", ["转换"]],
  ["transform", ["转换"]],
  ["validate", ["校验", "验证"]],
  ["verify", ["验证"]],
  ["check", ["检查"]],
  ["audit", ["审核"]],
  ["approve", ["审批"]],
  ["reject", ["驳回"]],
  ["retry", ["重试"]],
  ["notify", ["通知"]],
  ["alert", ["告警"]],
  ["log", ["日志"]],
  ["record", ["记录"]],
  ["track", ["追踪"]],
  ["count", ["计数"]],
  ["calculate", ["计算"]],
  ["compute", ["计算"]],
  ["aggregate", ["聚合"]],
  ["merge", ["合并"]],
  ["split", ["拆分"]],
  ["filter", ["过滤"]],
  ["sort", ["排序"]],
  ["group", ["分组"]],
  ["encrypt", ["加密"]],
  ["decrypt", ["解密"]],
  ["sign", ["签名"]],
  ["lock", ["锁"]],
  ["unlock", ["解锁"]],
  ["init", ["初始化"]],
  ["initialize", ["初始化"]],
  ["start", ["启动"]],
  ["stop", ["停止"]],
  ["shutdown", ["关闭"]],
  ["close", ["关闭"]],
  ["open", ["打开"]],
  ["connect", ["连接"]],
  ["disconnect", ["断开"]],
  ["register", ["注册"]],
  ["login", ["登录"]],
  ["logout", ["登出"]],
  ["auth", ["认证"]],
  ["authenticate", ["认证"]],
  ["authorize", ["授权"]],
  ["process", ["处理"]],
  ["execute", ["执行"]],
  ["run", ["运行"]],
  ["invoke", ["调用"]],
  ["call", ["调用"]],
  ["dispatch", ["分发"]],
  ["emit", ["发射"]],
  ["trigger", ["触发"]],
  ["handle", ["处理"]],
  ["resolve", ["解析", "处理"]],
  ["consume", ["消费"]],
  ["produce", ["生产"]],
  ["publish", ["发布"]],
  ["subscribe", ["订阅"]],
  ["listen", ["监听"]],
  ["watch", ["监听"]],
  ["observe", ["观察"]],
  ["schedule", ["调度"]],
  ["delay", ["延迟"]],
  ["timeout", ["超时"]],
  ["expire", ["过期"]],
  ["refresh", ["刷新"]],
  ["cache", ["缓存"]],
  ["clear", ["清除"]],
  ["clean", ["清理"]],
  ["reset", ["重置"]],
  ["recover", ["恢复"]],
  ["restore", ["恢复"]],
  ["backup", ["备份"]],
  ["migrate", ["迁移"]],
  ["upgrade", ["升级"]],
  ["write", ["写入", "回写"]],
  ["read", ["读取"]],

  // ── Architecture patterns ──
  ["service", ["服务"]],
  ["impl", ["实现"]],
  ["controller", ["控制器"]],
  ["handler", ["处理器"]],
  ["manager", ["管理器"]],
  ["factory", ["工厂"]],
  ["builder", ["构建器"]],
  ["adapter", ["适配器"]],
  ["proxy", ["代理"]],
  ["wrapper", ["包装器"]],
  ["decorator", ["装饰器"]],
  ["interceptor", ["拦截器"]],
  ["filter", ["过滤器"]],
  ["listener", ["监听器"]],
  ["observer", ["观察者"]],
  ["strategy", ["策略"]],
  ["template", ["模板"]],
  ["visitor", ["访问者"]],
  ["command", ["命令"]],
  ["chain", ["链"]],
  ["pipeline", ["管线"]],
  ["processor", ["处理器"]],
  ["converter", ["转换器"]],
  ["mapper", ["映射器"]],
  ["transformer", ["转换器"]],
  ["validator", ["校验器"]],
  ["checker", ["检查器"]],
  ["parser", ["解析器"]],
  ["serializer", ["序列化器"]],
  ["deserializer", ["反序列化器"]],
  ["encoder", ["编码器"]],
  ["decoder", ["解码器"]],
  ["provider", ["提供者"]],
  ["consumer", ["消费者"]],
  ["producer", ["生产者"]],
  ["publisher", ["发布者"]],
  ["subscriber", ["订阅者"]],
  ["repository", ["仓库"]],
  ["repo", ["仓库"]],
  ["dao", ["数据访问"]],
  ["gateway", ["网关"]],
  ["client", ["客户端"]],
  ["server", ["服务端"]],
  ["api", ["接口"]],
  ["endpoint", ["端点"]],
  ["middleware", ["中间件"]],
  ["plugin", ["插件"]],
  ["module", ["模块"]],
  ["component", ["组件"]],
  ["entity", ["实体"]],
  ["model", ["模型"]],
  ["dto", ["传输对象"]],
  ["vo", ["视图对象"]],
  ["bo", ["业务对象"]],
  ["do", ["数据对象"]],
  ["po", ["持久对象"]],
  ["enum", ["枚举"]],
  ["const", ["常量"]],
  ["constants", ["常量"]],
  ["util", ["工具"]],
  ["utils", ["工具"]],
  ["helper", ["辅助"]],
  ["common", ["公共"]],
  ["base", ["基类"]],
  ["abstract", ["抽象"]],
  ["default", ["默认"]],
  ["config", ["配置"]],
  ["configuration", ["配置"]],
  ["setting", ["设置"]],
  ["settings", ["设置"]],
  ["property", ["属性"]],
  ["properties", ["属性"]],
  ["param", ["参数"]],
  ["parameter", ["参数"]],
  ["request", ["请求"]],
  ["response", ["响应"]],
  ["result", ["结果"]],
  ["context", ["上下文"]],
  ["session", ["会话"]],
  ["token", ["令牌"]],
  ["key", ["键"]],
  ["value", ["值"]],
  ["type", ["类型"]],
  ["status", ["状态"]],
  ["state", ["状态"]],
  ["error", ["错误"]],
  ["exception", ["异常"]],
  ["message", ["消息"]],
  ["event", ["事件"]],
  ["notification", ["通知"]],
  ["callback", ["回调"]],
  ["promise", ["承诺"]],
  ["task", ["任务"]],
  ["job", ["作业"]],
  ["worker", ["工作者"]],
  ["thread", ["线程"]],
  ["pool", ["池"]],
  ["queue", ["队列"]],
  ["stack", ["栈"]],
  ["buffer", ["缓冲"]],
  ["stream", ["流"]],
  ["index", ["索引"]],
  ["table", ["表"]],
  ["column", ["列"]],
  ["field", ["字段"]],
  ["schema", ["模式"]],
  ["database", ["数据库"]],
  ["db", ["数据库"]],
  ["sql", ["查询语句"]],
  ["transaction", ["事务"]],
  ["connection", ["连接"]],
  ["test", ["测试"]],
  ["spec", ["规格"]],
  ["mock", ["模拟"]],
  ["stub", ["桩"]],
  ["fixture", ["测试数据"]],
  ["assert", ["断言"]],

  // ── Status / State ──
  ["pending", ["待处理"]],
  ["active", ["活跃"]],
  ["inactive", ["未激活"]],
  ["enabled", ["启用"]],
  ["disabled", ["禁用"]],
  ["success", ["成功"]],
  ["fail", ["失败"]],
  ["failed", ["失败"]],
  ["complete", ["完成"]],
  ["completed", ["已完成"]],
  ["finished", ["已完成"]],
  ["cancelled", ["已取消"]],
  ["expired", ["已过期"]],
  ["used", ["已使用"]],
  ["unused", ["未使用"]],
  ["valid", ["有效"]],
  ["invalid", ["无效"]],
  ["new", ["新建"]],
  ["old", ["旧"]],
  ["current", ["当前"]],
  ["previous", ["上一个"]],
  ["next", ["下一个"]],
  ["first", ["第一"]],
  ["last", ["最后"]],
  ["all", ["全部"]],
  ["single", ["单个"]],
  ["multi", ["多个"]],
  ["max", ["最大"]],
  ["min", ["最小"]],
  ["total", ["总计"]],
  ["detail", ["详情"]],
  ["summary", ["摘要"]],
  ["info", ["信息"]],
  ["data", ["数据"]],
  ["domestic", ["国内"]],
  ["international", ["国际"]],
  ["speed", ["极速", "加速"]],
  ["normal", ["普通"]],
  ["urgent", ["紧急"]],
  ["priority", ["优先"]],

  // ── MQ / Integration ──
  ["mq", ["消息队列"]],
  ["kafka", ["消息队列"]],
  ["rabbit", ["消息队列"]],
  ["redis", ["缓存"]],
  ["http", ["请求"]],
  ["rpc", ["远程调用"]],
  ["rest", ["接口"]],
  ["grpc", ["远程调用"]],
  ["webhook", ["回调"]],
  ["callback", ["回调"]],
  ["payload", ["载荷"]],
  ["header", ["头信息"]],
  ["body", ["请求体"]],
]);

const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;

/**
 * Split a PascalCase/camelCase identifier into words.
 * "OrderUsedPendingHandleServiceImpl" → ["Order", "Used", "Pending", "Handle", "Service", "Impl"]
 */
function splitIdentifier(name: string): string[] {
  return name
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Translate a single English word to Chinese using the dictionary.
 * Returns the Chinese translations or empty array if not found.
 */
function translateWord(word: string): string[] {
  return CODE_DICT.get(word.toLowerCase()) ?? [];
}

/**
 * Generate Chinese semantic labels for a symbol name.
 * Returns both individual word translations and a combined phrase.
 */
function labelSymbolName(name: string): string[] {
  const words = splitIdentifier(name);
  if (words.length === 0) return [];

  const labels: string[] = [];
  const phraseWords: string[] = [];

  for (const word of words) {
    const translations = translateWord(word);
    if (translations.length > 0) {
      // Add individual translations
      labels.push(...translations);
      // Use the first translation for the combined phrase
      phraseWords.push(translations[0]);
    }
  }

  // Add combined phrase if we translated multiple words
  if (phraseWords.length >= 2) {
    labels.push(phraseWords.join(""));
  }

  return labels;
}

/**
 * Generate Chinese semantic labels for all symbols in a chunk.
 * These labels are injected into chunk_semantic_fts.semantic_text at index time,
 * enabling FTS matching with Chinese search terms without LLM calls.
 *
 * @param symbols - SymbolInfo array for symbols within a chunk's line range
 * @returns Array of Chinese label strings (deduplicated)
 */
export function generateSymbolLabels(symbols: SymbolInfo[]): string[] {
  const labels = new Set<string>();

  for (const symbol of symbols) {
    // Label the symbol name itself
    for (const label of labelSymbolName(symbol.name)) {
      labels.add(label);
    }

    // Label the full qualified name (may contain additional context)
    if (symbol.fullName && symbol.fullName !== symbol.name) {
      // Extract the class part from "package.Class.method" → "Class"
      const parts = symbol.fullName.split(".");
      for (const part of parts) {
        if (part.length > 2 && /^[A-Z]/.test(part)) {
          for (const label of labelSymbolName(part)) {
            labels.add(label);
          }
        }
      }
    }

    // Add kind-based labels
    const kindTranslation = translateWord(symbol.kind);
    for (const kt of kindTranslation) {
      labels.add(kt);
    }

    // Label the container (enclosing class/namespace)
    if (symbol.containerName) {
      for (const label of labelSymbolName(symbol.containerName)) {
        labels.add(label);
      }
    }
  }

  return [...labels];
}
