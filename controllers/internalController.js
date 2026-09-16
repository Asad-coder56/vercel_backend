const crypto = require("crypto");

const {
    handleRetryCheck,
    MAX_ATTEMPTS,
} = require("../services/paymentRetryService");

const {
    sendPaymentFailedEmail,
} = require("../services/emailService");

const { Op } = require("sequelize");
const {
    User,
    Customer,
    SystemEmail,
    Campaign,
} = require("../models");

require("dotenv").config();


// ============================================================
// SENDGRID WEBHOOK DUPLICATE PROTECTION
// ============================================================

// Stores processed SendGrid webhook events in memory.
// This prevents the same webhook from being processed twice
// while the server is running.
const processedWebhookEvents = new Set();


// ============================================================
// HMAC VERIFICATION
// ============================================================

const verifyHmac = (req) => {
    try {
        const signature = req.headers["x-webhook-signature"];

        if (!signature) {
            return false;
        }

        const secret = process.env.WEBHOOK_HMAC_SECRET;

        if (!secret) {
            console.error(
                "❌ WEBHOOK_HMAC_SECRET is missing from environment variables"
            );

            return false;
        }

        const hmac = crypto
            .createHmac("sha256", secret)
            .update(JSON.stringify(req.body))
            .digest("hex");

        const signatureBuffer = Buffer.from(signature);
        const hmacBuffer = Buffer.from(hmac);

        // timingSafeEqual throws an error if buffer lengths differ
        if (signatureBuffer.length !== hmacBuffer.length) {
            return false;
        }

        return crypto.timingSafeEqual(
            signatureBuffer,
            hmacBuffer
        );

        } catch (error) {
            console.error("❌ HMAC verification error:", error);

            return false;
        }
    };

    // Helper: update campaign status to Delivered when all recipient SystemEmail rows are delivered
    async function updateCampaignStatusIfComplete(campaignId) {
        try {
            if (!campaignId) return;
            const campaign = await Campaign.findByPk(campaignId);
            if (!campaign) return;

            const totalRecipients = Number(campaign.recipientsCount) || 0;
            if (totalRecipients === 0) return;

            const deliveredCount = await SystemEmail.count({
                where: {
                    campaignId: campaign.id,
                    status: { [Op.in]: ['delivered', 'sent'] }
                }
            });
            const openedCount = await SystemEmail.count({
                where: {
                    campaignId: campaign.id,
                    opens: { [Op.gt]: 0 }
                }
            });
            const failedCount = await SystemEmail.count({
                where: {
                    campaignId: campaign.id,
                    status: 'failed'
                }
            });

            let nextStatus = campaign.status;
            if (openedCount >= totalRecipients && totalRecipients > 0) {
                nextStatus = 'Open';
            } else if (deliveredCount >= totalRecipients && totalRecipients > 0) {
                nextStatus = 'Delivered';
            } else if (failedCount === totalRecipients && totalRecipients > 0) {
                nextStatus = 'Failed';
            }

            if (nextStatus && nextStatus !== campaign.status) {
                await campaign.update({ status: nextStatus });
                console.log(`✅ Campaign ${campaign.id} status set to ${nextStatus} (${openedCount}/${totalRecipients} opened, ${deliveredCount}/${totalRecipients} delivered, ${failedCount}/${totalRecipients} failed)`);
            }
        } catch (err) {
            console.error('updateCampaignStatusIfComplete error:', err);
        }
    }

    // ============================================================
// WEBHOOK RETRY
// ============================================================

