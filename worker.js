// ============================================================
// worker.js (Cloudflare Worker)
// 财搭子 MCP 行情服务代理   (兼容原 QMT Flask API 格式)
// 使用官方 REST API：POST {base}/api/tools/call
// ============================================================
export default {
  async fetch(request, env, ctx) {
    // 1. 处理跨域 OPTIONS 请求
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": request.headers.get("Origin") || "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    // 2. 路由匹配
    if (path === "/querylocal" || path === "/api/querylocal") {
      try {
        if (request.method === "GET") {
          return await handleSingleQuery(request, env, ctx);
        } else if (request.method === "POST") {
          return await handleBatchQuery(request, env, ctx);
        } else {
          return errorResponse("Method Not Allowed", 405);
        }
      } catch (err) {
        console.error("Worker Error:", err);
        return errorResponse(err.message, 500);
      }
    }
    return errorResponse("Not found", 404);
  },
};

// ============================================================
// 请求处理：单股票 GET
// ============================================================
async function handleSingleQuery(request, env, ctx) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const type = url.searchParams.get("type");
  const date = url.searchParams.get("date");
  if (!code || !type) return errorResponse("Missing code or type", 400);
  const { qmtCode, currency } = convertCode(code);
  if (!qmtCode) return errorResponse(`Unsupported code format: ${code}`, 400);
  if (type !== "price" && type !== "intraday") {
    return errorResponse(`${type} not supported in local MCP service`, 501);
  }
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;
  let resultData;
  if (type === "price") {
    const results = await fetchPriceBatch([{ orig: code, qmt: qmtCode, currency }], env);
    resultData = results[code];
    if (!resultData) return errorResponse(`Price data not found for ${code}`, 404);
  } else {
    const tradeDate = date || getLastTradeDate();
    const results = await fetchIntradayBatch([{ orig: code, qmt: qmtCode, currency }], tradeDate, env);
    resultData = results[code];
    if (!resultData) return errorResponse(`Intraday data not found for ${code}`, 404);
  }
  const response = jsonResponse(resultData);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// 请求处理：批量 POST
