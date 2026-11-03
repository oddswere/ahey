/**
 * A simple signalling server implementation using socket.io.
 * This socket connection is used a signalling server as WebRTC does not support discovery of other peers.
 * User's audio, video or chat messages does not use this socket.
 */

const { isValidChannelName } = require("./utils");
const { getConferenceById } = require("./services/conferences");

// Keys in these maps come from untrusted clients. Null-prototype objects keep a
// key like "__proto__" from resolving to Object.prototype (prototype pollution).
const channels = Object.create(null);
const sockets = Object.create(null);
const peers = Object.create(null);
const callStartedAt = Object.create(null);

const has = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);

const signallingServer = (socket) => {
	// Keep application membership separate from Socket.IO's own room tracking.
	const joinedChannels = Object.create(null);

	sockets[socket.id] = socket;

	socket.on("disconnect", () => {
		for (const channel in joinedChannels) {
			part(channel);
		}
		delete sockets[socket.id];
	});

	socket.on("join", (config) => {
		const channel = config?.channel;

		// Reject malformed channel names. This mirrors the HTTP route's validation
		// and keeps unbounded/hostile keys out of the channel maps.
		if (!isValidChannelName(channel) || !getConferenceById(channel)) return;

		// Already Joined
		if (has(joinedChannels, channel)) return;

		if (!has(channels, channel)) {
			channels[channel] = Object.create(null);
			callStartedAt[channel] = Date.now();
		}

		if (!has(peers, channel)) peers[channel] = Object.create(null);

		peers[channel][socket.id] = { userData: Object.assign(Object.create(null), config.userData && typeof config.userData === "object" ? config.userData : {}) };

		for (const id in channels[channel]) {
			channels[channel][id].emit("addPeer", {
				peer_id: socket.id,
				should_create_offer: false,
				channel: peers[channel],
			});
			socket.emit("addPeer", { peer_id: id, should_create_offer: true, channel: peers[channel] });
		}

		channels[channel][socket.id] = socket;
		joinedChannels[channel] = channel;
		socket.emit("callStarted", { channel, startedAt: callStartedAt[channel], serverNow: Date.now() });

		const numPeers = Object.keys(peers[channel]).length;
		console.log("joined channel=" + channel + " peers=" + numPeers);
	});

	socket.on("updateUserData", (config) => {
		const channel = config?.channel;
		const key = config?.key;

		// Only a member of the channel may update data, and only its own entry.
		if (!isValidChannelName(channel) || !has(joinedChannels, channel)) return;
		if (!has(peers, channel) || !has(peers[channel], socket.id)) return;
		// Never let a client write prototype-mutating keys.
		if (typeof key !== "string" || key === "__proto__" || key === "constructor" || key === "prototype") return;

		peers[channel][socket.id].userData[key] = config.value;
	});

	const part = (channel) => {
		// Socket not in channel
		if (!has(joinedChannels, channel)) return;

		delete joinedChannels[channel];
		if (has(channels, channel)) delete channels[channel][socket.id];
		if (has(peers, channel)) delete peers[channel][socket.id];

		const remainingPeers = has(peers, channel) ? Object.keys(peers[channel]).length : 0;
		console.log("left channel=" + channel + " peers=" + remainingPeers);

		for (const id in channels[channel] ?? {}) {
			channels[channel][id].emit("removePeer", { peer_id: socket.id });
			socket.emit("removePeer", { peer_id: id });
		}

		if (remainingPeers === 0) {
			// last peer disconnected from the channel
			delete peers[channel];
			delete channels[channel];
			delete callStartedAt[channel];
		}
	};

	// Relay is only permitted between peers that share a channel, so a client
	// cannot push offers/candidates at arbitrary sockets on the server.
	const sharesChannelWith = (peerId) => {
		for (const channel in joinedChannels) {
			if (has(channels, channel) && has(channels[channel], peerId)) return true;
		}
		return false;
	};

	socket.on("relayICECandidate", (config) => {
		const peer_id = config?.peer_id;

		if (typeof peer_id !== "string" || !has(sockets, peer_id)) return;
		if (!sharesChannelWith(peer_id)) return;

		sockets[peer_id].emit("iceCandidate", { peer_id: socket.id, ice_candidate: config.ice_candidate });
	});

	socket.on("relaySessionDescription", (config) => {
		const peer_id = config?.peer_id;

		if (typeof peer_id !== "string" || !has(sockets, peer_id)) return;
		if (!sharesChannelWith(peer_id)) return;

		sockets[peer_id].emit("sessionDescription", {
			peer_id: socket.id,
			session_description: config.session_description,
		});
	});
};


module.exports = signallingServer;