const webhookRetry = async (req, res) => {
    try {

        // Verify HMAC signature
        if (!verifyHmac(req)) {
            return res.status(401).json({
                success: false,
                message: "Invalid signature",
            });
        }


        const {
            subscriptionId,
            installmentId,
            attemptCount,
        } = req.body;


        if (!subscriptionId) {
            return res.status(400).json({
                success: false,
                message: "subscriptionId is required",
            });
        }


        const result = await handleRetryCheck({
            subscriptionId,
            installmentId,
            attemptCount: attemptCount || 0,
        });


        return res.status(200).json({
            success: result.success,
            message: result.message,
        });


    } catch (err) {

        console.error(
            "❌ Webhook retry error:",
            err
        );


        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// ============================================================
// PAYMENT FAILED EMAIL
// ============================================================

const notifyPaymentFailed = async (req, res) => {
    try {

        // Verify HMAC signature
        if (!verifyHmac(req)) {
            return res.status(401).json({
                success: false,
                message: "Invalid signature",
            });
        }


        const {
            userId,
            installmentId,
            debtId,
            attemptCount,
            amount,
            installmentNo,
        } = req.body;


        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "userId is required",
            });
        }


        // Get user and customer information
        const user = await User.findByPk(
            userId,
            {
                include: [
                    {
                        model: Customer,
                    },
                ],
            }
        );


        if (!user) {
            return res.status(404).json({
                success: false,
                message: "User not found",
            });
        }


        const customerName = user.Customer
            ? `${user.Customer.FirstName || ""} ${user.Customer.LastName || ""}`.trim()
            : null;


        // Send payment failed email
        await sendPaymentFailedEmail({

            email: user.email,

            name:
                customerName ||
                "Valued Customer",

            amount:
                amount ||
                0,

            installmentNo:
                installmentNo ||
                "N/A",

            attemptCount:
                attemptCount ||
                1,

            maxAttempts:
                MAX_ATTEMPTS,
        });


        console.log(
            `✅ Payment failed email sent to ${user.email} ` +
            `for installment ${installmentId}`
        );


        return res.status(200).json({

            success: true,

            message:
                "Payment failed notification sent",
        });


    } catch (err) {

        console.error(
            "❌ Notify payment failed error:",
            err
        );


        return res.status(500).json({

            success: false,

            message:
                `Server error: ${err.message}`,
        });
    }
};

// ============================================================
// SENDGRID WEBHOOK
// ============================================================

const normalizeSendGridMessageId = (value) => {
    if (!value) return "";

    const normalized = String(value).trim().replace(/^<|>$/g, "");
    return normalized.split(".")[0] || normalized;
};

const getSendGridEventKey = (payload) => {
    const messageId = normalizeSendGridMessageId(
        payload?.["sg_message_id"] ||
        payload?.sg_message_id ||
        payload?.id ||
        payload?.messageId ||
        payload?.message_id ||
        payload?.["message-id"]
    );
    const email = payload?.email ? String(payload.email).toLowerCase().trim() : "";
    const eventType = payload?.event ? String(payload.event).toLowerCase() : "unknown";

    return `${messageId || email || "no-id"}_${eventType}`;
};

