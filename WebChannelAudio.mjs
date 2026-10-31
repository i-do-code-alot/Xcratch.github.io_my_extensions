const EXTENSION_ID = 'webChannelAudio';

const BLOCK_TYPE = {
    COMMAND: 'command',
    REPORTER: 'reporter'
};

/*
 * Web Channel adapter
 *
 * This is the one integration point that must match the actual
 * Web Channel extension API.
 */
class WebChannelAdapter {
    constructor(runtime) {
        this.runtime = runtime;
        this.webChannel = null;
    }

    connect() {
        /*
         * Connect to the already-loaded Web Channel extension here.
         * Obtain its active server and channel from that extension.
         *
         * Required adapter operations:
         *   getServer()
         *   getChannel()
         *   sendAudio(packet)
         *   onAudio(callback)
         */
        throw new Error(
            'Web Channel API adapter has not been connected.'
        );
    }

    getServer() {
        return this.webChannel.getServer();
    }

    getChannel() {
        return this.webChannel.getChannel();
    }

    sendAudio(packet) {
        return this.webChannel.sendAudio(packet);
    }

    onAudio(callback) {
        return this.webChannel.onAudio(callback);
    }
}

class ExtensionBlocks {
    constructor(runtime) {
        this.runtime = runtime;

        this.channel = new WebChannelAdapter(runtime);

        this.captureStream = null;
        this.recorder = null;
        this.audioSubscription = null;

        this.audioElement = null;
        this.audioQueue = [];
        this.playing = false;

        this.status = 'Stopped';
        this.error = '';
    }

    getInfo() {
        return {
            id: EXTENSION_ID,
            name: 'Web Channel Audio',
            extensionURL: ExtensionBlocks.extensionURL,
            showStatusButton: true,

            blocks: [
                {
                    opcode: 'startAudioToServer',
                    blockType: BLOCK_TYPE.COMMAND,
                    text: 'audio to server'
                },
                {
                    opcode: 'stopAudioToServer',
                    blockType: BLOCK_TYPE.COMMAND,
                    text: 'stop audio to server'
                },
                {
                    opcode: 'startAudioFromServer',
                    blockType: BLOCK_TYPE.COMMAND,
                    text: 'audio from server'
                },
                {
                    opcode: 'stopAudioFromServer',
                    blockType: BLOCK_TYPE.COMMAND,
                    text: 'stop audio from server'
                },
                {
                    opcode: 'getAudioStatus',
                    blockType: BLOCK_TYPE.REPORTER,
                    text: 'audio status'
                },
                {
                    opcode: 'getAudioError',
                    blockType: BLOCK_TYPE.REPORTER,
                    text: 'audio error'
                }
            ],

            menus: {}
        };
    }

    async startAudioToServer() {
        try {
            this.error = '';

            // Use Web Channel's existing server and channel.
            this.channel.connect();

            const server = this.channel.getServer();
            const channel = this.channel.getChannel();

            if (!server || !channel) {
                throw new Error('No active Web Channel server or channel.');
            }

            // Browser permission is required.
            // This captures shared display/tab audio, not microphone audio.
            this.captureStream =
                await navigator.mediaDevices.getDisplayMedia({
                    video: true,
                    audio: true
                });

            const audioTracks =
                this.captureStream.getAudioTracks();

            if (audioTracks.length === 0) {
                throw new Error(
                    'The selected display source has no audio track.'
                );
            }

            const mimeType = MediaRecorder.isTypeSupported(
                'audio/webm;codecs=opus'
            )
                ? 'audio/webm;codecs=opus'
                : 'audio/webm';

            this.recorder = new MediaRecorder(
                new MediaStream(audioTracks),
                { mimeType }
            );

            this.recorder.ondataavailable = async event => {
                if (!event.data || event.data.size === 0) {
                    return;
                }

                try {
                    const bytes = await event.data.arrayBuffer();

                    this.channel.sendAudio({
                        type: 'audio',
                        server,
                        channel,
                        mimeType: event.data.type,
                        data: bytes
                    });
                } catch (error) {
                    this.error = error.message;
                }
            };

            this.recorder.onerror = event => {
                this.error =
                    event.error?.message || 'Audio recording failed.';
            };

            this.recorder.start(250);
            this.status = 'Sending audio';

        } catch (error) {
            this.error = error.message;
            this.status = 'Error';
            this.stopAudioToServer();
        }
    }

    stopAudioToServer() {
        if (this.recorder && this.recorder.state !== 'inactive') {
            this.recorder.stop();
        }

        if (this.captureStream) {
            this.captureStream.getTracks().forEach(track => track.stop());
        }

        this.recorder = null;
        this.captureStream = null;

        if (this.status === 'Sending audio') {
            this.status = 'Stopped';
        }
    }

    startAudioFromServer() {
        try {
            this.error = '';
            this.channel.connect();

            this.audioElement = new Audio();
            this.audioElement.autoplay = true;

            this.audioSubscription = this.channel.onAudio(packet => {
                if (!packet || packet.type !== 'audio') {
                    return;
                }

                this.audioQueue.push(packet);
                this.playNextAudio();
            });

            this.status = 'Receiving audio';

        } catch (error) {
            this.error = error.message;
            this.status = 'Error';
        }
    }

    async playNextAudio() {
        if (this.playing || this.audioQueue.length === 0) {
            return;
        }

        this.playing = true;

        try {
            const packet = this.audioQueue.shift();

            const blob = new Blob(
                [packet.data],
                { type: packet.mimeType || 'audio/webm' }
            );

            const url = URL.createObjectURL(blob);

            this.audioElement.src = url;
            await this.audioElement.play();

            this.audioElement.onended = () => {
                URL.revokeObjectURL(url);
                this.playing = false;
                this.playNextAudio();
            };

        } catch (error) {
            this.error = error.message;
            this.playing = false;
        }
    }

    stopAudioFromServer() {
        if (typeof this.audioSubscription === 'function') {
            this.audioSubscription();
        }

        this.audioSubscription = null;
        this.audioQueue = [];
        this.playing = false;

        if (this.audioElement) {
            this.audioElement.pause();
            this.audioElement.removeAttribute('src');
            this.audioElement.load();
        }

        this.audioElement = null;
        this.status = 'Stopped';
    }

    getAudioStatus() {
        return this.status;
    }

    getAudioError() {
        return this.error;
    }

    dispose() {
        this.stopAudioToServer();
        this.stopAudioFromServer();
    }
}

ExtensionBlocks.extensionURL =
    'https://YOUR-HOST/WebChannelAudio.mjs';

const entry = {
    name: 'Web Channel Audio',
    extensionId: EXTENSION_ID,
    extensionURL: ExtensionBlocks.extensionURL,
    collaborator: 'YOUR-XCRATCH-NAME',
    iconURL: '',
    insetIconURL: '',
    description: 'Send and receive audio through Web Channel.',
    tags: ['audio', 'web channel', 'communication'],
    featured: false,
    disabled: false,
    bluetoothRequired: false,
    internetConnectionRequired: true,
    helpLink: ''
};

export {
    ExtensionBlocks as blockClass,
    entry
};
