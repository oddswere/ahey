const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function peerApp(kinds = []) {
 const handlers = {}, events = [], errors = [];
 const tracks = kinds.map(kind => ({kind}));
 const app = {
  peers: {}, dataChannels: {}, localMediaStream: {getTracks: () => tracks},
  publishVideoState() {},
 };
 class PeerConnection {
  constructor() {
   this.remoteDescription = null;
   this.transceivers = [];
   this.candidates = [];
  }
  addTrack(track) {
   const transceiver = this.addTransceiver(track.kind, {direction: 'sendrecv'});
   transceiver.sender.track = track;
   return transceiver.sender;
  }
  addTransceiver(kind, {direction}) {
   const transceiver = {direction, sender: {track: null}, receiver: {track: {kind}}};
   this.transceivers.push(transceiver);
   return transceiver;
  }
  getTransceivers() { return this.transceivers; }
  createDataChannel() { return {}; }
  async setRemoteDescription(description) {
   if (this.waitForDescription) await this.waitForDescription;
   this.remoteDescription = description;
  }
  async addIceCandidate(candidate) {
   assert.ok(this.remoteDescription, 'ICE must wait for the remote description');
   if (candidate.candidate === 'invalid') throw new Error('Invalid candidate');
   this.candidates.push(candidate.candidate);
  }
  async createAnswer() { return {type: 'answer', sdp: 'answer'}; }
  async setLocalDescription(description) { this.localDescription = description; }
  close() { this.closed = true; }
 }
 const context = {
  App: app, window: {}, navigator: {userAgent: 'test'}, ICE_SERVERS: [],
  RTCPeerConnection: PeerConnection,
  RTCSessionDescription: class { constructor(value) { Object.assign(this, value); } },
  RTCIceCandidate: class { constructor(value) { Object.assign(this, value); } },
  io: () => ({on: (key, callback) => handlers[key] = callback, emit: (key, data) => events.push([key, data])}),
  console: {log: (...args) => errors.push(args)},
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/peer.js'), 'utf8'), context);
 context.window.initiateCall();
 const addPeer = (id, offer = false) => {
  handlers.addPeer({peer_id: id, should_create_offer: offer, channel: {[id]: {userData: {}}}});
  return app.peers[id].rtc;
 };
 const ice = (id, candidate) => handlers.iceCandidate({peer_id: id, ice_candidate: {candidate}});
 const describe = (id, type) => handlers.sessionDescription({peer_id: id, session_description: {type, sdp: type}});
 return {app, handlers, events, errors, addPeer, ice, describe};
}

for (const type of ['offer', 'answer']) {
 test(`ICE arriving before and during the remote ${type} is retained and applied`, async () => {
  const {addPeer, ice, describe, events, errors} = peerApp();
  const peer = addPeer('existing');
  let releaseDescription;
  peer.waitForDescription = new Promise(resolve => { releaseDescription = resolve; });
  await ice('existing', 'early');
  const pending = describe('existing', type);
  await ice('existing', 'during');
  assert.deepEqual(peer.candidates, []);
  assert.equal(events.length, 0);
  releaseDescription();
  await pending;
  await ice('existing', 'after');
  assert.deepEqual(peer.candidates, ['early', 'during', 'after']);
  assert.equal(errors.length, 0);
  assert.equal(events.length, type === 'offer' ? 1 : 0);
  if (type === 'offer') {
   assert.equal(events[0][0], 'relaySessionDescription');
   assert.equal(events[0][1].session_description.type, 'answer');
  }
 });
}

test('a rejected candidate does not discard the rest of the queued candidates', async () => {
 const {addPeer, ice, describe, events, errors} = peerApp();
 const peer = addPeer('existing');
 await ice('existing', 'invalid');
 await ice('existing', 'valid');
 await describe('existing', 'offer');
 assert.deepEqual(peer.candidates, ['valid']);
 assert.equal(events.length, 1);
 assert.equal(errors.length, 1);
});

test('candidate queues are isolated by peer and discarded when a peer leaves', async () => {
 const {addPeer, ice, describe, handlers, errors} = peerApp();
 const first = addPeer('first'), second = addPeer('second');
 await ice('first', 'first candidate');
 await ice('second', 'second candidate');
 await describe('second', 'offer');
 assert.deepEqual(first.candidates, []);
 assert.deepEqual(second.candidates, ['second candidate']);
 handlers.removePeer({peer_id: 'first'});
 await ice('first', 'late candidate');
 await describe('first', 'offer');
 const replacement = addPeer('first');
 await describe('first', 'offer');
 assert.deepEqual(replacement.candidates, []);
 assert.equal(errors.length, 0);
});

test('a peer leaving while its description is pending is not answered', async () => {
 const {addPeer, describe, handlers, events} = peerApp();
 const peer = addPeer('existing');
 let releaseDescription;
 peer.waitForDescription = new Promise(resolve => { releaseDescription = resolve; });
 const pending = describe('existing', 'offer');
 handlers.removePeer({peer_id: 'existing'});
 releaseDescription();
 await pending;
 assert.equal(events.length, 0);
});

for (const kinds of [[], ['audio'], ['video'], ['audio', 'video']]) {
 test(`late joiner with ${kinds.join(' and ') || 'no local tracks'} can receive both media types`, () => {
  const {addPeer} = peerApp(kinds);
  const peer = addPeer('existing', true);
  for (const kind of ['audio', 'video']) {
   const matching = peer.getTransceivers().filter(item => item.receiver.track.kind === kind);
   assert.equal(matching.length, 1);
   assert.equal(matching[0].direction, kinds.includes(kind) ? 'sendrecv' : 'recvonly');
   assert.equal(matching[0].sender.track?.kind ?? null, kinds.includes(kind) ? kind : null);
  }
 });
}
