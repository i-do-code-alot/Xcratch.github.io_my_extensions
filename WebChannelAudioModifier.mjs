/*
 * Web Channel Audio Modifier
 *
 * Adds audio transmission and reception to the existing Web Channel.
 * It does not create a separate server or Web Channel.
 *
 * Required integration:
 * The existing Web Channel must expose:
 *
 * globalThis.WebChannelAudioBridge = {
 *     sendAudioChunk: async (packet) => {},
 *     onAudioChunk: (callback) => {
 *         // Return an unsubscribe function.
 *         return () => {};
 *     }
 * };
 */

const EXTENSION_ID = 'webChannelAudioModifier';

class WebChannelAudioModifier {
    constructor(runtime) {
        this.runtime = runtime;

        this.mediaRecorder = null;
        this.captureStream = null;

        this.unsubscribeAudio = null;
        this.isReceiving = false;

        this.audioElement = null;
        this.mediaSource = null;
        this.sourceBuffer = null;

        this.pendingSegments = [];
        this.lastError = '';
    }

    getInfo() {
        return {
            id: EXTENSION_ID,
            name: 'Web Channel Audio',

            color1: '#2878B5',
            color2: '#20669B',
            color3: '#174F7A',

            blocks: [
                {
                    opcode: 'audioToServer',
                    blockType: 'command',
                    text: 'audio to server'
                },
                {
                    opcode: 'stopAudioToServer',
                    blockType: 'command',
                    text: 'stop audio to server'
                },
                {
                    opcode: 'audioFromServer',
                    blockType: 'command',
                    text: 'audio from server'
                },
                {
                    opcode: 'stopAudioFromServer',
                    blockType: 'command',
                    text: 'stop audio from server'
                },
                {
                    opcode: 'audioStatus',
                    blockType: 'reporter',
                    text: 'audio transfer status'
                },
                {
                    opcode: 'audioError',
                    blockType: 'reporter',
                    text: 'audio transfer error'
                }
            ]
        };
    }

    getBridge() {
        return globalThis.WebChannelAudioBridge || null;
    }

    requireBridge() {
        const bridge = this.getBridge();

        if (
            !bridge ||
            typeof bridge.sendAudioChunk !== 'function' ||
            typeof bridge.onAudioChunk !== 'function'
        ) {
            throw new Error(
                'The existing Web Channel does not provide the audio bridge.'
            );
        }

        return bridge;
    }

    async audioToServer() {
        try {
            this.lastError = '';

            if (
                this.mediaRecorder &&
                this.mediaRecorder.state !== 'inactive'
            ) {
                return;
            }

            const bridge = this.requireBridge();

            if (!navigator.mediaDevices?.getDisplayMedia) {
                throw new Error(
                    'This browser does not support audio capture.'
                );
            }

            /*
             * The browser asks the user to choose a tab, window,
             * or screen to share.
             *
             * Audio is captured only if the selected source supports
             * audio sharing and the user enables it.
             */

            const stream =
                await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });

            const audioTracks = stream.getAudioTracks();

            if (audioTracks.length === 0) {
                stream.getTracks().forEach(track => track.stop());

                throw new Error(
                    'No audio was selected. Enable audio sharing.'
                );
            }

            this.captureStream = new MediaStream(audioTracks);

            // The video track is not needed.
            stream.getVideoTracks().forEach(track => track.stop());

            const mimeType = this.getSupportedMimeType();

            this.mediaRecorder = mimeType
                ? new MediaRecorder(this.captureStream, {
                    mimeType: mimeType
                })
                : new MediaRecorder(this.captureStream);

            const actualMimeType =
                this.mediaRecorder.mimeType || mimeType || 'audio/webm';

            let sequence = 0;

            this.mediaRecorder.addEventListener(
                'dataavailable',
                async event => {
                    if (!event.data || event.data.size === 0) {
                        return;
                    }

                    try {
                        const data = await event.data.arrayBuffer();

                        await bridge.sendAudioChunk({
                            kind: 'audio-chunk',
                            mimeType: actualMimeType,
                            sequence: sequence++,
                            data: data
                        });

                    } catch (error) {
                        this.lastError =
                            'Audio sending failed: ' + error.message;
                    }
                }
            );

            this.mediaRecorder.addEventListener('error', event => {
                this.lastError =
                    event.error?.message || 'Audio recording error.';
            });

            this.mediaRecorder.addEventListener('stop', () => {
                if (this.captureStream) {
                    this.captureStream
                        .getTracks()
                        .forEach(track => track.stop());

                    this.captureStream = null;
                }
            });

