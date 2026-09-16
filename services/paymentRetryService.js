/**
 * Payment Retry Service (No Redis version)
 *
 * For MVP, we rely on Authorize.net's built-in retry mechanism for ARB subscriptions.
 * Authorize.net will automatically retry failed payments and send webhooks for each attempt.
 *
 * This service now just logs retry information for monitoring purposes.
 * The actual retry logic is handled by Authorize.net.
 */

const models = require("../models");
const authorizeNet = require("./authorizeNetService");
require("dotenv").config();

const MAX_ATTEMPTS = 4;

/**
 * Handle retry check for a failed subscription payment
 * Called by the webhook server via /api/internal/webhook-retry
 *
 * For MVP: Just logs the failure and checks if we need to cancel the subscription
 */
const handleRetryCheck = async ({ subscriptionId, installmentId, attemptCount }) => {
    console.log(`📋 Payment retry check: subscription=${subscriptionId}, attempt=${attemptCount}/${MAX_ATTEMPTS}`);

    try {
        // Find all failed installments for this subscription
        const failedInstallments = await models.Installment.findAll({
            where: {
                authorizeSubscriptionId: subscriptionId,
                status: "failed",
            },
        });

        if (failedInstallments.length === 0) {
            console.log(`✅ No failed installments for subscription ${subscriptionId} — payment may have succeeded`);
            return { success: true, message: "No failed installments found" };
        }

        // Check if we've exceeded max attempts
        const maxAttempt = Math.max(...failedInstallments.map((i) => i.attemptCount));

        if (maxAttempt >= MAX_ATTEMPTS) {
            console.log(`⚠️ Subscription ${subscriptionId} exceeded ${MAX_ATTEMPTS} attempts — cancelling`);

            try {
                // Cancel the ARB subscription at Authorize.Net
                await authorizeNet.cancelARBSubscription(subscriptionId);
                console.log(`✅ ARB subscription ${subscriptionId} cancelled`);
            } catch (err) {
                console.error(`❌ Failed to cancel ARB subscription ${subscriptionId}:`, err.message);
            }

            // Suspend all remaining pending/failed installments
            await models.Installment.update(
                { status: "suspended" },
                {
                    where: {
                        authorizeSubscriptionId: subscriptionId,
                        status: { [models.sequelize.Op.in]: ["pending", "failed"] },
                    },
                }
            );

            console.log(`✅ Remaining installments for subscription ${subscriptionId} suspended`);
            return { success: true, message: "Subscription cancelled and installments suspended" };
        }

        // If not at max yet, Authorize.Net will retry the charge automatically
        console.log(`⏳ Subscription ${subscriptionId} at attempt ${maxAttempt}/${MAX_ATTEMPTS} — Authorize.Net will retry`);
        return { success: true, message: `Waiting for Authorize.Net retry (attempt ${maxAttempt}/${MAX_ATTEMPTS})` };

    } catch (err) {
        console.error(`❌ Payment retry check error:`, err.message);
        return { success: false, message: err.message };
    }
};

module.exports = {
    handleRetryCheck,
    MAX_ATTEMPTS,
};
