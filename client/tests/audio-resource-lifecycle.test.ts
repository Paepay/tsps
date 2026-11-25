import assert from "node:assert/strict";

import { IndexType } from "../rs/cache/IndexType";
import { MusicTrack } from "../game/audio/music/patch/MusicTrack";
import { RealtimeMidiSynth } from "../game/audio/music/realtime/RealtimeMidiSynth";
import { SoundEffectSystem } from "../game/audio/SoundEffectSystem";

// Long sessions load many areas. Every area's track used to leave its decoded samples in the
// persistent MIDI worklet and every one-shot effect left its source connected to the SFX bus,
// so the browser's audio graph grew for the rest of the session (#184).

class FakeParam {
    value = 0;
    setValueAtTime() {}
    linearRampToValueAtTime() {}
    cancelScheduledValues() {}
}

class FakeNode {
    disconnected = false;
    connect(): this {
        return this;
    }
    disconnect(): void {
        this.disconnected = true;
    }
}

class FakeGain extends FakeNode {
    gain = new FakeParam();
}

class FakeSource extends FakeNode {
    buffer: any = null;
    loop = false;
    loopStart = 0;
    loopEnd = 0;
    started = false;
    stopped = false;
    private readonly listeners = new Map<string, Array<() => void>>();

    addEventListener(type: string, listener: () => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
    }

    start(): void {
        this.started = true;
    }

    stop(): void {
        this.stopped = true;
        this.emit("ended");
    }

    emit(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener();
    }
}

class FakeAudioContext {
    state = "running";
    currentTime = 0;
    destination = new FakeNode();
    readonly sources: FakeSource[] = [];
    readonly gains: FakeGain[] = [];
    closed = false;

    createGain(): FakeGain {
        const gain = new FakeGain();
        this.gains.push(gain);
        return gain;
    }

    createBufferSource(): FakeSource {
        const source = new FakeSource();
        this.sources.push(source);
        return source;
    }

    createBuffer(_channels: number, length: number, sampleRate: number): any {
        return {
            duration: length / sampleRate,
            length,
            sampleRate,
            copyToChannel() {},
            getChannelData: () => new Float32Array(length),
        };
    }

    resume(): Promise<void> {
        return Promise.resolve();
    }

    suspend(): Promise<void> {
        return Promise.resolve();
    }

    close(): Promise<void> {
        this.closed = true;
        return Promise.resolve();
    }
}

async function oneShotSourcesAreDisconnectedWhenTheyEnd(): Promise<void> {
    const previousWindow = (globalThis as any).window;
    (globalThis as any).window = { AudioContext: FakeAudioContext };
    try {
        const loader = {
            available: () => true,
            load: () => ({
                sampleRate: 22050,
                samples: new Int8Array([0, 64, 0, -64]),
                start: 0,
                end: 0,
            }),
        };
        const system = new SoundEffectSystem(loader as any);
        system.playSoundEffect(1);

        const ctx = (system as any).context as FakeAudioContext;
        assert.equal(ctx.sources.length, 1, "the effect created a source");
        const source = ctx.sources[0];
        assert.equal(source.started, true);
        assert.equal(source.disconnected, false, "a playing source stays connected");

        source.emit("ended");
        assert.equal(
            source.disconnected,
            true,
            "an ended one-shot disconnects from the bus so its buffer can be freed",
        );
        assert.equal((system as any).activeSources.length, 0, "the ended source is forgotten");
        system.dispose();
        system.dispose();
        assert.equal(ctx.closed, true, "dispose is idempotent");
    } finally {
        (globalThis as any).window = previousWindow;
    }
}

function workletSampleTableCanBeReset(): void {
    let Processor: any;
    const code = (RealtimeMidiSynth.prototype as any).getWorkletProcessorCode.call({});
    new Function("AudioWorkletProcessor", "registerProcessor", "sampleRate", code)(
        class {
            port = { onmessage: null, postMessage() {} };
        },
        (_name: string, cls: any) => (Processor = cls),
        48000,
    );
    const processor = new Processor();
    processor.handleMessage({
        type: "loadSample",
        index: 11,
        samples: new Float32Array(64),
        sampleRate: 22050,
        looped: false,
        loopStart: 0,
        loopEnd: 0,
    });
    assert.equal(processor.samples.size, 1);
    processor.handleMessage({ type: "resetSamples" });
    assert.equal(processor.samples.size, 0, "a reset drops the previous area's samples");
}

async function loadingAnotherTrackResetsTheSampleCache(): Promise<void> {
    const synth: any = new RealtimeMidiSynth({} as any);
    synth.workletReady = true;
    const messages: any[] = [];
    synth.workletNode = { port: { postMessage: (message: any) => messages.push(message) } };
    synth.gainNode = new FakeGain();
    synth.context = new FakeAudioContext();
    synth.parseMidi = () => {
        synth.events = [{ type: "endOfTrack", tick: 0 }];
    };
    synth.buildTempoMap = () => {};

    const originalToMidi = (MusicTrack as any).toMidi;
    (MusicTrack as any).toMidi = () => new Uint8Array([0, 1, 2, 3]);
    try {
        synth.loadedSamples.add(7);
        synth.loadedSamples.add(8);
        const cache = {
            getIndex: (index: number) =>
                index === IndexType.DAT2.musicTracks
                    ? { getFileSmart: () => ({ data: new Uint8Array([1, 2, 3, 4]) }) }
                    : null,
        };
        synth.cache = cache;

        assert.equal(await synth.loadTrack(100), true);
        assert.equal(
            messages.filter((message) => message.type === "resetSamples").length,
            1,
            "loading a track clears the previous area's worklet samples",
        );
        assert.equal(synth.loadedSamples.size, 0, "the previous area's sample ids are forgotten");

        assert.equal(await synth.loadTrack(101), true);
        assert.equal(
            messages.filter((message) => message.type === "resetSamples").length,
            2,
            "each load resets once instead of accumulating",
        );
        assert.equal(synth.loadedSamples.size, 0);
    } finally {
        (MusicTrack as any).toMidi = originalToMidi;
    }
}

async function main(): Promise<void> {
    await oneShotSourcesAreDisconnectedWhenTheyEnd();
    workletSampleTableCanBeReset();
    await loadingAnotherTrackResetsTheSampleCache();
    console.log("audio-resource-lifecycle.test.ts: all tests passed");
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
