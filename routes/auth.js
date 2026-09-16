const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");

// Public routes
router.post("/signupTruNorth", authController.signup);
router.post("/loginTruNorth", authController.login);
router.post("/forgot-passwordTruNorth", authController.forgotPassword);
router.post("/reset-passwordTruNorth", authController.resetPassword);

// Admin workspace selection (requires a valid login token in header)
router.post("/select-workspace", authController.selectWorkspace);

module.exports = router;

