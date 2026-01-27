function initSocketHandlers({io,prisma,auth,gameLogic,market}){
  const lobbyStateByRoom=new Map();
  const socketUserMap=new Map();
  const orderPickingByRoom=new Map();
  const rollingUserByRoom=new Map();
  const minigameStateByRoom=new Map();
  const minigameTimerByRoom=new Map();

  const MINIGAME_INTRO_SECONDS=5;
  const MINIGAME_TOTAL_SECONDS=20;
  const MINIGAME_RESULT_SECONDS=5;
  const MINIGAME_BASE_SECONDS=5;
  const MINIGAME_MIN_SECONDS=2;

  const MINIGAME_QUESTIONS=[
    "박찬우","김명성","김지연","임태빈","배서연","이건","강예서",
    "신원영","박성재","정재우","민동휘","임남중","박성준","이준엽",
    "탁한진","최영운","정재원","안준영","박세윤","임유진","전하은"
  ];

  const CHOSUNG_LIST=["ㄱ","ㄲ","ㄴ","ㄷ","ㄸ","ㄹ","ㅁ","ㅂ","ㅃ","ㅅ","ㅆ","ㅇ","ㅈ","ㅉ","ㅊ","ㅋ","ㅌ","ㅍ","ㅎ"];
  function getChosung(text){
    if(!text) return "";
    let out="";
    for(const ch of String(text)){
      const code=ch.charCodeAt(0);
      if(code>=0xac00&&code<=0xd7a3){
        const idx=Math.floor((code-0xac00)/588);
        out+=CHOSUNG_LIST[idx]||"";
      }else{
        out+=ch;
      }
    }
    return out;
  }

  function pickRandomName(namePool){
    if(!namePool||namePool.length===0)return "";
    return namePool[Math.floor(Math.random()*namePool.length)];
  }

  function computeMinigameTimeLimit(correctCount){
    return Math.max(MINIGAME_MIN_SECONDS, MINIGAME_BASE_SECONDS - correctCount*0.7);
  }

  function buildMinigameRanking(state){
    const ranked=[...state.players].sort((a,b)=>{
      if(a.score===b.score)return 0;
      return a.score>b.score?-1:1;
    });
    return ranked.map((p,idx)=>({
      rank:idx+1,
      userId:p.userId,
      nickname:p.nickname,
      score:p.score,
      isDropped:p.isDropped
    }));
  }

  function buildMinigamePayload(state){
    if(!state) return null;
    const ranking=buildMinigameRanking(state);
    const winnerUserId=ranking[0]?.userId||null;
    return {
      phase: state.phase,
      players: state.players.map(p=>({
        userId:p.userId,
        nickname:p.nickname,
        score:p.score,
        isDropped:p.isDropped
      })),
      currentChosung: state.currentChosung || "",
      timeLeft: state.timeLeft,
      timeLimit: state.timeLimit,
      countdown: state.countdown,
      introLeft: state.introLeft,
      totalLeft: state.gameEndAt ? Math.max(0, Math.ceil((state.gameEndAt-Date.now())/1000)) : 0,
      resultLeft: state.resultLeft || 0,
      winners: state.winners||null,
      ranking,
      winnerUserId
    };
  }

  function broadcastMinigame(roomId){
    const state=minigameStateByRoom.get(roomId);
    if(!state||!io) return;
    io.to(roomId).emit("minigame_state",buildMinigamePayload(state));
  }

  function stopMinigameTimer(roomId){
    const timer=minigameTimerByRoom.get(roomId);
    if(timer){
      clearInterval(timer);
      minigameTimerByRoom.delete(roomId);
    }
  }

  function endMinigame(roomId){
    const state=minigameStateByRoom.get(roomId);
    if(!state) return;
    state.phase="RESULT";
    const maxScore=Math.max(0,...state.players.map(p=>p.score||0));
    const winners=state.players.filter(p=>p.score===maxScore);
    state.winners=winners.map(p=>p.nickname);
    state.resultLeft=MINIGAME_RESULT_SECONDS;
    state.resultEndAt=Date.now()+MINIGAME_RESULT_SECONDS*1000;
    broadcastMinigame(roomId);
  }

  function startMinigameLoop(roomId){
    stopMinigameTimer(roomId);
    const timer=setInterval(()=>{
      const state=minigameStateByRoom.get(roomId);
      if(!state) return;
      const now=Date.now();
      if(state.phase==="INTRO"){
        state.introLeft=Math.max(0,(state.introLeft||0)-1);
        if(state.introLeft<=0){
          state.phase="GAME";
          state.gameEndAt=now+MINIGAME_TOTAL_SECONDS*1000;
          state.correctCount=state.correctCount||0;
          state.timeLimit=computeMinigameTimeLimit(state.correctCount);
          state.timeLeft=Math.ceil(state.timeLimit);
          state.currentName=state.questionOrder[state.questionIndex]||pickRandomName(state.questionOrder);
          state.currentChosung=getChosung(state.currentName);
        }
        broadcastMinigame(roomId);
        return;
      }
      if(state.phase==="GAME"){
        if(state.gameEndAt&&now>=state.gameEndAt){
          endMinigame(roomId);
          return;
        }
        const aliveCount=state.players.filter((p)=>!p.isDropped).length;
        if(aliveCount<=1){
          endMinigame(roomId);
          return;
        }
        state.timeLeft=Math.max(0,(state.timeLeft||0)-1);
        if(state.timeLeft<=0){
          // timeout -> current active players are eliminated
          state.players.forEach((p)=>{ if(!p.isDropped) p.isDropped=true; });
          endMinigame(roomId);
          return;
        }
        broadcastMinigame(roomId);
        return;
      }
      if(state.phase==="RESULT"){
        state.resultLeft=Math.max(0,(state.resultLeft||0)-1);
        if(state.resultLeft<=0){
          broadcastMinigame(roomId);
          stopMinigameTimer(roomId);
          return;
        }
        broadcastMinigame(roomId);
      }
    },1000);
    minigameTimerByRoom.set(roomId,timer);
  }

  function shuffleArray(items){
    const arr=items.slice();
    for(let i=arr.length-1;i>0;i-=1){
      const j=Math.floor(Math.random()*(i+1));
      const temp=arr[i];
      arr[i]=arr[j];
      arr[j]=temp;
    }
    return arr;
  }

  io.use((socket,next)=>{
    try{
      const token=socket.handshake.auth?.token;
      if(!token)return next(new Error("Unauthorized"));
      const user=auth.verifySocketToken(token);
      socket.user=user;
      return next();
    }catch(err){
      return next(new Error("Unauthorized"));
    }
  });

  function getLobbyState(roomId){
    if(!lobbyStateByRoom.has(roomId)){
      lobbyStateByRoom.set(roomId,{hostUserId:null,readyUserIds:new Set(),players:new Map()});
    }
    return lobbyStateByRoom.get(roomId);
  }

  function buildLobbyPayload(roomId){
    const lobby=getLobbyState(roomId);
    const players=Array.from(lobby.players.values()).map((p)=>({
      userId:p.userId,
      playerId:p.playerId,
      nickname:p.nickname||`Player${p.userId}`,
      character:p.character||null,
      ready:lobby.readyUserIds.has(p.userId),
      isHost:lobby.hostUserId===p.userId
    }));
    const MIN_PLAYERS=2;
    // 모든 플레이어(방장 포함)가 준비되었는지 체크 (최소 인원 이상)
    const allReady=players.length>=MIN_PLAYERS&&players.every((p)=>p.ready);
    return{hostUserId:lobby.hostUserId,players,allReady};
  }

  function resetWarState(){
    if(!gameLogic.warState)return;
    gameLogic.warState.active=false;
    gameLogic.warState.warLine=null;
    gameLogic.warState.warNode=null;
    gameLogic.warState.turnsLeft=0;
    gameLogic.warState.recoveryActive=false;
    gameLogic.warState.recoveryLine=1;
    gameLogic.warState.recoveryNode=1;
  }

  function isActiveSocketId(socketId){
    return !!socketId&&!!io&&!!io.sockets&&!!io.sockets.sockets&&io.sockets.sockets.has(socketId);
  }

  async function getActivePlayersByUser(roomId){
    const players=await gameLogic.getLatestPlayersByUser(prisma,roomId);
    return players.filter((p)=>isActiveSocketId(p.socketId));
  }

  async function buildMinigamePlayers(roomId){
    const activePlayers=await getActivePlayersByUser(roomId);
    const players=activePlayers.length?activePlayers:await gameLogic.getLatestPlayersByUser(prisma,roomId);
    if(players.length===0)return [];
    const users=await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}});
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    return players.map((p)=>({
      userId:p.userId,
      nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
      score:0,
      isDropped:false
    }));
  }

  async function createMinigameState(roomId){
    const players=await buildMinigamePlayers(roomId);
    if(players.length===0)return null;
    const now=Date.now();
    const questionOrder=shuffleArray(MINIGAME_QUESTIONS);
    const state={
      phase:"INTRO",
      players,
      countdown:0,
      introLeft:MINIGAME_INTRO_SECONDS,
      timeLimit:computeMinigameTimeLimit(0),
      timeLeft:computeMinigameTimeLimit(0),
      currentName:"",
      currentChosung:"",
      correctCount:0,
      gameEndAt:null,
      resultLeft:0,
      resultEndAt:null,
      winners:null,
      questionOrder,
      questionIndex:0
    };
    minigameStateByRoom.set(roomId,state);
    startMinigameLoop(roomId);
    broadcastMinigame(roomId);
    return state;
  }

  async function syncLobbyPlayers(roomId){
    const lobby=getLobbyState(roomId);
    if(lobby.players.size>0)return lobby;
    const players=await getActivePlayersByUser(roomId);
    if(players.length===0)return lobby;
    const users=await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}});
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    players.forEach((p)=>{
      lobby.players.set(p.userId,{
        userId:p.userId,
        nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
        playerId:p.id,
        character:p.character||null
      });
    });
    if(!lobby.hostUserId&&players.length>0)lobby.hostUserId=players[0].userId;
    return lobby;
  }

  async function buildResumePayload(roomId){
    const activePlayers=await getActivePlayersByUser(roomId);
    const players=activePlayers.length?activePlayers:await gameLogic.getLatestPlayersByUser(prisma,roomId);
    const users=players.length?await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}}):[];
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    const playersPayload=players.map((p)=>({
      playerId:p.id,
      userId:p.userId,
      nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
      character:p.character||null,
      location:typeof p.location==="number"?p.location:0,
      cash:p.cash,
      totalAsset:p.totalAsset
    }));
    const playerIdSet=new Set(playersPayload.map((p)=>p.playerId));
    const storedOrder=gameLogic.roomTurnOrder.get(roomId);
    const turnOrderPlayerIds=storedOrder?storedOrder.filter((id)=>playerIdSet.has(id)):playersPayload.map((p)=>p.playerId);
    if(turnOrderPlayerIds.length)gameLogic.roomTurnOrder.set(roomId,turnOrderPlayerIds);
    else gameLogic.roomTurnOrder.delete(roomId);
    const playerIdToUser=new Map(playersPayload.map((p)=>[p.playerId,p.userId]));
    const turnOrder=turnOrderPlayerIds.map((id)=>playerIdToUser.get(id)).filter((id)=>id!=null);
    const turnPlayerId=turnOrderPlayerIds.length?await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,roomId)):null;
    let currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||null;
    if(!currentTurn&&turnPlayerId){
      const turnPlayer=await prisma.player.findUnique({where:{id:turnPlayerId},select:{userId:true}});
      currentTurn=turnPlayer?.userId||null;
      if(currentTurn)gameLogic.currentTurnUserByRoom.set(roomId,currentTurn);
    }
    if(currentTurn&&!gameLogic.turnStateByRoom.get(roomId)){
      gameLogic.turnStateByRoom.set(roomId,{userId:currentTurn,rolled:false,extraRoll:false});
    }
    return{resume:true,turnPlayerId,currentTurn,turnOrder,turnOrderPlayerIds,players:playersPayload};
  }

  async function ensureCurrentTurnUser(roomId){
    let currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||null;
    if(currentTurn)return currentTurn;
    const turnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,roomId));
    if(!turnPlayerId)return null;
    const turnPlayer=await prisma.player.findUnique({where:{id:turnPlayerId},select:{userId:true}});
    currentTurn=turnPlayer?.userId||null;
    if(currentTurn)gameLogic.currentTurnUserByRoom.set(roomId,currentTurn);
    return currentTurn;
  }

  async function buildStartPayload(roomId,turnOrderPlayerIds){
    const players=await prisma.player.findMany({where:{id:{in:turnOrderPlayerIds}}});
    const users=await prisma.user.findMany({where:{id:{in:players.map((p)=>p.userId)}},select:{id:true,nickname:true}});
    const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
    const byId=new Map(players.map((p)=>[p.id,p]));
    const orderedPlayers=turnOrderPlayerIds.map((id)=>byId.get(id)).filter(Boolean);
    const playersPayload=orderedPlayers.map((p)=>({
      playerId:p.id,
      userId:p.userId,
      nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
      character:p.character||null,
      location:typeof p.location==="number"?p.location:0,
      cash:p.cash,
      totalAsset:p.totalAsset
    }));
    const currentTurn=gameLogic.currentTurnUserByRoom.get(roomId)||playersPayload[0]?.userId||null;
    const turnOrder=playersPayload.map((p)=>p.userId);
    return{players:playersPayload,currentTurn,turnOrder,turnOrderPlayerIds,turnPlayerId:playersPayload[0]?.playerId||null};
  }

  io.on("connection",(socket)=>{
    socket.on("join_room",async(roomId)=>{
      try{
        const sessionUserId=socket.user?.id;
        const numericRoomId=Number(roomId);
        if(!sessionUserId||!Number.isInteger(numericRoomId)){
          socket.emit("join_error",{message:"Invalid room"});
          return;
        }
        const resolvedRoomId=numericRoomId;
        let room=await prisma.room.findUnique({where:{id:resolvedRoomId}});
        if(!room){
          room=await prisma.room.create({data:{id:resolvedRoomId,roomCode:"MAIN",status:"WAITING"}});
        }
        const lobbyState=getLobbyState(resolvedRoomId);
        const MAX_PLAYERS=4;
        if(!lobbyState.players.has(sessionUserId)&&lobbyState.players.size>=MAX_PLAYERS){
          socket.emit("join_error",{message:`Room is full (${MAX_PLAYERS} max)`});
          return;
        }
        // 방 리셋 조건: ENDED 상태이고 lobbyState가 비어있을 때만
        if(room.status==="ENDED"&&lobbyState.players.size===0){
          room=await prisma.room.update({where:{id:resolvedRoomId},data:{status:"WAITING",turnPlayerIdx:0,currentTurn:1}});
          await prisma.gameLand.deleteMany({where:{roomId:resolvedRoomId}});
          await prisma.player.deleteMany({where:{roomId:resolvedRoomId}});
          gameLogic.currentTurnUserByRoom.delete(resolvedRoomId);
          gameLogic.roomTurnOrder.delete(resolvedRoomId);
          gameLogic.actionWindowByRoom.delete(resolvedRoomId);
          gameLogic.turnStateByRoom.delete(resolvedRoomId);
          market.clearTradeLock(resolvedRoomId);
          rollingUserByRoom.delete(resolvedRoomId);
          orderPickingByRoom.delete(resolvedRoomId);
          resetWarState();
        }
        const user=await prisma.user.findUnique({where:{id:sessionUserId}});
        let player=await prisma.player.findFirst({where:{roomId:resolvedRoomId,userId:sessionUserId},orderBy:{id:"desc"},include:{assets:true}});
        if(!player){
          player=await prisma.player.create({
            data:{
              roomId:resolvedRoomId,
              userId:sessionUserId,
              socketId:socket.id,
              cash:gameLogic.INITIAL_CASH,
              totalAsset:gameLogic.INITIAL_CASH,
              assets:{create:{samsung:0,tesla:0,lockheed:0,gold:0,bitcoin:0}}
            },
            include:{assets:true}
          });
        }else{
          player=await prisma.player.update({where:{id:player.id},data:{socketId:socket.id},include:{assets:true}});
        }
        // Do not clear character on refresh while waiting; keep existing selection.
        if(room.status==="WAITING"){
          lobbyState.readyUserIds.delete(sessionUserId);
        }
        if(room.status==="PLAYING"){
          await syncLobbyPlayers(resolvedRoomId);
          if(!gameLogic.roomTurnOrder.get(resolvedRoomId)){
            const activePlayers=await getActivePlayersByUser(resolvedRoomId);
            const fallbackOrder=activePlayers.slice().sort((a,b)=>a.id-b.id).map((p)=>p.id);
            if(fallbackOrder.length)gameLogic.roomTurnOrder.set(resolvedRoomId,fallbackOrder);
          }
        }
        socket.join(resolvedRoomId);
        socketUserMap.set(socket.id,{roomId:resolvedRoomId,userId:sessionUserId});
        const lobby=getLobbyState(resolvedRoomId);
        lobby.players.set(sessionUserId,{userId:sessionUserId,nickname:user?.nickname||`Player${sessionUserId}`,playerId:player.id,character:player.character});
        if(!lobby.hostUserId)lobby.hostUserId=sessionUserId;
        if(room.status==="PLAYING"){
          await ensureCurrentTurnUser(resolvedRoomId);
        }
        const turnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,resolvedRoomId));
        const marketData=await prisma.$transaction(async(tx)=>market.getOrCreateMarket(tx,resolvedRoomId));
        const lobbyPayload=buildLobbyPayload(resolvedRoomId);
        socket.emit("join_success",{roomId:resolvedRoomId,message:"Join success",player,turnPlayerId,war:gameLogic.getWarPayload(),roomStatus:room.status,lobby:lobbyPayload,currentTurn:gameLogic.currentTurnUserByRoom.get(resolvedRoomId)||null});
        socket.emit("market_update",{samsung:marketData.priceSamsung,tesla:marketData.priceTesla,lockheed:marketData.priceLockheed,gold:marketData.priceGold,bitcoin:marketData.priceBtc,prevSamsung:marketData.prevSamsung,prevTesla:marketData.prevTesla,prevLockheed:marketData.prevLockheed,prevGold:marketData.prevGold,prevBtc:marketData.prevBtc});
        socket.emit("war_state",gameLogic.getWarPayload());
        io.to(resolvedRoomId).emit("lobby_update",lobbyPayload);
        await gameLogic.emitAssetUpdate(player.id);
        if(room.status==="PLAYING"){
          const resumePayload=await buildResumePayload(resolvedRoomId);
          socket.emit("game_start",resumePayload);
        }
      }catch(err){
        socket.emit("join_error",{message:"Failed to join room"});
      }
    });

    socket.on("set_ready",async({ready})=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info)return;
        const lobby=getLobbyState(info.roomId);
        const player=await prisma.player.findFirst({where:{userId:info.userId,roomId:info.roomId},orderBy:{id:"desc"}});
        const isReady=!!ready;
        if(isReady&&(!player||!player.character)){
          socket.emit("ready_error",{message:"Select a character before ready"});
          return;
        }
        if(isReady)lobby.readyUserIds.add(info.userId);
        else lobby.readyUserIds.delete(info.userId);
        if(player){
          const entry=lobby.players.get(info.userId);
          if(entry){
            entry.character=player.character||null;
            entry.playerId=player.id;
          }
          if(player.character)io.to(info.roomId).emit("character_update",{playerId:player.id,userId:info.userId,character:player.character});
        }
        io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
      }catch(err){}
    });

    socket.on("start_game",async()=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("start_error",{message:"Room not joined"});
          return;
        }
        const roomId=info.roomId;
        const room=await prisma.room.findUnique({where:{id:roomId}});
        if(!room){
          socket.emit("start_error",{message:"Room not found"});
          return;
        }
        if(room.status==="PLAYING"){
          await ensureCurrentTurnUser(roomId);
          const resumePayload=await buildResumePayload(roomId);
          socket.emit("game_start",resumePayload);
          return;
        }
        if(orderPickingByRoom.has(roomId)){
          socket.emit("start_error",{message:"Order picking already started"});
          return;
        }
        const lobby=await syncLobbyPlayers(roomId);
        if(lobby.hostUserId!==info.userId){
          socket.emit("start_error",{message:"Only the host can start"});
          return;
        }
        const activePlayers=await getActivePlayersByUser(roomId);
        if(activePlayers.length<2){
          socket.emit("start_error",{message:"At least 2 players are required"});
          return;
        }
        const users=await prisma.user.findMany({where:{id:{in:activePlayers.map((p)=>p.userId)}},select:{id:true,nickname:true}});
        const nicknameByUser=new Map(users.map((u)=>[u.id,u.nickname]));
        activePlayers.forEach((p)=>{
          const entry=lobby.players.get(p.userId);
          if(entry){
            entry.playerId=p.id;
            entry.character=p.character||null;
            entry.nickname=entry.nickname||nicknameByUser.get(p.userId)||`Player${p.userId}`;
          }else{
            lobby.players.set(p.userId,{
              userId:p.userId,
              nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
              playerId:p.id,
              character:p.character||null
            });
          }
        });
        const lobbyPayload=buildLobbyPayload(roomId);
        const MIN_PLAYERS=2;
        if(activePlayers.length<MIN_PLAYERS){
          socket.emit("start_error",{message:"At least 2 players are required"});
          return;
        }
        if(lobbyPayload.players.length<2||!lobbyPayload.allReady){
          socket.emit("start_error",{message:"All players must be ready"});
          return;
        }
        if(activePlayers.some((p)=>!p.character)){
          socket.emit("start_error",{message:"All players must select a character"});
          return;
        }

        // 순서 뽑기 단계 시작 - 카드 번호는 랜덤 배치
        const cardIds=Array.from({length:activePlayers.length},(_,i)=>i+1);
        const cardValues=new Map(cardIds.map((id)=>[id,id]));
        const availableCards=shuffleArray(cardIds.slice());
        orderPickingByRoom.set(info.roomId,{
          cardIds,
          cardValues,
          availableCards,
          picks:new Map(),
          players:activePlayers.map((p)=>({
            userId:p.userId,
            playerId:p.id,
            nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
            character:p.character||null
          }))
        });
        io.to(roomId).emit("order_picking_start",{availableCards});
      }catch(err){
        socket.emit("start_error",{message:"Failed to start game"});
      }
    });

    socket.on("minigame_start",async()=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("minigame_error",{message:"Room not joined"});
          return;
        }
        io.to(info.roomId).emit("minigame_start",{startedBy:info.userId});
      }catch(err){
        socket.emit("minigame_error",{message:"Failed to start minigame"});
      }
    });

    socket.on("minigame_join",async()=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("minigame_error",{message:"Room not joined"});
          return;
        }
        const roomId=info.roomId;
        let state=minigameStateByRoom.get(roomId);
        if(!state){
          state=await createMinigameState(roomId);
          if(!state){
            socket.emit("minigame_error",{message:"No players available"});
            return;
          }
          return;
        }
        if(state.phase==="RESULT"){
          socket.emit("minigame_state",buildMinigamePayload(state));
          return;
        }
        const exists=state.players.some((p)=>p.userId===info.userId);
        if(!exists){
          const user=await prisma.user.findUnique({where:{id:info.userId},select:{nickname:true}});
          state.players.push({
            userId:info.userId,
            nickname:user?.nickname||`Player${info.userId}`,
            score:0,
            isDropped:false
          });
          broadcastMinigame(roomId);
        }else{
          socket.emit("minigame_state",buildMinigamePayload(state));
        }
      }catch(err){
        socket.emit("minigame_error",{message:"Failed to join minigame"});
      }
    });

    socket.on("minigame_answer",async(payload)=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info)return;
        const roomId=info.roomId;
        const state=minigameStateByRoom.get(roomId);
        if(!state||state.phase!=="GAME")return;
        const player=state.players.find((p)=>p.userId===info.userId);
        if(!player||player.isDropped)return;
        const answer=String(payload?.answer||"").trim();
        if(!answer)return;
        const answerChosung=getChosung(answer);
        const isKnownName=MINIGAME_QUESTIONS.includes(answer);
        if(answerChosung===state.currentChosung&&isKnownName){
          player.score=(player.score||0)+1;
          state.correctCount=(state.correctCount||0)+1;
          state.timeLimit=computeMinigameTimeLimit(state.correctCount);
          state.timeLeft=Math.ceil(state.timeLimit);
          state.questionIndex=(state.questionIndex+1)%state.questionOrder.length;
          state.currentName=state.questionOrder[state.questionIndex];
          state.currentChosung=getChosung(state.currentName);
        }else{
          player.isDropped=true;
        }
        const aliveCount=state.players.filter((p)=>!p.isDropped).length;
        if(aliveCount<=1){
          endMinigame(roomId);
          return;
        }
        broadcastMinigame(roomId);
      }catch(err){
        socket.emit("minigame_error",{message:"Failed to submit answer"});
      }
    });

    socket.on("pick_order_card",async(cardNumber)=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("pick_error",{message:"Room not joined"});
          return;
        }
        const roomId=info.roomId;
        const userId=info.userId;
        const orderState=orderPickingByRoom.get(roomId);
        if(!orderState){
          socket.emit("pick_error",{message:"Order picking not active"});
          return;
        }
        const cardId=Number(cardNumber);
        if(!Number.isInteger(cardId)){
          socket.emit("pick_error",{message:"Invalid card"});
          return;
        }
        const availableCards=orderState.availableCards||orderState.cardIds;
        if(!availableCards.includes(cardId)){
          socket.emit("pick_error",{message:"Invalid card"});
          return;
        }

        // 유효한 카드인지 확인
        if(!orderState.cardIds.includes(cardId)){
          socket.emit("pick_error",{message:"유효하지 않은 카드입니다."});
          return;
        }

        // 이미 다른 사람이 선택한 카드인지 확인
        const pickedCards=Array.from(orderState.picks.values());
        if(pickedCards.includes(cardId)){
          socket.emit("pick_error",{message:"이미 선택된 카드입니다."});
          return;
        }

        // 카드 선택 저장
        orderState.picks.set(userId,cardId);
        const cardNumberValue=orderState.cardValues.get(cardId);
        console.log(`[Order Pick] User ${userId} picked card ${cardId} => ${cardNumberValue}`);

        // 모든 클라이언트에게 선택 상황 알림
        io.to(info.roomId).emit("order_card_picked",{
          userId,
          cardId,
          cardNumber:cardNumberValue,
          pickedCards:Array.from(orderState.picks.values()),
          remainingCards:orderState.cardIds.filter((c)=>!Array.from(orderState.picks.values()).includes(c))
        });

        // 모든 플레이어가 선택했는지 확인
        if(orderState.picks.size===orderState.players.length){
          // 순서 결정 및 게임 시작
          const sortedPlayers=[...orderState.players].sort((a,b)=>{
            const aCardId=orderState.picks.get(a.userId);
            const bCardId=orderState.picks.get(b.userId);
            const aCard=orderState.cardValues.get(aCardId)||99;
            const bCard=orderState.cardValues.get(bCardId)||99;
            return aCard-bCard;
          });

          const orderPlayerIds=sortedPlayers.map((p)=>p.playerId);
          const orderUserIds=sortedPlayers.map((p)=>p.userId);

          gameLogic.roomTurnOrder.set(info.roomId,orderPlayerIds);
        const currentTurn=orderUserIds[0]||null;
        gameLogic.currentTurnUserByRoom.set(info.roomId,currentTurn);
        market.clearTradeLock(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.set(info.roomId,{userId:currentTurn,rolled:false,extraRoll:false});

        await prisma.$transaction(async(tx)=>{
          await tx.room.update({where:{id:roomId},data:{status:"PLAYING",turnPlayerIdx:0,currentTurn:1,maxTurn:20}});
          await market.resetMarketDefaults(tx,roomId);
        });

        const lobbyInfo=buildLobbyPayload(info.roomId);
        const nicknameByUser=new Map(lobbyInfo.players.map((p)=>[p.userId,p.nickname]));
        const allPlayers=await gameLogic.getLatestPlayersByUser(prisma,info.roomId);
        const activeUserIds=new Set(lobbyInfo.players.map((p)=>p.userId));
          const players=allPlayers.filter((p)=>activeUserIds.has(p.userId));

          const playersPayload=players.map((p)=>({
            playerId:p.id,
            userId:p.userId,
            nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,
            character:p.character||null,
            location:typeof p.location==="number"?p.location:0
          }));

          // 순서 결과를 먼저 보여주고
          const orderResults=sortedPlayers.map((p,idx)=>({
            userId:p.userId,
            playerId:p.playerId,
            cardNumber:orderState.cardValues.get(orderState.picks.get(p.userId))||0,
            turnOrder:idx+1,
            nickname:p.nickname
          }));

          io.to(roomId).emit("order_picking_complete",{orderResults});
          orderPickingByRoom.delete(roomId);

          setTimeout(()=>{
            void (async()=>{
              try{
                const payload=await buildStartPayload(roomId,orderPlayerIds);
                io.to(roomId).emit("game_start",payload);
                io.to(roomId).emit("lobby_update",buildLobbyPayload(roomId));
              }catch(err){
                io.to(roomId).emit("start_error",{message:"Failed to start game"});
              }
            })();
          },1200);
        }
      }catch(err){
        socket.emit("pick_error",{message:"Failed to pick card"});
      }
    });

    socket.on("roll_dice",async()=>{
      try{
        const userId=socket.user?.id;
        if(!userId){
          socket.emit("roll_error",{message:"Login session expired"});
          return;
        }
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("roll_error",{message:"Room not joined"});
          return;
        }
        const rollingUserId=rollingUserByRoom.get(info.roomId);
        if(rollingUserId&&rollingUserId!==userId){
          socket.emit("roll_error",{message:"Another player is rolling"});
          return;
        }
        if(rollingUserId===userId){
          socket.emit("roll_error",{message:"Already rolling"});
          return;
        }
        const result=await gameLogic.rollDiceForUser({userId});
        if(result.turnUserId)gameLogic.currentTurnUserByRoom.set(result.roomId,result.turnUserId);
        rollingUserByRoom.set(info.roomId,userId);
        io.to(info.roomId).emit("dice_rolling_started",{userId});
        setTimeout(()=>{
          try{
            io.to(result.roomId).emit("dice_rolled",{userId,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,player:result.player,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
            io.to(result.roomId).emit("playerMove",{userId,playerId:result.player.id,character:result.player.character,oldLocation:result.oldLocation,newLocation:result.newLocation,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
            // drawCard is emitted only via explicit draw_card to avoid double fires.
            if(result.market){
              io.to(result.roomId).emit("market_update",{samsung:result.market.priceSamsung,tesla:result.market.priceTesla,lockheed:result.market.priceLockheed,gold:result.market.priceGold,bitcoin:result.market.priceBtc,prevSamsung:result.market.prevSamsung,prevTesla:result.market.prevTesla,prevLockheed:result.market.prevLockheed,prevGold:result.market.prevGold,prevBtc:result.market.prevBtc});
            }
            if(result.war){
              io.to(result.roomId).emit("war_state",result.war);
              if(result.warStarted)io.to(result.roomId).emit("war_start",result.war);
              if(result.warEnded)io.to(result.roomId).emit("war_end",result.war);
            }
            gameLogic.emitAssetUpdate(result.player.id);
            if(result.tollOwnerId)gameLogic.emitAssetUpdate(result.tollOwnerId);
          }catch(err){
            if(rollingUserByRoom.get(info.roomId)===userId){
              rollingUserByRoom.delete(info.roomId);
              io.to(info.roomId).emit("dice_roll_cancelled",{userId,reason:"EMIT_FAILED"});
            }
            socket.emit("roll_error",{message:"Failed to broadcast dice result"});
            return;
          }
          if(rollingUserByRoom.get(info.roomId)===userId){
            rollingUserByRoom.delete(info.roomId);
          }
        },800);
      }catch(err){
        socket.emit("roll_error",{message:err?.message||"Failed to roll dice"});
      }
    });

    socket.on("draw_card",async(payload)=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("draw_error",{message:"Room not joined"});
          return;
        }
        const player=await prisma.player.findFirst({where:{userId:info.userId,roomId:info.roomId},orderBy:{id:"desc"}});
        if(!player){
          socket.emit("draw_error",{message:"Player not found"});
          return;
        }
        const node=await prisma.mapNode.findUnique({where:{nodeIdx:player.location}});
        if(!node||node.type!=="KEY"){
          socket.emit("draw_error",{message:"Not on key tile"});
          return;
        }
        const card=payload?.card;
        if(!card||card.id==null||!card.title){
          socket.emit("draw_error",{message:"Invalid card"});
          return;
        }
        io.to(info.roomId).emit("drawCard",{...card,userId:info.userId,playerId:player.id});
      }catch(err){
        socket.emit("draw_error",{message:"Failed to draw card"});
      }
    });

    socket.on("end_turn",async()=>{
      try{
        const userId=socket.user?.id;
        if(!userId){
          socket.emit("turn_error",{message:"Login session expired"});
          return;
        }
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("turn_error",{message:"Room not joined"});
          return;
        }
        if(rollingUserByRoom.get(info.roomId)){
          socket.emit("turn_error",{message:"Dice is still rolling"});
          return;
        }
        const currentTurnUserId=await ensureCurrentTurnUser(info.roomId);
        if(!currentTurnUserId||currentTurnUserId!==userId){
          socket.emit("turn_error",{message:"Not your turn"});
          return;
        }
        const turnState=gameLogic.turnStateByRoom.get(info.roomId);
        if(!turnState||!turnState.rolled){
          socket.emit("turn_error",{message:"Roll before ending"});
          return;
        }
        if(turnState.extraRoll){
          socket.emit("turn_error",{message:"Extra turn available"});
          return;
        }
        gameLogic.actionWindowByRoom.delete(info.roomId);
        market.clearTradeLock(info.roomId);
        await prisma.player.updateMany({where:{roomId:info.roomId,userId},data:{extraTurnUsed:false}});

        const lobbyPlayersSnapshot=Array.from(getLobbyState(info.roomId).players.values());
        const lobbyUserByPlayerId=new Map(lobbyPlayersSnapshot.map((p)=>[p.playerId,p.userId]));

        const turnResult=await prisma.$transaction(async(tx)=>{
          const room=await tx.room.findUnique({where:{id:info.roomId}});
          if(!room)throw new Error("Room not found");
          const allPlayers=await gameLogic.getLatestPlayersByUser(tx,info.roomId);
          const activePlayers=allPlayers.filter((p)=>isActiveSocketId(p.socketId));
          let players=activePlayers.length?activePlayers:allPlayers;
          if(players.length===0&&lobbyPlayersSnapshot.length){
            players=lobbyPlayersSnapshot.map((p)=>({id:p.playerId,userId:p.userId}));
          }
          if(players.length===0)throw new Error("No players in room");
          let turnOrder=gameLogic.roomTurnOrder.get(info.roomId);
          const playerIds=players.map((p)=>p.id);
          const playerIdSet=new Set(playerIds);
          if(turnOrder&&turnOrder.length){
            const filtered=turnOrder.filter((id)=>playerIdSet.has(id));
            const filteredSet=new Set(filtered);
            const missing=playerIds.filter((id)=>!filteredSet.has(id));
            turnOrder=missing.length?filtered.concat(missing):filtered;
          }
          if(!turnOrder||turnOrder.length===0){
            turnOrder=players.slice().sort((a,b)=>a.id-b.id).map((p)=>p.id);
          }
          gameLogic.roomTurnOrder.set(info.roomId,turnOrder);
          const nextIndex=(room.turnPlayerIdx+1)%turnOrder.length;
          const wrapped=nextIndex===0;
          const nextTurn=wrapped?room.currentTurn+1:room.currentTurn;
          const reachedEnd=nextTurn>room.maxTurn;
          const updateData=reachedEnd?{status:"ENDED"}:{status:"PLAYING",turnPlayerIdx:nextIndex,currentTurn:nextTurn};
          await tx.room.update({where:{id:info.roomId},data:updateData});
          const nextPlayerId=turnOrder[nextIndex];
          const nextPlayer=await tx.player.findUnique({where:{id:nextPlayerId},select:{userId:true}});
          const fallbackUserId=lobbyUserByPlayerId.get(nextPlayerId)||null;
          return{room,turnOrder,nextIndex,wrapped,nextTurn,reachedEnd,nextPlayerId,nextUserId:nextPlayer?.userId||fallbackUserId};
        });

        let warEnded=false;
        if(gameLogic.warState.active){
          gameLogic.warState.turnsLeft=Math.max(0,gameLogic.warState.turnsLeft-1);
          if(gameLogic.warState.turnsLeft<=0){
            resetWarState();
            warEnded=true;
          }
        }
        const warPayload=gameLogic.getWarPayload();
        if(warEnded){
          io.to(info.roomId).emit("war_end",warPayload);
        }

        if(turnResult.reachedEnd){
          const latestPlayers=await gameLogic.getLatestPlayersByUser(prisma,info.roomId);
          const rankings=latestPlayers
            .slice()
            .sort((a,b)=>{
              if(a.totalAsset===b.totalAsset)return 0;
              return a.totalAsset>b.totalAsset?-1:1;
            })
            .map((p)=>({playerId:p.id,totalAsset:p.totalAsset}));
          io.to(info.roomId).emit("game_end",{rankings,maxTurn:turnResult.room.maxTurn});
          return;
        }

        if(turnResult.nextUserId){
          gameLogic.currentTurnUserByRoom.set(info.roomId,turnResult.nextUserId);
          gameLogic.turnStateByRoom.set(info.roomId,{userId:turnResult.nextUserId,rolled:false,extraRoll:false});
        }else{
          gameLogic.currentTurnUserByRoom.delete(info.roomId);
          gameLogic.turnStateByRoom.delete(info.roomId);
        }

        io.to(info.roomId).emit("turn_update",{turnPlayerId:turnResult.nextPlayerId,currentTurn:turnResult.nextUserId,war:warPayload});
      }catch(err){
        socket.emit("turn_error",{message:err?.message||"Failed to end turn"});
      }
    });

    // 전쟁 전투 시작 - 승자/패자 결정 및 전리품 모달 표시
    socket.on("start_war_fight",async({opponentUserId})=>{
      const info=socketUserMap.get(socket.id);
      if(!info)return socket.emit("war_error",{message:"Not authenticated"});

      try{
        const result=await prisma.$transaction(async(tx)=>{
          const attacker=await tx.player.findFirst({where:{userId:info.userId,roomId:info.roomId},include:{assets:true}});
          const defender=await tx.player.findFirst({where:{userId:opponentUserId,roomId:info.roomId},include:{assets:true}});

          if(!attacker||!defender)throw new Error("플레이어를 찾을 수 없습니다.");

          const market=await tx.market.findUnique({where:{roomId:info.roomId}});
          if(!market)throw new Error("시장 정보를 찾을 수 없습니다.");

          // 자산 가치 계산
          const attackerAsset=gameLogic.calcWarAssetValue(attacker.assets,market,attacker.cash);
          const defenderAsset=gameLogic.calcWarAssetValue(defender.assets,market,defender.cash);

          // 승률 계산
          const winRate=gameLogic.calcWarWinRate({
            myAsset:attackerAsset,
            oppAsset:defenderAsset,
            character:attacker.character
          });

          // 승패 결정
          const roll=Math.random();
          const attackerWins=roll<winRate;

          const winnerId=attackerWins?attacker.id:defender.id;
          const loserId=attackerWins?defender.id:attacker.id;
          const winnerUserId=attackerWins?info.userId:opponentUserId;
          const loserUserId=attackerWins?opponentUserId:info.userId;

          // 패자의 땅 목록 조회
          const loserLands=await tx.gameLand.findMany({
            where:{roomId:info.roomId,ownerId:loserId}
          });

          return {
            winnerId,
            loserId,
            winnerUserId,
            loserUserId,
            winRate:winRate*100,
            attackerWins,
            loserLands:loserLands.map(l=>l.nodeIdx),
            cashPenalty:1000000 // 땅이 없을 경우 100만원
          };
        });

        // 전투 결과를 방 전체에 브로드캐스트
        io.to(info.roomId).emit("war_fight_result",{
          winnerId:result.winnerId,
          loserId:result.loserId,
          winnerUserId:result.winnerUserId,
          loserUserId:result.loserUserId,
          winRate:result.winRate,
          attackerWins:result.attackerWins,
          loserLands:result.loserLands,
          cashPenalty:result.cashPenalty
        });

      }catch(err){
        console.error("[start_war_fight] error:",err);
        socket.emit("war_error",{message:err?.message||"전쟁 처리에 실패했습니다."});
      }
    });

    // 전쟁 전리품 선택 - 땅 이전 또는 현금 이전
    socket.on("select_war_spoils",async({winnerId,loserId,landId})=>{
      const info=socketUserMap.get(socket.id);
      if(!info)return socket.emit("war_error",{message:"Not authenticated"});

      try{
        const result=await prisma.$transaction(async(tx)=>{
          const winner=await tx.player.findUnique({where:{id:winnerId}});
          const loser=await tx.player.findUnique({where:{id:loserId}});

          if(!winner||!loser)throw new Error("플레이어를 찾을 수 없습니다.");

          let landName=null;

          if(landId!==null){
            // 땅 소유권 이전
            const land=await tx.gameLand.findFirst({
              where:{roomId:info.roomId,nodeIdx:landId,ownerId:loserId}
            });

            if(!land)throw new Error("해당 땅을 찾을 수 없습니다.");

            await tx.gameLand.update({
              where:{id:land.id},
              data:{ownerId:winnerId}
            });

            const mapNode=await tx.mapNode.findUnique({where:{nodeIdx:landId}});
            landName=mapNode?.name||`땅 ${landId}`;
          }else{
            // 현금 이전 (땅이 없는 경우)
            const cashPenalty=1000000n;
            const actualPenalty=loser.cash<cashPenalty?loser.cash:cashPenalty;

            await tx.player.update({
              where:{id:loserId},
              data:{cash:loser.cash-actualPenalty}
            });

            await tx.player.update({
              where:{id:winnerId},
              data:{cash:winner.cash+actualPenalty}
            });
          }

          return {winnerId,loserId,landId,landName};
        });

        // 결과를 방 전체에 브로드캐스트
        io.to(info.roomId).emit("war_spoils_result",{
          winnerId:result.winnerId,
          loserId:result.loserId,
          landId:result.landId,
          landName:result.landName
        });

      }catch(err){
        console.error("[select_war_spoils] error:",err);
        socket.emit("war_error",{message:err?.message||"전리품 선택에 실패했습니다."});
      }
    });

    socket.on("disconnect",async()=>{
      try{
        await prisma.player.updateMany({where:{socketId:socket.id},data:{socketId:null}});
      }catch(err){}

      const info=socketUserMap.get(socket.id);
      if(!info)return;
      socketUserMap.delete(socket.id);
      const minigameState=minigameStateByRoom.get(info.roomId);
      if(minigameState&&minigameState.phase==="GAME"){
        const player=minigameState.players.find((p)=>p.userId===info.userId);
        if(player&&!player.isDropped){
          player.isDropped=true;
          const aliveCount=minigameState.players.filter((p)=>!p.isDropped).length;
          if(aliveCount<=1){
            endMinigame(info.roomId);
          }else{
            broadcastMinigame(info.roomId);
          }
        }
      }
      const lobby=getLobbyState(info.roomId);
      lobby.players.delete(info.userId);
      lobby.readyUserIds.delete(info.userId);
      if(lobby.hostUserId===info.userId){
        const nextHost=lobby.players.keys().next();
        lobby.hostUserId=nextHost.done?null:nextHost.value;
      }
      if(rollingUserByRoom.get(info.roomId)===info.userId){
        rollingUserByRoom.delete(info.roomId);
      }
      if(lobby.players.size===0){
        lobbyStateByRoom.delete(info.roomId);
        gameLogic.roomTurnOrder.delete(info.roomId);
        gameLogic.currentTurnUserByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.delete(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        market.clearTradeLock(info.roomId);
        rollingUserByRoom.delete(info.roomId);
        orderPickingByRoom.delete(info.roomId);
        resetWarState();
        return;
      }
      io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
    });
  });

  return{getLobbyState,buildLobbyPayload,socketUserMap,lobbyStateByRoom};
}

module.exports={initSocketHandlers};
