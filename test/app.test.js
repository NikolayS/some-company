import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createApp} from '../server.js';
const origin='http://localhost:3000';
const future=n=>new Date(Date.now()+n*86400000).toISOString().slice(0,10);
const validPlan={title:'A garden walk and a long lunch',destination:'Porto, Portugal',type:'day',start:future(10),end:future(10),description:'A gentle walk around the gardens, followed by lunch at a local cafe. We each pay our own way.',seats:2};
async function setup(t,overrides={}) {
 const mails=[];const app=createApp({databasePath:':memory:',env:{APP_URL:origin,NODE_ENV:'test',RESEND_API_KEY:'',EMAIL_FROM:'',DEV_EMAIL_CONSOLE:'0',ADMIN_EMAILS:'admin@example.com'},sendEmail:async mail=>mails.push(mail),...overrides});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${app.server.address().port}`;t.after(()=>new Promise(r=>app.server.close(r)));
 function client(){const jar=new Map();return {jar,async request(path,method='GET',body,extra={}){const response=await fetch(url+path,{method,headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{}),Cookie:[...jar].map(([k,v])=>`${k}=${v}`).join('; '),...extra},body:body?JSON.stringify(body):undefined});for(const c of response.headers.getSetCookie()){const [key,value]=c.split(';')[0].split('=');jar.set(key,value);}const payload=await response.json();return {status:response.status,body:payload,headers:response.headers};}};}
 async function login(email,name='Alex',kind='solo') {const c=client();assert.equal((await c.request('/api/auth/start','POST',{email})).status,200);const token=mails.at(-1).link.split('#')[1];assert.equal((await c.request('/api/auth/verify','POST',{token})).status,200);assert.equal((await c.request('/api/profile','PUT',{name,kind,bio:'I enjoy unhurried days, local food and good conversation.',interests:'Gardens, food, art',languages:'English, Portuguese',pace:'easy'})).status,200);c.user=(await c.request('/api/me')).body.user;return c;}
 return {...app,mails,client,login,url};
}
test('magic links are hashed, browser-bound, one-use, expiring; sessions revoke on logout',async t=>{
 const {client,mails,db}=await setup(t);const a=client(),b=client();
 assert.equal((await a.request('/api/auth/start','POST',{email:'alex@example.com'})).status,200);
 const token=mails[0].link.split('#')[1],stored=db.prepare('SELECT * FROM tokens').get();assert.notEqual(stored.digest,token);assert.equal(stored.digest.length,64);
 assert.equal((await b.request('/api/auth/verify','POST',{token})).status,400);
 assert.equal((await a.request('/api/auth/verify','POST',{token})).status,200);
 assert.equal((await a.request('/api/auth/verify','POST',{token})).status,400);
 assert.equal((await a.request('/api/me')).body.user.email,'alex@example.com');
 const oldCookie=a.jar.get('sc_session');assert.notEqual(db.prepare('SELECT digest FROM sessions').get().digest,oldCookie);
 await a.request('/api/auth/logout','POST',{});a.jar.set('sc_session',oldCookie);assert.equal((await a.request('/api/me')).body.user,null);
 await b.request('/api/auth/start','POST',{email:'expiry@example.com'});db.prepare('UPDATE tokens SET expires=0').run();assert.equal((await b.request('/api/auth/verify','POST',{token:mails.at(-1).link.split('#')[1]})).status,400);
});
test('same-origin JSON safeguards, private profile fields and owner-only mutations',async t=>{
 const {login,client}=await setup(t);const owner=await login('owner@example.com'),stranger=await login('other@example.com'),anonymous=client();
 assert.equal((await owner.request('/api/plans','POST',validPlan,{Origin:'https://evil.example'})).status,403);
 assert.equal((await anonymous.request('/api/plans','POST',validPlan)).status,401);
 const created=await owner.request('/api/plans','POST',validPlan);assert.equal(created.status,201);const id=created.body.id;
 assert.equal((await stranger.request('/api/plans/'+id,'PUT',validPlan)).status,404);
 assert.equal((await stranger.request('/api/plans/'+id,'DELETE',{})).status,404);
 assert.equal((await anonymous.request('/api/profile','PUT',{})).status,401);
 const list=await anonymous.request('/api/plans');assert.equal(list.body.plans.length,1);assert.ok(!JSON.stringify(list.body).includes('owner@example.com'));assert.ok(!JSON.stringify((await anonymous.request('/api/plans/'+id)).body).includes('owner@example.com'));
 assert.equal((await owner.request('/api/plans/'+id,'PUT',{...validPlan,title:'An updated garden walk'})).status,200);
 assert.equal((await anonymous.request('/api/plans?destination=missing')).body.plans.length,0);
 assert.equal((await anonymous.request('/api/plans?destination=Porto&type=day&start='+future(9)+'&end='+future(12))).body.plans.length,1);
});
test('real request transitions, conversation isolation, accepted capacity and withdrawals',async t=>{
 const {login}=await setup(t);const owner=await login('owner@example.com','Owner'),couple=await login('couple@example.com','Kim & Pat','couple'),guest=await login('guest@example.com','Guest');
 const p=(await owner.request('/api/plans','POST',validPlan)).body.id;
 const r=(await couple.request(`/api/plans/${p}/requests`,'POST',{message:'We both love gardens and would love to join you.'})).body.id;
 const second=(await guest.request(`/api/plans/${p}/requests`,'POST',{message:'This sounds like a lovely day, may I join?'})).body.id;
 assert.equal((await guest.request(`/api/requests/${r}`)).status,404);
 assert.equal((await guest.request(`/api/requests/${r}/messages`,'POST',{message:'Intrusion'})).status,404);
 assert.equal((await couple.request(`/api/requests/${r}`,'PATCH',{status:'accepted'})).status,403);
 assert.equal((await owner.request(`/api/requests/${r}/messages`,'POST',{message:'Lovely to meet you both. Let us meet at the main gate.'})).status,201);
 assert.equal((await couple.request(`/api/requests/${r}`)).body.messages.length,2);
 assert.equal((await owner.request(`/api/requests/${r}`,'PATCH',{status:'accepted'})).status,200);
 assert.equal((await owner.request(`/api/requests/${second}`,'PATCH',{status:'accepted'})).status,409);
 assert.equal((await owner.request('/api/plans/'+p,'PUT',{...validPlan,start:future(11),end:future(11)})).status,409);
 assert.equal((await owner.request('/api/plans/'+p,'PUT',{...validPlan,seats:1})).status,409);
 assert.equal((await couple.request(`/api/requests/${r}`,'PATCH',{status:'cancelled'})).status,200);
 assert.equal((await owner.request(`/api/requests/${second}`,'PATCH',{status:'accepted'})).status,200);
 assert.equal((await couple.request(`/api/requests/${r}/messages`,'POST',{message:'After cancellation'})).status,409);
 assert.equal((await owner.request(`/api/requests/${r}`,'PATCH',{status:'accepted'})).status,409);
});
test('declining requests ends conversation and blocks prevent contact and public discovery',async t=>{
 const {login}=await setup(t);const owner=await login('owner@example.com'),guest=await login('guest@example.com');
 const p=(await owner.request('/api/plans','POST',validPlan)).body.id;
 const r=(await guest.request(`/api/plans/${p}/requests`,'POST',{message:'Would love to join your garden outing.'})).body.id;
 assert.equal((await owner.request(`/api/requests/${r}`,'PATCH',{status:'rejected'})).status,200);
 assert.equal((await guest.request(`/api/requests/${r}/messages`,'POST',{message:'More messages'})).status,409);
 assert.equal((await guest.request('/api/blocks','POST',{targetId:owner.user.id})).status,200);
 assert.equal((await guest.request('/api/plans')).body.plans.length,0);
 assert.equal((await guest.request('/api/plans/'+p)).status,404);
 assert.equal((await owner.request(`/api/requests/${r}`)).body.blocked,true);
 assert.equal((await guest.request('/api/blocks','DELETE',{targetId:owner.user.id})).status,200);
 assert.equal((await guest.request('/api/plans')).body.plans.length,1);
});
test('moderation is admin-only, suspension revokes sessions and hides plans',async t=>{
 const {login}=await setup(t);const admin=await login('admin@example.com'),member=await login('member@example.com'),reporter=await login('reporter@example.com');
 await member.request('/api/plans','POST',validPlan);
 const report=await reporter.request('/api/reports','POST',{targetId:member.user.id,reason:'This member repeatedly requested payment in advance.'});assert.equal(report.status,201);
 assert.equal((await member.request('/api/admin/reports')).status,403);
 const reports=(await admin.request('/api/admin/reports')).body.reports;assert.equal(reports.length,1);
 assert.equal((await admin.request('/api/admin/reports/'+reports[0].id,'PATCH',{action:'suspend'})).status,200);
 assert.equal((await member.request('/api/me')).body.user,null);
 assert.equal((await reporter.request('/api/plans')).body.plans.length,0);
 assert.equal((await admin.request('/api/admin/reports/'+reports[0].id,'PATCH',{action:'restore'})).status,200);
 assert.equal((await reporter.request('/api/plans')).body.plans.length,1);
});
test('date and plan validation, authentication throttling and disabled email are explicit',async t=>{
 const {login,client}=await setup(t);const c=await login('a@example.com');
 for(const invalid of [{...validPlan,start:'2026-02-30'},{...validPlan,end:future(12)},{...validPlan,seats:20},{...validPlan,type:'trip',end:future(45)}])assert.equal((await c.request('/api/plans','POST',invalid)).status,400);
 const a=client();for(let i=0;i<4;i++)assert.equal((await a.request('/api/auth/start','POST',{email:'rate@example.com'})).status,200);
 assert.equal((await a.request('/api/auth/start','POST',{email:'rate@example.com'})).status,429);
 const disabled=await setup(t,{sendEmail:undefined});assert.equal((await disabled.client().request('/api/auth/start','POST',{email:'no@example.com'})).status,503);
 assert.throws(()=>createApp({databasePath:':memory:',env:{NODE_ENV:'production',APP_URL:'https://example.com',DEV_EMAIL_CONSOLE:'1'}}),/Development email/);
});
test('account and plan deletion cascade while report identity is removed',async t=>{
 const {login,db}=await setup(t);const owner=await login('owner@example.com'),guest=await login('guest@example.com');
 const p=(await owner.request('/api/plans','POST',validPlan)).body.id;
 const r=(await guest.request(`/api/plans/${p}/requests`,'POST',{message:'We would love to join this outing.'})).body.id;
 await guest.request('/api/reports','POST',{targetId:owner.user.id,reason:'A report retained for review after account deletion.'});
 assert.equal((await owner.request('/api/account','DELETE',{})).status,200);
 assert.equal((await guest.request(`/api/requests/${r}`)).status,404);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,0);
 assert.equal(db.prepare('SELECT target_id FROM reports').get().target_id,null);
});
test('SQLite data survives a process-style close and reopen',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'some-company-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));const path=join(dir,'app.sqlite');
 const env={APP_URL:origin,NODE_ENV:'test',DEV_EMAIL_CONSOLE:'0'};
 let app=createApp({databasePath:path,env});app.db.prepare('INSERT INTO users(email,created) VALUES (?,?)').run('persistent@example.com',Date.now());await new Promise(r=>app.server.close(r));
 app=createApp({databasePath:path,env});assert.equal(app.db.prepare('SELECT email FROM users').get().email,'persistent@example.com');await new Promise(r=>app.server.close(r));
});
