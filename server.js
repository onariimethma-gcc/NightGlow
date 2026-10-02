
"use strict";
require("dotenv").config();

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const initSqlJs = require("sql.js");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 5000);
const DB_PATH = path.resolve(process.env.DB_PATH || path.join(ROOT, "data", "nightline.sqlite"));
const UPLOAD_DIR = path.resolve(process.env.UPLOAD_DIR || path.join(ROOT, "uploads"));
const MAX_UPLOAD_MB = Math.min(Math.max(Number(process.env.MAX_UPLOAD_MB || 200), 1), 500);
const APP_NAME = "NighGlow";
const MIN_AGE = 12;
const RETENTION_MIN_MINUTES = 48*60;   // 48 hours
const RETENTION_MAX_MINUTES = 120*60;  // 120 hours
const SESSION_TTL_DAYS = 7;

for (const p of [path.dirname(DB_PATH), UPLOAD_DIR]) fs.mkdirSync(p, {recursive:true});

const app = express();
app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(helmet({
  crossOriginResourcePolicy:{policy:"same-origin"},
  contentSecurityPolicy:{
    directives:{
      defaultSrc:["'self'"],
      scriptSrc:["'self'"],
      styleSrc:["'self'","'unsafe-inline'","https://fonts.googleapis.com"],
      imgSrc:["'self'","data:","blob:"],
      mediaSrc:["'self'","blob:"],
      connectSrc:["'self'"],
      fontSrc:["'self'","data:","https://fonts.gstatic.com"],
      objectSrc:["'none'"],
      baseUri:["'self'"],
      frameAncestors:["'none'"]
    }
  }
}));
app.use(express.json({limit:"1mb"}));
app.use(express.urlencoded({extended:false,limit:"1mb"}));

const generalLimiter = rateLimit({windowMs:60000,limit:240,standardHeaders:true,legacyHeaders:false});
const authLimiter = rateLimit({windowMs:15*60000,limit:25,standardHeaders:true,legacyHeaders:false});
const aiLimiter = rateLimit({windowMs:60000,limit:Number(process.env.AI_MAX_REQUESTS_PER_MINUTE||10),standardHeaders:true,legacyHeaders:false});
app.use(generalLimiter);

let db;
let SQL;
let saveTimer = null;
let saveInProgress = false;
let saveAgain = false;

function iso(){return new Date().toISOString();}
function token(n=32){return crypto.randomBytes(n).toString("hex");}

function saveDbNow(){
  if(!db) return;
  if(saveInProgress){saveAgain=true;return;}
  saveInProgress=true;
  try{
    fs.mkdirSync(path.dirname(DB_PATH),{recursive:true});
    fs.writeFileSync(DB_PATH,Buffer.from(db.export()));
    db.run("PRAGMA foreign_keys=ON"); // sql.js resets this after export()
  } finally {
    saveInProgress=false;
    if(saveAgain){saveAgain=false;saveDbNow();}
  }
}
function scheduleSave(){
  clearTimeout(saveTimer);
  saveTimer=setTimeout(saveDbNow,300);
}
function rows(sql, params=[]){
  const s=db.prepare(sql); const out=[];
  try{s.bind(params);while(s.step())out.push(s.getAsObject());}finally{s.free();}
  return out;
}
function row(sql,params=[]){return rows(sql,params)[0]||null;}
function run(sql,params=[]){db.run(sql,params);scheduleSave();}
function exec(sql){db.exec(sql);scheduleSave();}

