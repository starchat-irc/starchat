/**
 * Voice gate (AudioWorklet, runs on the audio thread)
 *
 * Decides per 128-sample block whether the microphone is sent:
 *  - mode 'open': always
 *  - mode 'ptt':  while the push-to-talk key is held
 *  - mode 'vad':  while the level is above the threshold, plus a short hold time
 *                 so word endings and short pauses are not cut off
 * The gain is ramped (fast attack, slower release) so opening and closing never clicks.
 * Every ~50 ms it reports { level (dBFS), open } to the main thread for the level meter.
 *
 * Plain script on purpose: it is loaded as a separate file via audioWorklet.addModule().
 */
const HOLD_SECONDS = 0.35;
const REPORT_SECONDS = 0.05;
const ATTACK_SECONDS = 0.005;
const RELEASE_SECONDS = 0.08;
const SILENCE_DB = -100;

class VoiceGate extends AudioWorkletProcessor {
    constructor() {
        super();
        this.mode = 'vad';
        this.thresholdDb = -50;
        this.pttActive = false;
        this.muted = false;
        this.gain = 0;
        this.holdUntil = 0;
        this.nextReport = 0;
        this.smoothedDb = SILENCE_DB;

        this.port.onmessage = (event) => {
            const data = event.data || {};
            if (typeof data.mode === 'string') this.mode = data.mode;
            if (typeof data.thresholdDb === 'number') this.thresholdDb = data.thresholdDb;
            if (typeof data.pttActive === 'boolean') this.pttActive = data.pttActive;
            if (typeof data.muted === 'boolean') this.muted = data.muted;
        };
    }

    process(inputs, outputs) {
        const input = inputs[0]?.[0];
        const output = outputs[0]?.[0];
        if (!output) return true;
        if (!input) {
            output.fill(0);
            return true;
        }

        let sum = 0;
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        const rms = Math.sqrt(sum / input.length);
        const db = rms > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(rms)) : SILENCE_DB;
        // Rise instantly, fall slowly: steadier meter and gate
        this.smoothedDb = db > this.smoothedDb ? db : this.smoothedDb * 0.9 + db * 0.1;

        let open;
        if (this.muted) {
            open = false;
        } else if (this.mode === 'open') {
            open = true;
        } else if (this.mode === 'ptt') {
            open = this.pttActive;
        } else {
            if (this.smoothedDb >= this.thresholdDb) this.holdUntil = currentTime + HOLD_SECONDS;
            open = currentTime < this.holdUntil;
        }

        const target = open ? 1 : 0;
        const seconds = open ? ATTACK_SECONDS : RELEASE_SECONDS;
        const coefficient = 1 - Math.exp(-1 / (seconds * sampleRate));
        for (let i = 0; i < input.length; i++) {
            this.gain += (target - this.gain) * coefficient;
            output[i] = input[i] * this.gain;
        }

        if (currentTime >= this.nextReport) {
            this.nextReport = currentTime + REPORT_SECONDS;
            this.port.postMessage({ level: this.smoothedDb, open });
        }
        return true;
    }
}

registerProcessor('starchat-voice-gate', VoiceGate);
