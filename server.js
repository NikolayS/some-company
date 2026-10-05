import http from 'node:http';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes, createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const hash = value => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const fail = (status, message) => { throw new HttpError(status, message); };
function str(value, name, min, max) { if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(400, `${name} must be ${min}–${max} characters.`); return value.trim(); }
function choice(value, options, name) { if (!options.includes(value)) fail(400, `Choose a valid ${name}.`); return value; }
function date(value) { if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10) !== value) fail(400, 'Choose a valid date.'); return value; }
const publicUser = user => user && ({id:user.id,name:user.name,kind:user.kind,bio:user.bio,interests:user.interests,languages:user.languages,pace:user.pace});

export function createApp(options = {}) {
  const env = {...process.env, ...options.env};
  const production = env.NODE_ENV === 'production';
  const origin = new URL(env.APP_URL || 'http://localhost:3000').origin;
  const local = ['localhost','127.0.0.1','[::1]'].includes(new URL(origin).hostname);
  if (production && !origin.startsWith('https://')) throw new Error('Production APP_URL must use HTTPS.');
  if (env.DEV_EMAIL_CONSOLE === '1' && (production || !local)) throw new Error('Development email delivery is only permitted on local non-production origins.');
  const dbPath = options.databasePath || env.DATABASE_PATH || './data/some-company.sqlite';
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), {recursive:true, mode:0o700});
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'solo', bio TEXT NOT NULL DEFAULT '', interests TEXT NOT NULL DEFAULT '', languages TEXT NOT NULL DEFAULT '', pace TEXT NOT NULL DEFAULT 'easy', banned INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS tokens (digest TEXT PRIMARY KEY, email TEXT NOT NULL, browser TEXT NOT NULL, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (digest TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id INTEGER PRIMARY KEY, owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, destination TEXT NOT NULL, type TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, description TEXT NOT NULL, seats INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE, guest_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, party_size INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created INTEGER NOT NULL, UNIQUE(plan_id,guest_id));
    CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, request_id INTEGER NOT NULL REFERENCES requests(id) ON DELETE CASCADE, sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, body TEXT NOT NULL, created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS blocks (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, target_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY(user_id,target_id));
    CREATE TABLE IF NOT EXISTS reports (id INTEGER PRIMARY KEY, reporter_id INTEGER REFERENCES users(id) ON DELETE SET NULL, target_id INTEGER REFERENCES users(id) ON DELETE SET NULL, reason TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, hits INTEGER NOT NULL, reset INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS plans_dates ON plans(status,start,end);
    CREATE INDEX IF NOT EXISTS messages_thread ON messages(request_id,id);
    CREATE INDEX IF NOT EXISTS requests_guest ON requests(guest_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires);`);
  const get = (sql,...args) => db.prepare(sql).get(...args);
  const all = (sql,...args) => db.prepare(sql).all(...args);
  const run = (sql,...args) => db.prepare(sql).run(...args);
  const admins = (env.ADMIN_EMAILS || '').toLowerCase().split(',').map(x=>x.trim()).filter(Boolean);
  const isAdmin = user => !!user && admins.includes(user.email);
  const blocked = (a,b) => !!get('SELECT 1 FROM blocks WHERE (user_id=? AND target_id=?) OR (user_id=? AND target_id=?)',a,b,b,a);
  function limit(key, max, period) {
    key = hash(key); const entry = get('SELECT * FROM limits WHERE key=?',key);
    if (!entry || entry.reset < now()) run('INSERT OR REPLACE INTO limits VALUES (?,?,?)',key,1,now()+period);
    else { if(entry.hits >= max) fail(429,'A little too much at once. Please try again later.'); run('UPDATE limits SET hits=hits+1 WHERE key=?',key); }
  }
  const cookie = (name,value,maxAge) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:')?'; Secure':''}`;
  function ownerPlan(id,user) { const p=get('SELECT * FROM plans WHERE id=?',id); if(!p || p.owner_id!==user.id) fail(404,'Plan not found.'); return p; }
  function thread(id,user) { const r=get('SELECT r.*,p.owner_id,p.title,p.status AS plan_status,p.start,p.end FROM requests r JOIN plans p ON p.id=r.plan_id WHERE r.id=?',id); if(!r || ![r.owner_id,r.guest_id].includes(user.id)) fail(404,'Conversation not found.'); return r; }
  function planInput(body) {
    const p = {title:str(body.title,'Title',5,100),destination:str(body.destination,'Destination',2,100),type:choice(body.type,['meal','day','trip'],'plan type'),start:date(body.start),end:date(body.end),description:str(body.description,'Description',20,2000),seats:Number(body.seats)};
    const today = new Date().toISOString().slice(0,10);
    if(p.start < today || p.end < p.start || (Date.parse(p.end)-Date.parse(p.start))/86400000 > 30 || p.start > new Date(now()+730*86400000).toISOString().slice(0,10)) fail(400,'Choose upcoming dates within two years, for a plan lasting at most 31 days.');
    if(p.type!=='trip' && p.start!==p.end) fail(400,'Meals and days out should start and finish on the same day.');
    if(!Number.isInteger(p.seats) || p.seats<1 || p.seats>6) fail(400,'Choose 1–6 places for other people.');
    return p;
  }
  const cleanup = setInterval(()=>{run('DELETE FROM tokens WHERE expires<?',now());run('DELETE FROM sessions WHERE expires<?',now());run('DELETE FROM limits WHERE reset<?',now());},60000); cleanup.unref();
  const transport = express();
  transport.disable('x-powered-by');
  transport.use(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');res.setHeader('Permissions-Policy','camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    if(production) res.setHeader('Strict-Transport-Security','max-age=31536000');
    const json = (status,data) => {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
    try {
      const url = new URL(req.url,origin); const path=url.pathname; const method=req.method;
      const cookies=Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=')));
      let user=cookies.sc_session ? get('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.digest=? AND s.expires>? AND u.banned=0',hash(cookies.sc_session),now()):null;
      const ip = env.TRUST_PROXY==='1' ? String(req.headers['x-forwarded-for']||req.socket.remoteAddress).split(',')[0].trim() : req.socket.remoteAddress;
      let body={};
      if(!['GET','HEAD'].includes(method)) {
        if(req.headers.origin!==origin) fail(403,'Please use this site to submit your request.');
        if(!req.headers['content-type']?.startsWith('application/json')) fail(415,'JSON required.');
        let raw='';for await(const chunk of req) {raw+=chunk;if(Buffer.byteLength(raw)>16000) fail(413,'That message is too long.');}
        try {body=JSON.parse(raw||'{}');} catch {fail(400,'Invalid request.');}
        if(!body || typeof body!=='object' || Array.isArray(body)) fail(400,'Invalid request.');
        limit(`write:${ip}`,200,600000);
      }
      if(path==='/healthz') {get('SELECT 1');return json(200,{ok:true});}
      if(path==='/api/me' && method==='GET') return json(200,{user:user?{...publicUser(user),email:user.email,admin:isAdmin(user)}:null,emailReady:!!(env.RESEND_API_KEY&&env.EMAIL_FROM)||(!production&&env.DEV_EMAIL_CONSOLE==='1')});
      if(path==='/api/auth/start' && method==='POST') {
        const email=str(body.email,'Email',3,254).toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail(400,'Enter a valid email address.');
        limit(`auth-ip:${ip}`,12,3600000);limit(`auth-email:${email}`,4,3600000);
        if(!(env.RESEND_API_KEY&&env.EMAIL_FROM) && !options.sendEmail && env.DEV_EMAIL_CONSOLE!=='1') fail(503,'Email sign-in is being set up. Please come back soon.');
        const token=random(), browser=random(); const link=`${origin}/auth/verify#${token}`;
        run('DELETE FROM tokens WHERE email=?',email);run('INSERT INTO tokens VALUES (?,?,?,?)',hash(token),email,hash(browser),now()+900000);
        try {
          if(options.sendEmail) await options.sendEmail({email,link});
          else if(env.RESEND_API_KEY&&env.EMAIL_FROM) {
            const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${env.RESEND_API_KEY}`,'Content-Type':'application/json'},body:JSON.stringify({from:env.EMAIL_FROM,to:[email],subject:'Your Some Company sign-in link',html:`<h1>Like some company?</h1><p><a href="${escape(link)}">Sign in to Some Company</a></p><p>Open this link in the same browser where you requested it. It expires in 15 minutes and works once. If you did not request it, ignore this email.</p>`,text:`Sign in to Some Company: ${link}\nOpen in the same browser where you requested it. This link expires in 15 minutes and works once.`}),signal:AbortSignal.timeout(10000)});
            if(!response.ok) throw new Error('Email provider rejected delivery');
          } else console.log(`[LOCAL EMAIL ONLY] ${email}: ${link}`);
        } catch {run('DELETE FROM tokens WHERE digest=?',hash(token));fail(503,'We could not send your email just now. Please try again shortly.');}
        res.setHeader('Set-Cookie',cookie('sc_browser',browser,900));return json(200,{ok:true});
      }
      if(path==='/api/auth/verify' && method==='POST') {
        limit(`verify:${ip}`,30,600000);
        const token=str(body.token,'Sign-in link',40,100);const row=get('SELECT * FROM tokens WHERE digest=? AND expires>?',hash(token),now());
        if(!row || !cookies.sc_browser || row.browser!==hash(cookies.sc_browser)) fail(400,'This link has expired, was already used, or opened in a different browser. Request a new link in this browser.');
        run('DELETE FROM tokens WHERE digest=?',hash(token));
        run('INSERT OR IGNORE INTO users(email,created) VALUES (?,?)',row.email,now());user=get('SELECT * FROM users WHERE email=?',row.email);
        if(user.banned) fail(403,'This account is suspended.');
        const session=random();run('INSERT INTO sessions VALUES (?,?,?)',hash(session),user.id,now()+30*86400000);
        res.setHeader('Set-Cookie',[cookie('sc_session',session,30*86400),cookie('sc_browser','',0)]);return json(200,{ok:true});
      }
      if(path==='/api/auth/logout' && method==='POST') {if(cookies.sc_session)run('DELETE FROM sessions WHERE digest=?',hash(cookies.sc_session));res.setHeader('Set-Cookie',cookie('sc_session','',0));return json(200,{ok:true});}
      if(path==='/api/plans' && method==='GET') {
        const destination=(url.searchParams.get('destination')||'').slice(0,100),type=url.searchParams.get('type')||'',start=url.searchParams.get('start')||'',end=url.searchParams.get('end')||'';
        if(start)date(start);if(end)date(end);if(type)choice(type,['meal','day','trip'],'plan type');
        const rows=all(`SELECT p.*,u.name,u.kind,u.bio,u.interests,u.languages,u.pace,COALESCE((SELECT SUM(party_size) FROM requests WHERE plan_id=p.id AND status='accepted'),0) AS filled FROM plans p JOIN users u ON u.id=p.owner_id WHERE p.status='open' AND u.banned=0 AND p.end>=? AND (?='' OR instr(lower(p.destination),lower(?))>0) AND (?='' OR p.type=?) AND (?='' OR p.end>=?) AND (?='' OR p.start<=?) ORDER BY p.start,p.id DESC LIMIT 100`,new Date().toISOString().slice(0,10),destination,destination,type,type,start,start,end,end).filter(p=>!user||!blocked(user.id,p.owner_id));
        return json(200,{plans:rows.map(p=>({...p,owner:{id:p.owner_id,name:p.name,kind:p.kind,bio:p.bio,interests:p.interests,languages:p.languages,pace:p.pace}}))});
      }
      const publicPlanMatch=path.match(/^\/api\/plans\/(\d+)$/);
      if(publicPlanMatch && method==='GET') {
        const p=get(`SELECT p.*,COALESCE((SELECT SUM(party_size) FROM requests WHERE plan_id=p.id AND status='accepted'),0) AS filled FROM plans p JOIN users u ON u.id=p.owner_id WHERE p.id=? AND u.banned=0`,Number(publicPlanMatch[1]));
        if(!p || (user&&blocked(user.id,p.owner_id)) || (p.status!=='open'&&p.owner_id!==user?.id))fail(404,'This plan is no longer available.');
        const owner=publicUser(get('SELECT * FROM users WHERE id=?',p.owner_id));
        const request=user?get('SELECT id,status FROM requests WHERE plan_id=? AND guest_id=?',p.id,user.id):null;
        return json(200,{plan:p,owner,request:request||null});
      }
      if(path.startsWith('/api/')) {
        if(!user)fail(401,'Sign in to continue.');
        if(path==='/api/profile' && method==='PUT') {
          const name=str(body.name,'Name',2,70),kind=choice(body.kind,['solo','couple'],'profile type'),bio=str(body.bio,'Introduction',20,1000),interests=str(body.interests,'Interests',2,200),languages=str(body.languages,'Languages',2,200),pace=choice(body.pace,['easy','balanced','active'],'pace');
          run('UPDATE users SET name=?,kind=?,bio=?,interests=?,languages=?,pace=? WHERE id=?',name,kind,bio,interests,languages,pace,user.id);return json(200,{ok:true});
        }
        if(path==='/api/account' && method==='DELETE') {run('DELETE FROM users WHERE id=?',user.id);res.setHeader('Set-Cookie',cookie('sc_session','',0));return json(200,{ok:true});}
        if(path==='/api/mine' && method==='GET') return json(200,{plans:all('SELECT p.*,COALESCE((SELECT SUM(party_size) FROM requests WHERE plan_id=p.id AND status=\'accepted\'),0) AS filled FROM plans p WHERE owner_id=? ORDER BY start DESC',user.id)});
        if(path==='/api/plans' && method==='POST') {
          if(!user.name)fail(400,'Introduce yourself in your profile first.');limit(`plans:${user.id}`,20,86400000);const p=planInput(body);
          const result=run('INSERT INTO plans(owner_id,title,destination,type,start,end,description,seats,created) VALUES (?,?,?,?,?,?,?,?,?)',user.id,p.title,p.destination,p.type,p.start,p.end,p.description,p.seats,now());return json(201,{id:Number(result.lastInsertRowid)});
        }
        let match=path.match(/^\/api\/plans\/(\d+)$/);
        if(match && method==='PUT') {
          const p=ownerPlan(Number(match[1]),user);const next=planInput(body);const accepted=get("SELECT COALESCE(SUM(party_size),0) AS count FROM requests WHERE plan_id=? AND status='accepted'",p.id).count;
          if(next.seats<accepted)fail(409,'Places cannot be fewer than your accepted guests.');
          if(accepted && ['destination','type','start','end'].some(k=>next[k]!==p[k]))fail(409,'Dates, destination and type cannot change after accepting a guest. Close this plan and agree a new one together.');
          const status=choice(body.status||p.status,['open','closed'],'plan status');run('UPDATE plans SET title=?,destination=?,type=?,start=?,end=?,description=?,seats=?,status=? WHERE id=?',next.title,next.destination,next.type,next.start,next.end,next.description,next.seats,status,p.id);return json(200,{ok:true});
        }
        if(match && method==='DELETE') {ownerPlan(Number(match[1]),user);run('DELETE FROM plans WHERE id=?',Number(match[1]));return json(200,{ok:true});}
        match=path.match(/^\/api\/plans\/(\d+)\/requests$/);
        if(match && method==='POST') {
          if(!user.name)fail(400,'Introduce yourself in your profile first.');limit(`requests:${user.id}`,30,86400000);
          const p=get('SELECT p.* FROM plans p JOIN users u ON u.id=p.owner_id WHERE p.id=? AND u.banned=0',Number(match[1]));
          if(!p||p.status!=='open'||p.end<new Date().toISOString().slice(0,10)||blocked(user.id,p.owner_id))fail(404,'This plan is no longer available.');
          if(p.owner_id===user.id)fail(400,'This is your own plan.');
          const size=user.kind==='couple'?2:1;const filled=get("SELECT COALESCE(SUM(party_size),0) AS count FROM requests WHERE plan_id=? AND status='accepted'",p.id).count;
          if(filled+size>p.seats)fail(409,'There are not enough places left for your party.');
          if(get('SELECT 1 FROM requests WHERE plan_id=? AND guest_id=?',p.id,user.id))fail(409,'You have already requested this plan. Check your conversations.');
          const message=str(body.message,'Introduction',10,2000);
          db.exec('BEGIN IMMEDIATE');try {const r=run('INSERT INTO requests(plan_id,guest_id,party_size,created) VALUES (?,?,?,?)',p.id,user.id,size,now());run('INSERT INTO messages(request_id,sender_id,body,created) VALUES (?,?,?,?)',r.lastInsertRowid,user.id,message,now());db.exec('COMMIT');return json(201,{id:Number(r.lastInsertRowid)});}catch(e){db.exec('ROLLBACK');throw e;}
        }
        if(path==='/api/requests' && method==='GET') {
          const rows=all('SELECT r.*,p.owner_id,p.title,p.destination,p.start,p.end,p.status AS plan_status,u.name AS guest_name,o.name AS owner_name FROM requests r JOIN plans p ON p.id=r.plan_id JOIN users u ON u.id=r.guest_id JOIN users o ON o.id=p.owner_id WHERE (p.owner_id=? OR r.guest_id=?) ORDER BY r.created DESC LIMIT 200',user.id,user.id);
          return json(200,{requests:rows.map(r=>({...r,blocked:blocked(r.owner_id,r.guest_id)}))});
        }
        match=path.match(/^\/api\/requests\/(\d+)(?:\/(messages))?$/);
        if(match) {
          const r=thread(Number(match[1]),user);const other=r.owner_id===user.id?r.guest_id:r.owner_id;
          if(method==='GET')return json(200,{request:r,other:publicUser(get('SELECT * FROM users WHERE id=?',other)),blocked:blocked(user.id,other),messages:all('SELECT m.id,m.sender_id,m.body,m.created,u.name FROM messages m JOIN users u ON u.id=m.sender_id WHERE request_id=? ORDER BY m.id LIMIT 500',r.id)});
          if(method==='PATCH'&&!match[2]) {
            const status=choice(body.status,['accepted','rejected','cancelled'],'request status');
            if(status==='cancelled'&&r.guest_id!==user.id)fail(403,'Only the guest can withdraw this request.');
            if(status!=='cancelled'&&r.owner_id!==user.id)fail(403,'Only the plan owner can decide this request.');
            if(r.status!=='pending'&&!(r.status==='accepted'&&status==='cancelled'))fail(409,'This request has already been decided.');
            if(status==='accepted') {
              if(blocked(user.id,other))fail(403,'Unblock this person before accepting.');
              if(r.plan_status!=='open'||r.end<new Date().toISOString().slice(0,10))fail(409,'This plan is no longer open.');
              const p=get('SELECT * FROM plans WHERE id=?',r.plan_id);const n=get("SELECT COALESCE(SUM(party_size),0) AS count FROM requests WHERE plan_id=? AND status='accepted'",r.plan_id).count;
              if(n+r.party_size>p.seats)fail(409,'There are not enough places left.');
              if(get('SELECT banned FROM users WHERE id=?',other).banned)fail(409,'This account is unavailable.');
            }
            run('UPDATE requests SET status=? WHERE id=?',status,r.id);return json(200,{ok:true});
          }
          if(method==='POST'&&match[2]) {
            if(blocked(user.id,other)||get('SELECT banned FROM users WHERE id=?',other).banned)fail(403,'This conversation is closed.');
            if(!['pending','accepted'].includes(r.status))fail(409,'This request is closed.');limit(`messages:${user.id}`,60,600000);
            if(get('SELECT COUNT(*) AS n FROM messages WHERE request_id=?',r.id).n>=500)fail(409,'This conversation has reached its message limit.');
            run('INSERT INTO messages(request_id,sender_id,body,created) VALUES (?,?,?,?)',r.id,user.id,str(body.message,'Message',1,2000),now());return json(201,{ok:true});
          }
        }
        if(path==='/api/blocks'&&method==='GET')return json(200,{blocks:all('SELECT u.id,u.name FROM blocks b JOIN users u ON u.id=b.target_id WHERE b.user_id=?',user.id)});
        if(path==='/api/blocks'&&['POST','DELETE'].includes(method)) {
          const target=Number(body.targetId);if(!Number.isInteger(target)||target===user.id||!get('SELECT 1 FROM users WHERE id=?',target))fail(400,'Choose another member.');
          if(method==='POST')run('INSERT OR IGNORE INTO blocks VALUES (?,?)',user.id,target);else run('DELETE FROM blocks WHERE user_id=? AND target_id=?',user.id,target);return json(200,{ok:true});
        }
        if(path==='/api/reports'&&method==='POST') {
          limit(`reports:${user.id}`,10,86400000);const target=Number(body.targetId);if(target===user.id||!get('SELECT 1 FROM users WHERE id=?',target))fail(400,'Choose another member.');
          run('INSERT INTO reports(reporter_id,target_id,reason,created) VALUES (?,?,?,?)',user.id,target,str(body.reason,'Report',10,2000),now());return json(201,{ok:true});
        }
        if(path.startsWith('/api/admin')) {
          if(!isAdmin(user))fail(403,'Administrator access required.');
          if(path==='/api/admin/reports'&&method==='GET')return json(200,{reports:all('SELECT r.*,u.name AS target_name,u.banned,v.name AS reporter_name FROM reports r LEFT JOIN users u ON u.id=r.target_id LEFT JOIN users v ON v.id=r.reporter_id ORDER BY r.created DESC LIMIT 200')});
          match=path.match(/^\/api\/admin\/reports\/(\d+)$/);
          if(match&&method==='PATCH') {const report=get('SELECT * FROM reports WHERE id=?',Number(match[1]));if(!report)fail(404,'Report not found.');const action=choice(body.action,['resolve','suspend','restore'],'moderation action');if(action!=='resolve'&&report.target_id){if(report.target_id===user.id)fail(400,'Cannot suspend your own admin account.');run('UPDATE users SET banned=? WHERE id=?',action==='suspend'?1:0,report.target_id);if(action==='suspend')run('DELETE FROM sessions WHERE user_id=?',report.target_id);}run("UPDATE reports SET status='resolved' WHERE id=?",report.id);return json(200,{ok:true});}
        }
        fail(404,'Not found.');
      }
      if(!['GET','HEAD'].includes(method))fail(405,'Method not allowed.');
      const assets={'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8'],'/favicon.svg':['favicon.svg','image/svg+xml']};
      const asset=assets[path]||(['/','/auth/verify'].includes(path)?['index.html','text/html; charset=utf-8']:null);
      if(!asset)fail(404,'Page not found.');const content=readFileSync(join(root,'public',asset[0]));res.writeHead(200,{'Content-Type':asset[1],'Cache-Control':'no-cache'});res.end(method==='HEAD'?undefined:content);
    } catch(e) {if(res.headersSent)return res.end();if(!e.status)console.error('Request failed:',e.name);json(e.status||500,{error:e.status?e.message:'Something went wrong. Please try again.'});}
  });
  const server = http.createServer(transport);
  server.requestTimeout=15000;server.headersTimeout=10000;
  server.on('close',()=>{clearInterval(cleanup);db.close();});
  return {server,db};
}
if(process.argv[1] && fileURLToPath(import.meta.url)===process.argv[1]) {
  const {server}=createApp();const port=Number(process.env.PORT||3000);server.listen(port,'0.0.0.0',()=>console.log(`Some Company listening on ${port}`));
  for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close(()=>process.exit(0)));
}
