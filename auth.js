const passport=require("passport");
const GoogleStrategy=require("passport-google-oauth20").Strategy;
const jwt=require("jsonwebtoken");

const JWT_SECRET=process.env.JWT_SECRET||process.env.SESSION_SECRET||"secret";
const JWT_EXPIRES_IN=process.env.JWT_EXPIRES_IN||"7d";

function signToken(user){
  return jwt.sign({id:user.id,nickname:user.nickname},JWT_SECRET,{expiresIn:JWT_EXPIRES_IN});
}

function initAuth(app,prisma,options={}){
  const onLogin=options.onLogin;
  const callbackURL =
    process.env.GOOGLE_CALLBACK_URL ||
    "http://ec2-3-37-103-167.ap-northeast-2.compute.amazonaws.com:3000/api/auth/google/callback";
  passport.use(new GoogleStrategy({
    clientID:process.env.GOOGLE_CLIENT_ID,
    clientSecret:process.env.GOOGLE_CLIENT_SECRET,
    callbackURL
  },async(accessToken,refreshToken,profile,done)=>{
    try{
      const googleId=profile.id;
      const email=profile.emails?.[0]?.value;
      const displayName=profile.displayName;
      if(!googleId||!email||!displayName)return done(new Error("Missing required Google profile fields"));
      const user=await prisma.user.upsert({
        where:{googleId},
        update:{email,nickname:displayName},
        create:{googleId,email,nickname:displayName,totalWins:0,totalGames:0}
      });
      return done(null,user);
    }catch(err){
      return done(err);
    }
  }));

  app.use(passport.initialize());

  app.get("/auth/google",passport.authenticate("google",{scope:["profile","email"],session:false}));
  app.get("/api/auth/google/callback",passport.authenticate("google",{failureRedirect:"/",session:false}),async(req,res)=>{
    try{
      if(onLogin)await onLogin(req.user);
      const token=signToken(req.user);
      res.redirect(`/?token=${encodeURIComponent(token)}`);
    }catch(e){
      res.redirect("/");
    }
  });

  app.get("/api/auth/logout",(req,res)=>{
    res.json({ok:true});
  });
}

function getTokenFromReq(req){
  const header=req.headers.authorization||"";
  if(header.startsWith("Bearer "))return header.slice(7);
  if(req.query?.token)return String(req.query.token);
  return null;
}

function requireAuth(req,res,next){
  const token=getTokenFromReq(req);
  if(!token)return res.status(401).json({error:"Unauthorized"});
  try{
    req.user=jwt.verify(token,JWT_SECRET);
    return next();
  }catch(e){
    return res.status(401).json({error:"Unauthorized"});
  }
}

function verifySocketToken(token){
  return jwt.verify(token,JWT_SECRET);
}

module.exports={initAuth,requireAuth,verifySocketToken,signToken};
