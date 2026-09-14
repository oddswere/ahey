const { isValidChannelName } = require("./utils");
const botAuth = require("./middleware/botAuth");
const { createConference, getConferenceById } = require("./services/conferences");

const router = require("express").Router();

const STATIC_VIEWS = {
	privacy: "Политика конфиденциальности",
	terms: "Условия использования",
};

// Route: Home page
router.get("/", (req, res) =>
	res.render("index", {
		page: "index",
		title: "Корпоративный веб сервис для видеозвонков. Без регистрации, без скачивания.",
	})
);

// API: Create conference (bot only)
router.post("/api/createConference", botAuth, (req, res) => {
	try {
		const telegramUserId = req.body?.telegramUserId;
		const metadata = req.body?.metadata;
		const { id } = createConference({ telegramUserId, metadata });
		const origin = `${req.protocol}://${req.get("host")}`;
		return res.status(201).json({ id, url: `${origin}/${id}` });
	} catch (e) {
		return res.status(400).json({ error: e.message || "bad_request" });
	}
});

// MIddleware: Static views (terms, privacy, etc.)
router.use("/:view", (req, res, next) => {
	const view = req.params.view;
	if (STATIC_VIEWS[view]) {
		return res.render(view, { page: view, title: STATIC_VIEWS[view] });
	}
	next();
});

// Route: Room page (dynamic)
router.get("/:channel", (req, res) => {
	const channel = req.params.channel;
	if (!isValidChannelName(channel)) {
		return res
			.status(400)
			.render("invalid", { page: "invalid-channel", title: "Неверное название канала", reason: "invalid_name" });
	}

	// Check that conference exists in DB
	const conf = getConferenceById(channel);
	if (!conf) {
		return res
			.status(404)
			.render("invalid", { page: "invalid-channel", title: "Конференция не найдена", reason: "not_found" });
	}

	res.render("channel", { page: "channel", title: "Видеовстреча" });
});

// Route: Catch-all for 404 errors
router.use(["/*", "/404"], (req, res) => res.status(404).render("404", { page: "404", title: "Страница не найдена" }));

module.exports = router;
