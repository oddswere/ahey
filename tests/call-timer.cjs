const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function timerApp() {
 let options, now = 0, nextId = 0;
 const intervals = new Map();
 const context = {
  Vue: {createApp(value) { options = value; return {mount() {}}; }},
  window: {location: {pathname: '/one', search: ''}, localStorage: {}},
  navigator: {}, URLSearchParams,
  performance: {now: () => now},
  setInterval(callback) { const id = ++nextId; intervals.set(id, callback); return id; },
  clearInterval(id) { intervals.delete(id); },
 };
 vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context);
 const app = options.data();
 for (const [name, method] of Object.entries(options.methods)) app[name] = method.bind(app);
 return {
  app, intervals,
  duration: () => options.computed.callDuration.call(app),
  advance(milliseconds) { now += milliseconds; for (const tick of intervals.values()) tick(); },
 };
}

test('timer waits for an accepted join, catches up after delayed ticks, and formats long calls', () => {
 const {app, intervals, duration, advance} = timerApp();
 const start = {channel: 'one', startedAt: 1000, serverNow: 1000};
 app.startCallTimer(start);
 assert.equal(app.callStartedAt, null);
 assert.equal(intervals.size, 0);
 app.callInitiated = true;
 app.startCallTimer({...start, channel: 'two'});
 assert.equal(intervals.size, 0);
 app.startCallTimer(start);
 assert.equal(duration(), '00:00');
 advance(65000);
 assert.equal(duration(), '01:05');
 advance(3535000);
 assert.equal(duration(), '01:00:00');
});

test('late joins use server duration and reconnects replace the timer without leaking intervals', () => {
 const {app, intervals, duration, advance} = timerApp();
 app.callInitiated = true;
 app.startCallTimer({channel: 'one', startedAt: 1000, serverNow: 3662000});
 assert.equal(duration(), '01:01:01');
 advance(2000);
 assert.equal(duration(), '01:01:03');
 app.startCallTimer({channel: 'one', startedAt: 1000, serverNow: 3666000});
 assert.equal(intervals.size, 1);
 assert.equal(duration(), '01:01:05');
 app.resetCallTimer();
 assert.equal(intervals.size, 0);
 assert.equal(app.callStartedAt, null);
 advance(10000);
 assert.equal(duration(), '00:00');
});
