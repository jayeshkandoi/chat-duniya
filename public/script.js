const socket = io();

// ==============================
// ANONYMOUS BROWSER ID
// ==============================

let anonymousId = localStorage.getItem("chatDuniyaUserId");

if (!anonymousId) {
    anonymousId =
        typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : "cd-" + Date.now() + "-" +
              Math.random().toString(36).slice(2);

    localStorage.setItem("chatDuniyaUserId", anonymousId);
}

// ==============================
// ELEMENTS
// ==============================

const messagesElement = document.getElementById("messages");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const findButton = document.getElementById("find-button");
const nextButton = document.getElementById("next-button");
const endButton = document.getElementById("end-button");
const blockButton = document.getElementById("block-button");
const reportButton = document.getElementById("report-button");
const identityElement = document.getElementById("identity");
const onlineCountElement = document.getElementById("online-count");
const chatStatusElement = document.getElementById("chat-status");

// ==============================
// STATE
// ==============================

let identityReady = false;
let matched = false;
let searching = false;
let myUsername = "You";
let strangerUsername = "Stranger";
let lastMessageTime = 0;

// ==============================
// UI HELPERS
// ==============================

function showSystemMessage(text) {
    const message = document.createElement("div");
    message.className = "system-message";
    message.textContent = text;

    messagesElement.appendChild(message);
    messagesElement.scrollTop = messagesElement.scrollHeight;
}

function addMessage(text, mine, username) {
    const message = document.createElement("div");
    message.className = mine ? "message mine" : "message";

    const usernameElement = document.createElement("div");
    usernameElement.className = "message-username";
    usernameElement.textContent = username;

    const textElement = document.createElement("div");
    textElement.className = "message-text";
    textElement.textContent = text;

    const timeElement = document.createElement("div");
    timeElement.className = "message-time";
    timeElement.textContent = new Date().toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
    });

    message.append(usernameElement, textElement, timeElement);
    messagesElement.appendChild(message);
    messagesElement.scrollTop = messagesElement.scrollHeight;
}

function clearChat() {
    messagesElement.replaceChildren();
}

function setMatched(value) {
    matched = value;

    messageInput.disabled = !value;
    sendButton.disabled = !value;
    nextButton.disabled = !value;
    endButton.disabled = !value;
    blockButton.disabled = !value;
    reportButton.disabled = !value;

    findButton.disabled = value || searching || !identityReady;

    if (value) {
        chatStatusElement.textContent =
            `Chatting with ${strangerUsername}`;

        messageInput.placeholder = "Type your message...";
        messageInput.focus();
    } else {
        chatStatusElement.textContent =
            searching ? "Finding someone..." : "Ready when you are";

        messageInput.placeholder =
            "Find a stranger to start chatting...";
    }
}

function findStranger() {
    if (!identityReady || matched || searching) {
        return;
    }

    searching = true;
    setMatched(false);

    findButton.disabled = true;
    findButton.textContent = "Searching...";

    clearChat();
    showSystemMessage("🔍 Looking for someone to chat with...");

    socket.emit("find-stranger");
}

function resetFindButton() {
    findButton.innerHTML = "<span>✦</span> Find Stranger";
    findButton.disabled = !identityReady || matched || searching;
}

// ==============================
// CONNECTION AND IDENTITY
// ==============================

socket.on("connect", function () {
    identityReady = false;
    findButton.disabled = true;

    chatStatusElement.textContent = "Connecting...";

    socket.emit("register-user", {
        userId: anonymousId
    });
});

socket.on("your-identity", function (data) {
    if (!data || typeof data.username !== "string") {
        return;
    }

    myUsername = data.username;
    identityReady = true;

    identityElement.replaceChildren();

    const label = document.createElement("span");
    label.className = "identity-icon";
    label.textContent = "✦";

    const name = document.createElement("strong");
    name.textContent = myUsername;

    identityElement.append(
        label,
        document.createTextNode(" Your anonymous identity: "),
        name
    );

    resetFindButton();
    chatStatusElement.textContent = "Ready when you are";
});

// ==============================
// LIVE ONLINE COUNTER
// ==============================

socket.on("online-count", function (count) {
    if (
        typeof count !== "number" ||
        !Number.isFinite(count)
    ) {
        return;
    }

    onlineCountElement.textContent =
        Math.max(0, Math.floor(count)).toLocaleString();
});

// ==============================
// FIND AND MATCH
// ==============================

