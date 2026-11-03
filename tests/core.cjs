const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function signalling(now = Date.now) {
 const context = { Date: {now}, module: {exports:{}}, console: {log(){}}, require(name) {
  if(name === './utils') return require('../server/utils');
  if(name === './services/conferences') return {getConferenceById: id => ['one','two'].includes(id)};
  throw Error(name);
 }};
 vm.runInNewContext(fs.readFileSync(path.join(root,'server/signalling-server.js'),'utf8'),context);
 return context.module.exports;
}
test('conference validation, member-only relay, metadata and disconnect', () => {
 const connect=signalling();
 const client=id=>{const handlers={},events=[];const socket={id,on:(n,f)=>handlers[n]=f,emit:(n,p)=>events.push([n,p])};connect(socket);return {handlers,events}};
 const a=client('a'),b=client('b'),c=client('c');
 for(const input of [null,{}, {channel:'__proto__'},{channel:'missing'}]) a.handlers.join(input);
 assert.equal(a.events.length,0);
 a.handlers.join({channel:'one',userData:{peerName:'A'}});
 b.handlers.join({channel:'one',userData:{peerName:'B'}});
 c.handlers.join({channel:'two'});
 assert.equal(a.events[1][0],'addPeer');
 c.handlers.relaySessionDescription({peer_id:'a',session_description:{type:'offer'}});
 assert.equal(a.events.length,2);
 b.handlers.relayICECandidate({peer_id:'a',ice_candidate:{candidate:'test'}});
 assert.equal(a.events.at(-1)[0],'iceCandidate');
 a.handlers.updateUserData({channel:'one',key:'peerName',value:'Updated'});
 assert.equal(b.events[0][1].channel.a.userData.peerName,'Updated');
 a.handlers.updateUserData({channel:'one',key:'__proto__',value:{polluted:true}});
 assert.equal({}.polluted,undefined);
 b.handlers.disconnect();
 assert.equal(a.events.at(-1)[0],'removePeer');
 a.handlers.disconnect();c.handlers.disconnect();
 const d=client('d'); d.handlers.join({channel:'one'});assert.equal(d.events.length,1);assert.equal(d.events[0][0],'callStarted');
});
test('call start is shared with late joiners and reconnects, and resets when the room empties', () => {
 let now = 1000;
 const connect = signalling(() => now);
 const client = id => {
  const handlers = {}, events = [];
  connect({id, on: (name, handler) => handlers[name] = handler, emit: (name, payload) => events.push([name, payload])});
  return {handlers, events, start: () => events.find(([name]) => name === 'callStarted')?.[1]};
 };
 const a = client('a'), b = client('b'), c = client('c');
 assert.equal(a.start(), undefined);
 a.handlers.join({channel: 'one'});
 assert.equal(a.start().startedAt, 1000);
 now = 61000;
 b.handlers.join({channel: 'one', startedAt: now});
 assert.equal(b.start().startedAt, 1000);
 assert.equal(b.start().serverNow, 61000);
 c.handlers.join({channel: 'two'});
 assert.equal(c.start().startedAt, 61000);
 const eventCount = b.events.length;
 b.handlers.join({channel: 'one'});
 assert.equal(b.events.length, eventCount);
 a.handlers.disconnect();
 now = 121000;
 const reconnected = client('a2');
 reconnected.handlers.join({channel: 'one'});
 assert.equal(reconnected.start().startedAt, 1000);
 b.handlers.disconnect();
 reconnected.handlers.disconnect();
 now = 181000;
 const next = client('next');
 next.handlers.join({channel: 'one'});
 assert.equal(next.start().startedAt, 181000);
 next.handlers.disconnect();
 c.handlers.disconnect();
});
test('no inherited four-person limit',()=>{
 const connect=signalling();let additions=0;
 for(let i=0;i<6;i++){const handlers={};connect({id:String(i),on:(n,f)=>handlers[n]=f,emit:n=>{if(n==='addPeer')additions++}});handlers.join({channel:'one'})}
 assert.equal(additions,30);
});
test('TURN credentials expire and match HMAC; secret never leaves server',()=>{
 const config={TURN_SECRET:'test-secret',TURN_TTL:600,TURN_URLS:['turn:localhost:3478']};
 const context={module:{exports:{}},process:{env:{}},require:n=>n==='crypto'?crypto:config};
 vm.runInNewContext(fs.readFileSync(path.join(root,'server/turn.js'),'utf8'),context);
 const servers=context.module.exports.getIceServers(),turn=servers.at(-1);
 assert.equal(turn.credential,crypto.createHmac('sha1',config.TURN_SECRET).update(turn.username).digest('base64'));
 assert.ok(Number(turn.username)>Date.now()/1000+590);
 assert.ok(!JSON.stringify(servers).includes(config.TURN_SECRET));
 config.TURN_SECRET='';assert.ok(context.module.exports.getIceServers().every(s=>s.urls.startsWith('stun:')));
});
