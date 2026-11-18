/* globals Vue */

"use strict";

// eslint-disable-next-line no-unused-vars
const App = Vue.createApp({
	data() {
		const channelId = window.location.pathname.substr(1);
		const searchParams = new URLSearchParams(window.location.search);

		const name = searchParams.get("name");
		const chatEnabled = searchParams.get("chat") !== "false";

		return {
			channelId,
			peerId: "",
			userAgent: "",
			audioDevices: [],
			audioOutputDevices: [],
			videoDevices: [],
			audioEnabled: true,
			videoEnabled: true,
			selectedAudioDeviceId: null,
			selectedAudioOutputDeviceId: "",
			audioOutputSwitchPending: false,
			selectedVideoDeviceId: null,
			mediaRequestVersions: { audio: 0, video: 0 },
			name: name ?? window.localStorage.name,
			callInitiated: false,
			callStartedAt: null,
			callElapsedSeconds: 0,
			callTimerInterval: null,
			expandedPeerId: null,
			localMediaStream: null,
			preCallMediaPromise: null,
			screenShareStream: null,
			isScreenSharing: false,
			peers: {},
			dataChannels: {},
			chatEnabled,
			chats: [],
			chatMessage: "",
			showChat: false,
			showExtraControls: false,
			showAudioDevices: false,
			showVideoDevices: false,
			toast: [{ type: "", message: "" }],
		};
	},
	computed: {
		hasVideo() {
			return this.videoEnabled || this.isScreenSharing;
		},
		callDuration() {
			const seconds = this.callElapsedSeconds;
			const minutes = Math.floor(seconds / 60);
			const pad = (value) => String(value).padStart(2, "0");
			return minutes < 60
				? `${pad(minutes)}:${pad(seconds % 60)}`
				: `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:${pad(seconds % 60)}`;
		},
		peersArray() {
			return Object.keys(this.peers)
				.filter((p) => this.peers[p].data.userAgent)
				.map((peer) => ({
					id: peer,
					stream: this.peers[peer].stream,
					name: this.peers[peer].data.peerName,
					hasVideo: this.peers[peer].data.hasVideo !== false,
					isTalking: this.peers[peer].data.isTalking,
				}));
		},
		screenShareSupported() {
			return navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia;
		},
		audioOutputSupported() {
			return typeof window.HTMLMediaElement?.prototype.setSinkId === "function";
		},
		audioOutputPickerSupported() {
			return this.audioOutputSupported && typeof navigator.mediaDevices?.selectAudioOutput === "function";
		},
		videoLayoutClass() {
			const totalParticipants = this.peersArray.length + 1; // +1 for self

			if (totalParticipants === 1) return "layout-1";
			if (totalParticipants === 2) return "layout-2";
			if (totalParticipants === 3) return "layout-3";
			if (totalParticipants === 4) return "layout-4";
			if (totalParticipants === 5) return "layout-5";
			if (totalParticipants === 6) return "layout-6";
			return "layout-7-plus";
		},
	},
	watch: {
		hasVideo() {
			this.publishVideoState();
		},
		expandedPeerId(peerId) {
			document.body.classList.toggle("video-expanded", peerId !== null);
		},
		peersArray(peers) {
			if (this.expandedPeerId !== null && !peers.some((peer) => peer.id === this.expandedPeerId)) {
				this.closeExpandedVideo();
			}
		},
		callInitiated(newValue, oldValue) {
			if (!newValue) this.closeExpandedVideo();
			if (oldValue && !newValue) {
				// Call ended, clean up screen sharing
				this.cleanupScreenShare();
			}
		},
	},
	methods: {
		nameInitial(name) {
			return Array.from((name || "").trim())[0]?.toUpperCase() || "?";
		},
		publishVideoState() {
			if (!this.callInitiated) return;
			// Keep join metadata current for participants who arrive later.
			window.signalingSocket?.emit("updateUserData", {
				channel: this.channelId,
				key: "hasVideo",
				value: this.hasVideo,
			});
			this.sendDataMessage("hasVideo", this.hasVideo);
		},
		startCallTimer({ channel, startedAt, serverNow }) {
			if (!this.callInitiated || channel !== this.channelId) return;
			if (!Number.isFinite(startedAt) || !Number.isFinite(serverNow)) return;
			this.resetCallTimer();
			this.callStartedAt = startedAt;
			// Use the server's elapsed time to avoid client clock differences, and
			// a monotonic clock so throttled tabs catch up without accumulating drift.
			const elapsed = Math.max(0, serverNow - startedAt);
			const receivedAt = performance.now();
			const update = () => {
				this.callElapsedSeconds = Math.floor((elapsed + performance.now() - receivedAt) / 1000);
			};
			update();
			this.callTimerInterval = setInterval(update, 1000);
		},
		resetCallTimer() {
			clearInterval(this.callTimerInterval);
			this.callTimerInterval = null;
			this.callStartedAt = null;
			this.callElapsedSeconds = 0;
		},
		toggleChat() {
			this.showChat = !this.showChat;
			this.showExtraControls = false;
		},
		toggleExtraControls() {
			this.showExtraControls = !this.showExtraControls;
			this.showChat = false;
			if (this.showExtraControls) this.refreshDevices();
		},
		resetPopups() {
			this.showChat = false;
			this.showExtraControls = false;
			this.showAudioDevices = false;
			this.showVideoDevices = false;
		},
		async toggleMedia(kind) {
			const requestVersion = ++this.mediaRequestVersions[kind];
			const enabledKey = kind + "Enabled";
			const selectedDeviceIdKey = "selected" + (kind.charAt(0).toUpperCase() + kind.slice(1)) + "DeviceId";
			const getTracks = kind === "audio" ? "getAudioTracks" : "getVideoTracks";
			const existingTrack = this.localMediaStream?.[getTracks]()[0];

			if (existingTrack && this[enabledKey]) {
				existingTrack.enabled = false;
				this[enabledKey] = false;
				existingTrack.stop();
				this.removeMediaTrack(kind);
			} else {
				let newStream;
				try {
					const device = this[selectedDeviceIdKey] ? { deviceId: { exact: this[selectedDeviceIdKey] } } : true;
					const constraints =
						kind === "audio"
							? { audio: device, video: false }
							: { audio: false, video: device };
					newStream = await navigator.mediaDevices.getUserMedia(constraints);
					if (requestVersion !== this.mediaRequestVersions[kind] || !this.callInitiated) {
						newStream.getTracks().forEach((track) => track.stop());
						return;
					}
					const newTrack = newStream[getTracks]()[0];
					await this.replaceMediaTrack(newTrack, kind, () => requestVersion === this.mediaRequestVersions[kind]);
					this[enabledKey] = true;
				} catch {
					newStream?.getTracks().forEach((track) => track.stop());
					if (requestVersion === this.mediaRequestVersions[kind]) this.setToast(`Не удалось включить ${kind}`);
				}
			}
		},
		switchMediaDevice(newDeviceId, kind) {
			const requestVersion = ++this.mediaRequestVersions[kind];
			// Share the preview queue with joining, so the call uses the chosen source.
			this.preCallMediaPromise = Promise.resolve(this.preCallMediaPromise)
				.catch(() => {})
				.then(() => this.acquireMediaDevice(newDeviceId, kind, requestVersion));
			return this.preCallMediaPromise;
		},
		async acquireMediaDevice(newDeviceId, kind, requestVersion) {
			const isCurrent = () => requestVersion === this.mediaRequestVersions[kind];
			if (!isCurrent()) return;
			const selectedKey = kind === "audio" ? "selectedAudioDeviceId" : "selectedVideoDeviceId";
			// Choosing a source must not unmute the user or interrupt screen sharing.
			if (!this[kind + "Enabled"] || (kind === "video" && this.isScreenSharing)) {
				this[selectedKey] = newDeviceId;
				return;
			}
			let newStream;
			try {
				const device = newDeviceId ? { deviceId: { exact: newDeviceId } } : true;
				const constraints =
					kind === "audio"
						? { audio: device, video: false }
						: { audio: false, video: device };
				newStream = await navigator.mediaDevices.getUserMedia(constraints);
				if (!isCurrent() || !this[kind + "Enabled"] || (kind === "video" && this.isScreenSharing)) {
					newStream.getTracks().forEach((track) => track.stop());
					return;
				}
				const getTracks = kind === "audio" ? "getAudioTracks" : "getVideoTracks";
				const newTrack = newStream[getTracks]()[0];
				await this.replaceMediaTrack(newTrack, kind, isCurrent);
				this[selectedKey] = newDeviceId;
				const preview = document.getElementById("preCallVideo");
				if (preview) preview.srcObject = this.localMediaStream;
				this.setToast(kind === "audio" ? "Микрофон изменён" : "Камера изменена", "success");
			} catch {
				newStream?.getTracks().forEach((track) => track.stop());
				if (isCurrent()) this.setToast(kind === "audio" ? "Не удалось переключить микрофон" : "Не удалось переключить камеру");
			}
		},
		async replaceMediaTrack(newTrack, kind, isCurrent = () => true) {
			if (!newTrack) throw new Error(`No ${kind} track available`);
			const replacements = [];
			const additions = [];
			const results = await Promise.allSettled(Object.entries(this.peers).map(async ([peerId, peer]) => {
				const sender = peer.rtc.getSenders().find((s) => s.track?.kind === kind);
				if (sender) {
					replacements.push({ sender, track: sender.track });
					await sender.replaceTrack(newTrack);
				} else {
					additions.push({ peerId, rtc: peer.rtc, sender: peer.rtc.addTrack(newTrack, this.localMediaStream) });
				}
			}));
			const failure = results.find((result) => result.status === "rejected");
			if (failure || !isCurrent()) {
				await Promise.allSettled(replacements.map(({ sender, track }) => sender.replaceTrack(
					isCurrent() ? track : this.localMediaStream?.getTracks().find((item) => item.kind === kind) ?? null
				)));
				additions.forEach(({ rtc, sender }) => rtc.removeTrack(sender));
				throw failure?.reason ?? new Error("Media selection superseded");
			}
			if (!this.localMediaStream) this.localMediaStream = new MediaStream();
			const oldTracks = this.localMediaStream.getTracks().filter((track) => track.kind === kind);
			oldTracks.forEach((track) => this.localMediaStream.removeTrack(track));
			this.localMediaStream.addTrack(newTrack);
			oldTracks.forEach((track) => track.stop());
			additions.forEach(({ peerId }) => this.triggerRenegotiation(peerId));
		},
		removeMediaTrack(kind) {
			// kind: "video" or "audio"
			const blankTrack = this.getBlankTrack(kind);
			if (!blankTrack) return;

			// Replace track in all peer connections
			Object.keys(this.peers).forEach((peerId) => {
				const peerConnection = this.peers[peerId].rtc;
				const senders = peerConnection.getSenders();
				const sender = senders.find((s) => s.track && s.track.kind === kind);
				if (sender) {
					sender.replaceTrack(blankTrack);
				}
			});

			// Replace in localMediaStream
			if (this.localMediaStream) {
				const getTracks = kind === "audio" ? "getAudioTracks" : "getVideoTracks";
				const oldTrack = this.localMediaStream[getTracks]()[0];
				if (oldTrack) this.localMediaStream.removeTrack(oldTrack);
				this.localMediaStream.addTrack(blankTrack);
			}
		},
		async triggerRenegotiation(peerId) {
			try {
				const peerConnection = this.peers[peerId].rtc;

				const offer = await peerConnection.createOffer();
				await peerConnection.setLocalDescription(offer);

				// Send the offer through the signaling server
				if (window.signalingSocket) {
					window.signalingSocket.emit("relaySessionDescription", {
						peer_id: peerId,
						session_description: offer,
					});
				}
			} catch (error) {
				console.error(`Error during renegotiation for peer ${peerId}:`, error);
			}
		},
		replaceVideoTrack(newVideoTrack) {
			// Replace video track in all peer connections
			Object.keys(this.peers).forEach((peerId) => {
				const peerConnection = this.peers[peerId].rtc;
				const senders = peerConnection.getSenders();

				const videoSender = senders.find((sender) => sender.track && sender.track.kind === "video");

				if (videoSender) {
					// Replace existing video track
					videoSender.replaceTrack(newVideoTrack);
				} else {
					// No existing video sender, add new video track
					peerConnection.addTrack(newVideoTrack, this.localMediaStream);
					// Trigger renegotiation for this peer
					this.triggerRenegotiation(peerId);
				}
			});

			// Update local video element
			if (this.localMediaStream) {
				const oldVideoTrack = this.localMediaStream.getVideoTracks()[0];
				if (oldVideoTrack) {
					this.localMediaStream.removeTrack(oldVideoTrack);
				}
				this.localMediaStream.addTrack(newVideoTrack);
			}
		},
		replaceAudioTrack(newAudioTrack) {
			// Replace audio track in all peer connections
			Object.keys(this.peers).forEach((peerId) => {
				const peerConnection = this.peers[peerId].rtc;
				const senders = peerConnection.getSenders();
				const audioSender = senders.find((sender) => sender.track && sender.track.kind === "audio");

				if (audioSender) {
					// Replace existing audio track
					audioSender.replaceTrack(newAudioTrack);
				} else {
					// No existing audio sender, add new audio track
					peerConnection.addTrack(newAudioTrack, this.localMediaStream);
					// Trigger renegotiation for this peer
					this.triggerRenegotiation(peerId);
				}
			});

			// Update local media stream
			if (this.localMediaStream) {
				const oldAudioTrack = this.localMediaStream.getAudioTracks()[0];
				if (oldAudioTrack) {
					this.localMediaStream.removeTrack(oldAudioTrack);
				}
				this.localMediaStream.addTrack(newAudioTrack);
			}
		},
		async startScreenShare() {
			try {
				// Get screen share stream
				const screenStream = await navigator.mediaDevices.getDisplayMedia({
					video: {
						cursor: "always",
						displaySurface: "monitor",
					},
					audio: false,
				});

				// Check if stream has video tracks
				if (!screenStream.getVideoTracks().length) {
					screenStream.getTracks().forEach((track) => track.stop());
					this.setToast("Не найдено видео трека в просмотре экрана");	
					return;
				}

				this.screenShareStream = screenStream;
				this.isScreenSharing = true;

				// Handle screen share stop
				screenStream.getVideoTracks()[0].onended = () => {
					this.stopScreenShare();
				};

				// Replace video track with screen share track
				const screenVideoTrack = screenStream.getVideoTracks()[0];
				this.replaceVideoTrack(screenVideoTrack);

				this.setToast("Просмотр экрана начат", "success");
			} catch (error) {
				console.error("Error starting screen share:", error);
				if (error.name === "NotAllowedError") {
					this.setToast("Разрешение на просмотр экрана отклонено");
				} else if (error.name === "NotSupportedError") {
					this.setToast("Просмотр экрана не поддерживается в этом браузере");
				} else if (error.name === "AbortError") {
					// User cancelled the screen share dialog
				} else {	
					this.setToast("Не удалось начать просмотр экрана");
				}
			}
		},

		async stopScreenShare() {
			if (!this.isScreenSharing) return;

			try {
				if (this.screenShareStream) {
					// Stop all tracks in screen share stream
					this.screenShareStream.getTracks().forEach((track) => track.stop());
					this.screenShareStream = null;
				}

				this.isScreenSharing = false;

				// Screen sharing must never change the user's camera choice.
				if (!this.videoEnabled) {
					this.removeMediaTrack("video");
					return;
				}

				// Get new video stream with the selected video device
				const newVideoStream = await navigator.mediaDevices.getUserMedia({
					audio: false,
					video: { deviceId: { exact: this.selectedVideoDeviceId } },
				});

				// Camera permission/device setup may finish after the user turns it off,
				// leaves the call, or starts sharing again.
				if (!this.videoEnabled || !this.callInitiated || this.isScreenSharing) {
					newVideoStream.getTracks().forEach((track) => track.stop());
					return;
				}

				// Replace video track with camera track
				const newVideoTrack = newVideoStream.getVideoTracks()[0];
				this.replaceVideoTrack(newVideoTrack);

				this.setToast("Просмотр экрана остановлен", "success");
			} catch (error) {
				console.error("Ошибка при остановке просмотра экрана:", error);
				this.videoEnabled = false;
				this.removeMediaTrack("video");
				this.setToast("Не удалось остановить просмотр экрана");
			}
		},

		toggleScreenShare() {
			if (this.isScreenSharing) {
				this.stopScreenShare();
			} else {
				this.startScreenShare();	
			}
			this.showExtraControls = false;
		},

		cleanupScreenShare() {
			if (this.screenShareStream) {
				this.screenShareStream.getTracks().forEach((track) => track.stop());
				this.screenShareStream = null;
			}
			this.isScreenSharing = false;
		},

		initiateCall() {
			if (this.callInitiated) return;
			if (!this.channelId) return alert("Неверный ID канала");
			if (!this.name) return alert("Пожалуйста, введите ваше имя");
			this.callInitiated = true;
			this.showExtraControls = false;
			window.initiateCall();
		},
		setToast(message, type = "error") {
			this.toast = { type, message, time: new Date().getTime() };
			setTimeout(() => {
				if (new Date().getTime() - this.toast.time >= 3000) {
					this.toast.message = "";
				}
			}, 3500);
		},
		copyURL() {
			navigator.clipboard.writeText(`${window.location.origin}/${this.channelId}`).then(
				() => this.setToast("URL канала скопирован 👍", "success"),
				() => console.error("Не удалось скопировать URL канала")
			);
		},
		toggleAudio() {
			return this.toggleMedia("audio");
		},
		toggleVideo() {
			return this.toggleMedia("video");
		},	
		switchAudioDevice(newDeviceId) {
			return this.switchMediaDevice(newDeviceId, "audio");
		},
		switchVideoDevice(newDeviceId) {
			return this.switchMediaDevice(newDeviceId, "video");
		},
		async applyAudioOutput(element) {
			if (!element || !this.audioOutputSupported || this.audioOutputSwitchPending) return;
			const deviceId = this.selectedAudioOutputDeviceId;
			try {
				if (element.sinkId !== deviceId) {
					await element.setSinkId(deviceId);
				}
				if (deviceId !== this.selectedAudioOutputDeviceId) {
					await this.applyAudioOutput(element);
				}
			} catch {
				this.setToast("Не удалось направить звук участника на выбранное устройство");
			}
		},
		onAudioOutputChange(event) {
			const value = event.target.value;
			const usePicker = value === "__choose_audio_output__";
			// Keep the active device selected until switching succeeds, including on cancellation.
			event.target.value = this.selectedAudioOutputDeviceId;
			return this.switchAudioOutput(usePicker ? "" : value, usePicker);
		},
		async switchAudioOutput(newDeviceId, usePicker = false) {
			if (!this.audioOutputSupported || this.audioOutputSwitchPending) return;
			this.audioOutputSwitchPending = true;
			const previousDeviceId = this.selectedAudioOutputDeviceId;
			let elements = [];
			try {
				if (usePicker) {
					// Keep the browser permission picker within the user's click gesture.
					const device = await navigator.mediaDevices.selectAudioOutput({ deviceId: newDeviceId });
					newDeviceId = device.deviceId;
					if (!this.audioOutputDevices.some((item) => item.deviceId === device.deviceId)) {
						this.audioOutputDevices.push(device);
					}
				}
				// Validate even before a call, when there are no remote media elements yet.
				await document.createElement("audio").setSinkId(newDeviceId);
				elements = Array.from(document.querySelectorAll("video[data-peer-audio]"));
				const results = await Promise.allSettled(elements.map((element) => element.setSinkId(newDeviceId)));
				const failure = results.find((result) => result.status === "rejected");
				if (failure) throw failure.reason;
				this.selectedAudioOutputDeviceId = newDeviceId;
				this.setToast("Устройство вывода звука изменено", "success");
			} catch (error) {
				await Promise.allSettled(elements.map((element) => element.setSinkId(previousDeviceId)));
				this.setToast(error.name === "AbortError" && usePicker
					? "Выбор устройства вывода отменён"
					: "Не удалось переключить вывод звука. Проверьте подключение и разрешение на выбор устройства.");
			} finally {
				this.audioOutputSwitchPending = false;
				// Include participants whose video elements appeared while switching.
				document.querySelectorAll("video[data-peer-audio]").forEach((element) => this.applyAudioOutput(element));
			}
		},
		togglePreCallAudio() {
			this.mediaRequestVersions.audio++;
			this.audioEnabled = !this.audioEnabled;
			this.getPreCallMedia();
		},
		togglePreCallVideo() {
			this.mediaRequestVersions.video++;
			this.videoEnabled = !this.videoEnabled;
			this.getPreCallMedia();
		},
		endCall() {
			this.mediaRequestVersions.audio++;
			this.mediaRequestVersions.video++;
			this.resetPopups();
			this.resetCallTimer();
			// Disconnect from signaling server
			if (window.signalingSocket) {
				window.signalingSocket.disconnect();
			}

			// Clean up all peer connections
			Object.keys(this.peers).forEach((peerId) => {
				if (this.peers[peerId].rtc) {
					this.peers[peerId].rtc.close();
				}
			});

			// Clean up data channels
			Object.keys(this.dataChannels).forEach((peerId) => {
				if (this.dataChannels[peerId]) {
					this.dataChannels[peerId].close();
				}
			});

			// Reset call state
			this.peers = {};
			this.dataChannels = {};
			this.callInitiated = false;
			this.chats = [];
			this.showChat = false;

			// Clean up screen sharing
			this.cleanupScreenShare();

			// Show toast
			this.setToast("Звонок завершен", "success");

			// Re-initialize pre-call preview
			this.getPreCallMedia();
		},
		stopEvent(e) {
			e.preventDefault();	
			e.stopPropagation();
		},
		updateName() {
			window.localStorage.name = this.name;
		},
		updateNameAndPublish() {
			window.localStorage.name = this.name;
			this.updateUserData("peerName", this.name);
		},
		updateUserData(key, value) {
			this.sendDataMessage(key, value);
		},
		formatDate(dateString) {
			const date = new Date(dateString);
			const hours = date.getHours() > 12 ? date.getHours() - 12 : date.getHours();
			return (
				(hours < 10 ? "0" + hours : hours) +
				":" +
				(date.getMinutes() < 10 ? "0" + date.getMinutes() : date.getMinutes()) +
				" " +
				(date.getHours() >= 12 ? "PM" : "AM")
			);
		},
		sanitizeString(str) {
			const tagsToReplace = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
			const replaceTag = (tag) => tagsToReplace[tag] || tag;
			const safe_tags_replace = (str) => str.replace(/[&<>]/g, replaceTag);
			return safe_tags_replace(str);
		},
		linkify(str) {
			return this.sanitizeString(str).replace(/(?:(?:https?|ftp):\/\/)?[\w/\-?=%.]+\.[\w/\-?=%]+/gi, (match) => {
				let displayURL = match.trim().replace("https://", "").replace("https://", "");
				displayURL = displayURL.length > 25 ? displayURL.substr(0, 25) + "&hellip;" : displayURL;
				const url = !/^https?:\/\//i.test(match) ? "http://" + match : match;
				return `<a href="${url}" target="_blank" class="link" rel="noopener">${displayURL}</a>`;
			});
		},
		sendChat(e) {
			e.stopPropagation();
			e.preventDefault();

			if (!this.chatMessage.length) return;

			if (Object.keys(this.peers).length > 0) {
				this.sendDataMessage("chat", this.chatMessage);
				this.chatMessage = "";
			} else {
				alert("Нет участников в канале");
			}
		},
		sendDataMessage(key, value) {
			const date = new Date().toISOString();
			const dataMessage = { type: key, name: this.name, peerId: this.peerId, message: value, date };

			switch (key) {
				case "chat":
					this.chats.push(dataMessage);
					break;
				default:
					break;
			}

			Object.values(this.dataChannels).forEach((channel) => {
				if (channel.readyState === "open") channel.send(JSON.stringify(dataMessage));
			});
		},
		setTalkingPeer(peerId, isTalking) {
			if (this.peers[peerId] && this.peers[peerId].data.isTalking !== isTalking) {
				this.peers[peerId].data.isTalking = isTalking;
			}
		},
		handleIncomingDataChannelMessage(dataMessage) {
			if (!this.peers[dataMessage.peerId]) return;
			switch (dataMessage.type) {
				case "peerName":
					this.peers[dataMessage.peerId].data.peerName = dataMessage.message;
					break;
				case "hasVideo":
					if (typeof dataMessage.message === "boolean") {
						this.peers[dataMessage.peerId].data.hasVideo = dataMessage.message;
					}
					break;
				case "chat":
					this.showChat = true;
					this.chats.push(dataMessage);
					break;
				default:
					break;
			}
		},
		async enumerateDevices() {
			try {
				const devices = await navigator.mediaDevices.enumerateDevices();

				this.audioDevices = devices.filter((device) => device.kind === "audioinput");
				this.audioOutputDevices = devices.filter((device) => device.kind === "audiooutput");
				this.videoDevices = devices.filter((device) => device.kind === "videoinput");

				// Enumeration must not reset an explicitly chosen source.
				this.selectedAudioDeviceId = this.selectedAudioDeviceId ?? this.localMediaStream?.getAudioTracks()[0]?.getSettings?.().deviceId
					?? this.audioDevices.find((device) => device.deviceId === "default")?.deviceId
					?? this.audioDevices[0]?.deviceId;
				this.selectedVideoDeviceId = this.selectedVideoDeviceId ?? this.localMediaStream?.getVideoTracks()[0]?.getSettings?.().deviceId
					?? this.videoDevices.find((device) => device.deviceId === "default")?.deviceId
					?? this.videoDevices[0]?.deviceId;
				return true;
			} catch (error) {
				console.error("Failed to initialize media devices:", error);
				return false;
			}
		},
		async refreshDevices() {
			if (!await this.enumerateDevices()) return;
			for (const kind of ["audio", "video"]) {
				const devices = this[kind + "Devices"];
				const selectedKey = kind === "audio" ? "selectedAudioDeviceId" : "selectedVideoDeviceId";
				if (devices.length && !devices.some((device) => device.deviceId === this[selectedKey])) {
					this.switchMediaDevice(devices.find((device) => device.deviceId === "default")?.deviceId ?? devices[0].deviceId, kind);
				}
			}
			if (this.selectedAudioOutputDeviceId && !this.audioOutputDevices.some((device) => device.deviceId === this.selectedAudioOutputDeviceId)) {
				await this.switchAudioOutput("");
			}
		},
		getBlankTrack(kind) {
			if (kind === "video") {
				const width = 640,
					height = 480;
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				const ctx = canvas.getContext("2d");
				ctx.fillStyle = "black";
				ctx.fillRect(0, 0, width, height);
				const stream = canvas.captureStream(5);
				return stream.getVideoTracks()[0];
			} else if (kind === "audio") {
				const ctx = new (window.AudioContext || window.webkitAudioContext)();
				const oscillator = ctx.createOscillator();
				const dst = ctx.createMediaStreamDestination();
				oscillator.connect(dst);
				oscillator.start();
				oscillator.stop(ctx.currentTime + 0.01);
				return dst.stream.getAudioTracks()[0];
			}
			return null;
		},
		getPreCallMedia() {
			// Serialize preview updates so an older permission request cannot replace
			// the stream after the user changes devices or starts a new call.
			this.preCallMediaPromise = Promise.resolve(this.preCallMediaPromise)
				.catch(() => {})
				.then(() => this.acquirePreCallMedia());
			return this.preCallMediaPromise;
		},
		async ensureLocalMedia() {
			if (!this.preCallMediaPromise && !this.localMediaStream) this.getPreCallMedia();
			let pending;
			do {
				pending = this.preCallMediaPromise;
				await pending;
			} while (pending !== this.preCallMediaPromise);
		},
		async acquirePreCallMedia() {
			try {
				if (this.localMediaStream) {
					this.localMediaStream.getTracks().forEach((track) => track.stop());
				}
				const constraints = {
					audio: this.audioEnabled
						? this.selectedAudioDeviceId
							? { deviceId: { exact: this.selectedAudioDeviceId } }
							: true
						: false,
					video: this.videoEnabled
						? this.selectedVideoDeviceId
							? { deviceId: { exact: this.selectedVideoDeviceId } }
							: true
						: false,
				};
				this.localMediaStream = constraints.audio || constraints.video
					? await navigator.mediaDevices.getUserMedia(constraints)
					: new MediaStream([this.getBlankTrack("audio"), this.getBlankTrack("video")]);
				const videoElem = document.getElementById("preCallVideo");
				if (videoElem) {
					videoElem.srcObject = this.localMediaStream;
				}

				// Enumerate devices once during pre-call flow if not already done
				if (this.audioDevices.length === 0 && this.videoDevices.length === 0) {
					await this.enumerateDevices();
				}
			} catch {
				// If user denies access, create blank tracks as needed
				this.audioEnabled = false;
				this.videoEnabled = false;
				const tracks = [this.getBlankTrack("audio"), this.getBlankTrack("video")];
				this.localMediaStream = new MediaStream(tracks);
				const videoElem = document.getElementById("preCallVideo");
				if (videoElem) {
					videoElem.srcObject = this.localMediaStream;
				}
				this.setToast("Не удалось получить доступ к камере/микрофону");
			}
		},
		toggleExpandedVideo(peerId) {
			// Keep the live video inline so mobile browsers do not open their media player.
			this.expandedPeerId = this.expandedPeerId === peerId ? null : peerId;
		},
		closeExpandedVideo() {
			this.expandedPeerId = null;
		},
		onExpandedVideoKeydown(event) {
			if (this.expandedPeerId === null) return;
			if (event.key === "Escape") {
				event.preventDefault();
				this.closeExpandedVideo();
			} else if (event.key === "Tab") {
				// The return button is the only control in the expanded view.
				event.preventDefault();
				document.querySelector(".video.is-expanded .fullscreen-btn")?.focus();
			}
		},
	},
	mounted() {
		document.addEventListener("keydown", this.onExpandedVideoKeydown);
		navigator.mediaDevices?.addEventListener("devicechange", this.refreshDevices);
		if (!this.callInitiated) {
			this.getPreCallMedia();
		}
	},
	beforeUnmount() {
		this.resetCallTimer();
		navigator.mediaDevices?.removeEventListener("devicechange", this.refreshDevices);
		document.removeEventListener("keydown", this.onExpandedVideoKeydown);
		document.body.classList.remove("video-expanded");
	},
}).mount("#app");

// Register service worker for PWA functionality
if ("serviceWorker" in navigator) {
	navigator.serviceWorker.register("/sw.js");
}
