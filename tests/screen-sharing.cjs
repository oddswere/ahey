const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function track(kind, source) {
 return {kind, source, enabled: true, readyState: 'live', stop() { this.readyState = 'ended'; }};
}

function stream(...tracks) {
 return {
  getTracks: () => [...tracks],
  getVideoTracks: () => tracks.filter(item => item.kind === 'video'),
  getAudioTracks: () => tracks.filter(item => item.kind === 'audio'),
  removeTrack(item) { tracks = tracks.filter(existing => existing !== item); },
  addTrack(item) { tracks.push(item); },
 };
}

function mediaApp(cameraEnabled) {
 let options;
 const cameraRequests = [], errors = [];
 const screen = track('video', 'screen');
 const camera = track('video', 'camera');
 const microphone = track('audio', 'microphone');
 const mediaDevices = {
  async getDisplayMedia() { return stream(screen); },
  async getUserMedia(constraints) { cameraRequests.push(constraints); return stream(camera); },
 };
 const context = {
  Vue: {createApp(value) { options = value; return {mount() {}}; }},
  window: {location: {pathname: '/one', search: ''}, localStorage: {}},
  navigator: {mediaDevices}, URLSearchParams,
  console: {error(...args) { errors.push(args); }},
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
 const app = options.data();
 for (const [key, method] of Object.entries(options.methods)) app[key] = method.bind(app);
 for (const [key, getter] of Object.entries(options.computed)) {
  Object.defineProperty(app, key, {get: () => getter.call(app)});
 }
 app.callInitiated = true;
 app.videoEnabled = cameraEnabled;
 app.selectedVideoDeviceId = 'chosen-camera';
 app.setToast = () => {};
 app.getBlankTrack = kind => track(kind, 'blank');
 app.localMediaStream = stream(microphone, track('video', cameraEnabled ? 'camera' : 'blank'));
 const sender = {track: app.localMediaStream.getVideoTracks()[0], replaceTrack(value) { this.track = value; }};
 app.peers = {other: {rtc: {getSenders: () => [sender]}}};
 return {app, mediaDevices, cameraRequests, screen, camera, microphone, sender, errors};
}

const flush = () => new Promise(resolve => setImmediate(resolve));

for (const stopWith of ['app button', 'browser button']) {
 for (const cameraEnabled of [false, true]) {
  test(`stopping sharing with ${stopWith} preserves camera ${cameraEnabled ? 'on' : 'off'}`, async () => {
   const {app, cameraRequests, screen, microphone, sender, errors} = mediaApp(cameraEnabled);
   app.toggleScreenShare();
   await flush();
   assert.equal(app.isScreenSharing, true);
   assert.equal(app.hasVideo, true);
   assert.equal(app.videoEnabled, cameraEnabled);
   assert.equal(sender.track, screen);

   if (stopWith === 'app button') app.toggleScreenShare();
   else screen.onended();
   await flush();

   assert.equal(app.isScreenSharing, false);
   assert.equal(app.screenShareStream, null);
   assert.equal(app.videoEnabled, cameraEnabled);
   assert.equal(app.hasVideo, cameraEnabled);
   assert.equal(cameraRequests.length, cameraEnabled ? 1 : 0);
   if (cameraEnabled) assert.equal(cameraRequests[0].video.deviceId.exact, 'chosen-camera');
   assert.equal(sender.track.source, cameraEnabled ? 'camera' : 'blank');
   assert.equal(app.localMediaStream.getVideoTracks()[0], sender.track);
   assert.equal(screen.readyState, 'ended');
   assert.equal(app.localMediaStream.getAudioTracks()[0], microphone);
   assert.equal(microphone.readyState, 'live');
   assert.equal(errors.length, 0);
  });
 }
}

test('duplicate stop notifications do not request the camera twice', async () => {
 const {app, cameraRequests} = mediaApp(true);
 await app.startScreenShare();
 await Promise.all([app.stopScreenShare(), app.stopScreenShare()]);
 assert.equal(cameraRequests.length, 1);
});

test('turning the camera off during restoration never publishes the pending camera track', async () => {
 const {app, mediaDevices, camera, sender} = mediaApp(true);
 await app.startScreenShare();
 let resolveCamera;
 mediaDevices.getUserMedia = () => new Promise(resolve => { resolveCamera = resolve; });
 const stopping = app.stopScreenShare();
 await app.toggleVideo();
 assert.equal(app.videoEnabled, false);
 resolveCamera(stream(camera));
 await stopping;
 assert.equal(camera.readyState, 'ended');
 assert.equal(sender.track.source, 'blank');
 assert.equal(app.localMediaStream.getVideoTracks()[0].source, 'blank');
 assert.equal(app.hasVideo, false);
});

test('canceling screen selection keeps the camera off without requesting it', async () => {
 const {app, mediaDevices, cameraRequests, sender} = mediaApp(false);
 mediaDevices.getDisplayMedia = async () => { throw Object.assign(new Error('Canceled'), {name: 'AbortError'}); };
 await app.startScreenShare();
 assert.equal(app.isScreenSharing, false);
 assert.equal(app.videoEnabled, false);
 assert.equal(cameraRequests.length, 0);
 assert.equal(sender.track.source, 'blank');
});
