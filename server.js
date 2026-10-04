const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const waitingUsers = [];
const partners = new Map();
const users = new Map();
const socketToUserId = new Map();
const blockedUsers = new Map();
const lastMessageAt = new Map();

const adjectives = [
    "Blue", "Happy", "Cool", "Brave", "Silent",
    "Lucky", "Smart", "Swift", "Chill", "Sunny",
    "Kind", "Cosmic", "Misty", "Golden", "Wild"
];

const animals = [
    "Tiger", "Lion", "Eagle", "Wolf", "Panda",
    "Fox", "Bear", "Falcon", "Rabbit", "Dolphin",
    "Otter", "Koala", "Hawk", "Leopard", "Penguin"
];

function generateUsername() {
    const adjective =
        adjectives[Math.floor(Math.random() * adjectives.length)];

    const animal =
        animals[Math.floor(Math.random() * animals.length)];

    const number = Math.floor(Math.random() * 90) + 10;

    return `${adjective}${animal}${number}`;
}

function getOnlineMemberCount() {
    // Count unique registered identities with active connections.
    return new Set(socketToUserId.values()).size;
}

function broadcastOnlineCount() {
    io.emit("online-count", getOnlineMemberCount());
}

function removeFromWaiting(socketId) {
    let index;

    while ((index = waitingUsers.indexOf(socketId)) !== -1) {
        waitingUsers.splice(index, 1);
    }
}

function isBlocked(userId1, userId2) {
    return blockedUsers.get(userId1)?.has(userId2) || false;
}

function endChat(socketId, notifyPartner = true) {
    const partnerId = partners.get(socketId);

    removeFromWaiting(socketId);

    if (!partnerId) {
        return;
    }

    partners.delete(socketId);
    partners.delete(partnerId);

    const partnerSocket = io.sockets.sockets.get(partnerId);

    if (notifyPartner && partnerSocket) {
        partnerSocket.emit("chat-ended");
    }
}

function findStranger(socket) {
    const socketId = socket.id;
    const userId = socketToUserId.get(socketId);

    if (!userId) {
        socket.emit("system-message", "Please wait while your identity loads.");
        return;
    }

    if (partners.has(socketId)) {
        socket.emit("system-message", "You are already chatting.");
        return;
    }

    removeFromWaiting(socketId);

    // Only inspect candidates already waiting at the start of this search.
    // This prevents an endless loop if users cannot be matched.
    const candidatesToCheck = waitingUsers.length;

    for (let i = 0; i < candidatesToCheck; i++) {
        const strangerId = waitingUsers.shift();

        if (!strangerId || strangerId === socketId) {
            continue;
        }

        const strangerSocket = io.sockets.sockets.get(strangerId);
        const strangerUserId = socketToUserId.get(strangerId);

        if (!strangerSocket || !strangerUserId) {
            continue;
        }

        // A user must not be matched with another tab of themselves.
        if (strangerUserId === userId) {
            waitingUsers.push(strangerId);
            continue;
        }

        // Do not match users who have blocked one another.
        if (
            isBlocked(userId, strangerUserId) ||
            isBlocked(strangerUserId, userId)
        ) {
            waitingUsers.push(strangerId);
            continue;
        }

        const myUser = users.get(userId);
        const strangerUser = users.get(strangerUserId);

        if (!myUser || !strangerUser) {
            continue;
        }

        partners.set(socketId, strangerId);
        partners.set(strangerId, socketId);

        socket.emit("matched", {
            username: strangerUser.username
        });

        strangerSocket.emit("matched", {
            username: myUser.username
        });

        console.log(
            `${myUser.username} matched with ${strangerUser.username}`
        );

        return;
    }

    waitingUsers.push(socketId);
    socket.emit("waiting");
}