findButton.addEventListener("click", findStranger);

socket.on("waiting", function () {
    searching = true;
    setMatched(false);
    resetFindButton();

    chatStatusElement.textContent = "Waiting for a stranger...";
});

socket.on("matched", function (data) {
    searching = false;

    strangerUsername =
        data && typeof data.username === "string"
            ? data.username
            : "Stranger";

    clearChat();
    setMatched(true);
    resetFindButton();

    showSystemMessage(
        `🎉 You are now chatting with ${strangerUsername}. Say hello!`
    );
});

// ==============================
// SEND MESSAGES
// ==============================

messageForm.addEventListener("submit", function (event) {
    event.preventDefault();

    if (!matched) {
        return;
    }

    const message = messageInput.value.trim();

    if (!message) {
        return;
    }

    if (message.length > 1000) {
        showSystemMessage("Messages can contain up to 1000 characters.");
        return;
    }

    const now = Date.now();

    if (now - lastMessageTime < 500) {
        showSystemMessage("Please slow down before sending another message.");
        return;
    }

    lastMessageTime = now;

    addMessage(message, true, myUsername);
    socket.emit("send-message", message);

    messageInput.value = "";
    messageInput.focus();
});

socket.on("receive-message", function (data) {
    if (typeof data === "string") {
        addMessage(data, false, strangerUsername);
        return;
    }

    if (!data || typeof data !== "object") {
        return;
    }

    if (typeof data.text !== "string") {
        return;
    }

    addMessage(
        data.text,
        false,
        typeof data.username === "string"
            ? data.username
            : strangerUsername
    );
});

// ==============================
// NEXT STRANGER
// ==============================

nextButton.addEventListener("click", function () {
    if (!matched) {
        return;
    }

    matched = false;
    searching = true;

    setMatched(false);
    resetFindButton();

    clearChat();
    showSystemMessage("Finding your next stranger...");

    socket.emit("next-stranger");
});

// ==============================
// END CHAT
// ==============================

endButton.addEventListener("click", function () {
    if (!matched) {
        return;
    }

    socket.emit("end-chat");

    matched = false;
    searching = false;

    setMatched(false);
    resetFindButton();

    clearChat();
    showSystemMessage("You ended the conversation.");
});

// ==============================
// PARTNER DISCONNECTS OR ENDS CHAT
// ==============================

socket.on("chat-ended", function () {
    const wasMatched = matched;

    matched = false;
    searching = false;

    setMatched(false);
    resetFindButton();

    if (wasMatched) {
        showSystemMessage(
            "The stranger left the chat. You can find someone new."
        );
    }
});

// ==============================
// BLOCK USER
// ==============================

blockButton.addEventListener("click", function () {
    if (!matched) {
        return;
    }

    const confirmed = window.confirm(
        `Block ${strangerUsername}? You will not be matched with this identity again while the server retains the block.`
    );

    if (confirmed) {
        socket.emit("block-user");
    }
});

socket.on("user-blocked", function () {
    matched = false;
    searching = false;

    setMatched(false);
    resetFindButton();

    clearChat();
    showSystemMessage("🚫 User blocked. You can find another stranger.");
});

// ==============================
// REPORT USER
// ==============================

reportButton.addEventListener("click", function () {
    if (!matched) {
        return;
    }

    const reason = window.prompt(
        `Why are you reporting ${strangerUsername}?`
    );

    if (reason === null) {
        return;
    }

    socket.emit("report-user", reason.trim());
});

socket.on("report-submitted", function () {
    matched = false;
    searching = false;

    setMatched(false);
    resetFindButton();

    clearChat();
    showSystemMessage(
        "⚠️ Report received by the server. The conversation has ended."
    );
});

// ==============================
// SERVER MESSAGES
// ==============================

socket.on("system-message", function (message) {
    if (typeof message === "string") {
        showSystemMessage(message);
    }
});

// ==============================
// DISCONNECT AND ERRORS
// ==============================

socket.on("disconnect", function () {
    identityReady = false;
    matched = false;
    searching = false;

    setMatched(false);
    resetFindButton();

    chatStatusElement.textContent = "Disconnected";
    showSystemMessage("Connection lost. Reconnecting...");
});

socket.on("connect_error", function () {
    chatStatusElement.textContent = "Connection problem";
});

// ==============================
// INITIAL BUTTON STATE
// ==============================

setMatched(false);
resetFindButton();