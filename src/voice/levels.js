/**
 * Constants and level math of the voice chat. Kept apart from session.js, which is
 * only loaded (with LiveKit and the worklets) when someone uses the voice chat.
 */

/** Transmit modes of the voice gate. */
export const VOICE_MODES = ['vad', 'ptt', 'open'];

/** Keys (KeyboardEvent.code) offered for push-to-talk – none of them types text. */
export const VOICE_PTT_KEYS = ['F8', 'F9', 'F10', 'ControlRight', 'AltRight', 'Pause'];

/** Mic level in dBFS that the meter shows as empty / full. */
export const METER_MIN_DB = -80;
export const METER_MAX_DB = 0;

export function levelToPercent(db) {
    const clamped = Math.min(METER_MAX_DB, Math.max(METER_MIN_DB, Number(db) || METER_MIN_DB));
    return Math.round(((clamped - METER_MIN_DB) / (METER_MAX_DB - METER_MIN_DB)) * 100);
}

export function percentToLevel(percent) {
    const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
    return METER_MIN_DB + (clamped / 100) * (METER_MAX_DB - METER_MIN_DB);
}
