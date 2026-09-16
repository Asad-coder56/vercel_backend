/**
 * Worker Emailer (Disabled)
 *
 * This file previously contained Bull queue processors for email sending.
 * Now all emails are sent directly without Redis queuing.
 *
 * If you need to re-enable Redis-based queuing in the future:
 * 1. Set up Redis/Upstash and add REDIS_URL to .env
 * 2. Restore the Bull queue code in emailService.js
 * 3. Restore the queue processors here
 *
 * Benefits of direct sending (current mode):
 * - No Redis dependency
 * - Simpler deployment
 * - Works for MVP / small-medium scale
 *
 * When to consider Redis queuing:
 * - Sending to 100+ customers regularly
 * - Need guaranteed delivery with retries
 * - Want to avoid request timeouts on bulk sends
 */

console.log("📧 Email service running in direct mode (no Redis queue)");

module.exports = {};
