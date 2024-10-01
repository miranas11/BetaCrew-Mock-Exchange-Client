const net = require("net");
const fs = require("fs");
const path = require("path");
const logFile = path.join(__dirname, "client.log");

const logStream = fs.createWriteStream(logFile, { flags: "a" });

function log(message) {
    const timestamp = new Date().toISOString();
    logStream.write(`[${timestamp}] ${message}\n`);
    console.log(`[${timestamp}] ${message}`);
}

function createCommand(commandType, sequenceNumber = 0x00) {
    const buffer = Buffer.alloc(2);
    buffer.writeInt8(commandType, 0);
    buffer.writeInt8(sequenceNumber, 1);
    return buffer;
}

let client;
let expectedSequence = 1;
let missingPackets = new Set();
let incompleteBuffer = Buffer.alloc(0);
let inactivityTimeout;
let packetData = [];

const connectToClient = () => {
    client = net.createConnection({ port: 3000 }, () => {
        log("Connected to server");
        try {
            if (missingPackets.size > 0) {
                missingPackets.forEach((seq) => {
                    const requestSpecificPacket = createCommand(0x02, seq);
                    client.write(requestSpecificPacket);
                    log(`Requested missing packet with sequence ${seq}`);
                });
                missingPackets.clear();
            } else {
                const requestAllPackets = createCommand(0x01);
                client.write(requestAllPackets);
                log("Requested all packets from server.");
            }
        } catch (e) {
            log(`Error sending command to server: ${e.message}`);
        }
    });

    client.on("data", (data) => {
        try {
            incompleteBuffer = Buffer.concat([incompleteBuffer, data]);

            const PACKET_SIZE = 17;

            while (incompleteBuffer.length >= PACKET_SIZE) {
                const packet = incompleteBuffer.slice(0, PACKET_SIZE);
                incompleteBuffer = incompleteBuffer.slice(PACKET_SIZE);

                const symbol = packet.slice(0, 4).toString("ascii");
                const buysellindicator = packet.slice(4, 5).toString("ascii");
                const quantity = packet.readInt32BE(5);
                const price = packet.readInt32BE(9);
                const packetSequence = packet.readInt32BE(13);

                if (packetSequence > expectedSequence) {
                    for (
                        let seq = expectedSequence;
                        seq < packetSequence;
                        seq++
                    ) {
                        missingPackets.add(seq);
                        log(`Detected missing packet with sequence ${seq}`);
                    }
                    expectedSequence = packetSequence + 1;
                } else {
                    expectedSequence++;
                }

                packetData.push({
                    symbol,
                    buysellindicator,
                    quantity,
                    price,
                    packetSequence,
                });
                log(`Received packet: Symbol=${symbol}, Seq=${packetSequence}`);
                resetInactivityTimeout();
            }
        } catch (e) {
            log(`Error processing data: ${e.message}`);
        }
    });

    client.on("end", () => {
        log("Disconnected from server");
        if (missingPackets.size > 0) {
            log("Reconnecting to request missing packets...");
            setTimeout(connectToClient, 1000);
        } else {
            packetData.sort((a, b) => a.packetSequence - b.packetSequence);
            try {
                fs.writeFileSync(
                    "packetData.json",
                    JSON.stringify(packetData, null, 2)
                );
                log("Saved packet data to packetData.json");
            } catch (e) {
                log(`Error writing packet data to file: ${e.message}`);
            }
        }
    });

    client.on("error", (err) => {
        log(`Client error: ${err.message}`);
        if (err.code === "ECONNREFUSED") {
            log("Server is down. Retrying connection...");
            setTimeout(connectToClient, 1500);
        } else {
            log(`Unhandled client error: ${err.code}`);
        }
    });
};

const resetInactivityTimeout = () => {
    clearTimeout(inactivityTimeout);
    inactivityTimeout = setTimeout(() => {
        if (missingPackets.size === 0) {
            log("No activity for 2 seconds. Closing connection.");
            client.end();
        }
    }, 2000);
};

connectToClient();
