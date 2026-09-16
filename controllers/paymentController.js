const authorizeNetService = require('../services/authorizeNetService');
const models = require('../models');
const axios = require('axios');
const crypto = require('crypto');
/**
 * Create an Authorize.net Accept Hosted payment session
 * POST /api/payment/create-session
 */
const createSession = async (req, res) => {
    try {
        const { amount, invoiceNumber, customerEmail } = req.body;

        // Validation
        if (!amount || !invoiceNumber) {
            return res.status(400).json({
                success: false,
                message: 'Amount and invoiceNumber are required fields.'
            });
        }

        // Find if a pending payment history already exists for this invoice
        let ph = await models.PaymentHistory.findOne({ where: { invoiceNumber } });

        // If not, create a pending record so the webhook can find it!
        if (!ph && invoiceNumber.startsWith('INST-')) {
            const parts = invoiceNumber.split('-');
            if (parts.length >= 3) {
                const debtId = parts[1];
                const installmentNo = parts[2];
                const inst = await models.Installment.findOne({ where: { debtId, installmentNo } });

                if (inst) {
                    await models.PaymentHistory.create({
                        debtId: inst.debtId,
                        amount: amount,
                        installmentId: inst.id,
                        userId: inst.userId || req.user?.userId || null,
                        paymentType: "installment",
                        status: "pending",
                        invoiceNumber: invoiceNumber,
                        gateway: "authorize_net"
                    });
                }
            }
        }

        // Generate hosted payment page token & URL
        const sessionResult = await authorizeNetService.getHostedPaymentPage(
            amount,
            invoiceNumber,
            customerEmail
        );

        // Include a local test URL that auto-posts the token
        const port = process.env.PORT || 5000;
        const host = req.get('host') || `localhost:${port}`;
        sessionResult.testUrl = `${req.protocol}://${host}/api/payment/test-checkout?token=${encodeURIComponent(sessionResult.token)}`;

        // Return token, raw paymentUrl, and testUrl
        return res.status(200).json(sessionResult);

    } catch (error) {
        console.error('Error creating payment session:', error.message);
        return res.status(500).json({
            success: false,
            message: 'Failed to create payment session.',
            error: error.message
        });
    }
};

const testCheckout = (req, res) => {
    const { token } = req.query;

    if (!token) {
        return res.status(400).send('Missing token parameter');
    }

    const isSandbox = process.env.AUTHORIZE_ENVIRONMENT === 'sandbox';
    const actionUrl = isSandbox
        ? 'https://test.authorize.net/payment/payment'
        : 'https://accept.authorize.net/payment/payment';

    const html = `
        <!DOCTYPE html>
        <html>
        <head>
            <title>Redirecting to Authorize.net...</title>
        </head>
        <body onload="document.getElementById('authNetForm').submit();">
            <h3>Redirecting to Authorize.net...</h3>
            <form id="authNetForm" method="post" action="${actionUrl}">
                <input type="hidden" name="token" value="${token}" />
                <button type="submit">Click here if you are not redirected automatically</button>
            </form>
        </body>
        </html>
    `;

    res.send(html);
};


// const handleReturn = async (req, res) => {
//     try {
//         // Authorize.net POSTs some variables back
//         // x_response_code: "1" = Approved, "2" = Declined, "3" = Error
//         const responseCode = req.body.x_response_code;
//         const transId = req.body.x_trans_id;
//         const invoiceNum = req.body.x_invoice_num;

//         // Forward the payload to the external webhook as requested
//         const webhookUrl = process.env.AUTHORIZE_WEBHOOK_URL;
//         if (webhookUrl) {
//             try {
//                 // Construct the exact JSON payload expected by the Replit webhook
//                 const webhookPayload = {
//                     notificationId: "test-" + Date.now(),
//                     eventType: "net.authorize.payment.authcapture.created",
//                     eventDate: new Date().toISOString(),
//                     webhookId: "test-webhook",
//                     payload: {
//                         id: transId || "123456789",
//                         authAmount: req.body.x_amount || "0.00",
//                         invoiceNumber: invoiceNum,
//                         subscription: null
//                     }
//                 };

//                 // Sign the payload so the webhook doesn't throw a 401 Invalid Signature error
//                 const rawBody = JSON.stringify(webhookPayload);
//                 let signatureHeader = "";
//                 if (process.env.AUTHORIZE_SIGNATURE_KEY) {
//                     const computed = crypto
//                         .createHmac("sha512", process.env.AUTHORIZE_SIGNATURE_KEY)
//                         .update(rawBody)
//                         .digest("hex")
//                         .toUpperCase();
//                     signatureHeader = `sha512=${computed}`;
//                 }

//                 await axios.post(webhookUrl, rawBody, {
//                     headers: { 
//                         'Content-Type': 'application/json',
//                         'x-anet-signature': signatureHeader
//                     }
//                 });
//                 console.log("Successfully forwarded Authorize.net data to webhook:", webhookUrl);
//             } catch (webhookErr) {
//                 console.error("Failed to call external webhook:", webhookErr.message);
//             }
//         }


//         const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173/';
//         const base = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;

