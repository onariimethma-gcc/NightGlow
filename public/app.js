"use strict";
async function api(url,opts={}){
  const r=await fetch(url,opts);
  const d=await r.json().catch(()=>({}));
  if(!r.ok){const e=Error(d.error||`Request failed (${r.status})`);e.status=r.status;throw e}
  return d;
}
const $=id=>document.getElementById(id);
const JSON_POST=body=>({method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
let me=null,currentRoom=null,members=[],myRole="member",lastSig="",loading=false,aiPending=0;

function esc(s){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]))}
function note(t){
  const n=$("toast")||$("notice");if(!n)return;
  n.textContent=t;n.classList.toggle("show",!!t&&n.id==="toast");
  setTimeout(()=>{if(n.textContent===t){n.textContent="";n.classList.remove("show")}},5000);
}
function modal(content){$("modalCard").innerHTML=content;$("modal").classList.remove("hidden")}
function closeModal(){$("modal").classList.add("hidden")}
$("modal")?.addEventListener("click",e=>{if(e.target.classList.contains("modal-bg")||e.target.closest("[data-close]"))closeModal()});
function modalNote(t){const n=$("modalNote");if(n)n.textContent=t}

/* ------------------------------------------------------------------ boot */
async function boot(){
  const d=await api("/api/me");me=d;
  if(location.pathname==="/"&&d.authenticated){location.href="/cm";return}
  if(location.pathname==="/cm"&&!d.authenticated){location.href="/";return}
  if(location.pathname==="/"){initLanding();return}
  initApp();
}
function initLanding(){
  $("signinForm").addEventListener("submit",async e=>{
    e.preventDefault();
    try{await api("/api/signin",JSON_POST({username:$("username").value.trim(),dob:$("dob").value}));location.href="/cm"}catch(e){note(e.message)}
  });
}
async function initApp(){
  $("who").textContent=me.username;
  $("logout").onclick=async()=>{await api("/api/logout",{method:"POST"});location.href="/"};
  $("newRoom").onclick=showCreate;$("emptyCreate").onclick=showCreate;$("emptyJoin").onclick=showJoin;$("railJoin").onclick=showJoin;
  $("closeRoom").onclick=()=>selectRoom(null);$("roomInfo").onclick=showMembers;
  $("messageForm").addEventListener("submit",send);
  const ta=$("message");
  ta.addEventListener("input",()=>{autoGrow();updateSuggest()});
  ta.addEventListener("click",updateSuggest);
  ta.addEventListener("keydown",onComposerKey);
  ta.addEventListener("blur",()=>setTimeout(hideSuggest,150));
  await loadRooms();
  setInterval(()=>{if(!document.hidden&&currentRoom)loadMessages(false)},4000);
  setInterval(()=>{if(!document.hidden)loadRooms()},15000);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden){loadRooms();if(currentRoom)loadMessages(false)}});
}
function autoGrow(){const t=$("message");t.style.height="auto";t.style.height=Math.min(t.scrollHeight,180)+"px"}

