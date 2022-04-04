import { EventEmitter } from 'events';
import { Readable, Writable } from 'stream';

const colors = /\u001b\[([0-9]+)m|\u001b/g;

const db = /^(\[(pid=)?[0-9\->]+\])?(\[\d+\])?DB\<+([0-9]+)\>+$/;

const ansiSeq = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g;

function cleanLine(line: string) {
    return line.replace(colors, '').replace(/\s|(\\b)/g, '').replace('\b', '');
}

const lastCommandLine = {
    test(line: string) {
        const stripped = cleanLine(line);
        return db.test(stripped);
    },

    match(line: string) {
        const stripped = cleanLine(line);
        return stripped.match(db);
    }
};

interface RequestTask {
    command: string | null,
    resolve: Function,
    reject: Function,
}

export class StreamCatcher extends EventEmitter {
    public debug: boolean = false;
    private requestQueue: RequestTask[] = [];
    private requestRunning: RequestTask | null = null;

    private buffer: string[] = [''];

    public input!: Writable;

    constructor() {
        super();
    }

    async launch(input: Writable, output: Readable): Promise<string[]> {
        this.input = input;

        let lastBuffer = '';
        output.on('data', (buffer) => {
            // remove ansi sequences from buffer to ensure consistent parsing
            const data = lastBuffer + buffer.toString().replace(ansiSeq, '');
            const lines = data.split(/\r?\n/);
            const lastLine = lines[lines.length - 1];

            if (lastCommandLine.test(lastLine)) {
                lastBuffer = '';
            } else {
                lastBuffer = lines.pop()!;
            }
            lines.forEach(line => this.readline(line));
        });

        return this.request(null);
    }

    readline(line: string) {
        // Remove unnecessary tabs and spaces
        line = line.trim();
        this.buffer.push(line);
        if (lastCommandLine.test(line)) {
            const data = this.buffer;
            this.buffer = [];
            this.resolveRequest(data);
        }
    }

    resolveRequest(data: string[]) {
        const req = this.requestRunning;
        if (req) {
            if (req.command) {
                data.unshift(req.command);
            }

            req.resolve(data);
            // Reset state making room for next task
            this.buffer = [];
            this.requestRunning = null;
        }
        this.nextRequest();
    }

    nextRequest() {
        if (!this.requestRunning && this.requestQueue.length) {
            this.requestRunning = this.requestQueue.shift()!;
            if (this.requestRunning.command !== null) {
                const data = `${this.requestRunning.command}\n`;
                this.input.write(data);
            }
        }
    }

    request(command: string | null): Promise<string[]> {
        return new Promise((resolve, reject) => {
            // Add our request to the queue
            this.requestQueue.push({
                command,
                resolve,
                reject
            });

            this.nextRequest();
        });
    }

    destroy() {
        this.removeAllListeners();
        return Promise.resolve();
    }
}
