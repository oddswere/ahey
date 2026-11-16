const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { reactive, computed } = require('vue');

const flush = () => new Promise(resolve => setImmediate(resolve));

function track(kind) {
 return {kind, readyState: 'live', stop() { this.readyState = 'ended'; }};
}

class MediaStream {
 constructor(tracks) { this.tracks = tracks; }
 getTracks() { return [...this.tracks]; }
 getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
 getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
}

function callApp() {
 const requests = [], sockets = [], messages = [], errors = [];
 const preview = {};
 let app;
 const context = {
  Vue: {createApp(options) { return {mount() {
   app = reactive(options.data());
   for (const [name, method] of Object.entries(options.methods)) app[name] = method.bind(app);
   for (const [name, getter] of Object.entries(options.computed)) {
    const value = computed(() => getter.call(app));
    Object.defineProperty(app, name, {get: () => value.value});
   }
   return app;
  }}; }},
  window: {location: {pathname: '/one', search: '?name=Alice'}, localStorage: {}},
  document: {getElementById: () => preview},
  navigator: {userAgent: 'test', mediaDevices: {
   getUserMedia(constraints) {
    return new Promise((resolve, reject) => requests.push({constraints, resolve, reject}));
   },
   async enumerateDevices() { return []; },
  }},
  MediaStream, URLSearchParams, clearInterval, ICE_SERVERS: [],
  console: {error: (...args) => errors.push(args)},
  io() {
   const handlers = {}, events = [];
   const socket = {
    connected: false, handlers, events,
    on(name, handler) { handlers[name] = handler; },
    emit(name, data) { events.push([name, data]); },
    connect(id = 'self') { this.id = id; this.connected = true; return handlers.connect(); },
    disconnect() { this.connected = false; handlers.disconnect(); },
   };
   sockets.push(socket);
   return socket;
  },
 };
 for (const file of ['app.js', 'peer.js']) {
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public', file), 'utf8'), context);
 }
 app.getBlankTrack = track;
 app.setToast = message => messages.push(message);
 const joins = socket => socket.events.filter(([name]) => name === 'join').map(([, data]) => data);
 return {app, requests, sockets, messages, errors, preview, joins};
}

test('joining during a denied preview request still joins once with the camera off', async () => {
 const {app, requests, sockets, joins, errors} = callApp();
 app.getPreCallMedia();
 await flush();
 app.initiateCall();
 const joined = sockets[0].connect();
 await flush();
 assert.equal(requests.length, 1, 'joining must reuse the pending permission request');
 assert.equal(joins(sockets[0]).length, 0);
 requests[0].reject(new Error('Permission denied'));
 await joined;
 assert.equal(joins(sockets[0]).length, 1);
 assert.equal(joins(sockets[0])[0].userData.hasVideo, false);
 assert.equal(app.audioEnabled, false);
 assert.equal(app.videoEnabled, false);
 assert.ok(app.localMediaStream.getTracks().every(track => track.readyState === 'live'));
 assert.equal(errors.length, 0);
});

test('first join shares the preview stream and repeated clicks do not create another socket', async () => {
 const {app, requests, sockets, joins, preview} = callApp();
 app.getPreCallMedia();
 app.initiateCall();
 app.initiateCall();
 assert.equal(sockets.length, 1);
 const joined = sockets[0].connect();
 await flush();
 assert.equal(requests.length, 1);
 requests[0].resolve(new MediaStream([track('audio'), track('video')]));
 await joined;
 assert.equal(joins(sockets[0]).length, 1);
 assert.equal(joins(sockets[0])[0].userData.hasVideo, true);
 assert.equal(preview.srcObject, app.localMediaStream);
 assert.ok(app.localMediaStream.getTracks().every(track => track.readyState === 'live'));
});

test('joining with both devices off does not request permissions', async () => {
 const {app, requests, sockets, joins, messages} = callApp();
 app.audioEnabled = false;
 app.videoEnabled = false;
 app.initiateCall();
 await sockets[0].connect();
 assert.equal(requests.length, 0);
 assert.equal(joins(sockets[0]).length, 1);
 assert.equal(joins(sockets[0])[0].userData.hasVideo, false);
 assert.equal(messages.length, 0);
});

test('join waits for newer preview settings and never publishes the superseded stream', async () => {
 const {app, requests, sockets, joins} = callApp();
 app.getPreCallMedia();
 await flush();
 app.initiateCall();
 const joined = sockets[0].connect();
 app.togglePreCallVideo();
 const previous = new MediaStream([track('audio'), track('video')]);
 requests[0].resolve(previous);
 await flush();
 assert.equal(requests.length, 2);
 assert.equal(requests[1].constraints.video, false);
 assert.equal(joins(sockets[0]).length, 0);
 assert.ok(previous.getTracks().every(track => track.readyState === 'ended'));
 requests[1].resolve(new MediaStream([track('audio')]));
 await joined;
 assert.equal(joins(sockets[0]).length, 1);
 assert.equal(joins(sockets[0])[0].userData.hasVideo, false);
 assert.equal(app.localMediaStream.getVideoTracks().length, 0);
});

test('leaving and rejoining during a permission request joins only the new call', async () => {
 const {app, requests, sockets, joins} = callApp();
 app.getPreCallMedia();
 await flush();
 app.initiateCall();
 const abandonedJoin = sockets[0].connect('old');
 app.endCall();
 app.initiateCall();
 const currentJoin = sockets[1].connect('new');
 requests[0].resolve(new MediaStream([track('audio'), track('video')]));
 await flush();
 assert.equal(requests.length, 2);
 assert.equal(joins(sockets[0]).length, 0);
 assert.equal(joins(sockets[1]).length, 0);
 requests[1].resolve(new MediaStream([track('audio'), track('video')]));
 await Promise.all([abandonedJoin, currentJoin]);
 assert.equal(joins(sockets[0]).length, 0);
 assert.equal(joins(sockets[1]).length, 1);
 assert.ok(app.localMediaStream.getTracks().every(track => track.readyState === 'live'));
});

test('a signalling reconnect during media setup cannot submit a stale join', async () => {
 const {app, requests, sockets, joins} = callApp();
 app.initiateCall();
 const previous = sockets[0].connect('old');
 sockets[0].disconnect();
 const current = sockets[0].connect('new');
 await flush();
 assert.equal(requests.length, 1);
 requests[0].resolve(new MediaStream([track('audio'), track('video')]));
 await Promise.all([previous, current]);
 assert.equal(joins(sockets[0]).length, 1);
 assert.equal(app.peerId, 'new');
});