function cookies(req){
  const out={};
  for(const x of String(req.headers.cookie||"").split(";")){
    const i=x.indexOf("="); if(i<1)continue;
    out[x.slice(0,i).trim()]=decodeURIComponent(x.slice(i+1).trim());
  }
  return out;
}
function userFromReq(req){
  const t=cookies(req).nightline_session;
  if(!t)return null;
  return row(`SELECT u.id,u.username,s.expires_at FROM sessions s JOIN users u ON u.id=s.user_id
              WHERE s.token=? AND s.expires_at>?`,[t,iso()]);
}
function requireUser(req,res,next){
  const u=userFromReq(req);
  if(!u)return res.status(401).json({error:"Your session has expired. Please sign in again."});
  req.user={id:Number(u.id),username:u.username};
  next();
}
function setSession(res,userId){
  const t=token(), exp=new Date(Date.now()+SESSION_TTL_DAYS*86400000).toISOString();
  run("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)",[t,userId,exp]);
  res.setHeader("Set-Cookie",`nightline_session=${encodeURIComponent(t)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_DAYS*86400}`);
}
function clearSession(req,res){
  const t=cookies(req).nightline_session;
  if(t)run("DELETE FROM sessions WHERE token=?",[t]);
  res.setHeader("Set-Cookie","nightline_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}
function age(dob){
  const d=new Date(dob+"T00:00:00");
  if(Number.isNaN(d.getTime()))return -1;
  const n=new Date(); let a=n.getFullYear()-d.getFullYear();
  if(n.getMonth()<d.getMonth() || (n.getMonth()===d.getMonth()&&n.getDate()<d.getDate()))a--;
  return a;
}
function member(roomId,userId){
  return !!row("SELECT 1 FROM room_members WHERE room_id=? AND user_id=?",[roomId,userId]);
}
function getRoom(id){return row("SELECT id,name,owner_id,created_at,expires_at FROM rooms WHERE id=? AND expires_at>?",[id,iso()]);}
// alpha = the room's creator (main owner) · admin = promoted by alpha · member
function roleOf(room,userId){
  if(!room||!member(room.id,userId))return null;
  if(Number(room.owner_id)===Number(userId))return "alpha";
  const m=row("SELECT role FROM room_members WHERE room_id=? AND user_id=?",[room.id,userId]);
  return m&&m.role==="admin"?"admin":"member";
}
function roomMembers(room){
  return rows(`SELECT u.id,u.username,m.role FROM room_members m JOIN users u ON u.id=m.user_id
    WHERE m.room_id=? ORDER BY u.username COLLATE NOCASE`,[room.id]).map(x=>({
      id:Number(x.id),username:x.username,
      role:Number(x.id)===Number(room.owner_id)?"alpha":(x.role==="admin"?"admin":"member")
    }));
}
function removeFiles(roomId){
  for(const f of rows("SELECT attachment_path FROM messages WHERE room_id=? AND attachment_path IS NOT NULL",[roomId])){
    try{fs.unlinkSync(path.join(UPLOAD_DIR,path.basename(f.attachment_path)))}catch{}
  }
}
function deleteRoom(roomId){
  removeFiles(roomId);
  // explicit deletes: do not rely on ON DELETE CASCADE
  run("DELETE FROM messages WHERE room_id=?",[roomId]);
  run("DELETE FROM room_members WHERE room_id=?",[roomId]);
  run("DELETE FROM room_bans WHERE room_id=?",[roomId]);
  run("DELETE FROM rooms WHERE id=?",[roomId]);
}
function isBanned(roomId,userId){return !!row("SELECT 1 FROM room_bans WHERE room_id=? AND user_id=?",[roomId,userId]);}
function safeName(s){return String(s||"").trim().replace(/[^\w.\- ]/g,"_").slice(0,120)||"file";}

function cleanup(){
  for(const r of rows("SELECT id FROM rooms WHERE expires_at<=?",[iso()]))deleteRoom(r.id);
  run("DELETE FROM sessions WHERE expires_at<=?",[iso()]);
}

const upload=multer({
  storage:multer.diskStorage({
    destination:(_r,_f,cb)=>cb(null,UPLOAD_DIR),
    filename:(_r,f,cb)=>cb(null,`${Date.now()}-${token(8)}${path.extname(f.originalname).toLowerCase()}`)
  }),
  limits:{fileSize:MAX_UPLOAD_MB*1024*1024},
  fileFilter:(_r,f,cb)=>{
    const allowed=new Set([
      "image/png","image/jpeg","image/gif","image/webp","application/pdf","application/zip",
      "video/mp4","video/webm","video/quicktime","video/x-matroska","video/x-m4v",
      "audio/ogg","audio/mpeg","audio/wav","audio/x-wav"
    ]);
    cb(null,allowed.has(f.mimetype));
  }
});

// ---------------------------------------------------------------- AI providers
// Each provider is asked for the largest reply its model allows (verified Oct 2026):
//   Groq openai/gpt-oss-120b ........ 65,536 completion tokens
//   Gemini 3.8 Flash ................ 65,536 output tokens
//   OpenRouter openai/gpt-oss-120b .. 131,072 output tokens
// If a provider's free quota/credits can't cover that, the request is retried with the
// biggest size it will accept (see smallerCap), so replies are never blocked by the cap.
const num=(v,d)=>{const n=Number(v);return Number.isFinite(n)&&n>0?Math.floor(n):d;};
const AI_PROVIDERS={
  groq:{label:"Groq",key:process.env.GROQ_API_KEY||"",model:process.env.GROQ_MODEL||"openai/gpt-oss-120b",
        maxTokens:num(process.env.GROQ_MAX_TOKENS,65536),keyName:"GROQ_API_KEY"},
  gemini:{label:"Gemini",key:process.env.GEMINI_API_KEY||"",model:process.env.GEMINI_MODEL||"gemini-3.8-flash",
        maxTokens:num(process.env.GEMINI_MAX_TOKENS,65536),keyName:"GEMINI_API_KEY"},
  openrouter:{label:"OpenRouter",key:process.env.OPENROUTER_API_KEY||"",model:process.env.OPENROUTER_MODEL||"openai/gpt-oss-120b",
        maxTokens:num(process.env.OPENROUTER_MAX_TOKENS,131072),keyName:"OPENROUTER_API_KEY"}
};
const AI_TIMEOUT_MS=180000;

const AI_SYSTEM=`You are {NAME}, an AI assistant inside the ${APP_NAME} group chat.
Format every answer as plain text made of short paragraphs and, where it helps, bullet points (lines starting with "- ") or numbered points ("1.", "2.").
Never use tables or pipe-separated columns - put comparisons into bullet points instead.
Do not use markdown headings (#). You may use **bold** sparingly for key terms and \`code\` for code.
Be complete and accurate, but well organised and easy to read on a phone.`;

// Safety net: if a model still returns a markdown table, turn it into bullet points.
function stripTables(text){
  const isRow=l=>/^\s*\|.*\|\s*$/.test(l);
  const lines=String(text).split("\n"),out=[];
  for(let i=0;i<lines.length;i++){
    if(!isRow(lines[i])){out.push(lines[i]);continue;}
    const block=[];
    while(i<lines.length&&isRow(lines[i])){block.push(lines[i]);i++;}
    i--;
    const cells=block.filter(b=>!/^\s*\|?[\s:\-|]+\|?\s*$/.test(b))
      .map(b=>b.trim().replace(/^\||\|$/g,"").split("|").map(c=>c.trim()));
    const header=cells.length>1?cells.shift():null;
    for(const r of cells){
      const first=r[0]||"";
      const rest=r.slice(1).map((c,k)=>c?(header&&header[k+1]?`${header[k+1]}: ${c}`:c):"").filter(Boolean);
      out.push(`- ${first}${rest.length?" - "+rest.join("; "):""}`);
    }
  }
  return out.join("\n");
}

// When a provider says "too many tokens requested", work out a cap it will accept.
function smallerCap(msg,cap){
  msg=String(msg||"");let n=null,m;
  if((m=msg.match(/can only afford (\d+)/i)))n=Number(m[1])-16;                      // OpenRouter credits
  else if((m=msg.match(/Limit (\d+),\s*Requested (\d+)/i)))n=cap-(Number(m[2])-Number(m[1]))-64; // Groq TPM
  else if(/token|too large|context length/i.test(msg))n=Math.floor(cap/4);
  return n&&n>=512&&n<cap?n:null;
}

async function postJson(url,headers,body){
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),AI_TIMEOUT_MS);
  try{
    const r=await fetch(url,{method:"POST",headers:{"Content-Type":"application/json",...headers},body:JSON.stringify(body),signal:controller.signal});
    const data=await r.json().catch(()=>({}));
    return {ok:r.ok,status:r.status,data};
  }catch(e){
    if(e.name==="AbortError")throw new Error("The AI took too long to answer. Try a shorter question.");
    throw e;
  }finally{clearTimeout(timer);}
}