/* ----------------------------------------------------------------- rooms */
function enterSubmit(inputIds,btnId){
  for(const id of inputIds)$(id).addEventListener("keydown",e=>{if(e.key==="Enter"){e.preventDefault();$(btnId).click()}});
}
function showCreate(){
  modal(`<h2>Create a private room</h2><p class="sub">You become its alpha (main owner). The room and its files are deleted when its retention period ends.</p>
  <label>Room name<input id="mName" maxlength="80" placeholder="Friday night"></label>
  <label>Password<input id="mPw" type="password" minlength="4" placeholder="At least 4 characters"></label>
  <button type="button" class="ghost wide-ghost" id="retBtn" aria-expanded="false">⏱ Custom retention period <span id="retSum">· 48h</span></button>
  <div id="retBox" class="ret-box hidden">
    <div class="ret-row"><label>Hours<input id="retH" type="number" min="48" max="120" step="1" value="48" inputmode="numeric"></label>
    <label>Minutes<input id="retM" type="number" min="0" max="59" step="1" value="0" inputmode="numeric"></label></div>
    <p class="tiny">Choose between 48 hours and 120 hours (5 days).</p>
  </div>
  <div id="modalNote" class="notice"></div>
  <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="mCreate">Create room</button></div>`);
  enterSubmit(["mName","mPw"],"mCreate");
  const retention=()=>{ // returns total minutes, or null with a message when invalid
    const h=Math.floor(Number($("retH").value)),mi=Math.floor(Number($("retM").value||0)),t=h*60+mi;
    if(!Number.isFinite(t)||h<48||h>120||mi<0||mi>59||t>7200){modalNote("Retention must be between 48 hours and 120 hours.");return null}
    return t;
  };
  const sum=()=>{const h=Math.floor(Number($("retH").value)||0),mi=Math.floor(Number($("retM").value)||0);$("retSum").textContent=`· ${h}h${mi?` ${mi}m`:""}`};
  $("retBtn").onclick=()=>{const open=$("retBox").classList.toggle("hidden")===false;$("retBtn").setAttribute("aria-expanded",open)};
  $("retH").oninput=$("retM").oninput=sum;
  $("mCreate").onclick=async()=>{try{
    const retentionMinutes=retention();if(retentionMinutes===null)return;
    const d=await api("/api/rooms",JSON_POST({name:$("mName").value.trim(),password:$("mPw").value,retentionMinutes}));closeModal();await loadRooms();selectRoom(d.room.id)}catch(e){modalNote(e.message)}};
}
function showJoin(){
  modal(`<h2>Unlock a room</h2><p class="sub">Enter the exact room name and its password.</p>
  <label>Room name<input id="jName" maxlength="80" placeholder="Room name"></label>
  <label>Password<input id="jPw" type="password" placeholder="Room password"></label>
  <div id="modalNote" class="notice"></div>
  <div class="modal-actions"><button class="ghost" data-close>Cancel</button><button class="primary" id="jGo">Unlock room</button></div>`);
  enterSubmit(["jName","jPw"],"jGo");
  $("jGo").onclick=async()=>{try{const d=await api("/api/rooms/login",JSON_POST({name:$("jName").value.trim(),password:$("jPw").value}));closeModal();await loadRooms();selectRoom(d.room.id)}catch(e){modalNote(e.message)}};
}
async function loadRooms(){
  try{
    const d=await api("/api/rooms");const box=$("rooms");box.innerHTML="";
    if(!d.rooms.length){box.innerHTML='<div class="tiny" style="padding:22px 10px">No rooms yet.<br>Create one or join with a room name and password.</div>'}
    d.rooms.forEach(r=>{
      const el=document.createElement("div");el.className="room"+(currentRoom===Number(r.id)?" active":"");
      const owner=Number(r.owner_id)===Number(me.userId)?'<span class="owner-tag">ALPHA</span>':"";
      el.innerHTML=`<div class="room-name">${esc(r.name)} ${owner}</div><div class="room-meta">ID ${r.id} · expires ${timeLeft(r.expires_at)}</div>`;
      el.onclick=()=>selectRoom(Number(r.id));
      if(Number(r.owner_id)===Number(me.userId)){
        const b=document.createElement("button");b.className="room-delete";b.textContent="×";b.title="Delete room";
        b.onclick=async e=>{e.stopPropagation();if(confirm("Delete this room permanently?")){try{await api("/api/rooms/"+r.id,{method:"DELETE"});if(currentRoom===Number(r.id))selectRoom(null);await loadRooms()}catch(e){note(e.message)}}};
        el.appendChild(b);
      }
      box.appendChild(el);
    });
  }catch(e){note(e.message)}
}
function timeLeft(x){const ms=new Date(x)-Date.now();if(ms<=0)return"expired";const h=Math.floor(ms/3600000),m=Math.floor(ms%3600000/60000);return h?`${h}h ${m}m`:`${m}m`}
async function selectRoom(id){
  currentRoom=id;lastSig="";members=[];hideSuggest();
  document.body.classList.toggle("has-room",!!id);
  document.querySelectorAll(".room").forEach(x=>x.classList.remove("active"));
  if(!id){$("emptyState").classList.remove("hidden");$("chatView").classList.add("hidden");return}
  $("emptyState").classList.add("hidden");$("chatView").classList.remove("hidden");
  $("messages").innerHTML="";
  await loadMessages(true);await loadRooms();
}