// ============================================================
async function handleBatchQuery(request, env, ctx) {
  const body = await request.json().catch(() => null);
  if (!body) return errorResponse("Missing JSON body", 400);
  const { codes, type, date } = body;
  if (!codes || !type || !Array.isArray(codes)) return errorResponse("Missing codes array or type", 400);
  if (codes.length > 50) return errorResponse("Too many codes, max 50", 400);
  if (type !== "price" && type !== "intraday") return errorResponse("Batch only supports 'price' or 'intraday'", 400);
  const codesInfo = [];
  for (const code of codes) {
    const { qmtCode, currency } = convertCode(String(code));
    if (qmtCode) codesInfo.push({ orig: String(code), qmt: qmtCode, currency });
  }
  if (codesInfo.length === 0) return errorResponse("No valid codes", 400);
  // 为 POST 请求构造虚拟 GET Cache Key (Cloudflare Cache API 只能 match GET 请求)
  const sortedCodes = [...new Set(codesInfo.map((c) => c.orig))].sort().join(",");
  const fakeCacheUrl = new URL(request.url);
  fakeCacheUrl.searchParams.set("codes", sortedCodes);
  fakeCacheUrl.searchParams.set("type", type);
  if (date) fakeCacheUrl.searchParams.set("date", date);
  const cacheKey = new Request(fakeCacheUrl.toString(), { method: "GET" });
  const cache = caches.default;
  const cachedResponse = await cache.match(cacheKey);
  if (cachedResponse) return cachedResponse;
  let results = {};
  if (type === "price") {
    results = await fetchPriceBatch(codesInfo, env);
  } else {
    results = await fetchIntradayBatch(codesInfo, date, env);
  }
  // 决定缓存 TTL (秒)
  let ttl = 5;
  if (type === "price") {
    ttl = 5; // 实时价格 5 秒
  } else if (type === "intraday") {
    const today = getBeijingToday();
    const tradeDate = date || today;
    if (tradeDate < today) {
      ttl = 86400; // 历史数据缓存 1 天
    } else {
      ttl = 30; // 当日数据缓存 30 秒
    }
  }
  const response = jsonResponse(results, 200, ttl);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// ============================================================
// 数据获取层：MCP / REST 封装
// ============================================================
async function fetchPriceBatch(codesInfo, env) {
  // 尽量保持原来的符号列表构建方式
  const symbols = deduplicateSymbols(codesInfo.map((c) => c.orig));
  if (!symbols.length) return {};

  // ★ 关键点1：换成 get_real_time_record
  // 注意：实际参数名以 MCP tools/list 返回的 schema 为准
  // 常见可能是 symbols / codes / symbol_list 等，这里先按最接近原写法的 symbols 传
  const mcpResult = await callMcpTool(
    "get_real_time_record",
    {
      symbols,          // 如果官方 schema 是 codes，就改成 codes: symbols
      // 如果支持批量，直接传数组；如果只支持单个，就需要循环调用
    },
    env,
  );

  // ★ 替换点2：解析 get_real_time_record 的返回结构
  // 不同版本可能返回 data.items / data.records / result 直接是数组，需要兼容
  const items =
    mcpResult?.data?.items ||
    mcpResult?.data?.records ||
    mcpResult?.items ||
    mcpResult?.records ||
    (Array.isArray(mcpResult) ? mcpResult : []) ||
    [];

  const results = {};
  const symbolMap = {};
  for (const c of codesInfo) {
    const norm = normalizeAShareCode(c.orig);
    if (norm && !symbolMap[norm]) symbolMap[norm] = c;
  }

  for (const item of items) {
    // 兼容多种字段命名
    const symbol =
      item.symbol ||
      item.code ||
      item.stock_code ||
      item.ticker ||
      item.sec_code;

    const mapping = symbolMap[symbol] || symbolMap[normalizeAShareCode(symbol)];
    if (!mapping) continue;

    // 最新价（常见字段名）
    const latestPrice = parseFloat(
      item.price ??
      item.last ??
      item.last_price ??
      item.close ??
      item.latestPrice ??
      item.latest_price
    );

    // 昨收
    const prevClose = parseFloat(
      item.prev_close ??
      item.pre_close ??
      item.yesterday_close ??
      item.last_close ??
      item.prevClose
    );

    if (isNaN(latestPrice)) continue;

    // 涨跌额 / 涨跌幅（优先用接口直接返回的，没有再自己算）
    let changeAmount = parseFloat(
      item.change ??
      item.change_amount ??
      item.changeAmount ??
      item.ud
    );
    let changePercent = parseFloat(
      item.pct_chg ??
      item.change_percent ??
      item.changePercent ??
      item.percent ??
      item.pc
    );

    if (isNaN(changeAmount) && !isNaN(prevClose)) {
      changeAmount = latestPrice - prevClose;
    }
    if (isNaN(changePercent) && !isNaN(prevClose) && prevClose !== 0) {
      changePercent = parseFloat(((changeAmount / prevClose) * 100).toFixed(6));
    }
    if (isNaN(changeAmount)) changeAmount = 0;
    if (isNaN(changePercent)) changePercent = 0;

    // ★ 保持原来对外返回结构完全一致
    results[mapping.orig] = {
      name: item.name || item.stock_name || mapping.orig,
      latestPrice: latestPrice,
      changePercent: changePercent,
      changeAmount: changeAmount,
      source: "caidazi_mcp_cf",
      currency: mapping.currency,
      dailydata: null,
    };
  }

  return results;
}

async function fetchIntradayBatch(codesInfo, endDate, env) {
  const symbols = deduplicateSymbols(codesInfo.map((c) => c.orig));
  if (!symbols.length) return {};
  const args = { symbols, trading_days: 2 };
  if (endDate) args.end_date = String(endDate).replace(/-/g, "");
  const mcpResult = await callMcpTool("get_a_share_history_1m_price", args, env);
  const items = mcpResult?.data?.items || [];
  const results = {};
  const symbolMap = {};
  for (const c of codesInfo) {
    const norm = normalizeAShareCode(c.orig);
    if (norm && !symbolMap[norm]) symbolMap[norm] = c.orig;
  }
  for (const item of items) {
    const origCode = symbolMap[item.symbol];
    if (!origCode) continue;
    const legacyData = convertHistoryItemToLegacy(item, endDate);
    if (legacyData) results[origCode] = legacyData;
  }
  return results;
}

// ============================================================
// 数据转换逻辑 (高度兼容原代码)
// ============================================================
function convertHistoryItemToLegacy(item, preferredTradeDate) {
  const days = item.days || [];
  if (!days.length) return null;
  let selectedDay = null;
  if (preferredTradeDate) {
    const target = String(preferredTradeDate).replace(/-/g, "");
    selectedDay = days.find((d) => String(d.trade_date).replace(/-/g, "") === target);
  }
  if (!selectedDay) selectedDay = days[days.length - 1];
  let bars = selectedDay.bars || [];
  if (!bars.length) return null;
  bars = bars.sort((a, b) => String(a.bar_time).localeCompare(String(b.bar_time)));
  let prevClose = bars[0].prev_close !== undefined ? parseFloat(bars[0].prev_close) : null;
  const result = [];
  let cumulativeAmount = 0.0;
  let cumulativeVolumeShares = 0.0;
  let isFirst = true;

  const dateFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const timeFmt = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  for (const bar of bars) {
    const barTime = String(bar.bar_time).replace("Z", "+00:00");
    let dateStr, timeStr;
    try {
      const dt = new Date(barTime);
      dateStr = dateFmt.format(dt); // YYYY-MM-DD（上海）
      timeStr = timeFmt.format(dt); // HH:MM:SS（上海）
    } catch (e) {
      dateStr = barTime.substring(0, 10);
      timeStr = barTime.substring(11, 19);
    }
    const close = parseFloat(bar.close);
    if (isNaN(close)) continue;
    const price = isFirst && prevClose !== null ? prevClose : close;
    const volumeShares = parseFloat(bar.volume || 0);
    const volumeHands = volumeShares / 100;
    const amount = parseFloat(bar.amount || 0);
    cumulativeAmount += amount;
    cumulativeVolumeShares += volumeShares;
    const avgPrice =
      cumulativeVolumeShares > 0
        ? parseFloat((cumulativeAmount / cumulativeVolumeShares).toFixed(6))
        : price;
    result.push({
      date: dateStr,
      time: timeStr,
      price: price,
      avg_price: avgPrice,
      volume: volumeHands,
    });
    isFirst = false;
  }
  return result.length ? result : null;
}

// ============================================================
// 财搭子 REST API 客户端（与官方 @caidazi/mcp 一致）
// POST {baseUrl}/api/tools/call
// body: { tool_name, parameters }
// ============================================================
async function callMcpTool(toolName, args, env) {
  const baseUrl = (env.CAIDAZI_MCP_URL || env.CAIDAZI_BASE_URL || "https://mcp.zhicepilot.com").replace(
    /\/+$/,
    "",
  );
  const apiKey = env.CAIDAZI_API_KEY;
  if (!apiKey) {
    throw new Error("CAIDAZI_API_KEY is not configured in Cloudflare environment.");
  }

  const url = `${baseUrl}/api/tools/call`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      tool_name: toolName,
      parameters: args || {},
    }),
  });

  const text = await res.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }

  if (!res.ok) {
    const msg =
      (typeof body === "object" && (body.detail || body.error || body.message)) ||
      (typeof text === "string" ? text.slice(0, 200) : "") ||
      res.statusText;
    throw new Error(`MCP Server Error: ${res.status} ${msg}`);
  }

  if (body && body.success === false) {
    throw new Error(body.error || `Tool ${toolName} failed`);
  }

  // 官方客户端优先使用 body.result
  if (body && Object.prototype.hasOwnProperty.call(body, "result")) {
    return body.result;
  }
  return body;
}

