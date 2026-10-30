import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createAuthRoutes } from './auth-routes.mjs';

function fixture(service) {
  let time=0;
  const handle=createAuthRoutes({service,now:()=>time});
  return {advance:()=>{time+=600001},async request(path,{method='GET',body,origin,type='application/json'}={}){
    const request=Readable.from(body===undefined?[]:[typeof body==='string'?body:JSON.stringify(body)]);
    Object.assign(request,{method,headers:{host:'localhost',...(origin?{origin}:{}),'content-type':type},socket:{remoteAddress:'127.0.0.1'}});
    const headers={};let status,output;
    const response={setHeader(k,v){headers[k.toLowerCase()]=v},writeHead(s,h){status=s;for(const [k,v]of Object.entries(h||{}))headers[k.toLowerCase()]=v},end(v){output=v}};
    const handled=await handle(request,response,new URL(path,'http://localhost'));
    return {handled,status,data:output?JSON.parse(output):null,headers};
  }};
}

test('unconfigured live auth exposes a clear setup state and does not accept sign-in',async()=>{
  const app=fixture({configured:false,setupState:()=>({missing:['secret-do-not-return']})});
  const me=await app.request('/api/auth/me');assert.equal(me.status,200);assert.equal(me.data.configured,false);assert.equal(me.data.user,null);assert.ok(!JSON.stringify(me.data).includes('secret-do-not-return'));
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:{}})).status,503);
});
test('auth router rejects cross-origin credential posts before calling the provider',async()=>{
  let called=false;const app=fixture({configured:true,signIn:()=>{called=true}});
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',origin:'https://other.example',body:{}})).status,403);assert.equal(called,false);
});
test('auth tokens and cookies never appear in response JSON',async()=>{
  const app=fixture({configured:true,signIn:async()=>({user:{id:'u',email:'organiser@example.com',name:'Organiser',access_token:'hidden'},setCookie:'cr_auth=encrypted; HttpOnly',session:{access_token:'hidden'}})});
  const r=await app.request('/api/auth/sign-in',{method:'POST',body:{email:'organiser@example.com',password:'not-logged'}});
  assert.equal(r.status,200);assert.equal(r.headers['set-cookie'],'cr_auth=encrypted; HttpOnly');assert.deepEqual(Object.keys(r.data.user).sort(),['email','id','name']);assert.ok(!JSON.stringify(r.data).includes('hidden'));assert.ok(!JSON.stringify(r.data).includes('encrypted'));
});
test('auth routes enforce method, content type and valid object bodies',async()=>{
  const app=fixture({configured:true});
  assert.equal((await app.request('/api/auth/sign-in')).status,405);
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:'{}',type:'text/plain'})).status,415);
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:'not-json'})).status,400);
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:[]})).status,400);
});
test('provider failures clear only explicitly supplied expired cookies',async()=>{
  const app=fixture({configured:true,currentUser:async()=>{throw Object.assign(new Error('Session ended'),{status:401,code:'session_invalid',setCookie:'cr_auth=; Max-Age=0'})}});
  const r=await app.request('/api/auth/me');assert.equal(r.status,401);assert.equal(r.headers['set-cookie'],'cr_auth=; Max-Age=0');
});
test('account attempt rate limiting expires and never repeats excess provider calls',async()=>{
  let count=0;const app=fixture({configured:true,signIn:async()=>{count++;return {user:null}}});
  for(let i=0;i<12;i++)assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:{}})).status,200);
  assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:{}})).status,429);assert.equal(count,12);
  app.advance();assert.equal((await app.request('/api/auth/sign-in',{method:'POST',body:{}})).status,200);assert.equal(count,13);
});
test('unrelated app routes are left to their own authorization handlers',async()=>{
  const r=await fixture({configured:true}).request('/api/state');assert.equal(r.handled,false);assert.equal(r.status,undefined);
});
