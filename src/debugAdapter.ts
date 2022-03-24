import { PerlDebugSession } from './perlDebug';

import * as Net from 'net';

let port = 0;
const args = process.argv.slice(2);
args.forEach(function (val, index, array) {
	const portMatch = /^--server=(\d{4,5})$/.exec(val);
	if (portMatch) {
		port = parseInt(portMatch[1], 10);
	}
});

if (port > 0) {
	// start a server that creates a new session for every connection request
	console.error(`waiting for debug protocol on port ${port}`);
	Net.createServer((socket) => {
		console.error('>> accepted connection from client');
		socket.on('end', () => {
			console.error('>> client connection closed\n');
		});
		const session = new PerlDebugSession();
		session.setRunAsServer(true);
		session.start(socket, socket);
	}).listen(port);
} else {

	// start a single session that communicates via stdin/stdout
	const session = new PerlDebugSession();
	process.on('SIGTERM', () => {
		session.shutdown();
	});
	session.start(process.stdin, process.stdout);
}
