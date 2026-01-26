require("dotenv").config();
const express = require("express");
const http = require("http");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");

const auth = require("./auth");
const { createMarketModule } = require("./market");
const { createGameLogic } = require("./gameLogic");
const { initSocketHandlers } = require("./socketHandler");

// Windows console encoding setup
if (process.platform === "win32") {
  try {
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  } catch (e) {}
}

// Fix BigInt serialization for JSON
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const prisma = new PrismaClient();
const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*" },
});

const publicDir = path.join(__dirname, "public");
const indexPath = path.join(publicDir, "index.html");

app.use(cors());
app.use(express.json());
if (fs.existsSync(publicDir)) app.use(express.static(publicDir));

// Initialize Modules
const market = createMarketModule({ prisma });
const gameLogic = createGameLogic({ prisma, io, market });

// Initialize Auth
auth.initAuth(app, prisma, {
  onLogin: async (user) => {
    console.log(`[Auth] User logged in: ${user.nickname} (${user.id})`);
  },
});

// Routes
app.use(gameLogic.createGameRoutes({ requireAuth: auth.requireAuth }));
app.use(market.createMarketRoutes({ requireAuth: auth.requireAuth, gameLogic }));

app.get("/", (req, res) => {
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
    return;
  }
  res.status(200).send("Backend Server Running. Frontend not found.");
});

// Socket Handlers
initSocketHandlers({ io, prisma, auth, gameLogic, market });

// Game Data Reset Logic on Startup
async function resetGameOnStartup() {
  console.log("[System] Server starting: Initializing game data...");
  try {
    await prisma.$transaction(async (tx) => {
      // 1. Delete dependent data first
      await tx.gameLand.deleteMany({});
      await tx.playerAsset.deleteMany({});
      await tx.player.deleteMany({});
      
      // Delete Market before Room
      await tx.market.deleteMany({ where: { roomId: 1 } });

      // 2. Create or Update Room
      // title, id 등을 제거하고 필수 필드(roomCode, status)만 남김
      await tx.room.upsert({
        where: { id: 1 },
        update: {
          status: "WAITING",
          turnPlayerIdx: 0,
        },
        create: {
          roomCode: "DEMO",
          status: "WAITING",
        },
      });

      // 3. Create or Update Market
      await tx.market.upsert({
        where: { roomId: 1 },
        update: {
          priceSamsung: 70000n,
          priceTesla: 250000n,
          priceLockheed: 600000n,
          priceGold: 100000n,
          priceBtc: 50000000n,
        },
        create: {
          roomId: 1,
          priceSamsung: 70000n,
          priceTesla: 250000n,
          priceLockheed: 600000n,
          priceGold: 100000n,
          priceBtc: 50000000n,
        },
      });
    });
    console.log("[System] Game data initialization complete. (Room ID: 1)");
  } catch (e) {
    console.error("❌ [System] Error during game initialization:", e);
  }
}

const PORT = 3000;

// 서버 실행
server.listen(PORT, async () => {
  await resetGameOnStartup();
  console.log(`🚀 Server running at http://localhost:${PORT}`);
});