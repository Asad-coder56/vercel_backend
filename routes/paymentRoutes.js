const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/paymentController');

// POST /api/payment/create-session
router.post('/create-session', paymentController.createSession);

// GET /api/payment/test-checkout
router.get('/test-checkout', paymentController.testCheckout);

// Purely for UI Redirects - No DB logic!
router.get('/return/success', paymentController.handleSuccessRedirect);
router.get('/return/cancel', paymentController.handleCancelRedirect);

// The REAL Source of Truth - Secure Server-to-Server
router.post('/webhook', paymentController.handleAuthorizeNetWebhook);

module.exports = router;
