const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('better-sqlite3');
const { isValidChannelName } = require('../server/utils');

const serviceDir = path.resolve(__dirname, '../server/services');
const words = require('../server/resources/room-words.json');

function conferences(t, randomValues) {
	const db = new Database(':memory:');
	t.after(() => db.close());
	db.exec(`CREATE TABLE conferences (
		id TEXT PRIMARY KEY, telegram_user_id TEXT NOT NULL,
		created_at TEXT NOT NULL, metadata TEXT
	)`);
	const config = { CONFERENCE_TTL_MINUTES: null };
	const context = {
		module: { exports: {} },
		require(name) {
			if (name === '../db') return db;
			if (name === '../config') return config;
			if (name === 'crypto') return {
				randomInt(max) {
					const value = randomValues.shift();
					assert.ok(Number.isInteger(value) && value >= 0 && value < max, 'valid random range');
					return value;
				},
			};
			return require(name.startsWith('.') ? path.resolve(serviceDir, name) : name);
		},
	};
	vm.runInNewContext(fs.readFileSync(path.join(serviceDir, 'conferences.js'), 'utf8'), context);
	return { ...context.module.exports, db, config };
}

test('room codes use the supplied words and exactly four digits, including leading zeroes', (t) => {
	const digits = [0, 7, 427, 9999];
	const randomValues = words.flatMap((_, index) => digits.flatMap((suffix) => [index, suffix]));
	const service = conferences(t, randomValues);
	for (const word of words) {
		for (const suffix of digits) {
			const room = service.createConference({ telegramUserId: 'user', metadata: { note: 'meeting' } });
			assert.equal(room.id, `${word}${String(suffix).padStart(4, '0')}`);
			assert.ok(isValidChannelName(room.id));
			const saved = service.getConferenceById(room.id);
			assert.equal(saved.telegramUserId, 'user');
			assert.equal(saved.createdAt, room.createdAt);
			assert.equal(saved.metadata.note, 'meeting');
		}
	}
});

for (const expired of [false, true]) {
	test(`room creation retries collisions with ${expired ? 'expired' : 'active'} rooms`, (t) => {
		const service = conferences(t, [0, 7, 0, 7, 1, 9999]);
		const original = service.createConference({ telegramUserId: 'original' });
		if (expired) {
			service.config.CONFERENCE_TTL_MINUTES = 1;
			service.db.prepare('UPDATE conferences SET created_at = ? WHERE id = ?')
				.run('2000-01-01T00:00:00.000Z', original.id);
			assert.equal(service.getConferenceById(original.id), null);
		}
		const next = service.createConference({ telegramUserId: 'next' });
		assert.equal(next.id, `${words[1]}9999`);
		assert.equal(service.db.prepare('SELECT telegram_user_id FROM conferences WHERE id = ?')
			.get(original.id).telegram_user_id, 'original');
		assert.equal(service.getConferenceById(next.id).telegramUserId, 'next');
	});
}

test('room creation stops after five collisions without overwriting the existing room', (t) => {
	const service = conferences(t, Array.from({ length: 6 }, () => [0, 7]).flat());
	service.createConference({ telegramUserId: 'original' });
	assert.throws(() => service.createConference({ telegramUserId: 'next' }), /Failed to generate unique id/);
	assert.equal(service.db.prepare('SELECT count(*) AS count FROM conferences').get().count, 1);
});

test('room creation preserves unrelated database errors', (t) => {
	const service = conferences(t, [0, 7]);
	service.db.pragma('query_only = ON');
	assert.throws(() => service.createConference({ telegramUserId: 'user' }), { code: 'SQLITE_READONLY' });
});

test('existing hexadecimal room codes remain accessible', (t) => {
	const service = conferences(t, []);
	const id = 'a1b2c3d4e5f6';
	service.db.prepare('INSERT INTO conferences (id, telegram_user_id, created_at) VALUES (?, ?, ?)')
		.run(id, 'existing', new Date().toISOString());
	assert.ok(isValidChannelName(id));
	assert.equal(service.getConferenceById(id).telegramUserId, 'existing');
});
