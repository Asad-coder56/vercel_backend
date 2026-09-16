const express = require('express');
const router = express.Router();
const clientRouter = require('./client');
const authRouter = require('./auth');
const adminRouter = require('./admin');
const internalRouter = require('./internal');
const paymentRouter = require('./paymentRoutes');
const { authenticate } = require("../middleware/authMiddleware");

router.use("/admin", authenticate, adminRouter);
router.use("/auth", authRouter);
router.use('/client', authenticate, clientRouter);
router.use('/internal', internalRouter); 
router.use('/payment', paymentRouter);

module.exports = router;