async function ai(provider,prompt){
  const p=AI_PROVIDERS[provider];
  if(!p.key)throw new Error(`${p.label} isn't set up yet - add ${p.keyName} on the server.`);
  const system=AI_SYSTEM.replace("{NAME}",p.label);
  let cap=p.maxTokens,lastMsg="";
  for(let attempt=0;attempt<3;attempt++){
    let res,text="";
    if(provider==="gemini"){
      res=await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`,
        {"x-goog-api-key":p.key},
        {systemInstruction:{parts:[{text:system}]},contents:[{role:"user",parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:cap}});
      if(res.ok){
        const c=res.data?.candidates?.[0];
        text=(c?.content?.parts||[]).filter(x=>!x.thought).map(x=>x.text||"").join("").trim();
        if(!text){
          const why=res.data?.promptFeedback?.blockReason||c?.finishReason;
          throw new Error(why?`Gemini returned no answer (${why}). Try rephrasing your question.`:"Gemini returned no answer.");
        }
      }
    }else{
      const endpoint=provider==="groq"?"https://api.groq.com/openai/v1/chat/completions":"https://openrouter.ai/api/v1/chat/completions";
      const headers={Authorization:`Bearer ${p.key}`};
      if(provider==="openrouter"){
        headers["HTTP-Referer"]=process.env.OPENROUTER_SITE_URL||"http://localhost:"+PORT;
        headers["X-Title"]=process.env.OPENROUTER_APP_NAME||APP_NAME;
      }
      const body={model:p.model,temperature:.7,messages:[{role:"system",content:system},{role:"user",content:prompt}]};
      body[provider==="groq"?"max_completion_tokens":"max_tokens"]=cap;
      res=await postJson(endpoint,headers,body);
      if(res.ok){
        text=String(res.data?.choices?.[0]?.message?.content||"").trim();
        if(!text)throw new Error(`${p.label} returned no answer. Try rephrasing your question.`);
      }
    }
    if(res.ok)return stripTables(text);
    lastMsg=res.data?.error?.message||(typeof res.data?.error==="string"?res.data.error:"")||`${p.label} returned HTTP ${res.status}`;
    const next=[400,402,413,429].includes(res.status)?smallerCap(lastMsg,cap):null;
    if(!next)break;
    cap=next;
  }
  if(/quota|rate.?limit|resource.?exhausted|too many requests/i.test(lastMsg))
    throw new Error(`${p.label} is busy or its free quota is used up for now. Please try again in a minute.`);
  throw new Error(lastMsg.slice(0,300));
}

app.get("/healthz",(_q,s)=>s.json({ok:true}));
app.get("/api/me",(req,res)=>{
  const u=userFromReq(req);
  res.json(u?{authenticated:true,userId:Number(u.id),username:u.username}:{authenticated:false});
});

app.post("/api/signin",authLimiter,(req,res)=>{
  const username=String(req.body.username||"").trim();
  const dob=String(req.body.dob||"").trim();
  if(!/^[A-Za-z0-9_.-]{2,32}$/.test(username))return res.status(400).json({error:"Username must be 2–32 letters, numbers, dots, underscores or hyphens."});
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dob))return res.status(400).json({error:"Please enter a valid date of birth."});
  const a=age(dob);
  if(a<MIN_AGE)return res.status(400).json({error:`You must be at least ${MIN_AGE} years old.`});
  let u=row("SELECT id,username,dob FROM users WHERE username=?",[username]);
  if(u&&u.dob!==dob)return res.status(401).json({error:"That username is already registered with a different date of birth."});
  if(!u){run("INSERT INTO users(username,dob,created_at) VALUES(?,?,?)",[username,dob,iso()]);u=row("SELECT id,username FROM users WHERE username=?",[username]);}
  setSession(res,Number(u.id)); res.json({ok:true,userId:Number(u.id),username:u.username});
});
app.post("/api/logout",(req,res)=>{clearSession(req,res);res.json({ok:true});});

app.get("/api/rooms",requireUser,(req,res)=>{
  cleanup();
  res.json({rooms:rows(`SELECT r.id,r.name,r.owner_id,r.created_at,r.expires_at,
      EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=?) AS joined,
      u.username owner_username
      FROM rooms r JOIN users u ON u.id=r.owner_id
      WHERE r.expires_at>? AND (r.owner_id=? OR EXISTS(SELECT 1 FROM room_members m WHERE m.room_id=r.id AND m.user_id=?))
      ORDER BY r.id DESC`,[req.user.id,iso(),req.user.id,req.user.id])});
});

app.post("/api/rooms",requireUser,async(req,res)=>{
  const name=String(req.body.name||"").trim(), pw=String(req.body.password||"");
  if(!/^[A-Za-z0-9 _.\-]{2,80}$/.test(name))return res.status(400).json({error:"Room name must be 2–80 characters."});
  if(pw.length<4||pw.length>200)return res.status(400).json({error:"Room password must be 4–200 characters."});
  const exists=row("SELECT id FROM rooms WHERE lower(name)=lower(?) AND expires_at>?",[name,iso()]);
  if(exists)return res.status(409).json({error:"An active room with that name already exists."});
  // custom retention period: 48h (default) up to 120h, any number of minutes in between
  const mins=req.body.retentionMinutes===undefined||req.body.retentionMinutes===""?RETENTION_MIN_MINUTES:Number(req.body.retentionMinutes);
  if(!Number.isInteger(mins)||mins<RETENTION_MIN_MINUTES||mins>RETENTION_MAX_MINUTES)
    return res.status(400).json({error:"Retention period must be between 48 hours and 120 hours."});
  const hash=await bcrypt.hash(pw,12), created=iso(), exp=new Date(Date.now()+mins*60000).toISOString();
  run("INSERT INTO rooms(name,password_hash,owner_id,created_at,expires_at) VALUES(?,?,?,?,?)",[name,hash,req.user.id,created,exp]);
  const r=row("SELECT id,name,owner_id,created_at,expires_at FROM rooms WHERE id=last_insert_rowid()");
  run("INSERT INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)",[r.id,req.user.id,created]);
  res.json({ok:true,room:r});
});

async function loginRoom(req,res){
  cleanup();
  const name=String(req.body.name||"").trim(), pw=String(req.body.password||"");
  if(!name||!pw)return res.status(400).json({error:"Enter both the room name and password."});
  const candidates=rows("SELECT * FROM rooms WHERE lower(name)=lower(?) AND expires_at>? ORDER BY id DESC",[name,iso()]);
  for(const r of candidates){
    if(await bcrypt.compare(pw,r.password_hash)){
      if(isBanned(r.id,req.user.id))return res.status(403).json({error:"You were removed from this room by its owner."});
      run("INSERT OR IGNORE INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)",[r.id,req.user.id,iso()]);
      return res.json({ok:true,room:{id:r.id,name:r.name,owner_id:r.owner_id,created_at:r.created_at,expires_at:r.expires_at}});
    }
  }
  res.status(401).json({error:"Room name or password is incorrect."});
}
app.post("/api/rooms/login",requireUser,loginRoom);
app.post("/api/rooms/:id/join",requireUser,async(req,res)=>{
  const id=Number(req.params.id),pw=String(req.body.password||"");
  const r=row("SELECT * FROM rooms WHERE id=? AND expires_at>?",[id,iso()]);
  if(!r)return res.status(404).json({error:"Room not found or expired."});
  if(!await bcrypt.compare(pw,r.password_hash))return res.status(401).json({error:"Incorrect room password."});
  if(isBanned(id,req.user.id))return res.status(403).json({error:"You were removed from this room by its owner."});
  run("INSERT OR IGNORE INTO room_members(room_id,user_id,joined_at) VALUES(?,?,?)",[id,req.user.id,iso()]);
  res.json({ok:true});
});
app.delete("/api/rooms/:id",requireUser,(req,res)=>{
  const id=Number(req.params.id),r=row("SELECT owner_id FROM rooms WHERE id=?",[id]);
  if(!r)return res.status(404).json({error:"Room not found."});
  if(Number(r.owner_id)!==req.user.id)return res.status(403).json({error:"Only the room's alpha (main owner) can delete this room."});
  deleteRoom(id);res.json({ok:true});
});

// ---- members, admins and removals
app.get("/api/rooms/:id/members",requireUser,(req,res)=>{
  const room=getRoom(Number(req.params.id));
  if(!room)return res.status(404).json({error:"Room not found or expired."});
  const myRole=roleOf(room,req.user.id);
  if(!myRole)return res.status(403).json({error:"You are not a member of this room."});
  const out={members:roomMembers(room),myRole,alphaId:Number(room.owner_id)};
  if(myRole==="alpha")out.removed=rows(`SELECT u.id,u.username FROM room_bans b JOIN users u ON u.id=b.user_id WHERE b.room_id=? ORDER BY u.username COLLATE NOCASE`,[room.id])
    .map(x=>({id:Number(x.id),username:x.username}));
  res.json(out);
});
function alphaOnly(req,res){
  const room=getRoom(Number(req.params.id));
  if(!room){res.status(404).json({error:"Room not found or expired."});return null;}
  if(Number(room.owner_id)!==req.user.id){res.status(403).json({error:"Only the room's alpha (main owner) can do this."});return null;}
  return room;
}
app.post("/api/rooms/:id/admins",requireUser,(req,res)=>{
  const room=alphaOnly(req,res);if(!room)return;
  const uid=Number(req.body.userId);
  if(uid===Number(room.owner_id))return res.status(400).json({error:"The alpha already has full control."});
  if(!member(room.id,uid))return res.status(404).json({error:"That person is not in this room."});
  run("UPDATE room_members SET role='admin' WHERE room_id=? AND user_id=?",[room.id,uid]);
  res.json({ok:true});
});
app.delete("/api/rooms/:id/admins/:userId",requireUser,(req,res)=>{
  const room=alphaOnly(req,res);if(!room)return;
  run("UPDATE room_members SET role='member' WHERE room_id=? AND user_id=?",[room.id,Number(req.params.userId)]);
  res.json({ok:true});
});
app.delete("/api/rooms/:id/members/:userId",requireUser,(req,res)=>{
  const room=alphaOnly(req,res);if(!room)return;
  const uid=Number(req.params.userId);
  if(uid===Number(room.owner_id))return res.status(400).json({error:"The alpha cannot be removed. Delete the room instead."});
  if(!member(room.id,uid))return res.status(404).json({error:"That person is not in this room."});
  run("DELETE FROM room_members WHERE room_id=? AND user_id=?",[room.id,uid]);
  run("INSERT OR IGNORE INTO room_bans(room_id,user_id,created_at) VALUES(?,?,?)",[room.id,uid,iso()]); // stops them rejoining with the password
  res.json({ok:true});
});
app.delete("/api/rooms/:id/bans/:userId",requireUser,(req,res)=>{
  const room=alphaOnly(req,res);if(!room)return;
  run("DELETE FROM room_bans WHERE room_id=? AND user_id=?",[room.id,Number(req.params.userId)]);
  res.json({ok:true});
});

app.get("/api/rooms/:id/messages",requireUser,(req,res)=>{
  const room=getRoom(Number(req.params.id));
  if(!room)return res.status(404).json({error:"Room not found or expired."});
  const myRole=roleOf(room,req.user.id);
  if(!myRole)return res.status(403).json({error:"You are not a member of this room."});
  const messages=rows(`SELECT * FROM (
      SELECT m.id,m.user_id,m.body,m.attachment_name,m.attachment_mime,m.ai_provider,m.created_at,u.username
      FROM messages m JOIN users u ON u.id=m.user_id WHERE m.room_id=? ORDER BY m.id DESC LIMIT 500
    ) ORDER BY id ASC`,[room.id]);
  res.json({room,messages,members:roomMembers(room),myRole});
});

app.delete("/api/rooms/:id/messages/:messageId",requireUser,(req,res)=>{
  const room=getRoom(Number(req.params.id));
  if(!room)return res.status(404).json({error:"Room not found or expired."});
  const role=roleOf(room,req.user.id);
  if(role!=="alpha"&&role!=="admin")return res.status(403).json({error:"Only the alpha or an admin can delete messages."});
  const m=row("SELECT id,attachment_path FROM messages WHERE id=? AND room_id=?",[Number(req.params.messageId),room.id]);
  if(!m)return res.status(404).json({error:"Message not found."});
  if(m.attachment_path)try{fs.unlinkSync(path.join(UPLOAD_DIR,path.basename(m.attachment_path)))}catch{}
  run("DELETE FROM messages WHERE id=?",[m.id]);
  res.json({ok:true});
});

app.post("/api/rooms/:id/messages",requireUser,(req,res)=>{
  upload.single("file")(req,res,(err)=>{
    if(err)return res.status(400).json({error:err.code==="LIMIT_FILE_SIZE"?`File is too large. Maximum is ${MAX_UPLOAD_MB} MB.`:"That file type is not allowed."});
    const id=Number(req.params.id);
    if(!member(id,req.user.id)){if(req.file)try{fs.unlinkSync(req.file.path)}catch{};return res.status(403).json({error:"You are not a member of this room."});}
    const body=String(req.body.body||"").trim();
    if(!body&&!req.file){return res.status(400).json({error:"Write a message or attach a file."});}
    run(`INSERT INTO messages(room_id,user_id,body,attachment_name,attachment_mime,attachment_path,created_at)
      VALUES(?,?,?,?,?,?,?)`,[id,req.user.id,body,req.file?.originalname||null,req.file?.mimetype||null,req.file?path.basename(req.file.path):null,iso()]);
    res.json({ok:true});
  });
});

app.get("/api/files/:messageId",requireUser,(req,res)=>{
  const m=row("SELECT attachment_path,attachment_name,attachment_mime,room_id FROM messages WHERE id=?",[Number(req.params.messageId)]);
  if(!m||!m.attachment_path||!member(m.room_id,req.user.id))return res.status(404).end();
  const p=path.join(UPLOAD_DIR,path.basename(m.attachment_path));
  if(!fs.existsSync(p))return res.status(404).end();
  res.setHeader("Content-Type",m.attachment_mime||"application/octet-stream");
  res.setHeader("Content-Disposition",`inline; filename*=UTF-8''${encodeURIComponent(safeName(m.attachment_name))}`);
  res.sendFile(p);
});

// The sender's own "@gemini ..." message is posted through the normal message route (so it is always visible);
// this route only generates and stores the AI's reply.
app.post("/api/ai",aiLimiter,requireUser,async(req,res)=>{
  const provider=String(req.body.provider||"").toLowerCase(),prompt=String(req.body.prompt||"").trim(),roomId=Number(req.body.roomId);
  if(!AI_PROVIDERS[provider])return res.status(400).json({error:"Unknown AI. Use @groq, @gemini or @openr."});
  if(!prompt||prompt.length>12000)return res.status(400).json({error:"AI prompt must be 1–12,000 characters."});
  if(!getRoom(roomId)||!member(roomId,req.user.id))return res.status(403).json({error:"You are not a member of this room."});
  try{
    const answer=await ai(provider,prompt);
    run("INSERT INTO messages(room_id,user_id,body,ai_provider,created_at) VALUES(?,?,?,?,?)",[roomId,req.user.id,answer,provider,iso()]);
    res.json({ok:true});
  }catch(e){res.status(502).json({error:e.message||"AI request failed."});}
});

app.use(express.static(path.join(ROOT,"public")));
app.get("/",(_q,s)=>s.sendFile(path.join(ROOT,"public","index.html")));
app.get("/cm",(_q,s)=>s.sendFile(path.join(ROOT,"public","cm.html")));
app.use((err,_req,res,_next)=>{console.error(err);res.status(500).json({error:"Internal server error."});});

(async()=>{
  SQL=await initSqlJs({locateFile:f=>path.join(ROOT,"node_modules","sql.js","dist",f)});
  db=fs.existsSync(DB_PATH)?new SQL.Database(new Uint8Array(fs.readFileSync(DB_PATH))):new SQL.Database();
  exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users(id INTEGER PRIMARY KEY AUTOINCREMENT,username TEXT NOT NULL UNIQUE,dob TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,password_hash TEXT NOT NULL,owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TEXT NOT NULL,expires_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_members(room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,joined_at TEXT NOT NULL,PRIMARY KEY(room_id,user_id));
    CREATE TABLE IF NOT EXISTS messages(id INTEGER PRIMARY KEY AUTOINCREMENT,room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,body TEXT NOT NULL DEFAULT '',attachment_name TEXT,attachment_mime TEXT,attachment_path TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS room_bans(room_id INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(room_id,user_id));
    CREATE INDEX IF NOT EXISTS idx_sessions_exp ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_rooms_exp ON rooms(expires_at);
    CREATE INDEX IF NOT EXISTS idx_messages_room ON messages(room_id,id);`);
  // migrations for databases created by earlier versions
  const hasCol=(t,c)=>rows(`PRAGMA table_info(${t})`).some(x=>x.name===c);
  if(!hasCol("room_members","role"))exec("ALTER TABLE room_members ADD COLUMN role TEXT NOT NULL DEFAULT 'member'");
  if(!hasCol("messages","ai_provider"))exec("ALTER TABLE messages ADD COLUMN ai_provider TEXT");
  cleanup(); saveDbNow();
  setInterval(()=>{try{cleanup();saveDbNow()}catch(e){console.error("maintenance:",e)}},10*60*1000);
  process.on("SIGINT",()=>{saveDbNow();process.exit(0)});
  process.on("SIGTERM",()=>{saveDbNow();process.exit(0)});
  app.listen(PORT,()=>console.log(`${APP_NAME} running at http://localhost:${PORT}`));
})();
