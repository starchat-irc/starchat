/**
 * Profiles module (feature "profiles")
 * Profile part of the user card, own avatar and status, and the profile editor in the
 * "Account" section of the settings. API: docs/discovery.md.
 *
 * The card asks the IRC server for the account first (user-card.js), the profile is
 * loaded by account name, never by nick.
 */
import { SCOPE } from '../ui/settings/registry.js';
import { isTrustedAvatarUrl } from '../ui/mixins/ui.js';
import { STATUS_MAX_LENGTH, normalizeStatus } from '../ui/mixins/user-card.js';

const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const AVATAR_TYPES = ['image/jpeg', 'image/png', 'image/gif'];

const RECENT_STATUS_EMOJIS_KEY = 'chat.recentStatusEmojis';
const RECENT_STATUS_EMOJIS_LIMIT = 8;
/** Shown until the user picked own emojis. */
const DEFAULT_STATUS_EMOJIS = ['😊', '🎮', '💼', '🎧', '😴', '🍕', '🔥', '🖖'];

function readRecentStatusEmojis() {
    try {
        const stored = JSON.parse(localStorage.getItem(RECENT_STATUS_EMOJIS_KEY) || '[]');
        return Array.isArray(stored) ? stored.filter(emoji => typeof emoji === 'string').slice(0, RECENT_STATUS_EMOJIS_LIMIT) : [];
    } catch {
        return [];
    }
}

function emptyProfileEditor() {
    return {
        show: false,
        loading: false,
        saving: false,
        profile: null,
        file: null,
        previewUrl: '',
        notice: '',
        error: '',
        statusDraft: '',
        statusSaving: false,
        statusNotice: '',
        statusError: '',
        statusEmojiOpen: false,
    };
}

/** Optional lists of a profile are arrays even when the server leaves them out. */
export function normalizeProfile(data) {
    if (!data || typeof data !== 'object') return null;
    return {
        ...data,
        characters: Array.isArray(data.characters) ? data.characters : [],
        mutual_communities: Array.isArray(data.mutual_communities) ? data.mutual_communities : [],
    };
}

/** First validation message of a Laravel style error answer. */
function errorMessage(data, fallback) {
    return Object.values(data?.errors || {})[0]?.[0] || data?.message || fallback;
}