/* -------------------------------------------------------------- messages */
const AI_NAMES={groq:"Groq",gemini:"Gemini",openrouter:"OpenRouter",mistral:"Mistral"};
function aiInfo(m){ // new rows carry ai_provider; older rows were stored as "[provider] text"
  if(m.ai_provider)return{p:m.ai_provider,body:m.body};
  const x=/^\[(groq|gemini|mistral|openrouter)\]\s([\s\S]*)$/.exec(m.body||"");
  return x?{p:x[1],body:x[2]}:null;
}
function inline(t){return esc(t).replace(/`([^`\n]+)`/g,"<code>$1</code>").replace(/\*\*([^*\n]+)\*\*/g,"<b>$1</b>")}
function aiHtml(raw){ // paragraphs + bullet/numbered points, nothing else
  const out=[];let list=null,code=null;
  const close=()=>{if(list){out.push(`</${list}>`);list=null}};
  for(const line of String(raw).replace(/\r/g,"").split("\n")){
    if(/^\s*```/.test(line)){if(code===null){close();code=[]}else{out.push(`<pre>${esc(code.join("\n"))}</pre>`);code=null}continue}
    if(code!==null){code.push(line);continue}
    let m;
    if((m=/^\s*[-*•]\s+(.*)$/.exec(line))){if(list!=="ul"){close();out.push("<ul>");list="ul"}out.push(`<li>${inline(m[1])}</li>`);continue}
    if((m=/^\s*\d+[.)]\s+(.*)$/.exec(line))){if(list!=="ol"){close();out.push("<ol>");list="ol"}out.push(`<li>${inline(m[1])}</li>`);continue}
    close();
    if(!line.trim())continue;
    if((m=/^#{1,6}\s+(.*)$/.exec(line))){out.push(`<p><b>${inline(m[1])}</b></p>`);continue}
    out.push(`<p>${inline(line)}</p>`);
  }
  close();if(code!==null)out.push(`<pre>${esc(code.join("\n"))}</pre>`);
  return out.join("");
}
// #username -> highlighted chip (only for people who are in this room)
function userHtml(raw){
  const names=members.map(m=>m.username).sort((a,b)=>b.length-a.length);
  let out="";
  for(let i=0;i<raw.length;){
    if(raw[i]==="#"&&(i===0||/[\s(\[{>"'“]/.test(raw[i-1]))){
      const hit=names.find(n=>raw.substr(i+1,n.length).toLowerCase()===n.toLowerCase()&&!/[A-Za-z0-9_]/.test(raw[i+1+n.length]||""));
      if(hit){
        const self=hit.toLowerCase()===me.username.toLowerCase();
        out+=`<span class="mention${self?" me":""}">#${esc(raw.substr(i+1,hit.length))}</span>`;i+=1+hit.length;continue;
      }
    }
    out+=esc(raw[i]);i++;
  }
  return out.replace(/\n/g,"<br>");
}
function fmtTime(iso){
  const d=new Date(iso),t=d.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"});
  return d.toDateString()===new Date().toDateString()?t:`${d.toLocaleDateString([],{month:"short",day:"numeric"})}, ${t}`;
}
function badge(role){return role==="alpha"?'<span class="badge alpha">ALPHA</span>':role==="admin"?'<span class="badge admin">ADMIN</span>':""}

async function loadMessages(scroll=true){
  if(!currentRoom||loading)return;
  loading=true;const roomAtStart=currentRoom;
  try{
    const d=await api(`/api/rooms/${roomAtStart}/messages`);
    if(roomAtStart!==currentRoom)return;
    members=d.members;myRole=d.myRole;
    $("roomTitle").textContent=d.room.name;
    $("roomMeta").textContent=`Room ${d.room.id} · ${members.length} member${members.length===1?"":"s"} · expires in ${timeLeft(d.room.expires_at)}`;
    const sig=d.messages.map(m=>m.id).join(",")+"|"+members.map(x=>x.id+x.role).join(",");
    if(sig===lastSig)return;lastSig=sig;
    const box=$("messages"),atBottom=box.scrollHeight-box.scrollTop-box.clientHeight<80;
    box.innerHTML="";
    const canModerate=myRole==="alpha"||myRole==="admin";
    if(!d.messages.length)box.innerHTML='<div class="tiny" style="text-align:center;padding:30px">No messages yet. Say hello 👋</div>';
    d.messages.forEach(m=>{
      const a=aiInfo(m),mine=!a&&Number(m.user_id)===Number(me.userId);
      const role=(members.find(x=>x.id===Number(m.user_id))||{}).role;
      const x=document.createElement("div");x.className="message"+(mine?" mine":"")+(a?" ai":"");
      let body,name,initial;
      if(a){body=aiHtml(a.body);name=`${esc(AI_NAMES[a.p]||a.p)} <span class="badge ai">AI</span>`;initial="✦"}
      else{
        body=userHtml(m.body||"");name=esc(m.username)+" "+badge(role);initial=esc((m.username||"?")[0].toUpperCase());
        if(new RegExp("(^|\\s)#"+me.username.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")+"(?![A-Za-z0-9_])","i").test(m.body||"")&&!mine)x.classList.add("mentioned-me");
      }
      if(m.attachment_name)body+=`<a class="attachment" href="/api/files/${m.id}" target="_blank" rel="noopener">↗ ${esc(m.attachment_name)}</a>`;
      x.innerHTML=`<div class="avatar">${initial}</div><div class="bubble"><div class="meta">${name} · ${fmtTime(m.created_at)}${canModerate?`<button class="msg-del" data-mid="${m.id}" title="Delete message">🗑</button>`:""}</div><div class="body">${body}</div></div>`;
      box.appendChild(x);
    });
    if(scroll||atBottom)box.scrollTop=box.scrollHeight;
  }catch(e){
    if(e.status===403||e.status===404){selectRoom(null);note(e.status===403?"You are no longer a member of that room.":e.message);loadRooms()}
    else note(e.message);
  }finally{loading=false}
}
$("messages")?.addEventListener("click",async e=>{
  const b=e.target.closest(".msg-del");if(!b)return;
  if(!confirm("Delete this message for everyone?"))return;
  try{await api(`/api/rooms/${currentRoom}/messages/${b.dataset.mid}`,{method:"DELETE"});lastSig="";await loadMessages(false)}catch(err){note(err.message)}
});

async function send(e){
  e.preventDefault();if(!currentRoom)return;
  const room=currentRoom,text=$("message").value.trim(),file=$("file").files[0];if(!text&&!file)return;
  const m=text.match(/^@(groq|gemini|openrouter|openr)\b\s*([\s\S]*)$/i);
  try{
    // the sender's message is always posted first so it is visible straight away
    const fd=new FormData();fd.append("body",text);if(file)fd.append("file",file);
    $("message").value="";$("file").value="";autoGrow();hideSuggest();
    await api(`/api/rooms/${room}/messages`,{method:"POST",body:fd});
    lastSig="";await loadMessages(true);
    if(m&&!file){
      const provider=m[1].toLowerCase()==="openr"?"openrouter":m[1].toLowerCase(),prompt=m[2].trim();
      if(!prompt){note(`Add a question after @${m[1].toLowerCase()}.`);return}
      aiPending++;aiStatus(`${AI_NAMES[provider]} is writing…`);
      try{await api("/api/ai",JSON_POST({provider,prompt,roomId:room}))}
      catch(err){note(err.message)}
      finally{aiPending--;aiStatus(aiPending?"AI is writing…":"")}
      lastSig="";await loadMessages(true);
    }
  }catch(err){note(err.message)}
}
function aiStatus(t){const s=$("aiStatus");s.textContent=t;s.classList.toggle("hidden",!t)}

/* ------------------------------------------- #mention / @ai suggestions */
let sugg=[],suggIdx=0,suggFrom=0;
function hideSuggest(){sugg=[];$("mentionBox")?.classList.add("hidden")}
function updateSuggest(){
  const ta=$("message"),pos=ta.selectionStart,before=ta.value.slice(0,pos);let m;
  if((m=/(^|[\s(])#([A-Za-z0-9_.-]*)$/.exec(before))){
    const q=m[2].toLowerCase();suggFrom=pos-q.length-1;
    sugg=members.filter(x=>x.username.toLowerCase().includes(q)).sort((a,b)=>(b.username.toLowerCase().startsWith(q))-(a.username.toLowerCase().startsWith(q))).slice(0,6)
      .map(x=>({text:"#"+x.username,label:"#"+esc(x.username),sub:x.role==="member"?"":x.role}));
  }else if((m=/^@([a-z]*)$/i.exec(before))){
    const q=m[1].toLowerCase();suggFrom=0;
    sugg=[["gemini","Gemini"],["groq","Groq"],["openr","OpenRouter"]].filter(x=>x[0].startsWith(q)).map(x=>({text:"@"+x[0],label:"@"+x[0],sub:x[1]+" AI"}));
  }else sugg=[];
  suggIdx=0;renderSuggest();
}
function renderSuggest(){
  const box=$("mentionBox");
  if(!sugg.length){box.classList.add("hidden");return}
  box.innerHTML=sugg.map((s,i)=>`<div class="mention-item${i===suggIdx?" active":""}" data-i="${i}"><b>${s.label}</b><small>${esc(s.sub||"")}</small></div>`).join("");
  box.classList.remove("hidden");
}
function pickSuggest(i){
  const s=sugg[i];if(!s)return;
  const ta=$("message"),pos=ta.selectionStart;
  ta.value=ta.value.slice(0,suggFrom)+s.text+" "+ta.value.slice(pos);
  const p=suggFrom+s.text.length+1;ta.setSelectionRange(p,p);ta.focus();hideSuggest();autoGrow();
}
$("mentionBox")?.addEventListener("mousedown",e=>{e.preventDefault();const it=e.target.closest(".mention-item");if(it)pickSuggest(Number(it.dataset.i))});
function onComposerKey(e){
  if(sugg.length&&!$("mentionBox").classList.contains("hidden")){
    if(e.key==="ArrowDown"){e.preventDefault();suggIdx=(suggIdx+1)%sugg.length;renderSuggest();return}
    if(e.key==="ArrowUp"){e.preventDefault();suggIdx=(suggIdx-1+sugg.length)%sugg.length;renderSuggest();return}
    if(e.key==="Tab"||e.key==="Enter"){e.preventDefault();pickSuggest(suggIdx);return}
    if(e.key==="Escape"){hideSuggest();return}
  }
  if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("messageForm").requestSubmit()}
}

/* ------------------------------------------- members / admins / removal */
async function showMembers(){
  if(!currentRoom)return;
  const room=currentRoom;
  try{
    const d=await api(`/api/rooms/${room}/members`);
    const alpha=d.myRole==="alpha";
    const row=m=>{
      const acts=alpha&&m.role!=="alpha"?`<div class="member-actions">
        ${m.role==="admin"?`<button class="ghost slim" data-act="demote" data-uid="${m.id}">Remove admin</button>`:`<button class="ghost slim" data-act="promote" data-uid="${m.id}">Make admin</button>`}
        <button class="ghost slim danger" data-act="remove" data-uid="${m.id}" data-name="${esc(m.username)}">Remove</button></div>`:"";
      return `<div class="member-row"><div class="avatar">${esc(m.username[0].toUpperCase())}</div><div class="member-name">${esc(m.username)} ${badge(m.role)}</div>${acts}</div>`;
    };
    const removed=alpha&&d.removed&&d.removed.length?`<h3 class="mini-h">Removed</h3>${d.removed.map(r=>`<div class="member-row"><div class="avatar">${esc(r.username[0].toUpperCase())}</div><div class="member-name">${esc(r.username)}</div><div class="member-actions"><button class="ghost slim" data-act="allow" data-uid="${r.id}">Allow back</button></div></div>`).join("")}`:"";
    modal(`<h2>${esc($("roomTitle").textContent)}</h2>
      <p class="sub">${esc($("roomMeta").textContent)}</p>
      <h3 class="mini-h">Members · ${d.members.length}</h3>
      <div class="member-list">${d.members.map(row).join("")}</div>${removed}
      <p class="tiny" style="margin-top:14px">${alpha?"You are the alpha: you can make admins and remove people. Admins can delete messages.":"Only the alpha (main owner) can make admins or remove people. Share the room name and password only with people you want to invite."}</p>
      <div class="modal-actions"><button class="primary" data-close>Done</button></div>`);
    $("modalCard").dataset.room=room;
  }catch(e){note(e.message)}
}
$("modalCard")?.addEventListener("click",async e=>{
  const b=e.target.closest("[data-act]");if(!b)return;
  const room=Number($("modalCard").dataset.room),uid=b.dataset.uid,act=b.dataset.act;
  try{
    if(act==="remove"){if(!confirm(`Remove ${b.dataset.name} from this room? They won't be able to rejoin unless you allow them back.`))return;await api(`/api/rooms/${room}/members/${uid}`,{method:"DELETE"})}
    if(act==="promote")await api(`/api/rooms/${room}/admins`,JSON_POST({userId:Number(uid)}));
    if(act==="demote")await api(`/api/rooms/${room}/admins/${uid}`,{method:"DELETE"});
    if(act==="allow")await api(`/api/rooms/${room}/bans/${uid}`,{method:"DELETE"});
    lastSig="";await loadMessages(false);await showMembers();
  }catch(err){note(err.message)}
});

boot().catch(e=>{console.error(e);note(e.message)});
