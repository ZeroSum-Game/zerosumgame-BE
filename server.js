require("dotenv").config(); // 1. 보안을 위해 환경변수 설정을 맨 위로!
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { PrismaClient } = require("@prisma/client");
const cors = require("cors");
const path = require("path");
const passport = require("passport"); // 추가
const GoogleStrategy = require("passport-google-oauth20").Strategy; // 추가
const session = require("express-session"); // 추가

// BigInt 에러 해결
BigInt.prototype.toJSON = function () {
  return this.toString();
};

const app = express();
const server = http.createServer(app);
const prisma = new PrismaClient();

// 2. 미들웨어 및 세션 설정 (로그인 유지를 위해 필요)
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET || "secret",
    resave: false,
    saveUninitialized: true,
  }),
);

app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// 3. [OAuth] 구글 전략 설정 (.env에서 정보를 가져옵니다)
passport.use(
  new GoogleStrategy(
    {
      clientID: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      callbackURL: "/api/auth/google/callback",
    },
    async (accessToken, refreshToken, profile, done) => {
      // 나중에 여기서 prisma를 통해 유저를 저장할 수 있어요!
      return done(null, profile);
    },
  ),
);

// 4. [API & Route] 라우트 설정 (반드시 listen 위에!)

// 구글 로그인 시작
app.get(
  "/auth/google",
  passport.authenticate("google", { scope: ["profile", "email"] }),
);

// 구글 로그인 성공 후 콜백 (이게 없으면 에러나요!)
app.get(
  "/api/auth/google/callback",
  passport.authenticate("google", { failureRedirect: "/" }),
  (req, res) => {
    res.redirect("/");
  },
);

app.get("/api/map", async (req, res) => {
  try {
    const mapData = await prisma.mapNode.findMany({
      orderBy: { nodeIdx: "asc" },
    });
    res.json(mapData);
  } catch (e) {
    res.status(500).json({ error: "맵 로딩 실패" });
  }
});

// 5. [Socket] 실시간 로직 (기존과 동일)
const io = new Server(server, { cors: { origin: "*" } });
io.on("connection", (socket) => {
  console.log(`🙋 유저 접속: ${socket.id}`);
  socket.on("join_room", (roomId) => {
    socket.join(roomId);
    socket.emit("join_success", { roomId, message: "방 입장 성공!" });
  });
});

// 6. [Final] 서버 실행 (무조건 맨 아래!)
async function initGame() {
  try {
    const room = await prisma.room.findUnique({ where: { id: 1 } });
    if (!room) {
      await prisma.room.create({
        data: { id: 1, roomCode: "DEMO", status: "WAITING" },
      });
      console.log("✅ 시연용 1번 방 생성 완료!");
    } else {
      console.log("♻️ 1번 방 로드 완료");
    }
  } catch (e) {
    console.error(e);
  }
}

server.listen(3000, async () => {
  await initGame();
  console.log("🚀 http://localhost:3000 에서 게임 실행 중!");
});
