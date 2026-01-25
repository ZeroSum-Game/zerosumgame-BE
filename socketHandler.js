function initSocketHandlers({io,prisma,auth,gameLogic,market}){
  const lobbyStateByRoom=new Map();
  const socketUserMap=new Map();

  io.use((socket,next)=>{
    try{
      const token=socket.handshake.auth?.token;
      if(!token)return next(new Error("Unauthorized"));
      const user=auth.verifySocketToken(token);
      socket.user=user;
      return next();
    }catch(e){
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
    // 모든 플레이어(방장 포함)가 준비되었는지 체크
    const allReady=players.length>0&&players.every((p)=>p.ready);
    return{hostUserId:lobby.hostUserId,players,allReady};
  }

  function shuffleArray(arr){
    for(let i=arr.length-1;i>0;i-=1){
      const j=Math.floor(Math.random()*(i+1));
      [arr[i],arr[j]]=[arr[j],arr[i]];
    }
    return arr;
  }
  function resetWarState(){
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
    const players=await getActivePlayersByUser(roomId);
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
    return{turnPlayerId,currentTurn,turnOrder,turnOrderPlayerIds,players:playersPayload};
  }

  io.on("connection",(socket)=>{
    console.log(`User connected: ${socket.id}`);

    socket.on("join_room",async(roomId)=>{
      try{
        const sessionUserId=socket.user?.id;
        console.log(`[join_room] User ${sessionUserId} attempting to join room ${roomId}`);
        if(!sessionUserId){
          socket.emit("join_error",{message:"User session not found"});
          return;
        }
        let room=await prisma.room.findUnique({where:{id:roomId}});
        if(!room){
          console.log(`[join_room] Room ${roomId} not found, creating...`);
          room=await prisma.room.create({data:{id:roomId,roomCode:"MAIN",status:"WAITING"}});
        }
        if(room.status==="PLAYING"){
          const activePlayers=await getActivePlayersByUser(roomId);
          if(activePlayers.length===0){
            room=await prisma.room.update({where:{id:roomId},data:{status:"WAITING",turnPlayerIdx:0,currentTurn:1}});
            gameLogic.currentTurnUserByRoom.delete(roomId);
            gameLogic.roomTurnOrder.delete(roomId);
            market.clearTradeLock(roomId);
            gameLogic.actionWindowByRoom.delete(roomId);
            gameLogic.turnStateByRoom.delete(roomId);
            resetWarState();
          }
        }
        const lobbyState=getLobbyState(roomId);
        // 인원 제한 체크 (최대 4명, 이미 있는 유저는 제외)
        const MAX_PLAYERS=4;
        if(!lobbyState.players.has(sessionUserId)&&lobbyState.players.size>=MAX_PLAYERS){
          socket.emit("join_error",{message:`방이 가득 찼습니다 (최대 ${MAX_PLAYERS}명)`});
          console.log(`[join_room] Room ${roomId} is full (${lobbyState.players.size}/${MAX_PLAYERS})`);
          return;
        }
        if(room.status==="ENDED"&&lobbyState.players.size===0){
          room=await prisma.room.update({where:{id:roomId},data:{status:"WAITING",turnPlayerIdx:0,currentTurn:1}});
          gameLogic.currentTurnUserByRoom.delete(roomId);
          gameLogic.roomTurnOrder.delete(roomId);
          market.clearTradeLock(roomId);
          gameLogic.actionWindowByRoom.delete(roomId);
          gameLogic.turnStateByRoom.delete(roomId);
          resetWarState();
        }
        const user=await prisma.user.findUnique({where:{id:sessionUserId}});
        let player=await prisma.player.findFirst({where:{roomId,userId:sessionUserId},orderBy:{id:"desc"},include:{assets:true}});
        if(!player){
          player=await prisma.player.create({
            data:{
              roomId,
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
        if(room.status==="WAITING"&&player.character){
          player=await prisma.player.update({where:{id:player.id},data:{character:null},include:{assets:true}});
        }
        if(room.status==="PLAYING"){
          await syncLobbyPlayers(roomId);
          if(!gameLogic.roomTurnOrder.get(roomId)){
            const activePlayers=await getActivePlayersByUser(roomId);
            const fallbackOrder=activePlayers.slice().sort((a,b)=>a.id-b.id).map((p)=>p.id);
            if(fallbackOrder.length)gameLogic.roomTurnOrder.set(roomId,fallbackOrder);
          }
        }
        socket.join(roomId);
        socketUserMap.set(socket.id,{roomId,userId:sessionUserId});
        const lobby=getLobbyState(roomId);
        lobby.players.set(sessionUserId,{userId:sessionUserId,nickname:user?.nickname||`Player${sessionUserId}`,playerId:player.id,character:player.character});
        if(!lobby.hostUserId)lobby.hostUserId=sessionUserId;
        const turnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,roomId));
        const marketData=await prisma.$transaction(async(tx)=>market.getOrCreateMarket(tx,roomId));
        const lobbyPayload=buildLobbyPayload(roomId);
        console.log(`[join_room] User ${sessionUserId} joined room ${roomId}. Total players: ${lobbyPayload.players.length}`);
        console.log(`[join_room] Players in room:`,lobbyPayload.players.map(p=>`${p.nickname}(${p.userId})`).join(", "));
        socket.emit("join_success",{roomId,message:"Join success",player,turnPlayerId,war:gameLogic.getWarPayload(),roomStatus:room.status,lobby:lobbyPayload,currentTurn:gameLogic.currentTurnUserByRoom.get(roomId)||null});
        socket.emit("market_update",{samsung:marketData.priceSamsung,tesla:marketData.priceTesla,lockheed:marketData.priceLockheed,gold:marketData.priceGold,bitcoin:marketData.priceBtc,prevSamsung:marketData.prevSamsung,prevTesla:marketData.prevTesla,prevLockheed:marketData.prevLockheed,prevGold:marketData.prevGold,prevBtc:marketData.prevBtc});
        socket.emit("war_state",gameLogic.getWarPayload());
        io.to(roomId).emit("lobby_update",lobbyPayload);
        await gameLogic.emitAssetUpdate(player.id);
        if(room.status==="PLAYING"){
          const resumePayload=await buildResumePayload(roomId);
          socket.emit("game_start",resumePayload);
        }
      }catch(e){
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
          if(entry)entry.character=player.character||null;
          if(player.character)io.to(info.roomId).emit("character_update",{playerId:player.id,userId:info.userId,character:player.character});
        }
        console.log(`[set_ready] User ${info.userId} ready: ${isReady}`);
        io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
      }catch(e){}
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
        const currentTurn=gameLogic.currentTurnUserByRoom.get(info.roomId);
        if(currentTurn&&currentTurn!==userId){
          socket.emit("turn_error",{message:"Not your turn"});
          return;
        }
        const room=await prisma.room.findUnique({where:{id:info.roomId}});
        if(!room)throw new Error("Room not found");
        if(room.status!=="PLAYING")throw new Error("Game not started");
        const turnState=gameLogic.turnStateByRoom.get(info.roomId);
        if(!turnState||turnState.userId!==userId||!turnState.rolled||turnState.extraRoll)throw new Error("Roll extra turn before ending");
        const order=gameLogic.roomTurnOrder.get(info.roomId);
        const players=order&&order.length?order:(await getActivePlayersByUser(info.roomId)).map((p)=>p.id);
        if(players.length===0)throw new Error("Player count is zero");
        const nextIdx=(room.turnPlayerIdx+1)%players.length;
        await prisma.player.updateMany({where:{roomId:info.roomId,userId},data:{extraTurnUsed:false}});
        const nextTurnNumber=(room.currentTurn||1)+1;
        if(nextTurnNumber>(room.maxTurn||10)){
          const lobbyPlayers=getLobbyState(info.roomId).players;
          const activeUserIds=new Set(lobbyPlayers?Array.from(lobbyPlayers.keys()):[]);
          const latestPlayers=await gameLogic.getLatestPlayersByUser(prisma,info.roomId);
          const activePlayers=activeUserIds.size?latestPlayers.filter((p)=>activeUserIds.has(p.userId)):latestPlayers;
          const rankings=[];
          const users=await prisma.user.findMany({where:{id:{in:activePlayers.map((p)=>p.userId)}},select:{id:true,nickname:true}});
          const nickMap=new Map(users.map((u)=>[u.id,u.nickname]));
          for(const p of activePlayers){
            const totals=await prisma.$transaction(async(tx)=>gameLogic.computeTotals(tx,p.id));
            rankings.push({userId:p.userId,playerId:p.id,nickname:nickMap.get(p.userId)||`Player${p.userId}`,totalAsset:totals.totalAsset,cash:totals.player.cash});
          }
          rankings.sort((a,b)=>Number(b.totalAsset-a.totalAsset));
          await prisma.room.update({where:{id:info.roomId},data:{status:"ENDED",currentTurn:nextTurnNumber}});
          gameLogic.currentTurnUserByRoom.delete(info.roomId);
          market.clearTradeLock(info.roomId);
          gameLogic.actionWindowByRoom.delete(info.roomId);
          gameLogic.turnStateByRoom.delete(info.roomId);
          resetWarState();
          io.to(info.roomId).emit("game_end",{rankings,maxTurn:room.maxTurn||10});
          return;
        }
        await prisma.room.update({where:{id:info.roomId},data:{turnPlayerIdx:nextIdx,currentTurn:nextTurnNumber}});
        const nextTurnPlayerId=await prisma.$transaction(async(tx)=>gameLogic.getTurnPlayerId(tx,info.roomId));
        let nextTurnUserId=null;
        if(nextTurnPlayerId){
          const p=await prisma.player.findUnique({where:{id:nextTurnPlayerId}});
          nextTurnUserId=p?.userId||null;
        }
        gameLogic.currentTurnUserByRoom.set(info.roomId,nextTurnUserId);
        market.clearTradeLock(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.set(info.roomId,{userId:nextTurnUserId,rolled:false,extraRoll:false});
        if(gameLogic.warState.active){
          gameLogic.warState.turnsLeft-=1;
          if(gameLogic.warState.turnsLeft<=0){
            gameLogic.warState.active=false;
            gameLogic.warState.recoveryActive=true;
          }
        }else if(gameLogic.warState.recoveryActive){
          gameLogic.warState.recoveryLine=Math.min(1,Math.round((gameLogic.warState.recoveryLine+0.1)*100)/100);
          gameLogic.warState.recoveryNode=Math.min(1,Math.round((gameLogic.warState.recoveryNode+0.1)*100)/100);
          if(gameLogic.warState.recoveryLine>=1&&gameLogic.warState.recoveryNode>=1){
            gameLogic.warState.recoveryActive=false;
            gameLogic.warState.warLine=null;
            gameLogic.warState.warNode=null;
          }
        }
        io.to(info.roomId).emit("turn_update",{currentTurn:nextTurnUserId,turnPlayerId:nextTurnPlayerId,war:gameLogic.getWarPayload()});
      }catch(e){
        socket.emit("turn_error",{message:e?.message||"Failed to end turn"});
      }
    });

    socket.on("start_game",async()=>{
      try{
        const info=socketUserMap.get(socket.id);
        if(!info){
          socket.emit("start_error",{message:"Room not joined"});
          return;
        }
        const lobby=getLobbyState(info.roomId);
        if(lobby.hostUserId!==info.userId){
          socket.emit("start_error",{message:"Only host can start"});
          return;
        }
        const payload=buildLobbyPayload(info.roomId);
        if(!payload.allReady){
          socket.emit("start_error",{message:"All players must be ready"});
          return;
        }
        const lobbyPlayers=getLobbyState(info.roomId).players;
        const activeUserIds=new Set(lobbyPlayers?Array.from(lobbyPlayers.keys()):[]);
        const allPlayers=await gameLogic.getLatestPlayersByUser(prisma,info.roomId);
        const players=activeUserIds.size?allPlayers.filter((p)=>activeUserIds.has(p.userId)):allPlayers;
        if(players.length===0){
          socket.emit("start_error",{message:"No players"});
          return;
        }
        if(players.some((p)=>!p.character)){
          socket.emit("start_error",{message:"All players must select a character"});
          return;
        }
        const shuffled=shuffleArray(players.slice());
        const orderPlayerIds=shuffled.map((p)=>p.id);
        const orderUserIds=shuffled.map((p)=>p.userId);
        gameLogic.roomTurnOrder.set(info.roomId,orderPlayerIds);
        const currentTurn=orderUserIds[0]||null;
        gameLogic.currentTurnUserByRoom.set(info.roomId,currentTurn);
        market.clearTradeLock(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.set(info.roomId,{userId:currentTurn,rolled:false,extraRoll:false});
        await prisma.room.update({where:{id:info.roomId},data:{status:"PLAYING",turnPlayerIdx:0,currentTurn:1}});
        await prisma.$transaction(async(tx)=>market.resetMarketDefaults(tx,info.roomId));
        const turnPlayerId=orderPlayerIds[0]||null;
        const lobbyInfo=buildLobbyPayload(info.roomId);
        const nicknameByUser=new Map(lobbyInfo.players.map((p)=>[p.userId,p.nickname]));
        const playersPayload=players.map((p)=>({playerId:p.id,userId:p.userId,nickname:nicknameByUser.get(p.userId)||`Player${p.userId}`,character:p.character||null,location:typeof p.location==="number"?p.location:0}));
        console.log(`[System] Game Started. Turn Order: [${orderUserIds.join(", ")}]`);
        io.to(info.roomId).emit("game_start",{turnPlayerId,currentTurn,turnOrder:orderUserIds,turnOrderPlayerIds:orderPlayerIds,players:playersPayload});
        io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
      }catch(e){
        socket.emit("start_error",{message:"Failed to start game"});
      }
    });

    socket.on("roll_dice",async()=>{
      console.log("roll_dice received",socket.id);
      try{
        const userId=socket.user?.id;
        if(!userId){
          socket.emit("roll_error",{message:"Login session expired"});
          console.log("emit failed: login session expired");
          return;
        }
        const result=await gameLogic.rollDiceForUser({userId});
        const userRecord=await prisma.user.findUnique({where:{id:userId},select:{nickname:true}});
        const userName=userRecord?.nickname||"Player";
        console.log(`[${userName}] moved ${result.oldLocation} -> ${result.newLocation}`);
        io.to(result.roomId).emit("dice_rolled",{userId,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,player:result.player,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
        io.to(result.roomId).emit("playerMove",{userId,playerId:result.player.id,character:result.player.character,oldLocation:result.oldLocation,newLocation:result.newLocation,dice1:result.dice1,dice2:result.dice2,isDouble:result.isDouble,hasExtraTurn:result.hasExtraTurn,passedStart:result.passedStart,turnPlayerId:result.turnPlayerId,turnUserId:result.turnUserId,autoSellEvents:result.autoSellEvents});
        if(result.cardEvent){
          io.to(result.roomId).emit("drawCard",result.cardEvent);
        }
        if(result.market){
          io.to(result.roomId).emit("market_update",{samsung:result.market.priceSamsung,tesla:result.market.priceTesla,lockheed:result.market.priceLockheed,gold:result.market.priceGold,bitcoin:result.market.priceBtc,prevSamsung:result.market.prevSamsung,prevTesla:result.market.prevTesla,prevLockheed:result.market.prevLockheed,prevGold:result.market.prevGold,prevBtc:result.market.prevBtc});
        }
        if(result.war){
          io.to(result.roomId).emit("war_state",result.war);
          if(result.warStarted){
            io.to(result.roomId).emit("war_start",result.war);
          }
          if(result.warEnded){
            io.to(result.roomId).emit("war_end",result.war);
          }
        }
        await gameLogic.emitAssetUpdate(result.player.id);
        if(result.tollOwnerId)await gameLogic.emitAssetUpdate(result.tollOwnerId);
        console.log("emit success: true");
      }catch(e){
        socket.emit("roll_error",{message:e?.message||"Failed to roll dice"});
        console.log("emit failed",e?.message||e);
      }
    });

    socket.on("disconnect",async()=>{
      // DB에 socketId가 남아있으면 REST API에서 "active"로 오인해서
      // 캐릭터 중복 체크가 잘못 동작할 수 있어 disconnect 시 정리합니다.
      try{
        await prisma.player.updateMany({where:{socketId:socket.id},data:{socketId:null}});
      }catch(e){
        console.log("[disconnect] Failed to clear socketId: "+(e?.message||e));
      }

      const info=socketUserMap.get(socket.id);
      if(!info)return;
      socketUserMap.delete(socket.id);
      const lobby=getLobbyState(info.roomId);
      lobby.players.delete(info.userId);
      lobby.readyUserIds.delete(info.userId);
      if(lobby.hostUserId===info.userId){
        const nextHost=lobby.players.keys().next();
        lobby.hostUserId=nextHost.done?null:nextHost.value;
      }
      if(lobby.players.size===0){
        lobbyStateByRoom.delete(info.roomId);
        gameLogic.roomTurnOrder.delete(info.roomId);
        gameLogic.currentTurnUserByRoom.delete(info.roomId);
        gameLogic.turnStateByRoom.delete(info.roomId);
        gameLogic.actionWindowByRoom.delete(info.roomId);
        market.clearTradeLock(info.roomId);
        resetWarState();
        return;
      }
      io.to(info.roomId).emit("lobby_update",buildLobbyPayload(info.roomId));
    });
  });

  return{getLobbyState,buildLobbyPayload,socketUserMap,lobbyStateByRoom};
}

module.exports={initSocketHandlers};
