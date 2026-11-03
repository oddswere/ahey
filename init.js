// Import required modules
const socketIO = require("socket.io"); // For real-time WebSocket communication
const express = require("express"); // Web framework for Node.js
const path = require("path"); // Utility for handling file and directory paths
const http = require("http"); // Node.js HTTP server
const app = express(); // Create an Express application

// Import configuration and signalling server logic
const config = require("./server/config");
const signallingServer = require("./server/signalling-server");
const routes = require("./server/routes");

// Get PORT from env variable else assign 3000 for development
const PORT = config.PORT || 824;
const server = http.createServer(app); // Create HTTP server with Express app

// Set EJS as the view engine for rendering templates
app.set("view engine", "ejs");

const turn = require("./server/turn");
app.get("/ice-config.js", (req, res) => {
 res.type("application/javascript").set("Cache-Control", "no-store");
 res.send('window.ICE_SERVERS = ' + JSON.stringify(turn.getIceServers()) + ';');
});

// Serve static files from Vue, assets, and www directories
app.use(express.json());
app.use(express.static(path.join(__dirname, "node_modules/vue/dist/")));
app.use(express.static(path.join(__dirname, "public/icons")));
app.use(express.static(path.join(__dirname, "public"), { maxAge: 0 })); // No cache for www

// Initialize Socket.IO and attach signalling server logic
const io = socketIO(server, {
	cors: {
		origin: config.CORS_ORIGIN,
		methods: ["GET", "POST"],
		credentials: true,
	},
});
io.sockets.on("connection", signallingServer);

app.use("/", routes);

// Start the server and log status
server.listen(PORT, config.HOST, () => {
	console.log("naberesh server started");
	console.log({ port: PORT, node_version: process.versions.node });
	if (process.argv.includes("--create-test-room")) {
		const { createConference } = require("./server/services/conferences");
		const { id } = createConference({ telegramUserId: "local-test" });
		const host = !config.HOST || ["127.0.0.1", "0.0.0.0", "::"].includes(config.HOST)
			? "localhost"
			: config.HOST;
		const urlHost = host.includes(":") ? `[${host}]` : host;
		console.log(`\nJoin test room: http://${urlHost}:${server.address().port}/${id}\n`);
	}
});
