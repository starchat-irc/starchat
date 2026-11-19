/**
 * Share module (client only, no server feature)
 * Text, links and files shared from other apps arrive from the app around the chat
 * (receiveShare). Once the chat is connected and its channels are joined, the quick
 * switcher asks where to send them. The text lands in the input and the file as pending
 * upload, so the user still checks and sends it.
 */

export const SHARE_TEXT_LIMIT = 4000;

/** Shared file as sent by the app: base64 data plus name and type. */
export function shareFileFromPayload(file) {
    if (!file?.data || typeof file.data !== 'string') return null;
    try {
        const binary = atob(file.data);
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new File([bytes], file.name || 'shared', { type: file.mimeType || 'application/octet-stream' });
    } catch {
        return null;
    }
}

/**
 * @param {{ text?: string, subject?: string, file?: Object, tooLarge?: string, unreadable?: boolean }} payload
 * @return {{ text: string, file: File|null, tooLarge: string|null, unreadable: boolean }|null}
 */
export function normalizeShare(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const subject = typeof payload.subject === 'string' ? payload.subject.trim() : '';
    let text = typeof payload.text === 'string' ? payload.text.trim() : '';
    // Many apps share the title as subject and only the link as text
    if (subject && text && !text.includes(subject)) text = `${subject} ${text}`;
    else if (!text) text = subject;
    const file = shareFileFromPayload(payload.file);
    const tooLarge = typeof payload.tooLarge === 'string' ? payload.tooLarge : null;
    const unreadable = payload.unreadable === true;
    if (!text && !file && !tooLarge && !unreadable) return null;
    return { text: text.slice(0, SHARE_TEXT_LIMIT), file, tooLarge, unreadable };
}

export function shareMixin() {
    return {
        /** What waits for a conversation while the quick switcher is open in share mode. */
        pendingShare: null,

        receiveShare(payload) {
            const share = normalizeShare(payload);
            if (!share) return;
            this.pendingShare = share;
            this.showPendingShare();
        },

        /** Opens the picker once the chat is connected and its channels are joined. */
        showPendingShare() {
            if (!this.pendingShare || this.quickSwitcher.show) return;
            if (!this.isRegistered || this._bulkJoining > 0) return;
            this.closeMobileDrawers?.();
            this.openQuickSwitcher('share');
        },

        /** Short description for the switcher header. */
        pendingShareSummary() {
            const share = this.pendingShare;
            if (!share) return '';
            if (share.file) return share.file.name;
            return share.text.length > 80 ? `${share.text.slice(0, 80)}…` : share.text;
        },

        /** Why a shared file cannot come along (too large, no uploads), empty when fine. */
        pendingShareWarning() {
            const share = this.pendingShare;
            if (!share) return '';
            if (share.tooLarge) return this.t('share_file_too_large', { name: share.tooLarge });
            if (share.unreadable) return this.t('share_file_unreadable');
            if (share.file && !this.canUploadMedia?.()) return this.t('share_file_account_only');
            return '';
        },

        /** The conversation is open now: put the shared content into the input. */
        applyShare(share) {
            if (share.text) {
                this.newMessage = this.newMessage ? `${this.newMessage} ${share.text}` : share.text;
            }
            if (share.file && this.canUploadMedia?.()) this.setPendingMedia(share.file);
            // After the conversation switch has rendered and x-model has written the text
            setTimeout(() => this.autoGrowInput?.(this.$refs?.messageInput), 50);
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const shareModule = {
    name: 'share',
    mixin: shareMixin,
};