//         // Redirect back to React frontend to show the green toast!
//         if (responseCode === "1") {
//             res.redirect(302, `${base}/client/dashboard?payment=success`);
//         } else {
//             res.redirect(302, `${base}/client/dashboard?payment=failed`);
//         }
//     } catch (err) {
//         console.error('Error in handleReturn:', err);
//         const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173/';
//         const base = frontendUrl.endsWith('/') ? frontendUrl.slice(0, -1) : frontendUrl;
//         res.redirect(302, `${base}/client/dashboard?payment=error`);
//     }
// };

const handleSuccessRedirect = (req, res) => {
    console.log("🔥 RETURN HIT - SUCCESS UI REDIRECT");
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173/";
    const base = frontendUrl.endsWith("/") ? frontendUrl.slice(0, -1) : frontendUrl;
    return res.redirect(302, `${base}/client/dashboard?payment=success`);
};

const handleCancelRedirect = (req, res) => {
    console.log("🔥 RETURN HIT - CANCEL UI REDIRECT");
    const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173/";
    const base = frontendUrl.endsWith("/") ? frontendUrl.slice(0, -1) : frontendUrl;
    return res.redirect(302, `${base}/client/dashboard?payment=cancelled`);
};

/**
 * Handle Authorize.Net Webhooks (Secure Server-to-Server)
 * POST /api/payment/webhook
 */
const handleAuthorizeNetWebhook = async (req, res) => {
    console.log("\n🔥🔥🔥 LOCAL WEBHOOK FUNCTION HIT 🔥🔥🔥");
    console.log("🔐 SECURE WEBHOOK HIT!");
    console.log("📥 Payload:", JSON.stringify(req.body, null, 2));

    try {
        const webhookSecret = process.env.AUTHORIZE_SIGNATURE_KEY;
        const signature = req.headers['x-anet-signature'];

        // If you are setting this up natively in Authorize.net:
        // You would verify the signature here.
        // For now, we are just receiving the POST and acknowledging it.

        const eventType = req.body.eventType;
        const payload = req.body.payload;

        console.log("📩 EVENT RECEIVED:", eventType);
        console.log("📦 PAYLOAD:", payload);

        // Ensure this is a successful payment
        // if (eventType === 'net.authorize.payment.authcapture.created' && payload) {
        if (payload) {
            console.log("✅ Processing webhook event...");
            const transId = payload.id;
            const amount = payload.authAmount;
            const invoiceNum = payload.invoiceNumber; // Ensure you pass this in order options

            console.log("✅ Payment Captured. ID:", transId, "Amount:", amount, "Invoice:", invoiceNum);

            // Local Database Update First
            const ph = await models.PaymentHistory.findOne({
                where: { invoiceNumber: invoiceNum },
                include: [{ model: models.Debt }]
            });

            if (ph && ph.status !== 'completed') {
                ph.status = 'completed';
                ph.authorizeTransactionId = transId;
                await ph.save();

                // If this is an installment payment or full payment, deduct from Debt
                if (ph.Debt) {
                    const debt = ph.Debt;
                    const deductionAmount = parseFloat(ph.amount);
                    let newBalance = parseFloat(debt.currentBalance) - deductionAmount;
                    if (newBalance <= 0) {
                        newBalance = 0;
                        debt.status = "paid";
                    }
                    debt.currentBalance = parseFloat(newBalance.toFixed(2));
                    debt.PaidToDate = parseFloat((parseFloat(debt.PaidToDate || 0) + deductionAmount).toFixed(2));
                    await debt.save();
                }

                // If it's an installment, update the installment status
                if (ph.paymentType === 'installment' && ph.installmentId) {
                    const installment = await models.Installment.findByPk(ph.installmentId);
                    if (installment) {
                        installment.status = 'paid';
                        installment.paidAt = new Date();
                        await installment.save();
                    }
                } else if (ph.paymentType === 'full') {
                    // Update all pending/processing installments to cancelled since debt is fully paid
                    const { Op } = require('sequelize');
                    await models.Installment.update(
                        { status: 'cancelled' },
                        {
                            where: {
                                debtId: ph.debtId,
                                status: { [Op.in]: ['pending', 'processing'] }
                            }
                        }
                    );
                }
            }

            // Optional: You can forward it to your Replit webhook here if you still want to use it
            const externalWebhookUrl = process.env.AUTHORIZE_WEBHOOK_URL;
            if (externalWebhookUrl) {
                console.log("🚀 Forwarding payload to Replit Webhook:", externalWebhookUrl);
                const rawBody = JSON.stringify(req.body);

                // Add signature if needed by Replit
                let signatureHeader = "";
                if (webhookSecret) {
                    const computed = crypto
                        .createHmac("sha512", webhookSecret)
                        .update(rawBody)
                        .digest("hex")
                        .toUpperCase();
                    signatureHeader = `sha512=${computed}`;
                }

                await axios.post(externalWebhookUrl, rawBody, {
                    headers: {
                        "Content-Type": "application/json",
                        "x-anet-signature": signatureHeader
                    }
                });
                console.log("✅ Webhook successfully forwarded to Replit!");
            }
        }

        // Must return 200 OK to tell Authorize.net we received it successfully
        return res.status(200).send("OK");
    } catch (err) {
        console.error("💥 WEBHOOK ERROR:", err.message);
        // Still return 200 so Authorize.net doesn't endlessly retry if it's our internal error
        return res.status(200).send("OK");
    }
};

module.exports = {
    createSession,
    testCheckout,
    handleSuccessRedirect,
    handleCancelRedirect,
    handleAuthorizeNetWebhook
};