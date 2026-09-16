require("dotenv").config();
const sgMail = require("@sendgrid/mail");

/* ================= SENDER CONFIG ================= */
// SendGrid rejects any 'from' that is not a verified Sender Identity with a 403.
// This account authenticates the domain trunorthsystems.org and has no Single Sender
// Verified addresses, so the sender MUST be @trunorthsystems.org.
const AUTHENTICATED_DOMAIN = "trunorthsystems.org";
const DEFAULT_SENDER_EMAIL = `noreply@${AUTHENTICATED_DOMAIN}`;

const getSenderEmail = () => process.env.SENDGRID_FROM_EMAIL || DEFAULT_SENDER_EMAIL;
const getSenderName = () => process.env.SENDGRID_FROM_NAME || "TruNorth Debt Solutions";
// Use SendGrid only when a SendGrid API key is configured.
const useSendGrid = Boolean(process.env.SENDGRID_API_KEY);

const sgApiKey = process.env.SENDGRID_API_KEY;
if (useSendGrid) {
    sgMail.setApiKey(sgApiKey);

    const sender = getSenderEmail();
    if (!sender.toLowerCase().endsWith(`@${AUTHENTICATED_DOMAIN}`)) {
        console.warn(
            `⚠️ [SendGrid] Sender "${sender}" is not on the authenticated domain @${AUTHENTICATED_DOMAIN}. ` +
            `SendGrid will reject sends with 403 unless this address is Single Sender Verified.`
        );
    }
}

const sendSendGridEmail = async ({ from, to, subject, html }) => {
    const recipients = Array.isArray(to)
        ? to.map((recipient) => ({
            email: recipient.email || recipient,
            name: recipient.name || recipient.email || recipient,
        }))
        : [{ email: to }];

    const msg = {
        from: {
            email: from || getSenderEmail(),
            name: getSenderName(),
        },
        personalizations: [{
            to: recipients,
        }],
        subject,
        content: [
            {
                type: 'text/html',
                value: html || '',
            },
        ],
        // ✅ ENABLE CLICK TRACKING
        trackingSettings: {
            clickTracking: {
                enable: true,
                enableText: false, // Don't track plain text links
            },
        },
    };

    let response;
    try {
        [response] = await sgMail.send(msg);
    } catch (err) {
        const status = err.response?.statusCode;
        const errors = err.response?.body?.errors;
        if (errors) {
            console.error(`❌ [SendGrid] status=${status} from=${msg.from.email}`, JSON.stringify(errors));
            // Surface SendGrid's reason to callers instead of a generic "Forbidden".
            err.message = errors.map((e) => e.message).join('; ');
        }
        throw err;
    }

    const messageId = response?.headers?.['x-message-id'] || null;

    console.log(`✉️ [SendGrid] To=${recipients.map(r => r.email).join(',')} Subject="${subject}" MessageId=${messageId}`);

    return {
        messageId,
        rawMessageId: messageId,
        response,
    };
};

const transporter = {
    sendMail: async (mailOptions) => {
        if (!useSendGrid) {
            throw new Error('SendGrid is not configured. Set SENDGRID_API_KEY to use email sending.');
        }

        return sendSendGridEmail(mailOptions);
    },
};

/* ================= HELPER FUNCTIONS ================= */

// Small delay between emails to avoid rate limiting
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const decodeHtmlEntities = (value) => {
    if (value == null) {
        return "";
    }

    return String(value)
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");
};

const repairBrokenAnchors = (html) => {
    if (!html) return html;

    // Fix anchor tags that were escaped into paragraph blocks by the editor.
    // Example: <p><a href="..."></p><p>Click here</p><p></a></p>
    return html.replace(/<p>\s*<a([^>]*)>\s*<\/p>\s*<p>([\s\S]*?)<\/p>\s*<p>\s*<\/a>\s*<\/p>/gi, '<p><a$1>$2</a></p>');
};

const decodeAndRepairHtml = (value) => {
    const decoded = decodeHtmlEntities(value);
    return repairBrokenAnchors(decoded);
};

