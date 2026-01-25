require("dotenv").config();
const express=require("express");
const http=require("http");
const cors=require("cors");
const path=require("path");
const fs=require("fs");
const {Server}=require("socket.io");
const {PrismaClient}=require("@prisma/client");

const auth=require("./auth");
const {createMarketModule}=require("./market");
const {createGameLogic}=require("./gameLogic");
const {initSocketHandlers}=require("./socketHandler");

if(process.platform==="win32"){
  try{
    process.stdout.setDefaultEncoding("utf8");
    process.stderr.setDefaultEncoding("utf8");
  }catch(e){}
}
BigInt.prototype.toJSON=function(){return this.toString();};

const prisma=new PrismaClient();
const app=express();
const server=http.createServer(app);
const io=new Server(server,{cors:{origin:"*"}});
const publicDir=path.join(__dirname,"public");
const indexPath=path.join(publicDir,"index.html");

app.use(cors());
app.use(express.json());
if(fs.existsSync(publicDir))app.use(express.static(publicDir));

const market=createMarketModule({prisma});
const gameLogic=createGameLogic({prisma,io,market});

auth.initAuth(app,prisma,{
  onLogin:async(user)=>{
    if(!user?.id)return;
    await prisma.$transaction(async(tx)=>{
      await tx.gameLand.updateMany({data:{ownerId:null,isLandmark:false,hasWorldCup:false,purchasePrice:0}});
      await tx.player.updateMany({where:{userId:user.id},data:{cash:gameLogic.INITIAL_CASH,totalAsset:gameLogic.INITIAL_CASH,location:0,isBankrupt:false,extraTurnUsed:false}});
    });
  }
});

app.use(gameLogic.createGameRoutes({requireAuth:auth.requireAuth}));
app.use(market.createMarketRoutes({requireAuth:auth.requireAuth,gameLogic}));
app.get("/",(req,res)=>{
  if(fs.existsSync(indexPath)){
    res.sendFile(indexPath);
    return;
  }
  res.status(200).send("Frontend not included in this workspace.");
});

initSocketHandlers({io,prisma,auth,gameLogic,market});

async function initGame(){
  try{
    const room=await prisma.room.findUnique({where:{id:1}});
    if(!room)await prisma.room.create({data:{id:1,roomCode:"DEMO",status:"WAITING"}});
  }catch(e){
    console.error(e);
  }
}

server.listen(3000,async()=>{
  await initGame();
  console.log("Server running at http://localhost:3000");
});
