const express = require("express");
const router = express.Router();
const internalController = require("../controllers/internalController");

// HMAC-secured (no JWT) — called by webhook server
router.post("/webhook-retry", internalController.webhookRetry);
router.post("/notify-payment-failed", internalController.notifyPaymentFailed);
router.post("/sendgrid-webhook", internalController.sendGridWebhook);
// router.post("/brevo-webhook", internalController.sendGridWebhook);

module.exports = router;
