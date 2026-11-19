/**
 * Always-on module (feature "alwaysOn")
 * "Stay online": the nick stays in the channels while no client is connected (bouncer,
 * e.g. Ergo always-on). After a login the chat asks once per account; the answer is kept
 * on the server, so the next device does not ask again. The account section of the
 * settings offers a switch. API: docs/discovery.md.
 */

export function emptyAlwaysOnState() {
    return {
        loaded: false,
        loadFailed: false,
        enabled: false,
        showPrompt: false,
        saving: false,
        notice: '',
        error: '',
    };
}

/** First validation message of a Laravel style error answer. */
function errorMessage(data, fallback) {
    return Object.values(data?.errors || {})[0]?.[0] || data?.message || fallback;
}

export function alwaysOnMixin() {
    return {
        alwaysOn: emptyAlwaysOnState(),
        _alwaysOnChecked: false,

        canUseAlwaysOn() {
            return this.hasFeature('alwaysOn') && this.hasApiToken;
        },

        /** After every registration, but the server is asked only once per login. */
        async checkAlwaysOnPrompt() {
            if (this._alwaysOnChecked || !this.canUseAlwaysOn()) return;
            this._alwaysOnChecked = true;
            const data = await this.loadAlwaysOn();
            if (data?.ask) this.alwaysOn.showPrompt = true;
        },

        /** @return {Promise<{ enabled: boolean, ask: boolean }|null>} */
        async loadAlwaysOn() {
            if (!this.canUseAlwaysOn()) return null;
            try {
                const response = await this.connection.api('chat/always-on');
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const data = await response.json();
                this.alwaysOn.enabled = Boolean(data.enabled);
                this.alwaysOn.loaded = true;
                this.alwaysOn.loadFailed = false;
                return data;
            } catch (error) {
                // The settings show the switch disabled with a hint instead of hiding it
                console.warn('Could not load the always-on state:', error);
                this.alwaysOn.loadFailed = true;
                return null;
            }
        },

        async setAlwaysOn(enabled) {
            if (this.alwaysOn.saving || !this.canUseAlwaysOn()) return false;
            this.alwaysOn.saving = true;
            this.alwaysOn.notice = '';
            this.alwaysOn.error = '';
            try {
                const response = await this.connection.api('chat/always-on', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ enabled }),
                });
                const data = await response.json().catch(() => ({}));
                if (!response.ok) {
                    // Validation errors are specific, anything else gets our own text
                    throw new Error(response.status === 422 ? errorMessage(data, this.t('always_on_unavailable')) : this.t('always_on_unavailable'));
                }
                this.alwaysOn.enabled = Boolean(data.enabled);
                this.alwaysOn.loaded = true;
                this.alwaysOn.notice = this.t(this.alwaysOn.enabled ? 'always_on_enabled' : 'always_on_disabled');
                return true;
            } catch (error) {
                this.alwaysOn.error = error instanceof TypeError ? this.t('always_on_unavailable') : error.message;
                return false;
            } finally {
                this.alwaysOn.saving = false;
            }
        },

        async acceptAlwaysOnPrompt() {
            if (await this.setAlwaysOn(true)) this.alwaysOn.showPrompt = false;
        },

        /** "No, thanks" is kept on the server; closing without an answer asks again next time. */
        async declineAlwaysOnPrompt() {
            this.alwaysOn.showPrompt = false;
            this.alwaysOn.error = '';
            try {
                await this.connection.api('chat/always-on/dismiss', { method: 'POST' });
            } catch (error) {
                console.warn('Could not store the always-on answer:', error);
            }
        },

        closeAlwaysOnPrompt() {
            if (this.alwaysOn.saving) return;
            this.alwaysOn.showPrompt = false;
            this.alwaysOn.error = '';
        },

        /** Switch in the settings: goes back when the server refuses. */
        async toggleAlwaysOn(event) {
            const wanted = Boolean(event?.target?.checked);
            if (!(await this.setAlwaysOn(wanted)) && event?.target) event.target.checked = this.alwaysOn.enabled;
        },
    };
}

/** @type {import('./index.js').ChatModule} */
export const alwaysOnModule = {
    name: 'alwaysOn',
    mixin: alwaysOnMixin,
    hooks: {
        settingsSectionOpened(sectionId) {
            if (sectionId === 'account') this.loadAlwaysOn();
        },
        loggedOut() {
            this.alwaysOn = emptyAlwaysOnState();
            this._alwaysOnChecked = false;
        },
    },
};
