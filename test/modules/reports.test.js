/**
 * Reports module: who can be reported, the request, errors.
 */
import { beforeEach, test } from 'vitest';
import assert from 'node:assert/strict';
import { REPORT_REASONS, reportPayload, reportsModule } from '../../src/modules/reports.js';
import { installBrowserStubs } from '../ui/chat-harness.js';
import { apiStub, chatWith, connectionWith, json } from './module-harness.js';

beforeEach(() => {
    installBrowserStubs();
});

function guestChat(routes = {}, options = {}) {
    const fetch = apiStub(routes);
    const { chat } = chatWith(connectionWith(fetch, { features: ['reports'], ...options }), { modules: [reportsModule] });
    chat.nickname = 'me';
    chat.currentChannel = '#lobby';
    return { chat, fetch };
}

const message = { user: 'bob', text: 'rude words', _ts: Date.UTC(2026, 10, 19, 12) };

test('only other users can be reported, and only with the feature', () => {
    const { chat } = guestChat();
    assert.ok(chat.canReportUser('bob'));
    assert.ok(!chat.canReportUser('ME'), 'not yourself');
    assert.ok(!chat.canReportUser('System'));
    assert.ok(!chat.canReportUser(''));
    assert.ok(chat.canReportMessage(message));
    assert.ok(!chat.canReportMessage({ ...message, isSystem: true }));
    assert.ok(!chat.canReportMessage({ ...message, redacted: true }));

    const { chat: plain } = guestChat({}, { features: [] });
    assert.ok(!plain.canReportUser('bob'), 'server without reports');
});

test('the reasons are translated, the policy link comes from discovery', () => {
    const { chat } = guestChat({}, { links: { reportPolicy: 'https://home.example.org/policy' } });
    assert.deepEqual(chat.reportReasons().map(reason => reason.value), REPORT_REASONS);
    assert.ok(chat.reportReasons().every(reason => reason.label && !reason.label.startsWith('report_reason_')));
    assert.equal(chat.reportPolicyUrl(), 'https://home.example.org/policy');
    assert.equal(guestChat().chat.reportPolicyUrl(), '');
});

test('a guest report is posted with the message and the channel', async () => {
    let body = null;
    const { chat, fetch } = guestChat({ 'POST chat/reports': (init) => { body = JSON.parse(init.body); return json({}, 201); } });

    chat.openReportDialog('bob', message);
    assert.equal(chat.reportDialog.channel, '#lobby');
    await chat.submitReport();
    assert.equal(chat.reportDialog.error, chat.t('report_reason_required'));
    assert.equal(fetch.calls.length, 0);

    chat.reportDialog.reason = 'harassment';
    chat.reportDialog.details = '  started in the morning  ';
    await chat.submitReport();

    assert.ok(chat.reportDialog.done);
    assert.equal(fetch.calls[0].init.headers.get('Authorization'), null, 'guests have no token');
    assert.deepEqual(body, {
        reported_nick: 'bob',
        reported_account: null,
        reporter_nick: 'me',
        channel: '#lobby',
        message_text: 'rude words',
        message_sent_at: '2026-11-19T12:00:00.000Z',
        reason: 'harassment',
        details: 'started in the morning',
    });
});

test('the account from the open profile card is sent along', () => {
    const { chat } = guestChat();
    chat.profileCard = { nick: 'Bob', account: 'bobby' };
    chat.openReportDialog('bob');
    assert.equal(chat.reportDialog.account, 'bobby');
    assert.equal(chat.reportDialog.message, null);
});

test('rate limits and failures show an error and keep the dialog', async () => {
    const { chat } = guestChat({ 'POST chat/reports': json({}, 429) });
    chat.openReportDialog('bob');
    chat.reportDialog.reason = 'spam';
    await chat.submitReport();
    assert.equal(chat.reportDialog.error, chat.t('report_error_rate_limited'));
    assert.ok(!chat.reportDialog.done);
    assert.ok(!chat.reportDialog.sending);

    const { chat: offline } = guestChat({ 'POST chat/reports': new TypeError('offline') });
    offline.openReportDialog('bob');
    offline.reportDialog.reason = 'spam';
    await offline.submitReport();
    assert.equal(offline.reportDialog.error, offline.t('report_error'));
});

test('long texts are cut to the documented limit', () => {
    const payload = reportPayload({
        nick: 'bob', account: null, channel: null, reason: 'other',
        details: 'x'.repeat(3000), message: { text: 'y'.repeat(3000), ts: null },
    }, '');
    assert.equal(payload.details.length, 2000);
    assert.equal(payload.message_text.length, 2000);
    assert.equal(payload.reporter_nick, 'Guest');
    assert.equal(payload.message_sent_at, null);
});