// ============================================================
// 辅助方法
// ============================================================
function convertCode(code) {
  if (!code) return { qmtCode: null, currency: null };
  const text = String(code).trim().toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(text)) return { qmtCode: text, currency: "CNY" };
  if (/^\d{5}\.HK$/.test(text)) return { qmtCode: text, currency: "HKD" };
  if (text.startsWith("HK")) {
    const pure = text.substring(2);
    if (/^\d+$/.test(pure)) return { qmtCode: `${pure}.HK`, currency: "HKD" };
  }
  if (/^(60|68|90)/.test(text)) return { qmtCode: `${text}.SH`, currency: "CNY" };
  if (/^(00|30)/.test(text)) return { qmtCode: `${text}.SZ`, currency: "CNY" };
  if (/^92/.test(text)) return { qmtCode: `${text}.BJ`, currency: "CNY" };
  return { qmtCode: null, currency: null };
}

function normalizeAShareCode(code) {
  const { qmtCode, currency } = convertCode(code);
  if (currency === "CNY" && /^\d{6}\.(SH|SZ|BJ)$/.test(qmtCode)) return qmtCode;
  return null;
}

function deduplicateSymbols(symbols) {
  const set = new Set();
  const res = [];
  for (const s of symbols) {
    const n = normalizeAShareCode(s);
    if (n && !set.has(n)) {
      set.add(n);
      res.push(n);
    }
  }
  return res;
}

/** 上海时区当前日期，格式 YYYYMMDD */
function getBeijingToday() {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // en-CA 得到 YYYY-MM-DD
  return fmt.format(new Date()).replace(/-/g, "");
}

/** 兼容旧调用：直接返回上海时区今天，由上游 API 处理最近交易日 */
function getLastTradeDate() {
  return getBeijingToday();
}



function jsonResponse(data, status = 200, ttl = 0) {
  const headers = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  };
  if (ttl > 0) headers["Cache-Control"] = `public, max-age=${ttl}`;
  return new Response(JSON.stringify(data), { status, headers });
}

function errorResponse(detail, status = 400) {
  return jsonResponse({ detail }, status);
}