export function profilesMixin() {
    return {
        profileEditor: emptyProfileEditor(),
        recentStatusEmojis: readRecentStatusEmojis(),

        /** Profiles need the feature and a token of this connection; guests have none. */
        canUseProfiles() {
            return this.hasFeature('profiles') && this.hasApiToken;
        },

        /** Own avatar and status from the profile, published as metadata after every connect. */
        async loadOwnAvatar() {
            if (!this.canUseProfiles()) return;
            try {
                const response = await this.connection.api('chat/profile');
                if (!response.ok) return;
                const data = await response.json();
                this.ownAvatarUrl = data.avatar_url || '';
                this.ownStatus = normalizeStatus(data.status);
                this.syncOwnAvatar();
                this.syncOwnStatus();
            } catch (error) {
                console.warn('Could not load own profile:', error);
            }
        },

        // Card

        async fetchProfileCard(nick, account) {
            if (!this.canUseProfiles()) return;
            this.profileCard.loading = true;
            try {
                const response = await this.connection.api(`chat/profiles/${encodeURIComponent(account)}`);
                // The card may show someone else by now
                if (this.profileCard.nick !== nick) return;
                this.profileCard.profile = response.ok ? normalizeProfile(await response.json()) : null;
            } catch (error) {
                console.warn('Could not load profile:', error);
            } finally {
                if (this.profileCard.nick === nick) {
                    this.profileCard.loading = false;
                    this.$nextTick(() => this.positionUserMenu());
                }
            }
        },

        profileCardProfileAvatar() {
            return this.trustedAvatar(this.profileCard.profile?.avatar_url);
        },

        formatProfileDate(iso) {
            if (!iso) return '';
            const date = new Date(iso);
            return Number.isNaN(date.getTime())
                ? ''
                : date.toLocaleDateString(this.t('locale'), { year: 'numeric', month: 'long', day: 'numeric' });
        },

        // Editor

        /** The profile editor is the "Account" section of the settings window. */
        openProfileEditor() {
            if (!this.canUseProfiles()) return;
            this.openSettings('account');
        },

        async loadProfileEditor() {
            if (!this.canUseProfiles()) return;
            this.resetProfileEditorFile();
            this.profileEditor = { ...emptyProfileEditor(), show: true, loading: true };

            try {
                const response = await this.connection.api('chat/profile');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                this.profileEditor.profile = normalizeProfile(await response.json());
                this.profileEditor.statusDraft = this.ownStatus || normalizeStatus(this.profileEditor.profile?.status);
            } catch (error) {
                console.warn('Could not load own profile:', error);
                this.profileEditor.error = this.t('profile_not_found');
            } finally {
                this.profileEditor.loading = false;
            }
        },

        closeProfileEditor() {
            this.resetProfileEditorFile();
            this.profileEditor.statusEmojiOpen = false;
            this.profileEditor.show = false;
        },

        statusDraftLength() {
            return [...this.profileEditor.statusDraft].length;
        },

        isStatusDraftChanged() {
            return normalizeStatus(this.profileEditor.statusDraft) !== this.ownStatus;
        },

        /** Last used emojis first, filled up with defaults so the row is never empty. */
        statusQuickEmojis() {
            return [...new Set([...this.recentStatusEmojis, ...DEFAULT_STATUS_EMOJIS])].slice(0, RECENT_STATUS_EMOJIS_LIMIT);
        },

        rememberStatusEmoji(emoji) {
            this.recentStatusEmojis = [emoji, ...this.recentStatusEmojis.filter(e => e !== emoji)].slice(0, RECENT_STATUS_EMOJIS_LIMIT);
            try {
                localStorage.setItem(RECENT_STATUS_EMOJIS_KEY, JSON.stringify(this.recentStatusEmojis));
            } catch {
                // Storage blocked: the row still works for this page view
            }
        },

        /** Inserts the emoji at the cursor of the status field. */
        insertStatusEmoji(emoji) {
            const input = this.$refs?.profileStatusInput;
            const draft = this.profileEditor.statusDraft;
            const start = input?.selectionStart ?? draft.length;
            const end = input?.selectionEnd ?? draft.length;
            const next = draft.slice(0, start) + emoji + draft.slice(end);
            if ([...next].length > STATUS_MAX_LENGTH) return;

            this.profileEditor.statusDraft = next;
            this.profileEditor.statusEmojiOpen = false;
            this.rememberStatusEmoji(emoji);
            this.$nextTick(() => {
                if (!input) return;
                input.focus();
                input.setSelectionRange(start + emoji.length, start + emoji.length);
            });
        },

        async saveProfileStatus(clear = false) {
            if (this.profileEditor.statusSaving) return;
            const status = clear ? '' : normalizeStatus(this.profileEditor.statusDraft);

            this.profileEditor.statusSaving = true;
            this.profileEditor.statusNotice = '';
            this.profileEditor.statusError = '';
            try {
                const response = await this.connection.api('chat/profile/status', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status: status || null }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data, this.t('profile_status_failed')));

                this.ownStatus = normalizeStatus(data.status);
                this.profileEditor.statusDraft = this.ownStatus;
                if (this.profileEditor.profile) this.profileEditor.profile.status = this.ownStatus || null;
                // Published as metadata, everyone sees it right away
                this.syncOwnStatus();
                this.profileEditor.statusNotice = this.t(this.ownStatus ? 'profile_status_saved' : 'profile_status_cleared');
            } catch (error) {
                this.profileEditor.statusError = error.message || this.t('profile_status_failed');
            } finally {
                this.profileEditor.statusSaving = false;
            }
        },

        resetProfileEditorFile() {
            if (this.profileEditor.previewUrl) URL.revokeObjectURL(this.profileEditor.previewUrl);
            this.profileEditor.file = null;
            this.profileEditor.previewUrl = '';
            if (this.$refs?.profileAvatarInput) this.$refs.profileAvatarInput.value = '';
        },

        profileEditorAvatar() {
            return this.profileEditor.previewUrl || this.ownAvatarUrl || this.trustedAvatar(this.profileEditor.profile?.avatar_url);
        },

        /** Avatars only from the origin of this connection's API (see isTrustedAvatarUrl). */
        trustedAvatar(url) {
            return isTrustedAvatarUrl(url, this.connection?.apiBaseUrl) ? url : '';
        },

        selectProfileAvatar(event) {
            const file = event.target.files?.[0];
            this.resetProfileEditorFile();
            this.profileEditor.notice = '';
            this.profileEditor.error = '';
            if (!file) return;

            if (!AVATAR_TYPES.includes(file.type) || file.size > AVATAR_MAX_BYTES) {
                this.profileEditor.error = this.t('profile_avatar_hint');
                return;
            }
            this.profileEditor.file = file;
            this.profileEditor.previewUrl = URL.createObjectURL(file);
        },

        async uploadProfileAvatar() {
            if (!this.profileEditor.file || this.profileEditor.saving) return;
            const body = new FormData();
            body.append('avatar', this.profileEditor.file);
            await this.saveProfileAvatar('POST', body, 'profile_avatar_saved');
        },

        async removeProfileAvatar() {
            if (this.profileEditor.saving) return;
            await this.saveProfileAvatar('DELETE', null, 'profile_avatar_removed');
        },

        async saveProfileAvatar(method, body, successKey) {
            this.profileEditor.saving = true;
            this.profileEditor.notice = '';
            this.profileEditor.error = '';
            try {
                const response = await this.connection.api('chat/profile/avatar', { method, body });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(errorMessage(data, this.t('profile_avatar_failed')));

                this.ownAvatarUrl = this.trustedAvatar(data.avatar_url);
                if (this.profileEditor.profile) this.profileEditor.profile.avatar_url = this.ownAvatarUrl || null;
                // Published as metadata, everyone sees it without a reconnect
                this.syncOwnAvatar();
                this.resetProfileEditorFile();
                this.profileEditor.notice = this.t(successKey);
            } catch (error) {
                this.profileEditor.error = error.message || this.t('profile_avatar_failed');
            } finally {
                this.profileEditor.saving = false;
            }
        },
    };
}

/** @param {import('../ui/settings/registry.js').SettingsRegistry} registry */
function registerProfileSettings(registry) {
    registry
        .registerSection({ id: 'account', label: 'settings_section_account', icon: 'bi-person-circle', order: 10, when: env => env.hasAccount })
        .registerSetting({
            id: 'account.profile',
            section: 'account',
            type: 'custom',
            view: 'profile',
            scope: SCOPE.Account,
            label: 'profile_edit',
            keywords: ['avatar', 'profilbild', 'status', 'bild', 'picture'],
        });
}

/** @type {import('./index.js').ChatModule} */
export const profilesModule = {
    name: 'profiles',
    mixin: profilesMixin,
    register: registerProfileSettings,
    hooks: {
        settingsSectionOpened(sectionId) {
            if (sectionId === 'account') this.loadProfileEditor();
        },
        settingsSectionClosed(sectionId) {
            if (sectionId === 'account') this.closeProfileEditor();
        },
    },
};
