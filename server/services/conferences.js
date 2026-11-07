"use strict";

const crypto = require("crypto");
const db = require("../db");
const config = require("../config");

const words = require("../resources/room-words.json");

if (!Array.isArray(words) || !words.length || words.some((word) => typeof word !== "string" || !/^[a-z]{1,59}$/.test(word))) {
	throw new Error("room-words.json must contain an array of lowercase ASCII words, up to 59 letters each");
}

const selectByIdStmt = db.prepare("SELECT id, telegram_user_id, created_at, metadata FROM conferences WHERE id = ?");
const insertStmt = db.prepare(
	"INSERT INTO conferences (id, telegram_user_id, created_at, metadata) VALUES (@id, @telegram_user_id, @created_at, @metadata)"
);

function getConferenceById(id) {
	const row = selectByIdStmt.get(id);
	if (!row) return null;

	if (config.CONFERENCE_TTL_MINUTES !== null) {
		const createdAt = new Date(row.created_at).getTime();
		const expiresAt = createdAt + config.CONFERENCE_TTL_MINUTES * 60 * 1000;
		if (Date.now() > expiresAt) return null;
	}

	return {
		id: row.id,
		telegramUserId: row.telegram_user_id,
		createdAt: row.created_at,
		metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
	};
}

function generateId() {
	const word = words[crypto.randomInt(words.length)];
	const digits = String(crypto.randomInt(10000)).padStart(4, "0");
	return `${word}${digits}`;
}

function createConference({ telegramUserId, metadata }) {
	if (!telegramUserId || typeof telegramUserId !== "string") {
		throw new Error("telegramUserId is required");
	}

	const created_at = new Date().toISOString();
	const payload = {
		telegram_user_id: telegramUserId,
		created_at,
		metadata: metadata ? JSON.stringify(metadata) : null,
	};

	for (let attempt = 0; attempt < 5; attempt++) {
		const id = generateId();
		try {
			insertStmt.run({ ...payload, id });
			return { id, createdAt: created_at };
		} catch (error) {
			// The database also reserves expired IDs and handles concurrent creators.
			if (error.code !== "SQLITE_CONSTRAINT_PRIMARYKEY") throw error;
		}
	}
	throw new Error("Failed to generate unique id");
}

module.exports = { createConference, getConferenceById };
