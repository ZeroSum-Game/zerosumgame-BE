const express = require("express");
const https = require("https");

// ================= CONSTANTS & CONFIG =================
const INITIAL_CASH = 3000000n;
const MUSK_BONUS = 1000000n;
const LEE_START_SAMSUNG_SHARES = 10;
const TRUMP_TOLL_BONUS_RATE = 0.10;
const PUTIN_WAR_BONUS = 10; // 전쟁 승률 10% 증가

// 전쟁 승률 관련 상수
const WAR_BASE_RATE = 30;
const WAR_RATIO_RATE = 40;
const WAR_BASE_MIN = 30;
const WAR_BASE_MAX = 70;
const WAR_FINAL_MIN = 25;
const WAR_FINAL_MAX = 80;

// 비용 및 비율 상수
const WORLD_CUP_COST = 800000n;
const LANDMARK_RATE_NUM = 2n;
const LANDMARK_RATE_DEN = 5n;
const TAKEOVER_RATE_NUM = 3n;
const TAKEOVER_RATE_DEN = 2n;
const SELL_RATE_NUM = 7n;
const SELL_RATE_DEN = 10n;

// 맵 데이터 (땅 가격 및 통행료)
const LAND_PRICE_BY_NODE = { 1: 535500n, 3: 665000n, 5: 756000n, 6: 735000n, 7: 700000n, 10: 770000n, 11: 630000n, 13: 567000n, 15: 598500n, 17: 661500n, 19: 1001000n, 21: 770000n, 22: 924000n, 23: 885000n, 26: 630000n, 27: 567000n, 29: 735000n, 31: 1078000n };
const LAND_STABILITY_BY_NODE = { 1: 0.9, 3: 1.0, 5: 0.9, 6: 1.0, 7: 1.0, 10: 1.0, 11: 0.9, 13: 0.9, 15: 0.9, 17: 0.9, 19: 1.1, 21: 1.0, 22: 1.1, 23: 1.1, 26: 0.9, 27: 0.9, 29: 1.0, 31: 1.1 };
const LAND_TOLL_BY_NODE = { 1: 85000n, 3: 95000n, 5: 120000n, 6: 105000n, 7: 100000n, 10: 110000n, 11: 100000n, 13: 90000n, 15: 95000n, 17: 105000n, 19: 130000n, 21: 110000n, 22: 120000n, 23: 115000n, 26: 100000n, 27: 90000n, 29: 105000n, 31: 140000n };

const STOCK_WAR_WEIGHT = { stock: 0.8, gold: 1.0, bitcoin: 0.6 };
const CHARACTER_LABEL = { MUSK: "MUSK", LEE: "LEE", TRUMP: "TRUMP", PUTIN: "PUTIN" };

const NODE_TYPE = {
  START: 0,
  WAR: 8,
  WORLDCUP: 16,
  SPACE: 24,
  TAX: 30,
};

const WAR_LINE_RANGES = [
  { name: "ASIA", start: 0, end: 7 },
  { name: "EUROPE", start: 8, end: 15 },
  { name: "AFRICA", start: 16, end: 23 },
  { name: "AMERICA", start: 24, end: 31 }
];
const NEUTRAL_NODES = new Set([0, 8, 16, 24, 30]);

