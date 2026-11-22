/**
 * Mobile Mixin
 * Small-screen layout: channel sidebar and user list become drawers, long-press
 * replaces hover/right-click (message actions, channel menu).
 */

/** Below this width the chat switches to the drawer layout (keep in sync with chat-styling). */
export const MOBILE_BREAKPOINT = 768;
const LONG_PRESS_MS = 500;
const LONG_PRESS_MOVE_TOLERANCE = 10;

/** Long-press tracking, not reactive state (one chat per page). */
let longPressTimerId = null;
let longPressStart = null;
let longPressFired = false;

export function mobileMixin() {
    return {
        isMobileLayout:       false,
        mobileSidebarOpen:    false,
        mobileUserListOpen:   false,
        touchActionsMessageId: null,
        showInputMoreMenu:    false,
        /** App shell only: the app is in the background (set by app-paused/app-resumed). */
        appInBackground:      false,

        setupMobileLayout() {
            const query = window.matchMedia?.(`(max-width: ${MOBILE_BREAKPOINT}px)`);
            if (!query) return;

            const apply = () => {
                this.isMobileLayout = query.matches;
                if (!query.matches) this.closeMobileDrawers();
            };
            apply();
            query.addEventListener?.('change', apply);
        },

        /**
         * Puts the cursor into the input after a channel switch or closing a dialog (desktop only).
         * On touch devices the user taps the field: a programmatic focus there opens the keyboard
         * unasked and leaves Android's IME on a basic layout without suggestions or spellcheck.
         */
        focusMessageInput() {
            if (this.isMobileLayout) return;
            this.$nextTick?.(() => this.$refs?.messageInput?.focus());
        },

        toggleMobileSidebar() {
            this.mobileUserListOpen = false;
            this.mobileSidebarOpen  = !this.mobileSidebarOpen;
        },

        /** Mobile app: the app shows its list of connections over the chat. */
        showAppConnections() {
            this.closeMobileDrawers();
            this.notifyHost('show-connections');
        },

        closeMobileDrawers() {
            this.mobileSidebarOpen  = false;
            this.mobileUserListOpen = false;
        },

        /** Picking a channel, DM or the friends hub in the drawer closes it; icon-rail clicks keep it open. */
        closeMobileSidebarAfterPick(event) {
            if (!this.isMobileLayout) return;
            const item = event?.target?.closest?.('.channel-item');
            if (item && !event.target.closest('.channel-item-close')) this.mobileSidebarOpen = false;
        },

        // "+" menu of the input bar (small screens)

        toggleInputMoreMenu() {
            this.showInputMoreMenu = !this.showInputMoreMenu;
            if (this.showInputMoreMenu) {
                this.showEmojiPicker = false;
                this.showGifPicker   = false;
                this.showColorPicker = false;
            }
        },

        runInputMoreAction(action) {
            this.showInputMoreMenu = false;
            action?.();
        },

        /**
         * Android back button (app shell): closes the topmost open layer, innermost first.
         * Returns false when nothing was open: the shell then sends the app to the background.
         */
        handleBackButton() {
            if (this.touchActionsMessageId !== null) {
                this.touchActionsMessageId = null;
                return true;
            }
            if (this.showEmojiPicker || this.showGifPicker || this.showColorPicker || this.showInputMoreMenu) {
                this.showEmojiPicker   = false;
                this.showGifPicker     = false;
                this.showColorPicker   = false;
                this.showInputMoreMenu = false;
                return true;
            }
            if (this.settingsWindow?.show) {
                this.closeSettings?.();
                return true;
            }
            if (this.quickSwitcher?.show) {
                this.closeQuickSwitcher();
                return true;
            }
            if (this.mobileSidebarOpen || this.mobileUserListOpen) {
                this.closeMobileDrawers();
                return true;
            }
            return false;
        },

        /** App went to the background: keep the read position, Android may end the app without unload events. */
        handleAppPaused() {
            this.appInBackground = true;
            this.saveChatState?.();
        },

        /** App is back: what is on screen counts as read again, and the connection comes back right away. */
        handleAppResumed() {
            this.appInBackground = false;
            this.socket?.resume?.();
            if (this.isTargetVisible(this.currentChannel)) this.markCurrentChannelAsRead();
            // Another device may have changed the account settings while the app slept
            this.refreshAccountSettings?.();
        },

        hasUnreadOutsideCurrentView() {
            return Boolean(this.channelsHaveUnread || this.friendsIndicatorCount > 0);
        },

        // Long-press (touch replacement for hover and right-click)

        startLongPress(event, handler) {
            this.cancelLongPress();
            const touch = event?.touches?.[0];
            if (!touch || event.touches.length > 1) return;

            longPressFired = false;
            longPressStart = { x: touch.clientX, y: touch.clientY };
            longPressTimerId = setTimeout(() => {
                longPressTimerId = null;
                longPressFired   = true;
                navigator.vibrate?.(10);
                handler({ clientX: longPressStart.x, clientY: longPressStart.y, preventDefault() {} });
            }, LONG_PRESS_MS);
        },

        moveLongPress(event) {
            const touch = event?.touches?.[0];
            if (!touch || !longPressStart) return;
            const moved = Math.abs(touch.clientX - longPressStart.x) > LONG_PRESS_MOVE_TOLERANCE
                || Math.abs(touch.clientY - longPressStart.y) > LONG_PRESS_MOVE_TOLERANCE;
            if (moved) this.cancelLongPress();
        },

        /** Swallows the click that follows a completed long-press, so it doesn't also activate the item. */
        endLongPress(event) {
            clearTimeout(longPressTimerId);
            longPressTimerId = null;
            if (longPressFired) {
                event?.preventDefault?.();
                longPressFired = false;
            }
        },

        cancelLongPress() {
            clearTimeout(longPressTimerId);
            longPressTimerId = null;
            longPressStart   = null;
        },

        showTouchActions(message) {
            this.touchActionsMessageId = message?.id ?? null;
        },

        /** Tapping anywhere outside the toolbar hides the long-press actions again. */
        hideTouchActions(event) {
            if (this.touchActionsMessageId === null) return;
            if (event?.target?.closest?.('.msg-actions')) return;
            this.touchActionsMessageId = null;
        },

        /** Keeps a context menu inside the viewport (narrow screens, long-press near the edge). */
        clampMenuPosition(x, y, width = 240, height = 280) {
            const maxX = Math.max(8, (window.innerWidth || width) - width - 8);
            const maxY = Math.max(8, (window.innerHeight || height) - height - 8);
            return { x: Math.min(Math.max(8, x), maxX), y: Math.min(Math.max(8, y), maxY) };
        },
    };
}