const sendGridWebhook = async (req, res) => {

    try {

        const payload = req.body;
        const events = Array.isArray(payload) ? payload : [payload];
        const results = [];

        if (!events.length) {
            return res.status(400).json({
                success: false,
                message: "No SendGrid event payload provided",
            });
        }

        if (!global.processedSendGridEvents) {
            global.processedSendGridEvents = new Set();
        }

        for (const item of events) {
            const eventType = item?.event ? String(item.event).toLowerCase() : "";
            const rawMessageId = item?.["sg_message_id"] || item?.sg_message_id || item?.id || item?.messageId || item?.message_id || item?.["message-id"] || "";
            const messageId = normalizeSendGridMessageId(rawMessageId);
            const email = item?.email ? String(item.email).toLowerCase().trim() : null;

            if (!eventType) {
                results.push({
                    success: false,
                    event: null,
                    message: "eventType is required",
                });
                continue;
            }

            const eventKey = getSendGridEventKey(item);
            if (global.processedSendGridEvents.has(eventKey)) {
                results.push({
                    success: true,
                    event: eventType,
                    message: "Duplicate event ignored",
                });
                continue;
            }

            global.processedSendGridEvents.add(eventKey);

            let systemEmail = null;
            const possibleMessageIds = [messageId].filter(Boolean);
            if (messageId && messageId.includes(".")) {
                possibleMessageIds.push(messageId.split(".")[0]);
            }

            for (const candidateId of possibleMessageIds) {
                systemEmail = await SystemEmail.findOne({
                    where: { messageId: candidateId },
                });
                if (systemEmail) break;
            }

            if (!systemEmail && email) {
                systemEmail = await SystemEmail.findOne({
                    where: {
                        receiverEmail: email,
                        status: { [Op.in]: ["sent", "delivered", "failed", "unsubscribed"] },
                    },
                    order: [["sentAt", "DESC"]],
                });
            }

            if (!systemEmail) {
                results.push({
                    success: true,
                    event: eventType,
                    message: "SystemEmail record not found",
                });
                continue;
            }

            if (eventType === "delivered") {
                await systemEmail.update({
                    status: "delivered",
                    sentAt: systemEmail.sentAt || new Date(),
                });

                if (systemEmail.campaignId) {
                    await updateCampaignStatusIfComplete(systemEmail.campaignId);
                }
            }

            else if (eventType === "open" || eventType === "opened" || eventType === "unique_open") {
                if (systemEmail.status !== "delivered") {
                    await systemEmail.update({
                        status: "delivered",
                        sentAt: systemEmail.sentAt || new Date(),
                    });
                }

                await systemEmail.increment("opens", { by: 1 });
                await systemEmail.reload();

                if (systemEmail.campaignId) {
                    const campaign = await Campaign.findByPk(systemEmail.campaignId);

                    if (campaign) {
                        await campaign.increment("opens", { by: 1 });
                        await campaign.reload();

                        const recipients = Number(campaign.recipientsCount) || 0;
                        const openedRecipients = recipients > 0
                            ? await SystemEmail.count({ where: { campaignId: campaign.id, opens: { [Op.gt]: 0 } } })
                            : 0;
                        const safeOpenRate = recipients > 0
                            ? Math.min(100, Math.round((openedRecipients / recipients) * 100))
                            : 0;

                        await campaign.update({ openRate: `${safeOpenRate}%` });
                    }

                    await updateCampaignStatusIfComplete(systemEmail.campaignId);
                }
            }

            else if (eventType === "click" || eventType === "clicked") {
                if (systemEmail.status !== "delivered") {
                    await systemEmail.update({
                        status: "delivered",
                        sentAt: systemEmail.sentAt || new Date(),
                    });
                }

                await systemEmail.increment("clicks", { by: 1 });

                if (systemEmail.campaignId) {
                    await Campaign.increment("clicks", {
                        by: 1,
                        where: { id: systemEmail.campaignId },
                    });

                    await updateCampaignStatusIfComplete(systemEmail.campaignId);
                }
            }

            else if (["bounce", "dropped", "blocked", "spamreport", "deferred"].includes(eventType)) {
                await systemEmail.update({ status: "failed" });
                console.log(`❌ Email marked failed: ${eventType}`);
            }

            else if (["unsubscribe", "group_unsubscribe", "group_resubscribe"].includes(eventType)) {
                await systemEmail.update({ status: "unsubscribed" });
                console.log(`⚠️ Email marked unsubscribed: ${systemEmail.id}`);
            }

            else {
                console.log(`ℹ️ Event received but no action required: ${eventType}`);
            }

            console.log("🔔 ===== WEBHOOK PROCESSING COMPLETE =====");
            results.push({
                success: true,
                event: eventType,
                message: `SendGrid event ${eventType} processed`,
            });
        }

        return res.status(200).json({
            success: true,
            results,
        });

    } catch (err) {
        console.error("❌ SendGrid webhook error:", err);
        console.error("📚 Stack:", err.stack);

        return res.status(500).json({
            success: false,
            message: `Server error: ${err.message}`,
        });
    }
};

// ============================================================
// EXPORT CONTROLLERS
// ============================================================

module.exports = {

    webhookRetry,

    notifyPaymentFailed,

    sendGridWebhook,

};