            // Send audio chunks approximately every 250 milliseconds.
            this.mediaRecorder.start(250);

        } catch (error) {
            this.lastError = error.message || String(error);
            this.stopAudioToServer();
        }
    }

    stopAudioToServer() {
        if (
            this.mediaRecorder &&
            this.mediaRecorder.state !== 'inactive'
        ) {
            this.mediaRecorder.stop();
        }

        if (this.captureStream) {
            this.captureStream
                .getTracks()
                .forEach(track => track.stop());

            this.captureStream = null;
        }

        this.mediaRecorder = null;
    }

    audioFromServer() {
        try {
            this.lastError = '';

            if (this.isReceiving) {
                return;
            }

            const bridge = this.requireBridge();

            this.createAudioPlayer();

            this.unsubscribeAudio = bridge.onAudioChunk(packet => {
                this.receiveAudioChunk(packet);
            });

            this.isReceiving = true;

        } catch (error) {
            this.lastError = error.message || String(error);
        }
    }

    createAudioPlayer() {
        if (!window.MediaSource) {
            throw new Error(
                'This browser does not support MediaSource audio playback.'
            );
        }

        const mimeType = 'audio/webm; codecs="opus"';

        if (!MediaSource.isTypeSupported(mimeType)) {
            throw new Error(
                'This browser does not support WebM Opus streaming.'
            );
        }

        this.audioElement = new Audio();
        this.audioElement.autoplay = true;
        this.audioElement.playsInline = true;

        this.mediaSource = new MediaSource();

        this.audioElement.src =
            URL.createObjectURL(this.mediaSource);

        this.mediaSource.addEventListener('sourceopen', () => {
            try {
                this.sourceBuffer =
                    this.mediaSource.addSourceBuffer(mimeType);

                this.sourceBuffer.addEventListener(
                    'updateend',
                    () => this.appendNextSegment()
                );

                this.appendNextSegment();

            } catch (error) {
                this.lastError = error.message || String(error);
            }
        }, { once: true });
    }

    receiveAudioChunk(packet) {
        if (
            !packet ||
            packet.kind !== 'audio-chunk' ||
            !packet.data
        ) {
            return;
        }

        if (!this.sourceBuffer || !this.mediaSource) {
            return;
        }

        if (packet.mimeType &&
            !packet.mimeType.toLowerCase().includes('webm')) {
            this.lastError = 'Unsupported audio format.';
            return;
        }

        let data;

        if (packet.data instanceof ArrayBuffer) {
            data = packet.data;
        } else if (ArrayBuffer.isView(packet.data)) {
            data = packet.data.buffer.slice(
                packet.data.byteOffset,
                packet.data.byteOffset + packet.data.byteLength
            );
        } else {
            this.lastError = 'Invalid audio data.';
            return;
        }

        this.pendingSegments.push(data);

        this.appendNextSegment();

        this.audioElement.play().catch(() => {
            this.lastError =
                'Browser requires permission to play received audio.';
        });
    }

    appendNextSegment() {
        if (
            !this.sourceBuffer ||
            this.sourceBuffer.updating ||
            this.pendingSegments.length === 0
        ) {
            return;
        }

        try {
            const data = this.pendingSegments.shift();

            this.sourceBuffer.appendBuffer(data);

        } catch (error) {
            this.lastError =
                'Audio playback failed: ' + error.message;
        }
    }

    stopAudioFromServer() {
        if (this.unsubscribeAudio) {
            this.unsubscribeAudio();
            this.unsubscribeAudio = null;
        }

        this.isReceiving = false;
        this.pendingSegments = [];

        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.audioElement.load();
            this.audioElement = null;
        }

        this.sourceBuffer = null;
        this.mediaSource = null;
    }

    audioStatus() {
        if (
            this.mediaRecorder &&
            this.mediaRecorder.state === 'recording'
        ) {
            return 'Sending';
        }

        if (this.isReceiving) {
            return 'Receiving';
        }

        if (this.lastError) {
            return 'Error';
        }

        return 'Stopped';
    }

    audioError() {
        return this.lastError;
    }

    getSupportedMimeType() {
        if (!MediaRecorder.isTypeSupported) {
            return '';
        }

        const formats = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/ogg;codecs=opus'
        ];

        return formats.find(format =>
            MediaRecorder.isTypeSupported(format)
        ) || '';
    }

    dispose() {
        this.stopAudioToServer();
        this.stopAudioFromServer();
    }
}

const entry = {
    name: 'Web Channel Audio',
    extensionId: EXTENSION_ID,
    description: 'Adds audio transmission and reception to Web Channel.',
    tags: ['audio', 'network', 'communication'],
    featured: false,
    disabled: false,
    bluetoothRequired: false,
    internetConnectionRequired: true
};

export {
    WebChannelAudioModifier as blockClass,
    entry
};