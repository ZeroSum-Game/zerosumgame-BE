// prisma/seed.js

const { PrismaClient } = require("@prisma/client");
const prisma = new PrismaClient();

async function main() {
  console.log("🛠️ 맵 데이터 심기 시작...");

  // 기존 데이터 삭제 (중복 방지)
  await prisma.gameLand.deleteMany();
  await prisma.mapNode.deleteMany();

  // 0~31번 (시계 방향: 하단 -> 좌측 -> 상단 -> 우측)
  const mapData = [
    // ============================================
    // ⬇️ 1. 하단 라인 (0~7번) / 아시아 & 오세아니아
    // ============================================
    { nodeIdx: 0, name: "시작", type: "START", continent: "SPECIAL" },
    {
      nodeIdx: 1,
      name: "베트남",
      type: "LAND",
      continent: "ASIA",
      basePrice: 535500, // 기획서 반영
      baseToll: 260000,
    },
    { nodeIdx: 2, name: "오락실", type: "MINI", continent: "SPECIAL" },
    {
      nodeIdx: 3,
      name: "호주",
      type: "LAND",
      continent: "ASIA",
      basePrice: 665000, // 기획서 반영
      baseToll: 330000,
    },
    { nodeIdx: 4, name: "테슬라", type: "STOCK", continent: "SPECIAL" },
    {
      nodeIdx: 5,
      name: "중국",
      type: "LAND",
      continent: "ASIA",
      basePrice: 756000, // 기획서 반영
      baseToll: 370000,
    },
    {
      nodeIdx: 6,
      name: "일본",
      type: "LAND",
      continent: "ASIA",
      basePrice: 735000, // 기획서 반영
      baseToll: 360000,
    },
    {
      nodeIdx: 7,
      name: "대한민국",
      type: "LAND",
      continent: "ASIA",
      basePrice: 700000, // 기획서 반영
      baseToll: 350000,
    },

    // ============================================
    // ⬅️ 2. 좌측 라인 (8~15번) / 중동 & 아프리카
    // ============================================
    { nodeIdx: 8, name: "전쟁", type: "JAIL", continent: "SPECIAL" },
    { nodeIdx: 9, name: "금 거래소", type: "STOCK", continent: "SPECIAL" },
    {
      nodeIdx: 10,
      name: "UAE",
      type: "LAND",
      continent: "AFRICA",
      basePrice: 770000, // 기획서 반영
      baseToll: 380000,
    },
    {
      nodeIdx: 11,
      name: "이란",
      type: "LAND",
      continent: "AFRICA",
      basePrice: 630000, // 기획서 반영
      baseToll: 310000,
    },
    { nodeIdx: 12, name: "황금열쇠", type: "KEY", continent: "SPECIAL" },
    {
      nodeIdx: 13,
      name: "이집트",
      type: "LAND",
      continent: "AFRICA",
      basePrice: 567000, // 기획서 반영
      baseToll: 280000,
    },
    { nodeIdx: 14, name: "록히드마틴", type: "STOCK", continent: "SPECIAL" },
    {
      nodeIdx: 15,
      name: "남아공",
      type: "LAND",
      continent: "AFRICA",
      basePrice: 598500, // 기획서 반영
      baseToll: 290000,
    },

    // ============================================
    // ⬆️ 3. 상단 라인 (16~23번) / 유럽
    // ============================================
    { nodeIdx: 16, name: "월드컵/올림픽", type: "EXPO", continent: "SPECIAL" },
    {
      nodeIdx: 17,
      name: "러시아",
      type: "LAND",
      continent: "EUROPE",
      basePrice: 661500, // 기획서 반영
      baseToll: 330000,
    },
    { nodeIdx: 18, name: "삼성전자", type: "STOCK", continent: "SPECIAL" },
    {
      nodeIdx: 19,
      name: "스위스",
      type: "LAND",
      continent: "EUROPE",
      basePrice: 1001000, // 기획서 반영
      baseToll: 500000,
    },
    { nodeIdx: 20, name: "황금열쇠", type: "KEY", continent: "SPECIAL" },
    {
      nodeIdx: 21,
      name: "프랑스",
      type: "LAND",
      continent: "EUROPE",
      basePrice: 770000, // 기획서 반영
      baseToll: 380000,
    },
    {
      nodeIdx: 22,
      name: "영국",
      type: "LAND",
      continent: "EUROPE",
      basePrice: 924000, // 기획서 반영
      baseToll: 460000,
    },
    {
      nodeIdx: 23,
      name: "독일",
      type: "LAND",
      continent: "EUROPE",
      basePrice: 885000, // 기획서 반영
      baseToll: 440000,
    },

    // ============================================
    // ➡️ 4. 우측 라인 (24~31번) / 아메리카
    // ============================================
    { nodeIdx: 24, name: "우주여행", type: "ISLAND", continent: "SPECIAL" },
    { nodeIdx: 25, name: "비트코인", type: "STOCK", continent: "SPECIAL" },
    {
      nodeIdx: 26,
      name: "브라질",
      type: "LAND",
      continent: "AMERICA",
      basePrice: 630000, // 기획서 반영
      baseToll: 310000,
    },
    {
      nodeIdx: 27,
      name: "아르헨티나",
      type: "LAND",
      continent: "AMERICA",
      basePrice: 567000, // 기획서 반영
      baseToll: 280000,
    },
    { nodeIdx: 28, name: "황금열쇠", type: "KEY", continent: "SPECIAL" },
    {
      nodeIdx: 29,
      name: "캐나다",
      type: "LAND",
      continent: "AMERICA",
      basePrice: 735000, // 기획서 반영
      baseToll: 360000,
    },
    { nodeIdx: 30, name: "국세청", type: "TAX", continent: "SPECIAL" },
    {
      nodeIdx: 31,
      name: "미국",
      type: "LAND",
      continent: "AMERICA",
      basePrice: 1078000, // 기획서 반영
      baseToll: 530000,
    },
  ];

  for (const node of mapData) {
    await prisma.mapNode.create({ data: node });
  }

  console.log("✅데이터 32개 반영 완료!");
}

main()
  .catch((e) => console.error(e))
  .finally(async () => await prisma.$disconnect());