// Personalize email content with user data
const personalizeContent = (content, user) => {
    let result = content || "";

    // Shared values
    const currentDate = new Date().toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric",
    });
    const companyName = "TruNorth Debt Solutions";

    // Build canonical placeholder mapping
    const placeholderData = {
        companyname: companyName,
        company: companyName,
        yourname: "TruNorth Agent",
        yourrole: "Customer Support",
        supportemail: process.env.SUPPORT_EMAIL || "support@trunorth.com",
        currentdate: currentDate,
        today: currentDate,
        date: currentDate,
    };

    const normalizeKey = (key) => key.toString().trim().toLowerCase().replace(/[^a-z0-9]/g, "");

    // Add user-specific data aliases
    const addUserValue = (key, value) => {
        if (value === undefined || value === null) return;
        placeholderData[normalizeKey(key)] = String(value);
    };

    // Helper to dynamically extract all properties from an object into placeholderData
    const extractObjectProperties = (obj) => {
        if (!obj || typeof obj !== "object") return;
        const plain = obj.toJSON ? obj.toJSON() : obj;
        Object.entries(plain).forEach(([k, v]) => {
            if (v !== undefined && v !== null && typeof v !== "object" && typeof v !== "function") {
                addUserValue(k, v);
            }
        });
    };

    if (user.personalizedData) {
        extractObjectProperties(user.personalizedData);
    }
    if (user.csvData) {
        extractObjectProperties(user.csvData);
    }
    if (user.Customer) {
        extractObjectProperties(user.Customer);
        const fullName = `${user.Customer.FirstName || ""} ${user.Customer.LastName || ""}`.trim();
        addUserValue("name", fullName);
        addUserValue("clientname", fullName);
        addUserValue("firstname", user.Customer.FirstName);
        addUserValue("lastname", user.Customer.LastName);
        addUserValue("email", user.email || user.Customer.EmailAddress);
        addUserValue("phone", user.Customer.PrimaryPhone);
    }

    // Also extract top-level non-object fields from user
    extractObjectProperties(user);

    if (!placeholderData.name) {
        addUserValue("name", user.username || user.email);
    }

    // Replace all {{placeholders}} and [placeholders] in the content using normalized keys
    result = result.replace(/\{\{\s*([^}]+)\s*\}\}|\[\s*([^\]]+)\s*\]/gi, (match, rawKey1, rawKey2) => {
        const rawKey = rawKey1 || rawKey2 || "";
        const normalized = normalizeKey(rawKey);
        if (Object.prototype.hasOwnProperty.call(placeholderData, normalized)) {
            return placeholderData[normalized] !== undefined ? placeholderData[normalized] : "";
        }
        return match;
    });

    return result;
};

/* ================= EMAIL FUNCTIONS ================= */

// Send deal email (direct)
const sendDealEmail = async (data) => {
    console.log("📧 Sending deal email to:", data.email);
    return transporter.sendMail({
        to: data.email,
        subject: "Deal Negotiation",
        html: data.body,
    });
};

// Send OTP (direct)
const sendOTP = async (email, otp, userId) => {
    console.log("📧 Sending OTP to:", email);
    return transporter.sendMail({
        to: email,
        subject: "Password Reset OTP",
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2563eb;">Password Reset</h2>
                <p>Your OTP is:</p>
                <h1 style="font-size: 32px; letter-spacing: 5px; background: #f3f4f6; padding: 15px; text-align: center;">${otp}</h1>
                <p>Valid for 10 minutes.</p>
                <p>If you didn't request this, please ignore this email.</p>
            </div>
        `,
    });
};

// Send payment failed notification (direct)
const sendPaymentFailedEmail = async ({ email, name, amount, installmentNo, attemptCount, maxAttempts }) => {
    const attemptsRemaining = maxAttempts - attemptCount;
    console.log("📧 Sending payment failed email to:", email);

    return transporter.sendMail({
        to: email,
        subject: "Payment Failed - Action Required",
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #dc2626;">Payment Failed</h2>
                <p>Dear ${name || "Valued Customer"},</p>
                <p>We were unable to process your scheduled payment. Here are the details:</p>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Amount:</strong></td>
                        <td style="padding: 10px; border: 1px solid #e5e7eb;">$${parseFloat(amount).toFixed(2)}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Installment #:</strong></td>
                        <td style="padding: 10px; border: 1px solid #e5e7eb;">${installmentNo}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Attempts Remaining:</strong></td>
                        <td style="padding: 10px; border: 1px solid #e5e7eb;">${attemptsRemaining} of ${maxAttempts}</td>
                    </tr>
                </table>
                ${attemptsRemaining > 0
                ? `<p style="color: #d97706;"><strong>Important:</strong> We will automatically retry this payment. If the issue persists after ${attemptsRemaining} more attempt(s), your payment plan may be suspended.</p>`
                : `<p style="color: #dc2626;"><strong>Final Notice:</strong> This was the last retry attempt. Your payment plan will be suspended unless you take action immediately.</p>`
            }
                <p>Please ensure your payment method is up to date. You can update your payment information by logging into your account.</p>
                <p>If you have any questions, please contact our support team.</p>
                <br>
                <p>Best regards,<br>TruNorth Debt Solutions</p>
            </div>
        `,
    });
};

