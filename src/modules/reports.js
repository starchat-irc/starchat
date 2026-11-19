/**
 * Reports module (feature "reports")
 * Reporting users (profile card) and messages (message toolbar) to the moderators of
 * the server. Guests may report too, the token is sent if there is one. API: docs/discovery.md.
 */

/** Reasons in docs/discovery.md, shown in this order. */
export const REPORT_REASONS = Object.freeze(['child_safety', 'sexual_content', 'harassment', 'hate_speech', 'spam', 'other']);

const TEXT_LIMIT = 2000;

function sameNick(a, b) {
    return typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
}

export function emptyReportDialog() {
    return {
        show: false,
        nick: '',
        account: null,
        channel: null,
        message: null,
        reason: '',
        details: '',
        sending: false,
        error: '',
        done: false,
    };
}

/** Body of POST chat/reports. */
export function reportPayload(dialog, reporterNick) {
    const details = dialog.details.trim();
    return {
        reported_nick: dialog.nick,
        reported_account: dialog.account,
        reporter_nick: reporterNick || 'Guest',
        channel: dialog.channel,
        message_text: dialog.message?.text ? dialog.message.text.slice(0, TEXT_LIMIT) : null,
        message_sent_at: dialog.message?.ts ? new Date(dialog.message.ts).toISOString() : null,
        reason: dialog.reason,
        details: details ? details.slice(0, TEXT_LIMIT) : null,
    };
}

export function reportsMixin() {
    return {
        reportDialog: emptyReportDialog(),

        // Methods, not getters: mixins are copied into the component, which would read a getter once
        reportReasons() {
            return REPORT_REASONS.map(value => ({ value, label: this.t(`report_reason_${value}`) }));
        },

        reportPolicyUrl() {
            return this.networkLink('reportPolicy');
        },

        /** Not for yourself and not for the client's own lines. */
        canReportUser(nick) {
            return this.hasFeature('reports') && Boolean(nick) && !sameNick(nick, this.nickname) && nick !== 'System';
        },

        canReportMessage(message) {
            return Boolean(message?.user) && !message.isSystem && !message.isJoinPart && !message.redacted
                && this.canReportUser(message.user);
        },

        openReportDialog(nick, message = null) {
            if (!this.canReportUser(nick)) return;
            const card = this.profileCard;
            const account = card && sameNick(card.nick, nick) ? card.account || null : null;
            const channel = String(this.currentChannel || '').startsWith('#') ? this.currentChannel : null;

            this.reportDialog = {
                ...emptyReportDialog(),
                show: true,
                nick,
                account,
                channel,
                message: message ? { text: String(message.text ?? ''), ts: message._ts ?? null } : null,
            };
            this.showingUserOptions = false;
        },

        closeReportDialog() {
            if (this.reportDialog.sending) return;
            this.reportDialog = emptyReportDialog();
        },

        async submitReport() {
            const dialog = this.reportDialog;
            if (dialog.sending || dialog.done) return;
            if (!dialog.reason) {
                dialog.error = this.t('report_reason_required');
                return;
            }

            dialog.sending = true;
            dialog.error = '';
            try {
                const response = await this.connection.api('chat/reports', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(reportPayload(dialog, this.nickname)),
                });
                if (response.ok) {
                    dialog.done = true;
                } else {
                    dialog.error = this.t(response.status === 429 ? 'report_error_rate_limited' : 'report_error');
                }
            } catch (error) {
                console.warn('Report failed:', error);
                dialog.error = this.t('report_error');
            } finally {
                dialog.sending = false;
            }
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const reportsModule = {
    name: 'reports',
    mixin: reportsMixin,
};
