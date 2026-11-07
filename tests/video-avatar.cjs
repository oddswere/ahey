const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { reactive, computed, watch, nextTick } = require('vue');

function videoApp() {
 const events = [], handlers = {};
 const socket = {id: 'self', on: (key, handler) => handlers[key] = handler,
  emit: (key, data) => events.push([key, JSON.parse(JSON.stringify(data))])};
 let app;
 const context = {
  Vue: {createApp(options) { return {mount() {
   app = reactive(options.data());
   for (const [key, method] of Object.entries(options.methods)) app[key] = method.bind(app);
   for (const [key, getter] of Object.entries(options.computed)) {
    const value = computed(() => getter.call(app));
    Object.defineProperty(app, key, {get: () => value.value});
   }
   watch(() => app.hasVideo, options.watch.hasVideo.bind(app));
   return app;
  }}; }},
  window: {location: {pathname: '/one', search: ''}, localStorage: {}},
  navigator: {userAgent: 'test', mediaDevices: {getUserMedia() { throw Error('Unexpected camera access'); }}},
  URLSearchParams, console, io: () => socket, ICE_SERVERS: [],
  RTCPeerConnection: class { createDataChannel() { return {readyState: 'connecting'}; } },
 };
 for (const file of ['app.js', 'peer.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
 }
 return {app, context, events, handlers};
}

test('avatar uses the first trimmed name character, including Cyrillic and Unicode', () => {
 const {app} = videoApp();
 assert.equal(app.nameInitial(' alice Smith '), 'A');
 assert.equal(app.nameInitial('иван'), 'И');
 assert.equal(app.nameInitial('😀 Alex'), '😀');
 assert.equal(app.nameInitial('  '), '?');
 assert.equal(app.nameInitial(undefined), '?');
});

test('camera changes reach connected peers and refresh metadata for late joiners', async () => {
 const {app, context, events, handlers} = videoApp();
 const messages = [];
 app.name = 'Alice';
 app.videoEnabled = false;
 await nextTick();
 app.callInitiated = true;
 app.localMediaStream = {getTracks: () => []};
 context.window.initiateCall();
 handlers.connect();
 assert.equal(events.find(([key]) => key === 'join')[1].userData.hasVideo, false);
 handlers.addPeer({peer_id: 'other', channel: {other: {userData: {peerName: 'Bob', userAgent: 'test', hasVideo: false}}}});
 assert.equal(app.peersArray[0].hasVideo, false);
 app.dataChannels.closed = {readyState: 'closed', send() { assert.fail('closed channel used'); }};
 app.videoEnabled = true;
 await nextTick(); // Connecting channels must also be skipped.
 const channel = app.dataChannels.other;
 channel.readyState = 'open';
 channel.send = message => messages.push(JSON.parse(message));
 channel.onopen();
 assert.equal(messages.at(-1).message, true);
 app.videoEnabled = false;
 await nextTick();
 assert.equal(messages.at(-1).message, false);
 assert.deepEqual(events.at(-1), ['updateUserData', {channel: 'one', key: 'hasVideo', value: false}]);
 app.handleIncomingDataChannelMessage({peerId: 'other', type: 'hasVideo', message: true});
 assert.equal(app.peersArray[0].hasVideo, true);
 app.handleIncomingDataChannelMessage({peerId: 'other', type: 'hasVideo', message: false});
 assert.equal(app.peersArray[0].hasVideo, false);
 app.handleIncomingDataChannelMessage({peerId: 'other', type: 'peerName', message: 'Charlie'});
 assert.equal(app.nameInitial(app.peersArray[0].name), 'C');
});

test('screen sharing remains visible with camera off and returns to the avatar when stopped', async () => {
 const {app} = videoApp();
 app.videoEnabled = false;
 assert.equal(app.hasVideo, false);
 let stopped = false, replaced = false;
 app.screenShareStream = {getTracks: () => [{stop() { stopped = true; }}]};
 app.isScreenSharing = true;
 assert.equal(app.hasVideo, true);
 app.removeMediaTrack = kind => { assert.equal(kind, 'video'); replaced = true; };
 await app.stopScreenShare();
 assert.equal(app.hasVideo, false);
 assert.equal(stopped, true);
 assert.equal(replaced, true);
});