// Send login credentials (direct)
const sendLoginCredentialsEmail = async (data) => {
    const { to, password, firstName } = data;
    const loginUrl = process.env.FRONTEND_URL || "http://localhost:5173";

    console.log("📧 Sending login credentials to:", to);

    return transporter.sendMail({
        to: to,
        subject: "Your TruNorth Account Login Credentials",
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #2563eb;">Welcome to TruNorth Debt Solutions</h2>
                <p>Dear ${firstName || "Valued Customer"},</p>
                <p>Your account has been created. Here are your login credentials:</p>
                <table style="width: 100%; border-collapse: collapse; margin: 20px 0;">
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Email:</strong></td>
                        <td style="padding: 10px; border: 1px solid #e5e7eb;">${to}</td>
                    </tr>
                    <tr>
                        <td style="padding: 10px; border: 1px solid #e5e7eb; background: #f9fafb;"><strong>Password:</strong></td>
                        <td style="padding: 10px; border: 1px solid #e5e7eb;">${password}</td>
                    </tr>
                </table>
                <p>
                    <a href="${loginUrl}/auth/login"
                       style="display: inline-block; padding: 12px 24px; background-color: #2563eb; color: white; text-decoration: none; border-radius: 6px;">
                        Login to Your Account
                    </a>
                </p>
                <p style="color: #d97706; margin-top: 20px;">
                    <strong>Important:</strong> Please change your password after your first login for security purposes.
                </p>
                <br>
                <p>Best regards,<br>TruNorth Debt Solutions</p>
            </div>
        `,
    });
};

// Send bulk email with personalization (direct - sends one by one)
const sendBulkEmail = async (users, template) => {
    let usersArray, subject, body;

    if (users && template) {
        usersArray = Array.isArray(users) ? users : [users];
        subject = template.subject;
        body = template.body;
    } else if (users && users.template) {
        usersArray = Array.isArray(users.users) ? users.users : [users.users];
        subject = users.template.subject;
        body = users.template.body;
    } else {
        throw new Error("Invalid parameters for sendBulkEmail");
    }

    console.log(`📧 Sending bulk email to ${usersArray.length} users`);

    const results = { success: 0, failed: 0, errors: [] };

    for (const user of usersArray) {
        try {
            const personalizedSubject = personalizeContent(subject, user);
            const personalizedBody = personalizeContent(body, user);
            const decodedBody = decodeAndRepairHtml(personalizedBody);

            // Log anchors for debugging
            try {
                const anchorRegex = /<a [^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>(.*?)<\/a>/gi;
                const anchors = [];
                let m;
                while ((m = anchorRegex.exec(decodedBody)) !== null) anchors.push({ href: m[1], text: m[2] });
                if (anchors.length === 0) {
                    console.warn(`WARN [sendBulkEmail] No anchor tags with href found in decoded HTML for recipient ${user.email}`);
                } else {
                    console.log(`DEBUG [sendBulkEmail] Found anchors for ${user.email}:`, anchors);
                }
            } catch (anchorErr) {
                console.warn('WARN [sendBulkEmail] Failed to parse anchors:', anchorErr.message);
            }

            // Debug: log final HTML being sent to help diagnose escaped templates
            console.log(`DEBUG [sendBulkEmail] to=${user.email} subject=${personalizedSubject} htmlPreview=` +
                (decodedBody ? decodedBody.slice(0, 1000) : '<empty>'));

            const info = await transporter.sendMail({
                to: user.email,
                subject: personalizedSubject,
                html: decodedBody,
            });

            console.log(`✅ Email sent to: ${user.email}, MessageId: ${info?.messageId}`);
            results.success++;
            if (!results.sentEmails) results.sentEmails = [];
            // messageId is already cleaned by sendBrevoEmail
            results.sentEmails.push({ email: user.email, messageId: info?.messageId || null });

            // Small delay to avoid rate limiting
            await delay(200);
        } catch (err) {
            console.error(`❌ Failed to send to ${user.email}:`, err.message);
            results.failed++;
            results.errors.push({ email: user.email, error: err.message });
        }
    }

    console.log(`📧 Bulk email complete: ${results.success} sent, ${results.failed} failed`);
    return results;
};

// Send individual template email (direct)
const sendIndividualEmail = async ({ user, subject, body, templateId }) => {
    const personalizedSubject = personalizeContent(subject, user);
    const personalizedBody = personalizeContent(body, user);
    const decodedBody = decodeAndRepairHtml(personalizedBody);

    console.log("📧 Sending individual email to:", user.email);

    // Log anchors for debugging
    try {
        const anchorRegex = /<a [^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>(.*?)<\/a>/gi;
        const anchors = [];
        let m;
        while ((m = anchorRegex.exec(decodedBody)) !== null) anchors.push({ href: m[1], text: m[2] });
        if (anchors.length === 0) {
            console.warn(`WARN [sendIndividualEmail] No anchor tags with href found in decoded HTML for recipient ${user.email}`);
        } else {
            console.log(`DEBUG [sendIndividualEmail] Found anchors for ${user.email}:`, anchors);
        }
    } catch (anchorErr) {
        console.warn('WARN [sendIndividualEmail] Failed to parse anchors:', anchorErr.message);
    }

    // Debug: log final HTML for single sends
    console.log(`DEBUG [sendIndividualEmail] to=${user.email} subject=${personalizedSubject} htmlPreview=` +
        (decodedBody ? decodedBody.slice(0, 1000) : '<empty>'));

    return transporter.sendMail({
        to: user.email,
        subject: personalizedSubject,
        html: decodedBody,
    });
};

// Send bulk personalized emails (direct - sends one by one)
const sendBulkPersonalizedEmails = async (personalizedEmails, templateId) => {
    if (!personalizedEmails || !Array.isArray(personalizedEmails)) {
        throw new Error("personalizedEmails must be an array");
    }

    console.log(`📧 Sending ${personalizedEmails.length} personalized emails`);

    const results = { success: 0, failed: 0, errors: [] };

    for (const emailData of personalizedEmails) {
        try {
            const decodedBody = decodeAndRepairHtml(emailData.body);

            // Log anchors for debugging
            try {
                const anchorRegex = /<a [^>]*href=(?:"|')([^"']+)(?:"|')[^>]*>(.*?)<\/a>/gi;
                const anchors = [];
                let m;
                while ((m = anchorRegex.exec(decodedBody)) !== null) anchors.push({ href: m[1], text: m[2] });
                if (anchors.length === 0) {
                    console.warn(`WARN [sendBulkPersonalizedEmails] No anchor tags with href found in decoded HTML for recipient ${emailData.email}`);
                } else {
                    console.log(`DEBUG [sendBulkPersonalizedEmails] Found anchors for ${emailData.email}:`, anchors);
                }
            } catch (anchorErr) {
                console.warn('WARN [sendBulkPersonalizedEmails] Failed to parse anchors:', anchorErr.message);
            }

            // Debug: log final HTML for personalized batch sends
            console.log(`DEBUG [sendBulkPersonalizedEmails] to=${emailData.email} subject=${emailData.subject} htmlPreview=` +
                (decodedBody ? decodedBody.slice(0, 1000) : '<empty>'));

            const info = await transporter.sendMail({
                to: emailData.email,
                subject: emailData.subject,
                html: decodedBody,
            });

            console.log(`✅ Email sent to: ${emailData.email}, MessageId: ${info?.messageId}`);
            results.success++;
            if (!results.sentEmails) results.sentEmails = [];
            // messageId is already cleaned by sendBrevoEmail
            results.sentEmails.push({ email: emailData.email, messageId: info?.messageId || null });

            // Small delay to avoid rate limiting
            await delay(200);
        } catch (err) {
            console.error(`❌ Failed to send to ${emailData.email}:`, err.message);
            results.failed++;
            results.errors.push({ email: emailData.email, error: err.message });
        }
    }

    console.log(`📧 Bulk personalized email complete: ${results.success} sent, ${results.failed} failed`);
    return results;
};

/* ================= EXPORTS ================= */
module.exports = {
    sendLoginCredentialsEmail,
    sendBulkEmail,
    sendIndividualEmail,
    sendOTP,
    sendDealEmail,
    sendBulkPersonalizedEmails,
    sendPaymentFailedEmail,
    transporter,
};