io.on("connection", (socket) => {
    console.log("Socket connected:", socket.id);

    // Send the latest count immediately, including to new connections.
    socket.emit("online-count", getOnlineMemberCount());

    socket.on("register-user", (data) => {
        if (!data || typeof data.userId !== "string") {
            return;
        }

        const userId = data.userId.trim();

        // This is a prototype identifier, not verified authentication.
        if (userId.length < 10 || userId.length > 100) {
            socket.emit("system-message", "Unable to register your identity.");
            return;
        }

        // Disconnecting and reconnecting with the same browser ID
        // retains the username while this server process is running.
        let user = users.get(userId);

        if (!user) {
            user = { username: generateUsername() };
            users.set(userId, user);
        }

        socketToUserId.set(socket.id, userId);

        socket.emit("your-identity", {
            username: user.username
        });

        broadcastOnlineCount();

        console.log(`${user.username} registered`);
    });

    socket.on("find-stranger", () => {
        findStranger(socket);
    });

    socket.on("send-message", (message) => {
        const partnerId = partners.get(socket.id);

        if (!partnerId || typeof message !== "string") {
            return;
        }

        message = message.trim();

        if (!message) {
            return;
        }

        if (message.length > 1000) {
            socket.emit(
                "system-message",
                "Messages can contain up to 1000 characters."
            );
            return;
        }

        // Basic server-side message cooldown.
        const now = Date.now();
        const lastSent = lastMessageAt.get(socket.id) || 0;

        if (now - lastSent < 500) {
            socket.emit(
                "system-message",
                "Please slow down before sending another message."
            );
            return;
        }

        lastMessageAt.set(socket.id, now);

        const partnerSocket = io.sockets.sockets.get(partnerId);

        if (!partnerSocket) {
            endChat(socket.id, false);
            socket.emit("chat-ended");
            return;
        }

        const senderUserId = socketToUserId.get(socket.id);
        const sender = users.get(senderUserId);

        partnerSocket.emit("receive-message", {
            text: message,
            username: sender?.username || "Stranger"
        });
    });

    socket.on("next-stranger", () => {
        endChat(socket.id, true);
        findStranger(socket);
    });

    socket.on("end-chat", () => {
        endChat(socket.id, true);
    });

    socket.on("block-user", () => {
        const partnerId = partners.get(socket.id);

        if (!partnerId) {
            return;
        }

        const userId = socketToUserId.get(socket.id);
        const strangerUserId = socketToUserId.get(partnerId);

        if (!userId || !strangerUserId) {
            return;
        }

        if (!blockedUsers.has(userId)) {
            blockedUsers.set(userId, new Set());
        }

        blockedUsers.get(userId).add(strangerUserId);

        socket.emit("user-blocked");

        console.log(
            `${users.get(userId)?.username} blocked ` +
            `${users.get(strangerUserId)?.username}`
        );

        endChat(socket.id, true);
    });

    socket.on("report-user", (reason) => {
        const partnerId = partners.get(socket.id);

        if (!partnerId) {
            return;
        }

        if (typeof reason !== "string") {
            reason = "";
        }

        reason = reason.trim().slice(0, 200);

        const reporterId = socketToUserId.get(socket.id);
        const reportedId = socketToUserId.get(partnerId);

        console.log("USER REPORT:", {
            reporter: users.get(reporterId)?.username || "Unknown",
            reported: users.get(reportedId)?.username || "Unknown",
            reason: reason || "No reason provided",
            time: new Date().toISOString()
        });

        socket.emit("report-submitted");

        endChat(socket.id, true);
    });

    socket.on("disconnect", () => {
        const userId = socketToUserId.get(socket.id);
        const user = users.get(userId);

        removeFromWaiting(socket.id);
        endChat(socket.id, true);

        socketToUserId.delete(socket.id);
        lastMessageAt.delete(socket.id);

        if (user) {
            console.log(`${user.username} disconnected`);
        }

        broadcastOnlineCount();
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Chat Duniya running at http://localhost:${PORT}`);
});