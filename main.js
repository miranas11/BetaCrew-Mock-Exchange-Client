const net = require("net");
const fs = require("fs");

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
        console.log("Connected to server");

        if (missingPackets.size > 0) {
            missingPackets.forEach((seq) => {
                const requestSpecificPacket = createCommand(0x02, seq);
                client.write(requestSpecificPacket);
            });
            missingPackets.clear();
        } else {
            const requestAllPackets = createCommand(0x01);
            client.write(requestAllPackets);
        }
    });

    client.on("data", (data) => {
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
                for (let seq = expectedSequence; seq < packetSequence; seq++) {
                    missingPackets.add(seq);
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

            resetInactivityTimeout();
        }
    });

    client.on("end", () => {
        console.log("Disconnected from server");
        if (missingPackets.size > 0) {
            console.log("Reconnecting to request missing packets...");
            setTimeout(connectToClient, 1000);
        } else {
            packetData.sort((a, b) => a.packetSequence - b.packetSequence);
            fs.writeFileSync(
                "packetData.json",
                JSON.stringify(packetData, null, 2)
            );
        }
    });

    client.on("error", (err) => {
        console.error("Error:", err.message);
    });
};

const resetInactivityTimeout = () => {
    clearTimeout(inactivityTimeout);
    inactivityTimeout = setTimeout(() => {
        if (missingPackets.size === 0) {
            console.log("No activity for 5 seconds. Closing connection.");
            client.end();
        }
    }, 2000);
};

connectToClient();
