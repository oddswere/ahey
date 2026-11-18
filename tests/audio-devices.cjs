const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const flush = () => new Promise(resolve => setImmediate(resolve));
function track(kind, deviceId) {
 return {kind, enabled: true, readyState: 'live', getSettings: () => ({deviceId}),
  stop() { this.readyState = 'ended'; }};
}
class MediaStream {
 constructor(tracks = []) { this.tracks = tracks; }
 getTracks() { return [...this.tracks]; }
 getAudioTracks() { return this.tracks.filter(track => track.kind === 'audio'); }
 getVideoTracks() { return this.tracks.filter(track => track.kind === 'video'); }
 addTrack(track) { this.tracks.push(track); }
 removeTrack(track) { this.tracks = this.tracks.filter(item => item !== track); }
}
function output() {
 return {sinkId: '', calls: [], async setSinkId(id) { this.calls.push(id); this.sinkId = id; }};
}
function mediaApp() {
 let options;
 const requests = [], messages = [], remote = [], probe = output(), preview = {};
 const devices = [
  {kind: 'audioinput', deviceId: 'mic-a'}, {kind: 'audioinput', deviceId: 'mic-b'},
  {kind: 'audiooutput', deviceId: 'speakers'}, {kind: 'audiooutput', deviceId: 'headphones'},
  {kind: 'videoinput', deviceId: 'camera'},
 ];
 const mediaDevices = {
  async enumerateDevices() { return devices; },
  getUserMedia(constraints) { return new Promise((resolve, reject) => requests.push({constraints, resolve, reject})); },
 };
 const context = {
  Vue: {createApp(value) { options = value; return {mount() {}}; }},
  window: {location: {pathname: '/one', search: ''}, localStorage: {}, HTMLMediaElement: {prototype: {setSinkId() {}}}},
  document: {getElementById: () => preview, querySelectorAll: () => remote, createElement: () => probe},
  navigator: {mediaDevices}, MediaStream, URLSearchParams, console,
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
 const app = options.data();
 for (const [key, method] of Object.entries(options.methods)) app[key] = method.bind(app);
 for (const [key, getter] of Object.entries(options.computed)) Object.defineProperty(app, key, {get: () => getter.call(app)});
 app.setToast = (message, type) => messages.push({message, type});
 app.getBlankTrack = kind => track(kind, 'blank');
 const microphone = track('audio', 'mic-a'), camera = track('video', 'camera');
 app.localMediaStream = new MediaStream([microphone, camera]);
 app.selectedAudioDeviceId = 'mic-a';
 app.selectedVideoDeviceId = 'camera';
 const senders = [0, 1].map(() => ({track: microphone, async replaceTrack(track) { this.track = track; }}));
 app.peers = Object.fromEntries(senders.map((sender, i) => [i, {rtc: {getSenders: () => [sender]}}]));
 return {app, requests, messages, remote, probe, preview, devices, mediaDevices, microphone, camera, senders, context};
}

test('rendered input and output selectors invoke device switching', async () => {
 const {app, requests, remote, mediaDevices} = mediaApp();
 await app.enumerateDevices();
 app.showExtraControls = true;
 app.showAudioDevices = true;
 const template = fs.readFileSync(path.join(__dirname, '../views/channel.ejs'), 'utf8')
  .match(/<section id="extra"[\s\S]*?<\/section>/)[0];
 const {code} = require('@vue/compiler-dom').compile(template);
 const render = new Function('Vue', code)(require('vue'));
 const tree = render(app, []);
 const find = (node, id) => node?.props?.id === id ? node
  : Array.isArray(node?.children) ? node.children.map(child => find(child, id)).find(Boolean) : undefined;
 const input = find(tree, 'audio-input');
 assert.ok(input);
 input.props.onChange({target: {value: 'mic-b'}});
 await flush();
 assert.equal(requests[0].constraints.audio.deviceId.exact, 'mic-b');
 requests[0].resolve(new MediaStream([track('audio', 'mic-b')]));
 await app.ensureLocalMedia();
 assert.equal(app.selectedAudioDeviceId, 'mic-b');
 remote.push(output());
 const speakers = find(tree, 'audio-output');
 assert.ok(speakers);
 await speakers.props.onChange({target: {value: 'headphones'}});
 assert.equal(remote[0].sinkId, 'headphones');

 let pickerCalled = false;
 mediaDevices.selectAudioOutput = async () => {
  pickerCalled = true;
  throw Object.assign(new Error('Cancelled'), {name: 'NotAllowedError'});
 };
 const updatedSpeakers = find(render(app, []), 'audio-output');
 const otherDevice = updatedSpeakers.children.find(child => child.type === 'option' && child.children === 'Другое устройство…');
 assert.ok(otherDevice);
 const target = {value: otherDevice.props.value};
 const choosing = updatedSpeakers.props.onChange({target});
 assert.equal(pickerCalled, true, 'picker must run within the dropdown interaction');
 assert.equal(target.value, 'headphones', 'keep the active device visible while choosing');
 await choosing;
 assert.equal(app.selectedAudioOutputDeviceId, 'headphones');
 assert.equal(remote[0].sinkId, 'headphones');
 assert.equal(target.value, 'headphones', 'cancelling must not leave the picker action selected');
});

for (const inCall of [false, true]) {
 test(`microphone selection replaces the actual track ${inCall ? 'during a call' : 'in the preview'}`, async () => {
  const {app, requests, microphone, camera, senders, preview} = mediaApp();
  app.callInitiated = inCall;
  const switching = app.switchAudioDevice('mic-b');
  await flush();
  assert.equal(requests[0].constraints.audio.deviceId.exact, 'mic-b');
  assert.equal(requests[0].constraints.video, false);
  assert.equal(microphone.readyState, 'live', 'keep the original mic until the replacement is ready');
  const next = track('audio', 'mic-b');
  requests[0].resolve(new MediaStream([next]));
  await switching;
  assert.equal(app.selectedAudioDeviceId, 'mic-b');
  assert.equal(app.localMediaStream.getAudioTracks()[0], next);
  assert.ok(senders.every(sender => sender.track === next));
  assert.equal(microphone.readyState, 'ended');
  assert.equal(camera.readyState, 'live');
  assert.equal(preview.srcObject, app.localMediaStream);
 });
}

test('choosing a microphone while muted keeps it off and uses it on unmute', async () => {
 const {app, requests, senders} = mediaApp();
 app.callInitiated = true;
 await app.toggleAudio();
 await app.switchAudioDevice('mic-b');
 assert.equal(app.audioEnabled, false);
 assert.equal(requests.length, 0);
 assert.equal(app.selectedAudioDeviceId, 'mic-b');
 const unmuting = app.toggleAudio();
 assert.equal(requests[0].constraints.audio.deviceId.exact, 'mic-b');
 const next = track('audio', 'mic-b');
 requests[0].resolve(new MediaStream([next]));
 await unmuting;
 assert.equal(app.audioEnabled, true);
 assert.ok(senders.every(sender => sender.track === next));
});

test('permission failure retains the working microphone and selection', async () => {
 const {app, requests, microphone, senders, messages} = mediaApp();
 const switching = app.switchAudioDevice('missing');
 await flush();
 requests[0].reject(new Error('Permission denied'));
 await switching;
 assert.equal(app.selectedAudioDeviceId, 'mic-a');
 assert.equal(microphone.readyState, 'live');
 assert.ok(senders.every(sender => sender.track === microphone));
 assert.notEqual(messages.at(-1).type, 'success');
});

test('peer replacement failure restores all senders and releases the new microphone', async () => {
 const {app, requests, microphone, senders} = mediaApp();
 const next = track('audio', 'mic-b');
 senders[1].replaceTrack = async function(value) { if (value === next) throw Error('replaceTrack failed'); this.track = value; };
 const switching = app.switchAudioDevice('mic-b');
 await flush();
 requests[0].resolve(new MediaStream([next]));
 await switching;
 assert.ok(senders.every(sender => sender.track === microphone));
 assert.equal(app.localMediaStream.getAudioTracks()[0], microphone);
 assert.equal(app.selectedAudioDeviceId, 'mic-a');
 assert.equal(microphone.readyState, 'live');
 assert.equal(next.readyState, 'ended');
});

test('rapid selections discard stale microphone streams and joining waits for the latest', async () => {
 const {app, requests, senders} = mediaApp();
 app.switchAudioDevice('mic-b');
 await flush();
 const latest = app.switchAudioDevice('mic-c');
 let joined = false;
 const joining = app.ensureLocalMedia().then(() => { joined = true; });
 const stale = track('audio', 'mic-b');
 requests[0].resolve(new MediaStream([stale]));
 await flush();
 assert.equal(stale.readyState, 'ended');
 assert.equal(joined, false);
 assert.equal(requests[1].constraints.audio.deviceId.exact, 'mic-c');
 const next = track('audio', 'mic-c');
 requests[1].resolve(new MediaStream([next]));
 await Promise.all([latest, joining]);
 assert.equal(joined, true);
 assert.equal(app.selectedAudioDeviceId, 'mic-c');
 assert.ok(senders.every(sender => sender.track === next));
});

test('muting during microphone acquisition cannot publish the pending track', async () => {
 const {app, requests, senders} = mediaApp();
 app.callInitiated = true;
 const switching = app.switchAudioDevice('mic-b');
 await flush();
 await app.toggleAudio();
 const next = track('audio', 'mic-b');
 requests[0].resolve(new MediaStream([next]));
 await switching;
 assert.equal(app.audioEnabled, false);
 assert.equal(next.readyState, 'ended');
 assert.ok(senders.every(sender => sender.track.getSettings().deviceId === 'blank'));
});

test('muting during sender replacement rolls the pending switch back to silence', async () => {
 const {app, requests, senders} = mediaApp();
 app.callInitiated = true;
 const next = track('audio', 'mic-b');
 let finish;
 senders[0].replaceTrack = async function(value) {
  if (value === next) await new Promise(resolve => { finish = resolve; });
  this.track = value;
 };
 const switching = app.switchAudioDevice('mic-b');
 await flush();
 requests[0].resolve(new MediaStream([next]));
 await flush();
 await app.toggleAudio();
 finish();
 await switching;
 assert.equal(app.audioEnabled, false);
 assert.equal(next.readyState, 'ended');
 assert.ok(senders.every(sender => sender.track.getSettings().deviceId === 'blank'));
});

test('camera selection during sharing preserves the shared screen', async () => {
 const {app, requests, camera} = mediaApp();
 app.isScreenSharing = true;
 await app.switchVideoDevice('camera-b');
 assert.equal(requests.length, 0);
 assert.equal(app.selectedVideoDeviceId, 'camera-b');
 assert.equal(app.localMediaStream.getVideoTracks()[0], camera);
 assert.equal(camera.readyState, 'live');
});

test('enumeration includes outputs and preserves selected devices', async () => {
 const {app} = mediaApp();
 app.selectedAudioDeviceId = 'mic-b';
 app.selectedAudioOutputDeviceId = 'headphones';
 await app.enumerateDevices();
 assert.equal(app.audioOutputDevices.length, 2);
 assert.equal(app.selectedAudioDeviceId, 'mic-b');
 assert.equal(app.selectedAudioOutputDeviceId, 'headphones');
});

test('output selection routes all participants, late arrivals, and the default output', async () => {
 const {app, remote, probe, requests} = mediaApp();
 remote.push(output(), output());
 await app.switchAudioOutput('headphones');
 assert.equal(app.selectedAudioOutputDeviceId, 'headphones');
 assert.equal(probe.sinkId, 'headphones');
 assert.ok(remote.every(element => element.sinkId === 'headphones'));
 const late = output();
 await app.applyAudioOutput(late);
 assert.equal(late.sinkId, 'headphones');
 remote.push(late);
 await app.switchAudioOutput('');
 assert.ok(remote.every(element => element.sinkId === ''));
 assert.equal(requests.length, 0, 'output selection must not request microphone access');
});

test('output can be selected before any participants arrive', async () => {
 const {app, probe} = mediaApp();
 await app.switchAudioOutput('speakers');
 assert.equal(probe.sinkId, 'speakers');
 const late = output();
 await app.applyAudioOutput(late);
 assert.equal(late.sinkId, 'speakers');
});

test('a pending late-arrival output assignment cannot overwrite a newer selection', async () => {
 const {app, remote} = mediaApp();
 await app.switchAudioOutput('speakers');
 const late = output();
 let finish;
 late.setSinkId = async function(id) {
  if (id === 'speakers') await new Promise(resolve => { finish = resolve; });
  this.sinkId = id;
 };
 remote.push(late);
 const attaching = app.applyAudioOutput(late);
 await app.switchAudioOutput('headphones');
 finish();
 await attaching;
 assert.equal(late.sinkId, 'headphones');
});

test('output failure rolls every participant back and keeps the previous selection', async () => {
 const {app, remote, messages} = mediaApp();
 remote.push(output(), output());
 await app.switchAudioOutput('speakers');
 remote[1].setSinkId = async function(id) { if (id === 'headphones') throw Error('Permission denied'); this.sinkId = id; };
 await app.switchAudioOutput('headphones');
 assert.equal(app.selectedAudioOutputDeviceId, 'speakers');
 assert.ok(remote.every(element => element.sinkId === 'speakers'));
 assert.notEqual(messages.at(-1).type, 'success');
 assert.equal(app.audioOutputSwitchPending, false);
});

test('browser output picker grants access and uses the returned device id', async () => {
 const {app, mediaDevices} = mediaApp();
 let called = false;
 mediaDevices.selectAudioOutput = async ({deviceId}) => { called = true; assert.equal(deviceId, ''); return {deviceId: 'permitted', kind: 'audiooutput'}; };
 const switching = app.onAudioOutputChange({target: {value: '__choose_audio_output__'}});
 assert.equal(called, true, 'picker must run synchronously within the dropdown interaction');
 await switching;
 assert.equal(app.selectedAudioOutputDeviceId, 'permitted');
 assert.ok(app.audioOutputDevices.some(device => device.deviceId === 'permitted'));
});

test('unsupported browsers retain the system output without requesting permissions', async () => {
 const {app, context, probe} = mediaApp();
 delete context.window.HTMLMediaElement;
 assert.equal(app.audioOutputSupported, false);
 await app.switchAudioOutput('headphones');
 assert.equal(app.selectedAudioOutputDeviceId, '');
 assert.equal(probe.calls.length, 0);
});

test('disconnecting the selected output restores the system output', async () => {
 const {app, remote, devices} = mediaApp();
 remote.push(output());
 await app.switchAudioOutput('headphones');
 devices.splice(devices.findIndex(device => device.deviceId === 'headphones'), 1);
 await app.refreshDevices();
 assert.equal(app.selectedAudioOutputDeviceId, '');
 assert.equal(remote[0].sinkId, '');
});
