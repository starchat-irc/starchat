/**
 * Uploads module (feature "uploads")
 * Images and videos from the file picker, paste or drop go to the server's API and are
 * sent as a link. The upload manager lists and deletes own uploads. API: docs/discovery.md.
 */
import { copyText } from '../ui/clipboard.js';

/** Unlocks the input if an upload never finishes. */
const UPLOAD_TIMEOUT_MS = 30000;
const DROPPABLE_TYPES = /^(image|video)\//;

function errorMessage(data) {
    return Object.values(data?.errors || {})[0]?.[0] || (typeof data?.message === 'string' ? data.message.trim() : '');
}

/** Text for a failed upload: the server's message, otherwise one by status. */
export function uploadErrorKey(status) {
    if (status === 413) return 'upload_too_large';
    if (status === 422) return 'upload_invalid';
    if (status >= 500) return 'upload_server_error';
    return 'upload_failed';
}

export function uploadsMixin() {
    return {
        mediaUploadInProgress: false,
        pendingMediaFile: null,
        pendingMediaPreviewUrl: null,
        myUploads: [],
        myUploadsLoading: false,
        _uploadTimer: null,

        /** Uploads need the feature and a token of this connection; guests have none. */
        canUploadMedia() {
            return this.hasFeature('uploads') && this.hasApiToken;
        },

        // Upload manager

        async fetchMyUploads() {
            if (!this.canUploadMedia()) return;
            this.myUploadsLoading = true;
            try {
                const response = await this.connection.api('chat/media-upload');
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data) || this.t('uploads_load_failed'));
                this.myUploads = Array.isArray(data.uploads) ? data.uploads.filter(upload => upload?.id !== undefined) : [];
            } catch (error) {
                console.warn('Could not load uploads:', error);
                this.updateStatus(error.message || this.t('uploads_load_failed'));
            } finally {
                this.myUploadsLoading = false;
            }
        },

        async deleteUpload(upload) {
            if (upload?.id === undefined || !this.canUploadMedia()) return;
            try {
                const response = await this.connection.api(`chat/media-upload/${encodeURIComponent(upload.id)}`, { method: 'DELETE' });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data) || this.t('upload_delete_failed'));
                this.myUploads = this.myUploads.filter(item => item.id !== upload.id);
            } catch (error) {
                console.warn('Could not delete upload:', error);
                this.updateStatus(error.message || this.t('upload_delete_failed'));
            }
        },

        async copyUploadLink(upload) {
            if (!upload?.url) return;
            const copied = await copyText(upload.url);
            this.updateStatus(this.t(copied ? 'upload_link_copied' : 'upload_link_copy_failed'));
        },

        isUploadImage(upload) {
            return String(upload?.mime_type || '').toLowerCase().startsWith('image/');
        },

        isUploadVideo(upload) {
            return String(upload?.mime_type || '').toLowerCase().startsWith('video/');
        },

        // Pending file (file picker, paste, drop)

        triggerMediaUpload() {
            if (this.mediaUploadInProgress || !this.canUploadMedia()) return;
            this.$refs.mediaInput?.click();
        },

        beginMediaUpload() {
            clearTimeout(this._uploadTimer);
            this.mediaUploadInProgress = true;
            this._uploadTimer = setTimeout(() => {
                this._uploadTimer = null;
                this.mediaUploadInProgress = false;
                this.updateStatus(this.t('upload_reset'));
            }, UPLOAD_TIMEOUT_MS);
        },

        endMediaUpload() {
            clearTimeout(this._uploadTimer);
            this._uploadTimer = null;
            this.mediaUploadInProgress = false;
        },

        setPendingMedia(file) {
            if (!file) return;
            if (this.pendingMediaPreviewUrl) URL.revokeObjectURL(this.pendingMediaPreviewUrl);
            this.pendingMediaFile = file;
            this.pendingMediaPreviewUrl = file.type?.startsWith('image/') ? URL.createObjectURL(file) : null;
        },

        clearPendingMedia() {
            if (this.pendingMediaPreviewUrl) URL.revokeObjectURL(this.pendingMediaPreviewUrl);
            this.pendingMediaFile = null;
            this.pendingMediaPreviewUrl = null;
            if (this.$refs?.mediaInput) this.$refs.mediaInput.value = '';
        },

        isPendingMediaImage() {
            return Boolean(this.pendingMediaFile?.type?.startsWith('image/'));
        },

        handlePasteUpload(event) {
            if (!this.canUploadMedia() || this.mediaUploadInProgress) return;
            const item = Array.from(event?.clipboardData?.items || []).find(entry => entry.type?.startsWith('image/'));
            const file = item?.getAsFile();
            if (!file) return;

            const extension = file.type.split('/')[1] || 'png';
            const name = `pasted-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
            this.setPendingMedia(new File([file], name, { type: file.type }));
            event.preventDefault();
        },

        handleInputDrop(event) {
            if (!this.canUploadMedia() || this.mediaUploadInProgress) return;
            const file = Array.from(event?.dataTransfer?.files || []).find(entry => DROPPABLE_TYPES.test(entry.type || ''));
            if (file) this.setPendingMedia(file);
        },

        handleInputBackspace(event) {
            if (this.newMessage.length === 0 && this.pendingMediaFile) {
                this.clearPendingMedia();
                event.preventDefault();
            }
        },

        uploadMediaFile(event) {
            const file = event?.target?.files?.[0];
            if (file && this.canUploadMedia()) this.setPendingMedia(file);
        },

        /** Uploads the pending file and sends its link, with the input text in front. */
        async sendPendingMediaMessage(caption = '') {
            if (!this.pendingMediaFile || !this.isChatTarget() || !this.canUploadMedia()) return false;

            const body = new FormData();
            body.append('media', this.pendingMediaFile);
            if (caption) body.append('caption', caption);

            this.beginMediaUpload();
            try {
                const response = await this.connection.api('chat/media-upload', { method: 'POST', body });
                const data = await response.json().catch(() => ({}));
                if (!response.ok || typeof data.url !== 'string' || !data.url) {
                    throw new Error(errorMessage(data) || this.t(uploadErrorKey(response.status)));
                }
                this.sendOwnMessage(this.currentChannel, caption ? `${caption} ${data.url}` : data.url);
                this.scrollToBottom();
                this.clearPendingMedia();
                return true;
            } catch (error) {
                console.warn('Upload failed:', error);
                this.updateStatus(error instanceof TypeError ? this.t('upload_failed') : (error.message || this.t('upload_failed')));
                return false;
            } finally {
                this.endMediaUpload();
            }
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const uploadsModule = {
    name: 'uploads',
    mixin: uploadsMixin,
    hooks: {
        loggedOut() {
            this.clearPendingMedia();
            this.myUploads = [];
        },
    },
};