function createGameLogic({ prisma, io, market }) {
  // 상태 관리 (메모리)
  const warState = { active: false, warLine: null, warNode: null, turnsLeft: 0, recoveryActive: false, recoveryLine: 1, recoveryNode: 1 };
  
  const roomTurnOrder = new Map();
  const currentTurnUserByRoom = new Map();
  const turnStateByRoom = new Map();
  const actionWindowByRoom = new Map();
  const landVisitCount = new Map(); 
  const landLastAction = new Map();

  // ================= HELPER FUNCTIONS =================
  function postJson({ hostname, path, headers, body }) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname,
          path,
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(body),
            ...headers,
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => {
            data += chunk;
          });
          res.on("end", () => {
            resolve({ status: res.statusCode || 0, data });
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  }

  function isMarketEvent(event) {
    const text = `${event?.type ?? ""} ${event?.title ?? ""} ${event?.message ?? ""}`.toLowerCase();
    return text.includes("market") || text.includes("시장") || text.includes("price");
  }

  function prioritizeNewsEvents(events) {
    const list = Array.isArray(events) ? events.slice() : [];
    const scoreEvent = (event) => {
      const text = `${event?.type ?? ""} ${event?.title ?? ""} ${event?.message ?? ""}`.toLowerCase();
      let score = 0;
      if (text.includes("war") || text.includes("전쟁")) score += 4;
      if (text.includes("worldcup") || text.includes("월드컵")) score += 3;
      if (text.includes("golden key") || text.includes("goldenkey") || text.includes("황금열쇠")) score += 3;
      if (text.includes("space") || text.includes("우주")) score += 3;
      if (text.includes("tax") || text.includes("세금")) score += 2;
      if (text.includes("land") || text.includes("부동산") || text.includes("매입") || text.includes("매각")) score += 2;
      if (text.includes("move") || text.includes("이동") || text.includes("도착")) score += 1;
      if (isMarketEvent(event)) score -= 1;
      return score;
    };
    return list.sort((a, b) => scoreEvent(b) - scoreEvent(a));
  }

  function buildFallbackNews({ round, events, locale }) {
    const safeRound = Number.isFinite(round) ? round : 0;
    const safeEvents = prioritizeNewsEvents(events);
    const safeLocale = typeof locale === "string" && locale ? locale : "en";
    const headlineEvent = safeEvents.find((event) => !isMarketEvent(event)) || safeEvents[0];
    const headline =
      headlineEvent?.title ||
      (safeLocale.startsWith("ko") ? `라운드 ${safeRound} 소식` : `Round ${safeRound} News`);
    const summaryEvents = safeEvents
      .slice(0, 3)
      .map((e) => {
        const title = String(e?.title ?? "").trim();
        const message = String(e?.message ?? "").trim();
        if (title && message) return `${title}: ${message}`;
        return title || message;
      })
      .filter(Boolean);
    const summary =
      summaryEvents.join(" ") ||
      (safeLocale.startsWith("ko") ? "현재 라운드의 주요 소식이 업데이트되었습니다." : "Key updates from the current round are available.");
    return { headline, summary };
  }

  async function generateNewsWithGemini({ round, events, locale }) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    const safeRound = Number.isFinite(round) ? round : 0;
    const safeLocale = typeof locale === "string" && locale ? locale : "ko";
    const safeEvents = prioritizeNewsEvents(events);
    console.log(`[News] Gemini request start: round=${safeRound}, locale=${safeLocale}, events=${safeEvents.length}`);
    const eventLines = safeEvents
      .slice(0, 10)
      .map((e, idx) => {
        const title = String(e?.title ?? "").slice(0, 120);
        const message = String(e?.message ?? "").slice(0, 240);
        const type = String(e?.type ?? "").slice(0, 40);
        return `${idx + 1}. [${type}] ${title} - ${message}`;
      })
      .join("\n");

    const prompt = [
      `You are a game newsroom editor.`,
      `Write a free-form headline and a 2-3 sentence summary in locale "${safeLocale}".`,
      `Never mention user names; refer to players by character names (e.g., TRUMP, LEE, MUSK, PUTIN).`,
      `Call out surging/crashing stocks, real estate, or continents when present in the events.`,
      `If events mention World Cup hosting or Golden Key draws, weave them into the headline or summary.`,
      `Pick the most distinctive event for the headline; avoid generic market headlines unless market updates are the only notable events.`,
      `Avoid rigid templates, colon-separated lists, or formulaic phrasing. Vary sentence starts.`,
      `Topic: round ${safeRound} in a competitive board/stock game.`,
      `Return JSON: {"headline":"...","summary":"..."}. No markdown.`,
      `Events:`,
      eventLines || "None.",
    ].join("\n");

    const body = JSON.stringify({
      systemInstruction: {
        role: "system",
        parts: [
          {
            text: "Return ONLY valid JSON with keys headline and summary. No preface text, no markdown, no code fences. Do not mention user names; refer to players by character names only. Highlight surging/crashing assets, real estate, or continents when present. Write a free-form headline and a 2-3 sentence summary without fixed templates. If events mention World Cup hosting or Golden Key draws, weave them into the headline or summary. Pick the most distinctive event for the headline; avoid generic market headlines unless market updates are the only notable events. Avoid rigid templates, colon-separated lists, or formulaic phrasing.",
          },
        ],
      },
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 512,
        responseMimeType: "application/json",
        responseSchema: {
          type: "object",
          properties: {
            headline: { type: "string" },
            summary: { type: "string" },
          },
          required: ["headline", "summary"],
        },
      },
    });

    const path = `/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await postJson({
      hostname: "generativelanguage.googleapis.com",
      path,
      body,
    });

    console.log(`[News] Gemini response status: ${response.status}`);
    console.log(`[News] Gemini response data: ${response.data.slice(0, 1000)}`);
    if (response.status < 200 || response.status >= 300) {
      throw new Error("Gemini request failed");
    }
    let payload;
    try {
      payload = JSON.parse(response.data);
    } catch {
      throw new Error("Invalid Gemini response");
    }
    const parts = payload?.candidates?.[0]?.content?.parts;
    console.log(`[News] Gemini parts: ${JSON.stringify(parts).slice(0, 1000)}`);
    const text = Array.isArray(parts)
      ? parts.map((p) => (p && typeof p.text === "string" ? p.text : "")).join("\n").trim()
      : "";
    if (!text) throw new Error("Empty Gemini response");
    const cleanJson = (raw) => {
      const cleaned = String(raw || "")
        .replace(/[“”]/g, '"')
        .replace(/[‘’]/g, "'")
        .replace(/,\s*([}\]])/g, "$1")
        .trim();
      return cleaned;
    };

    const extractJson = (raw) => {
      const trimmed = String(raw || "").trim();
      // 마크다운 코드 블록 추출 (greedy하게 매칭)
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (fenced && fenced[1]) {
        const inner = fenced[1].trim();
        // 코드 블록 내부에서 JSON 객체만 추출
        const jsonStart = inner.indexOf("{");
        const jsonEnd = inner.lastIndexOf("}");
        if (jsonStart >= 0 && jsonEnd > jsonStart) {
          return inner.slice(jsonStart, jsonEnd + 1);
        }
        return inner;
      }
      // 코드 블록이 없으면 직접 JSON 객체 추출
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
      return trimmed;
    };

    let parsed;
    // 먼저 JSON 추출 시도 (마크다운 코드 블록 처리)
    const extracted = extractJson(text);
    const cleaned = cleanJson(extracted);

    console.log(`[News] DEBUG raw text (${text.length} chars): ${JSON.stringify(text.slice(0, 500))}`);
    console.log(`[News] DEBUG extracted (${extracted.length} chars): ${JSON.stringify(extracted.slice(0, 500))}`);
    console.log(`[News] DEBUG cleaned (${cleaned.length} chars): ${JSON.stringify(cleaned.slice(0, 500))}`);

    try {
      parsed = JSON.parse(cleaned);
      console.log(`[News] DEBUG parsed from cleaned successfully`);
    } catch (e1) {
      console.log(`[News] DEBUG cleaned parse error: ${e1.message}`);
      try {
        // 순수 텍스트로 직접 파싱 시도
        parsed = JSON.parse(text);
        console.log(`[News] DEBUG parsed from raw text successfully`);
      } catch (e2) {
        console.log(`[News] DEBUG raw parse error: ${e2.message}`);
        const headlineMatch = text.match(/(?:headline|제목|헤드라인)\s*[:=]\s*"?([^"\n]+)"?/i);
        const summaryMatch = text.match(/(?:summary|요약|요지)\s*[:=]\s*"?([\s\S]+?)"?(?:\s*}|$)/i);
        if (headlineMatch && summaryMatch) {
          parsed = {
            headline: headlineMatch[1].trim(),
            summary: summaryMatch[1].trim(),
          };
        } else {
          console.warn("[News] Gemini JSON parse failed, using fallback response");
          parsed = buildFallbackNews({ round: safeRound, events: safeEvents, locale: safeLocale });
        }
      }
    }
    const headline = String(parsed?.headline ?? "").trim();
    const summary = String(parsed?.summary ?? "").trim();
    if (!headline || !summary) throw new Error("Incomplete Gemini response");
    console.log(`[News] Gemini response parsed: headline="${headline.slice(0, 80)}"`);
    return { headline, summary };
  }

  function getLandKey(playerId, nodeIdx) { return `${playerId}:${nodeIdx}`; }
  function getVisitCount(playerId, nodeIdx) { return landVisitCount.get(getLandKey(playerId, nodeIdx)) || 0; }
  function setVisitCount(playerId, nodeIdx, count) { landVisitCount.set(getLandKey(playerId, nodeIdx), count); }
  function incrementVisit(playerId, nodeIdx) { setVisitCount(playerId, nodeIdx, getVisitCount(playerId, nodeIdx) + 1); }
  function getLastAction(playerId, nodeIdx) { return landLastAction.get(getLandKey(playerId, nodeIdx)) || null; }
  function setLastAction(playerId, nodeIdx, action) { landLastAction.set(getLandKey(playerId, nodeIdx), action); }

  function getLineIndex(nodeIdx) { return WAR_LINE_RANGES.findIndex((range) => nodeIdx >= range.start && nodeIdx <= range.end); }
  function getAdjacentLines(lineIdx) { 
    const adjacent = []; 
    if (lineIdx > 0) adjacent.push(lineIdx - 1); 
    if (lineIdx < WAR_LINE_RANGES.length - 1) adjacent.push(lineIdx + 1); 
    return adjacent; 
  }
  
  function getWarLandMultiplier(nodeIdx, isOwned) {
    if (NEUTRAL_NODES.has(nodeIdx) || !isOwned) return 1;
    const lineIdx = getLineIndex(nodeIdx);
    if (warState.active) {
      if (nodeIdx === warState.warNode) return 0.5;
      if (lineIdx === warState.warLine) return 0.75;
      return 1.1;
    }
    if (warState.recoveryActive && lineIdx === warState.warLine) {
      return nodeIdx === warState.warNode ? warState.recoveryNode : warState.recoveryLine;
    }
    return 1;
  }

  function applyWarMultiplier(value, nodeIdx, isOwned) {
    const mult = getWarLandMultiplier(nodeIdx, isOwned);
    return BigInt(Math.round(Number(value) * mult));
  }

  function getWarPayload() {
    return {
      active: warState.active,
      warLine: warState.warLine,
      warNode: warState.warNode,
      turnsLeft: warState.turnsLeft,
      recoveryActive: warState.recoveryActive,
      recoveryLine: warState.recoveryLine,
      recoveryNode: warState.recoveryNode,
      adjacentLines: warState.warLine != null ? getAdjacentLines(warState.warLine) : []
    };
  }

  async function getLatestPlayersByUser(tx, roomId) {
    const players = await tx.player.findMany({ where: { roomId }, orderBy: { id: "desc" } });
    const byUser = new Map();
    for (const p of players) {
      if (!byUser.has(p.userId)) byUser.set(p.userId, p);
    }
    return Array.from(byUser.values());
  }

  async function getTurnPlayerId(tx, roomId) {
    const room = await tx.room.findUnique({ where: { id: roomId } });
    if (!room) return null;
    const players = await getLatestPlayersByUser(tx, roomId);
    if (players.length === 0) return null;

    const storedOrder = roomTurnOrder.get(roomId);
    if (Array.isArray(storedOrder) && storedOrder.length > 0) {
      const playerIdSet = new Set(players.map((p) => p.id));
      const filtered = storedOrder.filter((id) => playerIdSet.has(id));
      if (filtered.length > 0) {
        return filtered[room.turnPlayerIdx % filtered.length];
      }
    }

    const sorted = players.slice().sort((a, b) => a.id - b.id);
    return sorted[room.turnPlayerIdx % sorted.length].id;
  }

  function getLandBasePrice(nodeIdx) { return LAND_PRICE_BY_NODE[nodeIdx] || 0n; }
  function getLandBaseToll(nodeIdx, baseToll) { return LAND_TOLL_BY_NODE[nodeIdx] || baseToll || 0n; }
  
  function calcLandPriceFromToll(baseToll, nodeIdx) {
    const stability = LAND_STABILITY_BY_NODE[nodeIdx];
    const toll = getLandBaseToll(nodeIdx, baseToll);
    if (!stability || !toll) return getLandBasePrice(nodeIdx);
    return BigInt(Math.round(Number(toll) * 7 * stability));
  }

  function getEffectiveLandPrice(baseToll, nodeIdx, isOwned) {
    const basePrice = calcLandPriceFromToll(baseToll, nodeIdx);
    return applyWarMultiplier(basePrice, nodeIdx, isOwned);
  }

  function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

  async function computeTotals(tx, playerId) {
    const player = await tx.player.findUnique({ where: { id: playerId }, include: { assets: true, lands: true } });
    if (!player) throw new Error("Player not found");
    const marketData = await market.getOrCreateMarket(tx, player.roomId);
    const landTotal = player.lands.reduce((sum, land) => sum + land.purchasePrice, 0n);
    const assets = player.assets || { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 };
    const stockTotal = BigInt(assets.samsung) * marketData.priceSamsung + BigInt(assets.tesla) * marketData.priceTesla + BigInt(assets.lockheed) * marketData.priceLockheed + BigInt(assets.gold) * marketData.priceGold + BigInt(assets.bitcoin) * marketData.priceBtc;
    const totalAsset = player.cash + landTotal + stockTotal;
    return { player, assets, market: marketData, landTotal, stockTotal, totalAsset };
  }

  async function emitAssetUpdate(playerId) {
    if (!io) return;
    try {
      const payload = await prisma.$transaction(async (tx) => {
        const totals = await computeTotals(tx, playerId);
        await tx.player.update({ where: { id: playerId }, data: { totalAsset: totals.totalAsset } });
        return { roomId: totals.player.roomId, userId: totals.player.userId, cash: totals.player.cash, totalAsset: totals.totalAsset };
      });
      io.to(payload.roomId).emit("asset_update", payload);
    } catch (e) {}
  }

  function calcWarAssetValue(assets, marketData, cash) {
    const stockValue = BigInt(assets.samsung) * marketData.priceSamsung + BigInt(assets.tesla) * marketData.priceTesla + BigInt(assets.lockheed) * marketData.priceLockheed;
    const goldValue = BigInt(assets.gold) * marketData.priceGold;
    const coinValue = BigInt(assets.bitcoin) * marketData.priceBtc;
    const weightedStock = Number(stockValue) * STOCK_WAR_WEIGHT.stock;
    const weightedGold = Number(goldValue) * STOCK_WAR_WEIGHT.gold;
    const weightedCoin = Number(coinValue) * STOCK_WAR_WEIGHT.bitcoin;
    return Number(cash) + weightedStock + weightedGold + weightedCoin;
  }

  function calcWarWinRate({ myAsset, oppAsset, character }) {
    const ratio = myAsset + oppAsset === 0 ? 0.5 : myAsset / (myAsset + oppAsset);
    const baseRaw = WAR_BASE_RATE + (ratio * WAR_RATIO_RATE);
    const base = clamp(baseRaw, WAR_BASE_MIN, WAR_BASE_MAX);
    // [푸틴] 전쟁 승률 10% 보너스 적용
    const characterBonus = character === CHARACTER_LABEL.PUTIN ? PUTIN_WAR_BONUS : 0;
    return clamp(base + characterBonus, WAR_FINAL_MIN, WAR_FINAL_MAX);
  }

  function applyTrumpBonus(toll, ownerCharacter) {
    // [트럼프] 통행료 5% 증가
    if (ownerCharacter !== CHARACTER_LABEL.TRUMP) return toll;
    return BigInt(Math.round(Number(toll) * (1 + TRUMP_TOLL_BONUS_RATE)));
  }

  async function autoSellAssets(tx, player, amount, marketData) {
    if (player.cash >= amount) return { player, autoSales: [], covered: true };
    const assets = player.assets || await tx.playerAsset.create({ data: { playerId: player.id } });
    const sellOrder = [
      { key: "bitcoin", price: marketData.priceBtc },
      { key: "gold", price: marketData.priceGold },
      { key: "samsung", price: marketData.priceSamsung },
      { key: "tesla", price: marketData.priceTesla },
      { key: "lockheed", price: marketData.priceLockheed }
    ];
    let updatedPlayer = player;
    let updatedAssets = assets;
    const autoSales = [];
    for (const item of sellOrder) {
      if (updatedPlayer.cash >= amount) break;
      const owned = updatedAssets[item.key] || 0;
      if (owned <= 0) continue;
      const remaining = amount - updatedPlayer.cash;
      const price = item.price;
      const needed = (remaining + price - 1n) / price;
      const sellQty = Math.min(owned, Number(needed));
      if (sellQty <= 0) continue;
      const proceeds = price * BigInt(sellQty);
      updatedAssets = await tx.playerAsset.update({ where: { playerId: player.id }, data: { [item.key]: owned - sellQty } });
      updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: updatedPlayer.cash + proceeds } });
      autoSales.push({ symbol: item.key, quantity: sellQty, price, proceeds });
    }
    const covered = updatedPlayer.cash >= amount;
    if (!covered) {
      updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { isBankrupt: true } });
    }
    return { player: updatedPlayer, autoSales, covered };
  }

  // [국세청] 세금 징수 핸들러
  async function handleTaxNode(tx, player, marketData) {
    const totals = await computeTotals(tx, player.id);
    const taxAmount = totals.totalAsset / 5n; // 자산의 20%
    const sold = await autoSellAssets(tx, player, taxAmount, marketData);
    let updatedPlayer = sold.player;
    
    // 낼 돈이 없으면 가진 현금 전부 징수
    const payAmount = updatedPlayer.cash < taxAmount ? updatedPlayer.cash : taxAmount;
    if (payAmount > 0n) {
      updatedPlayer = await tx.player.update({
        where: { id: updatedPlayer.id },
        data: { cash: updatedPlayer.cash - payAmount }
      });
    }

    return {
      type: "TAX",
      amount: taxAmount,
      paid: payAmount,
      autoSales: sold.autoSales,
      isBankrupt: updatedPlayer.isBankrupt
    };
  }

  async function rollDiceForUser({ userId }) {
    return prisma.$transaction(async (tx) => {
      const player = await tx.player.findFirst({ where: { userId }, orderBy: { id: "desc" } });
      if (!player) throw new Error("Player not found");
      const room = await tx.room.findUnique({ where: { id: player.roomId } });
      if (!room || room.status !== "PLAYING") throw new Error("Game not started");
      
      const currentTurnId = await getTurnPlayerId(tx, player.roomId);
      if (currentTurnId !== player.id) throw new Error("Not your turn");

      // 우주여행 대기 상태 체크
      if (player.isResting) {
        throw new Error("SPACE_TRAVEL_PENDING");
      }

      // 턴 상태 체크
      const turnState = turnStateByRoom.get(player.roomId) || { userId: player.userId, rolled: false, extraRoll: false };
      if (turnState.userId !== player.userId) {
        turnState.userId = player.userId;
        turnState.rolled = false;
        turnState.extraRoll = false;
      }
      if (turnState.rolled && !turnState.extraRoll) throw new Error("Already rolled");

      // 주사위 굴리기
      const dice1 = Math.floor(Math.random() * 6) + 1;
      const dice2 = Math.floor(Math.random() * 6) + 1;
      const isDouble = dice1 === dice2;
      const oldLocation = player.location;
      const newLocation = (oldLocation + dice1 + dice2) % 32;
      const passedStart = newLocation < oldLocation;
      const salary = passedStart ? 200000n : 0n;
      const hasExtraTurn = isDouble && !player.extraTurnUsed;

      // 주식 시장 변동
      const currentMarket = await market.getOrCreateMarket(tx, player.roomId);
      const driftUpdates = {};
      Object.values(market.MARKET_SYMBOLS).forEach((cfg) => {
        const drift = (Math.random() * 0.1) - 0.05;
        driftUpdates[cfg.prevField] = currentMarket[cfg.priceField];
        driftUpdates[cfg.priceField] = market.applyMarketDelta(currentMarket[cfg.priceField], drift);
      });
      let marketData = await tx.market.update({ where: { roomId: player.roomId }, data: driftUpdates });

      // 플레이어 위치 이동
      let updatedPlayer = await tx.player.update({
        where: { id: player.id },
        data: { location: newLocation, cash: player.cash + salary, extraTurnUsed: hasExtraTurn ? true : false }
      });

      turnState.rolled = true;
      turnState.extraRoll = hasExtraTurn;
      turnStateByRoom.set(player.roomId, turnState);
      
      // Action Window 설정 (구매/전쟁 등 검증용)
      actionWindowByRoom.set(player.roomId, { userId: player.userId, location: newLocation });

      // 결과 변수 초기화
      let eventResult = null;
      let actionRequired = null; 
      let tollOwnerId = null;
      const autoSellEvents = [];
      
      // 1. 국세청 (TAX) -> 자동 실행
      if (newLocation === NODE_TYPE.TAX) {
        eventResult = await handleTaxNode(tx, updatedPlayer, marketData);
        updatedPlayer = await tx.player.findUnique({ where: { id: player.id } });
      }
      // 2. 우주여행 (SPACE) -> 상태 변경만 수행
      else if (newLocation === NODE_TYPE.SPACE) {
        await tx.player.update({ where: { id: player.id }, data: { isResting: true } });
        eventResult = { type: "SPACE", msg: "우주여행 도착! 다음 턴에 원하는 곳으로 이동합니다." };
      }
      // 3. 전쟁 (WAR) -> 선택 모달 요청
      else if (newLocation === NODE_TYPE.WAR) {
        if (!warState.active) {
          actionRequired = "WAR_CHOICE"; 
        }
      }
      // 4. 시작점 (START) -> 매수 모달 요청
      else if (newLocation === NODE_TYPE.START) {
        actionRequired = "BUY_ASSET";
      }
      // 5. 월드컵 (WORLDCUP) -> 개최 모달 요청
      else if (newLocation === NODE_TYPE.WORLDCUP) {
        const land = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: newLocation } });
        // 주인이 없거나 내가 주인이면 개최 가능
        if (!land || land.ownerId === player.id) {
            actionRequired = "WORLDCUP_HOST";
        }
      }

      // 6. 일반 땅 및 통행료 처리 (월드컵 포함)
      let tollPaid = null;
      let tollOwnerUserId = null;
      let landIsLandmark = false;
      const mapNode = await tx.mapNode.findUnique({ where: { nodeIdx: newLocation } });
      if (mapNode?.type === "LAND" || mapNode?.type === "EXPO") {
        const land = await tx.gameLand.findFirst({ where: { roomId: updatedPlayer.roomId, nodeIdx: newLocation } });

        // 내 땅 도착: 방문 횟수 증가
        if (land && land.ownerId === updatedPlayer.id) {
          incrementVisit(updatedPlayer.id, newLocation);
        }
        // 남의 땅 도착: 통행료 지불
        else if (land && land.ownerId && land.ownerId !== updatedPlayer.id) {
          const owner = await tx.player.findUnique({ where: { id: land.ownerId } });
          if (owner) {
            landIsLandmark = land.isLandmark;
            let toll = getLandBaseToll(newLocation, mapNode.baseToll);

            // 월드컵 개최지면 통행료 2배 (임시 로직)
            if (land.hasWorldCup) toll = toll * 2n;

            toll = applyTrumpBonus(toll, owner.character);
            toll = applyWarMultiplier(toll, newLocation, true);

            const sold = await autoSellAssets(tx, updatedPlayer, toll, marketData);
            updatedPlayer = sold.player;
            const payAmount = updatedPlayer.cash < toll ? updatedPlayer.cash : toll;

            updatedPlayer = await tx.player.update({ where: { id: updatedPlayer.id }, data: { cash: updatedPlayer.cash - payAmount } });
            const updatedOwner = await tx.player.update({ where: { id: owner.id }, data: { cash: owner.cash + payAmount } });

            tollOwnerId = owner.id;
            tollOwnerUserId = owner.userId;
            tollPaid = { amount: Number(payAmount), ownerId: owner.id, ownerUserId: owner.userId, ownerCash: Number(updatedOwner.cash), isLandmark: landIsLandmark };
            if (sold.autoSales.length) {
                autoSellEvents.push({ type: "TOLL", items: sold.autoSales, amount: toll, paid: payAmount, bankrupt: !sold.covered, ownerId: owner.id });
            }
          }
        }
      }

      // 턴 정보 갱신
      const turnPlayerId = await getTurnPlayerId(tx, updatedPlayer.roomId);
      const turnUserId = currentTurnUserByRoom.get(updatedPlayer.roomId) || player.userId;

      return {
        dice1, dice2, isDouble, hasExtraTurn, oldLocation, newLocation, passedStart,
        player: updatedPlayer,
        roomId: updatedPlayer.roomId,
        tollOwnerId,
        tollPaid,
        turnPlayerId,
        turnUserId,
        market: marketData,
        war: getWarPayload(),
        autoSellEvents,
        actionRequired,
        eventResult
      };
    });
  }

  function createGameRoutes({ requireAuth }) {
    const router = express.Router();

    router.post("/api/game/space-move", requireAuth, async (req, res) => {
      try {
        const targetNode = Number(req.body.nodeIdx);
        if (!Number.isInteger(targetNode) || targetNode < 0 || targetNode > 31) return res.status(400).json({ error: "Invalid node" });

        const KEY_NODES = [12, 20, 28]; // 황금열쇠 칸

        const result = await prisma.$transaction(async (tx) => {
            const player = await tx.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" } });
            if (!player) throw new Error("Player not found");
            if (!player.isResting) throw new Error("Not in space travel mode");

            const marketData = await market.getOrCreateMarket(tx, player.roomId);
            let eventResult = null;

            // 이동 처리 (우주여행 종료)
            let updated = await tx.player.update({
                where: { id: player.id },
                data: { location: targetNode, isResting: false }
            });

            // 국세청 도착 시 세금 징수
            if (targetNode === NODE_TYPE.TAX) {
              eventResult = await handleTaxNode(tx, updated, marketData);
              updated = await tx.player.findUnique({ where: { id: player.id } });
            }

            return { player: updated, userId: req.user.id, roomId: player.roomId, eventResult, isKeyNode: KEY_NODES.includes(targetNode) };
        });

        // 우주여행 도착 후 액션 윈도우 설정 (거래/구매 등 허용)
        actionWindowByRoom.set(result.roomId, { userId: result.userId, location: targetNode });

        await emitAssetUpdate(result.player.id);
        if(io) io.to(result.player.roomId).emit("playerMove", {
          playerId: result.player.id,
          userId: result.userId,
          newLocation: targetNode,
          type: "SPACE",
          eventResult: result.eventResult,
          isKeyNode: result.isKeyNode
        });
        return res.json(result);
      } catch (e) {
        return res.status(400).json({ error: e.message || "Space travel failed" });
      }
    });

    router.post("/api/game/buy-asset", requireAuth, async (req, res) => {
        try {
            const { type, quantity } = req.body; // type: 'samsung', 'tesla' ...
            const qty = Number(quantity);
            if (qty <= 0) return res.status(400).json({ error: "Invalid quantity" });

            const result = await prisma.$transaction(async (tx) => {
                const player = await tx.player.findFirst({ where: { userId: req.user.id } });
                const marketData = await market.getOrCreateMarket(tx, player.roomId);
                
                const mapping = Object.values(market.MARKET_SYMBOLS).find(cfg => cfg.key === type);
                if (!mapping) throw new Error("Invalid asset type");
                
                const price = marketData[mapping.priceField];
                const cost = price * BigInt(qty);

                if (player.cash < cost) throw new Error("Insufficient cash");

                const assets = await tx.playerAsset.upsert({
                    where: { playerId: player.id },
                    update: { [type]: { increment: qty } },
                    create: { playerId: player.id, [type]: qty }
                });
                
                const updatedPlayer = await tx.player.update({
                    where: { id: player.id },
                    data: { cash: player.cash - cost }
                });

                return { player: updatedPlayer, assets };
            });

            await emitAssetUpdate(result.player.id);
            return res.json({ ok: true });
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    router.post("/api/game/war/start", requireAuth, async (req, res) => {
        try {
            const result = await prisma.$transaction(async (tx) => {
                const player = await tx.player.findFirst({ where: { userId: req.user.id } });
                
                if (warState.active) throw new Error("War already active");
                if (player.location !== NODE_TYPE.WAR) throw new Error("Not at war node");

                const playerCount = await tx.player.count({ where: { roomId: player.roomId } });
                
                warState.active = true;
                warState.warLine = getLineIndex(player.location);
                warState.warNode = player.location;
                warState.turnsLeft = playerCount; 
                warState.recoveryActive = false;

                return { active: true };
            });
            
            if (io) io.to(1).emit("war_start", { starterId: req.user.id }); 
            return res.json(result);
        } catch (e) {
            return res.status(400).json({ error: e.message });
        }
    });

    router.get("/api/me", requireAuth, async (req, res) => {
      try {
        const result = await prisma.$transaction(async (tx) => {
          const player = await tx.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" } });
          if (!player) return { cash: 0, location: 0 };
          const totals = await computeTotals(tx, player.id);
          return { cash: totals.player.cash, location: totals.player.location, totalAsset: totals.totalAsset, character: totals.player.character, userId: totals.player.userId, playerId: totals.player.id };
        });
        return res.json(result);
      } catch (e) { return res.status(500).json({ error: "Failed to load user" }); }
    });

    router.post("/api/news", requireAuth, async (req, res) => {
      try {
        const round = Number(req.body?.round ?? 0);
        const events = Array.isArray(req.body?.events) ? req.body.events : [];
        const locale = typeof req.body?.locale === "string" ? req.body.locale : "ko";
        const result = await generateNewsWithGemini({ round, events, locale });
        return res.json(result);
      } catch (e) {
        console.error("[News] Gemini request failed:", e);
        const message = e?.message === "GEMINI_API_KEY missing" ? e.message : "News generation failed";
        return res.status(500).json({ error: message });
      }
    });

    router.get("/api/map", async (req, res) => {
      try {
        const mapData = await prisma.mapNode.findMany({ include: { gameLands: { where: { roomId: 1 } } }, orderBy: { nodeIdx: "asc" } });
        const normalized = mapData.map((node) => {
          if (node.type !== "LAND") return node;
          const basePrice = getLandBasePrice(node.nodeIdx);
          return { ...node, basePrice };
        });
        res.json(normalized);
      } catch (e) { res.status(500).json({ error: "Map load failed" }); }
    });

    router.get("/api/players/:id/assets", async (req, res) => {
      try {
        const userId = Number(req.params.id);
        if (!Number.isInteger(userId)) return res.status(400).json({ error: "Invalid user id" });
        const result = await prisma.$transaction(async (tx) => {
          const player = await tx.player.findFirst({ where: { userId }, orderBy: { id: "desc" } });
          if (!player) throw new Error("Player not found");
          const totals = await computeTotals(tx, player.id);
          return { cash: totals.player.cash, lands: totals.player.lands, assets: totals.assets, stockTotal: totals.stockTotal, landTotal: totals.landTotal, totalAsset: totals.totalAsset };
        });
        return res.json(result);
      } catch (e) {
        const message = e?.message === "Player not found" ? e.message : "Failed to load assets";
        return res.status(404).json({ error: message });
      }
    });

    router.post("/api/game/character", requireAuth, async (req, res) => {
      try {
        const character = String(req.body?.character || "").toUpperCase();
        if (!CHARACTER_LABEL[character]) return res.status(400).json({ error: "Invalid character" });
        const result = await prisma.$transaction(async (tx) => {
          const player = await tx.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" }, include: { assets: true, room: true } });
          if (!player) throw new Error("Player not found");
          if (player.room?.status !== "WAITING") throw new Error("Game already started");
          
          const others = await getLatestPlayersByUser(tx, player.roomId);
          const isActiveSocket = (sid) => !!sid && !!io && !!io.sockets && !!io.sockets.sockets && io.sockets.sockets.has(sid);
          const activeOthers = others.filter((p) => p.userId !== player.userId && isActiveSocket(p.socketId));
          if (activeOthers.some((p) => p.character === character)) throw new Error("Character already taken");
          
          let cash = INITIAL_CASH;
          let assets = player.assets || await tx.playerAsset.create({ data: { playerId: player.id } });
          assets = await tx.playerAsset.update({ where: { playerId: player.id }, data: { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 } });
          
          if (character === CHARACTER_LABEL.MUSK) cash += MUSK_BONUS;
          if (character === CHARACTER_LABEL.LEE) {
            assets = await tx.playerAsset.update({ where: { playerId: player.id }, data: { samsung: LEE_START_SAMSUNG_SHARES } });
          }
          const updated = await tx.player.update({ where: { id: player.id }, data: { character, cash, totalAsset: cash, location: 0, extraTurnUsed: false } });
          return { playerId: player.id, character: updated.character, cash: updated.cash, roomId: player.roomId, userId: player.userId };
        });
        await emitAssetUpdate(result.playerId);
        if (io) io.to(result.roomId).emit("character_update", { playerId: result.playerId, userId: result.userId, character: result.character });
        return res.json({ playerId: result.playerId, character: result.character, cash: result.cash });
      } catch (e) {
        const message = e?.message || "Failed to set character";
        return res.status(400).json({ error: message });
      }
    });

    router.post("/api/game/purchase", requireAuth, async (req, res) => {
      try {
        const action = String(req.body?.action || "BUY").toUpperCase();
        const player = await prisma.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" } });
        if (!player) return res.status(404).json({ error: "Player not found" });
        const targetNodeIdx = Number.isInteger(Number(req.body?.nodeIdx)) ? Number(req.body.nodeIdx) : player.location;
        const isRemote = targetNodeIdx !== player.location;
        if (isRemote && player.location !== 0) return res.status(400).json({ error: "Remote action not allowed" });
        const mapNode = await prisma.mapNode.findUnique({ where: { nodeIdx: targetNodeIdx } });
        if (!mapNode || mapNode.type !== "LAND") return res.status(400).json({ error: `Invalid tile type: ${mapNode?.type || "UNKNOWN"}` });
        
        const result = await prisma.$transaction(async (tx) => {
          const freshPlayer = await tx.player.findUnique({ where: { id: player.id } });
          if (!freshPlayer) throw new Error("Player not found");
          const currentTurn = currentTurnUserByRoom.get(player.roomId);
          if (currentTurn && currentTurn !== player.userId) throw new Error("Not your turn");
          const actionWindow = actionWindowByRoom.get(player.roomId);
          if (!actionWindow || actionWindow.userId !== player.userId || actionWindow.location !== player.location) throw new Error("Action window closed");
          
          const freshLand = await tx.gameLand.findFirst({ where: { roomId: player.roomId, nodeIdx: targetNodeIdx } });
          const visitCount = getVisitCount(player.id, targetNodeIdx);
          const lastAction = getLastAction(player.id, targetNodeIdx);
          const canUpgrade = visitCount > 0 && lastAction !== "BUY" && lastAction !== "TAKEOVER";
          
          if (action === "BUY") {
            if (isRemote) throw new Error("Remote action not allowed");
            if (freshLand && freshLand.ownerId != null) throw new Error("Land already owned");
            const landPrice = getEffectiveLandPrice(mapNode.baseToll, targetNodeIdx, false);
            if (freshPlayer.cash < landPrice) throw new Error("Insufficient cash");
            const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash - landPrice } });
            if (freshLand) {
              await tx.gameLand.update({ where: { id: freshLand.id }, data: { ownerId: player.id, isLandmark: false, purchasePrice: landPrice } });
            } else {
              await tx.gameLand.create({ data: { roomId: player.roomId, nodeIdx: targetNodeIdx, ownerId: player.id, purchasePrice: landPrice } });
            }
            setVisitCount(player.id, targetNodeIdx, 0);
            setLastAction(player.id, targetNodeIdx, "BUY");
            return { playerId: player.id, cash: updatedPlayer.cash, nodeIdx: targetNodeIdx, action };
          }
          if (action === "TAKEOVER") {
            if (isRemote) throw new Error("Remote action not allowed");
            if (!freshLand || !freshLand.ownerId || freshLand.ownerId === player.id) throw new Error("Invalid takeover");
            if (freshLand.isLandmark) throw new Error("Landmark protected");
            const landPrice = getEffectiveLandPrice(mapNode.baseToll, targetNodeIdx, true);
            const takeoverCost = landPrice * TAKEOVER_RATE_NUM / TAKEOVER_RATE_DEN;
            if (freshPlayer.cash < takeoverCost) throw new Error("Insufficient cash");
            const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash - takeoverCost } });
            await tx.gameLand.update({ where: { id: freshLand.id }, data: { ownerId: player.id, isLandmark: false, purchasePrice: takeoverCost } });
            setVisitCount(player.id, targetNodeIdx, 0);
            setLastAction(player.id, targetNodeIdx, "TAKEOVER");
            return { playerId: player.id, cash: updatedPlayer.cash, nodeIdx: targetNodeIdx, action, cost: takeoverCost };
          }
          if (action === "LANDMARK") {
            if (!freshLand || freshLand.ownerId !== player.id) throw new Error("Not your land");
            if (freshLand.isLandmark) throw new Error("Already landmark");
            if (!canUpgrade) throw new Error("Revisit required");
            const landPrice = getEffectiveLandPrice(mapNode.baseToll, targetNodeIdx, true);
            const buildCost = landPrice * LANDMARK_RATE_NUM / LANDMARK_RATE_DEN;
            if (freshPlayer.cash < buildCost) throw new Error("Insufficient cash");
            const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash - buildCost } });
            await tx.gameLand.update({ where: { id: freshLand.id }, data: { isLandmark: true, purchasePrice: freshLand.purchasePrice + buildCost } });
            setLastAction(player.id, targetNodeIdx, "LANDMARK");
            return { playerId: player.id, cash: updatedPlayer.cash, nodeIdx: targetNodeIdx, action, cost: buildCost };
          }
          if (action === "SELL") {
            if (!freshLand || freshLand.ownerId !== player.id) throw new Error("Not your land");
            const refund = freshLand.purchasePrice * SELL_RATE_NUM / SELL_RATE_DEN;
            const updatedPlayer = await tx.player.update({ where: { id: player.id }, data: { cash: freshPlayer.cash + refund } });
            await tx.gameLand.update({ where: { id: freshLand.id }, data: { ownerId: null, isLandmark: false, purchasePrice: 0 } });
            setLastAction(player.id, targetNodeIdx, "SELL");
            return { playerId: player.id, cash: updatedPlayer.cash, nodeIdx: targetNodeIdx, action, refund };
          }
          throw new Error("Invalid action");
        });
        await emitAssetUpdate(result.playerId);
        return res.json(result);
      } catch (e) {
        const message = e?.message || "Failed to purchase land";
        return res.status(400).json({ error: message });
      }
    });

    router.post("/api/game/worldcup", requireAuth, async (req, res) => {
      try {
        const targetNodeIdx = Number(req.body?.nodeIdx);
        if (!Number.isInteger(targetNodeIdx)) return res.status(400).json({ error: "Invalid node" });
        const result = await prisma.$transaction(async (tx) => {
          const host = await tx.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" } });
          if (!host) throw new Error("Player not found");
          if (host.location !== NODE_TYPE.WORLDCUP) throw new Error("Not on Worldcup spot");
          if (host.cash < WORLD_CUP_COST) throw new Error("Insufficient cash");
          
          const hostLand = await tx.gameLand.findFirst({ where: { roomId: host.roomId, nodeIdx: targetNodeIdx, ownerId: host.id } });
          if (!hostLand) throw new Error("Land not owned");
          
          const mapNode = await tx.mapNode.findUnique({ where: { nodeIdx: targetNodeIdx } });
          if (!mapNode || mapNode.type !== "LAND") throw new Error("Invalid land");
          
          // 월드컵 플래그 설정
          await tx.gameLand.update({ where: { id: hostLand.id }, data: { hasWorldCup: true } });
          
          const updatedHost = await tx.player.update({ where: { id: host.id }, data: { cash: host.cash - WORLD_CUP_COST } });
          const players = await tx.player.findMany({ where: { roomId: host.roomId } });
          
          // 개최 후 통행료 로직 (즉시 이동 및 지불)
          const tollBase = getLandBaseToll(targetNodeIdx, mapNode.baseToll);
          const hostToll = applyWarMultiplier(applyTrumpBonus(tollBase, updatedHost.character), targetNodeIdx, true);
          
          for (const p of players) {
            const movingData = { location: targetNodeIdx }; // 모두 강제 이동
            if (p.id !== updatedHost.id) {
              const cash = p.cash - hostToll;
              await tx.player.update({ where: { id: p.id }, data: { ...movingData, cash } });
              await tx.player.update({ where: { id: updatedHost.id }, data: { cash: updatedHost.cash + hostToll } });
              updatedHost.cash += hostToll;
            } else {
              await tx.player.update({ where: { id: p.id }, data: movingData });
            }
          }
          return { roomId: host.roomId, hostId: host.id, nodeIdx: targetNodeIdx };
        });
        const roomPlayers = await prisma.player.findMany({ where: { roomId: result.roomId }, select: { id: true } });
        for (const p of roomPlayers) { await emitAssetUpdate(p.id); }
        if (io) io.to(result.roomId).emit("worldcup", { hostId: result.hostId, nodeIdx: result.nodeIdx });
        return res.json(result);
      } catch (e) {
        const message = e?.message || "Failed to host worldcup";
        return res.status(400).json({ error: message });
      }
    });

    router.post("/api/game/war-rate", requireAuth, async (req, res) => {
      try {
        const opponentUserId = Number(req.body?.opponentUserId);
        if (!Number.isInteger(opponentUserId)) return res.status(400).json({ error: "Invalid opponent" });
        const result = await prisma.$transaction(async (tx) => {
          const me = await tx.player.findFirst({ where: { userId: req.user.id }, orderBy: { id: "desc" }, include: { assets: true } });
          const opp = await tx.player.findFirst({ where: { userId: opponentUserId }, orderBy: { id: "desc" }, include: { assets: true } });
          if (!me || !opp) throw new Error("Player not found");
          const marketData = await market.getOrCreateMarket(tx, me.roomId);
          const myAsset = calcWarAssetValue(me.assets || { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 }, marketData, me.cash);
          const oppAsset = calcWarAssetValue(opp.assets || { samsung: 0, tesla: 0, lockheed: 0, gold: 0, bitcoin: 0 }, marketData, opp.cash);
          const winRate = calcWarWinRate({ myAsset, oppAsset, character: me.character });
          return { myAsset, oppAsset, winRate };
        });
        return res.json(result);
      } catch (e) {
        const message = e?.message || "Failed to calc war rate";
        return res.status(400).json({ error: message });
      }
    });

    router.post("/api/game/war/lose", requireAuth, async (req, res) => {
      try {
        const loserUserId = Number(req.body?.loserUserId);
        if (!Number.isInteger(loserUserId)) return res.status(400).json({ error: "Invalid loser" });
        const result = await prisma.$transaction(async (tx) => {
          const loser = await tx.player.findFirst({ where: { userId: loserUserId }, orderBy: { id: "desc" } });
          if (!loser) throw new Error("Player not found");
          const destroyed = await destroyMostExpensiveLandmark(tx, loser.id);
          return { roomId: loser.roomId, loserId: loser.id, destroyed };
        });
        if (result.destroyed && io) {
          io.to(result.roomId).emit("landmark_destroyed", { loserId: result.loserId, landId: result.destroyed.id });
        }
        return res.json({ ok: true });
      } catch (e) {
        const message = e?.message || "Failed to process war loss";
        return res.status(400).json({ error: message });
      }
    });

    router.get("/api/test/roll", requireAuth, async (req, res) => {
      try {
        const result = await rollDiceForUser({ userId: req.user.id });
        return res.json(result);
      } catch (e) {
        return res.status(500).json({ error: "Failed to roll dice" });
      }
    });

    return router;
  }

  async function destroyMostExpensiveLandmark(tx, playerId) {
    const landmarks = await tx.gameLand.findMany({ where: { ownerId: playerId, isLandmark: true }, orderBy: { purchasePrice: "desc" } });
    if (landmarks.length === 0) return null;
    const target = landmarks[0];
    return tx.gameLand.update({ where: { id: target.id }, data: { isLandmark: false } });
  }

  return {
    INITIAL_CASH,
    CHARACTER_LABEL,
    warState,
    roomTurnOrder,
    currentTurnUserByRoom,
    turnStateByRoom,
    actionWindowByRoom,
    getTurnPlayerId,
    getLatestPlayersByUser,
    getWarPayload,
    computeTotals,
    emitAssetUpdate,
    rollDiceForUser,
    calcWarAssetValue,
    calcWarWinRate,
    applyTrumpBonus,
    autoSellAssets,
    getLandBaseToll,
    getLandBasePrice,
    getEffectiveLandPrice,
    getVisitCount,
    setVisitCount,
    setLastAction,
    incrementVisit,
    getLastAction,
    createGameRoutes
  };
}

module.exports = { createGameLogic, CHARACTER_LABEL, INITIAL_CASH };
